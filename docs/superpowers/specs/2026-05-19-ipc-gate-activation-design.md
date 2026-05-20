# IPC Gate-Activation: skill_* Cluster (save_skill + crystallize_skill)

**Status:** Draft (pre-plan)
**Date:** 2026-05-19
**Author:** brainstorm session with user, locked via Q&A 2026-05-19
**Precursor:** `docs/superpowers/HANDOFF-2026-05-19.md` item #1 ("Gate-activation pass for the bypass list")
**Successor:** plan written via `superpowers:writing-plans` skill (TBD)

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
5. **`parseApprovalCommand` and `handleApprovalCommand`** at `src/session-commands.ts:21-300` — fully implemented, fully tested (`src/session-commands.test.ts`). Supports `/approve <id>` and `/pending`. Auth: main can approve any; non-main scoped to own group via `isMainGroup ? undefined : sourceGroupFolder` filter at line 213.
6. **The wiring gap**: `handleApprovalCommand` is **never called from `src/index.ts` or anywhere in the live message loop.** `src/index.ts:116` imports something from `./session-commands.js` but neither `parseApprovalCommand` nor `handleApprovalCommand`. Approval rows could be inserted today (no callers stage `save_skill` to `draft` because of the allowlist), but if they were, nobody could approve them.

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
11. `parseApprovalCommand` extracts `{kind: 'approve', id: 'pa_abc123'}`.
12. `handleApprovalCommand({command, sourceGroupFolder, isMainGroup, db, execute: replayStagedAction})`.
13. Stale check (created_at + `PENDING_STALE_DAYS` env) — reject if expired.
14. Auth check — non-main can only approve own-group rows.
15. CAS update: `UPDATE pending_actions SET status='processing' WHERE id=? AND status='pending'`. If 0 rows affected → INSERT `agent_actions(outcome='denied_race')`, return `"Action pa_abc already being processed."`, do NOT proceed to step 16.
16. Invoke `execute` callback → `replayStagedAction({action_type, payload: JSON.parse(row.payload_json), group_folder, agent_name})`.
17. `replayStagedAction`: `getIpcHandler('save_skill')` → handler; build minimal `IpcHandlerContext`; invoke `handler.execute(payload, ctx)` (bypasses `gateAndStage`).
18. Handler executes — writes skill file, fires bus message, etc.
19. `UPDATE pending_actions SET status='executed', result=<resultText>`.
20. INSERT `agent_actions(outcome='approved', pendingId='pa_abc123', summary='approved by <approver>')`.
21. Reply to Telegram: `"Approved: <truncated executor result>"`.

## Components

### Files modified

| File | Change | Approximate LOC |
|---|---|---|
| `src/ipc/handler.ts` | Remove `'save_skill'` and `'crystallize_skill'` from `SKIP_GATE_ALLOWLIST`. Update inline `TODO` comment to reflect post-activation state. | −2 (allowlist entries), ±3 (comment) |
| `src/ipc/handlers/skills.ts` | Remove `skipGate: true as const` from `saveSkillHandler.authorize` and `crystallizeSkillHandler.authorize`. Both authorize() returns now flow through `gateAndStage()` normally. | −4 |
| `src/index.ts` | Add slash-command preprocessor BEFORE agent handoff (same level as existing `/new` check at line 399). Parses `/pending` and `/approve <id>` via `parseApprovalCommand`; calls `handleApprovalCommand` with host-side `execute` callback wired to `replayStagedAction`; sends result string back to Telegram. | +60–80 |
| `data/agents/{9 agents}/trust.yaml` | Add `crystallize_skill: draft` to each (mirror existing `save_skill: draft` indentation). Performed by migration script (D8). | +1 line per file × 9 = +9 |

### Files created

| File | Purpose | Approximate LOC |
|---|---|---|
| `src/replay-staged-action.ts` | Host-side replay executor. Exports `replayStagedAction({action_type, payload, group_folder, agent_name}): Promise<string>`. Looks up handler via `getIpcHandler`; builds minimal `IpcHandlerContext` for the original caller; invokes `handler.execute(payload, ctx)` directly (NO `gateAndStage`); formats result as a short success/error string. | ~100 |
| `scripts/migrations/2026-05-19-add-crystallize-trust.ts` | One-off migration script. Reads each `data/agents/*/trust.yaml`, validates parse via YAML lib, adds `crystallize_skill: draft` after the existing `save_skill: draft` line (idempotent — skip if present), validates all 9 files parse before writing any. Has `--dry-run` (default) and `--apply` modes. | ~80 |
| `src/replay-staged-action.test.ts` | Unit tests for the replay executor (see Testing section). | ~150 |
| `tests/migrations/add-crystallize-trust.test.ts` | Tests for the migration script (idempotency, malformed yaml rejection). | ~40 |

### Files modified for tests

| File | Coverage delta |
|---|---|
| `src/index.test.ts` | Append ~12 tests for slash-command parsing, scoping, end-to-end stage→approve→execute roundtrip. |
| `src/ipc/handlers/skills.test.ts` | Update existing SKIP_GATE_ALLOWLIST membership tests (`save_skill`, `crystallize_skill` now in *off-allowlist* set). Add 2 tests verifying authorize() returns NO `skipGate` field. Add 2 end-to-end tests (call → stage, NOT execute). |

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
| EC3 | Concurrent `/approve` race | Atomic SQL `UPDATE pending_actions SET status='processing' WHERE id=? AND status='pending'` first; if affected rows = 0, return `"Action pa_abc already being processed."`. INSERT `agent_actions(outcome='denied_race')`. Then execute. |
| EC4 | Replay failure (handler throws) | `handleApprovalCommand` wraps execute callback in try/catch. On throw: `UPDATE pending_actions SET status='failed', result=<truncated error>`. Reply `"Replay failed: <truncated error>. Action moved to failed state."`. INSERT `agent_actions(outcome='approved_then_failed')`. No auto-revive (D11). |
| EC5 | Malformed `/approve` | Prefix match (`^/approve(\s|$)`) triggers preprocessor (D10). Strict regex `^/approve\s+([A-Za-z0-9_-]+)$` for accept; on miss, reply `"Usage: /approve <id> (no spaces in id). Use /pending to list."`. NO silent pass-through to agent. |
| EC6 | `/approve <unknown_id>` | Existing `handleApprovalCommand` returns `"No pending action with id pa_xyz."`. No behavior change. |
| EC7 | `/approve <cross-group-id>` from non-main | Existing `handleApprovalCommand` auth check at line 235 logs WARN and returns `"You can only approve pending actions from your own group."`. INSERT `agent_actions(outcome='denied_cross_group')`. |
| EC8 | `/pending` from main with empty queue | `"No pending actions."` (existing behavior). |
| EC9 | `/pending` from non-main | Lists only own group's pending rows (existing behavior, no change needed). |
| EC10 | Concurrent `/approve` on row whose handler is slow | First request CAS-wins, then takes 30s in `handler.execute`. Second request sees `status='processing'` → returns race-loser message immediately. Original eventually completes and writes `status='executed'`. |

### Observability contract

Every operation produces at least one `agent_actions` row. The outcomes vocabulary for this work:

| outcome | When | Set by |
|---|---|---|
| `staged` | `checkTrustAndStage` decides to stage | Existing `checkTrustAndStage` (no new code) |
| `rejected_stale` | `/approve` of expired row | NEW: `handleApprovalCommand` before invoking executor |
| `denied_cross_group` | Non-main approving cross-group | NEW: `handleApprovalCommand` |
| `denied_race` | CAS race-loser | NEW: `handleApprovalCommand` |
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
| `/approve <id>` race-loser | `"Action pa_abc already being processed."` |
| `/approve <id>` replay-failure | `"Replay failed: <truncated error>. Action moved to failed state."` |
| `/approve` (no id) | `"Usage: /approve <id>. Use /pending to list."` |
| `/approve` (garbage args) | `"Usage: /approve <id> (no spaces in id). Use /pending to list."` |

## Error Handling

Layered defense:

1. **Slash-command preprocessor** rejects malformed input with usage hints (EC5).
2. **`handleApprovalCommand`** validates row existence (EC6), checks staleness (EC1), enforces cross-group auth (EC7), performs atomic CAS for concurrency (EC3).
3. **`replayStagedAction`** validates handler-type exists (`getIpcHandler` returning null is a hard error), validates agent dir exists (EC2), propagates handler exceptions.
4. **`handleApprovalCommand` catch block** converts handler exceptions to `failed` state + user reply (EC4).

Failure path is explicit at every layer — no silent swallowing. Logs at WARN level include enough context (`pendingId`, `sourceGroup`, `approverGroup`) to triage from `logs/nanoclaw.log` alone.

## Testing

### Test count summary: ~30 new tests across 3 files

#### 1. `src/replay-staged-action.test.ts` (NEW, ~10 tests)

Unit tests for the replay executor.

| # | Test | Pins |
|---|---|---|
| T1 | `replayStagedAction(save_skill payload)` → calls `saveSkillHandler.execute`, returns formatted result | Happy path |
| T2 | `replayStagedAction(crystallize_skill payload)` → calls `crystallizeSkillHandler.execute`, returns formatted result | Happy path |
| T3 | `replayStagedAction(unknown action_type)` → throws `Error('No handler registered for action_type: X')` | EC2 / null handler |
| T4 | `replayStagedAction(missing agent dir)` → throws `Error('Agent X no longer exists')` | EC2 |
| T5 | `replayStagedAction(malformed payload)` → handler-level error propagates | Error propagation |
| T6 | **MUTATION PIN:** `replayStagedAction` does NOT call `gateAndStage` (spy on `checkTrustAndStage`, assert call count 0) | D5 — must break if replay re-stages |
| T7 | **MUTATION PIN:** `replayStagedAction` does NOT insert `pending_actions` row (spy on `insertPendingAction`, assert 0) | D5 — must break if replay re-stages |
| T8 | Group-folder mismatch produces clear error (sourceGroup derived from `row.group_folder`, NOT approver) | Provenance |
| T9 | Handler throw is propagated (caller decides what to do) | Error propagation |
| T10 | requestId in context is `null` (no IPC requestId on host-initiated replay) | Convention |

#### 2. `src/index.test.ts` (APPEND, ~12 tests)

Integration tests for the slash-command wiring.

| # | Test | Pins |
|---|---|---|
| T11 | `/pending` from main group lists all groups' pending rows (limit 20) | D6 |
| T12 | `/pending` from LAB-claw lists only LAB-claw's pending rows | D6 |
| T13 | `/pending` empty queue → `"No pending actions."` | Existing behavior preserved |
| T14 | `/approve pa_validid` from main → `handleApprovalCommand` called with right args, reply contains "Approved" | Happy path |
| T15 | `/approve pa_validid` from LAB-claw for LAB-claw's row → approved | D6 |
| T16 | `/approve pa_validid` from LAB-claw for CLAIRE's row → cross-group denial | EC7 |
| T17 | `/approve` no id → `"Usage: /approve <id>..."` | EC5 / D10 |
| T18 | `/approve pa abc def` whitespace in args → `"Usage: /approve <id> (no spaces in id)..."` | EC5 / D10 |
| T19 | `/approve pa_stale` >7 days old → `"Pending action pa_stale is stale..."` | EC1 / D9 |
| T20 | Concurrent `/approve` → only one writes `executed`, other gets "already being processed" | EC3 |
| T21 | `/approve <id>` whose handler throws → `"Replay failed:..."` + row moves to `failed` | EC4 / D11 |
| T22 | `/approve this is a great idea` → treated as natural language (fails strict regex), NOT swallowed | D10 |

#### 3. `src/ipc/handlers/skills.test.ts` (MODIFY, ~5 tests added/changed)

| # | Test | Pins |
|---|---|---|
| T23 | UPDATE: existing SKIP_GATE_ALLOWLIST membership assertion — `save_skill` and `crystallize_skill` now in *off-allowlist* set | D1 |
| T24 | NEW: `saveSkillHandler.authorize` returns NO `skipGate` field | D1 |
| T25 | NEW: `crystallizeSkillHandler.authorize` returns NO `skipGate` field | D1 |
| T26 | NEW: end-to-end — call save_skill via `dispatchIpcAction` with `draft` trust.yaml → pending_actions row inserted, NO skill file written | D1 + D2 |
| T27 | NEW: end-to-end — same for crystallize_skill | D1 + D2 |

#### 4. `tests/migrations/add-crystallize-trust.test.ts` (NEW, ~2 tests)

| # | Test | Pins |
|---|---|---|
| T28 | Idempotency: running twice produces same result | D8 |
| T29 | Malformed yaml input rejected without writing | D8 |

### Mutation testing (D12 — required pre-merge)

Before declaring this work done, the controller (human or agent) must manually revert each of the following source-side changes and confirm the matching test breaks:

| Mutation | Test that must break |
|---|---|
| Add back `skipGate: true as const` to `saveSkillHandler.authorize` | T24 must fail |
| Add back `skipGate: true as const` to `crystallizeSkillHandler.authorize` | T25 must fail |
| Make `replayStagedAction` call `checkTrustAndStage` instead of `handler.execute` directly | T6 + T7 must fail |
| Comment out the `crystallize_skill: draft` insertion in migration script | T28 (idempotency) must fail |

If any mutation does NOT break its matching test, the test is tautological. Fix or replace it before merge.

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

### Migration sequence

Implementation order matters because the migration script must run before the gate-activation commit (otherwise live `save_skill` calls hit `checkTrustAndStage`, see no `crystallize_skill` entry, default to `'ask'`, and stage). Recommended sequence:

1. Implement migration script + tests; commit alone.
2. Run migration script (`--apply`); commit trust.yaml diffs alongside.
3. Implement `replay-staged-action.ts` + tests; commit alone.
4. Implement `index.ts` slash-command wiring + tests; commit alone.
5. Strip `skipGate: true` from `skills.ts` handlers + update `skills.test.ts`; remove allowlist entries in `handler.ts`; commit alone.
6. Run full suite; perform mutation testing per D12; commit any test fixes; push.

Steps 1–4 are gate-activation-neutral (script + new modules + new wiring without policy change). Step 5 is the policy flip. This means an aborted batch leaves the codebase with the new infrastructure but legacy bypass behavior — recoverable state.

### Rollback

If the gate-activation produces bad behavior in production:

1. Revert step 5 commit alone (allowlist + skipGate edits). The migration script's trust.yaml changes can stay (they're dormant entries when the allowlist re-bypasses).
2. The new `replay-staged-action.ts` module stays unused; the slash-command wiring stays inert (no pending rows to approve).
3. No DB schema migration to reverse.

### Compute, network, and disk impact

- **DB writes per action:** stage path = +2 rows (`agent_actions` + `pending_actions`). Approval path = +2 rows (`agent_actions` for approval + `pending_actions` update). Negligible.
- **Disk:** 9 trust.yaml files gain ~30 bytes each. New source files ~10KB total.
- **Network:** none.

## Open Questions

None. All decisions locked via Q&A 2026-05-19.

## Workflow

This spec follows the codebase's standard workflow:

1. ✅ **Brainstorm** — completed via `superpowers:brainstorming`, locked 12 decisions in 5 sections.
2. ⏳ **Spec self-review** — controller runs the brainstorming-skill checklist (placeholder scan, internal consistency, scope check, ambiguity check).
3. ⏳ **User reviews written spec** — controller asks user to review before plan-writing.
4. ⏳ **3-reviewer adversarial peer review** — three `general-purpose` agents pre-loaded with specific skeptical hypotheses to falsify (per `feedback_adversarial_reviewer_prompt` from MEMORY). Suggested hypotheses:
   - R1 (silent-failure hunter): "the CAS update is atomic, but there's a window between CAS and execute where a third actor could see status='processing' and do something stupid"
   - R2 (contract-composition reviewer): "the replay executor's minimal IpcHandlerContext misses a field that some handler depends on"
   - R3 (test-coverage analyzer): "T26/T27 (end-to-end stage tests) are tautological because they call dispatchIpcAction without the full trust.yaml load path"
5. ⏳ **Plan writing** — invoke `superpowers:writing-plans` to produce step-by-step implementation plan.
6. ⏳ **Subagent-driven execution** — per-task implementer + spec-compliance review + code-quality review per the parallel session's `HANDOFF-2026-05-19.md` workflow.
7. ⏳ **Post-batch holistic code review** — `superpowers:requesting-code-review` after all commits land but before push.
8. ⏳ **Push to origin/main**.

## References

- `docs/superpowers/HANDOFF-2026-05-19.md` — handoff doc that surfaced this work as candidate #1
- `src/ipc/handler.ts:21` — `SKIP_GATE_ALLOWLIST` definition
- `src/ipc/handlers/skills.ts` — current `saveSkillHandler` and `crystallizeSkillHandler`
- `src/trust-enforcement.ts:38` — `checkTrust` + `checkTrustAndStage` logic
- `src/session-commands.ts:21` and `:166` — `parseApprovalCommand` + `handleApprovalCommand` (live but unwired)
- `data/agents/claire/trust.yaml` — reference for `save_skill: draft` placement
- MEMORY: `project_batch2g_skills_cluster_complete.md`, `feedback_silent_failure_wedge_anti_pattern.md`, `feedback_adversarial_reviewer_prompt.md`, `feedback_red_isolation_verify.md`, `feedback_ipc_log_requestid_shrink.md`
