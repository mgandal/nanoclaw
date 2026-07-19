import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
 * Dispatcher gate-hardening pins (2026-07-19 review follow-up):
 *
 *   1. Trust level `notify` is honored for result-kind handlers WITHOUT
 *      any handler-side opt-in flag — "execute, then send a post-hoc
 *      notification to main" (trust-enforcement.ts) must hold for every
 *      responseKind, otherwise `notify` silently degenerates to
 *      `autonomous`.
 *   2. The notify still respects the success guard: a `{success:false}`
 *      result payload sends nothing.
 *   3. A throw inside the trust gate (audit/staging DB write) must not
 *      escape dispatchIpcAction: the dispatcher writes the Rule-1 failure
 *      result file so the container poller never hangs, and returns
 *      handled.
 */
describe('dispatcher gate hardening', () => {
  const SOURCE_GROUP = 'telegram_gh';
  const MAIN_JID = 'tg:gh-main';
  let dataDir: string;
  let deps: IpcDeps;
  let agentName: string;
  let agentDir: string;
  let sent: { jid: string; text: string }[];

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();

    setRegisteredGroup('tg:gh1', {
      name: 'GH',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: false,
    });
    setRegisteredGroup(MAIN_JID, {
      name: 'Main',
      folder: 'telegram_ghmain',
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    sent = [];
    deps = {
      db: getDb(),
      sendMessage: async (jid, text) => {
        sent.push({ jid, text });
      },
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: 'telegram_ghmain',
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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-hardening-'));

    agentName = `test-gh-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  const dispatch = async (data: Record<string, unknown>) => {
    const ctx = buildContext(
      `${SOURCE_GROUP}--${agentName}`,
      false,
      deps,
      dataDir,
    );
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const readResult = (requestId: string): Record<string, unknown> | null => {
    const file = path.join(
      dataDir,
      'ipc',
      `${SOURCE_GROUP}--${agentName}`,
      'wire_gh_results',
      `${requestId}.json`,
    );
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  };

  const registerResultHandler = (
    execute: IpcHandler<
      { raw: Record<string, unknown> },
      { executed: true; result: unknown }
    >['execute'],
  ) => {
    registerIpcHandler({
      type: 'wire_gh',
      responseKind: 'result',
      parse(raw) {
        return { raw: raw as Record<string, unknown> };
      },
      authorize() {
        return {
          target: 'gh-target',
          notifySummary: 'did the gh thing',
          payloadForStaging: { type: 'wire_gh' },
        };
      },
      execute,
    });
  };

  it('trust level notify fires the post-hoc notify for result-kind handlers without any opt-in flag', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  wire_gh: notify\n',
    );
    registerResultHandler(() => ({
      executed: true,
      result: { success: true, value: 42 },
    }));

    await dispatch({ type: 'wire_gh', requestId: 'req-notify-1' });

    // Result file written for the poller...
    expect(readResult('req-notify-1')).toEqual({ success: true, value: 42 });
    // ...AND the user got the trust-mandated receipt.
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(MAIN_JID);
    expect(sent[0].text).toContain('did the gh thing');
  });

  it('notify level stays silent when the result payload reports failure', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  wire_gh: notify\n',
    );
    registerResultHandler(() => ({
      executed: true,
      result: { success: false, message: 'bridge 500' },
    }));

    await dispatch({ type: 'wire_gh', requestId: 'req-notify-2' });

    expect(readResult('req-notify-2')).toEqual({
      success: false,
      message: 'bridge 500',
    });
    expect(sent).toHaveLength(0);
  });

  it('autonomous level stays silent for result-kind handlers', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  wire_gh: autonomous\n',
    );
    registerResultHandler(() => ({
      executed: true,
      result: { success: true },
    }));

    await dispatch({ type: 'wire_gh', requestId: 'req-notify-3' });

    expect(readResult('req-notify-3')).toEqual({ success: true });
    expect(sent).toHaveLength(0);
  });

  it('a throw inside the trust gate writes the Rule-1 failure result file instead of escaping', async () => {
    // draft level routes to insertPendingAction, whose JSON.stringify
    // throws on a circular payloadForStaging — a real in-gate throw with
    // no mocking.
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  wire_gh: draft\n',
    );
    const circular: Record<string, unknown> = { type: 'wire_gh' };
    circular.self = circular;
    let executeRan = false;
    registerIpcHandler({
      type: 'wire_gh',
      responseKind: 'result',
      parse(raw) {
        return { raw: raw as Record<string, unknown> };
      },
      authorize() {
        return {
          target: 'gh-target',
          notifySummary: 'did the gh thing',
          payloadForStaging: circular,
        };
      },
      execute() {
        executeRan = true;
        return { executed: true, result: { success: true } };
      },
    });

    const outcome = await dispatch({
      type: 'wire_gh',
      requestId: 'req-gate-throw',
    });

    expect(outcome).toEqual({ handled: true });
    expect(executeRan).toBe(false);
    const result = readResult('req-gate-throw');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(String(result!.message)).toMatch(/gate/i);
    // The audit row from checkTrustAndStage (written before the staging
    // throw) is fine to keep — forensics beat atomicity here.
    const rows = getDb()
      .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
      .all(agentName);
    expect(rows).toHaveLength(0);
  });
});
