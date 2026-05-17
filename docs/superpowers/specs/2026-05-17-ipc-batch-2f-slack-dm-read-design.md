# Batch 2F — `slack_dm_read` migration with `actionTypeOverride` contract widening

**Status:** Spec — awaiting user review before plan-writing.
**Owner:** mgandal
**Date:** 2026-05-17
**Predecessors:** Batches 1, 2A–2E (see git log `refactor(ipc): migrate * to IpcHandler registry`).
**Successor:** Batch 2F.1 (`slack_dm` write handler + post-hoc-notify-after-result contract widening). Deferred from this batch.

## TL;DR

Migrate the `slack_dm_read` IPC action out of the `src/ipc.ts` if-ladder into a typed `IpcHandler` under `src/ipc/handlers/slack.ts`. Three commits:

1. **Contract widening** — add `actionTypeOverride?: string` to `IpcAuthorization` so a handler can decouple its wire `type` from the `action_type` string used in `agent_actions` audits and `trust.yaml` policy lookups. Needed because the legacy slack cluster uses verb_noun audit names (`read_slack_dm`, `send_slack_dm`) while the wire types are noun_verb (`slack_dm_read`, `slack_dm`). Without an override, the migration would silently void 7 live `trust.yaml` policies + a container-side MCP tool description.
2. **Migrate `slack_dm_read`** — handler + tests + register + strip legacy.
3. **Style** — prettier pass, only if it yields a diff.

`slack_dm` (the write sibling) is deferred to Batch 2F.1 because it also fires a post-hoc Telegram notify *after* writing its result file — a hybrid the contract doesn't yet express. That batch will widen the contract once more (`postHocNotify?: true` on result handlers) and migrate `slack_dm` with `actionTypeOverride: 'send_slack_dm'`.

## Why this matters

The IPC handler registry consolidation (per `docs/context-engineering/ipc-handler-contract.md`) is mid-migration: six of eight legacy clusters have moved (dashboard, deploy_mini_app, kg_query, tasks, imessage, pageindex). Each prior migration was "behavior-preserving" by coincidence — the legacy `action_type` string already matched the wire `type`. Slack is the first cluster where the two diverge. Without contract support for the divergence, the migration would silently rename audit rows AND invalidate live trust policies on disk.

This batch fixes that hazard once, at the contract level, so the remaining migrations (slack_dm in 2F.1, skill_* in Batch 2G) can use the same override pattern cleanly.

## Source-of-truth references

- Contract doc: `docs/context-engineering/ipc-handler-contract.md`
- Dispatcher: `src/ipc/handler.ts` (esp. lines 65–92 `IpcAuthorization`, 192–345 `dispatchIpcAction`, 21–43 `SKIP_GATE_ALLOWLIST`)
- Gate helper: `src/ipc/trust-gate.ts` `gateAndStage()` / `fireNotifyIfRequested()`
- Trust enforcement: `src/trust-enforcement.ts:98-120` `checkTrustAndStage()` (writes audit row unconditionally per call)
- Closest analogue handler: `src/ipc/handlers/imessage.ts:108-161` `imessageReadHandler`
- Closest analogue test: `src/ipc/handlers/imessage.test.ts`
- Legacy slack handler: `src/ipc.ts:1205-1314` `handleSlackDmReadIpc`
- Legacy dispatcher branch: `src/ipc.ts:970-980`
- Container-side result reader: `container/agent-runner/src/ipc-mcp-stdio.ts:1597-1632` (hardcoded `slack_results` dir)
- Container-side MCP tool description (referenced by trust.yaml): `container/agent-runner/src/ipc-mcp-stdio.ts:1603`

## Architecture

### Change 1: Contract widening — `actionTypeOverride`

Today, the dispatcher passes `handler.type` as the `actionType` arg into `gateAndStage` (handler.ts:277) and as `actionType` for `fireNotifyIfRequested` (handler.ts:336). This couples the wire type (what the agent writes into the IPC file's `data.type`) to the audit type (what gets written into `agent_actions.action_type` and what's keyed in `trust.yaml`).

Existing precedent: `IpcAuthorization` already has `auditTarget?: string` to decouple user-facing target from audit target. The override pattern is established.

**Proposed:**

```typescript
export interface IpcAuthorization {
  target: string;
  notifySummary: string;
  auditSummary?: string;
  auditTarget?: string;
  payloadForStaging: Record<string, unknown>;
  skipGate?: true;
  /**
   * Override for the action_type string written to agent_actions and looked
   * up in trust.yaml. Defaults to `handler.type` (the wire type).
   *
   * Use this when migrating a legacy handler whose audit action_type doesn't
   * match the wire type — e.g. the legacy slack cluster used verb_noun
   * audit names (`read_slack_dm`, `send_slack_dm`) but the wire types are
   * noun_verb (`slack_dm_read`, `slack_dm`). Without this override, the
   * migration would silently invalidate every existing trust.yaml policy
   * keyed on the legacy name.
   */
  actionTypeOverride?: string;
}
```

**Dispatcher change** (handler.ts:269–342):

- Compute `auditActionType = auth.actionTypeOverride ?? handler.type` once after parse+authorize.
- Pass `auditActionType` to `gateAndStage` instead of `handler.type`.
- Pass `auditActionType` to `fireNotifyIfRequested` instead of `handler.type`.
- The `outcome: 'denied_contract_violation'` audit row at handler.ts:247–256 continues to use `handler.type` (it's a *contract* violation, not a *user* action — the wire type is the right discriminator there).

**Contract doc change** (`docs/context-engineering/ipc-handler-contract.md` § Rule 3):

Add a paragraph after the existing `auditTarget` mention pointing to the override and when to use it. Same shape as the existing auditTarget paragraph.

### Change 2: Migrate `slack_dm_read`

New file `src/ipc/handlers/slack.ts`:

```typescript
interface SlackDmReadInput {
  channel: string | undefined;
  limit: number | undefined;
}

export const slackDmReadHandler: IpcHandler<SlackDmReadInput, ExecuteResult> = {
  type: 'slack_dm_read',
  responseKind: 'result',
  resultsDirName: 'slack_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      channel: typeof r.channel === 'string' ? r.channel : undefined,
      limit: typeof r.limit === 'number' ? r.limit : undefined,
    };
  },

  authorize(input, ctx) {
    return {
      target: input.channel || '',
      auditSummary: `Read DM channel: ${input.channel || 'unknown'}`,
      notifySummary: 'read slack dm',
      payloadForStaging: { type: 'slack_dm_read' },
      actionTypeOverride: 'read_slack_dm',
      ...(ctx.agentName === null ? { skipGate: true as const } : {}),
    };
  },

  async execute(input, ctx): Promise<ExecuteResult> {
    if (!input.channel) {
      return {
        executed: true,
        result: { success: false, message: 'Missing required parameter: channel' },
      };
    }
    const body: Record<string, unknown> = { channel: input.channel };
    if (input.limit) body.limit = input.limit;

    const response = await fetch('http://127.0.0.1:19876/slack/dm/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;

    logger.info(
      { sourceGroup: ctx.sourceGroup, channel: input.channel },
      'slack_dm_read IPC handled',
    );

    if (response.ok) {
      const messages = result.messages as unknown[];
      return {
        executed: true,
        result: {
          success: true,
          message: JSON.stringify(messages || [], null, 2),
          data: result,
        },
      };
    }
    return {
      executed: true,
      result: {
        success: false,
        message: (result.error as string) || `Bridge returned ${response.status}`,
      },
    };
  },
};
```

**Key decisions:**

- `responseKind: 'result'` + `resultsDirName: 'slack_results'` — matches container hardcoded path at `ipc-mcp-stdio.ts:1597`.
- `actionTypeOverride: 'read_slack_dm'` — preserves audit rows + trust.yaml lookups for 7 live agents (claire, simon, coo, einstein, marvin, vincent + 3 with default fall-through comments referencing the name).
- `skipGate: true` only when `ctx.agentName === null` (non-agent caller) — matches `imessageReadHandler` (imessage.ts:136). `slack_dm_read` is already on `SKIP_GATE_ALLOWLIST` (handler.ts:27); no change there.
- Agent callers fall through to `gateAndStage`, which calls `checkTrustAndStage`, which writes an `agent_actions` row unconditionally (`trust-enforcement.ts:108-120`). This matches the legacy explicit `insertAgentAction` at `ipc.ts:1222-1230`.
- `logger.info` inside `execute` preserves the legacy log line at `ipc.ts:1298-1301` (operability: any operator runbook grepping for that string still finds it).

### Change 3: Strip legacy

- Delete `src/ipc.ts:970-980` (dispatcher if-ladder branch for `slack_dm_read`).
- Delete `src/ipc.ts:1205-1314` (entire `handleSlackDmReadIpc` function).
- Leave `src/ipc.ts:958-969` (the `slack_dm` branch) AND `src/ipc.ts:1082-1203` (`handleSlackDmIpc`) untouched. Both are Batch 2F.1's scope.
- Update the inline comment block at `src/ipc.ts:951-957` to add a `slack_dm_read migrated to src/ipc/handlers/slack.ts` line.
- Register `slackDmReadHandler` in `src/ipc/handlers/index.ts` after `pageindexIndexHandler` (line 57 area) per cluster-grouping convention (R2 F5).

## Test plan

New file `src/ipc/handlers/slack.test.ts`. Mirror `imessage.test.ts` structure (unit + dispatcher-level integration). All `fetch` calls mocked via `vi.stubGlobal('fetch', ...)`.

### Unit tests (handler shape)

1. **`parse` non-object input.** Returns `null` for `null`, `undefined`, `42`, `"str"`, `[]`.
2. **`parse` success.** Extracts `{channel: 'D123', limit: 50}` from raw input; coerces non-string `channel` to `undefined`; coerces non-number `limit` to `undefined`.
3. **`authorize` non-agent caller.** Returns `IpcAuthorization` with `skipGate: true` and `actionTypeOverride: 'read_slack_dm'`.
4. **`authorize` agent caller.** Returns `IpcAuthorization` *without* `skipGate` but *with* `actionTypeOverride: 'read_slack_dm'`. (Pins the override is unconditional, not skipGate-coupled.)
5. **`execute` happy path.** Mock fetch → 200 with `{messages: [{...}]}` → result is `{success: true, message: <JSON-stringified messages>, data: <full response>}`. Assert `result.message` parses back to the messages array (closes R3 #2 — pins the load-bearing field, not just success bit).
6. **`execute` missing channel.** Returns `{executed: true, result: {success: false, message: 'Missing required parameter: channel'}}`.
7. **`execute` bridge error (4xx with error body).** Mock fetch → `{ok: false, status: 404, json: () => ({error: 'channel not found'})}` → result is `{success: false, message: 'channel not found'}`.
8. **`execute` bridge error (4xx without error field).** Mock fetch → `{ok: false, status: 500, json: () => ({})}` → result is `{success: false, message: 'Bridge returned 500'}`.
9. **`execute` `limit` propagation.** When `limit` set, fetch body includes it; when `limit` undefined, body omits it. Inspect `(globalThis.fetch as Mock).mock.calls[0][1].body`.

### Dispatcher integration tests (closes R3 #1, #4, #5)

10. **End-to-end success writes result file.** Dispatch with valid requestId → file appears at `data/ipc/{sourceGroup}/slack_results/{requestId}.json` with correct shape. Use `mkdtempSync` for `dataDir` override. **Also assert the wrong-default path `slack_dm_read_results/{requestId}.json` does NOT exist** (closes R3 #1 — pins `resultsDirName` override; mirrors `dashboard-query.test.ts:254-284`).
11. **Missing requestId dropped.** Dispatch without `requestId` → no file written under either path, dispatcher logs warning. (Rule 2 enforcement, mirrors `imessage.test.ts` requestId test.)
12. **Malformed requestId dropped.** Dispatch with `requestId: '../../etc/passwd'` → regex rejects, no file written. (Path-traversal protection.)
13. **`fetch` rejects (network down).** `vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')))` → dispatcher catches, result file contains `{success: false, message: 'Error: ECONNREFUSED'}`.
14. **`response.json()` rejects (bridge returns HTML).** `mockResolvedValueOnce({ok: true, json: () => Promise.reject(new Error('Unexpected token'))})` → result file contains `{success: false, message: 'Error: Unexpected token'}`.

### Audit-row pinning (closes Rule 5 verification)

15. **Agent caller writes correct audit row.** Spy on `insertAgentAction` (or query the test DB). Assert exactly one row with `action_type='read_slack_dm'` (NOT `'slack_dm_read'`), `summary='Read DM channel: D123'`, `target='D123'`, `outcome='allowed'`. This is the load-bearing test that proves `actionTypeOverride` works end-to-end. Without it, the override could silently be a no-op and the suite would still go green.
16. **Non-agent caller writes ZERO audit rows.** No `agent_actions` row for `slack_dm_read` *or* `read_slack_dm`. (Matches legacy behavior — `insertAgentAction` only fires inside the `if (agentName)` block at `ipc.ts:1214`.)

### Dispatcher contract-widening tests (Change 1)

In `src/ipc/handler.test.ts` (or a new file under `src/ipc/handler-action-type-override.test.ts`):

17. **Override propagates to `gateAndStage`.** Register a stub handler with `type: 'wire_x'` + `actionTypeOverride: 'audit_x'`. Spy on the audit row. Assert `action_type='audit_x'`.
18. **No override → default to `handler.type`.** Stub handler without override. Audit row has `action_type='wire_x'`. (Backward-compat — all prior batches must not regress.)
19. **`outcome: 'denied_contract_violation'` row uses wire type.** Stub handler with `actionTypeOverride: 'audit_x'` AND off-allowlist `skipGate: true`. The contract-violation audit row has `action_type='wire_x'` (NOT `'audit_x'`). Rationale: a contract violation is about the *handler*, not the *user action*; reviewer should see the wire type.

## Behavior-preservation matrix (Rule 5 verification)

| Behavior | Legacy (ipc.ts:1205-1314) | New (slack.ts) | Match? |
|---|---|---|---|
| Wire result-file path | `{DATA_DIR}/ipc/{group}/slack_results/{requestId}.json` | Same (via `resultsDirName: 'slack_results'`) | ✅ |
| Result-file payload shape | `{success, message, data?}` | Same | ✅ |
| `agent_actions.action_type` | `read_slack_dm` | `read_slack_dm` (via `actionTypeOverride`) | ✅ |
| `agent_actions.summary` | `Read DM channel: X` | Same (via `auditSummary`) | ✅ |
| `agent_actions.target` | `channel` value or `''` | `input.channel || ''` (via `target`) | ✅ |
| Audit row condition | Only when `agentName` non-null | Same (gateAndStage returns `NON_AGENT_DECISION` for null agentName, skipping audit) | ✅ |
| Missing channel | Result file with `{success: false, message: 'Missing required parameter: channel'}` | Same | ✅ |
| Invalid requestId | Drop, no result file | Same (Rule 2 enforcement) | ✅ |
| Trust-deny outcome | Return without writing result file | gateAndStage denies → dispatcher returns `{handled: true}`, no file written | ✅ |
| Throw inside execute | Caught, writes `{success: false, message: 'Error: ...'}` | Dispatcher catches (handler.ts:301-308) and writes same shape | ✅ |
| Log line | `logger.info({...}, 'slack_dm_read IPC handled')` | Same (added inside execute for parity) | ✅ |

**Known minor divergence** (pre-existing cluster-wide, not slack-specific):

- `agent_actions.summary` is truncated to 200 chars by `checkTrustAndStage` (`trust-enforcement.ts:113`). Legacy `insertAgentAction` call passed `summary` raw. For `slack_dm_read`, summaries are `Read DM channel: <channel-id>` — channel IDs are ~11 chars, total well under 200. Non-issue for this batch. Flag for a Batch 4 follow-up if any cluster ever ships summaries longer than 200 chars.
- Outcome string space widens — `checkTrustAndStage` can emit `'staged'`; legacy slack only emitted `'allowed' | 'blocked'`. Read-only on SKIP_GATE_ALLOWLIST for non-agents means the new path won't actually fire `'staged'` for `slack_dm_read` (read actions in trust.yaml are typically `notify`/`autonomous`, not `ask`/`draft`). Non-issue for this batch.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| **`actionTypeOverride` becomes a magnet for sloppy wire vs. audit divergence.** Future handlers might use it to "fix" wire names instead of designing them properly. | Contract doc § Rule 3 paragraph names the *one* legitimate use case (legacy verb_noun audit names) and explicitly says new handlers should not use the override. Reviewer can grep `actionTypeOverride:` in PRs to spot new uses. |
| **Test #15 (audit-row pinning) requires DB setup in test.** Existing handler tests use mocked deps. | Mirror `kg-query.test.ts` if it exercises `agent_actions` directly, OR spy on `insertAgentAction` import. Inspect to pick approach during plan-writing. |
| **`slack_dm` and `slack_dm_read` cohabit the if-ladder during 2F→2F.1 window.** Half-migrated cluster. | Dispatch order is structurally safe: `registerBuiltinHandlers()` runs at `ipc.ts:918` before the if-ladder switch at `ipc.ts:929`. `dispatchIpcAction` returns `{handled: true}` before the if-ladder runs. R2 F7 confirmed. |
| **Container-side MCP tool description at `ipc-mcp-stdio.ts:1603` mentions `read_slack_dm`.** If we ever rename audit_action_type, the agent's tool-call permission check breaks. | `actionTypeOverride` prevents the rename. Container description stays accurate. If a future PR ever wants to rename, the operator-visible touch points are now grep-able: `data/agents/*/trust.yaml`, `container/agent-runner/src/ipc-mcp-stdio.ts`, `docs/SECURITY.md`, this spec. |
| **`postHocNotify` for 2F.1 might invalidate this spec's contract widening.** | They're orthogonal. `actionTypeOverride` controls the audit + trust.yaml string. `postHocNotify` will control result+notify hybrid behavior. Both extend `IpcAuthorization` cleanly without conflicting. |

## Scope discipline (what we are NOT doing)

- **Not** migrating `slack_dm`. Deferred to Batch 2F.1.
- **Not** auditing other clusters for verb_noun → noun_verb rename hazards. (Spot-checked during peer review: dashboard/kg/tasks/imessage/pageindex all match wire type. Only slack diverges. Skill_* in Batch 2G will be re-audited at that time.)
- **Not** closing the truncated-summary divergence — pre-existing, cluster-wide, fix once in Batch 4.
- **Not** touching `slack_dm`'s `send_slack_dm` audit name. Will use `actionTypeOverride` in 2F.1.
- **Not** renaming `trust.yaml` entries from `read_slack_dm` to `slack_dm_read`. The whole point of `actionTypeOverride` is to keep them stable.

## Acceptance criteria

1. `bun run test` passes after all three commits.
2. `bun run typecheck` passes.
3. `bun run lint` passes.
4. New tests #15 + #16 pin the `agent_actions` row shape (with and without agent).
5. Grep `data/agents/*/trust.yaml` for `read_slack_dm` returns the same 7 hits before and after the migration (proves no rename happened).
6. Manual smoke test: dispatch a `slack_dm_read` IPC from an agent caller in the test harness, confirm result file appears at `slack_results/{requestId}.json` and one `agent_actions` row with `action_type='read_slack_dm'` is inserted.

## Commit sequence

1. `refactor(ipc): add actionTypeOverride to IpcAuthorization (Batch 2F prep)`
   - `src/ipc/handler.ts`: extend interface + dispatcher
   - `src/ipc/handler-action-type-override.test.ts` (or extend existing): tests #17–19
   - `docs/context-engineering/ipc-handler-contract.md`: Rule 3 paragraph

2. `refactor(ipc): migrate slack_dm_read to IpcHandler registry (Batch 2F/N)`
   - `src/ipc/handlers/slack.ts`: new file
   - `src/ipc/handlers/slack.test.ts`: tests #1–16
   - `src/ipc/handlers/index.ts`: register
   - `src/ipc.ts`: strip dispatcher branch + delete `handleSlackDmReadIpc` + update comment

3. `style(ipc): apply prettier formatting to slack handler` *(only if prettier yields a diff)*

## Peer-review log

This spec was audited by 3 parallel adversarial reviewers (R1: silent-failure + Rule 5, R2: contract + dispatcher architecture, R3: test plan adversarial). All three independently flagged the `action_type` rename as a Critical Rule 5 violation. R3 added 4 test-plan gaps (wire-path explicit, message-payload contents, throw-from-execute network+JSON, bad-requestId, limit-propagation). R2 added cluster-grouping registration-order style note. R1 added log-parity minor (`logger.info` inside execute). All findings incorporated. Verified phantoms: R1 Critical 2 (non-agent path) was self-withdrawn after re-reading source; R2 F2 (gate skips audit for autonomous reads) was refuted by `trust-enforcement.ts:108` which writes the row unconditionally.

## Open questions for user review

None — design is locked. User review gate per brainstorming step 8 is the next step.
