import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DATA_DIR } from '../../config.js';
import { _initTestDatabase, getDb, setRegisteredGroup } from '../../db.js';
import { IpcDeps } from '../../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
} from '../handler.js';
import { kgQueryHandler } from './kg-query.js';

/**
 * Per-handler tests for kgQueryHandler. The handler delegates to
 * runKgQuery in src/kg-ipc.ts, which is itself unit-tested in
 * src/kg-ipc.test.ts (via the legacy handleKgIpc wrapper with a per-test
 * DB). Here we focus on the contract surface — parse, authorize, wire-
 * format path, skipGate for non-agent callers, audit row for agent
 * callers.
 *
 * runKgQuery is stubbed at the import boundary so we don't need to
 * stand up a real knowledge-graph DB — these tests are about the
 * dispatcher seam, not the graph query itself.
 */
vi.mock('../../kg-ipc.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../kg-ipc.js')>('../../kg-ipc.js');
  return {
    ...actual,
    runKgQuery: vi.fn().mockReturnValue({
      matched: [{ id: 'e1', name: 'mocked-entity', type: 'person' }],
      neighbors: [],
      edges: [],
    }),
  };
});

describe('kgQueryHandler', () => {
  const SOURCE_GROUP = 'telegram_other';

  let dataDir: string;
  let resultsDir: string;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(kgQueryHandler);

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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-handler-test-'));
    // Wire-format-locked path: container reads from `kg_results/`
    // (hardcoded at container/agent-runner/src/ipc-mcp-stdio.ts:735).
    resultsDir = path.join(dataDir, 'ipc', SOURCE_GROUP, 'kg_results');
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

  it('rejects malformed requestId at the dispatcher (Rule 2)', async () => {
    await dispatch(
      {
        type: 'kg_query',
        requestId: '../../etc/passwd',
        query: 'rachel',
      },
      true,
    );
    expect(fs.existsSync(resultsDir)).toBe(false);
  });

  it('writes result file for valid query (Rule 1)', async () => {
    await dispatch(
      {
        type: 'kg_query',
        requestId: 'req-kg-1',
        query: 'rachel',
      },
      true,
    );

    const result = readResult('req-kg-1');
    expect(result).not.toBeNull();
    expect(result!.matched).toBeDefined();
  });

  it('writes result file at container-expected wire path (kg_results/)', async () => {
    await dispatch(
      { type: 'kg_query', requestId: 'req-wire', query: 'x' },
      true,
    );

    const expectedFile = path.join(
      dataDir,
      'ipc',
      SOURCE_GROUP,
      'kg_results',
      'req-wire.json',
    );
    expect(fs.existsSync(expectedFile)).toBe(true);

    // Pin against auto-naming. A future contributor dropping resultsDirName
    // would silently break the container poller; this assertion catches it.
    const wrongFile = path.join(
      dataDir,
      'ipc',
      SOURCE_GROUP,
      'kg_query_results',
      'req-wire.json',
    );
    expect(fs.existsSync(wrongFile)).toBe(false);
  });

  it('skips audit row for non-agent callers (Rule 4 skipGate on allowlist)', async () => {
    const { getDb } = await import('../../db.js');
    await dispatch(
      { type: 'kg_query', requestId: 'req-no-audit', query: 'x' },
      true,
    );

    const rows = getDb()
      .prepare("SELECT * FROM agent_actions WHERE action_type = 'kg_query'")
      .all();
    expect(rows).toHaveLength(0);

    expect(readResult('req-no-audit')).not.toBeNull();
  });

  it('writes audit row for agent callers (gate fires)', async () => {
    const agentName = `test-kg-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  kg_query: autonomous\n',
    );

    try {
      await dispatch(
        { type: 'kg_query', requestId: 'req-audited', query: 'x' },
        false,
        `${SOURCE_GROUP}--${agentName}`,
      );

      const { getDb } = await import('../../db.js');
      const rows = getDb()
        .prepare(
          "SELECT outcome FROM agent_actions WHERE action_type = 'kg_query' AND agent_name = ?",
        )
        .all(agentName) as { outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('allowed');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
