-- Rollback for Stage 1 of digest noise reduction.
-- Inverse of: scripts/migrations/2026-05-21-patch-morning-briefing-compression-gate.sql
-- Use case: T+1 measurement shows no briefing-length reduction → revert + re-investigate
-- (per Stage 1.5 in docs/superpowers/specs/2026-05-21-digest-noise-reduction-design.md).
--
-- Per code-review I3: includes verify-SELECT confirming post-rollback state matches the
-- pre-Stage-1 string. If REPLACE no-ops (because the new clause was paraphrased by
-- some other process), the verify_result will signal so.

BEGIN IMMEDIATE;

UPDATE scheduled_tasks
SET prompt = REPLACE(
  prompt,
  'On quiet days (≤3 events, no conflicts, nothing urgent, ≤2 items in the OVERDUE bucket (per task_list), no NEW follow-ups in last 24h, Slack quiet)',
  'On quiet days (≤3 events, no conflicts, nothing urgent, nothing overdue, no open follow-ups, Slack quiet)'
)
WHERE id='claire-morning-briefing';

-- Verify: post-rollback state must contain the original clause and not the new one.
SELECT
  CASE
    WHEN instr(prompt, 'nothing overdue, no open follow-ups') > 0
     AND instr(prompt, 'no NEW follow-ups in last 24h') = 0
    THEN 'OK: Stage 1 rollback applied — pre-Stage-1 prompt restored'
    WHEN instr(prompt, 'no NEW follow-ups in last 24h') > 0
    THEN 'FAIL: rollback did not match — new clause still present (paraphrased?)'
    ELSE 'WARNING: prompt state ambiguous — verify manually before continuing'
  END AS verify_result
FROM scheduled_tasks
WHERE id='claire-morning-briefing';

COMMIT;
