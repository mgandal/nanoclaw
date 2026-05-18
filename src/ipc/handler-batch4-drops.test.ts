import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from '../db.js';
import { DATA_DIR } from '../config.js';
import { IpcDeps } from '../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
  type IpcHandler,
  type IpcHandlerContext,
} from './handler.js';

/**
 * Batch 4 dispatcher-observability pins. See
 * docs/superpowers/specs/2026-05-17-ipc-batch-4-dispatcher-observability-design.md
 * for the 10 F-finding resolutions this file enforces.
 */
describe('Batch 4 dispatcher drops', () => {
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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch4-drops-'));

    agentName = `test-batch4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  wire_z: autonomous\n',
    );
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
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

  describe('ctx.requestId binding', () => {
    it('T1: populates ctx.requestId for result-kind happy path', async () => {
      let capturedCtx: IpcHandlerContext | null = null;
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: (_input, ctx) => {
          capturedCtx = ctx;
          return {
            target: 'tgt',
            notifySummary: 'n',
            payloadForStaging: { type: 'wire_z' },
          };
        },
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);

      await dispatch({ type: 'wire_z', requestId: 'abc123' });

      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.requestId).toBe('abc123');
    });

    it('T2: leaves ctx.requestId null for notify-kind handler', async () => {
      let capturedCtx: IpcHandlerContext | null = null;
      const handler: IpcHandler<{ ok: boolean }, void> = {
        type: 'wire_z',
        // No responseKind → defaults to 'notify'
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: (_input, ctx) => {
          capturedCtx = ctx;
          return {
            target: 'tgt',
            notifySummary: 'n',
            payloadForStaging: { type: 'wire_z' },
          };
        },
        execute: () => undefined,
      };
      registerIpcHandler(handler);

      await dispatch({ type: 'wire_z', requestId: 'abc123' }); // requestId ignored for notify

      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.requestId).toBeNull();
    });

    it('T3: leaves ctx.requestId null on malformed-requestId rejection', async () => {
      let authorizeCalled = false;
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: () => {
          authorizeCalled = true;
          return null;
        },
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);

      const result = await dispatch({ type: 'wire_z', requestId: '!!malformed!!' });

      // Validation failed before authorize ran, so authorize was never called
      // and ctx.requestId was never set. We can't capture ctx here (authorize
      // didn't run), but the production code MUST not set ctx.requestId on
      // the dispatcher path until AFTER validation passes.
      // { handled: true } pins that the dispatcher took the malformed-requestId
      // reject branch (handler.ts:245), not the handler-not-found branch.
      expect(result).toEqual({ handled: true });
      expect(authorizeCalled).toBe(false);
    });
  });
});
