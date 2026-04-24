import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { getGroupsWithActivity, getTasksWithStatus } from './sql.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL,
      container_config TEXT, requires_trigger INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0,
      permitted_senders TEXT
    );
    CREATE TABLE sessions (
      group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      last_used TEXT, created_at TEXT
    );
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT,
      channel TEXT, is_group INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT,
      timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0,
      reply_to_message_id TEXT, reply_to_message_content TEXT, reply_to_sender_name TEXT,
      PRIMARY KEY (id, chat_jid), FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL,
      next_run TEXT, last_run TEXT, last_result TEXT, status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL, context_mode TEXT DEFAULT 'isolated',
      script TEXT, agent_name TEXT, surface_outputs INTEGER DEFAULT 0, proactive INTEGER DEFAULT 0
    );
    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      run_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL,
      result TEXT, error TEXT, outcome_emitted INTEGER DEFAULT 0
    );
  `);
});

afterEach(() => { db.close(); });

describe('getGroupsWithActivity', () => {
  it('aggregates per-group last_active from compound session keys', () => {
    db.run("INSERT INTO registered_groups VALUES ('c1@g','CLAIRE','telegram_claire','','2026-01-01',NULL,0,1,NULL)");
    db.run("INSERT INTO sessions VALUES ('telegram_claire','sess1','2026-04-18T10:00:00Z','2026-04-01')");
    db.run("INSERT INTO sessions VALUES ('telegram_claire:jennifer','sess2','2026-04-19T11:00:00Z','2026-04-15')");
    db.run("INSERT INTO sessions VALUES ('telegram_claire:claire','sess3','2026-04-19T09:00:00Z','2026-04-10')");
    db.run("INSERT INTO chats VALUES ('c1@g','CLAIRE',NULL,'telegram',1)");
    db.run("INSERT INTO messages VALUES ('m1','c1@g','u','U','hi','2026-04-19T11:30:00Z',1,0,NULL,NULL,NULL)");

    const now = new Date('2026-04-19T12:00:00Z');
    const rows = getGroupsWithActivity(db, now);
    expect(rows).toHaveLength(1);
    expect(rows[0].folder).toBe('telegram_claire');
    expect(rows[0].display_name).toBe('CLAIRE');
    expect(rows[0].last_active_at).toBe('2026-04-19T11:00:00Z');
    expect(rows[0].messages_24h).toBe(1);
  });

  it('returns null last_active when no sessions match', () => {
    db.run("INSERT INTO registered_groups VALUES ('c1@g','G','telegram_science-claw','','2026-01-01',NULL,0,0,NULL)");
    db.run("INSERT INTO chats VALUES ('c1@g','G',NULL,'telegram',1)");
    const now = new Date('2026-04-19T12:00:00Z');
    const [row] = getGroupsWithActivity(db, now);
    expect(row.last_active_at).toBeNull();
    expect(row.messages_24h).toBe(0);
  });
});

describe('getTasksWithStatus', () => {
  it('returns tasks with status from latest task_run_logs row', () => {
    db.run("INSERT INTO scheduled_tasks (id,group_folder,chat_jid,prompt,schedule_type,schedule_value,next_run,last_run,last_result,status,created_at,context_mode,agent_name) VALUES ('t1','telegram_claire','c1@g','Do a thing','cron','0 9 * * 1-5','2026-04-20T09:00:00Z','2026-04-19T09:00:00Z','All good','active','2026-04-01','group','claire')");
    db.run("INSERT INTO task_run_logs (task_id,run_at,duration_ms,status,result) VALUES ('t1','2026-04-17T09:00:00Z',1000,'error',NULL)");
    db.run("INSERT INTO task_run_logs (task_id,run_at,duration_ms,status,result) VALUES ('t1','2026-04-18T09:00:00Z',1000,'success',NULL)");
    db.run("INSERT INTO task_run_logs (task_id,run_at,duration_ms,status,result) VALUES ('t1','2026-04-19T09:00:00Z',1000,'success','All good')");

    const now = new Date('2026-04-19T12:00:00Z');
    const rows = getTasksWithStatus(db, now);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('t1');
    expect(rows[0].last_status).toBe('success');
    expect(rows[0].success_7d).toEqual([2, 3]);
  });

  it('handles task with no run logs', () => {
    db.run("INSERT INTO scheduled_tasks (id,group_folder,chat_jid,prompt,schedule_type,schedule_value,next_run,last_run,last_result,status,created_at,context_mode) VALUES ('t2','g','c@g','p','cron','0 * * * *',NULL,NULL,NULL,'active','2026-04-01','group')");
    const now = new Date('2026-04-19T12:00:00Z');
    const [row] = getTasksWithStatus(db, now);
    expect(row.last_status).toBeNull();
    expect(row.success_7d).toEqual([0, 0]);
  });
});
