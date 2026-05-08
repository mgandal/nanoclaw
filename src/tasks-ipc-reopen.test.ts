import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, _closeDatabase, _getTestDb } from './db.js';
import { addTask, reopenTask } from './tasks.js';

describe('reopenTask', () => {
  beforeEach(() => {
    _initTestDatabase();
  });
  afterEach(() => {
    _closeDatabase();
  });

  it('flips a closed task back to open and clears completed_at', () => {
    const added = addTask({ title: 'Close me', source: 'manual' });
    expect(added.success).toBe(true);
    const taskId = added.id!;

    // Mark it done via direct UPDATE (mirrors what closeTask does)
    _getTestDb()
      .query(
        "UPDATE tasks SET status='done', completed_at=datetime('now'), context='[closed: test]' WHERE id=?",
      )
      .run(taskId);

    const result = reopenTask({ id: taskId, reason: 'false alarm' });
    expect(result.success).toBe(true);
    expect(result.status).toBe('open');

    // Verify DB state directly
    const row = _getTestDb()
      .query('SELECT status, completed_at, context FROM tasks WHERE id=?')
      .get(taskId) as { status: string; completed_at: string | null; context: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.status).toBe('open');
    expect(row!.completed_at).toBeNull();
    expect(row!.context).toContain('[reopened: false alarm]');
  });

  it('preserves and appends to existing context with a newline separator', () => {
    const added = addTask({ title: 'Append test', source: 'manual' });
    const taskId = added.id!;

    _getTestDb()
      .query(
        "UPDATE tasks SET status='done', completed_at=datetime('now'), context='[closed: original]' WHERE id=?",
      )
      .run(taskId);

    reopenTask({ id: taskId, reason: 'retry' });

    const row = _getTestDb()
      .query('SELECT context FROM tasks WHERE id=?')
      .get(taskId) as { context: string };

    expect(row.context).toBe('[closed: original]\n[reopened: retry]');
  });

  it('returns error when task is already open', () => {
    const added = addTask({ title: 'Already open', source: 'manual' });
    const taskId = added.id!;

    const result = reopenTask({ id: taskId, reason: 'try reopen' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not closed/);
  });

  it('returns error when task id does not exist', () => {
    const result = reopenTask({ id: 99999, reason: 'ghost' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});
