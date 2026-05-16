import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from '../../db.js';
import { IpcDeps } from '../../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
} from '../handler.js';
import {
  taskAddHandler,
  taskCloseHandler,
  taskListHandler,
  taskReopenHandler,
} from './tasks.js';

/**
 * Per-handler tests for the tasks_* cluster. Heavy lifting (the task-table
 * semantics, group-attribution rules, cooling-off events) is tested
 * separately in src/tasks-ipc.test.ts + src/tasks-ipc-reopen.test.ts via
 * the legacy handleTasksIpc wrapper. Here we focus on the contract
 * surface — that all four register, share `task_results/`, and that
 * skipGate flows correctly: write-actions (add/close/reopen) and the
 * read-action (list) all bypass the gate today (Rule 5 preservation).
 */
describe('tasks_* cluster handlers', () => {
  const SOURCE_GROUP = 'telegram_other';

  let dataDir: string;
  let resultsDir: string;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(taskAddHandler);
    registerIpcHandler(taskListHandler);
    registerIpcHandler(taskCloseHandler);
    registerIpcHandler(taskReopenHandler);

    setRegisteredGroup('tg:main123', {
      name: 'Main',
      folder: 'telegram_main',
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    deps = {
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-handler-test-'));
    // Wire-format-locked path: container reads from `task_results/`
    // (hardcoded at container/agent-runner/src/ipc-mcp-stdio.ts:736).
    resultsDir = path.join(dataDir, 'ipc', SOURCE_GROUP, 'task_results');
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const dispatch = async (
    data: Record<string, unknown>,
    isMain: boolean,
    compoundSource = SOURCE_GROUP,
  ) => {
    const ctx = buildContext(compoundSource, isMain, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const readResult = (requestId: string): Record<string, unknown> | null => {
    const file = path.join(resultsDir, `${requestId}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  };

  it('all four task_* actions share task_results/ (wire-format contract)', async () => {
    // task_add
    await dispatch(
      {
        type: 'task_add',
        requestId: 'req-add',
        title: 'test task',
      },
      true,
      'telegram_main',
    );
    expect(
      fs.existsSync(
        path.join(
          dataDir,
          'ipc',
          'telegram_main',
          'task_results',
          'req-add.json',
        ),
      ),
    ).toBe(true);

    // task_list
    await dispatch({ type: 'task_list', requestId: 'req-list' }, true);
    expect(readResult('req-list')).not.toBeNull();
  });

  it('task_add writes a result file with the new task id', async () => {
    await dispatch(
      {
        type: 'task_add',
        requestId: 'req-add-1',
        title: 'integration test task',
      },
      true,
      'telegram_main',
    );

    const result = JSON.parse(
      fs.readFileSync(
        path.join(
          dataDir,
          'ipc',
          'telegram_main',
          'task_results',
          'req-add-1.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(true);
    expect(typeof result.id).toBe('number');
  });

  it('task_list returns an empty list when DB has no tasks', async () => {
    await dispatch({ type: 'task_list', requestId: 'req-list-1' }, true);
    const result = readResult('req-list-1');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.tasks).toEqual([]);
  });

  it('write actions skip the gate (no audit row written today — Rule 5 preservation)', async () => {
    // Even with an agent caller (compoundSource has +agent suffix),
    // task_add carries skipGate: true and the type is on
    // SKIP_GATE_ALLOWLIST, so no audit row should appear. This pin
    // protects against accidentally closing the bypass without the
    // explicit Batch 4 follow-up.
    const agentName = `tasks-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await dispatch(
      {
        type: 'task_add',
        requestId: 'req-no-audit',
        title: 'agent task',
      },
      false,
      `${SOURCE_GROUP}--${agentName}`,
    );

    const { getDb } = await import('../../db.js');
    const rows = getDb()
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type = 'task_add' AND agent_name = ?",
      )
      .all(agentName);
    expect(rows).toHaveLength(0);
  });

  it('rejects malformed requestId at the dispatcher (Rule 2)', async () => {
    await dispatch(
      {
        type: 'task_list',
        requestId: '../../etc/passwd',
      },
      true,
    );
    expect(fs.existsSync(resultsDir)).toBe(false);
  });
});
