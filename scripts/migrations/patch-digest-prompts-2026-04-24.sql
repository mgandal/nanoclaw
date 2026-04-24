-- Phase B step 6 — patch scheduled_tasks.prompt to cite task_list as authoritative.
--
-- Applied once. Rollback: restore from docs/snapshots/scheduled-tasks-pre-task-table-2026-04-24.json.
--
-- Scope (4 tasks, verified 2026-04-24 after step-2b audit):
--   task-1774027787743-upd8cur  (update-current.md, daily 7am M-F) — rewritten as renderer
--   followup-weekly-1774574992  (mid-week followup, Wed 8am) — prepend STEP 0
--   hermes-week-ahead           (week-ahead, Sat 10am) — prepend STEP 0
--   task-1775850929249-olcmx8   (weekly deep-dive, Mon 9:30am) — prepend STEP 0
--
-- Out of scope (skipped with reasoning):
--   task-1775919254910-bn99tx   — one-shot 2026-04-11, already completed
--   task-1775850917587-rodu8w   — disabled
--   task-1776026695758-w0960t   — current.md is a filename input for divergence check, not a task source
--   migrate-todos-2026-04-23    — inactive (migration completed Phase A)

BEGIN IMMEDIATE;

-- 1. update-current.md — full rewrite (current.md becomes rendered view)
UPDATE scheduled_tasks
SET prompt = 'You are Claire, Mike Gandal''s Chief of Staff. Render the shared priorities file at /workspace/global/state/current.md AS A VIEW of the task table. This file is no longer a source of truth — it is a snapshot of what mcp__nanoclaw__task_list returns right now, rendered for human reading.

STEP 1 — Read the authoritative list:
Call mcp__nanoclaw__task_list with status="open" and limit=100.

STEP 2 — Enrich with calendar + email context (optional):
- calendar_range for next 14 days to list deadlines not already captured as tasks.
- Gmail starred / unread count, just for situational awareness — do NOT convert emails into tasks here; email-ingest.py owns followups.md.

STEP 3 — Write /workspace/global/state/current.md with this shape:

    # Current Priorities — rendered from task table @ <ISO date>
    (source: nanoclaw tasks table; edit via /task commands, not this file)

    ## Top 3 (priority 4 + overdue)
    - [id:<n>] <title> — OWNER: <owner> — NEXT: <first sentence of context or "see task">

    ## Due in next 14 days
    - [id:<n>] <title> — due <date>

    ## Escalations
    - overdue tasks
    - stalled tasks where updated_at older than 14 days

    ## Upcoming deadlines from calendar
    - <date>: <event>

Keep it concise. Absolute dates only. Do NOT invent, rewrite, or reprioritize — just render what the table says. Do NOT send a message to any group; this is a background housekeeping task.'
WHERE id = 'task-1774027787743-upd8cur';

-- 2. followup-weekly-1774574992 — prepend STEP 0
UPDATE scheduled_tasks
SET prompt = 'STEP 0 — Read the live task list (authoritative).
Call mcp__nanoclaw__task_list with status="open". This is the canonical task list. Use it to cross-reference the email/slack/current.md findings below. Do NOT treat /workspace/global/state/todo.md or /workspace/global/state/lab-todos.md as sources (those are archived). When you find a resolved item that is still open in the table, call mcp__nanoclaw__task_close with outcome="done".

' || prompt
WHERE id = 'followup-weekly-1774574992';

-- 3. hermes-week-ahead — prepend STEP 0
UPDATE scheduled_tasks
SET prompt = 'STEP 0 — Read the live task list (authoritative).
Call mcp__nanoclaw__task_list with status="open". Use this as the source of truth for priorities. Calendar/email data below supplements the list but does not replace it. Reading /workspace/project/groups/global/state/current.md is fine for human-facing context (it is rendered from task_list at 7am) but the table itself is canonical.

' || prompt
WHERE id = 'hermes-week-ahead';

-- 4. weekly deep-dive — prepend STEP 0
UPDATE scheduled_tasks
SET prompt = 'STEP 0 — Read the live task list (authoritative).
Call mcp__nanoclaw__task_list with status="open". This is the canonical task list. The current.md / grants.md / papers.md reads below supplement this for narrative context; they are not the source.

' || prompt
WHERE id = 'task-1775850929249-olcmx8';

COMMIT;

-- Verification (run manually after commit):
--   SELECT id, substr(prompt, 1, 120) FROM scheduled_tasks
--   WHERE id IN ('task-1774027787743-upd8cur','followup-weekly-1774574992',
--                'hermes-week-ahead','task-1775850929249-olcmx8');
