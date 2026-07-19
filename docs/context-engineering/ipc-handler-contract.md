# IPC Handler Contract

How host-side handlers for `data.type`-keyed IPC actions are written, registered,
gated, and audited. The contract is the seam every action goes through. The
goal is depth: one small interface (`IpcHandler`), broad guarantee (parsed,
authorized, trust-gated, audited, optionally result-bearing).

This document is read **before** adding a new IPC action and **before**
modifying `src/ipc/handler.ts` or `src/ipc.ts`'s task dispatch. If a proposed
change would require a new escape hatch in the dispatcher, the right move is
usually to widen the contract — once — instead of carving a bespoke arm.

## Domain terms

See [`CONTEXT.md`](../../CONTEXT.md) for the canonical glossary. Three terms
recur below:

- **IPC action** — a typed message an in-container agent writes to
  `data/ipc/{group}/tasks/`. Identified by `data.type`. Closed set.
- **Trust gate** — `gateAndStage` in `src/ipc/handlers/trust-gate.ts`. Reads
  the agent's `trust.yaml`, returns allow / stage-for-approval / deny.
- **Audit row** — a row in `agent_actions` written by the trust gate. Has
  `target` and `summary`. Distinct from the **post-hoc notify**, which is the
  user-facing Telegram message fired after `execute` returns.

## The interface

```typescript
export type ExecuteResult =
  | void                                          // executed normally
  | { executed: false }                           // bailed (race, etc.)
  | { executed: true; result: unknown };          // produced a result payload

export interface IpcHandler<TInput> {
  readonly type: string;                          // matches data.type
  readonly responseKind?: 'notify' | 'result';    // default 'notify'

  parse(raw: unknown): TInput | null;
  authorize(input: TInput, ctx: IpcHandlerContext): IpcAuthorization | null;
  execute(input: TInput, ctx: IpcHandlerContext):
    Promise<ExecuteResult> | ExecuteResult;
}
```

`IpcAuthorization` may additionally declare `skipGate: true` to opt out of the
trust gate (see **Rule 4**), `suppressNotifyWhenTargetIs` to shape the
post-hoc notify (see **Rule 3**, step 5), and the
`actionTypeOverride` / `auditTarget` / `auditSummary` audit overrides.

## Six load-bearing rules

### Rule 1 — Handlers never write result files

When `responseKind === 'result'`, the **dispatcher** owns the result file.
Handlers return `{ executed: true, result: <payload> }` and the dispatcher
writes `data/ipc/{sourceGroup}/{resultsDirName}/{requestId}.json` using the
atomic `.tmp` + rename pattern.

`resultsDirName` defaults to `${type}_results` for new handlers. The
type → results-dir mapping (including the legacy prefix-grouped dirs) is
machine-readable in the **wire contract**: canonical at
`container/agent-runner/src/wire-contract.ts` (consumed by the container
tools), mirrored at `src/ipc/wire-contract.ts`. Do not maintain a prose
table here — `src/ipc/wire-contract.test.ts` enforces (a) the two copies
are identical and (b) every result-kind handler's `resultsDirName`
matches `resultsDirFor(type)`. Adding a legacy-dir action means adding
it to BOTH contract files, or the test fails.

The dispatcher also writes the failure file when `execute` throws or returns
`{ executed: false }`:

```json
{ "success": false, "message": "<err>" }
```

…to the same `resultsDirName` so the poller's success and failure paths
read from one location.

This is the bounded-growth discipline that keeps the registry deep. If a
handler ever needs a custom result schema, **the payload varies — the
mechanism does not**.

### Rule 2 — `requestId` is mandatory for `responseKind: 'result'`

The dispatcher requires `data.requestId` to pass `/^[A-Za-z0-9_-]{1,64}$/`
(same regex the existing if-ladder enforces). Missing or malformed requestId
causes the dispatcher to log and drop — *without* writing a result file
(the in-container poller will time out, which is the correct failure mode
for a malformed call).

### Rule 3 — `parse → authorize → gate → execute → notify-or-result`

Dispatch order is fixed:

1. `parse(raw)` — return `null` to reject bad input shape. Dispatcher logs
   and drops.
2. `authorize(input, ctx)` — return `null` to deny. Dispatcher drops silently
   (the action *appears* to never have happened to the agent).
3. **Trust gate** — `gateAndStage` runs unless `authorization.skipGate` is
   `true` *and* Rule 4 allows it. Gate denies → dispatcher drops.
4. `execute(input, ctx)` — runs the side effect.
5. **Post-hoc notify** (for `responseKind: 'notify'`) — `fireNotifyIfRequested`
   runs iff the gate decision asked for one and execute returned
   `executed !== false`.

   **Result write** (for `responseKind: 'result'`) — dispatcher writes the
   `{requestId}.json` file from the `result` field.

   The dispatcher passes `auth.actionTypeOverride ?? handler.type` to the
   gate and to the post-hoc notify. Use `actionTypeOverride` ONLY when
   bridging legacy verb_noun audit names whose wire type is noun_verb (the
   slack cluster's `read_slack_dm` / `send_slack_dm` is the canonical
   example — without the override, migration silently invalidates live
   `trust.yaml` policies and the container-side MCP tool descriptions
   that reference the legacy name). New handlers must design the wire and
   audit types to match — the override is a one-way bridge for existing
   mismatches, not a design escape hatch.

   The dispatcher fires the post-hoc notify for `responseKind: 'result'`
   handlers whenever the trust gate asked for one (2026-07-19; the old
   per-handler `postHocNotify` opt-in flag from Batch 2F.1 is gone — it
   made trust level `notify` a silent no-op on every handler that didn't
   set it). `fireNotifyIfRequested` runs AFTER `writeResultFile`, gated
   on: `decision.notify === true`, no throw from execute, `executed` is
   true, and the handler's result payload is `{success: true, ...}`
   (checked via `isSuccessPayload` — a bridge 4xx/5xx stays silent). The
   notify additionally AND's with `agentName` inside
   `fireNotifyIfRequested`, so non-agent callers are silent
   automatically; autonomous trust is silent because `decision.notify`
   is false. `slack_dm` is the canonical beneficiary (hybrid: structured
   result file for the in-container agent AND user-facing Telegram
   notify when its trust level is `notify`).

   The dispatcher also honors `auth.suppressNotifyWhenTargetIs?: string`
   (added for the `message` handler migration). When set, the dispatcher
   skips the post-hoc notify if `auth.target` equals this value — applied to
   BOTH the `notify`-kind branch and the `result`-kind notify
   branch. This exists for delivery-shaped handlers whose notify is
   chatJid-aware: the generic receipt always goes to the main jid, so a
   handler that *delivers to* the main jid would echo the receipt into the
   same chat. The `message` handler sets this to the main jid, reproducing
   the inline `processIpcMessage` self-echo guard
   (`mainJidForSelfCheck !== chatJid`). Leave it unset for ordinary
   handlers — the gate's `decision.notify` is the only notify control they
   need.

### Rule 4 — `skipGate: true` is allowlisted

A handler may declare `skipGate: true` in its authorization only when it is
on the read-only allowlist maintained in `src/ipc/handler.ts`. The allowlist
is a hardcoded set, not a registration flag — adding to it requires a code
change reviewed against the trust matrix.

Initial allowlist (read-only, observable but not state-mutating):

- `dashboard_query`, `kg_query`, `pageindex_fetch`, `task_list`, `slack_dm_read`, `skill_search`, `skill_invoked`, `imessage_search`, `imessage_read`, `imessage_list_contacts`

Mutating actions **must** go through the gate. When an off-allowlist handler
declares `skipGate: true` the dispatcher:

1. **Logs** an error with handler type and sourceGroup.
2. **Denies** the action (execute is not called).
3. **Writes an `agent_actions` audit row** with `outcome: 'denied_contract_violation'` and `trust_level: 'contract_violation'` — if the caller is an agent (ctx.agentName non-null). A grep on this outcome surfaces every contract abuse for security review even after a process restart.
4. Does **not throw.** A contributor bug must not crash the IPC watcher and take down every other in-flight dispatch with it. Loud-but-contained is the correct failure mode.

Non-agent callers (bare group, no `+agent` suffix) trigger the deny + log
but no audit row is written, since `agent_actions` requires an `agent_name`.

### Rule 5 — Migration commits preserve behaviour

When migrating an if-ladder arm to a handler, the migration commit ships
with the *current* gating behaviour — including `skipGate: true` for arms
that bypass the gate today. Closing trust gaps is a **separate follow-up
commit** with a `trust-matrix.yaml` update and a test asserting the gate
fires.

This is the discipline that keeps the consolidation reviewable. A reviewer
should be able to see the migration diff and confirm "no behaviour change."
A reviewer of a follow-up should see "one gate, one trust-matrix entry, one
test."

### Rule 6 — Skill-installed handlers self-register at startup

Handlers shipped by branch-installed skills (`x-integration`,
`browser-automation`) expose a single `registerHandlers()` function from
their `host.js`. The main process calls it once at startup if the skill
directory exists. The dispatcher has no knowledge of skill-vs-core handlers
once registered.

A skill's `host.ts` therefore looks like:

```typescript
export function registerHandlers(): void {
  registerIpcHandler(xPostHandler);
  registerIpcHandler(xLikeHandler);
  // ...
}
```

This replaces the per-call `import('.claude/skills/x-integration/host.js')`
dynamic-import in the if-ladder. The skill repo and the nanoclaw repo are
co-versioned by this contract; breaking changes require coordinated PRs.

### Rule 7: Handler logger calls SHOULD include `requestId: ctx.requestId`

After Batch 4 (commit-range `651b7803..HEAD`), the dispatcher
populates `ctx.requestId: string | null` on `IpcHandlerContext` after the
Rule 2 requestId validation block. Handler `logger.*` calls inside
`execute()` SHOULD include `requestId: ctx.requestId` so that operators
can join `nanoclaw.log` lines to `agent_actions` rows (and to the
in-container poller via the shared requestId).

Example:

```ts
async execute(input, ctx) {
  logger.info(
    { sourceGroup: ctx.sourceGroup, channel: input.channel, requestId: ctx.requestId },
    'slack_dm_read handler invoked',
  );
  // ... rest of handler ...
}
```

(Field ordering is not normative — existing handlers place `requestId`
last to minimize churn on existing log-shape consumers. New handlers may
choose either order.)

**Doc-enforced only (F-F).** No ESLint rule enforces this; future
batches may add one. Reviewers must catch omissions in code review.

**Mutation-timing constraint (F-E).** `ctx.requestId` is mutated by the
dispatcher between requestId validation and `parse()`. Handlers MUST NOT
capture `ctx` in `parse()` closures via module-level state — `parse()`
runs AFTER the mutation, but a reference held across multiple dispatches
would see ever-changing values. Current handlers do not capture; this
constraint exists to prevent a future regression.

**For non-agent callers (`ctx.agentName === null`):** `requestId` may
still be set (for result-kind calls), but `agent_actions` rows are not
written (synthetic or otherwise). Log lines remain useful for debugging
host-side test fixtures.

**For notify-kind handlers:** `ctx.requestId` is ALWAYS `null` (the
dispatcher only populates it on the result-kind code path — see
`handler.ts` Rule 2 validation). Adopting Rule 7 in notify-kind handlers
is harmless but information-free; field will serialize as `null`.
Reviewers should not flag notify-kind handlers for missing `requestId`.

## Authoring checklist

When adding a new IPC action:

1. Pick `type` — short, namespaced (`{domain}_{verb}`), lowercase.
2. Decide `responseKind` — `'notify'` for fire-and-forget, `'result'` for
   request/response. For `'result'` handlers migrated from the if-ladder,
   set `resultsDirName` to match the container-side hardcoded path (see
   Rule 1 table). For brand-new actions, omit and accept the default.
3. Write `parse(raw)`. Reject anything you wouldn't pattern-match against
   in `execute`. Log the offending value before returning `null` so the
   dispatcher's generic "rejected input shape" log has attribution.
4. Write `authorize(input, ctx)`. Return `null` to deny silently. Return an
   `IpcAuthorization` to allow. Populate `auditTarget` / `auditSummary` /
   `notifySummary` with care — these end up in `agent_actions` and in the
   user's Telegram. Do **not** set `skipGate: true` unless your type is on
   the Rule 4 allowlist.
   - Do not set `actionTypeOverride` for a brand-new handler. The override
     exists only to preserve legacy `trust.yaml` keys during migration.
     If you find yourself wanting it for a new action, rename the wire
     type to match instead.
   - Result-kind handlers get the post-hoc notify automatically when an
     agent's trust level for the action is `notify` — write
     `notifySummary` accordingly (and keep it empty if surfacing the
     input would leak something, as `knowledge_search` does).
5. Write `execute(input, ctx)`. Side effects only. Return the result payload
   for `'result'` kinds.
6. Register in `src/ipc/handlers/index.ts` (core) or your skill's
   `registerHandlers()` (Rule 6).
   - [ ] Inside `execute()`, all `logger.*` calls include `requestId: ctx.requestId` (Rule 7)
7. Write a focused test at `src/ipc/handlers/{type}.test.ts`. Cover: parse
   rejection, authorize denial, gate behaviour (or `skipGate` allowlisting),
   execute side effect, result-file write for `'result'` kinds.

## Anti-patterns

- **Writing to `data/ipc/.../results/` from a handler.** Use the
  `responseKind: 'result'` channel; the dispatcher writes it.
- **Reaching into `ctx.deps` for a notify the handler fires itself.** The
  dispatcher fires post-hoc notifies. Handlers describe the notify in their
  `IpcAuthorization`.
- **Adding a `data.type === '...'` branch to `src/ipc.ts`'s task dispatch.**
  Write a handler. The if-ladder is being retired.
- **`skipGate: true` to "make a test pass."** Means the test expects gateless
  behaviour. Either the action belongs on the Rule 4 allowlist (then add it
  there in a separate PR) or the test is wrong.
