import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { _initTestDatabase, _closeDatabase } from './db.js';
import { handleTasksIpc } from './tasks-ipc.js';

let tmpDir: string;

function readResult(
  groupFolder: string,
  requestId: string,
): Record<string, unknown> {
  const p = path.join(
    tmpDir,
    'ipc',
    groupFolder,
    'task_results',
    `${requestId}.json`,
  );
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('handleTasksIpc', () => {
  beforeEach(() => {
    _initTestDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-ipc-'));
  });
  afterEach(() => {
    _closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false for non-task_* types', async () => {
    const handled = await handleTasksIpc(
      { type: 'unrelated', requestId: 'r1' },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(handled).toBe(false);
  });

  it('drops request with invalid requestId and still reports handled', async () => {
    const handled = await handleTasksIpc(
      { type: 'task_list', requestId: '../bad' },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(handled).toBe(true);
    // No result file should be written.
    const resultsDir = path.join(
      tmpDir,
      'ipc',
      'telegram_claire',
      'task_results',
    );
    expect(fs.existsSync(resultsDir)).toBe(false);
  });

  it('task_add writes success result and stamps caller group_folder', async () => {
    await handleTasksIpc(
      { type: 'task_add', requestId: 'add-1', title: 'From IPC' },
      'telegram_lab-claw',
      false,
      tmpDir,
    );
    const r = readResult('telegram_lab-claw', 'add-1');
    expect(r.success).toBe(true);
    expect(r.id).toBeTypeOf('number');

    // Verify stamped group_folder via task_list without filter
    await handleTasksIpc(
      { type: 'task_list', requestId: 'list-1' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const list = readResult('telegram_claire', 'list-1') as {
      tasks: Array<{ title: string; group_folder: string | null }>;
    };
    expect(list.tasks[0].title).toBe('From IPC');
    expect(list.tasks[0].group_folder).toBe('telegram_lab-claw');
  });

  it('non-main task_add cannot stamp foreign group_folder', async () => {
    // home-claw tries to plant a task attributed to lab-claw — the handler
    // must ignore the payload and stamp home-claw's own sourceGroup instead.
    await handleTasksIpc(
      {
        type: 'task_add',
        requestId: 'spoof-1',
        title: 'Spoof attempt',
        group_folder: 'telegram_lab-claw',
      },
      'telegram_home-claw',
      false,
      tmpDir,
    );
    const r = readResult('telegram_home-claw', 'spoof-1');
    expect(r.success).toBe(true);

    await handleTasksIpc(
      { type: 'task_list', requestId: 'spoof-list' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const list = readResult('telegram_claire', 'spoof-list') as {
      tasks: Array<{ title: string; group_folder: string | null }>;
    };
    const row = list.tasks.find((t) => t.title === 'Spoof attempt')!;
    expect(row.group_folder).toBe('telegram_home-claw');
  });

  it('main task_add may stamp any group_folder', async () => {
    await handleTasksIpc(
      {
        type: 'task_add',
        requestId: 'main-stamp',
        title: 'Main-stamped lab task',
        group_folder: 'telegram_lab-claw',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    const r = readResult('telegram_claire', 'main-stamp');
    expect(r.success).toBe(true);

    await handleTasksIpc(
      { type: 'task_list', requestId: 'main-list' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const list = readResult('telegram_claire', 'main-list') as {
      tasks: Array<{ title: string; group_folder: string | null }>;
    };
    const row = list.tasks.find((t) => t.title === 'Main-stamped lab task')!;
    expect(row.group_folder).toBe('telegram_lab-claw');
  });

  it('task_list response includes truncated flag', async () => {
    for (let i = 0; i < 3; i++) {
      await handleTasksIpc(
        {
          type: 'task_add',
          requestId: `fill-${i}`,
          title: `Row ${i}`,
        },
        'telegram_claire',
        true,
        tmpDir,
      );
    }
    await handleTasksIpc(
      { type: 'task_list', requestId: 'trunc', limit: 2 },
      'telegram_claire',
      true,
      tmpDir,
    );
    const r = readResult('telegram_claire', 'trunc') as {
      tasks: unknown[];
      count: number;
      truncated: boolean;
      limit: number;
    };
    expect(r.count).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.limit).toBe(2);
  });

  it('task_add with group_folder="" produces a global task (NULL)', async () => {
    await handleTasksIpc(
      {
        type: 'task_add',
        requestId: 'add-global',
        title: 'Global',
        group_folder: '',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    await handleTasksIpc(
      { type: 'task_list', requestId: 'list-global' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const list = readResult('telegram_claire', 'list-global') as {
      tasks: Array<{ group_folder: string | null }>;
    };
    expect(list.tasks[0].group_folder).toBeNull();
  });

  it('task_close enforces group_folder auth via IPC caller', async () => {
    // Create a task scoped to lab-claw
    await handleTasksIpc(
      { type: 'task_add', requestId: 'add-2', title: 'Lab task' },
      'telegram_lab-claw',
      false,
      tmpDir,
    );
    const added = readResult('telegram_lab-claw', 'add-2') as { id: number };

    // code-claw tries to close → denied
    await handleTasksIpc(
      {
        type: 'task_close',
        requestId: 'close-deny',
        id: added.id,
        outcome: 'done',
      },
      'telegram_code-claw',
      false,
      tmpDir,
    );
    const denied = readResult('telegram_code-claw', 'close-deny');
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/not authorized/);

    // main closes → allowed
    await handleTasksIpc(
      {
        type: 'task_close',
        requestId: 'close-ok',
        id: added.id,
        outcome: 'done',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    const ok = readResult('telegram_claire', 'close-ok');
    expect(ok.success).toBe(true);
  });
});
