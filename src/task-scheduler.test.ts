import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById, logTaskRun } from './db.js';
import {
  _resetAlertsForTests,
  _resetSchedulerLoopForTests,
  checkAlerts,
  checkStaleTasks,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';
import type { SchedulerDependencies } from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

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
    const staleNextRun = new Date(
      Date.now() - intervalMs * 3,
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
});
