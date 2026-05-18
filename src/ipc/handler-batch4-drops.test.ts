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
  });
});
