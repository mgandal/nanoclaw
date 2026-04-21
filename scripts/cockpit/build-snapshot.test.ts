import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildSnapshot } from './build-snapshot.js';
import type { Snapshot } from './types.js';

describe('buildSnapshot (integration)', () => {
  let tmpVault: string;
  let tmpAgents: string;
  let tmpGroups: string;
  let tmpGlobal: string;
  let tmpCockpit: string;
  let db: Database;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    tmpAgents = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
    tmpGroups = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-'));
    tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'global-'));
    tmpCockpit = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-'));

    fs.mkdirSync(path.join(tmpVault, '99-wiki'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, '99-wiki', 'test.md'), '# test\nbody');

    fs.mkdirSync(path.join(tmpAgents, 'einstein'), { recursive: true });
    fs.writeFileSync(path.join(tmpAgents, 'einstein', 'memory.md'),
      '# Einstein\n## Standing Instructions\n- be concise\n## Watchlist\n- [Paper X](http://x) — note\n');

    fs.writeFileSync(path.join(tmpGlobal, 'current.md'),
      '# Current\n## Top 3\n1. First priority\n2. Second priority\n3. Third priority\n');

    db = new Database(':memory:');
    const DDL = [
      "CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL, container_config TEXT, requires_trigger INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0, permitted_senders TEXT)",
      "CREATE TABLE sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL, last_used TEXT, created_at TEXT)",
      "CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT, channel TEXT, is_group INTEGER DEFAULT 0)",
      "CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, reply_to_message_id TEXT, reply_to_message_content TEXT, reply_to_sender_name TEXT, PRIMARY KEY (id, chat_jid), FOREIGN KEY (chat_jid) REFERENCES chats(jid))",
      "CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL, prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL, next_run TEXT, last_run TEXT, last_result TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, context_mode TEXT DEFAULT 'isolated', script TEXT, agent_name TEXT, surface_outputs INTEGER DEFAULT 0, proactive INTEGER DEFAULT 0)",
      "CREATE TABLE task_run_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, outcome_emitted INTEGER DEFAULT 0)",
    ];
    for (const stmt of DDL) db.run(stmt);
    db.run("INSERT INTO registered_groups VALUES ('c1@g','CLAIRE','telegram_claire','','2026-01-01',NULL,0,1,NULL)");
    db.run("INSERT INTO chats VALUES ('c1@g','CLAIRE',NULL,'telegram',1)");
    db.run("INSERT INTO scheduled_tasks (id,group_folder,chat_jid,prompt,schedule_type,schedule_value,next_run,last_run,last_result,status,created_at,context_mode,agent_name) VALUES ('t1','telegram_claire','c1@g','Do a thing','cron','0 9 * * 1-5',NULL,NULL,NULL,'active','2026-04-01','group','claire')");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpVault, { recursive: true, force: true });
    fs.rmSync(tmpAgents, { recursive: true, force: true });
    fs.rmSync(tmpGroups, { recursive: true, force: true });
    fs.rmSync(tmpGlobal, { recursive: true, force: true });
    fs.rmSync(tmpCockpit, { recursive: true, force: true });
  });

  it('produces a valid Snapshot object matching the schema', () => {
    const now = new Date('2026-04-19T12:00:00Z');
    const snap: Snapshot = buildSnapshot({
      db,
      vaultPath: tmpVault,
      agentsDir: tmpAgents,
      groupsDir: tmpGroups,
      currentMdPath: path.join(tmpGlobal, 'current.md'),
      papersLogPath: path.join(tmpCockpit, 'papers-evaluated.jsonl'),
      emailsStatePath: path.join(tmpCockpit, 'gmail-sync-state.json'),
      blogsPath: path.join(tmpCockpit, 'blogs.json'),
      previousSnapshot: null,
      now,
    });

    expect(snap.schema_version).toBe(1);
    expect(snap.generated_at).toBe('2026-04-19T12:00:00.000Z');
    expect(snap.groups).toHaveLength(1);
    expect(snap.groups[0].folder).toBe('telegram_claire');
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0].schedule_human).toContain('9');
    expect(snap.priorities).toEqual(['First priority', 'Second priority', 'Third priority']);
    expect(snap.blogs).toBeNull();
    expect(snap.watchlists.some(w => w.scope === 'agent' && w.scope_name === 'einstein' && w.items.length === 1)).toBe(true);
    expect(snap.vault_pages_available.length).toBeGreaterThan(0);
  });
});
