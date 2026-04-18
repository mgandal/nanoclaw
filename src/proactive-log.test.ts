import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, getDb } from './db.js';
import {
  insertLog,
  hasDeliveredOrDispatchedRecent,
  getLastAgentSend,
  markDispatched,
  markDelivered,
  clearDispatch,
  getDueDefers,
  backfillReaction,
} from './proactive-log.js';

beforeEach(() => {
  _initTestDatabase();
  getDb().prepare('DELETE FROM proactive_log').run();
});

describe('proactive-log CRUD', () => {
  it('inserts and dedup finds delivered rows', () => {
    const id = insertLog({
      timestamp: new Date().toISOString(),
      fromAgent: 'a',
      toGroup: 'j',
      decision: 'send',
      reason: 'approved',
      correlationId: 'c1',
      contributingEvents: [],
    });
    markDispatched(id, new Date().toISOString());
    markDelivered(id, new Date().toISOString());
    expect(hasDeliveredOrDispatchedRecent('c1', 24)).toBe(true);
    expect(hasDeliveredOrDispatchedRecent('other', 24)).toBe(false);
  });

  it('hasDeliveredOrDispatchedRecent sees dispatched (mid-flight)', () => {
    const id = insertLog({
      timestamp: new Date().toISOString(),
      fromAgent: 'a',
      toGroup: 'j',
      decision: 'send',
      reason: 'approved',
      correlationId: 'c-flight',
      contributingEvents: [],
    });
    markDispatched(id, new Date().toISOString());
    // delivered_at still NULL — in flight
    expect(hasDeliveredOrDispatchedRecent('c-flight', 24)).toBe(true);
  });

  it('hasDeliveredOrDispatchedRecent ignores defers that never dispatched', () => {
    insertLog({
      timestamp: new Date().toISOString(),
      fromAgent: 'a',
      toGroup: 'j',
      decision: 'defer',
      reason: 'quiet_hours',
      correlationId: 'pending',
      deliverAt: new Date(Date.now() + 3600_000).toISOString(),
      contributingEvents: [],
    });
    expect(hasDeliveredOrDispatchedRecent('pending', 24)).toBe(false);
  });

  it('getLastAgentSend returns only send decisions', () => {
    insertLog({
      timestamp: new Date().toISOString(),
      fromAgent: 'ein',
      toGroup: 'j',
      decision: 'drop',
      reason: 'kill_switch',
      correlationId: 'x',
      contributingEvents: [],
    });
    const id = insertLog({
      timestamp: new Date().toISOString(),
      fromAgent: 'ein',
      toGroup: 'j',
      decision: 'send',
      reason: 'approved',
      correlationId: 'y',
      contributingEvents: [],
    });
    expect(getLastAgentSend('ein')?.id).toBe(id);
  });

  it('clearDispatch nulls dispatched_at', () => {
    const id = insertLog({
      timestamp: new Date().toISOString(),
      fromAgent: 'a',
      toGroup: 'j',
      decision: 'send',
      reason: 'approved',
      correlationId: 'c2',
      contributingEvents: [],
    });
    markDispatched(id, new Date().toISOString());
    clearDispatch(id);
    const row = getDb()
      .prepare('SELECT dispatched_at FROM proactive_log WHERE id = ?')
      .get(id) as { dispatched_at: string | null };
    expect(row.dispatched_at).toBeNull();
  });

  it('getDueDefers returns pending defers with deliver_at <= now', () => {
    insertLog({
      timestamp: '2026-04-18T01:00:00Z',
      fromAgent: 'a',
      toGroup: 'j',
      decision: 'defer',
      reason: 'quiet_hours',
      correlationId: 'd1',
      deliverAt: '2026-04-18T11:00:00Z',
      contributingEvents: [],
    });
    insertLog({
      timestamp: '2026-04-18T01:00:00Z',
      fromAgent: 'a',
      toGroup: 'j',
      decision: 'defer',
      reason: 'quiet_hours',
      correlationId: 'd2',
      deliverAt: '2026-04-19T11:00:00Z',
      contributingEvents: [],
    });
    const due = getDueDefers('2026-04-18T12:00:00Z');
    expect(due.map((r) => r.correlation_id)).toEqual(['d1']);
  });

  it('backfillReaction tags most recent matching send within 1h', () => {
    const ts = new Date(Date.now() - 30 * 60_000).toISOString();
    const id = insertLog({
      timestamp: ts,
      fromAgent: 'claire',
      toGroup: 'main',
      decision: 'send',
      reason: 'approved',
      correlationId: 'task:proactive-daily-review:2026-04-18',
      contributingEvents: [],
    });
    markDelivered(id, ts);
    expect(
      backfillReaction(
        'main',
        /^task:proactive-daily-review:/,
        'reply',
        'thanks',
      ),
    ).toBe(true);
    const row = getDb()
      .prepare('SELECT * FROM proactive_log WHERE id = ?')
      .get(id) as { reaction_kind: string; reaction_value: string };
    expect(row.reaction_kind).toBe('reply');
    expect(row.reaction_value).toBe('thanks');
  });

  it('backfillReaction returns false when no matching row', () => {
    expect(backfillReaction('main', /^task:nothing:/, 'reply', 'hi')).toBe(
      false,
    );
  });
});
