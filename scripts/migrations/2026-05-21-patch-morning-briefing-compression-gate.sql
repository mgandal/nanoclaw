-- Stage 1 of digest noise reduction (spec: docs/superpowers/specs/2026-05-21-digest-noise-reduction-design.md)
--
-- Soften the morning-briefing compression-to-3-4-lines AND-gate so it can actually fire on
-- a low-overdue day. Pre-Stage-1 the clause `nothing overdue` was perpetually false (17
-- migration-cohort tasks frozen on 2026-04-24), so the full 9-section envelope rendered
-- daily even on quiet calendars.
--
-- Applied: 2026-05-21 14:22 ET (live, then backfilled as a migration per code-review C1).
-- Rollback: scripts/migrations/2026-05-21-rollback-morning-briefing-compression-gate.sql
--
-- Idempotency: REPLACE on already-replaced text matches nothing and is a no-op. Safe to
-- run against the post-Stage-1 DB without effect.
--
-- Scope: 1 row — id='claire-morning-briefing'.

BEGIN IMMEDIATE;

UPDATE scheduled_tasks
SET prompt = REPLACE(
  prompt,
  'On quiet days (≤3 events, no conflicts, nothing urgent, nothing overdue, no open follow-ups, Slack quiet)',
  'On quiet days (≤3 events, no conflicts, nothing urgent, ≤2 items in the OVERDUE bucket (per task_list), no NEW follow-ups in last 24h, Slack quiet)'
)
WHERE id='claire-morning-briefing';

-- Verify: post-state must contain the new clause exactly once
SELECT
  CASE
    WHEN instr(prompt, 'no NEW follow-ups in last 24h') > 0
     AND instr(prompt, 'nothing overdue, no open follow-ups') = 0
    THEN 'OK: Stage 1 compression-gate edit applied'
    ELSE 'WARNING: prompt state unexpected — verify manually'
  END AS verify_result
FROM scheduled_tasks
WHERE id='claire-morning-briefing';

COMMIT;
