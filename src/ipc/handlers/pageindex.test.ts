import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

import { _initTestDatabase, getDb, setRegisteredGroup } from '../../db.js';
import {
  makeTrustAgent,
  rmTrustAgent,
  sweepStaleFixtureAgents,
  readIpcResult,
} from '../test-fixtures.js';
import { IpcDeps } from '../../ipc.js';
import { type MountMapping } from '../../pageindex.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
} from '../handler.js';
import { pageindexFetchHandler, pageindexIndexHandler } from './pageindex.js';

/**
 * Per-handler tests for the pageindex_* cluster. The PDF reading/indexing
 * logic is tested separately in src/pageindex.test.ts (the inner
 * fetchPageRange / indexPdf functions). Here we focus on the contract
 * surface — that the handler resolves mounts the same way the if-ladder
 * did, sends them to the runner, and lands the result at
 * pageindex_results/.
 *
 * runPageindexFetch / runPageindexIndex are stubbed so the tests don't
 * need real PDFs on disk.
 */
// vi.hoisted runs before vi.mock factories so the mocks are defined when
// the factory closure references them. Plain `const mockFetch = vi.fn()`
// followed by `vi.mock(... mockFetch ...)` fails because vi.mock is hoisted
// above the const decl.
const { mockFetch, mockIndex } = vi.hoisted(() => ({
  mockFetch: vi.fn().mockResolvedValue({ success: true, text: 'page text' }),
  mockIndex: vi
    .fn()
    .mockResolvedValue({ success: true, tree: {}, pageCount: 5 }),
}));
vi.mock('../../pageindex-ipc.js', () => ({
  runPageindexFetch: mockFetch,
  runPageindexIndex: mockIndex,
}));

describe('pageindex_* cluster handlers', () => {
  const MAIN_GROUP_FOLDER = 'telegram_main';
  const MAIN_JID = 'tg:main123';

  let dataDir: string;
  let resultsDir: string;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(pageindexFetchHandler);
    registerIpcHandler(pageindexIndexHandler);

    setRegisteredGroup(MAIN_JID, {
      name: 'Main',
      folder: MAIN_GROUP_FOLDER,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    deps = {
      db: getDb(),
      sendMessage: async () => undefined,
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: MAIN_GROUP_FOLDER,
          trigger: '@Claire',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pageindex-handler-test-'));
    // Wire-format-locked path: pageindex_results/ (matches legacy + the
    // in-container poller).
    resultsDir = path.join(
      dataDir,
      'ipc',
      MAIN_GROUP_FOLDER,
      'pageindex_results',
    );
    mockFetch.mockClear();
    mockIndex.mockClear();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const dispatch = async (
    data: Record<string, unknown>,
    isMain: boolean,
    compoundSource = MAIN_GROUP_FOLDER,
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

  it('pageindex_fetch writes result at wire-format path', async () => {
    await dispatch(
      {
        type: 'pageindex_fetch',
        requestId: 'req-fetch',
        pdfPath: '/workspace/group/x.pdf',
        startPage: 1,
        endPage: 3,
      },
      true,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(readResult('req-fetch')).not.toBeNull();
  });

  it('passes the if-ladder mount shape to runPageindexFetch', async () => {
    await dispatch(
      {
        type: 'pageindex_fetch',
        requestId: 'req-mounts',
        pdfPath: '/workspace/group/x.pdf',
        startPage: 1,
        endPage: 1,
      },
      true,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Second arg is the mounts array. The handler must include the
    // /workspace/group mount the if-ladder appended.
    const mounts = mockFetch.mock.calls[0]![1] as MountMapping[];
    const groupMount = mounts.find(
      (m) => m.containerPath === '/workspace/group',
    );
    expect(groupMount).toBeDefined();
    expect(groupMount!.readonly).toBe(false);
  });

  it('pageindex_index writes result at wire-format path', async () => {
    await dispatch(
      {
        type: 'pageindex_index',
        requestId: 'req-index',
        pdfPath: '/workspace/group/big.pdf',
      },
      true,
    );

    expect(mockIndex).toHaveBeenCalledTimes(1);
    const result = readResult('req-index');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
  });

  it('rejects malformed requestId at the dispatcher (Rule 2)', async () => {
    await dispatch(
      {
        type: 'pageindex_fetch',
        requestId: '../../etc/passwd',
        pdfPath: 'x.pdf',
        startPage: 1,
        endPage: 1,
      },
      true,
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.existsSync(resultsDir)).toBe(false);
  });

  it('pageindex_index from agent hits the gate; pageindex_fetch still skips (Batch 4 closure)', async () => {
    // pageindex_fetch stays on SKIP_GATE_ALLOWLIST (read-only, no audit
    // row). pageindex_index is gated: an agent with no trust.yaml falls
    // to the 'ask' default and stages, leaving one audit row.
    const agentName = `px-agent-${Date.now()}`;
    await dispatch(
      {
        type: 'pageindex_fetch',
        requestId: 'req-fetch-skip',
        pdfPath: 'x.pdf',
      },
      false,
      `${MAIN_GROUP_FOLDER}--${agentName}`,
    );
    await dispatch(
      {
        type: 'pageindex_index',
        requestId: 'req-no-audit',
        pdfPath: 'x.pdf',
      },
      false,
      `${MAIN_GROUP_FOLDER}--${agentName}`,
    );

    const { getDb } = await import('../../db.js');
    const rows = getDb()
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type IN ('pageindex_fetch', 'pageindex_index') AND agent_name = ?",
      )
      .all(agentName) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('pageindex_index');
    expect(rows[0].outcome).toBe('staged');
  });

  describe('Batch 4 gate closure (pageindex_index write)', () => {
    // Shared fixtures (src/ipc/test-fixtures.ts); beforeAll sweep clears
    // dirs orphaned by a previously killed run.
    const PREFIX = 'px-gate';
    beforeAll(() => sweepStaleFixtureAgents(PREFIX));
    const makeAgent = (trustYaml: string): string =>
      makeTrustAgent(PREFIX, trustYaml);
    const rmAgent = rmTrustAgent;
    const readAgentResult = (
      agentName: string,
      requestId: string,
    ): Record<string, unknown> | null =>
      readIpcResult(
        dataDir,
        `${MAIN_GROUP_FOLDER}--${agentName}`,
        'pageindex_results',
        requestId,
      );

    it('pageindex_index from agent with draft trust stages; runner never called', async () => {
      const agentName = makeAgent('actions:\n  pageindex_index: draft\n');
      try {
        await dispatch(
          {
            type: 'pageindex_index',
            requestId: 'req-px-draft',
            pdfPath: '/workspace/group/doc.pdf',
          },
          false,
          `${MAIN_GROUP_FOLDER}--${agentName}`,
        );

        expect(mockIndex).not.toHaveBeenCalled();

        const actions = getDb()
          .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
          .all(agentName) as Array<Record<string, unknown>>;
        expect(actions).toHaveLength(1);
        expect(actions[0].action_type).toBe('pageindex_index');
        expect(actions[0].outcome).toBe('staged');

        const pending = getDb()
          .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
          .all(agentName) as Array<Record<string, unknown>>;
        expect(pending).toHaveLength(1);
        // The staged payload must carry the full original request — an
        // /approve replay re-parses it, and runPageindexIndex rejects a
        // missing pdfPath. Regression pin for the thin-payload bug.
        const stagedPayload = JSON.parse(String(pending[0].payload_json));
        expect(stagedPayload.pdfPath).toBe('/workspace/group/doc.pdf');

        const result = readAgentResult(agentName, 'req-px-draft');
        expect(result).not.toBeNull();
        expect(result!.staged).toBe(true);
      } finally {
        rmAgent(agentName);
      }
    });

    it('pageindex_index from agent with autonomous trust executes with allowed audit row', async () => {
      const agentName = makeAgent('actions:\n  pageindex_index: autonomous\n');
      try {
        await dispatch(
          {
            type: 'pageindex_index',
            requestId: 'req-px-auto',
            pdfPath: '/workspace/group/doc.pdf',
          },
          false,
          `${MAIN_GROUP_FOLDER}--${agentName}`,
        );

        // Gate allowed the action and wrote the audit row. Note: execute()
        // itself then throws for compound `group--agent` sources because
        // resolveMountsForGroup → resolveGroupFolderPath rejects `--`
        // (pre-existing quirk, identical under the old skipGate bypass) —
        // so we assert the gate decision + dispatcher result-file contract,
        // not the runner call.
        const actions = getDb()
          .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
          .all(agentName) as Array<Record<string, unknown>>;
        expect(actions).toHaveLength(1);
        expect(actions[0].trust_level).toBe('autonomous');
        expect(actions[0].outcome).toBe('allowed');

        // No staging: gate passed it through to execute.
        const pending = getDb()
          .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
          .all(agentName);
        expect(pending).toHaveLength(0);

        // Dispatcher always writes a result file (Rule 1) so the poller
        // never hangs — here the execute-threw failure shape.
        const result = readAgentResult(agentName, 'req-px-auto');
        expect(result).not.toBeNull();
      } finally {
        rmAgent(agentName);
      }
    });
  });
});
