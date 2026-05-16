import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb, _initTestDatabase } from '../db.js';
import {
  TaskOutcomeWatcher,
  markStaleTaskOutcomesEmitted,
} from './task-outcome-watcher.js';

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

  // Regression: 2026-05-16 storm.
  // When surface_outputs is flipped to 1 on a task that has accumulated months
  // of historical successful logs (outcome_emitted=0), the watcher previously
  // dumped 100 events per tick into the event router, which fanned out to
  // Ollama and produced an AbortError storm. The watcher must only emit
  // outcomes for *recently completed* runs — stale rows must be ignored.
  it('does not emit run_at older than the recency horizon (storm guard)', () => {
    const db = getDb();
    const now = Date.now();
    const old = new Date(now - 25 * 3600_000).toISOString(); // 25h ago
    const recent = new Date(now - 60_000).toISOString(); // 1 min ago

    // Seed 500 historical rows — same shape as the live 1953-row backlog.
    const ins = db.prepare(
      `INSERT INTO task_run_logs
        (task_id, run_at, duration_ms, status, result, error, outcome_emitted)
        VALUES (?, ?, 100, 'success', 'historical output', NULL, 0)`,
    );
    for (let i = 0; i < 500; i++) ins.run('task-a', old);
    // One fresh row that SHOULD still emit.
    ins.run('task-a', recent);

    const emit = vi.fn();
    const w = new TaskOutcomeWatcher({ onEvent: emit });
    w.poll();

    // Only the fresh row may emit — the 500 stale ones must be ignored.
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0][0];
    expect(payload.timestamp).toBe(recent);
  });

  it('markStaleTaskOutcomesEmitted neutralizes pre-existing backlog', () => {
    const db = getDb();
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    const ins = db.prepare(
      `INSERT INTO task_run_logs
        (task_id, run_at, duration_ms, status, result, error, outcome_emitted)
        VALUES (?, ?, 100, 'success', 'old', NULL, 0)`,
    );
    for (let i = 0; i < 50; i++) ins.run('task-a', old);
    // A fresh row should NOT be touched by the migration.
    const recent = new Date(Date.now() - 60_000).toISOString();
    ins.run('task-a', recent);

    const updated = markStaleTaskOutcomesEmitted();
    expect(updated).toBe(50);

    const remainingStale = db
      .prepare(
        `SELECT COUNT(*) AS c FROM task_run_logs
         WHERE outcome_emitted = 0 AND run_at < ?`,
      )
      .get(new Date(Date.now() - 24 * 3600_000).toISOString()) as { c: number };
    expect(remainingStale.c).toBe(0);

    const freshUntouched = db
      .prepare(
        `SELECT outcome_emitted AS e FROM task_run_logs WHERE run_at = ?`,
      )
      .get(recent) as { e: number };
    expect(freshUntouched.e).toBe(0);
  });

  it('is idempotent: second migration call updates zero rows', () => {
    const db = getDb();
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    db.prepare(
      `INSERT INTO task_run_logs
        (task_id, run_at, duration_ms, status, result, error, outcome_emitted)
        VALUES (?, ?, 100, 'success', 'old', NULL, 0)`,
    ).run('task-a', old);

    expect(markStaleTaskOutcomesEmitted()).toBe(1);
    expect(markStaleTaskOutcomesEmitted()).toBe(0);
  });
});
