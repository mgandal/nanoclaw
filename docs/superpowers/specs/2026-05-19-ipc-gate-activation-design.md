# IPC Gate-Activation: skill_* Cluster (save_skill + crystallize_skill)

**Status:** Draft (post-R1 amendments)
**Date:** 2026-05-19
**Author:** brainstorm session with user, locked via Q&A 2026-05-19
**Precursor:** `docs/superpowers/HANDOFF-2026-05-19.md` item #1 ("Gate-activation pass for the bypass list")
**Successor:** plan written via `superpowers:writing-plans` skill (TBD)

## Round-1 Amendments Summary (2026-05-20)

Three adversarial reviewers (R1 silent-failure hunter, R2 contract-composition, R3 test-coverage adversarial) audited the original draft and returned 6 Critical + 8 Important findings. All 14 findings have been absorbed into the body of this spec. The meta-finding: **the original "small policy change" framing was wrong**. Gate-activation revealed legacy debt in the Batch 2G handlers themselves (payloadForStaging stub, missing deps plumbing, isMain authorize block) that was hidden by the very bypass we are removing. The spec now includes Phase 0 (Batch 2G handler fixes) as preparatory work before the policy flip.

| # | Source | Severity | Finding | Resolution |
|---|---|---|---|---|
| C1 | R1 | Critical | The `'processing'` status the spec introduced doesn't exist in `PendingActionStatus` union (`src/db.ts:1494-1499`). Causes type widening, dead-lock recovery, test break, /pending invisibility, schema-migration mislabel. | Dropped `'processing'` entirely. Use existing `'approved'` state via the established 2-step UPDATE pattern at `session-commands.ts:259` (already in production). Eliminates 5 sub-findings in one move. Concurrency: human-typed `/approve` has low race likelihood; existing UPDATE-then-execute pattern is acceptable. |
| C2 | R3 | Critical | `payloadForStaging: { type: 'save_skill' }` at skills.ts:474, 628 is a stub, not the actual input. Approve-replay would fail with "Missing required parameters." Round-trip is broken today. | Added Phase 0 step: change both handlers' `payloadForStaging` to include actual `skillName`, `skillContent` (save_skill) and `agent`, `skillName`, `skillBody`, `selfReportedConfidence` (crystallize_skill). |
| C3 | R3 | Critical | `handler.ts:421` returns without writing result file when `decision.stage===true`. `responseKind: 'result'` handlers hang container poller for IPC_TIMEOUT_MS. | Added Phase 0 step: extend `handler.ts:421` to write a stage-path result file: `{ executed: false, staged: true, pendingId: 'pa_xxx', message: 'Staged for approval: pa_xxx' }`. Container poller sees this immediately; agent gets "staged" reply instead of timeout. |
| C4 | R3 | Critical | `src/index.test.ts` globally mocks `extractSessionCommand: vi.fn(() => null)` — adding 12 approval tests in same file conflicts. | New test file: `src/index-approval.test.ts`. No global session-commands mock; uses fresh fixture per test. Keeps existing 100+ tests untouched. |
| C5 | R3 | Critical | T26/T27 tautological — without compound-source naming + on-disk trust.yaml under `DATA_DIR/agents/<unique>/trust.yaml`, gate is bypassed and tests pass for the wrong reason. | T26/T27 rewritten to use compound-source pattern from existing T11/T20 (skills.test.ts:875-917). Each test creates a unique agent dir + trust.yaml under tmpdir, then dispatches via the compound-source pattern. |
| C6 | R3 | Critical | No test verifies `pending_actions.payload_json` contains the ACTUAL input, not the type stub. | Added T26.5 / T27.5: stage→read DB row→assert `JSON.parse(payload_json)` deep-equals the original input. The load-bearing roundtrip pin. |
| I1 | R2 | Important | `replayStagedAction` signature elides `deps`, but `IpcHandlerContext.deps` is required (handler.ts:76). TypeScript compile fails. | `replayStagedAction` takes `deps: IpcDeps` and `registeredGroups` parameters, calls existing `buildContext()` at `index.ts:917` to produce a real context. Byte-identical to normal dispatch except skip `gateAndStage`. |
| I2 | R2 | Important | `if (!ctx.isMain) return null` at skills.ts:470, 624 makes non-main staging IMPOSSIBLE. D6/EC7/T15 are dead code for these handlers. | Added Phase 0 step: drop the `isMain` block from both authorize() functions. Post-fix, trust.yaml policy is the only restriction. Non-main groups can now stage AND approve their own actions. |
| I3 | R3 | Important | T24/T25 tautological (same words as source change). | Replaced with behavior assertions: "dispatcher invokes `gateAndStage` (spy on `loadAgentTrust`, assert called once)" — pins routing, not line-edit. |
| I4 | R3 | Important | No exact-list pin on `SKIP_GATE_ALLOWLIST`. Future "cleanup" could silently drop `task_add` etc. | Added T-allowlist-exact-pin: `expect([...SKIP_GATE_ALLOWLIST].sort()).toEqual([<full sorted list>])`. Single regression sentinel. |
| I5 | R3 | Important | Spec referenced `parseApprovalCommand`; actual function name is `extractApprovalCommand`. | Replaced all references throughout the spec. |
| I6 | R3 | Important | Mutation matrix (4 mutations) too weak. | Adopted R3's 6-mutation matrix (M1–M6): full trust-resolution chain, allowlist-not-stripped, allowlist-only-stripped, payloadForStaging revert, migration whitespace, slash-cmd reorder. |
| I7 | R3 | Important | Migration script test only checks idempotency; doesn't validate that crystallize_skill actually loads from disk as `'draft'`. | Added T28.5: round-trip resulting YAML through `loadAgentTrust`, assert `trust.actions.crystallize_skill === 'draft'`. Catches wrong-section append, whitespace, etc. |
| I8 | R2 | Minor | T1/T2 must invoke `replayStagedAction` directly (not via dispatcher) — replay path doesn't go through dispatcher's result-file write. | T1/T2 specifically state: "test fixture invokes `replayStagedAction(...)` directly and asserts on returned string; does NOT go through `dispatchIpcAction`." |

**New phase structure** (was 6 sequential commits, now 7):

| Phase | Commits | Subject | Reversible alone? |
|---|---|---|---|
| **Phase 0 (NEW)** | 3 commits | Batch 2G handler fixes: payloadForStaging real payload, drop isMain authorize, add stage-path result file in handler.ts | Yes — gate-activation-neutral; legacy bypass behavior preserved |
| Phase 1 | 1 commit | Migration script + trust.yaml diffs | Yes — dormant entries |
| Phase 2 | 1 commit | New `src/replay-staged-action.ts` module + tests | Yes — unused until Phase 3 wires it |
| Phase 3 | 1 commit | Slash-command wiring in `src/index.ts` + tests in new `src/index-approval.test.ts` | Yes — wiring active but no rows to approve |
| Phase 4 | 1 commit | The policy flip: allowlist + skipGate edits + skills.test.ts updates | Yes — single revert restores bypass |
| Phase 5 | 1 commit (or part of P4) | Mutation testing per D12; test fixups | Yes |

## Goal

Close the legacy preserve-bypass on `save_skill` and `crystallize_skill` so they honor `trust.yaml` policy via `checkTrustAndStage`, AND wire the existing-but-unused `/pending` and `/approve` slash command infrastructure into the live Telegram message loop so users can actually approve the staged actions. End-state: a `save_skill` call from any agent lands in `pending_actions` (status `pending`); user runs `/approve pa_xxx` in Telegram; the action replays end-to-end and writes the real skill file.

This is a real policy change, not a mechanical migration. The IPC migration arc (Batches 2B–2G) was deliberately structural-only to keep blast radius small. This spec lights up the policy half of the work.

## Non-Goals

- Gate-activation for `task_add`, `task_close`, `task_reopen`, or `pageindex_index`. These are higher-frequency actions with NO existing trust.yaml entries; each would require its own per-agent default policy decision. Out of scope for this spec — future batch.
- Approval-queue observability metrics (queue depth, latency histograms, approval ratio). Worth tracking; deferred to a separate observability batch to keep this spec focused.
- Slash-command router refactor. Pattern is 4 commands (`/new`, `/remote-control`, `/approve`, `/pending`); refactor pressure starts around 6–8. Today this means inline parsing in `src/index.ts` next to the existing `/new` check — matches current convention.
- Auto-revive logic on transient replay failures. Failures stay `failed`; user re-stages via the agent. Avoids hidden retry loops (per MEMORY entry `feedback_silent_failure_wedge_anti_pattern`).

## Background

### What exists today (verified 2026-05-19)

1. **`SKIP_GATE_ALLOWLIST`** at `src/ipc/handler.ts:21-54` — `save_skill` and `crystallize_skill` are listed under the "Writes that bypassed the gate in the if-ladder" section with a `TODO: gate` comment. The 9 agent trust.yaml files each have `save_skill: draft` (dormant). No trust.yaml entry exists for `crystallize_skill`.
2. **`checkTrustAndStage`** at `src/trust-enforcement.ts:98` — combines `checkTrust` decision + audit log + (on stage) pending_actions insert. `draft` and `ask` both produce `{allowed: false, stage: true}`. Missing action types default to `'ask'` (per `checkTrust` line 50).
3. **`gateAndStage`** at `src/ipc/trust-gate.ts:34` — the dispatcher's call point. Handlers that return `skipGate: true` (allowed only if their type is in `SKIP_GATE_ALLOWLIST`) bypass this entirely. Handlers without `skipGate` flow through.
4. **`pending_actions` table** at `src/db.ts:137` — schema includes `id, group_folder, agent_name, action_type, summary, payload_json, status, created_at`. Status enum: `'pending' | 'approved' | 'rejected' | 'executed' | 'failed'`.
5. **`extractApprovalCommand` and `handleApprovalCommand`** at `src/session-commands.ts:21-300` — fully implemented, fully tested (`src/session-commands.test.ts`). Supports `/approve <id>` and `/pending`. Auth: main can approve any; non-main scoped to own group via `isMainGroup ? undefined : sourceGroupFolder` filter at line 213.
6. **The wiring gap**: `handleApprovalCommand` is **never called from `src/index.ts` or anywhere in the live message loop.** `src/index.ts:116` imports something from `./session-commands.js` but neither `extractApprovalCommand` nor `handleApprovalCommand`. Approval rows could be inserted today (no callers stage `save_skill` to `draft` because of the allowlist), but if they were, nobody could approve them.

### Why this design now

Two prerequisites finally lined up:

- The IPC migration arc closing (Batch 2G) put `save_skill` and `crystallize_skill` behind typed handlers with clean `authorize()` returns. Activating the gate is now a 2-line change in `skills.ts` plus an allowlist edit.
- The dormant `save_skill: draft` entries have been sitting in trust.yaml since C13 (2026-04-19) waiting for this activation. Tests for `checkTrustAndStage` cover the `draft` path already.

The remaining gap (approval-surface wiring) is small enough to ship alongside the policy activation rather than spec it separately.

## Locked decisions (from brainstorm)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Scope | save_skill + crystallize_skill | Cohesive skill-creation cluster; keeps blast radius small; validates pattern for future batches. task_*/pageindex_index need per-action default policy work that's out of scope today. |
| D2 | Trust level | `draft` for both, all 9 agents | Symmetric with existing `save_skill: draft`. Matches the spirit of "real policy change adds oversight, not bypasses". |
| D3 | Rollout shape | Direct, single commit, takes effect on next restart | No flag machinery. Revert is one commit if something explodes. Pending_actions UX already exists for other staged actions (publish_to_bus, etc.). |
| D4 | Approval surface | Ship wiring in same spec | Otherwise pending rows accumulate as dead data. End-to-end shipping is the only honest answer. |
| D5 | Gate behavior on `/approve` | Bypass `checkTrustAndStage` on replay | The approval IS the authorization; re-running `checkTrust` would re-stage forever. Standard `pending_actions → executed` semantic. |
| D6 | Slash-command access | Any group, scoped to own actions | Matches existing `handleApprovalCommand` auth contract at `session-commands.ts:213`. Main approves any; non-main scoped to own group. |
| D7 | Replay registry access | Direct import of `getIpcHandler` | Matches handler-module convention; avoids DI plumbing that nothing else needs. Tests use `_resetHandlersForTests` + `registerIpcHandler` for stubs. |
| D8 | Trust.yaml edit method | One-off TypeScript migration script using YAML library | Validates parse before write; idempotent re-runs; committed alongside diffs as record. Matches `publishKnowledge`'s YAML safety pattern. |
| D9 | Stale pending threshold | 7 days, env-configurable via `PENDING_STALE_DAYS` | Encourages timely review; aligns with weekly cadence. Env var lets ops adjust without recompile. |
| D10 | Malformed `/approve` | Prefix match + usage hint | `^/approve(\s|$)` triggers preprocessor; strict regex `^/approve\s+([A-Za-z0-9_-]+)$` for accept; reject with usage on miss. No silent pass-through. |
| D11 | Replay failure UX | Stay `failed`, no auto-revive | Surfaces real problems instead of hiding them. User must explicitly re-stage via agent. Matches MEMORY `feedback_silent_failure_wedge_anti_pattern`. |
| D12 | Mutation testing | Required pre-merge for 3 listed mutations | Discipline matches `da0854e7` (parallel session). Each load-bearing test must break when its source line is reverted. |

## Architecture

Two-sided change shipped in one commit:

```
┌─────────────────────────┐         ┌──────────────────────────┐
│   Policy side (gating)   │         │ Approval-surface side    │
│                          │         │                          │
│ • Remove from allowlist  │         │ • Parse /pending,/approve│
│ • Strip skipGate:true    │         │ • Call handleApprovalCmd │
│ • Add crystallize_skill  │         │ • Replay via new module  │
│   draft to 9 trust.yamls │         │ • Reply to Telegram chat │
└──────────┬───────────────┘         └─────────────┬────────────┘
           │                                       │
           ▼                                       ▼
   ┌──────────────────┐                  ┌────────────────────┐
   │ gateAndStage     │                  │ replayStagedAction │
   │ (existing)       │                  │ (new module)       │
   │                  │                  │                    │
   │ → stages in      │                  │ → bypasses gate    │
   │   pending_actions│                  │ → executes handler │
   │ → audit row      │                  │ → audit row        │
   └──────────────────┘                  └────────────────────┘
```

### Happy-path data flow

**Stage path** (agent calls `save_skill`):
1. Agent calls `mcp__nanoclaw__save_skill(...)` → MCP tool writes IPC task file.
2. Host `ipc.ts` watcher → `dispatchIpcAction(payload, ctx)`.
3. `handler.authorize()` returns `{target, summary, payloadForStaging}` (no `skipGate`).
4. `dispatchIpcAction` → `gateAndStage()` → `checkTrustAndStage()`.
5. `checkTrust` reads `trust.actions.save_skill === 'draft'` → returns `{allowed: false, stage: true, pendingId: 'pa_abc123'}`.
6. INSERT `pending_actions(id='pa_abc123', payload_json=<payload>, status='pending')`.
7. INSERT `agent_actions(outcome='staged', pendingId='pa_abc123')`.
8. `handler.execute()` NEVER fires.
9. Result returned to agent: `{executed: false, staged: true, pendingId: 'pa_abc123', message: 'Staged for approval'}`.

**Approval path** (user runs `/approve pa_abc123`):
10. Telegram message hits `src/index.ts` message preprocessor (BEFORE agent handoff).
11. `extractApprovalCommand` extracts `{kind: 'approve', id: 'pa_abc123'}`.
12. `handleApprovalCommand({command, sourceGroupFolder, isMainGroup, db, execute: replayStagedAction})`.
13. Stale check (created_at + `PENDING_STALE_DAYS` env) — reject if expired.
14. Auth check — non-main can only approve own-group rows.
15. Re-read row (after stale + auth checks); the existing `row.status !== 'pending'` guard at `session-commands.ts:248` returns `"Pending action pa_abc is already <status>."` if it's not still `'pending'` — covers the race-loser path. INSERT `agent_actions(outcome='denied_already')` on this branch. (No NEW status value introduced; uses existing `PendingActionStatus` union — R1-C1 amendment.)
16. `db.updatePendingActionStatus(command.id, 'approved')` — existing 2-step UPDATE pattern at `session-commands.ts:259`. Concurrency note: this is a blind UPDATE, not CAS. Two simultaneous `/approve` calls could both pass the row.status check and both UPDATE to 'approved'. Accepted because `/approve` is human-typed (concurrent race vanishingly unlikely in practice). The execute callback is idempotent-safe in the worst case because Phase 0's payloadForStaging fix means the payload is fully self-contained.
17. Invoke `execute` callback → `replayStagedAction({action_type, payload: JSON.parse(row.payload_json), group_folder, agent_name, deps, registeredGroups})`. (Note: `deps` + `registeredGroups` threaded per R2-I1 amendment.)
18. `replayStagedAction`: `getIpcHandler('save_skill')` → handler; build real `IpcHandlerContext` via existing `buildContext(group_folder, /*isMain=*/true, deps)` at `src/ipc/handler.ts` (NOT a hand-rolled stub — R2-I1 amendment); invoke `handler.execute(payload, ctx)` directly (bypasses `gateAndStage` per D5).
19. Handler executes — writes skill file, fires bus message, etc.
20. `db.updatePendingActionStatus(command.id, 'executed', resultText.slice(0, 200))`.
21. INSERT `agent_actions(outcome='approved', pendingId='pa_abc123', summary='approved by <approver>')`.
22. Reply to Telegram: `"Approved pa_abc123: <truncated executor result>"`.

## Components

### Files modified — Phase 0 (Batch 2G handler fixes, gate-activation-neutral)

R2/R3 audit revealed legacy debt in the Batch 2G handlers that gate-activation would expose. These changes preserve the bypass behavior but fix the underlying handlers so they CAN be gated cleanly.

| File | Change | LOC | R-finding |
|---|---|---|---|
| `src/ipc/handlers/skills.ts` (Phase 0) | Change `saveSkillHandler.authorize` payloadForStaging from `{type:'save_skill'}` to `{type:'save_skill', skillName: input.skillName, skillContent: input.skillContent}` so `pending_actions.payload_json` stores the actual input. Required for approve→replay roundtrip. Same fix in `crystallizeSkillHandler.authorize` for its 4 fields. | ±10 | R3-C2 |
| `src/ipc/handlers/skills.ts` (Phase 0) | Drop `if (!ctx.isMain) return null;` from both authorize() functions (lines 470 + 624). Trust.yaml policy becomes the only restriction post-fix; non-main agents can stage AND approve their own actions. | −4 | R2-I2 |
| `src/ipc/handler.ts` (Phase 0) | At line 421, when `decision !== null && !decision.allowed && decision.stage === true && responseKind === 'result'`: write a stage-result file `{ executed: false, staged: true, pendingId: decision.pendingId, message: 'Staged for approval: <pendingId>' }` so the container poller doesn't hang. | +12 | R3-C3 |

### Files modified — Phase 4 (the policy flip)

| File | Change | LOC | R-finding |
|---|---|---|---|
| `src/ipc/handler.ts` | Remove `'save_skill'` and `'crystallize_skill'` from `SKIP_GATE_ALLOWLIST`. Update inline `TODO` comment. | −2, ±3 | D1 |
| `src/ipc/handlers/skills.ts` | Remove `skipGate: true as const` from both authorize() returns (the `as const` line still exists post-Phase-0 because Phase 0 only changed payloadForStaging contents + dropped isMain block). | −2 (one per handler) | D1 |

### Files modified — Phase 3 (approval-surface wiring)

| File | Change | LOC | R-finding |
|---|---|---|---|
| `src/index.ts` | Add slash-command preprocessor BEFORE agent handoff (same level as existing `/new` check at line 399). Parses `/pending` and `/approve <id>` via `extractApprovalCommand`; calls `handleApprovalCommand` with host-side `execute` callback wired to `replayStagedAction`; sends result string back to Telegram. | +60–80 | D4 |

### Files modified — Phase 1 (trust.yaml population)

| File | Change | LOC | R-finding |
|---|---|---|---|
| `data/agents/{9 agents}/trust.yaml` | Add `crystallize_skill: draft` to each (mirror existing `save_skill: draft` indentation). Performed by migration script (D8). | +1 per file × 9 | D2 |

### Files created

| File | Phase | Purpose | LOC | R-finding |
|---|---|---|---|---|
| `src/replay-staged-action.ts` | Phase 2 | Host-side replay executor. Exports `replayStagedAction({action_type, payload, group_folder, agent_name, deps, registeredGroups}): Promise<string>`. Calls existing `buildContext(group_folder, /*isMain=*/true, deps)` to produce a real `IpcHandlerContext` (byte-identical to normal dispatch, only diff is "skip gateAndStage"). Looks up handler via `getIpcHandler`; invokes `handler.execute(payload, ctx)` directly; formats result. | ~120 | R2-I1 |
| `scripts/migrations/2026-05-19-add-crystallize-trust.ts` | Phase 1 | One-off migration script. Reads each `data/agents/*/trust.yaml`, validates parse via YAML lib, adds `crystallize_skill: draft` after the existing `save_skill: draft` line (idempotent — skip if present), validates all 9 files parse before writing any. Has `--dry-run` (default) and `--apply` modes. | ~80 | D8 |
| `src/replay-staged-action.test.ts` | Phase 2 | Unit tests for the replay executor (see Testing section). | ~150 | — |
| `src/index-approval.test.ts` (NEW, replaces appending to index.test.ts) | Phase 3 | Integration tests for slash-command wiring. Separate file so it doesn't inherit `src/index.test.ts`'s global mock of `extractSessionCommand` which would break the new tests. | ~200 | R3-C4 |
| `tests/migrations/add-crystallize-trust.test.ts` | Phase 1 | Tests for the migration script (idempotency, malformed yaml rejection, post-write `loadAgentTrust` round-trip). | ~60 | R3-I7 |

### Files modified for tests

| File | Coverage delta | Phase |
|---|---|---|
| `src/ipc/handlers/skills.test.ts` | Update existing SKIP_GATE_ALLOWLIST membership tests (off-allowlist set). Replace tautological "no skipGate" asserts (R3-I3) with dispatcher-routing behavior assertions. Add T26/T27 rewrites with compound-source pattern. Add T26.5/T27.5 payloadForStaging-roundtrip pins (R3-C6). Add T-allowlist-exact-pin (R3-I4). Add T-staged-result-file pin for Phase 0's handler.ts change. | Phase 4 |

### Total estimate

LOC numbers below are rough estimates for sizing the work, NOT commitments. The plan-writer (`superpowers:writing-plans`) and subagent implementers will refine these as actual line counts emerge from the work.

- Production: ~250 LOC new + ~70 LOC modified across existing files
- Tests: ~200 LOC new
- Trust.yaml: 9 lines added across 9 files
- Migration script: ~80 LOC

## Data Flow & Edge Cases

### Edge case matrix

| # | Edge case | Handling |
|---|---|---|
| EC1 | Stale pending row (>7 days old) | `handleApprovalCommand` checks `created_at + PENDING_STALE_DAYS env (default 7)`; if expired, reject with `"Pending action pa_xxx is stale (created Nday ago). Run /pending to see current queue."`. INSERT `agent_actions(outcome='rejected_stale')`. |
| EC2 | Agent retired between staging and approval | `replayStagedAction` uses `row.agent_name` as the original caller's identity (skill body has already been authored by that agent; replaying under a different identity would corrupt provenance). If `data/agents/{name}/` does not exist, reject with `"Agent <X> no longer exists."`. |
| EC3 | Concurrent `/approve` race | Re-read row; existing `row.status !== 'pending'` guard at `session-commands.ts:248` returns `"Pending action pa_abc is already <status>."` if a parallel call has already moved it. INSERT `agent_actions(outcome='denied_already')`. (R1-C1 amendment: NO new `'processing'` status — uses existing `'approved'` 2-step UPDATE pattern.) Race-safety is best-effort because the UPDATE is blind not CAS; acceptable because `/approve` is human-typed and concurrent races are vanishingly unlikely. |
| EC4 | Replay failure (handler throws) | `handleApprovalCommand` wraps execute callback in try/catch. On throw: `UPDATE pending_actions SET status='failed', result=<truncated error>`. Reply `"Replay failed: <truncated error>. Action moved to failed state."`. INSERT `agent_actions(outcome='approved_then_failed')`. No auto-revive (D11). |
| EC5 | Malformed `/approve` | Prefix match (`^/approve(\s|$)`) triggers preprocessor (D10). Strict regex `^/approve\s+([A-Za-z0-9_-]+)$` for accept; on miss, reply `"Usage: /approve <id> (no spaces in id). Use /pending to list."`. NO silent pass-through to agent. |
| EC6 | `/approve <unknown_id>` | Existing `handleApprovalCommand` returns `"No pending action with id pa_xyz."`. No behavior change. |
| EC7 | `/approve <cross-group-id>` from non-main | Existing `handleApprovalCommand` auth check at line 235 logs WARN and returns `"You can only approve pending actions from your own group."`. INSERT `agent_actions(outcome='denied_cross_group')`. |
| EC8 | `/pending` from main with empty queue | `"No pending actions."` (existing behavior). |
| EC9 | `/pending` from non-main | Lists only own group's pending rows (existing behavior, no change needed). |
| EC10 | Concurrent `/approve` on row whose handler is slow | First request updates `status='approved'` then takes 30s in `handler.execute`. Second request sees `status='approved'` → returns `"already approved"` immediately via the existing line-248 guard. Original eventually writes `status='executed'`. (R1-C1 amendment.) |

### Observability contract

Every operation produces at least one `agent_actions` row. The outcomes vocabulary for this work:

| outcome | When | Set by |
|---|---|---|
| `staged` | `checkTrustAndStage` decides to stage | Existing `checkTrustAndStage` (no new code) |
| `rejected_stale` | `/approve` of expired row | NEW: `handleApprovalCommand` before invoking executor |
| `denied_cross_group` | Non-main approving cross-group | NEW: `handleApprovalCommand` |
| `denied_already` | Row already moved off `'pending'` (race-loser OR re-approve attempt) | NEW: `handleApprovalCommand` line-248 guard (R1-C1 amendment) |
| `approved` | Successful replay | NEW: `handleApprovalCommand` after `execute` returns |
| `approved_then_failed` | Replay throws | NEW: `handleApprovalCommand` catch block |

All new logger calls include: `pendingId: row.id`, `sourceGroup`, `approverGroup` (may differ from sourceGroup when main approves cross-group), `requestId: null` (no IPC requestId on host-initiated replay). WARN-level for rejections and replay failures; INFO-level for successful staging and approval.

### User-facing reply matrix

| Scenario | Reply |
|---|---|
| `/pending` empty | `"No pending actions."` |
| `/pending` with rows | `"Pending (N):\n• pa_abc — claire save_skill (2h ago): example summary..."` |
| `/approve pa_validid` success | `"Approved: <truncated executor result>"` |
| `/approve <unknown_id>` | `"No pending action with id pa_xyz."` |
| `/approve <stale_id>` | `"Pending action pa_abc is stale (created Nday ago). Run /pending to see current queue."` |
| `/approve <cross_group_id>` non-main | `"You can only approve pending actions from your own group."` |
| `/approve <id>` race-loser or re-approve | `"Pending action pa_abc is already approved."` (existing `session-commands.ts:249` reply — R1-C1 amendment) |
| `/approve <id>` replay-failure | `"Replay failed: <truncated error>. Action moved to failed state."` |
| `/approve` (no id) | `"Usage: /approve <id>. Use /pending to list."` |
| `/approve` (garbage args) | `"Usage: /approve <id> (no spaces in id). Use /pending to list."` |

## Error Handling

Layered defense:

1. **Slash-command preprocessor** rejects malformed input with usage hints (EC5).
2. **`handleApprovalCommand`** validates row existence (EC6), checks staleness (EC1), enforces cross-group auth (EC7), and uses the existing `row.status !== 'pending'` guard at `session-commands.ts:248` for race-detection (EC3 — best-effort, acceptable because `/approve` is human-typed; R1-C1 amendment).
3. **`replayStagedAction`** validates handler-type exists (`getIpcHandler` returning null is a hard error), validates agent dir exists (EC2), propagates handler exceptions.
4. **`handleApprovalCommand` catch block** converts handler exceptions to `failed` state + user reply (EC4).

Failure path is explicit at every layer — no silent swallowing. Logs at WARN level include enough context (`pendingId`, `sourceGroup`, `approverGroup`) to triage from `logs/nanoclaw.log` alone.

## Testing

Test plan revised after R3 audit. Total: ~37 new tests across 5 files (was ~30 across 3). Tautological tests replaced with behavior assertions; missing roundtrip and allowlist pins added.

### Test count summary: ~37 new tests across 5 files

#### 1. `src/replay-staged-action.test.ts` (NEW, ~10 tests) — Phase 2

Unit tests for the replay executor.

| # | Test | Pins | Mode |
|---|---|---|---|
| T1 | `replayStagedAction(save_skill payload)` invoked DIRECTLY (NOT through dispatchIpcAction) — assert returned string contains skill name. R2-I8 amendment. | Happy path | Direct |
| T2 | `replayStagedAction(crystallize_skill payload)` invoked DIRECTLY — assert returned string contains skill name. R2-I8 amendment. | Happy path | Direct |
| T3 | `replayStagedAction(unknown action_type)` → throws `Error('No handler registered for action_type: X')` | EC2 / null handler | |
| T4 | `replayStagedAction(missing agent dir)` → throws `Error('Agent X no longer exists')`. Test injects synthetic `agentsRoot` via payload mutation (R2 finding 4 amendment). | EC2 | |
| T5 | `replayStagedAction(malformed payload)` → handler-level error propagates | Error propagation | |
| T6 | **MUTATION PIN:** `replayStagedAction` does NOT call `gateAndStage` (spy on `checkTrustAndStage`, assert call count 0) | D5 — must break if replay re-stages | |
| T7 | **MUTATION PIN:** `replayStagedAction` does NOT insert `pending_actions` row (spy on `insertPendingAction`, assert 0) | D5 — must break if replay re-stages | |
| T8 | Group-folder mismatch produces clear error (sourceGroup derived from `row.group_folder`, NOT approver) | Provenance | |
| T9 | Handler throw is propagated (caller decides what to do) | Error propagation | |
| T10 | requestId in context is `null` (no IPC requestId on host-initiated replay) | Convention | |
| T10b | (NEW per R2-I1) `replayStagedAction` calls `buildContext(group_folder, true, deps)` — assert `ctx.deps === deps` (real deps threaded, not stubbed) | Contract | |

#### 2. `src/index-approval.test.ts` (NEW separate file, ~13 tests) — Phase 3

R3-C4 amendment: separate file to avoid `src/index.test.ts`'s global mock of `extractSessionCommand`.

| # | Test | Pins |
|---|---|---|
| T11 | `/pending` from main group lists all groups' pending rows (limit 20) | D6 |
| T12 | `/pending` from LAB-claw lists only LAB-claw's pending rows | D6 |
| T13 | `/pending` empty queue → `"No pending actions."` | Existing behavior preserved |
| T14 | `/approve pa_validid` from main → `handleApprovalCommand` called with right args, reply contains "Approved" | Happy path |
| T15 | `/approve pa_validid` from LAB-claw for LAB-claw's row → approved. (R2-I2 amendment: post-isMain-drop, non-main can actually stage rows; this test now reachable.) | D6 |
| T16 | `/approve pa_validid` from LAB-claw for CLAIRE's row → cross-group denial | EC7 |
| T17 | `/approve` no id → `"Usage: /approve <id>..."` | EC5 / D10 |
| T18 | `/approve pa abc def` whitespace in args → `"Usage: /approve <id> (no spaces in id)..."` | EC5 / D10 |
| T19 | `/approve pa_stale` >7 days old → `"Pending action pa_stale is stale..."` | EC1 / D9 |
| T20 | Concurrent `/approve` → first updates to `'approved'`, second sees non-pending and gets `"already approved"` (R1-C1 amendment — uses existing `'approved'` not invented `'processing'`) | EC3 |
| T21 | `/approve <id>` whose handler throws → `"Replay failed:..."` + row moves to `failed` | EC4 / D11 |
| T22 | `/approve this is a great idea` → treated as natural language (fails strict regex), NOT swallowed | D10 |
| T22b | (NEW per R3-H4) `/new /approve pa_xxx` precedence pin: `/new` fires first (trimmed equals check fails → falls through, then `/approve` strict regex fails → natural language path). Documents the precedence choice explicitly. | Precedence |

#### 3. `src/ipc/handlers/skills.test.ts` (MODIFY, ~9 tests added/changed) — Phase 4

| # | Test | Pins | Note |
|---|---|---|---|
| T23 | UPDATE: existing SKIP_GATE_ALLOWLIST membership — assert `save_skill` and `crystallize_skill` NOT in set | D1 | |
| T24 (REWRITTEN per R3-I3) | Behavior assertion: given a payload with no skipGate, `dispatchIpcAction` invokes `gateAndStage` (spy on `loadAgentTrust`, assert called once). Pins dispatcher routing, NOT line-edit. | D1 | Non-tautological |
| T25 (REWRITTEN per R3-I3) | Same as T24 for crystallize_skill. | D1 | Non-tautological |
| T26 (REWRITTEN per R3-C5) | End-to-end with REAL trust.yaml: write `actions: { save_skill: draft }` to `DATA_DIR/agents/<unique>/trust.yaml`; dispatch save_skill via compound-source pattern; assert `pending_actions` row inserted AND NO skill file at `container/skills/<name>/`. Mirrors existing T11/T20 fixture pattern at skills.test.ts:875-917. | D1 + D2 | Real trust chain |
| T26.5 (NEW per R3-C6) | **LOAD-BEARING ROUNDTRIP PIN:** Stage save_skill; read pending_actions row; assert `JSON.parse(payload_json)` deep-equals `{type:'save_skill', skillName:<original>, skillContent:<original>}` (NOT the `{type:'save_skill'}` stub). Without Phase 0 payloadForStaging fix, this test fails. | R3-C2 | Mutation pin for M4 |
| T27 (REWRITTEN per R3-C5) | Same as T26 for crystallize_skill — real trust.yaml + compound source. | D1 + D2 | Real trust chain |
| T27.5 (NEW per R3-C6) | Same as T26.5 for crystallize_skill — payload roundtrip pin. | R3-C2 | Mutation pin for M4 |
| T-allowlist-exact (NEW per R3-I4) | Assert `[...SKIP_GATE_ALLOWLIST].sort()` deep-equals exactly: `['dashboard_query', 'imessage_list_contacts', 'imessage_read', 'imessage_search', 'kg_query', 'knowledge_search', 'pageindex_fetch', 'pageindex_index', 'schedule_wakeup', 'skill_invoked', 'skill_search', 'slack_dm_read', 'task_add', 'task_close', 'task_list', 'task_reopen']`. Single regression sentinel for the WHOLE allowlist. | D1 + Non-Goals | Allowlist-drift pin |
| T-staged-result-file (NEW per R3-C3) | Stage save_skill via dispatchIpcAction; assert result file exists at `DATA_DIR/ipc/<resultsDirName>/<requestId>.json` containing `{executed: false, staged: true, pendingId, message: 'Staged for approval: pa_xxx'}`. Pins Phase 0's handler.ts change so container poller never hangs. | R3-C3 | Phase 0 pin |

#### 4. `tests/migrations/add-crystallize-trust.test.ts` (NEW, ~3 tests) — Phase 1

| # | Test | Pins |
|---|---|---|
| T28 | Idempotency: running twice produces byte-identical YAML output | D8 |
| T28.5 (NEW per R3-I7) | Round-trip: after running migration on a test trust.yaml, call `loadAgentTrust(tmpdir)` and assert `trust.actions.crystallize_skill === 'draft'`. Catches wrong-section append, whitespace mangling, etc. | R3-I7 |
| T29 | Malformed yaml input → rejects without writing any of the 9 files (validate-all-before-write semantics) | D8 |

#### 5. Existing `src/session-commands.test.ts` (UNCHANGED — R1-C1 amendment)

R1's amendment by adopting the existing `'approved'` state means `session-commands.ts:259` is unchanged. The existing test at `session-commands.test.ts:735` (`expect(db.statusUpdates.map((u) => u[1])).toEqual(['approved', 'executed'])`) is preserved as-is. No edits needed to this file.

### Mutation testing (D12 — strengthened per R3-I6 — required pre-merge)

The original 4-mutation matrix had tautological pins (T24/T25 weren't load-bearing). R3 proposed a 6-mutation matrix that exercises the full trust-resolution chain plus the most likely accidental regressions. Adopted.

| # | Mutation | Test that MUST break | Notes |
|---|---|---|---|
| M1 | Strip `skipGate: true` from `saveSkillHandler.authorize` AND remove from `SKIP_GATE_ALLOWLIST` AND set `save_skill: autonomous` in fixture trust.yaml | T26 must fail (file IS written, NO pending row) | Full trust chain exercise |
| M2 | Strip `skipGate: true` from `saveSkillHandler.authorize` BUT FORGET to remove from `SKIP_GATE_ALLOWLIST` | T24 (rewritten) must fail — handler falls through to gate normally without writing a `denied_contract_violation` row | Partial-revert detection |
| M3 | Leave `skipGate: true` intact, REMOVE from `SKIP_GATE_ALLOWLIST` | A new test asserts `agent_actions.outcome === 'denied_contract_violation'` for this exact dispatch | Inverse partial-revert |
| M4 | Revert `payloadForStaging: {type:'save_skill', skillName, skillContent}` to `{type:'save_skill'}` (the Batch 2G stub) | T26.5 must fail (`JSON.parse(payload_json)` no longer deep-equals original input) | The Phase 0 load-bearing fix |
| M5 | Add trailing whitespace to `crystallize_skill: draft` line in migration output (`'crystallize_skill: draft '`) | T28.5 must fail (round-trip through `loadAgentTrust` shows `'draft '`, not `'draft'`) | Migration whitespace catch |
| M6 | Re-order `src/index.ts` so `/approve` preprocessor runs AFTER `handleSessionCommand` | T22b precedence test must fail (or a new test pins the order) | Slash-cmd precedence |

If any mutation does NOT break its matching test, the test is tautological. Fix or replace it before merge.

The original D12 matrix (revert-skipGate + revert-replay-bypass + comment-out-migration-insertion) is subsumed: T6/T7 still pin the replay-bypass; the migration insertion is now pinned by T28.5 (round-trip) instead of T28 (idempotency only).

### Test commands

- Per-file: `bun run test src/replay-staged-action.test.ts`
- Full suite: `bun run test`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint`

## Production Readiness

### Backward compatibility

Two backward-compat concerns:

1. **Existing in-flight `save_skill` IPC calls at restart.** None expected — `save_skill` is rare (agent crystallizes a learned pattern, usually 1–2 per session). But if one is mid-flight at the moment of restart, it would land in the new gated path on retry. Acceptable; agent gets `staged` reply and user can approve.
2. **`pending_actions` rows from past activity.** None expected for `save_skill` (allowlist bypassed it; no rows ever staged). `/pending` will show only newly-staged rows from this batch forward.

### Migration sequence (revised post-amendments)

Implementation order matters because (a) Phase 0 Batch 2G handler fixes are prerequisites — without them, the policy flip in Phase 4 ships a broken approve-replay roundtrip and hanging container polls; (b) the migration script must run before the policy flip so trust.yaml has the entries the gate will consult; (c) every phase is independently revertible.

| Phase | Step | Commit(s) | What | Gate-activation-neutral? |
|---|---|---|---|---|
| **Phase 0a** | 1 | 1 commit | Fix `payloadForStaging` in both handlers to include actual input fields (R3-C2). Add T26.5/T27.5 mutation pins (run before Phase 4 flip exercises them). | ✅ Yes — bypass still active |
| **Phase 0b** | 2 | 1 commit | Drop `if (!ctx.isMain) return null;` from both authorize() functions (R2-I2). Add tests pinning non-main staging. | ✅ Yes — bypass still active; non-main behavior changes but stage path still bypassed |
| **Phase 0c** | 3 | 1 commit | Extend `handler.ts:421` to write stage-path result file for `responseKind:'result'` handlers (R3-C3). Add T-staged-result-file pin. | ✅ Yes — fires only when a handler stages (which today never happens for skill_*) |
| **Phase 1** | 4 | 1 commit | Implement migration script + tests; run with `--apply`; commit trust.yaml diffs alongside. | ✅ Yes — dormant entries (still bypassed) |
| **Phase 2** | 5 | 1 commit | Implement `src/replay-staged-action.ts` + `src/replay-staged-action.test.ts`. | ✅ Yes — unused module |
| **Phase 3** | 6 | 1 commit | Implement slash-command wiring in `src/index.ts` + new `src/index-approval.test.ts`. | ✅ Yes — active but no rows to approve |
| **Phase 4** | 7 | 1 commit | **THE POLICY FLIP.** Strip `skipGate: true` from both authorize() returns; remove `save_skill` + `crystallize_skill` from `SKIP_GATE_ALLOWLIST`; update `skills.test.ts` (T23 + rewritten T24/T25 + new T26/T27/T-allowlist-exact). | ❌ No — policy change goes live |
| **Phase 5** | 8 | Part of P4 or separate | Run full suite; perform mutation testing per D12 / 6-mutation matrix; commit any test fixups; push. | ✅ Yes — verification only |

An aborted batch at any phase boundary leaves the codebase in a coherent state. Phases 0a–3 ship infrastructure + handler-debt fixes without changing policy. Phase 4 is the single revertible policy flip.

### Rollback

If the policy flip in Phase 4 produces bad behavior in production:

1. **Revert Phase 4 commit alone** (allowlist + skipGate edits). The Phase 0 handler fixes, Phase 1 trust.yaml entries, Phase 2 replay module, Phase 3 slash-command wiring all stay — they are gate-activation-neutral and would not regress anything by themselves.
2. The new `replay-staged-action.ts` module stays unused (no staged rows once allowlist re-bypasses).
3. The slash-command wiring stays inert (`/pending` returns empty, `/approve` finds no rows).
4. **No SQL DDL change to reverse** (no schema migration was needed; R1-C1 amendment dropped the invented `'processing'` status). Trust.yaml entries stay dormant.
5. Phase 0 fixes are KEPT through rollback — they fix real legacy bugs that were hidden by the bypass; they're worth keeping regardless of the policy decision.

### Compute, network, and disk impact

- **DB writes per action:** stage path = +2 rows (`agent_actions` + `pending_actions`). Approval path = +2 rows (`agent_actions` for approval + `pending_actions` update). Negligible.
- **Disk:** 9 trust.yaml files gain ~30 bytes each. New source files ~10KB total.
- **Network:** none.

## Open Questions

None. All decisions locked via Q&A 2026-05-19.

## Workflow

This spec follows the codebase's standard workflow:

1. ✅ **Brainstorm** — completed via `superpowers:brainstorming`, locked 12 decisions in 5 sections.
2. ✅ **Spec self-review** — controller ran the brainstorming-skill checklist (placeholder scan, internal consistency, scope check, ambiguity check); fixed 2 inline ambiguities.
3. ✅ **User reviews written spec** — user signed off on draft via "go".
4. ✅ **3-reviewer adversarial peer review** — three `general-purpose` agents dispatched in parallel with pre-loaded skeptical hypotheses (per `feedback_adversarial_reviewer_prompt` from MEMORY):
   - R1 (silent-failure hunter): hypothesis "the CAS update introduces a 30s `processing` window other consumers could observe badly" — returned PARTIALLY CONFIRMED + 5 sub-findings (the real bug was that `'processing'` doesn't exist in the type union at all; use existing `'approved'` instead).
   - R2 (contract-composition reviewer): hypothesis "the minimal IpcHandlerContext misses fields handlers depend on" — returned PARTIALLY CONFIRMED + 4 findings (TypeScript `deps` is required; `isMain` authorize block makes non-main staging impossible; test-fixture pattern needs clarification; `agentsRoot` env-gate threading).
   - R3 (test-coverage analyzer): hypothesis "T26/T27 are tautological — don't exercise full trust.yaml chain" — returned CONFIRMED on all 4 sub-hypotheses + 10 findings (6 Critical: payloadForStaging stub, stage path doesn't write result file, index.test.ts global mock conflict, T26/T27 tautological, missing roundtrip pin, missing allowlist exact-pin; plus naming defect; weak mutation matrix).
5. ✅ **Round-1 amendments applied** — all 14 findings (6 Critical + 8 Important) absorbed into spec body; see "Round-1 Amendments Summary" at top. Phase structure restructured from 6 commits to 7 phases (added Phase 0a/0b/0c for Batch 2G handler debt).
6. ⏳ **User reviews amended spec** — pending; controller will ask for sign-off before invoking writing-plans.
7. ⏳ **Plan writing** — invoke `superpowers:writing-plans` to produce step-by-step implementation plan.
8. ⏳ **Subagent-driven execution** — per-task implementer + spec-compliance review + code-quality review per the parallel session's `HANDOFF-2026-05-19.md` workflow.
9. ⏳ **Post-batch holistic code review** — `superpowers:requesting-code-review` after all commits land but before push.
10. ⏳ **Push to origin/main**.

## References

- `docs/superpowers/HANDOFF-2026-05-19.md` — handoff doc that surfaced this work as candidate #1
- `src/ipc/handler.ts:21` — `SKIP_GATE_ALLOWLIST` definition
- `src/ipc/handlers/skills.ts` — current `saveSkillHandler` and `crystallizeSkillHandler`
- `src/trust-enforcement.ts:38` — `checkTrust` + `checkTrustAndStage` logic
- `src/session-commands.ts:21` and `:166` — `extractApprovalCommand` + `handleApprovalCommand` (live but unwired)
- `data/agents/claire/trust.yaml` — reference for `save_skill: draft` placement
- MEMORY: `project_batch2g_skills_cluster_complete.md`, `feedback_silent_failure_wedge_anti_pattern.md`, `feedback_adversarial_reviewer_prompt.md`, `feedback_red_isolation_verify.md`, `feedback_ipc_log_requestid_shrink.md`
