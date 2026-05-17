# IPC Batch 4 — Dispatcher observability (synthetic drop rows + log requestId)

**Status:** Spec locked, awaiting plan + impl
**Author:** Claude (Opus 4.7)
**Date:** 2026-05-17
**Predecessor:** Batch 2F (slack_dm_read migration, commits `1738f6ce..20f284ea`)
**Successor:** Batch 2F.1 (slack_dm write sibling) or Batch 2G (skill_* cluster) — Batch 4 does not block either

## Problem

Two cluster-wide gaps surfaced during the Batch 2F independent code review and were captured as durable memory entries:

1. **Audit-row coverage gap** ([[ipc-audit-row-coverage-gap]]). All 6 migrated `'result'`-kind IpcHandlers silently drop the `agent_actions` audit row when an agent caller sends a malformed `requestId`. The legacy if-ladder wrote one row from inside each handler body before any requestId check; the new dispatcher validates `requestId` at `src/ipc/handler.ts:224-235` *before* the handler runs. Net effect: agent callers spamming bad requestIds leave zero forensic trail in the canonical audit table. Same pattern affects parse-rejection drops at handler.ts:237-244.

2. **Log requestId shrink** ([[ipc-log-requestid-shrink]]). The migrated handlers' `logger.info` / `logger.warn` calls inside `execute()` typically log `{sourceGroup, ...}` and lost the legacy `{requestId, sourceGroup, ...}` shape. The dispatcher's catch-path log at handler.ts:325-327 also has no `requestId`. Operators correlating IPC traffic across `nanoclaw.log` ↔ `agent_actions` ↔ the in-container poller lose the universal join key the legacy code provided.

This batch closes both gaps in the dispatcher (one commit), then mechanically updates the small set of existing handler log call-sites (second commit).

## Scope

In:
- `src/ipc/handler.ts` dispatcher (synthetic audit rows for paths B + C, ctx.requestId binding, catch-path log enhancement)
- `scripts/trust/run-analyzer.ts` SELECT and `scripts/trust/analyze-promotions.ts` row filter (defense-in-depth allowlist preventing synthetic rows from poisoning promotion analysis)
- `docs/context-engineering/ipc-handler-contract.md` (new authoring rule + mutation-timing constraint note)
- `docs/incident-response/ipc-drop-outcomes.md` (NEW operator runbook)
- 6 logger call-sites in `src/ipc/handlers/{slack,dashboard-query,imessage}.ts`

Out (per Q4 brainstorm lock):
- `src/ipc.ts` legacy if-ladder. Un-migrated handlers absorb the fix on their individual migration.
- `src/db.ts` schema. F-B is solved by embedding `req=<id>` in `summary` rather than adding a `request_id` column.
- Path D (`handler.authorize() === null`). Excluded per peer review F-A — Rule 3 of contract doc mandates silent drop.

## Pre-design peer review summary

Three adversarial reviewers (R1 silent-failure, R2 contract/schema, R3 forensic completeness) were dispatched against the initial broad-scope design. They returned 7 findings; the design was reshaped before this spec was written. Summary:

| ID | Source | Severity | Finding | Resolution |
|----|--------|----------|---------|------------|
| F-A | R1 F1 + R2 F1 (converged) | Critical | Path D drops violate contract Rule 3 + poison `analyze-promotions.ts` | Dropped path D entirely; analyzer guard added |
| F-B | R3 F1 | Critical | No correlation key between synthetic row and log line | Embed `req=<id>` in `summary` for path C |
| F-C | R3 F2 | High | New `outcome` strings have zero operator-facing docs | Added `docs/incident-response/ipc-drop-outcomes.md` |
| F-D | R1 F2 | Medium | Synthetic row omits requestId | Merged with F-B fix |
| F-E | R1 F3 | Low | ctx.requestId set before parse → latent contract trap | Spec note + contract-doc constraint |
| F-F | R2 F2 | Medium | "MUST include requestId" is doc-only, not enforced | Spec acknowledges doc-only |
| F-G | R3 F3 | Medium | `target: ctx.sourceGroup` is dead weight in drop rows | `target: NULL` for drop rows |

## Behavior-preservation matrix (Rule 5)

| Caller / path | Current behavior | Batch 4 behavior | New rows in `agent_actions` |
|---|---|---|---|
| Agent, result-kind, happy path | gate writes 1 row (`autonomous`/`pending`/`notify`), result file written | UNCHANGED | 1 (same) |
| Agent, result-kind, malformed requestId (path B) | `logger.warn`, return; no row | `logger.warn`, **synthetic row**, return | 1 (NEW) |
| Agent, result-kind, parse null (path C) | `logger.warn`, return; no row | `logger.warn` (now with `requestId`), **synthetic row**, return | 1 (NEW) |
| Agent, result-kind, authorize null (path D) | silent return; no log, no row | **UNCHANGED** (silent return per Rule 3) | 0 |
| Agent, result-kind, off-allowlist skipGate | `logger.error` + contract-violation row | UNCHANGED | 1 (same) |
| Agent, result-kind, gate denies | gate writes 1 row (`blocked`), return | UNCHANGED | 1 (same) |
| Agent, result-kind, execute throws | gate row already written; logger.error; result file with `{success:false}` | log enhanced with `requestId`+`agentName`; result file unchanged | 0 new (gate row pre-existed) |
| Agent, notify-kind, any path | various | `ctx.requestId === null` throughout; otherwise UNCHANGED | UNCHANGED |
| Non-agent caller, any drop path | silent return | silent return (synthetic row skipped via `if (!ctx.agentName) return`) | 0 |

## Architecture

ONE dispatcher file (`src/ipc/handler.ts`) is modified for production behavior. Added:

1. **New field on `IpcHandlerContext`:** `requestId: string | null`. Populated by dispatcher after the requestId validation block at line 224-235. Defaults `null` for notify-kind handlers (no requestId in flow).

2. **New private helper `writeSyntheticAuditRow`:**
   ```ts
   function writeSyntheticAuditRow(
     ctx: IpcHandlerContext,
     type: string,
     requestId: string | null,
     trust_level: 'dispatch_drop_input',
     summary: string,
     outcome: 'dropped_invalid_requestId' | 'dropped_invalid_input',
   ): void {
     if (!ctx.agentName) return;
     try {
       insertAgentAction({
         agent_name: ctx.agentName,
         group_folder: ctx.baseGroup,
         action_type: type,
         trust_level,
         summary: requestId ? `${summary} (req=${requestId.slice(0, 64)})` : summary,
         target: null,
         outcome,
       });
     } catch (err) {
       logger.error({ err, type, requestId }, 'Failed to write synthetic drop audit row');
     }
   }
   ```

3. **Two new call sites** in `dispatchIpcAction`:
   - Path B (after current line 232, before the existing `return { handled: true }`): `writeSyntheticAuditRow(ctx, data.type, null, 'dispatch_drop_input', 'malformed requestId', 'dropped_invalid_requestId')`
   - Path C (after current line 240, before the existing `return`): `writeSyntheticAuditRow(ctx, data.type, requestId, 'dispatch_drop_input', 'parse rejected', 'dropped_invalid_input')`

4. **Catch-path log enhancement** at handler.ts:324-327: append `requestId, agentName: ctx.agentName` to the log context.

5. **No code changes to handler.parse, handler.authorize, handler.execute interface.** ctx grows a field; handlers ignore or use it.

## Components (files modified, with LOC estimates)

| File | Change | LOC |
|---|---|---|
| `src/ipc/handler.ts` | ctx.requestId field, populate, writeSyntheticAuditRow helper, 2 call sites, catch-path log enhance | ~70 |
| `src/ipc/handlers/slack.ts` | `requestId: ctx.requestId` in 1 logger.info at line 76 | 1 |
| `src/ipc/handlers/dashboard-query.ts` | `requestId: ctx.requestId` in 1 logger.info at line 95 | 1 |
| `src/ipc/handlers/imessage.ts` | `requestId: ctx.requestId` in 4 logger.warn calls (lines 67, 125, 186, 242) | 4 |
| `scripts/trust/run-analyzer.ts` | Extend SELECT at line 87 with `WHERE trust_level IN ('ask','draft','notify','autonomous')` — the actual SQL caller | 1 |
| `scripts/trust/analyze-promotions.ts` | Defense-in-depth: filter `groupRows` against `LADDER` membership before `sorted[0]?.trust_level` lookup at line 92 — protects the pure function against any future caller that skips the SQL filter | 2-3 |
| `docs/context-engineering/ipc-handler-contract.md` | New Rule N paragraph + authoring-checklist sub-bullet + ctx.requestId mutation-timing constraint | ~25 |
| `docs/incident-response/ipc-drop-outcomes.md` | NEW operator runbook | ~60 |
| `src/ipc/handler-batch4-drops.test.ts` | NEW test file, 14 tests + mutation-checked | ~280 |

Files NOT touched (intentional, per scope locks):
- `src/ipc.ts` (legacy if-ladder out per Q4)
- `src/db.ts` schema (β over γ per F-B decision)
- `src/ipc/handlers/{pageindex,kg-query,tasks}.ts` (no logger calls in execute)

## Data flow (representative scenarios)

### Path B drop (malformed requestId, agent caller)

```
agent writes data/ipc/{group}/in/{n}.json with data.requestId='!!bad!!'
→ dispatcher buildContext() [ctx.requestId=null]
→ lookup handler ✓
→ responseKind='result' → validate data.requestId ✗ (regex fail)
→ logger.warn({type, sourceGroup, requestId: '!!bad!!'}, ...)   [unchanged]
→ writeSyntheticAuditRow(ctx, type, null, 'dispatch_drop_input',
                         'malformed requestId',
                         'dropped_invalid_requestId')           [NEW]
  → row: trust_level='dispatch_drop_input',
         summary='malformed requestId' (NO req= since requestId is null here),
         target=NULL,
         outcome='dropped_invalid_requestId'
→ return {handled: true}
```

### Path C drop (parse rejected, agent caller, valid requestId)

```
agent writes data/ipc/{group}/in/{n}.json with requestId='abc123' + bad payload
→ dispatcher buildContext()
→ lookup handler ✓
→ responseKind='result' → validate data.requestId ✓
→ ctx.requestId = 'abc123'                                       [NEW]
→ handler.parse(data) → null ✗
→ logger.warn({type, sourceGroup, requestId: 'abc123'}, ...)     [ENHANCED w/ requestId]
→ writeSyntheticAuditRow(ctx, type, 'abc123', 'dispatch_drop_input',
                         'parse rejected',
                         'dropped_invalid_input')               [NEW]
  → row: trust_level='dispatch_drop_input',
         summary='parse rejected (req=abc123)' (F-B/F-D join key),
         target=NULL,
         outcome='dropped_invalid_input'
→ return {handled: true}
```

### Path D — UNCHANGED (per F-A)

```
... [reach authorize, returns null] ...
→ return {handled: true}    [SILENT — no log, no row, Rule 3 preserved]
```

### Handler throws (catch path enhancement)

```
... [happy path through execute] ... → throws
→ logger.error({err, type, sourceGroup, requestId, agentName},  [ENHANCED]
               'IPC handler execute threw')
→ writeResultFile {success:false, message:'Error: ...'}
→ return {handled: true}
```

### Non-agent caller, any drop path

```
... [reach path B or C] ...
→ writeSyntheticAuditRow(ctx, ...)
→ ctx.agentName === null
→ early return (no insertAgentAction call)
→ continue to {handled: true}
```

## Error handling

| Scenario | Trigger | Handling | Observable |
|---|---|---|---|
| E1: synthetic-row insert throws | DB lock, WAL conflict, schema mismatch | helper try/catch → logger.error → continue | log line, no row (acceptable) |
| E2: dispatcher catch logger throws | logger.error itself throws | NOT caught, propagates to ipc.ts watcher's outer boundary | stack trace, watcher restarts |
| E3: synthetic write rollback | N/A — bun:sqlite per-statement implicit txn | — | — |
| E4: analyzer guard not picked up | Cron re-execs Bun per invocation | None needed | — |
| E5: parallel test mutation of agent_actions | Multiple test files writing | `_initTestDatabase(':memory:')` + non-deterministic agent names per test | isolated |
| E6: migration race (git pull mid-flight) | Old in-flight calls run old code | Acceptable; new calls run new behavior; build+restart bounded ~10s | brief mixed behavior |

### Invariants

1. Synthetic-row write failure ≠ dispatcher failure.
2. Path D never writes a synthetic row (F-A).
3. Non-agent callers never write a synthetic row.
4. Malformed requestId value (path B) appears ONLY in logs, NOT in audit row.
5. Validated requestId (path C) appears in `summary` via `${requestId.slice(0, 64)}`.

## Testing

### New test file `src/ipc/handler-batch4-drops.test.ts` (~14 tests, ~280 LOC)

- `describe: ctx.requestId binding`
  - populates ctx.requestId for result-kind happy path
  - leaves ctx.requestId null for notify-kind
  - leaves ctx.requestId null on malformed-requestId rejection
- `describe: path B synthetic row (malformed requestId)`
  - writes row with trust_level='dispatch_drop_input'
  - writes row with outcome='dropped_invalid_requestId'
  - writes row with summary='malformed requestId' (NO 'req=' substring)
  - writes row with target=NULL
  - skips row write when ctx.agentName is null
- `describe: path C synthetic row (parse rejected)`
  - writes row with trust_level='dispatch_drop_input'
  - writes row with outcome='dropped_invalid_input'
  - writes row with summary CONTAINING 'req=abc123' (validated id)
  - writes row with target=NULL
  - skips row write when ctx.agentName is null
- `describe: catch path log enhancement`
  - logger.error context includes requestId on result-kind throw
  - logger.error context includes agentName on throw

### Extended existing test files (+2 pattern-pins)

- `src/ipc/handlers/slack.test.ts`: assert logger.info call includes requestId field
- `src/ipc/handlers/imessage.test.ts`: assert at least one logger.warn call includes requestId field (pattern-pin)

### Extended existing test file `scripts/trust/analyze-promotions.test.ts`

- pin: synthetic-row trust_level (e.g., `'dispatch_drop_input'`) in input rows is filtered out, never reaches `nextTrustLevel` and never becomes a promotion candidate (~30 LOC, 1 test)

No new test file needed for `run-analyzer.ts` SELECT — the SQL filter is mechanical and the JS-guard test above already covers the load-bearing case (defense-in-depth invariant: function rejects bad rows regardless of SQL filter).

### Mutation-test discipline (mandatory per `feedback_red_isolation_verify`)

Each test must be mutation-checked: comment out the production-code line → re-run → confirm test fails → revert → confirm test passes. ~14 mutations × 30s manual verify = ~7 min total.

Specific high-tautology-risk tests requiring extra rigor:
- "path D never writes a row" — assert exactly ONE gate row + ZERO synthetic rows
- "ctx.requestId leaves null for notify" — capture ctx via spy through `buildContext`, assert spy was called with `requestId: null`

### Test infrastructure (reused from Batch 2F)

- `_initTestDatabase(':memory:')` per test
- `_resetHandlersForTests()` per test
- non-deterministic agent names: `test-agent-${Date.now()}-${Math.random().toString(36).slice(2,8)}`
- real `insertAgentAction` write to in-memory DB (closer to production semantics than mocking)

### Acceptance criteria

1. All 14 new tests pass on first run.
2. All ~14 mutation checks fail when mutated, pass when reverted.
3. All existing 2311 tests still pass (no regressions).
4. `bun run typecheck` clean.
5. `bun run lint` zero errors.
6. Manual grep verifies: `scripts/trust/run-analyzer.ts:87` SELECT has `WHERE trust_level IN ('ask','draft','notify','autonomous')` AND `scripts/trust/analyze-promotions.ts` filters `groupRows` by `LADDER.includes(r.trust_level as TrustLevel)` before any `sorted[0]?.trust_level` lookup.
7. `docs/incident-response/ipc-drop-outcomes.md` is committed.

## Commit shape

**Approach A (locked):** 2 thin commits, prettier inline pre-commit (sub-choice b).

- **Commit 1 — Dispatcher + observability surface.** Dispatcher changes (helper, ctx.requestId, 2 call sites, catch enhance), analyzer SQL filter (`run-analyzer.ts`), analyzer JS guard (`analyze-promotions.ts`), both doc files (contract + runbook), new test file (`handler-batch4-drops.test.ts`), extended analyzer test. ~365 LOC. Atomic — revert pulls all new contract surface together.
- **Commit 2 — Handler logger pass.** Mechanical update to 6 logger call-sites in slack/dashboard-query/imessage handlers + 2 pattern-pin test assertions. ~16 LOC.

Prettier and lint run before each commit (no separate cleanup commit, learned from Batch 2F).

## Deferred (intentionally NOT in Batch 4)

- **Path A coverage** (unknown handler type at handler.ts:215-216). Out per brainstorm Q1 — routing question, not silent-drop pattern.
- **Path D coverage** (authorize null). Out per F-A — preserves Rule 3 contract.
- **Schema migration for `request_id` column.** Use summary-embedding (option β) for now; promote to schema column (option γ) only if `WHERE summary LIKE '%req=%'` queries become hot.
- **ESLint rule enforcing `requestId` in handler logger calls.** Acknowledged in spec; would need a custom rule, deferred to Batch 5+.
- **Legacy if-ladder synthetic rows.** Out per Q4 — each handler picks up the protection on its individual migration.
- **`processIpcMessage` arms** (message, send_file, set_proactive_pause). Different lifecycle; would need separate ADR.

## Related memory

- [[ipc-audit-row-coverage-gap]] — the originating finding for paths B+C
- [[ipc-log-requestid-shrink]] — the originating finding for log enhancement
- [[feedback_silent_failure_wedge]] — recurring NanoClaw anti-pattern; F-A and F-B are direct instances
- [[feedback_red_isolation_verify]] — mutation-test discipline source
- [[feedback_commit_plan_with_first_task]] — applies to plan file (not this spec commit)
- [[feedback_adversarial_reviewer_prompt]] — pattern used for pre-design peer review

## Open questions for plan-writing phase

None. All architecture, scope, error handling, and testing decisions are locked. Plan will decompose the 2 commits into ordered tasks.
