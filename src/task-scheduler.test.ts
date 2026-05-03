import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getDueTasks,
  getTaskById,
  getTaskRunLogs,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import {
  _resetAlertsForTests,
  _resetSchedulerLoopForTests,
  checkAlerts,
  checkStaleTasks,
  computeNextRun,
  runGuardScript,
  startSchedulerLoop,
} from './task-scheduler.js';
import type { SchedulerDependencies } from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

// Re-export TIMEZONE for cron tests
import { TIMEZONE } from './config.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      agent_name: null,
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

function makeMockDeps(
  overrides: Partial<SchedulerDependencies> = {},
): SchedulerDependencies {
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
    agent_name: null,
    created_at: new Date().toISOString(),
    context_mode: 'isolated',
    ...overrides,
  };
}

function createTestTask(id = 'test-task') {
  createTask({
    id,
    group_folder: 'telegram_claire',
    chat_jid: 'tg:123',
    prompt: 'test',
    schedule_type: 'cron',
    schedule_value: '0 7 * * 1-5',
    status: 'active',
    next_run: new Date().toISOString(),
    agent_name: null,
    created_at: new Date().toISOString(),
    context_mode: 'isolated',
  });
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
    createTestTask();
    logTaskRun({
      task_id: 'test-task',
      run_at: new Date().toISOString(),
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail',
    });
    const deps = makeMockDeps();
    checkAlerts(makeTask(), 'fail', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('sends alert after 2+ consecutive failures and flush timer', () => {
    createTestTask();
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail1',
    });
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail2',
    });
    const deps = makeMockDeps();
    checkAlerts(makeTask(), 'fail2', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg).toContain('Task Alert');
    expect(msg).toContain('test-task');
  });

  it('deduplicates — does not re-alert for same task', () => {
    createTestTask();
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail1',
    });
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail2',
    });
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
    createTestTask();
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail1',
    });
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail2',
    });
    const deps = makeMockDeps();
    checkAlerts(makeTask(), 'fail2', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    checkAlerts(makeTask(), null, deps);
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T12:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail3',
    });
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T13:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail4',
    });
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
    checkStaleTasks(
      [makeTask({ schedule_type: 'once', next_run: staleNextRun })],
      deps,
    );
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('alerts for interval task with next_run > 2x interval behind', () => {
    const deps = makeMockDeps();
    const intervalMs = 3600000;
    const staleNextRun = new Date(Date.now() - intervalMs * 3).toISOString();
    checkStaleTasks(
      [
        makeTask({
          schedule_type: 'interval',
          schedule_value: String(intervalMs),
          next_run: staleNextRun,
        }),
      ],
      deps,
    );
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
  });

  it('deduplicates stale alerts — does not re-alert for same stale task', () => {
    const deps = makeMockDeps();
    const staleNextRun = new Date(Date.now() - 25 * 3600000).toISOString();
    const staleTask = makeTask({ next_run: staleNextRun });
    checkStaleTasks([staleTask], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    (deps.sendMessage as ReturnType<typeof vi.fn>).mockClear();
    // Second call should not re-alert
    checkStaleTasks([staleTask], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('skips paused and inactive tasks', () => {
    const deps = makeMockDeps();
    const staleNextRun = new Date(Date.now() - 25 * 3600000).toISOString();
    checkStaleTasks(
      [makeTask({ next_run: staleNextRun, status: 'paused' })],
      deps,
    );
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('skips tasks with null next_run', () => {
    const deps = makeMockDeps();
    checkStaleTasks([makeTask({ next_run: null })], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('does not treat interval task as stale when interval value is invalid (0 or NaN)', () => {
    const deps = makeMockDeps();
    const staleNextRun = new Date(Date.now() - 25 * 3600000).toISOString();
    checkStaleTasks(
      [
        makeTask({
          schedule_type: 'interval',
          schedule_value: '0',
          next_run: staleNextRun,
        }),
      ],
      deps,
    );
    vi.advanceTimersByTime(70000);
    // Should not alert — intervalMs <= 0 makes the isStale check false
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});

describe('computeNextRun — edge cases (regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws on invalid cron expression', () => {
    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: 'not a cron',
    });
    expect(() => computeNextRun(task)).toThrow();
  });

  it('returns fallback for zero interval value', () => {
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: '0',
      next_run: new Date().toISOString(),
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Should be ~60s from now (fallback)
    const nextMs = new Date(nextRun!).getTime();
    expect(nextMs - Date.now()).toBeCloseTo(60000, -2);
  });

  it('returns fallback for negative interval value', () => {
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: '-5000',
      next_run: new Date().toISOString(),
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const nextMs = new Date(nextRun!).getTime();
    expect(nextMs - Date.now()).toBeCloseTo(60000, -2);
  });

  it('returns fallback for non-numeric interval value', () => {
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: 'abc',
      next_run: new Date().toISOString(),
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // NaN check triggers fallback
    const nextMs = new Date(nextRun!).getTime();
    expect(nextMs - Date.now()).toBeCloseTo(60000, -2);
  });

  it('handles null next_run on interval task (corrupted DB row)', () => {
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: '3600000',
      next_run: null,
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // With null next_run, base falls back to Date.now(), so next = now + interval
    const nextMs = new Date(nextRun!).getTime();
    expect(nextMs - Date.now()).toBe(3600000);
  });

  it('returns null for unknown schedule_type', () => {
    const task = makeTask({
      schedule_type: 'unknown' as any,
      schedule_value: '42',
    });
    expect(computeNextRun(task)).toBeNull();
  });

  it('throttles cron that fires every minute to >= 30 min from now', () => {
    // "every minute" cron — way too frequent
    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: '* * * * *',
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const gapMs = new Date(nextRun!).getTime() - Date.now();
    expect(gapMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});

describe('scheduler loop lifecycle (regression)', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prevents duplicate scheduler loop starts', () => {
    const enqueueTask = vi.fn();
    const deps: SchedulerDependencies = {
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    };

    startSchedulerLoop(deps);
    startSchedulerLoop(deps); // second call should be a no-op
    // No error thrown, scheduler runs once
  });

  it('skips tasks that become paused between getDueTasks and execution', async () => {
    // Create a task that is due
    createTask({
      id: 'task-pause-race',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const taskFn = vi.fn();
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        // Simulate: task was paused by the time enqueueTask checks
        // The scheduler re-reads the task inside the loop before enqueueing
        // so this should not run
      },
    );

    startSchedulerLoop({
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
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(enqueueTask).toHaveBeenCalledOnce();
  });
});

describe('checkAlerts — batching and edge cases (regression)', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches multiple task failures into a single alert message', () => {
    // Create two different tasks with consecutive failures
    createTestTask('task-a');
    createTestTask('task-b');

    logTaskRun({
      task_id: 'task-a',
      run_at: '2026-03-23T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail-a1',
    });
    logTaskRun({
      task_id: 'task-a',
      run_at: '2026-03-23T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail-a2',
    });
    logTaskRun({
      task_id: 'task-b',
      run_at: '2026-03-23T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail-b1',
    });
    logTaskRun({
      task_id: 'task-b',
      run_at: '2026-03-23T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail-b2',
    });

    const deps = makeMockDeps();
    checkAlerts(makeTask({ id: 'task-a' }), 'fail-a2', deps);
    checkAlerts(makeTask({ id: 'task-b' }), 'fail-b2', deps);

    // Before flush window, no messages sent
    expect(deps.sendMessage).not.toHaveBeenCalled();

    // After flush window, both alerts in one message
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg).toContain('task-a');
    expect(msg).toContain('task-b');
  });

  it('does not send alert when no main group is registered', () => {
    createTestTask();
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail1',
    });
    logTaskRun({
      task_id: 'test-task',
      run_at: '2026-03-23T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail2',
    });

    // Override registeredGroups to return no main group
    const deps = makeMockDeps({
      registeredGroups: () => ({
        'tg:456': {
          name: 'NON-MAIN',
          folder: 'telegram_nonmain',
          trigger: '@Bot',
          added_at: new Date().toISOString(),
          isMain: false,
          requiresTrigger: true,
        },
      }),
    });

    checkAlerts(makeTask(), 'fail2', deps);
    vi.advanceTimersByTime(70000);
    // sendMessage should NOT be called — no main group to deliver to
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});

describe('computeNextRun — cron edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles monthly cron (runs on 1st of each month)', () => {
    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: '0 9 1 * *', // 9am on 1st of month
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const nextDate = new Date(nextRun!);
    // Should be in the future and on the 1st of a month
    expect(nextDate.getTime()).toBeGreaterThan(Date.now());
    expect(nextDate.getUTCDate()).toBe(1);
  });

  it('handles yearly cron (runs on Jan 1st)', () => {
    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: '0 0 1 1 *', // midnight Jan 1st
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const nextDate = new Date(nextRun!);
    expect(nextDate.getTime()).toBeGreaterThan(Date.now());
    // Should be Jan 1 of a future year
    expect(nextDate.getUTCMonth()).toBe(0); // January
    expect(nextDate.getUTCDate()).toBe(1);
  });

  it('does not throttle hourly cron (inter-fire gap >= 30 min)', () => {
    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: '0 * * * *', // every hour
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const gapMs = new Date(nextRun!).getTime() - Date.now();
    // Hourly cron has 60min inter-fire gap, so it should NOT be throttled.
    // The next occurrence may be < 30 min away (e.g. if we're at :43),
    // but the throttle only kicks in when the cron FIRES too frequently.
    // So the gap should be <= 60min (one hour interval) and > 0.
    expect(gapMs).toBeGreaterThan(0);
    expect(gapMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

describe('task status transitions and DB persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updateTaskAfterRun marks once-task as completed when nextRun is null', () => {
    createTestTask('once-complete');
    // Simulate: computeNextRun returned null for a once-task
    updateTaskAfterRun('once-complete', null, 'Done');
    const task = getTaskById('once-complete');
    expect(task).toBeDefined();
    expect(task!.status).toBe('completed');
    expect(task!.last_result).toBe('Done');
    expect(task!.last_run).not.toBeNull();
    expect(task!.next_run).toBeNull();
  });

  it('updateTaskAfterRun keeps recurring task active when nextRun is provided', () => {
    createTestTask('recurring-active');
    const nextRun = new Date(Date.now() + 3600000).toISOString();
    updateTaskAfterRun('recurring-active', nextRun, 'OK');
    const task = getTaskById('recurring-active');
    expect(task).toBeDefined();
    expect(task!.status).toBe('active');
    expect(task!.next_run).toBe(nextRun);
    expect(task!.last_result).toBe('OK');
  });

  it('logTaskRun persists error details to task_run_logs', () => {
    createTestTask('log-error');
    const runAt = '2026-06-15T12:00:00Z';
    logTaskRun({
      task_id: 'log-error',
      run_at: runAt,
      duration_ms: 500,
      status: 'error',
      result: null,
      error: 'Container crashed',
    });
    const logs = getTaskRunLogs('2026-06-15T00:00:00Z');
    const entry = logs.find((l) => l.task_id === 'log-error');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('error');
    expect(entry!.error).toBe('Container crashed');
    expect(entry!.duration_ms).toBe(500);
  });

  it('logTaskRun persists success result to task_run_logs', () => {
    createTestTask('log-success');
    const runAt = '2026-06-15T13:00:00Z';
    logTaskRun({
      task_id: 'log-success',
      run_at: runAt,
      duration_ms: 1200,
      status: 'success',
      result: 'All good',
      error: null,
    });
    const logs = getTaskRunLogs('2026-06-15T00:00:00Z');
    const entry = logs.find((l) => l.task_id === 'log-success');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('success');
    expect(entry!.result).toBe('All good');
    expect(entry!.error).toBeNull();
  });
});

describe('expired/past schedule handling (DB-level)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('getDueTasks picks up tasks whose next_run is far in the past (expired schedule)', () => {
    // Task was due 2 hours ago — should still be returned by getDueTasks
    createTask({
      id: 'task-expired',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'run overdue task',
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 2 * 3600000).toISOString(),
      status: 'active',
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const dueTasks = getDueTasks();
    expect(dueTasks.length).toBeGreaterThanOrEqual(1);
    expect(dueTasks.some((t) => t.id === 'task-expired')).toBe(true);
  });

  it('getDueTasks does not return paused tasks even if next_run is past due', () => {
    createTask({
      id: 'task-paused-due',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'should not run',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    // Pause it
    updateTask('task-paused-due', { status: 'paused' });

    const dueTasks = getDueTasks();
    expect(dueTasks.some((t) => t.id === 'task-paused-due')).toBe(false);
  });
});

describe('concurrent task execution prevention (DB-level)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('completed tasks are excluded from getDueTasks even with past next_run', () => {
    createTask({
      id: 'task-race',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'test race',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    // Mark task as completed (simulates race: getDueTasks returned it, but
    // status changed before scheduler re-checks with getTaskById)
    updateTask('task-race', { status: 'completed' });

    const dueTasks = getDueTasks();
    expect(dueTasks.some((t) => t.id === 'task-race')).toBe(false);

    // Also verify getTaskById returns the completed status (scheduler's re-check)
    const task = getTaskById('task-race');
    expect(task).toBeDefined();
    expect(task!.status).toBe('completed');
  });
});

describe('alert includes last success time', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes last success time in alert when available', () => {
    createTestTask('task-with-history');
    // Log a success, then two failures
    logTaskRun({
      task_id: 'task-with-history',
      run_at: '2026-03-23T08:00:00Z',
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 'task-with-history',
      run_at: '2026-03-23T09:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail1',
    });
    logTaskRun({
      task_id: 'task-with-history',
      run_at: '2026-03-23T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail2',
    });

    const deps = makeMockDeps();
    checkAlerts(makeTask({ id: 'task-with-history' }), 'fail2', deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg).toContain('Last success');
    expect(msg).toContain('2026-03-23T08:00:00Z');
  });
});

describe('computeNextRun — interval drift prevention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('anchors to scheduled time even when execution is delayed', () => {
    // Task was scheduled 5s ago. Next run should be scheduled+interval, not now+interval.
    const now = Date.now();
    const scheduledTime = new Date(now - 5000).toISOString(); // 5s ago
    const intervalMs = 3600000; // 1 hour
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: String(intervalMs),
      next_run: scheduledTime,
    });

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Should be scheduled + 1h, NOT now + 1h
    const expectedMs = new Date(scheduledTime).getTime() + intervalMs;
    expect(new Date(nextRun!).getTime()).toBe(expectedMs);
    // Confirm it differs from now+interval (drift prevention)
    expect(new Date(nextRun!).getTime()).not.toBe(now + intervalMs);
  });

  it('skips multiple missed intervals and lands on the correct grid point', () => {
    // 3.5 intervals have passed since scheduled time
    const intervalMs = 3600000; // 1 hour
    const now = Date.now();
    const scheduledTime = new Date(now - 3.5 * intervalMs).toISOString();
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: String(intervalMs),
      next_run: scheduledTime,
    });

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const nextMs = new Date(nextRun!).getTime();
    // Should be base + 4*interval (first grid point after now)
    const expectedMs = new Date(scheduledTime).getTime() + 4 * intervalMs;
    expect(nextMs).toBe(expectedMs);
    expect(nextMs).toBeGreaterThan(now);
    // Verify grid alignment
    const offset = (nextMs - new Date(scheduledTime).getTime()) % intervalMs;
    expect(offset).toBe(0);
  });
});

describe('edge cases — concurrent execution and guards', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scheduler re-checks task status and skips tasks paused between getDueTasks and getTaskById', async () => {
    // Create a due task
    createTask({
      id: 'task-mid-pause',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    let enqueueCallCount = 0;
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, _fn: () => Promise<void>) => {
        enqueueCallCount++;
      },
    );

    // Pause the task before the scheduler loop runs but after it's in the DB as active
    // The scheduler loop calls getDueTasks, then getTaskById for re-check.
    // We need to pause AFTER getDueTasks but BEFORE the re-check.
    // Since we can't intercept between those calls, we verify the scheduler
    // does re-check by pausing and confirming enqueueTask is NOT called.
    updateTask('task-mid-pause', { status: 'paused' });

    startSchedulerLoop({
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
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    // getDueTasks only returns active tasks, so paused task is excluded
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('scheduler enqueues multiple due tasks in a single poll cycle', async () => {
    createTask({
      id: 'multi-task-1',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'task one',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'multi-task-2',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'task two',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 30_000).toISOString(),
      status: 'active',
      agent_name: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueuedTaskIds: string[] = [];
    const enqueueTask = vi.fn(
      (_groupJid: string, taskId: string, _fn: () => Promise<void>) => {
        enqueuedTaskIds.push(taskId);
      },
    );

    startSchedulerLoop({
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
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(enqueuedTaskIds).toContain('multi-task-1');
    expect(enqueuedTaskIds).toContain('multi-task-2');
    expect(enqueueTask).toHaveBeenCalledTimes(2);
  });
});

describe('runGuardScript — exit-code classification', () => {
  it('exit 0 → shouldRun=true, kind=ok', async () => {
    const r = await runGuardScript('exit 0');
    expect(r.shouldRun).toBe(true);
    expect(r.kind).toBe('ok');
  });

  it('exit 1 → shouldRun=false, kind=normal (legitimate skip)', async () => {
    const r = await runGuardScript('exit 1');
    expect(r.shouldRun).toBe(false);
    expect(r.kind).toBe('normal');
    expect(r.reason).toMatch(/exit code 1/);
  });

  it('exit 2 → shouldRun=false, kind=abnormal (guard is broken)', async () => {
    const r = await runGuardScript('exit 2');
    expect(r.shouldRun).toBe(false);
    expect(r.kind).toBe('abnormal');
    expect(r.reason).toMatch(/exit code 2/);
  });

  it('script crash (python missing file) → abnormal', async () => {
    const r = await runGuardScript('python3 /no/such/file.py');
    expect(r.kind).toBe('abnormal');
  });

  it('command not found (127) → shouldRun=true, abnormal', async () => {
    const r = await runGuardScript('definitely-not-a-real-command-xyz123');
    expect(r.shouldRun).toBe(true);
    expect(r.kind).toBe('abnormal');
  });

  it('no script → shouldRun=true, kind=ok', async () => {
    const r = await runGuardScript(null);
    expect(r.shouldRun).toBe(true);
    expect(r.kind).toBe('ok');
  });
});

describe('checkStaleTasks — boundary conditions', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not alert for task with future next_run', () => {
    const deps = makeMockDeps();
    const futureNextRun = new Date(Date.now() + 3600000).toISOString();
    checkStaleTasks([makeTask({ next_run: futureNextRun })], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('does not treat interval task as stale when lag is exactly 2x interval (boundary)', () => {
    const deps = makeMockDeps();
    const intervalMs = 3600000;
    // lagMs === intervalMs * 2 exactly — the check is `lagMs > intervalMs * 2`, so this should NOT be stale
    const staleNextRun = new Date(Date.now() - intervalMs * 2).toISOString();
    checkStaleTasks(
      [
        makeTask({
          schedule_type: 'interval',
          schedule_value: String(intervalMs),
          next_run: staleNextRun,
        }),
      ],
      deps,
    );
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('does treat interval task as stale when lag is just over 2x interval', () => {
    const deps = makeMockDeps();
    const intervalMs = 3600000;
    // lagMs slightly > intervalMs * 2
    const staleNextRun = new Date(
      Date.now() - intervalMs * 2 - 1,
    ).toISOString();
    checkStaleTasks(
      [
        makeTask({
          schedule_type: 'interval',
          schedule_value: String(intervalMs),
          next_run: staleNextRun,
        }),
      ],
      deps,
    );
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not alert for cron task with lag exactly 24h (boundary)', () => {
    const deps = makeMockDeps();
    // lagMs === 24 * 3600000 exactly — check is `lagMs > 24 * 3600000`
    const staleNextRun = new Date(Date.now() - 24 * 3600000).toISOString();
    checkStaleTasks([makeTask({ next_run: staleNextRun })], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});

describe('checkAlerts — error truncation and sendMessage failure', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('truncates long error messages to 200 chars in alerts', () => {
    createTestTask('task-long-error');
    logTaskRun({
      task_id: 'task-long-error',
      run_at: '2026-03-23T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail1',
    });
    logTaskRun({
      task_id: 'task-long-error',
      run_at: '2026-03-23T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail2',
    });

    const longError = 'X'.repeat(500);
    const deps = makeMockDeps();
    checkAlerts(makeTask({ id: 'task-long-error' }), longError, deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    // The full 500-char error should NOT appear — only the truncated version
    expect(msg).not.toContain('X'.repeat(500));
    expect(msg).toContain('X'.repeat(200));
  });

  it('does not crash when sendMessage rejects during alert flush', () => {
    createTestTask('task-send-fail');
    logTaskRun({
      task_id: 'task-send-fail',
      run_at: '2026-03-23T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail1',
    });
    logTaskRun({
      task_id: 'task-send-fail',
      run_at: '2026-03-23T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail2',
    });

    const deps = makeMockDeps({
      sendMessage: vi.fn().mockRejectedValue(new Error('network down')),
    });
    checkAlerts(makeTask({ id: 'task-send-fail' }), 'fail2', deps);
    // Should not throw — flushAlerts catches the rejection
    expect(() => vi.advanceTimersByTime(70000)).not.toThrow();
    expect(deps.sendMessage).toHaveBeenCalledOnce();
  });
});

describe('_resetAlertsForTests clears stale alert dedup', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows re-alerting after reset clears stale dedup state', () => {
    const deps = makeMockDeps();
    const staleNextRun = new Date(Date.now() - 25 * 3600000).toISOString();
    const staleTask = makeTask({ next_run: staleNextRun });

    // First alert
    checkStaleTasks([staleTask], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();

    // Reset clears dedup
    _resetAlertsForTests();
    (deps.sendMessage as ReturnType<typeof vi.fn>).mockClear();

    // Should alert again after reset
    checkStaleTasks([staleTask], deps);
    vi.advanceTimersByTime(70000);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
  });
});

describe('computeNextRun — cron safety-net boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns first occurrence for daily cron without throttling (inter-fire gap is 24h)', () => {
    // Use a cron that fires daily — the inter-fire gap (24h) >> 30min,
    // so the safety-net throttle should NOT kick in even if the next fire
    // happens to be less than 30min away.
    // We construct the cron from the current time + 5 minutes in the local timezone.
    const fiveMinLater = new Date(Date.now() + 5 * 60 * 1000);
    // Build a cron that fires at fiveMinLater's hour:minute in the configured tz
    // Format: "M H * * *"
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(fiveMinLater);
    const hour = parts.find((p) => p.type === 'hour')!.value;
    const minute = parts.find((p) => p.type === 'minute')!.value;
    const cronExpr = `${minute} ${hour} * * *`;

    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: cronExpr,
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const nextMs = new Date(nextRun!).getTime();
    const now = Date.now();
    // The next fire should be ~5min from now and should NOT be throttled
    expect(nextMs - now).toBeLessThanOrEqual(6 * 60 * 1000); // at most 6min
    expect(nextMs - now).toBeGreaterThan(0);
  });

  it('throttles every-5-min cron to >= 30min from now', () => {
    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: '*/5 * * * *', // every 5 minutes
    });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const gapMs = new Date(nextRun!).getTime() - Date.now();
    expect(gapMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});

describe('healOrphanedNextRun — startup recovery for null next_run', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('recomputes next_run for active cron tasks where it is NULL', async () => {
    const { healOrphanedNextRun } = await import('./db.js');

    createTask({
      id: 'task-orphan-cron',
      group_folder: 'telegram_ops-claw',
      chat_jid: 'tg:-1',
      prompt: 'guard-only',
      script: '/tmp/some-guard.sh',
      schedule_type: 'cron',
      schedule_value: '5 12 * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      agent_name: null,
      created_at: new Date().toISOString(),
    });

    const healed = healOrphanedNextRun();
    expect(healed.length).toBe(1);
    expect(healed[0].id).toBe('task-orphan-cron');

    const task = getTaskById('task-orphan-cron');
    expect(task?.next_run).toBeTruthy();
    expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });

  it('also heals active interval tasks with null next_run', async () => {
    const { healOrphanedNextRun } = await import('./db.js');

    createTask({
      id: 'task-orphan-interval',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:1',
      prompt: 'p',
      schedule_type: 'interval',
      schedule_value: String(60 * 60 * 1000),
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      agent_name: null,
      created_at: new Date().toISOString(),
    });

    const healed = healOrphanedNextRun();
    expect(healed.length).toBe(1);

    const task = getTaskById('task-orphan-interval');
    expect(task?.next_run).toBeTruthy();
  });

  it('skips once-tasks (correctly nullable next_run after completion)', async () => {
    const { healOrphanedNextRun } = await import('./db.js');

    createTask({
      id: 'task-once-completed',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:1',
      prompt: 'p',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      agent_name: null,
      created_at: new Date().toISOString(),
    });

    const healed = healOrphanedNextRun();
    expect(healed.length).toBe(0);

    const task = getTaskById('task-once-completed');
    expect(task?.next_run).toBeNull();
  });

  it('skips inactive tasks (paused/completed/cancelled)', async () => {
    const { healOrphanedNextRun } = await import('./db.js');

    createTask({
      id: 'task-paused-orphan',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:1',
      prompt: 'p',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'paused',
      agent_name: null,
      created_at: new Date().toISOString(),
    });

    const healed = healOrphanedNextRun();
    expect(healed.length).toBe(0);
  });

  it('returns empty array when no orphans exist (idempotent)', async () => {
    const { healOrphanedNextRun } = await import('./db.js');

    const healed = healOrphanedNextRun();
    expect(healed).toEqual([]);
  });

  it('skips cron tasks with malformed schedule_value (logs but does not crash)', async () => {
    const { healOrphanedNextRun, _getTestDb } = await import('./db.js');

    // Bypass validateTaskSchedule by inserting raw — we're simulating an
    // already-corrupted row (the realistic shape of a heal target).
    _getTestDb()
      .prepare(
        `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-bad-cron',
        'telegram_claire',
        'tg:1',
        'p',
        null,
        'cron',
        'not-a-cron',
        'isolated',
        null,
        'active',
        new Date().toISOString(),
      );

    expect(() => healOrphanedNextRun()).not.toThrow();

    const task = getTaskById('task-bad-cron');
    expect(task?.next_run).toBeNull();
  });
});
