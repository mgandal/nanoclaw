import { describe, it, expect, beforeEach } from 'vitest';

import { _getTestDb, _initTestDatabase } from './db.js';

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
    const rows = db
      .prepare(`SELECT id FROM crystallize_candidates`)
      .all();
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
