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

**Schedule:** Weekdays 7:15am ET (cron: `15 7 * * 1-5`, interpreted in local time via `TIMEZONE` config).

Runs after the priorities update task (7am ET) so `current.md` is fresh.

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
The task runs inside a CLAIRE container with `context_mode: group`. It reads `current.md` directly from `/workspace/global/state/current.md` (filesystem mount). For DB data (task counts, run logs, sessions), it uses the `query_dashboard` MCP tool (see Container-Side MCP Tool below), which issues IPC requests to the host.

## Component 2: Weekly Deep Dive

**Schedule:** Mondays 9:30am ET (cron: `30 9 * * 1`, local time).

Runs after the Monday batch (bookmarks, ARIA watch, skills check all run at 9am).

**Group:** `telegram_claire`, `context_mode: group`

**Data sources:** Everything from the daily summary, plus:
- `data/sessions/{group}/.claude/skills/` — skill counts per group (via IPC `skill_inventory` query; these directories persist on the host across container restarts)
- `groups/global/state/` directory — file modification times (via IPC `state_freshness` query)
- Task run history for the past 7 days (success rate per task)
- `/workspace/group/bookmarks.md` — current watchlist items (direct filesystem read from group workspace)

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
1. **Consecutive failures:** A task has 2+ consecutive runs with `status: 'error'` in `task_run_logs`. Requires at least 2 logged runs (new tasks with only 1 failure do not trigger an alert).
2. **Stale task:** A task's `next_run` is more than 2x its interval in the past. Only applies to `interval`-type tasks. For `cron` tasks, staleness is detected by comparing `next_run` against the current time — if `next_run` is more than 24 hours in the past, the task is considered stale. `once`-type tasks are excluded from staleness checks.

**Behavior:**
- After each task completes, the scheduler checks whether to fire an alert
- Sends alerts to the main group's chat JID, resolved via `deps.registeredGroups()` where `isMain === true`
- Uses `deps.sendMessage()` (host-side, no container spawn needed)
- Includes: task name, group, error message (truncated to 200 chars), last successful run time
- Deduplication: track alerted task IDs in a `Set<string>` in memory; don't re-alert for the same task until it either succeeds or a new failure occurs
- Batching: alerts that fire within a 60-second window are combined into a single message

**Message format:**

```
! Task Alert

*Morning Briefing* (CLAIRE) failed 2x in a row.
Last error: Container timeout after 300s
Last success: Mar 22, 6:02am

Check logs: tail -50 logs/nanoclaw.log | grep briefing
```

## New Code Required

### 1. IPC Handler: `dashboard_query` (new `src/dashboard-ipc.ts`)

Handles requests from container agents to query host-side data.

**IPC routing:** Add an explicit `case 'dashboard_query':` in the `processTaskIpc` switch in `src/ipc.ts`, delegating to the handler in `src/dashboard-ipc.ts`. (Single type, not a family — no prefix matching needed.)

**Host-side paths:** Results written to `data/ipc/{groupFolder}/dashboard_results/{requestId}.json`
**Container-side paths:** Visible at `/workspace/ipc/dashboard_results/{requestId}.json`

```typescript
type DashboardQueryType =
  | 'task_summary'      // all scheduled tasks with metadata
  | 'run_logs_24h'      // task_run_logs from last 24h
  | 'run_logs_7d'       // task_run_logs from last 7 days
  | 'group_summary'     // registered groups with session info
  | 'skill_inventory'   // skill counts per group (reads host filesystem; agent cannot access these directly)
  | 'state_freshness';  // mtime of files in groups/global/state/ (known limitation: reflects host-side mtime, not container write time)
```

### 2. Container-Side MCP Tool: `query_dashboard` (`container/agent-runner/src/ipc-mcp-stdio.ts`)

Follows the existing IPC MCP tool pattern (like `pageindex_fetch`, `browser_*`):
- Exposes an MCP tool `query_dashboard` with parameter `queryType: DashboardQueryType`
- Writes a `dashboard_query` JSON task to `/workspace/ipc/tasks/`
- Polls `/workspace/ipc/dashboard_results/{requestId}.json` using a generic `waitForIpcResult(dir, requestId, maxWait)` helper (extract from existing `waitFor*Result` functions to avoid a fifth copy-paste variant)
- Returns the parsed JSON result to the agent

This gives the scheduled dashboard agent a clean MCP interface to query host-side data without writing raw IPC files.

### 3. DB Query Functions (`src/db.ts`)

```typescript
getTaskRunLogs(since: string): TaskRunLog[]
getTaskSuccessRate(taskId: string, days: number): { total: number; passed: number }
getConsecutiveFailures(taskId: string): number  // scans backwards from most recent, stops at first success or LIMIT 20
```

### 4. Alert Check (`src/task-scheduler.ts`)

After each task run completes:
```typescript
function checkAlerts(task: ScheduledTask, result: string, deps: SchedulerDependencies): void
```

- Query consecutive failure count from `task_run_logs` via `getConsecutiveFailures()`
- If >= 2 consecutive failures, queue an alert
- Resolve CLAIRE JID via `deps.registeredGroups()` where `isMain === true`
- Send via `deps.sendMessage(claireJid, alertText)`
- Dedup: `alertedTaskIds: Set<string>` (cleared per task on success)
- Batch: collect alerts within 60s window, send as single message

### 5. Scheduled Tasks (DB inserts)

Two new rows in `scheduled_tasks`:
- `dashboard-daily` — cron `15 7 * * 1-5`, group `telegram_claire`, context_mode `group`
- `dashboard-weekly` — cron `30 9 * * 1`, group `telegram_claire`, context_mode `group`

## File Changes

| File | Change |
|------|--------|
| `src/dashboard-ipc.ts` | New — IPC handler for dashboard queries |
| `src/db.ts` | Add `getTaskRunLogs()`, `getTaskSuccessRate()`, `getConsecutiveFailures()` |
| `src/task-scheduler.ts` | Add `checkAlerts()` after task completion, alert batching |
| `src/ipc.ts` | Register dashboard IPC handler |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `query_dashboard` MCP tool + `waitForDashboardResult()` |

## Known Limitations

- **Alert dedup lost on restart:** The `Set<string>` tracking alerted task IDs is in-memory. On NanoClaw restart, previously-alerted tasks may re-alert if still failing. Acceptable for personal use.
- **State file mtime:** `state_freshness` reports host-side `mtime`, which may not exactly match container write time due to mount sync.
- **Missing `current.md`:** If the priorities file is missing or empty, the dashboard task should note "Priorities not yet set" rather than failing.
- **Alert storm:** If all tasks fail simultaneously (e.g., container runtime down), up to N alerts fire (one per task, batched within 60s). No per-hour cap — acceptable given the small task count (6).

## Out of Scope

- No web UI, charts, or browser-based dashboard
- No new services or dependencies
- No historical trend tracking beyond 7-day run logs
- No cross-group aggregation of agent conversation metrics
- Dashboard does not modify any state — read-only (except `dashboard-state.json` snapshot for weekly skill diff)

## Testing

- Unit tests for DB query functions (`getTaskRunLogs`, `getTaskSuccessRate`, `getConsecutiveFailures`)
- Unit test for `checkAlerts` logic (consecutive failure detection, deduplication, batching, first-run edge case)
- Manual test: trigger daily/weekly tasks via `next_run` update, verify message format
- Manual test: force a task failure 2x, verify alert fires to CLAIRE
