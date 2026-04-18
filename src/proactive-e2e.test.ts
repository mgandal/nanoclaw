/**
 * End-to-end smoke test for the proactive pipeline.
 *
 * Asserts the happy paths of the spec's acceptance criteria:
 *   - shadow mode (governor on, enabled off) → decision is logged but nothing sends
 *   - live mode (both on) → send happens, dispatched_at and delivered_at both set
 *
 * Deeper unit tests live in src/outbound-governor.test.ts and src/ipc.test.ts.
 * This file exists to catch integration regressions that only surface when
 * the config flags + governor + proactive_log chain are wired together.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getDb, _initTestDatabase } from './db.js';

const envSnapshot: Record<string, string | undefined> = {};
const KEYS = [
  'PROACTIVE_GOVERNOR',
  'PROACTIVE_ENABLED',
  'QUIET_HOURS_START',
  'QUIET_HOURS_END',
  'QUIET_DAYS_OFF',
];

beforeEach(() => {
  for (const k of KEYS) envSnapshot[k] = process.env[k];
  // Neutralize quiet hours so tests don't get surprised by weekends.
  process.env.QUIET_HOURS_START = '04:00';
  process.env.QUIET_HOURS_END = '04:01';
  process.env.QUIET_DAYS_OFF = 'Neverday';
  _initTestDatabase();
  getDb().prepare('DELETE FROM proactive_log').run();
});

afterEach(() => {
  for (const k of KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  vi.resetModules();
});

describe('proactive e2e', () => {
  it('shadow mode: governor on + enabled off → drop:kill_switch row, no send', async () => {
    process.env.PROACTIVE_GOVERNOR = 'true';
    process.env.PROACTIVE_ENABLED = 'false';
    vi.resetModules();
    const { _initTestDatabase: freshInit, getDb: freshGetDb } = await import(
      './db.js'
    );
    freshInit();
    freshGetDb().prepare('DELETE FROM proactive_log').run();
    const { deliverSendMessage } = await import('./ipc.js');
    const sendMessage = vi.fn();
    await deliverSendMessage(
      {
        chatJid: 'jid:lab',
        text: 'hello',
        proactive: true,
        correlationId: 'escalate:e2e:1',
        urgency: 0.5,
        ruleId: 'escalate',
        fromAgent: 'einstein',
        contributingEvents: [],
      } as Parameters<typeof deliverSendMessage>[0],
      { sendMessage } as Parameters<typeof deliverSendMessage>[1],
      'telegram_lab-claw',
    );
    expect(sendMessage).not.toHaveBeenCalled();
    const rows = freshGetDb()
      .prepare("SELECT * FROM proactive_log WHERE correlation_id = 'escalate:e2e:1'")
      .all() as { decision: string; reason: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('drop');
    expect(rows[0].reason).toBe('kill_switch');
  });

  it('live mode: governor on + enabled on → send + dispatched_at + delivered_at', async () => {
    process.env.PROACTIVE_GOVERNOR = 'true';
    process.env.PROACTIVE_ENABLED = 'true';
    vi.resetModules();
    const { _initTestDatabase: freshInit, getDb: freshGetDb } = await import(
      './db.js'
    );
    freshInit();
    freshGetDb().prepare('DELETE FROM proactive_log').run();
    const { deliverSendMessage } = await import('./ipc.js');
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await deliverSendMessage(
      {
        chatJid: 'jid:lab',
        text: 'hello',
        proactive: true,
        correlationId: 'escalate:e2e:2',
        urgency: 0.5,
        ruleId: 'escalate',
        fromAgent: 'einstein',
        contributingEvents: [],
      } as Parameters<typeof deliverSendMessage>[0],
      { sendMessage } as Parameters<typeof deliverSendMessage>[1],
      'telegram_lab-claw',
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const row = freshGetDb()
      .prepare("SELECT * FROM proactive_log WHERE correlation_id = 'escalate:e2e:2'")
      .get() as { dispatched_at: string | null; delivered_at: string | null };
    expect(row.dispatched_at).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
  });

  it('off mode: governor flag off → reactive path unchanged, no log row', async () => {
    process.env.PROACTIVE_GOVERNOR = 'false';
    vi.resetModules();
    const { _initTestDatabase: freshInit, getDb: freshGetDb } = await import(
      './db.js'
    );
    freshInit();
    freshGetDb().prepare('DELETE FROM proactive_log').run();
    const { deliverSendMessage } = await import('./ipc.js');
    const sendMessage = vi.fn();
    await deliverSendMessage(
      {
        chatJid: 'jid:lab',
        text: 'hello',
        proactive: true,
        correlationId: 'escalate:e2e:3',
        urgency: 0.5,
        ruleId: 'escalate',
        fromAgent: 'einstein',
        contributingEvents: [],
      } as Parameters<typeof deliverSendMessage>[0],
      { sendMessage } as Parameters<typeof deliverSendMessage>[1],
      'telegram_lab-claw',
    );
    expect(sendMessage).toHaveBeenCalled();
    const rows = freshGetDb()
      .prepare('SELECT COUNT(*) AS c FROM proactive_log')
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });
});
