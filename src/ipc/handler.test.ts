import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
import * as trustGate from './trust-gate.js';
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

  it('passes auth.auditSummary through to gateAndStage when set', async () => {
    // Spy on gateAndStage so we can pin what reaches the audit/trust path —
    // not just what the handler returned. This is the seam a regression like
    // `auth.auditSummary ?? auth.target` → `auth.auditSummary || auth.target`
    // would slip through if we only checked the handler's return value.
    const gateSpy = vi.spyOn(trustGate, 'gateAndStage');
    try {
      registerIpcHandler({
        type: 'summary_split_explicit',
        parse: () => ({}),
        authorize: () => ({
          target: 'task-42',
          auditSummary: 'forensic-summary-text',
          notifySummary: 'paused task task-42',
          payloadForStaging: { taskId: 'task-42' },
        }),
        execute: () => {},
      });
      const deps = fakeDeps();
      const ctx = buildContext('telegram_main', true, deps);
      await dispatchIpcAction({ type: 'summary_split_explicit' }, ctx);
      expect(gateSpy).toHaveBeenCalledTimes(1);
      const arg = gateSpy.mock.calls[0]![0];
      // The dispatcher should hand the explicit auditSummary to the gate as
      // `summary` — not the user-facing notify text.
      expect(arg.summary).toBe('forensic-summary-text');
      expect(arg.target).toBe('task-42');
    } finally {
      gateSpy.mockRestore();
    }
  });

  it('defaults gate.summary to auth.target when auditSummary is OMITTED (?? semantics, not ||)', async () => {
    // Critical: this test pins the `auth.auditSummary ?? auth.target` fallback
    // in handler.ts. A regression to `||` would still pass on undefined inputs
    // but would diverge for an explicit empty-string auditSummary (see the
    // empty-string test below).
    const gateSpy = vi.spyOn(trustGate, 'gateAndStage');
    try {
      registerIpcHandler({
        type: 'summary_default',
        parse: () => ({}),
        authorize: () => ({
          target: 'task-42',
          notifySummary: 'paused task task-42',
          payloadForStaging: { taskId: 'task-42' },
        }),
        execute: () => {},
      });
      const deps = fakeDeps();
      const ctx = buildContext('telegram_main', true, deps);
      await dispatchIpcAction({ type: 'summary_default' }, ctx);
      expect(gateSpy).toHaveBeenCalledTimes(1);
      expect(gateSpy.mock.calls[0]![0].summary).toBe('task-42');
      expect(gateSpy.mock.calls[0]![0].target).toBe('task-42');
    } finally {
      gateSpy.mockRestore();
    }
  });

  it('preserves an explicit empty-string auditSummary instead of falling back to target (?? not ||)', async () => {
    // This is the test that catches the `?? → ||` regression. With `??` the
    // empty string is preserved as the gate summary. With `||` it silently
    // becomes `target`. A reviewer-reported gap exactly like this is why we
    // pin the distinction.
    const gateSpy = vi.spyOn(trustGate, 'gateAndStage');
    try {
      registerIpcHandler({
        type: 'summary_empty_string',
        parse: () => ({}),
        authorize: () => ({
          target: 'task-42',
          auditSummary: '',
          notifySummary: 'paused task task-42',
          payloadForStaging: {},
        }),
        execute: () => {},
      });
      const deps = fakeDeps();
      const ctx = buildContext('telegram_main', true, deps);
      await dispatchIpcAction({ type: 'summary_empty_string' }, ctx);
      expect(gateSpy.mock.calls[0]![0].summary).toBe('');
    } finally {
      gateSpy.mockRestore();
    }
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

  it('publish_to_bus suppresses post-hoc notify when messageBus is unwired (executed=false)', async () => {
    // Pre-fix: handler returned void on null-bus, so the dispatcher fired the
    // notify saying "→ agentX@groupY: …" to the user even though no message
    // was actually written. The fix returns { executed: false } so the user
    // sees no notify for an action that didn't happen. Audit row is unaffected
    // (it was emitted upstream by the gate).
    const { publishToBusHandler } =
      await import('./handlers/publish-to-bus.js');
    registerIpcHandler(publishToBusHandler);
    const notifySpy = vi.spyOn(trustGate, 'fireNotifyIfRequested');
    try {
      const deps = fakeDeps({
        // No messageBus key → ctx.deps.messageBus is undefined → the no-bus
        // branch fires.
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
      const ctx = buildContext('telegram_main', true, deps);
      await dispatchIpcAction(
        {
          type: 'publish_to_bus',
          to_agent: 'marvin',
          to_group: 'telegram_main',
          topic: 'hello',
          summary: 'test summary',
          payload: {},
        },
        ctx,
      );
      // Notify must NOT have been called for the unwired-bus path.
      expect(notifySpy).not.toHaveBeenCalled();
    } finally {
      notifySpy.mockRestore();
    }
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

  it('routes auditTarget to gate.target while keeping auth.target for notify (schedule_task parity)', async () => {
    // Pins the dispatcher's `auth.auditTarget ?? auth.target` split so the gate
    // audit row references the group folder while the post-hoc notify still
    // mentions the new task id. Spying on gateAndStage AND fireNotifyIfRequested
    // verifies both halves of the split.
    const gateSpy = vi.spyOn(trustGate, 'gateAndStage');
    const notifySpy = vi.spyOn(trustGate, 'fireNotifyIfRequested');
    try {
      registerIpcHandler({
        type: 'target_split_pinned',
        parse: () => ({}),
        authorize: () => ({
          target: 'task-99', // notify points at the new task id
          auditTarget: 'group-folder', // gate audit row references the group
          notifySummary: "added task 'do the thing' (cron)",
          payloadForStaging: {},
        }),
        execute: () => {},
      });
      const deps = fakeDeps();
      const ctx = buildContext('telegram_main', true, deps);
      await dispatchIpcAction({ type: 'target_split_pinned' }, ctx);
      expect(gateSpy).toHaveBeenCalledTimes(1);
      // Audit path sees the override.
      expect(gateSpy.mock.calls[0]![0].target).toBe('group-folder');
      // Notify path (when called) sees the unsplit target.
      // For non-agent callers fireNotifyIfRequested still gets called by the
      // dispatcher with auth.target — it short-circuits internally on the null
      // agentName, but we can still inspect the args it received.
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy.mock.calls[0]![1].target).toBe('task-99');
    } finally {
      gateSpy.mockRestore();
      notifySpy.mockRestore();
    }
  });

  it('defaults gate.target to auth.target when auditTarget is OMITTED', async () => {
    const gateSpy = vi.spyOn(trustGate, 'gateAndStage');
    try {
      registerIpcHandler({
        type: 'target_default',
        parse: () => ({}),
        authorize: () => ({
          target: 'task-99',
          notifySummary: 'paused task task-99',
          payloadForStaging: {},
        }),
        execute: () => {},
      });
      const deps = fakeDeps();
      const ctx = buildContext('telegram_main', true, deps);
      await dispatchIpcAction({ type: 'target_default' }, ctx);
      expect(gateSpy.mock.calls[0]![0].target).toBe('task-99');
    } finally {
      gateSpy.mockRestore();
    }
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
