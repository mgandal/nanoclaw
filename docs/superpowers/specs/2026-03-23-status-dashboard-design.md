# NanoClaw Status Dashboard — Design Spec

**Date:** 2026-03-23
**Status:** Approved

## Problem

NanoClaw runs 6 scheduled tasks across 2 groups, manages 5 Telegram groups with isolated skills, and maintains shared state files. There is no consolidated view of system health, task outcomes, or escalations. The user must manually check logs, the DB, and state files to understand what's happening.

## Solution

Three components delivered as Telegram messages to CLAIRE:

1. **Daily compact summary** — quick health check every weekday morning
2. **Weekly deep dive** — full status report on Mondays
3. **Real-time failure alerts** — immediate notification when tasks break or go stale

## Component 1: Daily Compact Summary

**Schedule:** Weekdays 7:15am ET (`15 11 * * 1-5` UTC) — runs after the priorities update task (7am ET) so `current.md` is fresh.

**Group:** `telegram_claire`, `context_mode: group`

**Data sources:**
- `scheduled_tasks` table — task list, schedules, last_run, last_result, status
- `task_run_logs` table — pass/fail counts for last 24 hours
- `registered_groups` table — group registry
- `sessions` table — active session count
- `/workspace/global/state/current.md` — top priorities and escalations

**Message format (~15-20 lines):**

```
Status Dashboard — Mon Mar 23

*Agent Groups*
CLAIRE | LAB-claw | CODE-claw | HOME-claw | SCIENCE-claw
Active sessions: 2

*Tasks (last 24h)*
6 scheduled | 5 ran | 5 passed | 0 failed
Next: Morning Briefing (tomorrow 6:00am)

*Top 3 Priorities*
1. Miao Tang hire — URGENT, initiate Workday process
2. Nature Genetics review — critically overdue
3. Emma ABCD manuscript — review discussion sections

*Escalations*
! Raquel Gur COAP — unanswered 9+ weeks
! Emma LoR letterhead — 3 days overdue
```

**How it reads data:**
The task runs inside a CLAIRE container with `context_mode: group`. It reads `current.md` from `/workspace/global/state/current.md`. For DB data (task counts, run logs, sessions), it uses IPC task requests:
- Write a JSON task file to `/workspace/ipc/tasks/` with `type: "dashboard_query"`
- The host-side IPC handler queries SQLite and writes results to `/workspace/ipc/dashboard_results/`
- The agent polls for results

**New IPC handler required:** `dashboard_query` — accepts a query type (`task_summary`, `group_summary`, `run_logs_24h`) and returns JSON results. This keeps all DB access on the host side (containers have no direct SQLite access).

## Component 2: Weekly Deep Dive

**Schedule:** Mondays 9:30am ET (`30 13 * * 1` UTC) — after the Monday batch (bookmarks, ARIA watch, skills check all run at 9am).

**Group:** `telegram_claire`, `context_mode: group`

**Data sources:** Everything from the daily summary, plus:
- `data/sessions/{group}/.claude/skills/` — skill counts per group (via IPC `dashboard_query` type `skill_inventory`)
- `groups/global/state/` directory — file modification times (via IPC)
- Task run history for the past 7 days (success rate per task)
- `bookmarks.md` — current watchlist items and their routing

**Message format (~40-60 lines):**

```
Weekly Status Report — Week of Mar 23

*Agent Groups*
• CLAIRE — 186 skills, 5 tasks, active
• LAB-claw — 33 skills, 1 task, active
• CODE-claw — 18 skills, 0 tasks, active
• HOME-claw — 4 skills, 0 tasks, idle
• SCIENCE-claw — 177 skills, 1 task, active

*Scheduled Tasks*
| Task | Group | Schedule | Last Run | Success (7d) |
Morning Briefing | CLAIRE | Weekdays 6am | Mar 23 | 5/5
Priorities Update | CLAIRE | Weekdays 7am | Mar 23 | 4/5
Session Journal | CLAIRE | 5x/day weekdays | Mar 23 | 23/25
Bookmarks Watch | CLAIRE | Mon 9am | Mar 23 | 1/1
Skills Check | SCIENCE | Mon 9am | Mar 23 | 1/1
ARIA RFA Watch | LAB | Mon 9am | Mar 23 | 1/1

*Bookmarks Watchlist*
• Composio → CODE-claw
• Eden → CLAIRE
• ClawBio → SCIENCE-claw
• Claude Scientific Skills → SCIENCE-claw
• AutoFigure-Edit → SCIENCE-claw

*State Files*
current.md — updated today
grants.md — 11 days stale
lab-roster.md — 11 days stale
projects.md — 11 days stale

*Priorities & Escalations*
[same as daily]

*Skill Changes This Week*
+ polars-bio (SCIENCE-claw, CLAIRE)
```

**Skill change tracking:** The weekly task compares the current skill list against a snapshot stored in `/workspace/group/dashboard-state.json`. After each run, it saves the current inventory as the new snapshot.

## Component 3: Real-time Failure Alerts

**Not a scheduled task.** This is a lightweight check added to the existing task scheduler loop in `src/task-scheduler.ts`.

**Trigger conditions:**
1. **Consecutive failures:** A task's `last_result` starts with `error` or `Error` for 2+ consecutive runs (checked via `task_run_logs`)
2. **Stale task:** A task's `next_run` is more than 2x its interval in the past (e.g., an hourly task hasn't run in 2+ hours)

**Behavior:**
- After each task completes, the scheduler checks whether to fire an alert
- Uses the existing `router.sendMessage()` (host-side, no container needed) to send to the CLAIRE chat JID
- Includes: task name, group, error message (truncated to 200 chars), last successful run time
- Deduplication: track alerted task IDs in memory; don't re-alert for the same task until it either succeeds or a new failure occurs

**Message format:**

```
! Task Alert

*Morning Briefing* (CLAIRE) failed 2x in a row.
Last error: Container timeout after 300s
Last success: Mar 22, 6:02am

Check logs: tail -50 logs/nanoclaw.log | grep briefing
```

## New Code Required

### 1. IPC Handler: `dashboard_query` (`src/ipc.ts` or new `src/dashboard-ipc.ts`)

Handles requests from container agents to query host-side data:

```typescript
type DashboardQueryType =
  | 'task_summary'      // all scheduled tasks with metadata
  | 'run_logs_24h'      // task_run_logs from last 24h
  | 'run_logs_7d'       // task_run_logs from last 7 days
  | 'group_summary'     // registered groups with session info
  | 'skill_inventory'   // skill counts per group (reads filesystem)
  | 'state_freshness';  // mtime of files in groups/global/state/
```

Response written as JSON to `/workspace/ipc/dashboard_results/{requestId}.json`.

### 2. DB Query Functions (`src/db.ts`)

```typescript
getTaskRunLogs(since: string): TaskRunLog[]
getTaskSuccessRate(taskId: string, days: number): { total: number; passed: number }
getStaleTaskIds(thresholdMultiplier: number): string[]
```

### 3. Alert Check (`src/task-scheduler.ts`)

After each task run completes:
```typescript
function checkAlerts(task: ScheduledTask, result: string, deps: SchedulerDependencies): void
```

- Query last N runs from `task_run_logs`
- If 2+ consecutive failures, send alert via `deps.router.sendMessage()`
- Track alerted IDs in a `Set<string>` (reset on success)

### 4. Scheduled Tasks (DB inserts)

Two new rows in `scheduled_tasks`:
- `dashboard-daily` — cron `15 11 * * 1-5`, group `telegram_claire`
- `dashboard-weekly` — cron `30 13 * * 1`, group `telegram_claire`

## File Changes

| File | Change |
|------|--------|
| `src/dashboard-ipc.ts` | New — IPC handler for dashboard queries |
| `src/db.ts` | Add `getTaskRunLogs()`, `getTaskSuccessRate()`, `getStaleTaskIds()` |
| `src/task-scheduler.ts` | Add `checkAlerts()` after task completion |
| `src/ipc.ts` | Register dashboard IPC handler |

## Out of Scope

- No web UI, charts, or browser-based dashboard
- No new services or dependencies
- No historical trend tracking beyond 7-day run logs
- No cross-group aggregation of agent conversation metrics
- Dashboard does not modify any state — read-only

## Testing

- Unit tests for DB query functions (`getTaskRunLogs`, `getTaskSuccessRate`, `getStaleTaskIds`)
- Unit test for `checkAlerts` logic (consecutive failure detection, deduplication)
- Manual test: trigger daily/weekly tasks via `next_run` update, verify message format
