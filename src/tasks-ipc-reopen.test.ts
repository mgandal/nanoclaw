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

describe('handleTasksIpc — task_reopen writes cooling-off event', () => {
  let dataDir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    _initTestDatabase();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskreopen-cool-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskreopen-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    _closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('appends a reopened event to task-closures.jsonl on success', async () => {
    const add = addTask({ title: 'Cool me off', source: 'manual' });
    expect(add.success).toBe(true);
    _getTestDb()
      .query("UPDATE tasks SET status='done', completed_at=datetime('now') WHERE id=?")
      .run(add.id!);

    await handleTasksIpc(
      {
        type: 'task_reopen',
        requestId: 'req-cool-1',
        id: add.id!,
        reason: 'morning digest dispute',
      },
      'telegram_claire',
      true,
      dataDir,
    );

    const jsonlPath = path.join(homeDir, '.cache', 'email-ingest', 'task-closures.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(event.action).toBe('reopened');
    expect(event.task_id).toBe(add.id);
    expect(event.reason).toBe('morning digest dispute');
    expect(event.feedback_source).toBe('agent');
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('does not write a reopened event when reopen fails (already open)', async () => {
    const add = addTask({ title: 'Already open cool', source: 'manual' });
    expect(add.success).toBe(true);

    await handleTasksIpc(
      {
        type: 'task_reopen',
        requestId: 'req-cool-2',
        id: add.id!,
        reason: 'should not write',
      },
      'telegram_claire',
      true,
      dataDir,
    );

    const jsonlPath = path.join(homeDir, '.cache', 'email-ingest', 'task-closures.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });
});
