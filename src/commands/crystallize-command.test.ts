import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  _getTestDb,
  insertCrystallizeCandidate,
  getCrystallizeCandidate,
} from '../db.js';
import {
  extractCrystallizeCommand,
  handleCrystallizeCommand,
} from './crystallize-command.js';

describe('extractCrystallizeCommand', () => {
  it('parses /crystallize-yes cc-aaa111', () => {
    expect(extractCrystallizeCommand('/crystallize-yes cc-aaa111')).toEqual({
      kind: 'yes',
      ccId: 'cc-aaa111',
    });
  });

  it('parses /crystallize-skip cc-bbb222', () => {
    expect(extractCrystallizeCommand('/crystallize-skip cc-bbb222')).toEqual({
      kind: 'skip',
      ccId: 'cc-bbb222',
    });
  });

  it('returns null on non-match', () => {
    expect(extractCrystallizeCommand('/approve cc-aaa111')).toBeNull();
    expect(extractCrystallizeCommand('/crystallize-yes garbage')).toBeNull();
    expect(extractCrystallizeCommand('plain text')).toBeNull();
  });

  // Mutation-pin: catches relaxation of cc-[a-z0-9]{6} length quantifier
  // (e.g. {6} -> +, or dropping the \b end-anchor).
  it('rejects ccIds with wrong length', () => {
    expect(extractCrystallizeCommand('/crystallize-yes cc-aaa')).toBeNull();
    expect(extractCrystallizeCommand('/crystallize-yes cc-aaa1112')).toBeNull();
  });
});

describe('handleCrystallizeCommand /crystallize-yes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  const seed = () => {
    const db = _getTestDb();
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111',
      agent: 'marvin',
      sourceGroup: 'telegram_ops-claw',
      sourceJid: 'tg:-1234',
      sessionId: 's',
      traceSummary: 'did stuff',
      toolSequence: '[]',
      contentHash: 'h',
      createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z',
    });
    return db;
  };

  it('yes happy path: marks accepted, inserts task row, propagates source_group', async () => {
    const db = seed();
    const createTask = vi.fn();
    const reply = await handleCrystallizeCommand(
      { kind: 'yes', ccId: 'cc-aaa111' },
      { db, createTask, now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('Scheduled body-gen');
    expect(reply).toContain('telegram_ops-claw');

    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.status).toBe('accepted');
    expect(row?.responded_at).toBe('2026-05-23T19:00:00Z');

    expect(createTask).toHaveBeenCalledOnce();
    const task = createTask.mock.calls[0][0];
    expect(task).toMatchObject({
      group_folder: 'telegram_ops-claw',
      chat_jid: 'tg:-1234',
      schedule_type: 'once',
      status: 'active',
      context_mode: 'isolated',
      agent_name: 'marvin',
    });
    expect(task.id).toMatch(/^crystallize-cc-aaa111-/);
    expect(task.prompt).toContain('cc-aaa111');
    expect(task.prompt).toContain('mcp__nanoclaw__crystallize_candidate_fetch');
    expect(task.prompt).toContain('not_found');
    expect(task.prompt).toContain('crystallize_skill');
    expect(task.prompt).toContain('Generalize');
  });

  it('yes on missing ccId returns error reply', async () => {
    const db = _getTestDb(); // empty db, no seed
    const reply = await handleCrystallizeCommand(
      { kind: 'yes', ccId: 'cc-missing' },
      { db, createTask: vi.fn(), now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('not found');
  });

  it('yes on expired returns error, no task created', async () => {
    const db = _getTestDb();
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111',
      agent: 'm',
      sourceGroup: 'g',
      sourceJid: 'j',
      sessionId: 's',
      traceSummary: 't',
      toolSequence: '[]',
      contentHash: 'h',
      createdAt: '2026-05-01T18:00:00Z',
      expiresAt: '2026-05-08T18:00:00Z', // already expired vs now=2026-05-23
    });
    const createTask = vi.fn();
    const reply = await handleCrystallizeCommand(
      { kind: 'yes', ccId: 'cc-aaa111' },
      { db, createTask, now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('expired');
    expect(createTask).not.toHaveBeenCalled();
    // Status should also be flipped to expired so we don't re-prompt.
    expect(getCrystallizeCandidate(db, 'cc-aaa111')?.status).toBe('expired');
  });

  it('yes on already-accepted returns error, no task created', async () => {
    const db = seed();
    db.prepare(
      `UPDATE crystallize_candidates SET status='accepted' WHERE id='cc-aaa111'`,
    ).run();
    const createTask = vi.fn();
    const reply = await handleCrystallizeCommand(
      { kind: 'yes', ccId: 'cc-aaa111' },
      { db, createTask, now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('not pending');
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('handleCrystallizeCommand /crystallize-skip', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('skip happy path', async () => {
    const db = _getTestDb();
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111',
      agent: 'm',
      sourceGroup: 'g',
      sourceJid: 'j',
      sessionId: 's',
      traceSummary: 't',
      toolSequence: '[]',
      contentHash: 'h',
      createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z',
    });
    const reply = await handleCrystallizeCommand(
      { kind: 'skip', ccId: 'cc-aaa111' },
      { db, createTask: vi.fn(), now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('Skipped');
    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.status).toBe('skipped');
  });

  it('skip on missing ccId returns error reply', async () => {
    const db = _getTestDb();
    const reply = await handleCrystallizeCommand(
      { kind: 'skip', ccId: 'cc-missing' },
      { db, createTask: vi.fn(), now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('not found');
  });

  it('skip on already-skipped returns error, no mutation', async () => {
    const db = _getTestDb();
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111',
      agent: 'm',
      sourceGroup: 'g',
      sourceJid: 'j',
      sessionId: 's',
      traceSummary: 't',
      toolSequence: '[]',
      contentHash: 'h',
      createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z',
    });
    db.prepare(
      `UPDATE crystallize_candidates SET status='skipped' WHERE id='cc-aaa111'`,
    ).run();
    const reply = await handleCrystallizeCommand(
      { kind: 'skip', ccId: 'cc-aaa111' },
      { db, createTask: vi.fn(), now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('not pending');
    // responded_at should be unchanged (no UPDATE on non-pending)
    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.status).toBe('skipped');
    expect(row?.responded_at).toBeNull();
  });
});
