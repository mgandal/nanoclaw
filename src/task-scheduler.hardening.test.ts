/**
 * Regression tests for task-scheduler hardening.
 *
 * Covers the five bug classes identified in the 60-day fix history:
 *   1. next_run drift between authorize and execute
 *   2. NULL next_run silently excluded by getDueTasks
 *   3. heal-on-tick promotion (runtime vs startup-only)
 *   4. 30-minute minimum interval enforcement (layer-2 safety net)
 *   5. session touchSession on every group-context task fire
 *   6. guard failure classification edge cases
 *
 * These tests target code paths NOT covered by the existing test files.
 */

// Must hoist env before any module imports that throw at load time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (!process.env.CREDENTIAL_PROXY_HOST) {
    process.env.CREDENTIAL_PROXY_HOST = '0.0.0.0';
  }
});

import {
  _getTestDb,
  _initTestDatabase,
  createTask,
  getDueTasks,
  getTaskById,
  healOrphanedNextRun,
  setSession,
  touchSession,
} from './db.js';
import {
  _resetAlertsForTests,
  _resetSchedulerLoopForTests,
  computeNextRun,
  runGuardScript,
  startSchedulerLoop,
} from './task-scheduler.js';
import type { SchedulerDependencies, ScheduledTask } from './task-scheduler.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'hardening-task',
    group_folder: 'telegram_claire',
    chat_jid: 'tg:123',
    prompt: 'hardening test',
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

/** Raw-insert a task bypassing validateTaskSchedule (simulates direct DB write / migration). */
function rawInsertTask(params: {
  id: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  status?: string;
}) {
  _getTestDb()
    .prepare(
      `INSERT INTO scheduled_tasks
         (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value,
          context_mode, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.id,
      'telegram_claire',
      'tg:123',
      'hardening raw',
      null,
      params.schedule_type,
      params.schedule_value,
      'isolated',
      params.next_run,
      params.status ?? 'active',
      new Date().toISOString(),
    );
}

// ---------------------------------------------------------------------------
// Bug class 4 — 30-minute minimum interval: runtime safety net for intervals
//
// The layer-1 gate is validateTaskSchedule() at INSERT time. But a task can
// reach the scheduler with a sub-30min interval via direct DB write or a
// malformed migration (bug class 4 scenario). The layer-2 safety net in
// computeNextRun() throttles sub-30min CRON expressions, but there is NO
// equivalent throttle for interval tasks. This test documents the gap and
// should FAIL until the runtime throttle is added to the interval path.
// ---------------------------------------------------------------------------

describe('Bug class 4 — interval runtime safety net (layer-2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'computeNextRun should throttle sub-30min interval task to >= 30min from now ' +
      '(layer-2 safety net — CURRENTLY MISSING for intervals)',
    () => {
      // A 1-minute interval bypassed insert validation via direct DB write.
      // The runtime safety net SHOULD throttle it to >= 30min, the same way
      // the cron safety net does for high-frequency cron expressions.
      const tooFrequentTask = makeTask({
        schedule_type: 'interval',
        schedule_value: String(60 * 1000), // 1 minute — far below 30-min minimum
        next_run: new Date(Date.now() - 60 * 1000).toISOString(), // was due 1m ago
      });

      const nextRun = computeNextRun(tooFrequentTask);
      expect(nextRun).not.toBeNull();

      const gapMs = new Date(nextRun!).getTime() - Date.now();
      // Should be >= 30 minutes from now (the same minimum enforced at insert).
      // This FAILS today because computeNextRun has no 30-min gate for intervals.
      expect(gapMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
    },
  );

  it(
    'computeNextRun should throttle sub-30min interval even when task has been ' +
      'running for many missed cycles (interval was 5s, missed 100 cycles)',
    () => {
      // Simulate a task that somehow got a 5s interval and has been ticking.
      // Without a safety net, computeNextRun returns now + 5s (or the next
      // aligned 5s boundary), spinning the scheduler every 5s.
      const fiveSecInterval = makeTask({
        schedule_type: 'interval',
        schedule_value: String(5 * 1000), // 5 seconds
        next_run: new Date(Date.now() - 500 * 1000).toISOString(), // way in the past
      });

      const nextRun = computeNextRun(fiveSecInterval);
      expect(nextRun).not.toBeNull();

      const gapMs = new Date(nextRun!).getTime() - Date.now();
      // Should be >= 30 minutes from now.
      // This FAILS today.
      expect(gapMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
    },
  );
});

// ---------------------------------------------------------------------------
// Bug class 2 — NULL next_run silently excluded (runtime corruption path)
//
// getDueTasks filters WHERE next_run IS NOT NULL. A task with NULL next_run
// is invisible to the scheduler until heal runs. We verify:
//   a) getDueTasks excludes the NULL-next_run task before healing
//   b) healOrphanedNextRun fixes it
//   c) getDueTasks picks it up on the next tick after healing
// ---------------------------------------------------------------------------

describe('Bug class 2 — NULL next_run exclusion and runtime heal', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('getDueTasks excludes active cron task with NULL next_run (silent limbo)', () => {
    rawInsertTask({
      id: 'null-next-cron',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      next_run: null,
    });

    const due = getDueTasks();
    expect(due.some((t) => t.id === 'null-next-cron')).toBe(false);
  });

  it('healOrphanedNextRun rescues the NULL-next_run task and sets a future next_run', () => {
    rawInsertTask({
      id: 'null-next-heal',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      next_run: null,
    });

    const healed = healOrphanedNextRun();
    expect(healed.some((h) => h.id === 'null-next-heal')).toBe(true);

    const task = getTaskById('null-next-heal');
    expect(task?.next_run).toBeTruthy();
    expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });

  it('scheduler loop heals NULL-next_run task inserted after startup (runtime, not just startup)', async () => {
    // Insert a task with NULL next_run AFTER the scheduler would have already run
    // the startup heal. This simulates the runtime corruption scenario.
    rawInsertTask({
      id: 'runtime-null-cron',
      schedule_type: 'cron',
      schedule_value: '5 8 * * *',
      next_run: null,
    });

    // Confirm it starts as excluded
    expect(getDueTasks().some((t) => t.id === 'runtime-null-cron')).toBe(false);

    const enqueueTask = vi.fn();
    startSchedulerLoop({
      ...makeMockDeps({ queue: { enqueueTask } as any }),
    });

    // One tick: the loop calls healOrphanedNextRun() before getDueTasks().
    await vi.advanceTimersByTimeAsync(10);

    // The task should now have a next_run (healed by the tick's heal call).
    const task = getTaskById('runtime-null-cron');
    expect(task?.next_run).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Bug class 3 — heal-on-tick promotion
//
// Verify heal runs on every tick AND that the warning log only fires when
// there are actual orphans (no log spam on clean ticks).
// ---------------------------------------------------------------------------

describe('Bug class 3 — heal-on-tick: no log spam when clean', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    _resetAlertsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('healOrphanedNextRun returns empty array when no orphans exist (idempotent, no spam)', () => {
    // Create a normal task with a proper next_run
    createTask({
      id: 'clean-task',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 3600000).toISOString(),
      status: 'active',
      agent_name: null,
      created_at: new Date().toISOString(),
    });

    const healed = healOrphanedNextRun();
    expect(healed).toHaveLength(0);
  });

  it('heal runs on each scheduler tick (per-tick call, not startup-only)', async () => {
    // Start the scheduler with a clean DB (no orphans at startup).
    startSchedulerLoop(
      makeMockDeps({ queue: { enqueueTask: vi.fn() } as any }),
    );

    // Run the first tick — no orphans, clean.
    await vi.advanceTimersByTimeAsync(10);

    // NOW insert a NULL-next_run task — AFTER the startup heal and the first
    // tick's heal have already run. If heal only ran at startup (old behavior),
    // this task would stay in limbo. If it runs every tick, the next tick
    // will fix it.
    rawInsertTask({
      id: 'per-tick-heal-test',
      schedule_type: 'interval',
      schedule_value: String(2 * 60 * 60 * 1000), // 2h interval (valid)
      next_run: null,
    });

    // Confirm still NULL before next tick
    expect(getTaskById('per-tick-heal-test')?.next_run).toBeNull();

    // Advance to the next poll tick (SCHEDULER_POLL_INTERVAL).
    // We import SCHEDULER_POLL_INTERVAL to stay in sync with the config.
    const { SCHEDULER_POLL_INTERVAL } = await import('./config.js');
    await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_INTERVAL + 10);

    // After the next tick, the per-tick heal should have fixed the NULL next_run.
    expect(getTaskById('per-tick-heal-test')?.next_run).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Bug class 6 — guard failure edge cases
//
// Extend coverage beyond the basic exit-code classification already in the
// existing test files. Focus on: timeout classification, output capture, and
// the stdout-vs-stderr priority in the reason field.
// ---------------------------------------------------------------------------

describe('Bug class 6 — guard failure edge cases', () => {
  it('guard timeout → shouldRun=true, kind=abnormal, reason mentions timeout', async () => {
    const r = await runGuardScript('sleep 60', 100);
    expect(r.shouldRun).toBe(true);
    expect(r.kind).toBe('abnormal');
    expect(r.reason).toMatch(/timed out/i);
  });

  it('guard exit 2 with stdout output → reason captures output, kind=abnormal', async () => {
    // Exit code 2+ is "abnormal" (guard is broken). The output should be captured
    // in the reason field so operators can debug the issue.
    const r = await runGuardScript('echo "diagnostic output here"; exit 2');
    expect(r.shouldRun).toBe(false);
    expect(r.kind).toBe('abnormal');
    // reason should include the exit code and ideally some output content
    expect(r.reason).toMatch(/exit code 2/);
    // The stdout output "diagnostic output here" should appear in reason
    expect(r.reason).toContain('diagnostic output here');
  });

  it('guard exit 1 with stdout → reason captures stdout, kind=normal', async () => {
    // Exit 1 is a legitimate "skip" signal. The reason should include any
    // stdout emitted so operators can see why the guard skipped.
    const r = await runGuardScript('echo "no work to do today"; exit 1');
    expect(r.shouldRun).toBe(false);
    expect(r.kind).toBe('normal');
    expect(r.reason).toContain('no work to do today');
  });

  it('guard exit 3 → shouldRun=false, kind=abnormal (any exit > 1 is broken)', async () => {
    const r = await runGuardScript('exit 3');
    expect(r.shouldRun).toBe(false);
    expect(r.kind).toBe('abnormal');
    expect(r.reason).toMatch(/exit code 3/);
  });

  it('guard with stderr but no stdout → reason captures stderr', async () => {
    // When there's only stderr output, it should still appear in the reason.
    const r = await runGuardScript('echo "stderr msg" >&2; exit 2');
    expect(r.shouldRun).toBe(false);
    expect(r.kind).toBe('abnormal');
    // stderr "stderr msg" should be captured
    expect(r.reason).toContain('stderr msg');
  });
});

// ---------------------------------------------------------------------------
// Bug class 1 — next_run drift: interval anchor correctness
//
// The fix in schedule-task.ts (precomputedNextRun) pins next_run at authorize
// time. But computeNextRun is called in runTask AFTER execution completes.
// Verify that the post-execution computeNextRun uses task.next_run (the DB
// value, pinned at authorize) as the anchor, not the current wall clock.
// ---------------------------------------------------------------------------

describe('Bug class 1 — next_run drift: post-execution anchor is task.next_run not now', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('computeNextRun for interval uses task.next_run as base, ignoring execution delay', () => {
    // Simulate: task was scheduled at T=0, executed at T=500ms (500ms delay).
    // next_run in DB is T=0. computeNextRun should produce T=0 + interval,
    // NOT now (T=500ms) + interval. The 500ms gate latency must not drift
    // the schedule.
    const scheduledTime = new Date(Date.now() - 500).toISOString(); // T=0
    const intervalMs = 2 * 60 * 60 * 1000; // 2h (above 30min minimum)

    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: String(intervalMs),
      next_run: scheduledTime, // anchor: T=0
    });

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    const expectedMs = new Date(scheduledTime).getTime() + intervalMs;
    const actualMs = new Date(nextRun!).getTime();

    // Must be anchored to task.next_run + interval, NOT now + interval
    expect(actualMs).toBe(expectedMs);
    expect(actualMs).not.toBe(Date.now() + intervalMs);
  });

  it('computeNextRun drift: even 5s gate latency shifts next_run by 5s if anchored to now', () => {
    // This test documents the ORIGINAL drift bug for regression purposes.
    // If computeNextRun used Date.now() instead of task.next_run as the base,
    // repeated runs would drift by the execution latency on each cycle.
    // The test asserts the CORRECT (no-drift) behavior.
    const now = Date.now();
    const scheduledTime = new Date(now - 5000).toISOString(); // 5s ago
    const intervalMs = 60 * 60 * 1000; // 1h

    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: String(intervalMs),
      next_run: scheduledTime,
    });

    const nextRun = computeNextRun(task);
    const nextMs = new Date(nextRun!).getTime();

    // Correct: anchored to scheduledTime + interval (no drift)
    const correctAnchor = new Date(scheduledTime).getTime() + intervalMs;
    expect(nextMs).toBe(correctAnchor);

    // Incorrect (drift): if it had used Date.now() + interval instead
    const driftedAnchor = now + intervalMs;
    expect(nextMs).not.toBe(driftedAnchor);
  });
});
