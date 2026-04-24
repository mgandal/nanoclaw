-- Phase B follow-up — patch claire-morning-briefing to cite task_list as authoritative.
-- Added 2026-04-24 after peer review flagged this task as the highest-visibility
-- daily digest still reading Todoist (the exact source Option D was designed to replace).
--
-- The edit replaces the Todoist call entirely (per the original plan — Todoist is
-- unreliable) and keeps everything else intact. followups.md is still read for
-- email obligations (email-ingest.py owns that surface).
--
-- Rollback: restore from docs/snapshots/scheduled-tasks-pre-task-table-2026-04-24.json
-- via scripts/migrations/rollback-digest-prompts-2026-04-24.sql.

BEGIN IMMEDIATE;

UPDATE scheduled_tasks
SET prompt = replace(
  prompt,
  '- Todoist: call mcp__todoist__find-tasks-by-date with startDate "today" and include-overdue=true. Split into: DUE TODAY vs OVERDUE.',
  '- Tasks (authoritative): call mcp__nanoclaw__task_list with status="open" and owner="mike". Split into: DUE TODAY (due_date == today or NULL with priority 4) vs OVERDUE (due_date < today). The task table is the single source of truth — do NOT read /workspace/project/groups/global/state/todo.md or lab-todos.md (archived 2026-04-24).'
)
WHERE id = 'claire-morning-briefing';

COMMIT;

-- Verify:
--   SELECT substr(prompt, 1, 200) FROM scheduled_tasks WHERE id = 'claire-morning-briefing';
--   -- should contain "mcp__nanoclaw__task_list" and NOT "mcp__todoist__find-tasks-by-date"
