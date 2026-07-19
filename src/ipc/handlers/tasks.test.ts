import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DATA_DIR } from '../../config.js';
import { _initTestDatabase, getDb, setRegisteredGroup } from '../../db.js';
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
      db: getDb(),
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

  it('write actions from agent callers hit the gate (Batch 4 closure)', async () => {
    // Inverse of the old Rule 5 pin: an agent caller with NO trust.yaml
    // (loadAgentTrust returns {actions:{}}) falls to the 'ask' default —
    // the action stages and an audit row appears. The bypass is closed.
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
      .all(agentName) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('staged');
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

  describe('Batch 4 gate closure (task_* writes)', () => {
    // Fixture agents live under the real DATA_DIR/agents like the Phase 4
    // gate-activation tests in skills.test.ts — gateAndStage loads
    // trust.yaml from AGENTS_DIR, which is not test-overridable.
    const makeAgent = (trustYaml: string | null): string => {
      const agentName = `tasks-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const agentDir = path.join(DATA_DIR, 'agents', agentName);
      fs.mkdirSync(agentDir, { recursive: true });
      if (trustYaml !== null) {
        fs.writeFileSync(path.join(agentDir, 'trust.yaml'), trustYaml);
      }
      return agentName;
    };
    const rmAgent = (agentName: string) =>
      fs.rmSync(path.join(DATA_DIR, 'agents', agentName), {
        recursive: true,
        force: true,
      });
    // Result files land under the FULL compound source dir
    // (ipc/{group}--{agent}/task_results/), not the bare group.
    const readAgentResult = (
      agentName: string,
      requestId: string,
    ): Record<string, unknown> | null => {
      const file = path.join(
        dataDir,
        'ipc',
        `${SOURCE_GROUP}--${agentName}`,
        'task_results',
        `${requestId}.json`,
      );
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    };

    it('task_add from agent with draft trust stages instead of executing', async () => {
      const agentName = makeAgent('actions:\n  task_add: draft\n');
      const title = `staged-task-${agentName}`;
      try {
        await dispatch(
          { type: 'task_add', requestId: 'req-gate-draft', title },
          false,
          `${SOURCE_GROUP}--${agentName}`,
        );

        // Task NOT created — the gate short-circuited before execute().
        const tasks = getDb()
          .prepare('SELECT * FROM tasks WHERE title = ?')
          .all(title);
        expect(tasks).toHaveLength(0);

        // Audit row: staged.
        const actions = getDb()
          .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
          .all(agentName) as Array<Record<string, unknown>>;
        expect(actions).toHaveLength(1);
        expect(actions[0].action_type).toBe('task_add');
        expect(actions[0].outcome).toBe('staged');

        // pending_actions row for /approve.
        const pending = getDb()
          .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
          .all(agentName) as Array<Record<string, unknown>>;
        expect(pending).toHaveLength(1);
        expect(pending[0].action_type).toBe('task_add');

        // Stage-result file so the container poller doesn't hang (Phase 0c).
        const result = readAgentResult(agentName, 'req-gate-draft');
        expect(result).not.toBeNull();
        expect(result!.executed).toBe(false);
        expect(result!.staged).toBe(true);
        expect(typeof result!.pendingId).toBe('string');
      } finally {
        rmAgent(agentName);
      }
    });

    it('task_add from agent with autonomous trust executes AND writes an allowed audit row', async () => {
      const agentName = makeAgent('actions:\n  task_add: autonomous\n');
      const title = `auto-task-${agentName}`;
      try {
        await dispatch(
          { type: 'task_add', requestId: 'req-gate-auto', title },
          false,
          `${SOURCE_GROUP}--${agentName}`,
        );

        const result = readAgentResult(agentName, 'req-gate-auto');
        expect(result).not.toBeNull();
        expect(result!.success).toBe(true);

        const actions = getDb()
          .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
          .all(agentName) as Array<Record<string, unknown>>;
        expect(actions).toHaveLength(1);
        expect(actions[0].action_type).toBe('task_add');
        expect(actions[0].trust_level).toBe('autonomous');
        expect(actions[0].outcome).toBe('allowed');
      } finally {
        rmAgent(agentName);
      }
    });

    it('agent with trust.yaml lacking task_* entries falls to ask and stages (fail-safe default)', async () => {
      const agentName = makeAgent('actions:\n  send_message: notify\n');
      try {
        await dispatch(
          {
            type: 'task_close',
            requestId: 'req-gate-default',
            id: 999999,
          },
          false,
          `${SOURCE_GROUP}--${agentName}`,
        );

        const actions = getDb()
          .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
          .all(agentName) as Array<Record<string, unknown>>;
        expect(actions).toHaveLength(1);
        expect(actions[0].action_type).toBe('task_close');
        expect(actions[0].outcome).toBe('staged');
        expect(actions[0].trust_level).toBe('ask');
      } finally {
        rmAgent(agentName);
      }
    });

    it('task_reopen from agent with draft trust stages without touching the task', async () => {
      // Seed a closed task via the non-agent path.
      const title = `reopen-target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await dispatch(
        { type: 'task_add', requestId: 'req-seed-add', title },
        true,
        'telegram_main',
      );
      const seeded = getDb()
        .prepare('SELECT * FROM tasks WHERE title = ?')
        .get(title) as { id: number; status: string };
      await dispatch(
        {
          type: 'task_close',
          requestId: 'req-seed-close',
          id: seeded.id,
          outcome: 'done',
        },
        true,
        'telegram_main',
      );

      const agentName = makeAgent('actions:\n  task_reopen: draft\n');
      try {
        await dispatch(
          { type: 'task_reopen', requestId: 'req-gate-reopen', id: seeded.id },
          false,
          `${SOURCE_GROUP}--${agentName}`,
        );

        // Task still closed — execute() never ran.
        const after = getDb()
          .prepare('SELECT * FROM tasks WHERE id = ?')
          .get(seeded.id) as Record<string, unknown>;
        expect(after.status).not.toBe('open');

        const actions = getDb()
          .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
          .all(agentName) as Array<Record<string, unknown>>;
        expect(actions).toHaveLength(1);
        expect(actions[0].outcome).toBe('staged');
      } finally {
        rmAgent(agentName);
      }
    });

    it('non-agent caller still executes with no audit row (NON_AGENT_DECISION parity)', async () => {
      const title = `nonagent-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await dispatch(
        { type: 'task_add', requestId: 'req-gate-nonagent', title },
        false,
      );

      const result = readResult('req-gate-nonagent');
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);

      const actions = getDb()
        .prepare("SELECT * FROM agent_actions WHERE action_type = 'task_add'")
        .all();
      expect(actions).toHaveLength(0);
    });
  });
});
