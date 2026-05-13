---
name: daily-task-prep
description: "Prepare Mike Gandal's task list for the day using Todoist plus his calendars. Use when a cron or direct request asks to prepare today's tasks before the day starts; when recurring weekday tasks, due-today backlog items, and principal-owned meetings / calls should be surfaced; or when the task list needs a safe early-morning refresh without overwriting manual priorities."
---

# Daily Task Prep

Use Todoist (`mcp__todoist__*`) as the canonical live task system. Use `mcp__calendar__*` to pull today's meetings. Use `mcp__apple_notes__*` for any meeting notes that need task extraction.

## Core rules

- surface the priority map from `/workspace/group/skills/priority-map.md` before regrouping or inserting active tasks
- preserve existing manually added open tasks in Todoist Inbox / Today unless they are obviously stale past meetings
- on weekdays, treat the `Every weekday` Todoist section (or equivalent recurring tasks) as the recurring seed list
- on weekends, do not auto-add weekday-recurring items unless explicitly asked
- promote items due today from backlog into Today view focus
- scan recurring Todoist tasks that fire today and confirm they appear in the active task list
- add principal-owned meetings and calls for today to Todoist as time-blocked tasks (if not already present)
- exclude personal or family calendar blocks that are only conflict sources, not Mike-owned tasks
- keep assistant tasks clearly separate from Mike's tasks (use Todoist assignment / labeling as appropriate)
- archive or complete tasks that were finished yesterday if not already marked done
- keep tasks completed today in place until the next morning's prep run unless Mike explicitly wants earlier cleanup
- stay silent unless something needs human attention

## Preparation workflow

1. Read today's Todoist tasks via `mcp__todoist__find-tasks-by-date` with `startDate: "today"` and `overdueOption: "include-overdue"`
2. Read `/workspace/group/skills/priority-map.md`
3. Determine whether today is a weekday
4. Mark as complete (or note for Mike) any tasks that were clearly finished yesterday but not closed
5. Build the candidate today list from:
   - current open tasks already due today or overdue
   - recurring tasks that fire on weekdays (if today is Monday–Friday)
   - backlog tasks whose due date is today
   - today's principal-owned meetings / calls from calendar (via `mcp__calendar__calendar_today`)
6. Deduplicate by normalized task text; keep the most specific wording already present
7. Assign priority (`p1`–`p4`) to each active task using the priority map
8. Reorder tasks so highest-priority work is listed first within each category
9. Add any missing tasks to Todoist via `mcp__todoist__add-tasks`; update priority/due-date on existing tasks via `mcp__todoist__update-tasks` if stale
10. Write only the minimal necessary changes

## Calendar workflow

Use `mcp__calendar__calendar_today` to inspect Mike's calendars before adding meeting tasks.

Only add calendar items that Mike is actually expected to attend (not tentative blocks or family-only events).

Scheduling constraints to enforce:
- 9–11 am ET — protected focus time; flag if a meeting is booked here
- Monday mornings — clinic; no academic meetings before noon on Mondays
- 30-min lunch block between 11 am and 1 pm — confirm it exists or flag the gap

## Priority map reference

When ordering tasks, use this weighting:

1. Grant deadlines — Google.org AI for Science (*Apr 17 deadline*, treat as urgent now); NIH grant submissions
2. Collaborator commitments — Bogdan Pasaniuc, Raquel Gur (joint grants, papers)
3. Lab member blockers — anything blocking Liqing Jin, Yunlong Ma, Connor Jops, postdocs, or grad students from moving forward
4. Clinical / Penn / CHOP compliance items
5. Manuscript and paper revisions with near-term deadlines
6. Routine admin, email, and scheduling

## Meeting notes task extraction

If new meeting notes exist in Apple Notes or elsewhere:
- use `mcp__apple_notes__search_notes` to find recent meeting notes (past 2 days)
- extract any action items for Mike or lab members
- classify through the priority map
- add extracted tasks to Todoist before ending the run

## Task text rules

- use concise one-line task titles; put details in the description field
- use ISO due dates when setting due dates via `dueString` (e.g., "2026-04-17" or "today at 2pm")
- use `p1` for grant-deadline and compliance items; `p2` for collaborator/lab-blocker items; `p3` for routine; `p4` for someday/low-priority
- when a backlog item is promoted into today's focus, update its due date to today rather than duplicating it
- for recurring tasks, leave the recurring schedule intact; Todoist manages recurrence automatically

## Safety

- do not wipe or mass-delete today's task list to rebuild it from scratch
- do not delete recurring Todoist tasks (only their individual instances)
- do not complete tasks that were completed today during the same prep run
- if calendar access fails, still do the Todoist-based prep and only notify Mike if the failure affects his day materially
- if nothing needs to change, do nothing
