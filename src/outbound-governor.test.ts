import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, _initTestDatabase } from './db.js';
import { insertLog, markDispatched, markDelivered } from './proactive-log.js';
import { decide, ProactiveSend, GovernorContext } from './outbound-governor.js';

function baseSend(o: Partial<ProactiveSend> = {}): ProactiveSend {
  return {
    fromAgent: 'einstein',
    toGroup: 'jid:1',
    message: 'test',
    urgency: 0.5,
    correlationId: 'escalate:test:abc',
    ruleId: 'escalate',
    contributingEvents: [],
    ...o,
  };
}

function defaultCtx(overrides: Partial<GovernorContext> = {}): GovernorContext {
  return {
    enabled: true,
    governorOn: true,
    isPaused: () => false,
    isInQuiet: () => false,
    nextQuietEnd: () => new Date('2026-04-15T12:00:00Z'),
    now: () => new Date('2026-04-15T14:00:00Z'),
    pauseFile: '/tmp/none',
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  getDb().prepare('DELETE FROM proactive_log').run();
});

describe('governor.decide', () => {
  it('kill_switch when disabled', () => {
    const r = decide(baseSend(), defaultCtx({ enabled: false }));
    expect(r.decision).toBe('drop');
    expect(r.reason).toBe('kill_switch');
  });

  it('paused when pause active', () => {
    const r = decide(baseSend(), defaultCtx({ isPaused: () => true }));
    expect(r.decision).toBe('drop');
    expect(r.reason).toBe('paused');
  });

  it('duplicate_recent when delivered within window', () => {
    const id = insertLog({
      timestamp: new Date(Date.now() - 3600_000).toISOString(),
      fromAgent: 'einstein',
      toGroup: 'jid:1',
      decision: 'send',
      reason: 'approved',
      correlationId: 'escalate:test:abc',
      contributingEvents: [],
    });
    markDispatched(id, new Date().toISOString());
    markDelivered(id, new Date().toISOString());
    const r = decide(baseSend(), defaultCtx({ now: () => new Date() }));
    expect(r.reason).toBe('duplicate_recent');
  });

  it('duplicate_recent also triggered by dispatched-but-not-delivered (in-flight)', () => {
    const id = insertLog({
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      fromAgent: 'einstein',
      toGroup: 'jid:1',
      decision: 'send',
      reason: 'approved',
      correlationId: 'escalate:test:abc',
      contributingEvents: [],
    });
    markDispatched(id, new Date().toISOString());
    const r = decide(baseSend(), defaultCtx({ now: () => new Date() }));
    expect(r.reason).toBe('duplicate_recent');
  });

  it('agent_cooldown defers when same agent sent recently', () => {
    insertLog({
      timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
      fromAgent: 'einstein',
      toGroup: 'jid:1',
      decision: 'send',
      reason: 'approved',
      correlationId: 'escalate:other:xyz',
      contributingEvents: [],
    });
    const r = decide(baseSend(), defaultCtx({ now: () => new Date() }));
    expect(r.decision).toBe('defer');
    expect(r.reason).toBe('agent_cooldown');
    expect(r.deliverAt).toBeDefined();
  });

  it('quiet_hours defers when outside window and urgency low', () => {
    const r = decide(
      baseSend({ urgency: 0.5 }),
      defaultCtx({
        isInQuiet: () => true,
        nextQuietEnd: () => new Date('2026-04-15T12:00:00Z'),
      }),
    );
    expect(r.decision).toBe('defer');
    expect(r.reason).toBe('quiet_hours');
    expect(r.deliverAt).toBe('2026-04-15T12:00:00.000Z');
  });

  it('sends when quiet but urgency meets threshold', () => {
    const r = decide(
      baseSend({ urgency: 0.9 }),
      defaultCtx({ isInQuiet: () => true }),
    );
    expect(r.decision).toBe('send');
    expect(r.reason).toBe('approved');
  });

  it('sends happy path', () => {
    const r = decide(baseSend(), defaultCtx());
    expect(r.decision).toBe('send');
    expect(r.reason).toBe('approved');
  });

  it('missing correlation_id drops', () => {
    const r = decide(baseSend({ correlationId: '' }), defaultCtx());
    expect(r.reason).toBe('missing_correlation_id');
  });

  it('every decision writes a proactive_log row with the correct fields', () => {
    const r = decide(baseSend(), defaultCtx());
    const rows = getDb()
      .prepare('SELECT COUNT(*) AS c FROM proactive_log')
      .get() as { c: number };
    expect(rows.c).toBe(1);
    const row = getDb()
      .prepare('SELECT * FROM proactive_log WHERE id = ?')
      .get(r.logId) as any;
    expect(row.from_agent).toBe('einstein');
    expect(row.decision).toBe('send');
    expect(row.reason).toBe('approved');
    expect(row.correlation_id).toBe('escalate:test:abc');
  });

  it('returns logId so caller can markDispatched / markDelivered', () => {
    const r = decide(baseSend(), defaultCtx());
    expect(typeof r.logId).toBe('number');
    expect(r.logId).toBeGreaterThan(0);
  });

  it('decision order: missing correlation beats kill_switch', () => {
    const r = decide(
      baseSend({ correlationId: '' }),
      defaultCtx({ enabled: false }),
    );
    expect(r.reason).toBe('missing_correlation_id');
  });

  it('decision order: kill_switch beats paused', () => {
    const r = decide(
      baseSend(),
      defaultCtx({ enabled: false, isPaused: () => true }),
    );
    expect(r.reason).toBe('kill_switch');
  });

  it('decision order: paused beats duplicate', () => {
    const id = insertLog({
      timestamp: new Date().toISOString(),
      fromAgent: 'einstein',
      toGroup: 'jid:1',
      decision: 'send',
      reason: 'approved',
      correlationId: 'escalate:test:abc',
      contributingEvents: [],
    });
    markDelivered(id, new Date().toISOString());
    const r = decide(
      baseSend(),
      defaultCtx({ isPaused: () => true, now: () => new Date() }),
    );
    expect(r.reason).toBe('paused');
  });
});
