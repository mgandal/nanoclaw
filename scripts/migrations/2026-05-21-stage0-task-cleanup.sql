-- Stage 0 of digest noise reduction (spec: docs/superpowers/specs/2026-05-21-digest-noise-reduction-design.md)
--
-- Hand cleanup of stale tasks in the tasks table to test the hypothesis that the
-- morning-briefing compression branch is being defeated by an always-non-empty
-- OVERDUE bucket. 17 of 27 open tasks were frozen on 2026-04-24 (Phase B migration
-- date) and never reviewed since. This migration documents the 14 closures + 3
-- timestamp refreshes that ran live, AFTER they were already applied.
--
-- Applied: 2026-05-21 14:11:01 ET (live, then backfilled as a migration per code-review C2).
-- Post-state snapshot: docs/snapshots/tasks-pre-stage0-2026-05-21-postchange.json
--   (NOTE: snapshot captures post-state because pre-state was not preserved at run time.
--    The context column carries the `[auto-archived ...]` / `[closed ...]` audit string
--    showing what each touched row was.)
--
-- Idempotency: each UPDATE has a `status='open'` guard, so re-running is a no-op
-- against rows already archived/closed.
--
-- Scope (17 rows total):
--   Archived (10) — explicit stale signal in context or covered in current.md:
--     ID 3   Joe Buxbaum (Already in current.md "High Priority")
--     ID 4   Lucinda 10X PO bundle ([stale: from Feb])
--     ID 6   Sylvanus K99/R00 (Already in current.md Needs Reply)
--     ID 10  Yanli Wang ([stale] no date)
--     ID 18  Salmon TPM vs long-read ([stale: from Feb 4 meeting])
--     ID 19  Shridhar WGCNA height ([stale: from Feb 4 meeting])
--     ID 20  Border et al. Science 2023 (Zaitlen Seminar read-pile, no deadline)
--     ID 21  Chun Chieh Fan spousal correlations (Zaitlen, no deadline)
--     ID 22  Peyrot JAMA Psychiatry (Zaitlen, no deadline)
--     ID 23  Gorla PACA bioRxiv (Zaitlen, no deadline)
--   Closed-done (4) — user-confirmed handled:
--     ID 5   Liqing ASPE ciliopathy
--     ID 9   Briana Macedo thesis committee
--     ID 14  Jade England Clinical Note
--     ID 15  Brian Li folate
--   Refreshed timestamps (3) — confirmed active by user:
--     ID 2   Ziller RIS scope (on hold, still pending)
--     ID 7   Rachel Smith HotNet/BrainGO (active project)
--     ID 17  ASD genes ∩ MAGICC modules (ASD-ASC project)
--
-- Rollback rationale: not provided. Closures are user-confirmed; if a closure was
-- a mistake, the task can be reopened individually via `task_reopen` (IPC) or
-- `UPDATE tasks SET status='open', completed_at=NULL WHERE id=<id>`.

BEGIN IMMEDIATE;

-- 1. Bulk archive (10 explicitly-stale items)
UPDATE tasks
SET status='archived',
    completed_at=datetime('now'),
    updated_at=datetime('now'),
    context = COALESCE(context, '') || ' [auto-archived 2026-05-21: marked stale or covered elsewhere]'
WHERE id IN (3, 4, 6, 10, 18, 19, 20, 21, 22, 23) AND status='open';

-- 2. User-confirmed closes (4 items, marked done)
UPDATE tasks
SET status='done',
    completed_at=datetime('now'),
    updated_at=datetime('now'),
    context = COALESCE(context, '') || ' [closed 2026-05-21: handled per user]'
WHERE id IN (5, 9, 14, 15) AND status='open';

-- 3. Active refreshes (2 items confirmed active)
UPDATE tasks
SET updated_at=datetime('now'),
    context = COALESCE(context, '') || ' [confirmed active 2026-05-21]'
WHERE id IN (7, 17) AND status='open';

-- 4. Hold refresh (1 item)
UPDATE tasks
SET updated_at=datetime('now'),
    context = COALESCE(context, '') || ' [on hold 2026-05-21 — still pending]'
WHERE id=2 AND status='open';

-- Verify: 14 closures (10 archived + 4 done) + 3 refreshed should land
SELECT
  CASE
    WHEN (SELECT COUNT(*) FROM tasks WHERE id IN (3,4,6,10,18,19,20,21,22,23) AND status='archived') = 10
     AND (SELECT COUNT(*) FROM tasks WHERE id IN (5,9,14,15) AND status='done') = 4
     AND (SELECT COUNT(*) FROM tasks WHERE id IN (2,7,17) AND status='open') = 3
    THEN 'OK: Stage 0 cleanup applied — 10 archived + 4 done + 3 refreshed-open'
    ELSE 'WARNING: Stage 0 state unexpected — verify manually'
  END AS verify_result;

COMMIT;
