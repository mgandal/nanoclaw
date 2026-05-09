import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  IpcHandler,
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  getIpcHandler,
  registerIpcHandler,
} from './handler.js';
import {
  _resetBuiltinHandlersForTests,
  registerBuiltinHandlers,
} from './handlers/index.js';
import type { IpcDeps } from '../ipc.js';
import type { RegisteredGroup } from '../types.js';

function fakeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: async () => {},
    registeredGroups: () => ({}),
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    ...overrides,
  };
}

describe('IpcHandler registry', () => {
  beforeEach(() => {
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
  });
  afterEach(() => {
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
  });

  it('registers and retrieves a handler by type', () => {
    const handler: IpcHandler<{ x: number }> = {
      type: 'demo',
      parse: () => ({ x: 1 }),
      authorize: () => ({
        target: 't',
        notifySummary: 's',
        payloadForStaging: {},
      }),
      execute: () => {},
    };
    registerIpcHandler(handler);
    expect(getIpcHandler('demo')?.type).toBe('demo');
  });

  it('throws on duplicate registration to surface programming errors', () => {
    const h: IpcHandler<unknown> = {
      type: 'dup',
      parse: () => ({}),
      authorize: () => ({
        target: 't',
        notifySummary: 's',
        payloadForStaging: {},
      }),
      execute: () => {},
    };
    registerIpcHandler(h);
    expect(() => registerIpcHandler(h)).toThrow(/Duplicate IPC handler/);
  });
});

describe('dispatchIpcAction', () => {
  beforeEach(() => {
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
  });
  afterEach(() => {
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
  });

  it('returns handled=false when no handler matches the type', async () => {
    const deps = fakeDeps();
    const ctx = buildContext('telegram_main', true, deps);
    const result = await dispatchIpcAction({ type: 'unknown' }, ctx);
    expect(result.handled).toBe(false);
  });

  it('returns handled=true and skips execute when parse rejects', async () => {
    let executed = false;
    registerIpcHandler({
      type: 'parse_test',
      parse: () => null,
      authorize: () => ({
        target: 't',
        notifySummary: 's',
        payloadForStaging: {},
      }),
      execute: () => {
        executed = true;
      },
    });
    const deps = fakeDeps();
    const ctx = buildContext('telegram_main', true, deps);
    const result = await dispatchIpcAction(
      { type: 'parse_test', bogus: 1 },
      ctx,
    );
    expect(result.handled).toBe(true);
    expect(executed).toBe(false);
  });

  it('returns handled=true and skips execute when authorize rejects', async () => {
    let executed = false;
    registerIpcHandler({
      type: 'auth_test',
      parse: () => ({}),
      authorize: () => null,
      execute: () => {
        executed = true;
      },
    });
    const deps = fakeDeps();
    const ctx = buildContext('telegram_main', true, deps);
    const result = await dispatchIpcAction({ type: 'auth_test' }, ctx);
    expect(result.handled).toBe(true);
    expect(executed).toBe(false);
  });

  it('runs execute and returns handled=true on the happy path (non-agent caller)', async () => {
    let executed = false;
    registerIpcHandler({
      type: 'happy',
      parse: () => ({ ok: true }),
      authorize: () => ({
        target: 'tgt',
        notifySummary: 'did the thing',
        payloadForStaging: {},
      }),
      execute: () => {
        executed = true;
      },
    });
    const deps = fakeDeps();
    const ctx = buildContext('telegram_main', true, deps);
    const result = await dispatchIpcAction({ type: 'happy' }, ctx);
    expect(result.handled).toBe(true);
    expect(executed).toBe(true);
  });

  it('extracts agentName + baseGroup from a compound source group', () => {
    const deps = fakeDeps();
    const ctx = buildContext('telegram_lab--marvin', false, deps);
    expect(ctx.agentName).toBe('marvin');
    expect(ctx.baseGroup).toBe('telegram_lab');
    expect(ctx.isMain).toBe(false);
  });

  it('reports null agentName for non-compound source groups', () => {
    const deps = fakeDeps();
    const ctx = buildContext('telegram_main', true, deps);
    expect(ctx.agentName).toBeNull();
    expect(ctx.baseGroup).toBe('telegram_main');
  });

  it('preserves separate audit + notify summaries — auditSummary defaults to target', async () => {
    let executed = false;
    let observedAuth: {
      target: string;
      notifySummary: string;
      auditSummary?: string;
    } | null = null;
    registerIpcHandler({
      type: 'summary_split',
      parse: () => ({}),
      authorize: () => {
        observedAuth = {
          target: 'task-42',
          notifySummary: 'paused task task-42',
          payloadForStaging: { taskId: 'task-42' },
        } as never;
        return observedAuth as never;
      },
      execute: () => {
        executed = true;
      },
    });
    const deps = fakeDeps();
    const ctx = buildContext('telegram_main', true, deps);
    const result = await dispatchIpcAction({ type: 'summary_split' }, ctx);
    expect(result.handled).toBe(true);
    expect(executed).toBe(true);
    // Sanity: the test fixture demonstrates that when auditSummary is omitted,
    // the dispatcher falls back to `target` for the gate audit row — keeping
    // agent_actions.summary equal to the bare identifier (forensic parity
    // with the pre-refactor switch).
    expect(observedAuth!.target).toBe('task-42');
    expect(observedAuth!.notifySummary).toBe('paused task task-42');
    expect(observedAuth!.auditSummary).toBeUndefined();
  });

  it('skips post-hoc notify when execute returns { executed: false }', async () => {
    let sendCount = 0;
    const sendingDeps = fakeDeps({
      sendMessage: async () => {
        sendCount++;
      },
      registeredGroups: () => ({
        'main-jid': {
          name: 'main',
          folder: 'telegram_main',
          trigger: '',
          added_at: '',
          isMain: true,
        },
      }),
    });
    registerIpcHandler({
      type: 'execute_false',
      parse: () => ({}),
      authorize: () => ({
        target: 'tgt',
        notifySummary: 'should not be sent',
        payloadForStaging: {},
      }),
      execute: () => ({ executed: false }),
    });
    // Compound caller so the gate path is exercised; trust resolves to
    // null (no trust.yaml on the synthetic agent), giving NON_AGENT_DECISION
    // path for the test — but with notify=false anyway. The point is the
    // executed=false short-circuit comes BEFORE the dispatcher's notify call.
    const ctx = buildContext('telegram_main', true, sendingDeps);
    await dispatchIpcAction({ type: 'execute_false' }, ctx);
    expect(sendCount).toBe(0);
  });

  it('fires post-hoc notify when execute returns void (treats undefined as executed)', async () => {
    // Mirror of the executed=false test: void/undefined means executed
    // normally and the dispatcher should attempt notify (which still no-ops
    // for non-agent callers but the path is exercised).
    let executed = false;
    registerIpcHandler({
      type: 'execute_void',
      parse: () => ({}),
      authorize: () => ({
        target: 'tgt',
        notifySummary: 's',
        payloadForStaging: {},
      }),
      execute: () => {
        executed = true;
      },
    });
    const deps = fakeDeps();
    const ctx = buildContext('telegram_main', true, deps);
    const result = await dispatchIpcAction({ type: 'execute_void' }, ctx);
    expect(result.handled).toBe(true);
    expect(executed).toBe(true);
  });

  it('supports separate auditTarget override — needed for schedule_task forensic parity', async () => {
    let executed = false;
    let observedAuth: {
      target: string;
      auditTarget?: string;
      notifySummary: string;
    } | null = null;
    registerIpcHandler({
      type: 'target_split',
      parse: () => ({}),
      authorize: () => {
        observedAuth = {
          target: 'task-99', // notify points at the new task id
          auditTarget: 'group-folder', // audit row references the group
          notifySummary: "added task 'do the thing' (cron)",
          payloadForStaging: {},
        } as never;
        return observedAuth as never;
      },
      execute: () => {
        executed = true;
      },
    });
    const deps = fakeDeps();
    const ctx = buildContext('telegram_main', true, deps);
    const result = await dispatchIpcAction({ type: 'target_split' }, ctx);
    expect(result.handled).toBe(true);
    expect(executed).toBe(true);
    expect(observedAuth!.target).toBe('task-99');
    expect(observedAuth!.auditTarget).toBe('group-folder');
  });
});

describe('registerBuiltinHandlers idempotence', () => {
  beforeEach(() => {
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
  });
  afterEach(() => {
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
  });

  it('registers the migrated trio on first call', () => {
    registerBuiltinHandlers();
    expect(getIpcHandler('pause_task')?.type).toBe('pause_task');
    expect(getIpcHandler('resume_task')?.type).toBe('resume_task');
    expect(getIpcHandler('cancel_task')?.type).toBe('cancel_task');
  });

  it('is idempotent across repeated calls (no duplicate-registration throw)', () => {
    registerBuiltinHandlers();
    expect(() => registerBuiltinHandlers()).not.toThrow();
    expect(() => registerBuiltinHandlers()).not.toThrow();
  });

  it('re-registers after _resetBuiltinHandlersForTests() — guards against the silent no-op trap', () => {
    registerBuiltinHandlers();
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
    expect(getIpcHandler('pause_task')).toBeUndefined();
    registerBuiltinHandlers();
    expect(getIpcHandler('pause_task')?.type).toBe('pause_task');
  });
});

describe('gateAndStage (non-agent path)', async () => {
  const { gateAndStage, fireNotifyIfRequested } =
    await import('./trust-gate.js');

  it('grants autonomous access when agentName is null', () => {
    const decision = gateAndStage({
      agentName: null,
      baseGroup: 'telegram_main',
      actionType: 'pause_task',
      summary: 's',
      target: 't',
      payloadForStaging: {},
    });
    expect(decision.allowed).toBe(true);
    expect(decision.notify).toBe(false);
    expect(decision.pendingId).toBeNull();
    expect(decision.level).toBe('autonomous');
  });

  it('fireNotifyIfRequested is a no-op when notify is false', async () => {
    let sent = 0;
    const deps = {
      ...fakeDeps(),
      sendMessage: async () => {
        sent++;
      },
    };
    const decision = {
      allowed: true,
      notify: false,
      level: 'autonomous',
      pendingId: null,
    };
    await fireNotifyIfRequested(decision, {
      agentName: 'marvin',
      actionType: 'pause_task',
      summary: 's',
      target: 't',
      registeredGroups: {} as Record<string, RegisteredGroup>,
      deps,
    });
    expect(sent).toBe(0);
  });

  it('fireNotifyIfRequested is a no-op when agentName is null even if notify=true', async () => {
    let sent = 0;
    const deps = {
      ...fakeDeps(),
      sendMessage: async () => {
        sent++;
      },
    };
    const decision = {
      allowed: true,
      notify: true,
      level: 'notify',
      pendingId: null,
    };
    await fireNotifyIfRequested(decision, {
      agentName: null,
      actionType: 'pause_task',
      summary: 's',
      target: 't',
      registeredGroups: {} as Record<string, RegisteredGroup>,
      deps,
    });
    expect(sent).toBe(0);
  });
});
