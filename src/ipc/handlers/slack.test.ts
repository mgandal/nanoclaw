import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb, setRegisteredGroup } from '../../db.js';
import { DATA_DIR } from '../../config.js';
import { IpcDeps } from '../../ipc.js';
import { logger } from '../../logger.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
} from '../handler.js';
import { slackDmReadHandler } from './slack.js';

/**
 * slack_dm_read handler tests. Migrated from the if-ladder arm at
 * src/ipc.ts:1205-1314. Pins:
 *  - parse / authorize / execute unit behavior
 *  - wire-format result-file path matches container hardcoded
 *    `slack_results/` (NOT default `slack_dm_read_results/`)
 *  - actionTypeOverride preserves audit action_type as `read_slack_dm`
 *  - throw-from-execute (network down, non-JSON response) covered by
 *    the dispatcher's catch
 *
 * fetch is stubbed at the global boundary — the goal here is the
 * dispatcher seam + wire format, not the Slack bridge integration.
 */
describe('slack_dm_read handler', () => {
  const SOURCE_GROUP = 'telegram_slacktest';

  let dataDir: string;
  let deps: IpcDeps;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(slackDmReadHandler);

    setRegisteredGroup('tg:slacktest1', {
      name: 'SlackTest',
      folder: SOURCE_GROUP,
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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-handler-test-'));

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const dispatch = async (
    data: Record<string, unknown>,
    compoundSource = SOURCE_GROUP,
  ) => {
    const ctx = buildContext(compoundSource, false, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const readResult = (
    sourceGroup: string,
    requestId: string,
  ): Record<string, unknown> | null => {
    const file = path.join(
      dataDir,
      'ipc',
      sourceGroup,
      'slack_results',
      `${requestId}.json`,
    );
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  };

  // ---- Unit: parse ----

  it('parse returns null for non-object input', () => {
    expect(slackDmReadHandler.parse(null)).toBeNull();
    expect(slackDmReadHandler.parse(undefined)).toBeNull();
    expect(slackDmReadHandler.parse(42)).toBeNull();
    expect(slackDmReadHandler.parse('str')).toBeNull();
  });

  it('parse extracts channel + limit and coerces wrong types to undefined', () => {
    expect(slackDmReadHandler.parse({ channel: 'D123', limit: 50 })).toEqual({
      channel: 'D123',
      limit: 50,
    });
    expect(slackDmReadHandler.parse({ channel: 42 })).toEqual({
      channel: undefined,
      limit: undefined,
    });
    expect(
      slackDmReadHandler.parse({ channel: 'D123', limit: 'fifty' }),
    ).toEqual({
      channel: 'D123',
      limit: undefined,
    });
  });

  // ---- Unit: authorize ----

  it('authorize sets skipGate for non-agent caller, with actionTypeOverride always present', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = slackDmReadHandler.authorize(
      { channel: 'D123', limit: undefined },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBe(true);
    expect(auth!.actionTypeOverride).toBe('read_slack_dm');
  });

  it('authorize omits skipGate for agent caller, override still set', () => {
    const ctx = buildContext(
      `${SOURCE_GROUP}--some-agent`,
      false,
      deps,
      dataDir,
    );
    const auth = slackDmReadHandler.authorize(
      { channel: 'D123', limit: undefined },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBeUndefined();
    expect(auth!.actionTypeOverride).toBe('read_slack_dm');
  });

  // ---- Unit: execute ----

  it('execute returns missing-channel failure when channel absent', async () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const result = await slackDmReadHandler.execute(
      { channel: undefined, limit: undefined },
      ctx,
    );
    expect(result).toEqual({
      executed: true,
      result: {
        success: false,
        message: 'Missing required parameter: channel',
      },
    });
  });

  it('execute returns success result with JSON-stringified messages on 200', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'm1', text: 'hi' }] }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmReadHandler.execute(
      { channel: 'D123', limit: undefined },
      ctx,
    );
    expect(out).toMatchObject({ executed: true });
    const payload = (out as { result: Record<string, unknown> }).result;
    expect(payload.success).toBe(true);
    // load-bearing: container poller reads .message
    expect(JSON.parse(payload.message as string)).toEqual([
      { id: 'm1', text: 'hi' },
    ]);
  });

  it('execute returns failure result on bridge 4xx with error field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'channel not found' }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmReadHandler.execute(
      { channel: 'D999', limit: undefined },
      ctx,
    );
    expect(out).toMatchObject({
      executed: true,
      result: { success: false, message: 'channel not found' },
    });
  });

  it('execute returns failure result on bridge 5xx without error field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmReadHandler.execute(
      { channel: 'D123', limit: undefined },
      ctx,
    );
    expect(out).toMatchObject({
      executed: true,
      result: { success: false, message: 'Bridge returned 500' },
    });
  });

  it('execute includes limit in fetch body when set, omits when undefined', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);

    await slackDmReadHandler.execute({ channel: 'D1', limit: 25 }, ctx);
    const bodyWith = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(bodyWith).toEqual({ channel: 'D1', limit: 25 });

    await slackDmReadHandler.execute({ channel: 'D1', limit: undefined }, ctx);
    const bodyWithout = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(bodyWithout).toEqual({ channel: 'D1' });
  });

  // ---- Integration: dispatcher writes result file at the legacy path ----

  it('dispatcher writes success result to slack_results/ (NOT slack_dm_read_results/)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'm1' }] }),
    });

    await dispatch({
      type: 'slack_dm_read',
      requestId: 'req-ok',
      channel: 'D123',
    });

    expect(readResult(SOURCE_GROUP, 'req-ok')).not.toBeNull();
    // Pin the legacy prefix-grouped dir — guards against a future
    // accidental drop of `resultsDirName: 'slack_results'`.
    expect(
      fs.existsSync(
        path.join(
          dataDir,
          'ipc',
          SOURCE_GROUP,
          'slack_dm_read_results',
          'req-ok.json',
        ),
      ),
    ).toBe(false);
  });

  it('dispatcher drops malformed requestId, no file written (Rule 2)', async () => {
    await dispatch({
      type: 'slack_dm_read',
      requestId: '../../etc/passwd',
      channel: 'D123',
    });
    expect(
      fs.existsSync(path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_results')),
    ).toBe(false);
  });

  it('dispatcher drops missing requestId, no file written (Rule 2)', async () => {
    await dispatch({
      type: 'slack_dm_read',
      channel: 'D123',
    });
    expect(
      fs.existsSync(path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_results')),
    ).toBe(false);
  });

  it('dispatcher catches fetch rejection (network down) and writes failure file', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await dispatch({
      type: 'slack_dm_read',
      requestId: 'req-net',
      channel: 'D123',
    });
    const result = readResult(SOURCE_GROUP, 'req-net');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('ECONNREFUSED');
  });

  it('dispatcher catches response.json() rejection (bridge returned non-JSON)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    });
    await dispatch({
      type: 'slack_dm_read',
      requestId: 'req-html',
      channel: 'D123',
    });
    const result = readResult(SOURCE_GROUP, 'req-html');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('Unexpected token');
  });

  // ---- Integration: audit-row pinning (THE Rule 5 test) ----

  it('agent caller produces audit row with action_type=read_slack_dm (NOT slack_dm_read)', async () => {
    const agentName = `test-slack-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  read_slack_dm: autonomous\n',
    );

    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ messages: [] }),
      });

      await dispatch(
        {
          type: 'slack_dm_read',
          requestId: 'req-audit',
          channel: 'D123',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      const rows = getDb()
        .prepare(
          'SELECT action_type, summary, target, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as {
        action_type: string;
        summary: string;
        target: string;
        outcome: string;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0].action_type).toBe('read_slack_dm');
      expect(rows[0].action_type).not.toBe('slack_dm_read');
      expect(rows[0].summary).toBe('Read DM channel: D123');
      expect(rows[0].target).toBe('D123');
      expect(rows[0].outcome).toBe('allowed');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('logger.info call includes requestId in context (Batch 4 Rule N)', async () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ messages: [] }),
      });

      await dispatch({
        type: 'slack_dm_read',
        requestId: 'req-xyz',
        channel: 'D123',
      });

      const calls = spy.mock.calls.filter(
        (c) => c[1] === 'slack_dm_read IPC handled',
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const ctxArg = calls[0][0] as Record<string, unknown>;
      expect(ctxArg.requestId).toBe('req-xyz');
    } finally {
      spy.mockRestore();
    }
  });

  it('non-agent caller produces ZERO audit rows for both action_type strings', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
    });

    await dispatch({
      type: 'slack_dm_read',
      requestId: 'req-no-audit',
      channel: 'D123',
    });

    const rows = getDb()
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type IN ('read_slack_dm', 'slack_dm_read')",
      )
      .all();
    expect(rows).toHaveLength(0);
    expect(readResult(SOURCE_GROUP, 'req-no-audit')).not.toBeNull();
  });
});
