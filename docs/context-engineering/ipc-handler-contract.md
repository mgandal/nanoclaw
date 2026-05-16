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
trust gate. See **Rule 4** below for when that's permitted.

## Six load-bearing rules

### Rule 1 — Handlers never write result files

When `responseKind === 'result'`, the **dispatcher** owns the result file.
Handlers return `{ executed: true, result: <payload> }` and the dispatcher
writes `data/ipc/{sourceGroup}/{resultsDirName}/{requestId}.json` using the
atomic `.tmp` + rename pattern.

`resultsDirName` defaults to `${type}_results` for new handlers. **Legacy
actions being migrated from the if-ladder MUST set `resultsDirName`
explicitly** to match the container-side hardcoded path
(`container/agent-runner/src/ipc-mcp-stdio.ts`). The legacy wire format is
prefix-grouped, not type-suffixed:

| action prefix | `resultsDirName` |
|---|---|
| `dashboard_query` | `dashboard_results` |
| `kg_*` | `kg_results` |
| `task_*` | `task_results` |
| `pageindex_*` | `pageindex_results` |
| `imessage_*` | `imessage_results` |
| `slack_*` | `slack_results` |
| `x_*` | `x_results` |
| `browser_*` | `browser_results` |
| `skill_*` | `skill_results` |
| `deploy_*` | `deploy_results` |

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

### Rule 4 — `skipGate: true` is allowlisted

A handler may declare `skipGate: true` in its authorization only when it is
on the read-only allowlist maintained in `src/ipc/handler.ts`. The allowlist
is a hardcoded set, not a registration flag — adding to it requires a code
change reviewed against the trust matrix.

Initial allowlist (read-only, observable but not state-mutating):

- `dashboard_query`, `kg_query`, `pageindex_fetch`, `task_list`, `slack_dm_read`, `skill_search`, `skill_invoked`, `imessage_search`, `imessage_read`, `imessage_list_contacts`

Mutating actions **must** go through the gate. The dispatcher rejects a
`skipGate: true` from an off-allowlist handler with a logged error, treating
it as a denied authorization.

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
5. Write `execute(input, ctx)`. Side effects only. Return the result payload
   for `'result'` kinds.
6. Register in `src/ipc/handlers/index.ts` (core) or your skill's
   `registerHandlers()` (Rule 6).
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
