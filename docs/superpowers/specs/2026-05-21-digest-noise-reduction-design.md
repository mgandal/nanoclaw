---
title: Digest noise reduction — minimal prompt edits + per-group self-diff
date: 2026-05-21
status: ready
authors: [mgandal, claude]
supersedes: 2026-05-21-digest-staleness-and-verbosity-design-V1-superseded.md
reviewers: [R1 adversarial, R2 codebase audit, R3 alternatives]
---

# Digest noise reduction — minimal prompt edits + per-group self-diff

## Problem

User-stated symptoms (ranked):
1. Cross-channel info sharing failures (same fact, different freshness across channels)
2. Per-channel 8h context digests feel stale/redundant
3. OPS-claw infra/health checks noisy
4. CLAIRE morning briefing slightly verbose

Two underlying failure modes confirmed by user: **same fact, different freshness** + **already-handled items resurface**.

## V1 history

V1 spec (`2026-05-21-digest-staleness-and-verbosity-design-V1-superseded.md`) proposed a `tasks-stale-review` cron + `digest-envelope` skill + 3 slash commands + 9 prompt rewrites. Three independent reviewers (R1, R2, R3) found:

- **C1 (R1+R2):** Fingerprint storage path `data/digest-fingerprints/` is unwritable in main and doesn't exist in 7/8 target groups. `/workspace/project` is read-only for main; non-main containers don't mount it at all.
- **C2 (R1):** Fingerprint mechanism requires stable item IDs; two highest-noise targets (`hermes-ai-brief`, `hermes-slack-scanner`) are LLM-curated digests with no IDs.
- **I1 (R3):** Spec dropped user's #1 ranked complaint (cross-channel disagreement) as out-of-scope.
- **I9/I10 (R3):** Simpler alternative exists — one-line `REPLACE` on the morning briefing's AND-gate gets ~80% of the gain. Two existing prompts (`task-1774637802835-tp6ugc` VAULT briefing, `hermes-blogwatcher`) already implement the diff-and-skip pattern V1 proposed to invent.

Verdict: replace V1 with a staged, evidence-driven approach that **copies existing patterns and edits prompts** rather than building new subsystems.

## Design philosophy

- **Pattern replication over abstraction.** Two prompts already do "no diff → silent." Copy them.
- **Per-group state only.** `/workspace/group/{folder}/` is writable by its container. No cross-group state. This is a constraint AND a feature: each digest owns its own diff state, no coupling.
- **Each stage independently shippable + reversible.** Single-statement SQL or per-prompt edit at every step. No "all or nothing."
- **Falsify before generalizing.** Stage 1 tests the compression-gate hypothesis with one edit. Stages 2+ only ship if Stage 1 confirms; if it doesn't, root cause is elsewhere and we re-investigate.

## Stage 0: Hand-clean stale tasks (DONE 2026-05-21 14:11 ET)

Archived 10 explicitly-stale tasks (3,4,6,10,18,19,20,21,22,23) + closed 4 user-triaged (5,9,14,15) + refreshed timestamps on 3 active (2,7,17). Open task count: 27 → 13. Open >14d: 19 → 2.

This is the falsification primer for Stage 1.

## Stage 1: Fix the compression-gate (1 SQL statement)

### Root cause

Morning briefing prompt has a compression branch:

> On quiet days (≤3 events, no conflicts, nothing urgent, nothing overdue, no open follow-ups, Slack quiet) compress to 3–4 lines

`nothing overdue` was perpetually false because 17 migration-cohort tasks were frozen on 2026-04-24 and never reviewed. Compression branch never triggered → 9-section envelope always rendered.

### Fix

```sql
UPDATE scheduled_tasks
SET prompt = REPLACE(
  prompt,
  'On quiet days (≤3 events, no conflicts, nothing urgent, nothing overdue, no open follow-ups, Slack quiet)',
  'On quiet days (≤3 events, no conflicts, nothing urgent, ≤2 overdue items, no NEW follow-ups in last 24h, Slack quiet)'
)
WHERE id='claire-morning-briefing';
```

### Rationale for new thresholds

- `≤2 overdue items` — even with Stage 0 cleanup, a few real items will sit overdue. Two is a "not a crisis" threshold.
- `no NEW follow-ups in last 24h` — follow-ups don't auto-expire; "no open" was wrong. The 24h-new filter aligns with the briefing's actual daily cadence.
- All other conjuncts unchanged.

### Rollback

```sql
UPDATE scheduled_tasks
SET prompt = REPLACE(
  prompt,
  'On quiet days (≤3 events, no conflicts, nothing urgent, ≤2 overdue items, no NEW follow-ups in last 24h, Slack quiet)',
  'On quiet days (≤3 events, no conflicts, nothing urgent, nothing overdue, no open follow-ups, Slack quiet)'
)
WHERE id='claire-morning-briefing';
```

### Acceptance

- **Baseline:** capture tomorrow morning's pre-deploy briefing length BEFORE running the SQL (manual: read from Telegram, count lines).
- **T+1 day:** if briefing length drops ≥30%, Stage 1 succeeds. If not, re-investigate (compression-gate isn't the load-bearer; check Stage 1.5).
- **T+7 days:** baseline ratio holds (no regression).

### Stage 1.5: If Stage 1 doesn't reduce length

If T+1 shows no shrinkage, hypothesis was wrong. Re-investigate before any further fixes. Likely re-investigation paths:
- The "quiet day" branch isn't where the verbosity lives — re-read prompt + Telegram output side-by-side.
- LLM ignores the compression instruction. Inspect 2-3 recent briefings for which sections are non-empty.
- Other prompts dominate noise (`hermes-ai-brief`, `audit-mcp-weekly`, etc.) — proceed to Stage 2 anyway since they're independently justified.

## Stage 2: Self-diff pattern for 2 noisiest non-task prompts

### Existing pattern (DO NOT REINVENT)

`hermes-blogwatcher` already implements:
> "Check for new items in the RSS feeds tracked in `/workspace/group/blogwatcher-state.json`."

`task-1774637802835-tp6ugc` (VAULT briefing) writes a per-fire timestamp and skips silently on no-change.

### Targets

The two LLM-curated digests R1 flagged as fingerprint-incompatible:
- `hermes-ai-brief` (group: `telegram_code-claw`) — daily 5:00am ET CODE-claw AI builders digest
- `hermes-slack-scanner` (group: `telegram_ops-claw`) — daily 6:00am ET LAB Slack scan

These can't use ID-based fingerprinting because the LLM picks 3-5 items from a larger candidate set. But they CAN do **prose-similarity self-diff** because the LLM that wrote yesterday's digest can compare its prose to today's.

### Prompt edit pattern (append to both prompts)

```
SELF-DIFF GATE (before sending):
1. Read /workspace/group/last-fire-{TASK_ID}.json if it exists.
   Schema: { "computed_at": ISO8601, "headline": str, "items": [str, ...] }
2. Compose today's output.
3. Compare today's items vs yesterday's items:
   - If ≥3 of today's items are substantially the same topic as yesterday's
     items (paraphrase OK, same underlying story), AND no new high-priority
     signal appeared, send only: "🟢 No notable new {digest_type} since yesterday."
   - Otherwise send full digest.
4. Write today's items to /workspace/group/last-fire-{TASK_ID}.json (overwrite).

REMOVE THE COUNT FLOOR: "3-5 items" → "up to 5 items; fewer is fine; if nothing
new, follow the SELF-DIFF GATE above."
```

### Why this works where V1's fingerprint didn't

- **Storage path:** `/workspace/group/` is writable from the container that fires the task. No mount changes needed (R2-H3 resolved).
- **Item identity:** the LLM does semantic comparison, not hash-overlap. Works for synthesized content (R1-H1 resolved).
- **No cross-group coordination needed:** each task owns its own state file. Aligned with NanoClaw's group-isolation model.

### Acceptance

- After 2-3 fires per task, at least one fire emits the `🟢 No notable new` line (or genuinely sends full content because there was new content).
- No regressions: full-content fires still surface the items they would have surfaced pre-edit.

### Rollback

Per-prompt SQL revert (stored alongside the apply migration). Delete state files: `rm /Users/mgandal/Agents/nanoclaw/groups/{folder}/last-fire-{taskId}.json`.

## Stage 3 (conditional — only if user still complains after Stages 1+2)

**Pull-not-push reframe** (R3-H5). Convert lowest-value crons to slash commands:

- Pause crons via `UPDATE scheduled_tasks SET status='paused' WHERE id IN (...)`.
- Add slash-command parsers in `src/session-commands.ts` that wake the same prompts on demand.
- Touch the existing dispatch loop in `src/index.ts:processGroupMessages()` (R2-H2: `src/commands/` is NOT the convention; `src/session-commands.ts` is).

Candidates for slash conversion:
- `task-1776340759047-d7coxl` r/LocalLLaMA → `/llama`
- `hermes-blogwatcher` → `/blog`
- `audit-mcp-weekly` → `/audit-mcp`
- `task-1773612236244-4np9bh` bookmarks watchlist → `/bookmarks`

Do NOT convert: `claire-morning-briefing`, `task_health_monitor`, `launchd-health-monitor`, `vault-inbox-ingest`, sync/health scheduled jobs.

This stage is deferred until Stages 1+2 are evaluated. Pull-not-push has its own UX cost (user must remember commands), so don't ship it speculatively.

## Out of scope (explicitly)

- `tasks-stale-review` aging cron — V1 included this; deferred because Stage 0 hand-clean + the natural attrition from refreshed timestamps gets us to ≤2 stale items. Re-evaluate at T+14 if stale count rebounds.
- `agent_actions` audit table observability — separate bug (Batch 4 dispatcher work `342d8769` was supposed to address but R1-B4 notes it may still be 0-rows; verify separately).
- Cross-substrate aging (Honcho, Hindsight, memory.md write-back) — R1-H4 flagged this as real but evidence-thin. Out of scope for this design pass; revisit after Stage 1+2 measurements.
- 8h `<internal>` context-capture tasks contribute to staleness via `memory.md` write-back (R1-H5). Same out-of-scope rationale.
- The 4 SimpleMem-using prompts R1 flagged as silently failing — separate cleanup task.

## Components touched

| Stage | Path | Change |
|---|---|---|
| 0 | `store/messages.db:tasks` | Hand cleanup DONE |
| 1 | `store/messages.db:scheduled_tasks` row `claire-morning-briefing` | 1 prompt edit |
| 2 | `store/messages.db:scheduled_tasks` rows `hermes-ai-brief`, `hermes-slack-scanner` | 1 prompt edit each |
| 2 | `groups/telegram_code-claw/last-fire-hermes-ai-brief.json` | NEW, written by container |
| 2 | `groups/telegram_ops-claw/last-fire-hermes-slack-scanner.json` | NEW, written by container |
| 3 (deferred) | `src/session-commands.ts` | New extractors |
| 3 (deferred) | `src/index.ts` | New dispatch arms |

Total new code in Stages 1+2: **zero TypeScript LOC**. Three prompt edits.

## Phased rollout

### Phase 1.1 (tonight)
1. Capture baseline briefing length (manual screenshot of tomorrow's pre-deploy fire).
2. Run Stage 1 SQL.
3. Observe T+1 briefing.

### Phase 1.2 (T+1, IF Stage 1 shows shrinkage)
- Mark Stage 1 successful. Proceed to Stage 2.

### Phase 1.2-alt (T+1, IF Stage 1 shows NO shrinkage)
- Revert Stage 1. Re-investigate per the Stage 1.5 paths.

### Phase 2 (T+2-3 days, after Stage 1 confirmed)
- Apply Stage 2 to `hermes-ai-brief` first. Observe 3 fires.
- If acceptance criteria met, apply Stage 2 to `hermes-slack-scanner`.

### Phase 3 (T+14 days, conditional)
- Measure: did briefing length stay reduced? Did `🟢 No notable new` line fire at least once per Stage 2 task?
- If user still reports noise: design Stage 3 (pull-not-push). Don't preemptively design.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Stage 1 SQL hits no rows (prompt text changed) | Pre-check: `SELECT prompt FROM scheduled_tasks WHERE id='claire-morning-briefing'` to confirm exact-match string before running |
| LLM ignores self-diff gate in Stage 2 | Prompt structure puts SELF-DIFF GATE before content composition; if it ignores, Stage 1 + Stage 0 still in effect |
| `last-fire-*.json` files corrupt | LLM can't read → falls through to "send full content"; no breakage, just no diff that fire |
| Per-group state files accumulate forever | Files are ~1KB each, 2 files total in Stage 2. Acceptable. Add purge to weekly cleanup if Stage 3 expands. |
| Hidden cross-channel coupling I haven't mapped | Stages 1+2 don't introduce cross-channel state. Stage 3 (pull-not-push) reduces coupling, doesn't add it. |

## Decision rules

**Stage 1 → Stage 2 gate:**
- IF T+1 briefing length drops ≥30% AND ≥1 of next 3 briefings hits the quiet-day branch → ship Stage 2.
- IF T+1 shows no change → revert Stage 1 and re-investigate.
- IF T+1 shows mixed/marginal change → hold for 3 more days before deciding.

**Stage 2 → Stage 3 gate:**
- IF after Stages 1+2 user reports "still too noisy" with specific examples → design Stage 3.
- IF noise complaints stop → declare done, don't ship Stage 3.

## Success criteria (overall design)

- Briefing length 7-day average drops ≥40% vs prior 7-day baseline.
- At least one `hermes-ai-brief` or `hermes-slack-scanner` fire emits the `🟢 No notable new` line within 7 days of Stage 2.
- Zero false-positive auto-closes (Stage 0 was hand-curated; no automation introduced).
- User subjective: "feels less noisy" with no "I missed an important thing" complaints.

## What V2 explicitly does NOT promise

- Cross-channel info-sharing fix. The user's #1 complaint is acknowledged as deferred. Stage 3 (pull-not-push) is the eventual fix if needed; deferred until Stages 1+2 are measured.
- Tasks-table aging automation. Hand-cleanup + the natural attrition from refreshed timestamps is the working hypothesis.
- Honcho/Hindsight staleness. Separate substrates, separate fix later.
