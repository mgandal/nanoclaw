import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb, setRegisteredGroup } from '../db.js';
import { DATA_DIR } from '../config.js';
import { IpcDeps } from '../ipc.js';
import { logger } from '../logger.js';
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

      const result = await dispatch({
        type: 'wire_z',
        requestId: '!!malformed!!',
      });

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

  describe('path B synthetic row (malformed requestId)', () => {
    const registerResultHandler = () => {
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: () => ({
          target: 'tgt',
          notifySummary: 'n',
          payloadForStaging: { type: 'wire_z' },
        }),
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);
    };

    const fetchDropRows = () =>
      getDb()
        .prepare(
          'SELECT trust_level, summary, target, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as Array<{
        trust_level: string;
        summary: string;
        target: string | null;
        outcome: string;
      }>;

    it('T4: writes row with trust_level=dispatch_drop_input', async () => {
      registerResultHandler();
      await dispatch({ type: 'wire_z', requestId: '!!bad!!' });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].trust_level).toBe('dispatch_drop_input');
    });

    it('T5: writes row with outcome=dropped_invalid_requestId', async () => {
      registerResultHandler();
      await dispatch({ type: 'wire_z', requestId: '!!bad!!' });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('dropped_invalid_requestId');
    });

    it('T6: writes row with summary "malformed requestId" (NO req= substring)', async () => {
      registerResultHandler();
      await dispatch({ type: 'wire_z', requestId: '!!bad!!' });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toBe('malformed requestId');
      expect(rows[0].summary).not.toContain('req=');
    });

    it('T7: skips row write when ctx.agentName is null', async () => {
      registerResultHandler();
      const errorSpy = vi
        .spyOn(logger, 'error')
        .mockImplementation(() => undefined);
      // Bare sourceGroup (no compound-key separator) → parseCompoundKey
      // returns {group: 'telegram_aud', agent: null}. F-O induction.
      await dispatch({ type: 'wire_z', requestId: '!!bad!!' }, SOURCE_GROUP);
      const rows = fetchDropRows();
      expect(rows).toHaveLength(0);
      // Mutation pin: if the agentName guard is removed, insertAgentAction
      // would throw a NOT NULL constraint and the helper's catch block would
      // log 'Failed to write synthetic drop audit row'. Asserting this DOESN'T
      // happen makes the test actually distinguish guard-fired from
      // guard-removed-but-DB-rejected. Without this, both paths produce 0 rows
      // and the test cannot detect the mutation.
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        'Failed to write synthetic drop audit row',
      );
    });
  });

  describe('path C synthetic row (parse rejected)', () => {
    const registerResultHandlerThatRejectsParse = () => {
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) => {
          if (
            typeof raw === 'object' &&
            raw !== null &&
            (raw as { badParse?: boolean }).badParse
          ) {
            return null;
          }
          return { ok: true };
        },
        authorize: () => ({
          target: 'tgt',
          notifySummary: 'n',
          payloadForStaging: { type: 'wire_z' },
        }),
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);
    };

    const fetchDropRows = () =>
      getDb()
        .prepare(
          'SELECT trust_level, summary, target, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as Array<{
        trust_level: string;
        summary: string;
        target: string | null;
        outcome: string;
      }>;

    it('T8: writes row with trust_level=dispatch_drop_input', async () => {
      registerResultHandlerThatRejectsParse();
      await dispatch({ type: 'wire_z', requestId: 'abc123', badParse: true });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].trust_level).toBe('dispatch_drop_input');
    });

    it('T9: writes row with outcome=dropped_invalid_input', async () => {
      registerResultHandlerThatRejectsParse();
      await dispatch({ type: 'wire_z', requestId: 'abc123', badParse: true });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('dropped_invalid_input');
    });

    it('T10: writes row with summary CONTAINING "req=abc123"', async () => {
      registerResultHandlerThatRejectsParse();
      await dispatch({ type: 'wire_z', requestId: 'abc123', badParse: true });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toContain('req=abc123');
      expect(rows[0].summary).toContain('parse rejected');
    });

    it('T11: skips row write when ctx.agentName is null', async () => {
      registerResultHandlerThatRejectsParse();
      const errorSpy = vi
        .spyOn(logger, 'error')
        .mockImplementation(() => undefined);
      await dispatch(
        { type: 'wire_z', requestId: 'abc123', badParse: true },
        SOURCE_GROUP,
      );
      const rows = fetchDropRows();
      expect(rows).toHaveLength(0);
      // Mutation pin: without this spy assertion, the test cannot distinguish
      // guard-fired from guard-removed-but-DB-rejected. The catch block fires
      // logger.error on NOT NULL constraint failure; asserting NOT-called proves
      // the guard prevented the write rather than the DB rejecting it.
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        'Failed to write synthetic drop audit row',
      );
    });
  });

  describe('path D invariant pin (F-I — authorize null preserves Rule 3 silent deny)', () => {
    it('T12: authorize-null with agent caller writes ZERO synthetic rows', async () => {
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: () => null, // polite-no per Rule 3
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);

      await dispatch({ type: 'wire_z', requestId: 'abc123' });

      // Strong assertion: ZERO drop rows for this agent. The agent_actions
      // table may have other rows from gate writes on other tests (shared
      // _initTestDatabase across files) but filter by unique agent_name +
      // outcome LIKE 'dropped_%'.
      const dropRows = getDb()
        .prepare(
          "SELECT COUNT(*) as c FROM agent_actions WHERE agent_name = ? AND outcome LIKE 'dropped_%'",
        )
        .get(agentName) as { c: number };
      expect(dropRows.c).toBe(0);
    });
  });
});
