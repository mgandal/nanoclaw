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
| F-G | R3 F3 | Medium | `target: ctx.sourceGroup` is dead weight in drop rows | Omit `target` from helper's `insertAgentAction` call — `AgentActionInput.target?: string` is optional; `insertAgentAction` runtime-NULLs falsy values at `db.ts:1416` |

## Post-redesign peer review summary (Round 2)

Second adversarial round (R4 test-completeness, R5 redesign-integrity, R6 operational-readiness) against the post-redesign spec. 10 additional findings; spec amended inline before this revision committed.

| ID | Source | Severity | Finding | Resolution |
|----|--------|----------|---------|------------|
| F-H | R4 #1 | Critical | Spec sold "mutation-checked" but had no test↔mutation pairing table; 12 of 14 mutations were unspecified | Added explicit mutation table in § Testing |
| F-I | R4 #2 + R5 #3 (converged) | Critical | No `describe: path D` test existed; Invariant 2 un-pinned; regression would ship green | Added path D test block to enumeration |
| F-J | R5 #1 | Critical | `target: NULL` assumed `AgentActionInput.target: string \| null` but actual type is `target?: string` (optional, NOT nullable) | Helper omits `target` field; matches existing dispatcher pattern at `handler.ts:266-274` |
| F-K | R6 #1 | High | `docs/incident-response/ipc-drop-outcomes.md` content undefined; acceptance criterion #7 satisfiable by empty stub | Added "Runbook contents (mandatory)" subsection with required headings + asymmetry call-out |
| F-L | R6 #2 | High | Container poller error `'Request timed out'` unchanged; agent caller blind to new forensic surface | Added Commit 3 — container poller hint at `ipc-mcp-stdio.ts:759` |
| F-M | R4 #3 | High | Catch-path tests under-specified; no spy mechanism named for pino logger | Locked `vi.spyOn(logger, 'error')` mechanism in § Testing |
| F-N | R6 #3 | Medium | Analyzer JS guard fires silently; no observable confirmation guard is working vs dead code | Added `logger.info({filtered: N}, ...)` to JS guard spec |
| F-O | R4 #4 | Medium | "agentName null" test tautology-prone; spec didn't specify how to induce null | Specified: pass bare `sourceGroup` (no compound-key separator) → `parseCompoundKey` returns `{group, agent: null}` |
| F-P | R6 #4 | Medium | No bake-period observation plan; no smoke query, no baseline | Added § Bake observability with smoke query template |
| F-Q | R5 #2 | Medium | Path B `req=` asymmetry operationally lopsided; most-likely 3am scenario has valid requestId but matches nothing | Mandated in runbook content (F-K subsection) |

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
         // target omitted (F-G/F-J): AgentActionInput.target is `target?: string`
         // — passing it would require a value; omission triggers
         // insertAgentAction's `action.target || null` runtime NULL coercion
         // at db.ts:1416, matching the existing dispatcher pattern at
         // handler.ts:266-274 where target is also conditionally omitted.
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
| `scripts/trust/analyze-promotions.ts` | Defense-in-depth: filter `groupRows` against `LADDER` membership before `sorted[0]?.trust_level` lookup at line 92 — protects the pure function against any future caller that skips the SQL filter. **F-N:** emit `logger.info` (or `console.warn` if no pino in script) with `{filtered: N, action_type, agent_name}` when N > 0 so operator sees guard is firing vs dead code | 4-6 |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **F-L (Commit 3):** Update poller timeout message at line 759 from `'Request timed out'` to `'Request timed out (host may have dropped — query agent_actions WHERE outcome LIKE \\'dropped_%\\' AND agent_name=<agent> ORDER BY created_at DESC)'` so agent caller can self-diagnose host-side drops | 1 |
| `docs/context-engineering/ipc-handler-contract.md` | New Rule N paragraph + authoring-checklist sub-bullet + ctx.requestId mutation-timing constraint | ~25 |
| `docs/incident-response/ipc-drop-outcomes.md` | NEW operator runbook | ~60 |
| `src/ipc/handler-batch4-drops.test.ts` | NEW test file, 15 tests + explicit mutation table (F-H, F-I) | ~300 |

### Runbook contents — MANDATORY (F-K, F-Q)

`docs/incident-response/ipc-drop-outcomes.md` MUST contain the following headings + content:

1. **Where the DB lives** — absolute path `store/messages.db` (per memory: NOT `data/nanoclaw.db`). Read-only SQLite via `sqlite3 store/messages.db` from project root.
2. **Outcome glossary** — table mapping `outcome` strings to meaning + first-response action:
   - `dropped_invalid_requestId` → agent sent malformed/missing requestId → likely agent code bug; check container logs for the call site
   - `dropped_invalid_input` → agent sent valid requestId but malformed payload → schema drift; check IpcHandler.parse() for the type
   - `denied_contract_violation` → handler declared `skipGate` without being on the allowlist → contributor bug; revert the handler change
3. **Query templates** — copy-pasteable SELECTs:
   - "agent stuck on poll for requestId=X" — `SELECT created_at, outcome, summary FROM agent_actions WHERE outcome LIKE 'dropped_%' AND summary LIKE '%req=X%' ORDER BY created_at DESC LIMIT 5;`
   - "all drops for agent Y in last hour" — `SELECT created_at, action_type, outcome, summary FROM agent_actions WHERE outcome LIKE 'dropped_%' AND agent_name='Y' AND created_at > datetime('now','-1 hour') ORDER BY created_at DESC;`
   - "drop volume by outcome (last 24h)" — `SELECT outcome, COUNT(*) FROM agent_actions WHERE outcome LIKE 'dropped_%' AND created_at > datetime('now','-1 day') GROUP BY outcome;`
4. **MUST CALL OUT: Path B asymmetry (F-Q)** — explicit warning that `dropped_invalid_requestId` rows have NO `req=` substring (because the malformed value is intentionally not stored). Operator must join those rows by timestamp + agent_name only. The container-side requestId (which IS valid from agent perspective) does NOT appear in path-B rows.
5. **Per-outcome resolution decision tree** — bullets for "if N rows in 5min → page agent operator", "if storm pattern (>100 same outcome same agent in 1min) → suspect agent crash-loop, kill container".
6. **Cross-reference** — link to `docs/context-engineering/ipc-handler-contract.md` Rule 3 (Path D silent-deny) and Rule 6 (skipGate allowlist).

Acceptance criterion #7 is satisfied ONLY when all 6 headings are present with non-empty content.

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
         target=NULL (helper omits field; runtime coerced at db.ts:1416),
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
         target=NULL (helper omits field; runtime coerced at db.ts:1416),
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

### New test file `src/ipc/handler-batch4-drops.test.ts` (15 tests, ~300 LOC)

- `describe: ctx.requestId binding`
  - T1: populates ctx.requestId for result-kind happy path
  - T2: leaves ctx.requestId null for notify-kind
  - T3: leaves ctx.requestId null on malformed-requestId rejection
- `describe: path B synthetic row (malformed requestId)`
  - T4: writes row with trust_level='dispatch_drop_input'
  - T5: writes row with outcome='dropped_invalid_requestId'
  - T6: writes row with summary='malformed requestId' (asserts NO 'req=' substring)
  - T7: skips row write when ctx.agentName is null
- `describe: path C synthetic row (parse rejected)`
  - T8: writes row with trust_level='dispatch_drop_input'
  - T9: writes row with outcome='dropped_invalid_input'
  - T10: writes row with summary CONTAINING 'req=abc123' (validated id)
  - T11: skips row write when ctx.agentName is null
- `describe: path D — invariant 2 pin (F-I)`
  - T12: authorize-null with agent caller writes ZERO synthetic rows (asserts `SELECT COUNT(*) FROM agent_actions WHERE outcome LIKE 'dropped_%' AND agent_name = ?` returns 0; gate row may exist if gate ran, asserted separately)
- `describe: catch path log enhancement (F-M)`
  - T13: logger.error context on result-kind throw includes `requestId` field (use `vi.spyOn(logger, 'error')` and inspect first arg's bindings object)
  - T14: logger.error context on throw includes `agentName` field (same spy)
- `describe: F-O agentName-null induction discipline`
  - T15: passing bare `sourceGroup` (no compound-key separator, e.g. `'telegram_aud'`) to `buildContext()` produces `ctx.agentName === null`, AND the helper short-circuits at the `if (!ctx.agentName) return` guard (this test pins the induction mechanism T7+T11 rely on — without it, T7/T11 are tautology-prone per R4 finding F-O)

**Removed `target` assertions:** Per F-J, the helper omits the `target` field rather than passing `null` literal. Asserting `target IS NULL` in tests is fine (DB stores NULL either way), but the assertion documents row state, not helper behavior.

### Extended existing test files (+2 pattern-pins)

- `src/ipc/handlers/slack.test.ts`: assert logger.info call includes requestId field
- `src/ipc/handlers/imessage.test.ts`: assert at least one logger.warn call includes requestId field (pattern-pin)

### Extended existing test file `scripts/trust/analyze-promotions.test.ts`

- pin: synthetic-row trust_level (e.g., `'dispatch_drop_input'`) in input rows is filtered out, never reaches `nextTrustLevel` and never becomes a promotion candidate (~30 LOC, 1 test)

No new test file needed for `run-analyzer.ts` SELECT — the SQL filter is mechanical and the JS-guard test above already covers the load-bearing case (defense-in-depth invariant: function rejects bad rows regardless of SQL filter).

### Mutation-test discipline (mandatory per `feedback_red_isolation_verify`)

Each test must be mutation-checked: apply the mutation → re-run → confirm test fails → revert → confirm test passes. 15 mutations × 30s manual verify = ~8 min total.

**Explicit test↔mutation table (F-H):**

| Test | Production-code mutation | Expected outcome |
|---|---|---|
| T1 ctx.requestId populated (result-kind) | comment out `ctx.requestId = raw` at handler.ts (post-line-234) | test fails — ctx.requestId stays null |
| T2 ctx.requestId null (notify-kind) | populate ctx.requestId from data.requestId for notify-kind too | test fails — should stay null |
| T3 ctx.requestId null on path B | populate ctx.requestId BEFORE the requestId-validation block | test fails — gets set then dropped on validation fail |
| T4 path B trust_level | change literal `'dispatch_drop_input'` → `'wrong'` at path B helper call | test fails |
| T5 path B outcome | change literal `'dropped_invalid_requestId'` → `'wrong'` at path B helper call | test fails |
| T6 path B no req= in summary | change helper to always interpolate `req=` (drop the `requestId ? ... : ...` ternary) | test fails — req=null appears |
| T7 path B skip on agentName null | remove `if (!ctx.agentName) return` from helper | test fails — row appears with NULL agent_name |
| T8 path C trust_level | change literal `'dispatch_drop_input'` → `'wrong'` at path C helper call | test fails |
| T9 path C outcome | change literal `'dropped_invalid_input'` → `'wrong'` at path C helper call | test fails |
| T10 path C summary has req= | comment out the `requestId ? ... : ...` ternary (always use bare summary) | test fails — no req= substring |
| T11 path C skip on agentName null | same mutation as T7 | test fails |
| T12 path D no synthetic row (F-I) | insert `writeSyntheticAuditRow(ctx, data.type, requestId, 'dispatch_drop_input', 'authorize null', 'dropped_unauthorized')` immediately before `return { handled: true }` at handler.ts:247 | test fails — count > 0 |
| T13 catch log includes requestId | revert catch log context at handler.ts:325 from `{err, type, sourceGroup, requestId, agentName}` to original `{err, type, sourceGroup}` | test fails — spy captures call without requestId |
| T14 catch log includes agentName | same mutation as T13 | test fails |
| T15 F-O induction discipline | accidentally change `parseCompoundKey('telegram_aud')` to return `{group: 'telegram_aud', agent: 'system'}` | test fails — ctx.agentName !== null |

**Spy mechanism (F-M, locked):** All catch-path tests use `const spy = vi.spyOn(logger, 'error')` before dispatch and `expect(spy).toHaveBeenCalledWith(expect.objectContaining({ requestId: ..., agentName: ... }), 'IPC handler execute threw')` after. Reset between tests via `vi.restoreAllMocks()` in `afterEach`.

**Induction mechanism (F-O, locked):** Tests that require `ctx.agentName === null` MUST call `buildContext('telegram_aud', false, mockDeps)` (no compound-key separator `--`), which `parseCompoundKey` returns as `{group: 'telegram_aud', agent: null}`. Tests asserting "agent caller" branch use the compound form (`'telegram_aud--einstein'`).

### Bake observability (F-P)

Day-1 smoke verification (run after Commit 1 ships):
```sql
SELECT outcome, COUNT(*) FROM agent_actions
WHERE outcome LIKE 'dropped_%' AND created_at > datetime('now','-1 hour')
GROUP BY outcome;
```
**Expected:** 0-N rows, where N ≤ ~20/hour under normal operation. Zero rows after 24h = code path might be dead (investigate). >100/hour same outcome = synthetic-row storm (investigate agent crash-loop).

Day-7 baseline:
```sql
SELECT date(created_at), outcome, COUNT(*) FROM agent_actions
WHERE outcome LIKE 'dropped_%' AND created_at > datetime('now','-7 days')
GROUP BY date(created_at), outcome ORDER BY date(created_at);
```
**Expected:** Establishes per-day baseline. Spikes >3σ from mean = investigate.

Add to existing `~/Library/LaunchAgents/com.nanoclaw.health.plist` watchlist as a future enhancement (out of scope for Batch 4 but noted for follow-up).

Specific high-tautology-risk tests requiring extra rigor:
- "path D never writes a row" — assert exactly ONE gate row + ZERO synthetic rows
- "ctx.requestId leaves null for notify" — capture ctx via spy through `buildContext`, assert spy was called with `requestId: null`

### Test infrastructure (reused from Batch 2F)

- `_initTestDatabase(':memory:')` per test
- `_resetHandlersForTests()` per test
- non-deterministic agent names: `test-agent-${Date.now()}-${Math.random().toString(36).slice(2,8)}`
- real `insertAgentAction` write to in-memory DB (closer to production semantics than mocking)

### Acceptance criteria

1. All 15 new tests (T1–T15) pass on first run.
2. All 15 mutation checks in the table fail when mutated, pass when reverted.
3. All existing 2311 tests still pass (no regressions).
4. `bun run typecheck` clean.
5. `bun run lint` zero errors.
6. Manual grep verifies: `scripts/trust/run-analyzer.ts:87` SELECT has `WHERE trust_level IN ('ask','draft','notify','autonomous')` AND `scripts/trust/analyze-promotions.ts` filters `groupRows` by `LADDER.includes(r.trust_level as TrustLevel)` before any `sorted[0]?.trust_level` lookup.
7. `docs/incident-response/ipc-drop-outcomes.md` is committed AND contains all 6 mandatory headings from § Runbook contents (DB location, outcome glossary, query templates, F-Q asymmetry call-out, decision tree, cross-reference). An empty-stub file fails this criterion.
8. `container/agent-runner/src/ipc-mcp-stdio.ts:759` poller error message references `agent_actions WHERE outcome LIKE 'dropped_%'` (F-L verification).
9. Container rebuild via `./container/build.sh` completes and agent-runner-src cache invalidated for at least one test group (`rm -rf data/sessions/{test-group}/agent-runner-src/`).

## Commit shape

**Approach A (locked, amended Round 2):** 3 thin commits, prettier inline pre-commit (sub-choice b). Commit 3 added per F-L.

- **Commit 1 — Dispatcher + observability surface.** Dispatcher changes (helper, ctx.requestId, 2 call sites, catch enhance), analyzer SQL filter (`run-analyzer.ts`), analyzer JS guard + F-N filter-count log (`analyze-promotions.ts`), both doc files (contract + runbook w/ all 6 mandatory headings), new test file (`handler-batch4-drops.test.ts` w/ 15 tests including F-I path D pin), extended analyzer test. ~400 LOC.
- **Commit 2 — Handler logger pass.** Mechanical update to 6 logger call-sites in slack/dashboard-query/imessage handlers + 2 pattern-pin test assertions. ~16 LOC. Host-only.
- **Commit 3 — Container poller hint (F-L).** One-line message change at `container/agent-runner/src/ipc-mcp-stdio.ts:759`. Requires `./container/build.sh` rebuild and `rm -rf data/sessions/{group}/agent-runner-src/` cache invalidation per `feedback_stale_dist_restart_loop` discipline. Separated into own commit so a host-only revert (1+2) does not pull container side. ~3 LOC + rebuild artifact.

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
