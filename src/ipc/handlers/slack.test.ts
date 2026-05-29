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
import { slackDmReadHandler, slackDmHandler } from './slack.js';

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
      db: getDb(),
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

/**
 * slack_dm (write) handler tests. Migrated from src/ipc.ts:1074-1196
 * (handleSlackDmIpc) at git HEAD prior to Batch 2F.1.
 *
 * Pins:
 *  - parse / authorize / execute unit shape
 *  - authorize accepts non-agent callers (matches imessageSendHandler
 *    pattern verified at imessage.ts:184-202; gateAndStage's
 *    NON_AGENT_DECISION + fireNotifyIfRequested's internal agentName
 *    guard preserve legacy "bridge fires, no notify" behavior)
 *  - notifySummary literal format including 120-char slice
 *  - wire-format result-file path matches container hardcoded
 *    `slack_results/`
 *  - actionTypeOverride preserves audit action_type as `send_slack_dm`
 *  - postHocNotify wires through the dispatcher's new branch (Batch
 *    2F.1) on bridge 2xx + trust=notify, stays silent on autonomous
 *    or bridge failure
 *  - dispatcher catches fetch rejection (network down) AND
 *    response.json() rejection (non-JSON body) — both produce failure
 *    result files and skip the notify (isSuccessPayload guard)
 *  - agent + malformed/missing requestId path writes synthetic audit row
 *    (Batch 4 dispatcher-observability contract)
 *  - trust level 'ask' stages without executing (no file, no notify)
 */
describe('slack_dm handler', () => {
  const SOURCE_GROUP = 'telegram_slacktest';

  let dataDir: string;
  let deps: IpcDeps;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(slackDmHandler);

    setRegisteredGroup('tg:slacktest1', {
      name: 'SlackTest',
      folder: SOURCE_GROUP,
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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-dm-handler-test-'));

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
    expect(slackDmHandler.parse(null)).toBeNull();
    expect(slackDmHandler.parse(undefined)).toBeNull();
    expect(slackDmHandler.parse(42)).toBeNull();
    expect(slackDmHandler.parse('str')).toBeNull();
  });

  it('parse extracts text + user_id + user_email and coerces wrong types to undefined', () => {
    expect(
      slackDmHandler.parse({
        text: 'hi',
        user_id: 'U1',
        user_email: 'a@b.com',
      }),
    ).toEqual({
      text: 'hi',
      user_id: 'U1',
      user_email: 'a@b.com',
    });
    expect(
      slackDmHandler.parse({ text: 42, user_id: 1, user_email: true }),
    ).toEqual({
      text: undefined,
      user_id: undefined,
      user_email: undefined,
    });
  });

  // ---- Unit: authorize ----

  it('authorize returns a non-null IpcAuthorization for non-agent caller (matches imessageSendHandler precedent)', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = slackDmHandler.authorize(
      { text: 'hi', user_id: undefined, user_email: 'a@b.com' },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.postHocNotify).toBe(true);
    expect(auth!.actionTypeOverride).toBe('send_slack_dm');
  });

  it('authorize returns IpcAuthorization with literal notifySummary including 120-char slice', () => {
    const ctx = buildContext(
      `${SOURCE_GROUP}--some-agent`,
      false,
      deps,
      dataDir,
    );
    const auth = slackDmHandler.authorize(
      {
        text: 'x'.repeat(200),
        user_id: undefined,
        user_email: 'alice@example.com',
      },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.postHocNotify).toBe(true);
    expect(auth!.actionTypeOverride).toBe('send_slack_dm');
    expect(auth!.target).toBe('alice@example.com');
    expect(auth!.auditSummary).toBe('x'.repeat(200));
    expect(auth!.notifySummary).toBe(
      'Slack DM → alice@example.com: ' + 'x'.repeat(120),
    );
  });

  // ---- Unit: execute ----

  it('execute returns missing-params failure when text absent', async () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const result = await slackDmHandler.execute(
      { text: undefined, user_id: 'U1', user_email: undefined },
      ctx,
    );
    expect(result).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Missing required parameters: text and either user_id or user_email',
      },
    });
  });

  it('execute returns missing-params failure when both user_id and user_email absent', async () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const result = await slackDmHandler.execute(
      { text: 'hi', user_id: undefined, user_email: undefined },
      ctx,
    );
    expect(result).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Missing required parameters: text and either user_id or user_email',
      },
    });
  });

  it('execute happy path POSTs to 19876/slack/dm and returns success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: 'sent' }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmHandler.execute(
      { text: 'hi', user_id: 'U1', user_email: undefined },
      ctx,
    );
    expect(out).toEqual({
      executed: true,
      result: {
        success: true,
        message: 'sent',
        data: { message: 'sent' },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19876/slack/dm',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('execute returns failure result on bridge 4xx with error field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'user_not_found' }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmHandler.execute(
      { text: 'hi', user_id: 'U_unknown', user_email: undefined },
      ctx,
    );
    expect(out).toEqual({
      executed: true,
      result: { success: false, message: 'user_not_found' },
    });
  });

  it('execute returns failure result on bridge 5xx without error field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmHandler.execute(
      { text: 'hi', user_id: 'U1', user_email: undefined },
      ctx,
    );
    expect(out).toEqual({
      executed: true,
      result: { success: false, message: 'Bridge returned 500' },
    });
  });

  it('execute includes user_email when set, omits when undefined; same for user_id', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);

    await slackDmHandler.execute(
      { text: 'hi', user_id: undefined, user_email: 'a@b.com' },
      ctx,
    );
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body1).toEqual({ text: 'hi', user_email: 'a@b.com' });

    await slackDmHandler.execute(
      { text: 'hi', user_id: 'U1', user_email: undefined },
      ctx,
    );
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body2).toEqual({ text: 'hi', user_id: 'U1' });

    await slackDmHandler.execute(
      { text: 'hi', user_id: 'U1', user_email: 'a@b.com' },
      ctx,
    );
    const body3 = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body3).toEqual({ text: 'hi', user_id: 'U1', user_email: 'a@b.com' });
  });

  // ---- Integration: dispatcher result file ----

  it('dispatcher writes success result to slack_results/ (NOT slack_dm_results/)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: 'sent' }),
    });

    await dispatch({
      type: 'slack_dm',
      requestId: 'req-ok',
      text: 'hi',
      user_email: 'a@b.com',
    });

    expect(readResult(SOURCE_GROUP, 'req-ok')).not.toBeNull();
    expect(
      fs.existsSync(
        path.join(
          dataDir,
          'ipc',
          SOURCE_GROUP,
          'slack_dm_results',
          'req-ok.json',
        ),
      ),
    ).toBe(false);
  });

  it('dispatcher drops malformed requestId for non-agent caller, no file written', async () => {
    await dispatch({
      type: 'slack_dm',
      requestId: '../../etc/passwd',
      text: 'hi',
      user_email: 'a@b.com',
    });
    expect(
      fs.existsSync(path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_results')),
    ).toBe(false);
  });

  it('dispatcher drops malformed requestId for agent caller, writes synthetic audit row', async () => {
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    try {
      await dispatch(
        {
          type: 'slack_dm',
          requestId: '../../etc/passwd',
          text: 'hi',
          user_email: 'a@b.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      expect(
        fs.existsSync(
          path.join(
            dataDir,
            'ipc',
            `${SOURCE_GROUP}--${agentName}`,
            'slack_results',
          ),
        ),
      ).toBe(false);

      const rows = getDb()
        .prepare('SELECT outcome FROM agent_actions WHERE agent_name = ?')
        .all(agentName) as { outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('dropped_invalid_requestId');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('dispatcher drops missing requestId for non-agent caller, no file written', async () => {
    await dispatch({
      type: 'slack_dm',
      text: 'hi',
      user_email: 'a@b.com',
    });
    expect(
      fs.existsSync(path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_results')),
    ).toBe(false);
  });

  it('dispatcher drops missing requestId for agent caller, writes synthetic audit row', async () => {
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    try {
      await dispatch(
        {
          type: 'slack_dm',
          text: 'hi',
          user_email: 'a@b.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );
      const rows = getDb()
        .prepare('SELECT outcome FROM agent_actions WHERE agent_name = ?')
        .all(agentName) as { outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('dropped_invalid_requestId');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('dispatcher catches fetch rejection (network down) and writes failure file', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await dispatch({
      type: 'slack_dm',
      requestId: 'req-net',
      text: 'hi',
      user_email: 'a@b.com',
    });
    const result = readResult(SOURCE_GROUP, 'req-net');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('ECONNREFUSED');
  });

  it('dispatcher catches response.json() rejection (bridge returned non-JSON) and writes failure file', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <');
      },
    });
    await dispatch({
      type: 'slack_dm',
      requestId: 'req-html',
      text: 'hi',
      user_email: 'a@b.com',
    });
    const result = readResult(SOURCE_GROUP, 'req-html');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('Unexpected token');
  });

  // ---- Integration: audit + notify ----

  it('agent + send_slack_dm:notify + bridge 200 → file + audit row + sendMessage once', async () => {
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  send_slack_dm: notify\n',
    );

    const MAIN_JID = 'tg:slacktest-main';
    setRegisteredGroup(MAIN_JID, {
      name: 'Main',
      folder: 'telegram_slacktest_main',
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const sent: { jid: string; text: string }[] = [];
    deps = {
      ...deps,
      sendMessage: async (jid, text) => {
        sent.push({ jid, text });
      },
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: 'telegram_slacktest_main',
          trigger: '@Claire',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
    };

    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: 'sent' }),
      });

      await dispatch(
        {
          type: 'slack_dm',
          requestId: 'req-audit-notify',
          text: 'hello peer',
          user_email: 'peer@example.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      expect(
        readResult(`${SOURCE_GROUP}--${agentName}`, 'req-audit-notify'),
      ).not.toBeNull();

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
      expect(rows[0].action_type).toBe('send_slack_dm');
      expect(rows[0].outcome).toBe('allowed');
      expect(rows[0].target).toBe('peer@example.com');

      expect(sent).toHaveLength(1);
      expect(sent[0].jid).toBe(MAIN_JID);
      expect(sent[0].text).toContain('send_slack_dm');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('agent + send_slack_dm:autonomous + bridge 200 → file + audit row + sendMessage NOT called', async () => {
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  send_slack_dm: autonomous\n',
    );

    const MAIN_JID = 'tg:slacktest-main-auto';
    setRegisteredGroup(MAIN_JID, {
      name: 'Main',
      folder: 'telegram_slacktest_main',
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const sent: { jid: string; text: string }[] = [];
    deps = {
      ...deps,
      sendMessage: async (jid, text) => {
        sent.push({ jid, text });
      },
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: 'telegram_slacktest_main',
          trigger: '@Claire',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
    };

    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: 'sent' }),
      });

      await dispatch(
        {
          type: 'slack_dm',
          requestId: 'req-audit-auto',
          text: 'hello peer',
          user_email: 'peer@example.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      expect(
        readResult(`${SOURCE_GROUP}--${agentName}`, 'req-audit-auto'),
      ).not.toBeNull();

      const rows = getDb()
        .prepare(
          'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as { action_type: string; outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].action_type).toBe('send_slack_dm');
      expect(rows[0].outcome).toBe('allowed');

      expect(sent).toHaveLength(0);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('agent + send_slack_dm:ask → stage-result file written, audit row outcome=staged', async () => {
    // Phase 0c (R3-C3 amendment): the dispatcher now writes a stage-result
    // file when a result-kind handler stages, so the in-container poller
    // sees `{executed:false, staged:true, pendingId, message}` instead of
    // hanging IPC_TIMEOUT_MS. Bridge is NOT called (no execute()).
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  send_slack_dm: ask\n',
    );

    try {
      await dispatch(
        {
          type: 'slack_dm',
          requestId: 'req-audit-ask',
          text: 'hello peer',
          user_email: 'peer@example.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      const stagedFile = readResult(
        `${SOURCE_GROUP}--${agentName}`,
        'req-audit-ask',
      );
      expect(stagedFile).not.toBeNull();
      // `readResult` returns `Record<string, unknown> | null`; the prior
      // assertion narrows null. `!` is the documented test-narrowing idiom
      // used elsewhere in this file.
      expect(stagedFile!.executed).toBe(false);
      expect(stagedFile!.staged).toBe(true);
      expect(typeof stagedFile!.pendingId).toBe('string');
      expect(stagedFile!.pendingId).toMatch(/^pa-/);
      expect(stagedFile!.message).toContain('Staged for approval');
      expect(fetchMock).not.toHaveBeenCalled();

      const rows = getDb()
        .prepare(
          'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as { action_type: string; outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].action_type).toBe('send_slack_dm');
      expect(rows[0].outcome).toBe('staged');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('non-agent caller dispatches to bridge with no audit row and no notify (replaces C13 non-agent test)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: 'sent' }),
    });

    await dispatch({
      type: 'slack_dm',
      requestId: 'req-nonagent',
      text: 'hi',
      user_email: 'a@b.com',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readResult(SOURCE_GROUP, 'req-nonagent')).not.toBeNull();
    const rows = getDb()
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type IN ('slack_dm', 'send_slack_dm')",
      )
      .all();
    expect(rows).toHaveLength(0);
  });
});
