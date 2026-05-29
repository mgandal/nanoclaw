import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { scheduleWakeupHandler } from './schedule-wakeup.js';
import {
  _initTestDatabase,
  _getTestDb,
  createWakeupTask,
  getTaskById,
} from '../../db.js';
import type { IpcHandlerContext } from '../handler.js';

function buildCtx(
  overrides: Partial<IpcHandlerContext> = {},
): IpcHandlerContext {
  return {
    sourceGroup: 'telegram_claire',
    isMain: true,
    baseGroup: 'telegram_claire',
    agentName: 'claire',
    requestId: null,
    // RegisteredGroup is keyed by JID; the JID is the map key, not a field
    // on the value. The handler resolves chat_jid via Object.entries.
    registeredGroups: {
      '8475020901': {
        name: 'CLAIRE',
        folder: 'telegram_claire',
        trigger: '',
        added_at: new Date().toISOString(),
        isMain: true,
      },
    },
    deps: {
      onTasksChanged: () => {},
    } as any,
    dataDir: '/tmp/test',
    ...overrides,
  };
}

function getAuditRows(): Array<{
  action_type: string;
  outcome: string;
  summary: string;
}> {
  const db = _getTestDb();
  return db
    .prepare(
      "SELECT action_type, outcome, summary FROM agent_actions WHERE action_type='schedule_wakeup' ORDER BY created_at ASC",
    )
    .all() as Array<{ action_type: string; outcome: string; summary: string }>;
}

describe('scheduleWakeupHandler.parse', () => {
  it('returns null for non-object input', () => {
    expect(scheduleWakeupHandler.parse(null)).toBeNull();
    expect(scheduleWakeupHandler.parse(42)).toBeNull();
    expect(scheduleWakeupHandler.parse('string')).toBeNull();
  });

  it('returns null when both delay_minutes and fire_at are absent', () => {
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: 'check x',
      }),
    ).toBeNull();
  });

  it('returns null when both delay_minutes and fire_at are present', () => {
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: 'check x',
        delay_minutes: 30,
        fire_at: '2026-05-20T09:00:00',
      }),
    ).toBeNull();
  });

  it('returns null when prompt is absent, empty, or exceeds 4000 chars', () => {
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        delay_minutes: 30,
      }),
    ).toBeNull();
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: '',
        delay_minutes: 30,
      }),
    ).toBeNull();
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: 'x'.repeat(4001),
        delay_minutes: 30,
      }),
    ).toBeNull();
  });

  it('returns null when fire_at has Z or timezone-offset suffix (must be local time)', () => {
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: 'p',
        fire_at: '2026-05-20T09:00:00Z',
      }),
    ).toBeNull();
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: 'p',
        fire_at: '2026-05-20T09:00:00+05:00',
      }),
    ).toBeNull();
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: 'p',
        fire_at: '2026-05-20T09:00:00-08:00',
      }),
    ).toBeNull();
  });

  it('returns valid input with defaults for minimal payload', () => {
    const result = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc',
      prompt: 'check x',
      delay_minutes: 30,
    });
    expect(result).not.toBeNull();
    expect(result?.wakeupId).toBe('wu-1-abc');
    expect(result?.prompt).toBe('check x');
    expect(result?.delayMinutes).toBe(30);
    expect(result?.fireAt).toBeNull();
    expect(result?.contextBlob).toBeNull();
    expect(result?.contextMode).toBe('isolated');
    expect(result?.precomputedNextRun).toBeNull();
    expect(result?.chatJid).toBeNull();
  });
});

describe('scheduleWakeupHandler.authorize', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns null with no audit row when ctx.agentName is null', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc',
      prompt: 'p',
      delay_minutes: 30,
    })!;
    const result = scheduleWakeupHandler.authorize(
      input,
      buildCtx({ agentName: null }),
    );
    expect(result).toBeNull();
    expect(getAuditRows()).toHaveLength(0);
  });

  it('returns null and writes denied_rate_limit audit row when 10 active wakeups exist', () => {
    const now = new Date().toISOString();
    const next = new Date(Date.now() + 10 * 60_000).toISOString();
    for (let i = 0; i < 10; i++) {
      createWakeupTask({
        id: `wu-pre-${i}`,
        group_folder: 'telegram_claire',
        chat_jid: 'j',
        prompt: 'p',
        agent_name: 'claire',
        context_mode: 'isolated',
        next_run: next,
        created_at: now,
      });
    }
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-new',
      prompt: 'p',
      delay_minutes: 30,
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_rate_limit');
    expect(rows[0].summary).toContain('10/10');
  });

  it('returns null and writes denied_invalid_delay audit row when delay_minutes < 5', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc',
      prompt: 'p',
      delay_minutes: 3,
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_invalid_delay');
    expect(rows[0].summary).toContain('< 5');
  });

  it('returns null and writes denied_invalid_delay audit row when delay_minutes > 10080', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc',
      prompt: 'p',
      delay_minutes: 10081,
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_invalid_delay');
    expect(rows[0].summary).toContain('> 10080');
  });

  it('returns null and writes denied_invalid_delay audit row when fire_at resolves to < 5 min', () => {
    // Use a clearly-past local-time ISO string. Parsed as local time, this
    // resolves to a negative delta, which is also < MIN_DELAY_MINUTES and
    // exercises the same code path. Avoiding `toISOString().replace(/Z$/, '')`
    // — that constructs a UTC instant and strips the Z, but the handler then
    // parses it as local time, shifting it by the local UTC offset and
    // unintentionally landing well in the valid range in non-UTC zones.
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc',
      prompt: 'p',
      fire_at: '2020-01-01T00:00:00',
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_invalid_delay');
  });

  it('returns null and writes denied_no_chat_jid audit row when group not in registeredGroups', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc',
      prompt: 'p',
      delay_minutes: 30,
    })!;
    const result = scheduleWakeupHandler.authorize(
      input,
      buildCtx({ registeredGroups: {} }),
    );
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_no_chat_jid');
  });

  it('returns non-null IpcAuthorization with skipGate:true and resolves precomputedNextRun + chatJid', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc',
      prompt: 'p',
      delay_minutes: 30,
    })!;
    const auth = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(auth).not.toBeNull();
    expect(auth?.skipGate).toBe(true);
    expect(input.precomputedNextRun).not.toBeNull();
    expect(input.chatJid).toBe('8475020901');
    const ms = new Date(input.precomputedNextRun!).getTime() - Date.now();
    expect(ms).toBeGreaterThan(25 * 60_000);
    expect(ms).toBeLessThan(35 * 60_000);
    expect(getAuditRows()).toHaveLength(0);
  });
});

describe('scheduleWakeupHandler.execute', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates row with kind=agent_wakeup, status=active, schedule_type=once, script=NULL', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-exec-1',
      prompt: 'check inbox',
      delay_minutes: 30,
    })!;
    const ctx = buildCtx();
    scheduleWakeupHandler.authorize(input, ctx); // populates chatJid, precomputedNextRun
    scheduleWakeupHandler.execute(input, ctx);
    const row = getTaskById('wu-exec-1');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('agent_wakeup');
    expect(row?.status).toBe('active');
    expect(row?.schedule_type).toBe('once');
    expect(row?.script).toBeNull();
  });

  it('composes prompt with <wakeup-context> fence when contextBlob is set', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-exec-2',
      prompt: 'do thing',
      delay_minutes: 30,
      context_blob: 'STATE=foo',
    })!;
    const ctx = buildCtx();
    scheduleWakeupHandler.authorize(input, ctx);
    scheduleWakeupHandler.execute(input, ctx);
    const row = getTaskById('wu-exec-2');
    expect(row?.prompt).toBe(
      'do thing\n\n<wakeup-context>\nSTATE=foo\n</wakeup-context>',
    );
  });

  it('writes audit row with outcome=allowed, trust_level=skipGate AFTER INSERT succeeds', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-exec-3',
      prompt: 'p',
      delay_minutes: 30,
    })!;
    const ctx = buildCtx();
    scheduleWakeupHandler.authorize(input, ctx);
    scheduleWakeupHandler.execute(input, ctx);
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('allowed');
    // Pin: only one row, no phantom row from before-INSERT write.
    const db = _getTestDb();
    const all = db
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type='schedule_wakeup'",
      )
      .all();
    expect(all).toHaveLength(1);
  });

  it('calls deps.onTasksChanged after successful insert', () => {
    let called = 0;
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-exec-4',
      prompt: 'p',
      delay_minutes: 30,
    })!;
    const ctx = buildCtx({
      deps: {
        onTasksChanged: () => {
          called++;
        },
      } as any,
    });
    scheduleWakeupHandler.authorize(input, ctx);
    scheduleWakeupHandler.execute(input, ctx);
    expect(called).toBe(1);
  });
});

// ---- Integration tests via dispatchIpcAction ----
//
// Exercises the full dispatcher path (parse → authorize → execute) on a
// realistic registered IPC handler. Catches integration bugs that the unit
// tests miss: skip-gate allowlist coverage, registry wiring, and dispatcher
// audit-row writes on the rate-limit denial branch.

import {
  buildContext,
  dispatchIpcAction,
  _resetHandlersForTests,
} from '../handler.js';
import {
  registerBuiltinHandlers,
  _resetBuiltinHandlersForTests,
} from './index.js';
import { setRegisteredGroup } from '../../db.js';
import type { IpcDeps } from '../../ipc.js';

describe('scheduleWakeupHandler integration (via dispatchIpcAction)', () => {
  let deps: IpcDeps;
  let dataDir: string;
  let agentDir: string;
  let agentName: string;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
    registerBuiltinHandlers();

    setRegisteredGroup('8475020901', {
      name: 'CLAIRE',
      folder: 'telegram_claire',
      trigger: '',
      added_at: new Date().toISOString(),
      isMain: true,
    });

    deps = {
      db: _getTestDb(),
      sendMessage: async () => undefined,
      registeredGroups: () => ({
        '8475020901': {
          name: 'CLAIRE',
          folder: 'telegram_claire',
          trigger: '',
          added_at: new Date().toISOString(),
          isMain: true,
        },
      }),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    agentName = `wu-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-int-'));
    agentDir = path.join(dataDir, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  schedule_wakeup: autonomous\n',
    );
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
  });

  it('full dispatch with valid agent creates row + audit row outcome=allowed', async () => {
    const ctx = buildContext(
      `telegram_claire--${agentName}`,
      true,
      deps,
      dataDir,
    );
    const result = await dispatchIpcAction(
      {
        type: 'schedule_wakeup',
        wakeupId: 'wu-int-1',
        prompt: 'check inbox',
        delay_minutes: 30,
      },
      ctx,
    );
    expect(result.handled).toBe(true);
    const row = getTaskById('wu-int-1');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('agent_wakeup');
    expect(row?.script).toBeNull();
    const audits = getAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('allowed');
  });

  it('full dispatch with rate-limit-saturated state writes denied_rate_limit', async () => {
    const now = new Date().toISOString();
    const next = new Date(Date.now() + 10 * 60_000).toISOString();
    for (let i = 0; i < 10; i++) {
      createWakeupTask({
        id: `wu-pre-${i}`,
        group_folder: 'telegram_claire',
        chat_jid: '8475020901',
        prompt: 'p',
        agent_name: agentName,
        context_mode: 'isolated',
        next_run: next,
        created_at: now,
      });
    }
    const ctx = buildContext(
      `telegram_claire--${agentName}`,
      true,
      deps,
      dataDir,
    );
    const result = await dispatchIpcAction(
      {
        type: 'schedule_wakeup',
        wakeupId: 'wu-int-overflow',
        prompt: 'p',
        delay_minutes: 30,
      },
      ctx,
    );
    expect(result.handled).toBe(true);
    expect(getTaskById('wu-int-overflow')).toBeUndefined();
    const audits = getAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('denied_rate_limit');
  });

  it('rate limit enforced through compound-key roundtrip (11 dispatches, 11th denied)', async () => {
    // Regression guard: the existing rate-limit test (above) seeds rows via
    // createWakeupTask directly, which bypasses parseCompoundKey. If that
    // parser ever returns a different agent_name than what's stored, the
    // rate cap silently fails. This test drives all 11 wakeups through
    // dispatchIpcAction so creation AND counting use the same identity path.
    const ctx = buildContext(
      `telegram_claire--${agentName}`,
      true,
      deps,
      dataDir,
    );

    // Dispatch 10 valid wakeups — all should land.
    for (let i = 0; i < 10; i++) {
      const result = await dispatchIpcAction(
        {
          type: 'schedule_wakeup',
          wakeupId: `wu-roundtrip-${i}`,
          prompt: 'p',
          delay_minutes: 30,
        },
        ctx,
      );
      expect(result.handled).toBe(true);
    }

    // Confirm we're at the cap.
    const placedRows = _getTestDb()
      .prepare(
        "SELECT COUNT(*) AS cnt FROM scheduled_tasks WHERE kind='agent_wakeup' AND group_folder=? AND agent_name=?",
      )
      .get('telegram_claire', agentName) as { cnt: number };
    expect(placedRows.cnt).toBe(10);

    // The 11th should be denied.
    const result = await dispatchIpcAction(
      {
        type: 'schedule_wakeup',
        wakeupId: 'wu-roundtrip-11',
        prompt: 'p',
        delay_minutes: 30,
      },
      ctx,
    );
    expect(result.handled).toBe(true);
    expect(getTaskById('wu-roundtrip-11')).toBeUndefined();

    // Find the denied row in agent_actions.
    const deniedRow = _getTestDb()
      .prepare(
        "SELECT outcome FROM agent_actions WHERE action_type='schedule_wakeup' AND target=?",
      )
      .get('wu-roundtrip-11') as { outcome: string } | undefined;
    expect(deniedRow?.outcome).toBe('denied_rate_limit');
  });
});
