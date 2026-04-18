import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb, _initTestDatabase } from '../db.js';
import { insertLog } from '../proactive-log.js';
import { DeferredSendProcessor } from './deferred-send-processor.js';

beforeEach(() => {
  _initTestDatabase();
  getDb().prepare('DELETE FROM proactive_log').run();
});

describe('DeferredSendProcessor', () => {
  it('re-dispatches a due defer via the send callback', async () => {
    insertLog({
      timestamp: '2026-04-18T01:00:00Z',
      fromAgent: 'a',
      toGroup: 'jid:1',
      decision: 'defer',
      reason: 'quiet_hours',
      correlationId: 'd1',
      deliverAt: '2026-04-18T12:00:00Z',
      contributingEvents: [],
      messagePreview: 'hello',
    });
    const send = vi.fn();
    const p = new DeferredSendProcessor({
      send,
      now: () => new Date('2026-04-18T12:30:00Z'),
    });
    await p.poll();
    expect(send).toHaveBeenCalled();
    expect(send.mock.calls[0][0].correlationId).toBe('d1');
  });

  it('skips defers whose deliver_at is in the future', async () => {
    insertLog({
      timestamp: '2026-04-18T01:00:00Z',
      fromAgent: 'a',
      toGroup: 'jid:1',
      decision: 'defer',
      reason: 'quiet_hours',
      correlationId: 'd2',
      deliverAt: '2026-04-19T12:00:00Z',
      contributingEvents: [],
    });
    const send = vi.fn();
    const p = new DeferredSendProcessor({
      send,
      now: () => new Date('2026-04-18T12:30:00Z'),
    });
    await p.poll();
    expect(send).not.toHaveBeenCalled();
  });

  it('marks delivered_at when send resolves', async () => {
    const id = insertLog({
      timestamp: '2026-04-18T01:00:00Z',
      fromAgent: 'a',
      toGroup: 'jid:1',
      decision: 'defer',
      reason: 'quiet_hours',
      correlationId: 'd3',
      deliverAt: '2026-04-18T12:00:00Z',
      contributingEvents: [],
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const p = new DeferredSendProcessor({
      send,
      now: () => new Date('2026-04-18T12:30:00Z'),
    });
    await p.poll();
    const row = getDb()
      .prepare('SELECT * FROM proactive_log WHERE id = ?')
      .get(id) as any;
    expect(row.delivered_at).not.toBeNull();
  });

  it('does not mark delivered on send failure; will retry on next poll', async () => {
    const id = insertLog({
      timestamp: '2026-04-18T01:00:00Z',
      fromAgent: 'a',
      toGroup: 'jid:1',
      decision: 'defer',
      reason: 'quiet_hours',
      correlationId: 'd4',
      deliverAt: '2026-04-18T12:00:00Z',
      contributingEvents: [],
    });
    const send = vi.fn().mockRejectedValue(new Error('net fail'));
    const p = new DeferredSendProcessor({
      send,
      now: () => new Date('2026-04-18T12:30:00Z'),
    });
    await p.poll();
    const row = getDb()
      .prepare('SELECT * FROM proactive_log WHERE id = ?')
      .get(id) as any;
    expect(row.delivered_at).toBeNull();
  });
});
