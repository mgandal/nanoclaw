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
 * Dispatcher contract tests for `postHocNotify` (Batch 2F.1).
 *
 * Pins:
 *   1. On a result-kind handler with postHocNotify + decision.notify +
 *      success payload, sendMessage fires once and the notify text
 *      contains the auditActionType (override-aware).
 *   2. Autonomous trust (decision.notify=false) → no sendMessage.
 *   3. Bridge failure (result.success=false) → no sendMessage.
 *   4. Opt-out (no postHocNotify on auth) → no sendMessage, even with
 *      trust=notify. Regression guard for the `auth.postHocNotify &&`
 *      AND-chain.
 *   5. Ordering: result file lives on disk before sendMessage is awaited.
 *      Uses outer-scope capture (NOT throw-inside-spy — firePostHocNotify
 *      swallows spy throws at trust-notify.ts:46-53).
 *   5a. Bail (executed=false) → no sendMessage. Regression guard for the
 *       `executed &&` AND-chain.
 *   6. Contract violation: postHocNotify + skipGate → loud deny with
 *      `denied_contract_violation` audit row, no execute, no notify.
 */
describe('postHocNotify dispatcher behavior', () => {
  const SOURCE_GROUP = 'telegram_pn';
  const MAIN_JID = 'tg:pn-main';
  let dataDir: string;
  let deps: IpcDeps;
  let agentName: string;
  let agentDir: string;
  let sent: { jid: string; text: string }[];

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();

    setRegisteredGroup('tg:pn1', {
      name: 'PN',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: false,
    });
    setRegisteredGroup(MAIN_JID, {
      name: 'Main',
      folder: 'telegram_pnmain',
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    sent = [];
    deps = {
      sendMessage: async (jid, text) => {
        sent.push({ jid, text });
      },
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: 'telegram_pnmain',
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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-hoc-notify-'));

    agentName = `test-pn-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  const resultFile = (requestId: string, compoundSource?: string): string =>
    path.join(
      dataDir,
      'ipc',
      compoundSource ?? `${SOURCE_GROUP}--${agentName}`,
      'wire_x_results',
      `${requestId}.json`,
    );

  // ---- Test 1: success path with override ----

  it('1. postHocNotify + success + decision.notify → sendMessage once, with auditActionType in text', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    const handler: IpcHandler<
      { ok: boolean },
      { executed: true; result: unknown }
    > = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({
        executed: true,
        result: { success: true, message: 'ok' },
      }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-1' });

    expect(fs.existsSync(resultFile('req-1'))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(MAIN_JID);
    // Mirrors handler-action-type-override.test.ts:200-201.
    expect(sent[0].text).toContain('audit_x');
    expect(sent[0].text).not.toContain('wire_x');
  });

  // ---- Test 2: autonomous trust → no notify ----

  it('2. postHocNotify + success + autonomous trust → sendMessage NOT called', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: autonomous\n',
    );

    const handler: IpcHandler<
      { ok: boolean },
      { executed: true; result: unknown }
    > = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({ executed: true, result: { success: true } }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-2' });

    expect(fs.existsSync(resultFile('req-2'))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  // ---- Test 3: bridge failure → no notify ----

  it('3. postHocNotify + result.success=false → sendMessage NOT called', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    const handler: IpcHandler<
      { ok: boolean },
      { executed: true; result: unknown }
    > = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({
        executed: true,
        result: { success: false, message: 'bridge 500' },
      }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-3' });

    expect(fs.existsSync(resultFile('req-3'))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  // ---- Test 4: opt-out → no notify ----

  it('4. !postHocNotify + success + decision.notify → sendMessage NOT called (opt-in regression guard)', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    const handler: IpcHandler<
      { ok: boolean },
      { executed: true; result: unknown }
    > = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        // postHocNotify INTENTIONALLY OMITTED — pins that the
        // dispatcher's AND-chain requires the opt-in flag.
      }),
      execute: () => ({ executed: true, result: { success: true } }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-4' });

    expect(fs.existsSync(resultFile('req-4'))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  // ---- Test 5: ordering (file before notify) ----

  it('5. result file exists on disk before sendMessage is awaited', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    let fileExistedAtSpyEntry: boolean | null = null;
    // Replace sendMessage to capture file existence at spy-entry time.
    // Do NOT throw inside the spy — firePostHocNotify wraps sendMessage
    // in try/catch and would swallow the throw (trust-notify.ts:46-53).
    deps.sendMessage = async () => {
      fileExistedAtSpyEntry = fs.existsSync(resultFile('req-5'));
    };

    const handler: IpcHandler<
      { ok: boolean },
      { executed: true; result: unknown }
    > = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({ executed: true, result: { success: true } }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-5' });

    expect(fileExistedAtSpyEntry).toBe(true);
  });

  // ---- Test 5a: executed=false bail → no notify ----

  it('5a. postHocNotify + execute returns {executed: false} → sendMessage NOT called', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    const handler: IpcHandler<{ ok: boolean }, { executed: false }> = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({ executed: false }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-5a' });

    // Dispatcher writes synthetic failure payload (handler.ts:378) but
    // the postHocNotify executed-guard blocks the notify.
    expect(fs.existsSync(resultFile('req-5a'))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  // ---- Test 6: postHocNotify + skipGate → loud deny ----

  it('6. postHocNotify + skipGate → denied_contract_violation audit row, no execute, no notify', async () => {
    // Regression guard for the new postHocNotify+skipGate contract check
    // (Batch 2F.1, handler.ts authorize-time loud-deny).
    //
    // Note: wire_x is NOT on SKIP_GATE_ALLOWLIST. The off-allowlist
    // skipGate check at handler.ts:292-321 would catch this on its own.
    // The postHocNotify-specific loud-deny check is for the case where
    // a handler IS on SKIP_GATE_ALLOWLIST and accidentally combines the
    // two flags. We test wire_x here because it is the cleaner failure
    // mode (the new check fires whether or not the type is allowlisted).
    let executed = false;

    const handler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_x',
      // No responseKind — notify-kind. We do NOT actually want the
      // result-kind path to run; we want to prove the loud-deny fires
      // BEFORE the dispatcher reaches either branch.
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        skipGate: true,
        postHocNotify: true,
      }),
      execute: () => {
        executed = true;
        return undefined;
      },
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x' });

    expect(executed).toBe(false);
    expect(sent).toHaveLength(0);

    const rows = getDb()
      .prepare(
        'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('wire_x');
    expect(rows[0].outcome).toBe('denied_contract_violation');
  });

  // ---- Test 7: schedule_wakeup-style on-allowlist skipGate → execute runs ----

  it('7. on-allowlist handler with skipGate → execute runs, no denied_contract_violation', async () => {
    // Pins that SKIP_GATE_ALLOWLIST honors skipGate when the wire type is on
    // the list. This is the on-allowlist control: a handler whose type IS
    // 'schedule_wakeup' (allowlisted) and uses skipGate:true should execute
    // normally and produce NO denied_contract_violation row.
    let executed = false;

    const handler: IpcHandler<{ ok: boolean }, void> = {
      type: 'schedule_wakeup', // ON SKIP_GATE_ALLOWLIST per src/ipc/handler.ts
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'wu-stub',
        notifySummary: 'wakeup stub',
        payloadForStaging: { type: 'schedule_wakeup' },
        skipGate: true,
      }),
      execute: () => {
        executed = true;
        return undefined;
      },
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'schedule_wakeup' });

    expect(executed).toBe(true);

    const rows = getDb()
      .prepare(
        'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    // No denied_contract_violation row — the allowlist honored skipGate.
    expect(rows.map((r) => r.outcome)).not.toContain(
      'denied_contract_violation',
    );
  });

  // ---- Test 8: off-allowlist skipGate → denied_contract_violation ----

  it('8. off-allowlist handler with skipGate → denied_contract_violation, no execute', async () => {
    // Pins the off-allowlist branch of the skipGate check at handler.ts:292-321.
    // wire_off_allowlist is NOT on SKIP_GATE_ALLOWLIST; the dispatcher must
    // refuse skipGate, write denied_contract_violation, and skip execute.
    // This is the parallel control for Test 7 — confirms the allowlist
    // gate actually fires when the type is not listed.
    let executed = false;

    const handler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_off_allowlist',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-off',
        notifySummary: 'should never fire',
        payloadForStaging: { type: 'wire_off_allowlist' },
        skipGate: true,
      }),
      execute: () => {
        executed = true;
        return undefined;
      },
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_off_allowlist' });

    expect(executed).toBe(false);

    const rows = getDb()
      .prepare(
        'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('wire_off_allowlist');
    expect(rows[0].outcome).toBe('denied_contract_violation');
  });
});
