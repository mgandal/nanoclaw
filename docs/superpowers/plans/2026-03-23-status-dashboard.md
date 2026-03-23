# Status Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram-based status dashboard with daily summaries, weekly deep dives, and real-time failure alerts.

**Architecture:** Three components: (1) Host-side IPC handler + DB queries for dashboard data, (2) Container-side MCP tool for agents to query that data, (3) Alert check hook in the task scheduler. Daily/weekly reports are scheduled tasks that run in CLAIRE's container context.

**Tech Stack:** TypeScript, better-sqlite3, MCP SDK (zod), existing IPC file-based patterns.

**Spec:** `docs/superpowers/specs/2026-03-23-status-dashboard-design.md`

---

### File Structure

| File | Responsibility |
|------|---------------|
| `src/dashboard-ipc.ts` | **New.** Host-side IPC handler — receives `dashboard_query` tasks, queries DB/filesystem, writes JSON results |
| `src/db.ts` | **Modify.** Add 3 query functions: `getTaskRunLogs`, `getTaskSuccessRate`, `getConsecutiveFailures` |
| `src/task-scheduler.ts` | **Modify.** Add `checkAlerts()` called after each task run, alert batching logic |
| `src/ipc.ts` | **Modify.** Add `case 'dashboard_query':` routing to `processTaskIpc` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **Modify.** Add `query_dashboard` MCP tool + generic `waitForIpcResult` helper |
| `src/dashboard-ipc.test.ts` | **New.** Tests for dashboard IPC handler |
| `src/task-scheduler.test.ts` | **Modify.** Add tests for `checkAlerts` |

---

### Task 1: DB Query Functions

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Write failing tests for the 3 new DB functions**

Add to `src/db.test.ts`:

```typescript
import {
  _initTestDatabase,
  logTaskRun,
  getTaskRunLogs,
  getTaskSuccessRate,
  getConsecutiveFailures,
} from './db.js';

describe('dashboard DB queries', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  describe('getTaskRunLogs', () => {
    it('returns logs since a given timestamp', () => {
      logTaskRun({ task_id: 't1', run_at: '2026-03-22T10:00:00Z', duration_ms: 1000, status: 'success', result: 'ok', error: null });
      logTaskRun({ task_id: 't1', run_at: '2026-03-23T10:00:00Z', duration_ms: 2000, status: 'error', result: null, error: 'fail' });
      logTaskRun({ task_id: 't2', run_at: '2026-03-23T12:00:00Z', duration_ms: 500, status: 'success', result: 'done', error: null });

      const logs = getTaskRunLogs('2026-03-23T00:00:00Z');
      expect(logs).toHaveLength(2);
      expect(logs[0].task_id).toBe('t1');
      expect(logs[1].task_id).toBe('t2');
    });
  });

  describe('getTaskSuccessRate', () => {
    it('returns pass/total for a task in the given window', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 3600000).toISOString();
      logTaskRun({ task_id: 't1', run_at: recent, duration_ms: 100, status: 'success', result: 'ok', error: null });
      logTaskRun({ task_id: 't1', run_at: now.toISOString(), duration_ms: 100, status: 'error', result: null, error: 'fail' });

      const rate = getTaskSuccessRate('t1', 1);
      expect(rate).toEqual({ total: 2, passed: 1 });
    });
  });

  describe('getConsecutiveFailures', () => {
    it('returns 0 when last run was success', () => {
      logTaskRun({ task_id: 't1', run_at: '2026-03-23T10:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail' });
      logTaskRun({ task_id: 't1', run_at: '2026-03-23T11:00:00Z', duration_ms: 100, status: 'success', result: 'ok', error: null });

      expect(getConsecutiveFailures('t1')).toBe(0);
    });

    it('returns count of trailing consecutive failures', () => {
      logTaskRun({ task_id: 't1', run_at: '2026-03-23T10:00:00Z', duration_ms: 100, status: 'success', result: 'ok', error: null });
      logTaskRun({ task_id: 't1', run_at: '2026-03-23T11:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail1' });
      logTaskRun({ task_id: 't1', run_at: '2026-03-23T12:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail2' });
      logTaskRun({ task_id: 't1', run_at: '2026-03-23T13:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail3' });

      expect(getConsecutiveFailures('t1')).toBe(3);
    });

    it('returns 0 when no runs exist', () => {
      expect(getConsecutiveFailures('nonexistent')).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement the 3 DB functions**

Add to `src/db.ts` after the `logTaskRun` function (around line 566):

```typescript
/** Get task run logs since a given ISO timestamp, ordered by run_at ascending. */
export function getTaskRunLogs(since: string): TaskRunLog[] {
  return db
    .prepare('SELECT * FROM task_run_logs WHERE run_at >= ? ORDER BY run_at ASC')
    .all(since) as TaskRunLog[];
}

/** Get success rate for a task over the last N days. */
export function getTaskSuccessRate(
  taskId: string,
  days: number,
): { total: number; passed: number } {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db
    .prepare(
      'SELECT status FROM task_run_logs WHERE task_id = ? AND run_at >= ? ORDER BY run_at DESC',
    )
    .all(taskId, since) as { status: string }[];
  return {
    total: rows.length,
    passed: rows.filter((r) => r.status === 'success').length,
  };
}

/** Count consecutive failures from the most recent run backwards. Stops at first success or LIMIT 20. */
export function getConsecutiveFailures(taskId: string): number {
  const rows = db
    .prepare(
      'SELECT status FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 20',
    )
    .all(taskId) as { status: string }[];
  let count = 0;
  for (const row of rows) {
    if (row.status !== 'error') break;
    count++;
  }
  return count;
}

/** Get the ISO timestamp of the most recent successful run for a task, or null if none. */
export function getLastSuccessTime(taskId: string): string | null {
  const row = db
    .prepare(
      "SELECT run_at FROM task_run_logs WHERE task_id = ? AND status = 'success' ORDER BY run_at DESC LIMIT 1",
    )
    .get(taskId) as { run_at: string } | undefined;
  return row?.run_at ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All dashboard DB query tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(dashboard): add DB query functions for run logs, success rate, consecutive failures"
```

---

### Task 2: Dashboard IPC Handler (Host-Side)

**Files:**
- Create: `src/dashboard-ipc.ts`
- Create: `src/dashboard-ipc.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/dashboard-ipc.test.ts`:

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, logTaskRun, createTask, setRegisteredGroup, setSession } from './db.js';
import { handleDashboardIpc } from './dashboard-ipc.js';

describe('handleDashboardIpc', () => {
  let tmpDir: string;

  beforeEach(() => {
    _initTestDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-ipc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false for non-dashboard types', async () => {
    const result = await handleDashboardIpc(
      { type: 'pageindex_fetch' },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(false);
  });

  it('handles task_summary query', async () => {
    createTask({
      id: 'test-task-1',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'test prompt',
      schedule_type: 'cron',
      schedule_value: '0 7 * * 1-5',
      status: 'active',
      next_run: new Date().toISOString(),
      created_at: new Date().toISOString(),
      context_mode: 'isolated',
    });

    const result = await handleDashboardIpc(
      { type: 'dashboard_query', requestId: 'req-001', queryType: 'task_summary' },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true);

    const resultFile = path.join(tmpDir, 'ipc', 'telegram_claire', 'dashboard_results', 'req-001.json');
    expect(fs.existsSync(resultFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(data.success).toBe(true);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('test-task-1');
  });

  it('handles run_logs_24h query', async () => {
    logTaskRun({ task_id: 't1', run_at: new Date().toISOString(), duration_ms: 100, status: 'success', result: 'ok', error: null });

    const result = await handleDashboardIpc(
      { type: 'dashboard_query', requestId: 'req-002', queryType: 'run_logs_24h' },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true);

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'ipc', 'telegram_claire', 'dashboard_results', 'req-002.json'), 'utf-8'),
    );
    expect(data.success).toBe(true);
    expect(data.logs).toHaveLength(1);
  });

  it('handles group_summary query', async () => {
    setRegisteredGroup('tg:123', {
      name: 'CLAIRE',
      folder: 'telegram_claire',
      trigger: '@Claire',
      added_at: new Date().toISOString(),
      isMain: true,
      requiresTrigger: false,
    });

    const result = await handleDashboardIpc(
      { type: 'dashboard_query', requestId: 'req-003', queryType: 'group_summary' },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true);

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'ipc', 'telegram_claire', 'dashboard_results', 'req-003.json'), 'utf-8'),
    );
    expect(data.success).toBe(true);
    expect(data.groups).toBeDefined();
  });

  it('rejects invalid requestId', async () => {
    const result = await handleDashboardIpc(
      { type: 'dashboard_query', requestId: '../../../etc/passwd', queryType: 'task_summary' },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true); // handled (rejected), not unrecognized
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dashboard-ipc.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the dashboard IPC handler**

Create `src/dashboard-ipc.ts`:

```typescript
import fs from 'fs';
import path from 'path';

import {
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getTaskRunLogs,
  getTaskSuccessRate,
} from './db.js';
import { logger } from './logger.js';

const GROUPS_DIR = path.join(process.cwd(), 'groups');
const SESSIONS_DIR = path.join(process.cwd(), 'data', 'sessions');

/**
 * Handle dashboard_query IPC requests from container agents.
 * Follows the same pattern as handlePageindexIpc.
 * Returns true if handled, false if not a dashboard type.
 */
export async function handleDashboardIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  if (data.type !== 'dashboard_query') return false;

  const requestId = data.requestId as string | undefined;
  if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    logger.warn({ sourceGroup, requestId }, 'dashboard IPC invalid requestId');
    return true;
  }

  const queryType = data.queryType as string | undefined;
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'dashboard_results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: Record<string, unknown>) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  try {
    switch (queryType) {
      case 'task_summary': {
        const tasks = getAllTasks();
        writeResult({
          success: true,
          tasks: tasks.map((t) => ({
            id: t.id,
            group_folder: t.group_folder,
            schedule_type: t.schedule_type,
            schedule_value: t.schedule_value,
            status: t.status,
            next_run: t.next_run,
            last_run: t.last_run,
            last_result: t.last_result,
            context_mode: t.context_mode,
          })),
        });
        break;
      }

      case 'run_logs_24h': {
        const since = new Date(Date.now() - 24 * 3600000).toISOString();
        const logs = getTaskRunLogs(since);
        writeResult({ success: true, logs });
        break;
      }

      case 'run_logs_7d': {
        const since = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
        const logs = getTaskRunLogs(since);
        writeResult({ success: true, logs });
        break;
      }

      case 'group_summary': {
        const groups = getAllRegisteredGroups();
        const sessions = getAllSessions();
        writeResult({
          success: true,
          groups: Object.entries(groups).map(([jid, g]) => ({
            jid,
            name: g.name,
            folder: g.folder,
            isMain: g.isMain,
            hasSession: !!sessions[g.folder],
          })),
        });
        break;
      }

      case 'skill_inventory': {
        const groups = getAllRegisteredGroups();
        const inventory: Record<string, number> = {};
        for (const g of Object.values(groups)) {
          const skillsDir = path.join(SESSIONS_DIR, g.folder, '.claude', 'skills');
          try {
            const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
            inventory[g.folder] = entries.filter((e) => e.isDirectory()).length;
          } catch {
            inventory[g.folder] = 0;
          }
        }
        writeResult({ success: true, inventory });
        break;
      }

      case 'state_freshness': {
        const stateDir = path.join(GROUPS_DIR, 'global', 'state');
        const freshness: Record<string, string> = {};
        try {
          for (const file of fs.readdirSync(stateDir)) {
            const stat = fs.statSync(path.join(stateDir, file));
            freshness[file] = stat.mtime.toISOString();
          }
        } catch {
          // state dir may not exist
        }
        writeResult({ success: true, freshness });
        break;
      }

      default:
        writeResult({ success: false, error: `Unknown query type: ${queryType}` });
    }

    logger.info({ queryType, requestId, sourceGroup }, 'dashboard IPC handled');
    return true;
  } catch (err) {
    logger.error({ err, queryType, requestId }, 'dashboard IPC error');
    writeResult({
      success: false,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dashboard-ipc.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-ipc.ts src/dashboard-ipc.test.ts
git commit -m "feat(dashboard): add host-side IPC handler for dashboard queries"
```

---

### Task 3: Wire IPC Handler Into Router

**Files:**
- Modify: `src/ipc.ts`

- [ ] **Step 1: Add import for dashboard IPC handler**

At the top of `src/ipc.ts`, add with other IPC handler imports:

```typescript
import { handleDashboardIpc } from './dashboard-ipc.js';
```

- [ ] **Step 2: Add dashboard_query routing in the default case of processTaskIpc**

In `src/ipc.ts`, inside the `default:` case of `processTaskIpc` (around line 615), add BEFORE the pageindex check:

```typescript
      if (typeof data.type === 'string' && data.type === 'dashboard_query') {
        handled = await handleDashboardIpc(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
          DATA_DIR,
        );
      }
```

- [ ] **Step 3: Build and verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Clean build, no errors

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts
git commit -m "feat(dashboard): wire dashboard_query IPC routing"
```

---

### Task 4: Container-Side MCP Tool

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Extract generic `waitForIpcResult` helper**

Replace the existing `waitForBrowserResult` function (around line 377) with a generic helper, then make browser use it:

```typescript
const DASHBOARD_RESULTS_DIR = path.join(IPC_DIR, 'dashboard_results');

async function waitForIpcResult(
  resultsDir: string,
  requestId: string,
  maxWait = 120000,
): Promise<Record<string, unknown>> {
  const resultFile = path.join(resultsDir, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;
  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        return { success: false, message: 'Failed to read result' };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }
  return { success: false, message: 'Request timed out' };
}

async function waitForBrowserResult(
  requestId: string,
  maxWait = 120000,
): Promise<{ success: boolean; message: string; data?: unknown }> {
  return waitForIpcResult(BROWSER_RESULTS_DIR, requestId, maxWait) as Promise<{
    success: boolean;
    message: string;
    data?: unknown;
  }>;
}
```

- [ ] **Step 2: Add the `query_dashboard` MCP tool**

Add after the existing `waitForIpcResult` helper, outside any `if (isMain)` guard (dashboard should work from any group that has a dashboard task):

```typescript
server.tool(
  'query_dashboard',
  'Query NanoClaw system status. Returns task summaries, run logs, group info, skill counts, or state file freshness from the host.',
  {
    queryType: z
      .enum([
        'task_summary',
        'run_logs_24h',
        'run_logs_7d',
        'group_summary',
        'skill_inventory',
        'state_freshness',
      ])
      .describe('The type of dashboard data to query'),
  },
  async (args) => {
    const requestId = `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'dashboard_query',
      requestId,
      queryType: args.queryType,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForIpcResult(DASHBOARD_RESULTS_DIR, requestId, 30000);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: !(result as { success?: boolean }).success,
    };
  },
);
```

- [ ] **Step 3: Build host and container**

Run: `npm run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(dashboard): add query_dashboard MCP tool + generic waitForIpcResult"
```

---

### Task 5: Alert Check in Task Scheduler

**Files:**
- Modify: `src/task-scheduler.ts`
- Modify: `src/task-scheduler.test.ts` (if it exists; create section if needed)

- [ ] **Step 1: Add alert state and checkAlerts function**

Add imports at top of `src/task-scheduler.ts`:

```typescript
import { getConsecutiveFailures, getLastSuccessTime } from './db.js';
```

Add after the `_resetSchedulerLoopForTests` function at the bottom of the file:

```typescript
// --- Real-time failure alerts ---

const alertedTaskIds = new Set<string>();
let pendingAlerts: Array<{ taskId: string; group: string; error: string; lastSuccess: string | null }> = [];
let alertFlushTimer: ReturnType<typeof setTimeout> | null = null;
const ALERT_BATCH_WINDOW_MS = 60000;

/**
 * Check for failure alerts after a task run completes.
 * Also checks for stale tasks (next_run far in the past).
 */
export function checkAlerts(
  task: ScheduledTask,
  error: string | null,
  deps: SchedulerDependencies,
): void {
  // Clear dedup on success
  if (!error) {
    alertedTaskIds.delete(task.id);
    return;
  }

  // Already alerted for this task
  if (alertedTaskIds.has(task.id)) return;

  const failures = getConsecutiveFailures(task.id);
  if (failures < 2) return;

  alertedTaskIds.add(task.id);

  const lastSuccess = getLastSuccessTime(task.id);

  pendingAlerts.push({
    taskId: task.id,
    group: task.group_folder,
    error: error.slice(0, 200),
    lastSuccess,
  });

  // Batch alerts within a window
  if (!alertFlushTimer) {
    alertFlushTimer = setTimeout(() => {
      flushAlerts(deps);
    }, ALERT_BATCH_WINDOW_MS);
  }
}

/**
 * Check for stale tasks — tasks whose next_run is far in the past.
 * Called from the scheduler loop, not after individual task runs.
 * - interval tasks: stale if next_run > 2x interval behind
 * - cron tasks: stale if next_run > 24h behind
 * - once tasks: excluded
 */
export function checkStaleTasks(
  tasks: ScheduledTask[],
  deps: SchedulerDependencies,
): void {
  const now = Date.now();
  for (const task of tasks) {
    if (task.status !== 'active' || !task.next_run) continue;
    if (task.schedule_type === 'once') continue;
    if (alertedTaskIds.has(`stale:${task.id}`)) continue;

    const nextRunMs = new Date(task.next_run).getTime();
    const lagMs = now - nextRunMs;
    if (lagMs <= 0) continue;

    let isStale = false;
    if (task.schedule_type === 'interval') {
      const intervalMs = parseInt(task.schedule_value, 10);
      isStale = intervalMs > 0 && lagMs > intervalMs * 2;
    } else if (task.schedule_type === 'cron') {
      isStale = lagMs > 24 * 3600000;
    }

    if (isStale) {
      alertedTaskIds.add(`stale:${task.id}`);
      pendingAlerts.push({
        taskId: task.id,
        group: task.group_folder,
        error: `Task is stale — next_run was ${task.next_run}, ${Math.round(lagMs / 3600000)}h ago`,
        lastSuccess: getLastSuccessTime(task.id),
      });

      if (!alertFlushTimer) {
        alertFlushTimer = setTimeout(() => {
          flushAlerts(deps);
        }, ALERT_BATCH_WINDOW_MS);
      }
    }
  }
}

function flushAlerts(deps: SchedulerDependencies): void {
  alertFlushTimer = null;
  if (pendingAlerts.length === 0) return;

  // Find main group JID
  const groups = deps.registeredGroups();
  const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
  if (!mainEntry) {
    logger.warn('No main group found for alert delivery');
    pendingAlerts = [];
    return;
  }
  const mainJid = mainEntry[0];

  let text = '⚠ *Task Alert*\n';
  for (const alert of pendingAlerts) {
    const shortGroup = alert.group.replace('telegram_', '').toUpperCase();
    const failCount = getConsecutiveFailures(alert.taskId);
    const successLine = alert.lastSuccess ? `\nLast success: ${alert.lastSuccess}` : '';
    text += `\n*${alert.taskId}* (${shortGroup})${failCount > 0 ? ` failed ${failCount}x in a row` : ' is stale'}.\nLast error: ${alert.error}${successLine}\n`;
  }

  deps.sendMessage(mainJid, text).catch((err) =>
    logger.error({ err }, 'Failed to send task alert'),
  );

  pendingAlerts = [];
}

/** @internal - for tests only. */
export function _resetAlertsForTests(): void {
  alertedTaskIds.clear();
  pendingAlerts = [];
  if (alertFlushTimer) {
    clearTimeout(alertFlushTimer);
    alertFlushTimer = null;
  }
}
```

- [ ] **Step 2: Hook checkAlerts into runTask**

In `src/task-scheduler.ts`, in the `runTask` function, right after the `logTaskRun(...)` call (around line 273), add:

```typescript
  checkAlerts(task, error, deps);
```

Also in the `loop` function inside `startSchedulerLoop`, after the `for` loop over `dueTasks` (around line 311), add staleness check:

```typescript
      // Check for stale tasks (next_run far in the past)
      const allTasks = getAllTasks();
      checkStaleTasks(allTasks, deps);
```

- [ ] **Step 3: Build and verify**

Run: `npm run build 2>&1 | tail -5`
Expected: Clean build

- [ ] **Step 4: Write tests for checkAlerts**

Add to `src/task-scheduler.test.ts` (or create a new describe block):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkAlerts, checkStaleTasks, _resetAlertsForTests } from './task-scheduler.js';
import { _initTestDatabase, logTaskRun } from './db.js';
import type { SchedulerDependencies } from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

function makeMockDeps(overrides: Partial<SchedulerDependencies> = {}): SchedulerDependencies {
  return {
    registeredGroups: () => ({
      'tg:123': {
        name: 'CLAIRE',
        folder: 'telegram_claire',
        trigger: '@Claire',
        added_at: new Date().toISOString(),
        isMain: true,
        requiresTrigger: false,
      },
    }),
    getSessions: () => ({}),
    queue: {} as any,
    onProcess: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'test-task',
    group_folder: 'telegram_claire',
    chat_jid: 'tg:123',
    prompt: 'test',
    schedule_type: 'cron',
    schedule_value: '0 7 * * 1-5',
    status: 'active',
    next_run: new Date().toISOString(),
    last_run: null,
    last_result: null,
    created_at: new Date().toISOString(),
    context_mode: 'isolated',
    ...overrides,
  };
}

describe('checkAlerts', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not alert on success', () => {
    const deps = makeMockDeps();
    checkAlerts(makeTask(), null, deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('does not alert on single failure', () => {
    logTaskRun({ task_id: 'test-task', run_at: new Date().toISOString(), duration_ms: 100, status: 'error', result: null, error: 'fail' });
    const deps = makeMockDeps();
    checkAlerts(makeTask(), 'fail', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('sends alert after 2+ consecutive failures and flush timer', () => {
    logTaskRun({ task_id: 'test-task', run_at: '2026-03-23T10:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail1' });
    logTaskRun({ task_id: 'test-task', run_at: '2026-03-23T11:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail2' });
    const deps = makeMockDeps();
    checkAlerts(makeTask(), 'fail2', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg).toContain('Task Alert');
    expect(msg).toContain('test-task');
  });

  it('deduplicates — does not re-alert for same task', () => {
    logTaskRun({ task_id: 'test-task', run_at: '2026-03-23T10:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail1' });
    logTaskRun({ task_id: 'test-task', run_at: '2026-03-23T11:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail2' });
    const deps = makeMockDeps();
    checkAlerts(makeTask(), 'fail2', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    (deps.sendMessage as ReturnType<typeof vi.fn>).mockClear();
    checkAlerts(makeTask(), 'fail3', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('clears dedup state on success, allowing re-alert', () => {
    logTaskRun({ task_id: 'test-task', run_at: '2026-03-23T10:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail1' });
    logTaskRun({ task_id: 'test-task', run_at: '2026-03-23T11:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail2' });
    const deps = makeMockDeps();
    checkAlerts(makeTask(), 'fail2', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    checkAlerts(makeTask(), null, deps);
    logTaskRun({ task_id: 'test-task', run_at: '2026-03-23T12:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail3' });
    logTaskRun({ task_id: 'test-task', run_at: '2026-03-23T13:00:00Z', duration_ms: 100, status: 'error', result: null, error: 'fail4' });
    (deps.sendMessage as ReturnType<typeof vi.fn>).mockClear();
    checkAlerts(makeTask(), 'fail4', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
  });
});

describe('checkStaleTasks', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('alerts for cron task with next_run > 24h in the past', () => {
    const deps = makeMockDeps();
    const staleNextRun = new Date(Date.now() - 25 * 3600000).toISOString();
    checkStaleTasks([makeTask({ next_run: staleNextRun })], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg).toContain('stale');
  });

  it('does not alert for cron task with recent next_run', () => {
    const deps = makeMockDeps();
    const recentNextRun = new Date(Date.now() - 3600000).toISOString();
    checkStaleTasks([makeTask({ next_run: recentNextRun })], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('excludes once-type tasks', () => {
    const deps = makeMockDeps();
    const staleNextRun = new Date(Date.now() - 48 * 3600000).toISOString();
    checkStaleTasks([makeTask({ schedule_type: 'once', next_run: staleNextRun })], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('alerts for interval task with next_run > 2x interval behind', () => {
    const deps = makeMockDeps();
    const intervalMs = 3600000;
    const staleNextRun = new Date(Date.now() - intervalMs * 3).toISOString();
    checkStaleTasks([makeTask({ schedule_type: 'interval', schedule_value: String(intervalMs), next_run: staleNextRun })], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/task-scheduler.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/task-scheduler.ts src/task-scheduler.test.ts
git commit -m "feat(dashboard): add real-time failure alerts with batching and dedup"
```

---

### Task 6: Register Scheduled Tasks in DB

**Files:**
- None created — DB inserts via sqlite3 CLI

- [ ] **Step 1: Insert the daily dashboard task**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode) VALUES (
  'dashboard-daily',
  'telegram_claire',
  'tg:8475020901',
  'You are Claire. Generate a daily status dashboard and send it via mcp__nanoclaw__send_message.

Use the mcp__nanoclaw__query_dashboard tool to gather data:
1. query_dashboard(queryType: \"task_summary\") — get all scheduled tasks
2. query_dashboard(queryType: \"run_logs_24h\") — get pass/fail counts
3. query_dashboard(queryType: \"group_summary\") — get registered groups
4. Read /workspace/global/state/current.md for priorities and escalations

Format as a compact Telegram message (~15-20 lines) using *bold* (single asterisks), • bullets. Include:
- Agent group names and active session count
- Task health: total scheduled, ran, passed, failed in last 24h
- Top 3 priorities from current.md
- Escalations from current.md
- Next upcoming task

If current.md is missing or empty, note \"Priorities not yet set\".
Do NOT use markdown headers or **double asterisks**.',
  'cron',
  '15 7 * * 1-5',
  NULL,
  'active',
  datetime('now'),
  'group'
);"
```

- [ ] **Step 2: Insert the weekly dashboard task**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode) VALUES (
  'dashboard-weekly',
  'telegram_claire',
  'tg:8475020901',
  'You are Claire. Generate a weekly deep-dive status report and send it via mcp__nanoclaw__send_message.

Use the mcp__nanoclaw__query_dashboard tool to gather ALL data:
1. query_dashboard(queryType: \"group_summary\") — registered groups
2. query_dashboard(queryType: \"skill_inventory\") — skill counts per group
3. query_dashboard(queryType: \"task_summary\") — all scheduled tasks
4. query_dashboard(queryType: \"run_logs_7d\") — 7-day run history for success rates
5. query_dashboard(queryType: \"state_freshness\") — state file modification times
6. Read /workspace/global/state/current.md for priorities and escalations
7. Read /workspace/group/bookmarks.md for watchlist items

Compare skill counts against /workspace/group/dashboard-state.json (create if missing). After reporting, save current inventory to that file.

Format as a detailed Telegram message (~40-60 lines) using *bold* (single asterisks), • bullets. Include:
- Per-group breakdown: name, skill count, task count, active/idle
- Each scheduled task: group, schedule, last run, 7-day success rate
- Bookmarks watchlist with routing targets
- State file freshness (days since last update)
- Priorities and escalations from current.md
- Skill changes since last week (added/removed)

Do NOT use markdown headers or **double asterisks**.',
  'cron',
  '30 9 * * 1',
  NULL,
  'active',
  datetime('now'),
  'group'
);"
```

- [ ] **Step 3: Verify tasks were inserted**

```bash
sqlite3 store/messages.db "SELECT id, group_folder, schedule_value FROM scheduled_tasks WHERE id LIKE 'dashboard%';"
```

Expected: Two rows — `dashboard-daily` and `dashboard-weekly`

- [ ] **Step 4: No commit needed** (DB changes only, not in git)

---

### Task 7: Build Container, Restart, and Manual Test

**Files:**
- None modified

- [ ] **Step 1: Build the project**

```bash
npm run build
```

Expected: Clean build

- [ ] **Step 2: Rebuild container image**

```bash
./container/build.sh
```

Expected: Successful build of `nanoclaw-agent:latest`

- [ ] **Step 3: Restart the service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 4: Trigger the daily dashboard task**

```bash
sqlite3 store/messages.db "UPDATE scheduled_tasks SET next_run = datetime('now') WHERE id = 'dashboard-daily';"
```

Wait ~3 minutes, then check:

```bash
sqlite3 store/messages.db "SELECT last_result FROM scheduled_tasks WHERE id = 'dashboard-daily';"
```

Expected: A status summary was sent to the CLAIRE Telegram chat

- [ ] **Step 5: Commit all uncommitted changes and push**

```bash
git push origin main
```
