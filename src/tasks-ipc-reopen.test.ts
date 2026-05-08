import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { _initTestDatabase, _closeDatabase, _getTestDb } from './db.js';
import { addTask, reopenTask } from './tasks.js';
import { handleTasksIpc } from './tasks-ipc.js';

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

    const result = reopenTask({
      id: taskId,
      reason: 'false alarm',
      callerGroup: 'telegram_claire',
      callerIsMain: true,
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe('open');

    // Verify DB state directly
    const row = _getTestDb()
      .query('SELECT status, completed_at, context FROM tasks WHERE id=?')
      .get(taskId) as
      | { status: string; completed_at: string | null; context: string }
      | undefined;

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

    reopenTask({
      id: taskId,
      reason: 'retry',
      callerGroup: 'telegram_claire',
      callerIsMain: true,
    });

    const row = _getTestDb()
      .query('SELECT context FROM tasks WHERE id=?')
      .get(taskId) as { context: string };

    expect(row.context).toBe('[closed: original]\n[reopened: retry]');
  });

  it('returns error when task is already open', () => {
    const added = addTask({ title: 'Already open', source: 'manual' });
    const taskId = added.id!;

    const result = reopenTask({
      id: taskId,
      reason: 'try reopen',
      callerGroup: 'telegram_claire',
      callerIsMain: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already open/);
  });

  it('returns error when task id does not exist', () => {
    const result = reopenTask({
      id: 99999,
      reason: 'ghost',
      callerGroup: 'telegram_claire',
      callerIsMain: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('auth: main caller can reopen any group task', () => {
    const added = addTask({
      title: 'Lab task',
      source: 'manual',
      group_folder: 'telegram_lab-claw',
    });
    expect(added.success).toBe(true);
    const taskId = added.id!;

    _getTestDb()
      .query(
        "UPDATE tasks SET status='done', completed_at=datetime('now') WHERE id=?",
      )
      .run(taskId);

    const result = reopenTask({
      id: taskId,
      reason: 'main override',
      callerGroup: 'telegram_claire',
      callerIsMain: true,
    });
    expect(result.success).toBe(true);
  });

  it('auth: same-group caller can reopen its own task', () => {
    const added = addTask({
      title: 'Lab task 2',
      source: 'manual',
      group_folder: 'telegram_lab-claw',
    });
    expect(added.success).toBe(true);
    const taskId = added.id!;

    _getTestDb()
      .query(
        "UPDATE tasks SET status='done', completed_at=datetime('now') WHERE id=?",
      )
      .run(taskId);

    const result = reopenTask({
      id: taskId,
      reason: 'same group',
      callerGroup: 'telegram_lab-claw',
      callerIsMain: false,
    });
    expect(result.success).toBe(true);
  });

  it('auth: cross-group caller is rejected and task remains done', () => {
    const added = addTask({
      title: 'Lab task 3',
      source: 'manual',
      group_folder: 'telegram_lab-claw',
    });
    expect(added.success).toBe(true);
    const taskId = added.id!;

    _getTestDb()
      .query(
        "UPDATE tasks SET status='done', completed_at=datetime('now') WHERE id=?",
      )
      .run(taskId);

    const result = reopenTask({
      id: taskId,
      reason: 'cross group',
      callerGroup: 'telegram_other',
      callerIsMain: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authorized/);

    // Task must remain done
    const row = _getTestDb()
      .query('SELECT status FROM tasks WHERE id=?')
      .get(taskId) as { status: string } | undefined;
    expect(row!.status).toBe('done');
  });
});

describe('handleTasksIpc — task_reopen', () => {
  let dataDir: string;

  beforeEach(() => {
    _initTestDatabase();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-ipc-reopen-'));
  });
  afterEach(() => {
    _closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('success path: reopens a closed task and writes result file', async () => {
    // Add a task and mark it done directly
    const added = addTask({ title: 'Close me via IPC', source: 'manual' });
    expect(added.success).toBe(true);
    const id = added.id!;

    _getTestDb()
      .query(
        "UPDATE tasks SET status='done', completed_at=datetime('now'), context='[closed: test]' WHERE id=?",
      )
      .run(id);

    const handled = await handleTasksIpc(
      {
        type: 'task_reopen',
        requestId: 'req-test-1',
        id,
        reason: 'wrong thread',
      },
      'telegram_claire',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const resultFile = path.join(
      dataDir,
      'ipc',
      'telegram_claire',
      'task_results',
      'req-test-1.json',
    );
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(result.success).toBe(true);
    expect(result.id).toBe(id);
  });

  it('malformed requestId: dropped (handled=true) and IPC dir not created', async () => {
    const handled = await handleTasksIpc(
      { type: 'task_reopen', requestId: '../escape', id: 1, reason: 'test' },
      'telegram_claire',
      true,
      dataDir,
    );
    expect(handled).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'ipc'))).toBe(false);
  });

  it('validation error: negative id writes result file with expected error', async () => {
    const handled = await handleTasksIpc(
      { type: 'task_reopen', requestId: 'req-validate-1', id: -1, reason: 'x' },
      'telegram_claire',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const resultFile = path.join(
      dataDir,
      'ipc',
      'telegram_claire',
      'task_results',
      'req-validate-1.json',
    );
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({
      success: false,
      error: 'id must be a positive integer',
    });
  });
});
