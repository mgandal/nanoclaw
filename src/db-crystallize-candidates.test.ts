import { describe, it, expect, beforeEach } from 'vitest';

import {
  _getTestDb,
  _initTestDatabase,
  countTodayCandidatesWithDm,
  getCrystallizeCandidate,
  insertCrystallizeCandidate,
  setCrystallizeCandidateDm,
  updateCrystallizeCandidateStatus,
} from './db.js';

describe('crystallize_candidates table', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('UNIQUE INDEX dedups (agent, content_hash, day)', () => {
    const db = _getTestDb();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO crystallize_candidates
        (id, agent, source_group, source_jid, session_id, trace_summary,
         tool_sequence, content_hash, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const now = '2026-05-23T18:00:00.000Z';
    const expires = '2026-05-30T18:00:00.000Z';
    const r1 = insert.run(
      'cc-aaa111',
      'marvin',
      'g',
      'j',
      's',
      't',
      '[]',
      'h1',
      now,
      expires,
    );
    const r2 = insert.run(
      'cc-bbb222',
      'marvin',
      'g',
      'j',
      's',
      't',
      '[]',
      'h1',
      now,
      expires,
    );
    expect(r1.changes).toBe(1);
    expect(r2.changes).toBe(0); // dedup
    const rows = db.prepare(`SELECT id FROM crystallize_candidates`).all();
    expect(rows).toHaveLength(1);
  });

  it('UNIQUE INDEX permits same hash on different day', () => {
    const db = _getTestDb();
    const insert = db.prepare(`INSERT OR IGNORE INTO crystallize_candidates
      (id, agent, source_group, source_jid, session_id, trace_summary,
       tool_sequence, content_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insert.run(
      'cc-1',
      'm',
      'g',
      'j',
      's',
      't',
      '[]',
      'h1',
      '2026-05-23T18:00:00Z',
      'x',
    );
    const r2 = insert.run(
      'cc-2',
      'm',
      'g',
      'j',
      's',
      't',
      '[]',
      'h1',
      '2026-05-24T18:00:00Z',
      'x',
    );
    expect(r2.changes).toBe(1);
  });

  it('UNIQUE INDEX permits same hash for different agents', () => {
    const db = _getTestDb();
    const insert = db.prepare(`INSERT OR IGNORE INTO crystallize_candidates
      (id, agent, source_group, source_jid, session_id, trace_summary,
       tool_sequence, content_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insert.run(
      'cc-1',
      'marvin',
      'g',
      'j',
      's',
      't',
      '[]',
      'h1',
      '2026-05-23T18:00:00Z',
      'x',
    );
    const r2 = insert.run(
      'cc-2',
      'einstein',
      'g',
      'j',
      's',
      't',
      '[]',
      'h1',
      '2026-05-23T18:00:00Z',
      'x',
    );
    expect(r2.changes).toBe(1);
  });
});

describe('crystallize_candidates helpers', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('insertCrystallizeCandidate returns true on insert, false on dedup', () => {
    const db = _getTestDb();
    const row = {
      id: 'cc-aaa111',
      agent: 'marvin',
      sourceGroup: 'g',
      sourceJid: 'j',
      sessionId: 's',
      traceSummary: 't',
      toolSequence: '[]',
      contentHash: 'h1',
      createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z',
    };
    expect(insertCrystallizeCandidate(db, row)).toBe(true);
    expect(insertCrystallizeCandidate(db, { ...row, id: 'cc-bbb222' })).toBe(
      false,
    );
  });

  it('getCrystallizeCandidate returns row or null', () => {
    const db = _getTestDb();
    expect(getCrystallizeCandidate(db, 'cc-missing')).toBeNull();
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111',
      agent: 'm',
      sourceGroup: 'g',
      sourceJid: 'j',
      sessionId: 's',
      traceSummary: 't',
      toolSequence: '[]',
      contentHash: 'h1',
      createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z',
    });
    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.agent).toBe('m');
    expect(row?.status).toBe('pending');
  });

  it('updateCrystallizeCandidateStatus mutates status + responded_at', () => {
    const db = _getTestDb();
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111',
      agent: 'm',
      sourceGroup: 'g',
      sourceJid: 'j',
      sessionId: 's',
      traceSummary: 't',
      toolSequence: '[]',
      contentHash: 'h1',
      createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z',
    });
    updateCrystallizeCandidateStatus(
      db,
      'cc-aaa111',
      'accepted',
      '2026-05-23T19:00:00Z',
    );
    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.status).toBe('accepted');
    expect(row?.responded_at).toBe('2026-05-23T19:00:00Z');
  });

  it('updateCrystallizeCandidateStatus preserves pending_action_id when omitted', () => {
    const db = _getTestDb();
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111',
      agent: 'm',
      sourceGroup: 'g',
      sourceJid: 'j',
      sessionId: 's',
      traceSummary: 't',
      toolSequence: '[]',
      contentHash: 'h1',
      createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z',
    });
    updateCrystallizeCandidateStatus(
      db,
      'cc-aaa111',
      'accepted',
      '2026-05-23T19:00:00Z',
      'pa-123',
    );
    updateCrystallizeCandidateStatus(
      db,
      'cc-aaa111',
      'crystallized',
      '2026-05-23T20:00:00Z',
    );
    expect(getCrystallizeCandidate(db, 'cc-aaa111')?.pending_action_id).toBe(
      'pa-123',
    );
  });

  it('setCrystallizeCandidateDm updates dm_message_id', () => {
    const db = _getTestDb();
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111',
      agent: 'm',
      sourceGroup: 'g',
      sourceJid: 'j',
      sessionId: 's',
      traceSummary: 't',
      toolSequence: '[]',
      contentHash: 'h1',
      createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z',
    });
    setCrystallizeCandidateDm(db, 'cc-aaa111', 'msg-id-xyz');
    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.dm_message_id).toBe('msg-id-xyz');
  });

  it('countTodayCandidatesWithDm counts only same-agent same-day dm-sent rows', () => {
    const db = _getTestDb();
    const today = '2026-05-23T18:00:00.000Z';
    const insertRaw = (
      id: string,
      agent: string,
      dmId: string | null,
      createdAt: string,
    ) =>
      db
        .prepare(
          `INSERT INTO crystallize_candidates
            (id, agent, source_group, source_jid, session_id, trace_summary,
             tool_sequence, content_hash, dm_message_id, created_at, expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, agent, 'g', 'j', 's', 't', '[]', id, dmId, createdAt, 'x');
    insertRaw('cc-1', 'marvin', 'm1', today);
    insertRaw('cc-2', 'marvin', 'm2', today);
    insertRaw('cc-3', 'marvin', null, today); // no DM, not counted
    insertRaw('cc-4', 'einstein', 'm4', today); // different agent
    insertRaw('cc-5', 'marvin', 'm5', '2026-05-22T18:00:00Z'); // yesterday
    expect(countTodayCandidatesWithDm(db, 'marvin', today)).toBe(2);
  });
});
