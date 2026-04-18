import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb, _initTestDatabase } from '../db.js';
import { TaskOutcomeWatcher } from './task-outcome-watcher.js';

beforeEach(() => {
  _initTestDatabase();
  const db = getDb();
  db.prepare('DELETE FROM task_run_logs').run();
  db.prepare('DELETE FROM scheduled_tasks').run();
  // Insert two tasks: task-a has surface_outputs=1, task-b has surface_outputs=0
  db.prepare(
    `INSERT INTO scheduled_tasks
      (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       next_run, last_run, last_result, status, created_at, surface_outputs)
      VALUES (?, ?, ?, ?, 'cron', '0 9 * * *', ?, NULL, NULL, 'active', ?, 1)`,
  ).run(
    'task-a',
    'main',
    'jid',
    'prompt',
    new Date().toISOString(),
    new Date().toISOString(),
  );
  db.prepare(
    `INSERT INTO scheduled_tasks
      (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       next_run, last_run, last_result, status, created_at, surface_outputs)
      VALUES (?, ?, ?, ?, 'cron', '0 9 * * *', ?, NULL, NULL, 'active', ?, 0)`,
  ).run(
    'task-b',
    'main',
    'jid',
    'prompt',
    new Date().toISOString(),
    new Date().toISOString(),
  );
});

describe('TaskOutcomeWatcher', () => {
  it('emits for success with surface_outputs=1', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO task_run_logs
        (task_id, run_at, duration_ms, status, result, error, outcome_emitted)
        VALUES (?, ?, 100, 'success', 'output data', NULL, 0)`,
    ).run('task-a', new Date().toISOString());
    const emit = vi.fn();
    const w = new TaskOutcomeWatcher({ onEvent: emit });
    w.poll();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].type).toBe('task_outcome');
    expect(emit.mock.calls[0][0].payload.taskId).toBe('task-a');
  });

  it('ignores success when surface_outputs=0', () => {
    getDb()
      .prepare(
        `INSERT INTO task_run_logs
        (task_id, run_at, duration_ms, status, result, error, outcome_emitted)
        VALUES (?, ?, 100, 'success', 'output', NULL, 0)`,
      )
      .run('task-b', new Date().toISOString());
    const emit = vi.fn();
    const w = new TaskOutcomeWatcher({ onEvent: emit });
    w.poll();
    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores 'error' status (handled by checkAlerts, not this watcher)", () => {
    getDb()
      .prepare(
        `INSERT INTO task_run_logs
        (task_id, run_at, duration_ms, status, result, error, outcome_emitted)
        VALUES (?, ?, 100, 'error', NULL, 'boom', 0)`,
      )
      .run('task-a', new Date().toISOString());
    const emit = vi.fn();
    const w = new TaskOutcomeWatcher({ onEvent: emit });
    w.poll();
    expect(emit).not.toHaveBeenCalled();
  });

  it('sets outcome_emitted=1 after emit (idempotent on second poll)', () => {
    getDb()
      .prepare(
        `INSERT INTO task_run_logs
        (task_id, run_at, duration_ms, status, result, error, outcome_emitted)
        VALUES (?, ?, 100, 'success', 'output', NULL, 0)`,
      )
      .run('task-a', new Date().toISOString());
    const emit = vi.fn();
    const w = new TaskOutcomeWatcher({ onEvent: emit });
    w.poll();
    w.poll();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('skips empty/whitespace result', () => {
    getDb()
      .prepare(
        `INSERT INTO task_run_logs
        (task_id, run_at, duration_ms, status, result, error, outcome_emitted)
        VALUES (?, ?, 100, 'success', '   ', NULL, 0)`,
      )
      .run('task-a', new Date().toISOString());
    const emit = vi.fn();
    const w = new TaskOutcomeWatcher({ onEvent: emit });
    w.poll();
    expect(emit).not.toHaveBeenCalled();
  });
});
