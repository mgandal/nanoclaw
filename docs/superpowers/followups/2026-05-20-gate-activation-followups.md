# Gate-Activation Follow-ups (2026-05-20)

After the 8-commit gate-activation batch (`6c918822..61a533e4`) landed on origin/main, the holistic post-batch code review surfaced 5 Important findings that ship as-is per user decision. This file tracks them.

## Source

Spec: `docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md`
Plan: `docs/superpowers/plans/2026-05-19-ipc-gate-activation-plan.md`
HEAD at push: `61a533e4 feat(ipc): Phase 4 — gate-activation policy flip for skill_* cluster`

## Items

### A. Gate is INERT for the production IPC path

**Finding:** containers write IPC tasks to `/workspace/ipc/tasks/` mounted from `data/ipc/{group.folder}/` — bare folder, NOT compound `{group.folder}--{agent}`. The watcher at `src/ipc.ts:791-815` reads `sourceGroup = 'telegram_claire'`. `buildContext('telegram_claire')` calls `parseCompoundKey('telegram_claire')` → `agentName: null`. `gateAndStage` at `src/ipc/trust-gate.ts:35` short-circuits with `NON_AGENT_DECISION (allowed=true, no staging)`. Agent's save_skill executes inline, no pending row, no approval needed.

**Evidence:** `agent_actions` table has 0 rows in production today (`SELECT COUNT(*) FROM agent_actions`). Tests 12 + 21 in `src/ipc/handlers/skills.test.ts` document this — but they were framed as "non-agent path" tests, not "production path". Spec drift.

**Impact:** Phase 4's policy flip lands the infrastructure (allowlist edit + skipGate strip) but doesn't change observable behavior for the primary code path. Spec's narrative "every save_skill call now stages" is false in practice.

**Resolution options:** (1) Wire compound IPC dirs — containers mount `{groupFolder}--{agentName}` instead of bare folder. (2) Change gate semantics — `gateAndStage` for actions on a "staging-required" allowlist could default-deny on `agentName=null` instead of short-circuiting allowed. Either needs its own brainstorm + spec.

**Severity:** Important. Not blocking (no regression vs. pre-batch behavior).

### B. Approval-side observability (audit) unimplemented

**Finding:** `handleApprovalCommand` at `src/session-commands.ts:200-289` writes ZERO `agent_actions` rows for any approve/reject/deny path. Spec lines 218-230 listed `outcome='approved'`, `'approved_then_failed'`, `'denied_cross_group'`, `'denied_already'`, `'rejected_stale'`. None implemented.

**Resolution:** Add `insertAgentAction` calls in `handleApprovalCommand` for each terminal path. ~30 LOC.

**Severity:** Important. Forensic gap; no functional bug.

### C. Stale-row check (`PENDING_STALE_DAYS`) unimplemented

**Finding:** No code reads the env var. Users can `/approve` arbitrarily old rows. Spec EC1 + D9 promised "Pending action pa_abc is stale (created Nday ago)..." reply path; that reply never fires.

**Resolution:** Add `Date.now() - new Date(row.created_at).getTime() > envDays * 86400000` check in `handleApprovalCommand` before the auth check. Reply with stale message + insert `agent_actions(outcome='rejected_stale')`.

**Severity:** Important. Tied to Item B.

### D. SKILL.md prose claims IPC reply contains `pendingId` but no mechanism

**Finding:** `container/skills/skill-creator/SKILL.md:82` and `container/skills/crystallize/SKILL.md:83` (Phase 4 amendments) say "Your IPC reply will include the `pendingId`." But the bash heredoc IPC pattern in those skills is fire-and-forget — no `waitForIpcResult` call, no result-file read. An agent following these instructions will tell the user "approved as pa-???" without knowing the actual ID.

**Compounding Item A:** in production today no stage-result file is written anyway (the gate is inert).

**Resolution:** Either (1) update the SKILL.md prose to instruct agents to read the result file after their write, or (2) wait until Item A is resolved (compound IPC dirs → gate fires → result file lands) before any prose update.

**Severity:** Important. Misleading agent-facing contract.

### E. crystallize SKILL.md still says "main channel only"

**Finding:** `container/skills/crystallize/SKILL.md:23` reads "Gate: **main channel only.** If the user is in a non-main group, tell them they need to run this from the main channel." This contradicts Phase 0b, which removed the `isMain` block specifically so non-main groups can stage. Agent will refuse legitimate non-main requests.

**Resolution:** Update the SKILL.md prose to remove the main-only gate and explain the trust.yaml policy instead. ~5 LOC edit.

**Severity:** Important. Active misleading-of-agent.

### F. Minor: Spec drift on test paths / numbering

- Migration test lives at `scripts/migrations/add-crystallize-trust.test.ts`, not `tests/migrations/` as spec said.
- T26.5/T27.5 in spec became T28/T29 (Phase 4) and T26.5/T27.5 (Phase 0a payloadForStaging pins) in code. Future readers confused.

**Resolution:** Update the spec to acknowledge.

**Severity:** Minor docs drift.

### G. Minor: Several spec-listed tests dropped

Spec listed T4 (replay-staged-action missing agent dir), T19 (stale pending), T22b (slash-command precedence). T4 = `replayStagedAction` doesn't check agent dir (underlying handler `mkdirSync`-recreates silently); T19 = tied to Item C (feature unbuilt); T22b = no test exists, mutation matrix M6 skipped.

**Severity:** Minor coverage gaps.

## Recommended Next Steps

1. Item E (~5 LOC SKILL.md edit) — cheap correctness fix; ship within hours.
2. Items B + C together — they share `handleApprovalCommand` surface; one follow-up batch (~50 LOC + tests).
3. Item D — wait for Item A resolution OR rewrite prose to drop the false `pendingId` claim.
4. Item A — meaningful new batch. Brainstorm: which option (compound IPC dirs vs. gate-semantics change)?
5. Item F (spec amendment) — bundle with Item A resolution.

## Memory Notes Worth Capturing

- **Gate-activation activates only on compound `sourceGroup` IPC paths.** In production today, container IPC mounts to bare `{groupFolder}` so `gateAndStage` returns `NON_AGENT_DECISION`. To make gating effective, either mount compound IPC paths or change the gate semantics for staging-policy actions.
- **`agent_actions(outcome='staged')` is written by `checkTrustAndStage`, NOT by the dispatcher.** The synthetic audit row + pending_actions insert happen in `src/trust-enforcement.ts:108`. Approve-path audit rows are missing (Item B above).
- **Forensic query for staged save_skill/crystallize_skill (once gate is effective):** `SELECT * FROM agent_actions WHERE outcome='staged' AND action_type IN ('save_skill','crystallize_skill')` joined to `pending_actions` on pending_id.

## Test Coverage Summary

- Test count: 2477 → 2491 (+14 net, with replacements).
- Mutation matrix: 5/6 verified load-bearing (M1, M2, M3, M4, M5). M6 documented-skip.
- Typecheck: clean. Lint: 0 errors.
