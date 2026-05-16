import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from '../../db.js';
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

  it('both actions skip the gate (no audit row — Rule 5 preservation)', async () => {
    // pageindex_fetch is on SKIP_GATE_ALLOWLIST as read-only; pageindex_index
    // is on the allowlist with TODO(Batch4). Both bypass the gate even for
    // agent callers — preserves the if-ladder's behaviour.
    const agentName = `px-agent-${Date.now()}`;
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
      .all(agentName);
    expect(rows).toHaveLength(0);
  });
});
