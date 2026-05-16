import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DATA_DIR } from '../../config.js';
import {
  _initTestDatabase,
  createTask,
  getDb,
  setRegisteredGroup,
} from '../../db.js';
import { IpcDeps } from '../../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
} from '../handler.js';
import { dashboardQueryHandler } from './dashboard-query.js';

/**
 * Per-handler tests for dashboardQueryHandler. Covers the contract surface
 * (parse / authorize / execute) plus the dispatcher behaviours the handler
 * relies on: requestId rejection (Rule 2), skipGate honoring for non-agent
 * callers (Rule 4), and result-file writing (Rule 1).
 *
 * The legacy library entry point is tested separately in
 * src/dashboard-ipc.test.ts; the trust-gate equivalence is in
 * src/ipc.test.ts under 'dashboard_query trust enforcement (C13)'.
 */
describe('dashboardQueryHandler', () => {
  const SOURCE_GROUP = 'telegram_other';
  // Wire-format-locked path: container reads from `dashboard_results/`
  // (singular suffix, prefix-grouped). See dashboard-query.ts and
  // container/agent-runner/src/ipc-mcp-stdio.ts:733.
  const RESULTS_DIR = path.join(
    DATA_DIR,
    'ipc',
    SOURCE_GROUP,
    'dashboard_results',
  );

  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(dashboardQueryHandler);

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

    fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
  });

  const dispatch = async (
    data: Record<string, unknown>,
    isMain: boolean,
    compoundSource = SOURCE_GROUP,
  ) => {
    const ctx = buildContext(compoundSource, isMain, deps);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const readResult = (requestId: string): Record<string, unknown> | null => {
    const file = path.join(RESULTS_DIR, `${requestId}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  };

  it('rejects malformed requestId at the dispatcher (Rule 2)', async () => {
    const result = await dispatch(
      {
        type: 'dashboard_query',
        requestId: '../../../etc/passwd',
        queryType: 'task_summary',
      },
      false,
    );
    expect(result.handled).toBe(true);
    // No result file should be written for malformed requestId — the poller
    // is expected to time out, which is the correct failure mode.
    expect(fs.existsSync(RESULTS_DIR)).toBe(false);
  });

  it('rejects missing requestId at the dispatcher (Rule 2)', async () => {
    const result = await dispatch(
      { type: 'dashboard_query', queryType: 'task_summary' },
      false,
    );
    expect(result.handled).toBe(true);
    expect(fs.existsSync(RESULTS_DIR)).toBe(false);
  });

  it('writes result file for valid task_summary query (Rule 1)', async () => {
    createTask({
      id: 'test-task-1',
      group_folder: SOURCE_GROUP,
      chat_jid: 'tg:other456',
      prompt: 'p',
      schedule_type: 'cron',
      schedule_value: '0 7 * * *',
      status: 'active',
      next_run: new Date().toISOString(),
      created_at: new Date().toISOString(),
      context_mode: 'isolated',
      agent_name: null,
    });

    await dispatch(
      {
        type: 'dashboard_query',
        requestId: 'req-success',
        queryType: 'task_summary',
      },
      false,
    );

    const result = readResult('req-success');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.tasks).toBeDefined();
    expect((result!.tasks as unknown[]).length).toBe(1);
  });

  it('returns per-query deny for non-main group_summary (preserves legacy behaviour)', async () => {
    await dispatch(
      {
        type: 'dashboard_query',
        requestId: 'req-deny',
        queryType: 'group_summary',
      },
      false,
    );

    const result = readResult('req-deny');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toContain('restricted to main group');
  });

  it('writes failure-shape result on unknown query type', async () => {
    await dispatch(
      {
        type: 'dashboard_query',
        requestId: 'req-unknown',
        queryType: 'no_such_query',
      },
      true,
    );

    const result = readResult('req-unknown');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toContain('Unknown query type');
  });

  it('skips audit row for non-agent callers (Rule 4 skipGate on allowlist)', async () => {
    // SOURCE_GROUP has no '+agent' component, so ctx.agentName is null. The
    // handler requests skipGate; the dispatcher honors it because
    // dashboard_query is on SKIP_GATE_ALLOWLIST. No audit row should appear.
    await dispatch(
      {
        type: 'dashboard_query',
        requestId: 'req-no-audit',
        queryType: 'state_freshness',
      },
      true,
    );

    const rows = getDb()
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type = 'dashboard_query'",
      )
      .all();
    expect(rows).toHaveLength(0);

    // The result file is still written — skipGate doesn't change execution,
    // only the gate.
    expect(readResult('req-no-audit')).not.toBeNull();
  });

  it('writes audit row for agent callers (gate fires)', async () => {
    const agentName = 'test-dash-agent';
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  dashboard_query: autonomous\n',
    );

    try {
      await dispatch(
        {
          type: 'dashboard_query',
          requestId: 'req-audited',
          queryType: 'state_freshness',
        },
        false,
        `${SOURCE_GROUP}--${agentName}`,
      );

      const rows = getDb()
        .prepare(
          "SELECT outcome FROM agent_actions WHERE action_type = 'dashboard_query' AND agent_name = ?",
        )
        .all(agentName) as { outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('allowed');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  // --- Wire-format contract with the container-side poller ---
  //
  // The in-container agent reads from dashboard_results/{requestId}.json
  // (hardcoded at container/agent-runner/src/ipc-mcp-stdio.ts:733). Every
  // result-kind handler being migrated must land its result file at the
  // legacy prefix-grouped path. This test locks the contract for
  // dashboard_query so a future refactor cannot silently retarget it to,
  // e.g., `dashboard_query_results/`.
  it('writes result file at container-expected wire path (dashboard_results/)', async () => {
    await dispatch(
      {
        type: 'dashboard_query',
        requestId: 'req-wire-format',
        queryType: 'state_freshness',
      },
      true,
    );

    const expectedFile = path.join(
      DATA_DIR,
      'ipc',
      SOURCE_GROUP,
      'dashboard_results',
      'req-wire-format.json',
    );
    expect(fs.existsSync(expectedFile)).toBe(true);

    // Also pin: the auto-naming path MUST NOT have been used, even
    // accidentally. If a future contributor drops resultsDirName from the
    // handler, this assertion fails and steers them to read the contract.
    const wrongFile = path.join(
      DATA_DIR,
      'ipc',
      SOURCE_GROUP,
      'dashboard_query_results',
      'req-wire-format.json',
    );
    expect(fs.existsSync(wrongFile)).toBe(false);

    fs.rmSync(
      path.join(DATA_DIR, 'ipc', SOURCE_GROUP, 'dashboard_query_results'),
      { recursive: true, force: true },
    );
  });
});

// --- Rule 1: dispatcher writes failure result file when execute throws ---
//
// Lives outside the dashboardQueryHandler describe block because it
// registers a different handler (a deliberately-throwing one). This locks
// in the failure-file invariant for ALL future result-kind handlers; the
// in-container poller must never hang because of a thrown error.
describe('dispatcher Rule 1: failure-file on execute throw', () => {
  const SOURCE_GROUP = 'telegram_other';
  const RESULTS_DIR = path.join(
    DATA_DIR,
    'ipc',
    SOURCE_GROUP,
    'throwing_test_results',
  );

  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    deps = {
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };
    fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
  });

  it('writes {success:false, message:"Error: ..."} when handler throws', async () => {
    // Register a deliberately throwing handler on a unique allowlisted-ish
    // type. We don't need it on SKIP_GATE_ALLOWLIST because no agent caller
    // is involved (sourceGroup has no '+agent'), so gateAndStage allows
    // unconditionally for non-agent callers.
    registerIpcHandler({
      type: 'throwing_test',
      responseKind: 'result',
      parse: () => ({}),
      authorize: () => ({
        target: 'test',
        notifySummary: 'test',
        payloadForStaging: {},
      }),
      execute: () => {
        throw new Error('deliberate boom');
      },
    });

    const ctx = buildContext(SOURCE_GROUP, true, deps);
    await dispatchIpcAction(
      { type: 'throwing_test', requestId: 'req-throw' },
      ctx,
    );

    const file = path.join(RESULTS_DIR, 'req-throw.json');
    expect(fs.existsSync(file)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(payload.success).toBe(false);
    expect(payload.message).toContain('deliberate boom');
  });

  it('writes {success:false, message:"execution bailed"} when handler returns {executed:false}', async () => {
    registerIpcHandler({
      type: 'throwing_test',
      responseKind: 'result',
      parse: () => ({}),
      authorize: () => ({
        target: 'test',
        notifySummary: 'test',
        payloadForStaging: {},
      }),
      execute: () => ({ executed: false }) as const,
    });

    const ctx = buildContext(SOURCE_GROUP, true, deps);
    await dispatchIpcAction(
      { type: 'throwing_test', requestId: 'req-bail' },
      ctx,
    );

    const file = path.join(RESULTS_DIR, 'req-bail.json');
    expect(fs.existsSync(file)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(payload.success).toBe(false);
    expect(payload.message).toBe('execution bailed');
  });
});
