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
import { deployMiniAppHandler } from './deploy-mini-app.js';

/**
 * Per-handler tests for deployMiniAppHandler. Mirror the
 * dashboardQueryHandler test structure but exercise the C1 fence
 * (non-agent + non-main rejection at authorize), which is the one
 * non-trivial difference from dashboard_query.
 *
 * The legacy library entry point is tested separately in
 * src/vercel-deployer.test.ts; the C13 trust equivalence is in
 * src/ipc.test.ts under 'deploy_mini_app trust enforcement (C13)'.
 */
describe('deployMiniAppHandler', () => {
  const SOURCE_GROUP = 'telegram_other';

  let dataDir: string;
  let resultsDir: string;
  let deps: IpcDeps;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(deployMiniAppHandler);

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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-handler-test-'));
    // Wire-format-locked path: container reads from `deploy_results/`
    // (hardcoded at container/agent-runner/src/ipc-mcp-stdio.ts:1714).
    resultsDir = path.join(dataDir, 'ipc', SOURCE_GROUP, 'deploy_results');

    process.env.VERCEL_TOKEN = 'test-token';
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'nanoclaw-test.vercel.app' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.VERCEL_TOKEN;
    vi.unstubAllGlobals();
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

  const readResult = (
    requestId: string,
    sourceGroup = SOURCE_GROUP,
  ): Record<string, unknown> | null => {
    const file = path.join(
      dataDir,
      'ipc',
      sourceGroup,
      'deploy_results',
      `${requestId}.json`,
    );
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  };

  const validPayload = {
    type: 'deploy_mini_app',
    requestId: 'req-deploy-1',
    appName: 'test-app',
    html: '<html><body>test</body></html>',
  };

  it('rejects malformed requestId at the dispatcher (Rule 2)', async () => {
    await dispatch({ ...validPayload, requestId: '../../etc/passwd' }, true);
    expect(fs.existsSync(resultsDir)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects missing requestId at the dispatcher (Rule 2)', async () => {
    const { requestId: _, ...withoutId } = validPayload;
    await dispatch(withoutId, true);
    expect(fs.existsSync(resultsDir)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('C1 fence: rejects non-agent non-main callers at authorize', async () => {
    // No '+agent' suffix on sourceGroup, isMain=false. authorize() returns
    // null. Execute should not run. No result file. No fetch call.
    await dispatch(validPayload, false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(resultsDir)).toBe(false);
  });

  it('main group, no agent: deploys (bypass)', async () => {
    await dispatch(validPayload, true, 'telegram_main');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const result = readResult('req-deploy-1', 'telegram_main');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.url).toContain('nanoclaw-test.vercel.app');
  });

  it('writes failure-shape result when Vercel returns non-ok', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });
    await dispatch(validPayload, true, 'telegram_main');
    const result = readResult('req-deploy-1', 'telegram_main');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toContain('Vercel API returned 500');
  });

  it('writes result file at container-expected wire path (deploy_results/)', async () => {
    await dispatch(
      { ...validPayload, requestId: 'req-wire-format' },
      true,
      'telegram_main',
    );

    const expectedFile = path.join(
      dataDir,
      'ipc',
      'telegram_main',
      'deploy_results',
      'req-wire-format.json',
    );
    expect(fs.existsSync(expectedFile)).toBe(true);

    // Pin against the auto-naming path. If a future contributor drops
    // resultsDirName from the handler, this fails fast.
    const wrongFile = path.join(
      dataDir,
      'ipc',
      'telegram_main',
      'deploy_mini_app_results',
      'req-wire-format.json',
    );
    expect(fs.existsSync(wrongFile)).toBe(false);
  });

  it('writes audit row + deploys for agent caller with autonomous trust', async () => {
    const agentName = `test-deploy-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  deploy_mini_app: autonomous\n',
    );

    try {
      await dispatch(validPayload, false, `${SOURCE_GROUP}--${agentName}`);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const { getDb } = await import('../../db.js');
      const rows = getDb()
        .prepare(
          "SELECT outcome FROM agent_actions WHERE action_type = 'deploy_mini_app' AND agent_name = ?",
        )
        .all(agentName) as { outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('allowed');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
