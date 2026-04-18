import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});

describe('proactive_log schema', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates proactive_log with required columns', () => {
    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info('proactive_log')")
      .all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'id',
        'timestamp',
        'from_agent',
        'to_group',
        'decision',
        'reason',
        'urgency',
        'rule_id',
        'correlation_id',
        'message_preview',
        'contributing_events',
        'deliver_at',
        'dispatched_at',
        'delivered_at',
        'reaction_kind',
        'reaction_value',
      ]),
    );
  });

  it('adds surface_outputs and proactive columns to scheduled_tasks', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('scheduled_tasks')")
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('surface_outputs');
    expect(names).toContain('proactive');
  });

  it('adds outcome_emitted to task_run_logs', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('task_run_logs')")
      .all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('outcome_emitted');
  });

  it('upgrades an existing DB missing the new columns', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-proactive-upgrade-'),
    );

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY,
          group_folder TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          next_run TEXT,
          last_run TEXT,
          last_result TEXT,
          status TEXT DEFAULT 'active',
          created_at TEXT NOT NULL
        );
        CREATE TABLE task_run_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          run_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT
        );
      `);
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getDb: getDbFresh, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const taskCols = getDbFresh()
        .prepare("PRAGMA table_info('scheduled_tasks')")
        .all() as { name: string }[];
      const taskNames = taskCols.map((c) => c.name);
      expect(taskNames).toContain('surface_outputs');
      expect(taskNames).toContain('proactive');

      const logCols = getDbFresh()
        .prepare("PRAGMA table_info('task_run_logs')")
        .all() as { name: string }[];
      expect(logCols.map((c) => c.name)).toContain('outcome_emitted');

      const proactiveCols = getDbFresh()
        .prepare("PRAGMA table_info('proactive_log')")
        .all() as { name: string }[];
      expect(proactiveCols.map((c) => c.name)).toContain('correlation_id');

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
