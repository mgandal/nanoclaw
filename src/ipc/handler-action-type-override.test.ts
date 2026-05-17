import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { _initTestDatabase, getDb, setRegisteredGroup } from '../db.js';
import { DATA_DIR } from '../config.js';
import { IpcDeps } from '../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
  type IpcHandler,
} from './handler.js';

/**
 * Dispatcher contract test for `actionTypeOverride`. Pins three invariants:
 *
 *   1. When a handler returns `actionTypeOverride: 'X'`, the
 *      `agent_actions.action_type` row is `'X'` (not `handler.type`).
 *   2. When a handler returns no override, the `agent_actions.action_type`
 *      row is `handler.type` (backward-compat — all prior batches).
 *   3. The contract-violation audit row (off-allowlist skipGate) keeps
 *      using `handler.type` regardless of override — that row describes
 *      the handler bug, not the user's action.
 */
describe('actionTypeOverride dispatcher behavior', () => {
  const SOURCE_GROUP = 'telegram_aud';
  let dataDir: string;
  let deps: IpcDeps;
  let agentName: string;
  let agentDir: string;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();

    setRegisteredGroup('tg:aud123', {
      name: 'Aud',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: false,
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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-type-override-'));

    agentName = `test-override-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  const dispatch = async (
    data: Record<string, unknown>,
    compoundSource = `${SOURCE_GROUP}--${agentName}`,
  ) => {
    const ctx = buildContext(compoundSource, false, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  it('writes audit row with actionTypeOverride when handler provides one', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: autonomous\n',
    );

    const overrideHandler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_x',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
      }),
      execute: () => undefined,
    };
    registerIpcHandler(overrideHandler);

    await dispatch({ type: 'wire_x' });

    const rows = getDb()
      .prepare(
        "SELECT action_type FROM agent_actions WHERE agent_name = ?",
      )
      .all(agentName) as { action_type: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('audit_x');
  });

  it('writes audit row with handler.type when no override (backward-compat)', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  wire_y: autonomous\n',
    );

    const plainHandler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_y',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-y',
        notifySummary: 'did y',
        payloadForStaging: { type: 'wire_y' },
      }),
      execute: () => undefined,
    };
    registerIpcHandler(plainHandler);

    await dispatch({ type: 'wire_y' });

    const rows = getDb()
      .prepare("SELECT action_type FROM agent_actions WHERE agent_name = ?")
      .all(agentName) as { action_type: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('wire_y');
  });

  it('contract-violation audit row uses handler.type, not override (off-allowlist skipGate)', async () => {
    const violatingHandler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_z',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-z',
        notifySummary: 'did z',
        payloadForStaging: { type: 'wire_z' },
        actionTypeOverride: 'audit_z',
        skipGate: true,
      }),
      execute: () => undefined,
    };
    registerIpcHandler(violatingHandler);

    await dispatch({ type: 'wire_z' });

    const rows = getDb()
      .prepare(
        "SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?",
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('wire_z');
    expect(rows[0].outcome).toBe('denied_contract_violation');
  });
});
