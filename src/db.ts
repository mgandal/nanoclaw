import { Database } from 'bun:sqlite';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database;

function createSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
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
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE INDEX IF NOT EXISTS idx_messages_chat_rowid ON messages(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_tasks_group ON scheduled_tasks(group_folder);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      last_used TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Helper: add a column if it doesn't exist (SQLite throws on duplicate)
  const addColumn = (sql: string): boolean => {
    try {
      database.exec(sql);
      return true;
    } catch {
      return false;
    }
  };

  addColumn(
    `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
  );
  addColumn(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  addColumn(`ALTER TABLE sessions ADD COLUMN last_used TEXT`);
  addColumn(`ALTER TABLE sessions ADD COLUMN created_at TEXT`);

  if (
    addColumn(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    )
  ) {
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  }

  if (
    addColumn(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    )
  ) {
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  }

  if (addColumn(`ALTER TABLE chats ADD COLUMN channel TEXT`)) {
    addColumn(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastSeq: number,
  botPrefix: string,
  limit: number = 200,
): { messages: (NewMessage & { seq: number })[]; newSeq: number } {
  if (jids.length === 0) return { messages: [], newSeq: lastSeq };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Uses rowid as a monotonic sequence to avoid skipping messages with equal timestamps.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT rowid as seq, id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE rowid > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY rowid DESC
      LIMIT ?
    ) ORDER BY seq
  `;

  const rows = db
    .prepare(sql)
    .all(lastSeq, ...jids, `${botPrefix}:%`, limit) as (NewMessage & {
    seq: number;
  })[];

  let newSeq = lastSeq;
  for (const row of rows) {
    if (row.seq > newSeq) newSeq = row.seq;
  }

  return { messages: rows, newSeq };
}

export function getMessagesSince(
  chatJid: string,
  sinceSeq: number,
  botPrefix: string,
  limit: number = 200,
): (NewMessage & { seq: number })[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Uses rowid as a monotonic sequence to avoid skipping messages with equal timestamps.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT rowid as seq, id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ? AND rowid > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY rowid DESC
      LIMIT ?
    ) ORDER BY seq
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceSeq, `${botPrefix}:%`, limit) as (NewMessage & {
    seq: number;
  })[];
}

/**
 * Recover the cursor (rowid) of the last bot reply for a chat.
 * Used when lastAgentSeq is missing (new group, corrupted state, startup
 * recovery) to avoid sending the entire message history to the agent.
 * Returns 0 if no bot message exists.
 */
export function getLastBotMessageSeq(chatJid: string): number {
  const row = db
    .prepare(
      `SELECT MAX(rowid) as seq FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1`,
    )
    .get(chatJid) as { seq: number | null } | undefined;
  return row?.seq ?? 0;
}

/**
 * Validate a cron expression and ensure it doesn't fire too frequently.
 * Minimum interval: 30 minutes. Rejects expressions that would burn tokens.
 */
function validateCronSchedule(cronExpr: string): void {
  const interval = CronExpressionParser.parse(cronExpr);
  const first = interval.next().getTime();
  const second = interval.next().getTime();
  const gapMs = second - first;
  const MIN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  if (gapMs < MIN_INTERVAL_MS) {
    const gapMin = Math.round(gapMs / 60000);
    throw new Error(
      `Cron "${cronExpr}" fires every ${gapMin} minute(s). ` +
        `Minimum allowed interval is 30 minutes. ` +
        `If you meant hours, use 5-field cron (min hour dom mon dow).`,
    );
  }
}

/**
 * Validate a task schedule. Throws on invalid or too-frequent schedules.
 * Minimum interval: 30 minutes.
 */
export function validateTaskSchedule(
  scheduleType: string,
  scheduleValue: string,
): void {
  if (scheduleType === 'cron') {
    validateCronSchedule(scheduleValue);
  }
  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms < 30 * 60 * 1000) {
      throw new Error(
        `Interval ${scheduleValue}ms is too frequent. Minimum: 30 minutes (1800000ms).`,
      );
    }
  }
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  validateTaskSchedule(task.schedule_type, task.schedule_value);

  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return (db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) ??
    undefined) as ScheduledTask | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function getRecentMessages(
  groupFolder: string,
  limit: number = 10,
): Array<{ sender: string; content: string; timestamp: string }> {
  return db
    .prepare(
      `SELECT m.sender, m.content, m.timestamp
       FROM messages m
       JOIN registered_groups rg ON m.chat_jid = rg.jid
       WHERE rg.folder = ?
       ORDER BY m.timestamp DESC
       LIMIT ?`,
    )
    .all(groupFolder, limit) as Array<{
    sender: string;
    content: string;
    timestamp: string;
  }>;
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

/** Get task run logs since a given ISO timestamp, ordered by run_at ascending. */
export function getTaskRunLogs(since: string): TaskRunLog[] {
  return db
    .prepare(
      'SELECT * FROM task_run_logs WHERE run_at >= ? ORDER BY run_at ASC',
    )
    .all(since) as TaskRunLog[];
}

/** Get success rate for a task over the last N days. */
export function getTaskSuccessRate(
  taskId: string,
  days: number,
): { total: number; passed: number } {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db
    .prepare(
      'SELECT status FROM task_run_logs WHERE task_id = ? AND run_at >= ? ORDER BY run_at DESC',
    )
    .all(taskId, since) as { status: string }[];
  return {
    total: rows.length,
    passed: rows.filter((r) => r.status === 'success').length,
  };
}

/** Count consecutive failures from the most recent run backwards. Stops at first success or LIMIT 20. */
export function getConsecutiveFailures(taskId: string): number {
  const rows = db
    .prepare(
      'SELECT status FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 20',
    )
    .all(taskId) as { status: string }[];
  let count = 0;
  for (const row of rows) {
    if (row.status !== 'error') break;
    count++;
  }
  return count;
}

/** Get the ISO timestamp of the most recent successful run for a task, or null if none. */
export function getLastSuccessTime(taskId: string): string | null {
  const row = db
    .prepare(
      "SELECT run_at FROM task_run_logs WHERE task_id = ? AND status = 'success' ORDER BY run_at DESC LIMIT 1",
    )
    .get(taskId) as { run_at: string } | undefined;
  return row?.run_at ?? null;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  const now = new Date().toISOString();
  // Preserve created_at if session row already exists (session ID changed but session continues).
  // Wrapped in a transaction to prevent read-modify-write race on created_at.
  db.transaction(() => {
    const existing = db
      .prepare('SELECT created_at FROM sessions WHERE group_folder = ?')
      .get(groupFolder) as { created_at: string | null } | undefined;
    const createdAt = existing?.created_at || now;
    db.prepare(
      'INSERT OR REPLACE INTO sessions (group_folder, session_id, last_used, created_at) VALUES (?, ?, ?, ?)',
    ).run(groupFolder, sessionId, now, createdAt);
  })();
}

export function touchSession(groupFolder: string): void {
  db.prepare('UPDATE sessions SET last_used = ? WHERE group_folder = ?').run(
    new Date().toISOString(),
    groupFolder,
  );
}

export function getSessionTimestamps(groupFolder: string): {
  lastUsed?: string;
  createdAt?: string;
} {
  const row = db
    .prepare(
      'SELECT last_used, created_at FROM sessions WHERE group_folder = ?',
    )
    .get(groupFolder) as
    | { last_used: string | null; created_at: string | null }
    | undefined;
  return {
    lastUsed: row?.last_used ?? undefined,
    createdAt: row?.created_at ?? undefined,
  };
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const filesToRename: { from: string; to: string }[] = [];

  const readJsonFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      filesToRename.push({ from: filePath, to: `${filePath}.migrated` });
      return data;
    } catch {
      return null;
    }
  };

  const routerState = readJsonFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  const sessions = readJsonFile('sessions.json') as Record<
    string,
    string
  > | null;
  const groups = readJsonFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;

  if (!routerState && !sessions && !groups) return;

  // All DB writes in a single transaction — files only renamed after commit
  const migrate = db.transaction(() => {
    if (routerState) {
      if (routerState.last_timestamp) {
        setRouterState('last_timestamp', routerState.last_timestamp);
      }
      if (routerState.last_agent_timestamp) {
        setRouterState(
          'last_agent_timestamp',
          JSON.stringify(routerState.last_agent_timestamp),
        );
      }
    }

    if (sessions) {
      for (const [folder, sessionId] of Object.entries(sessions)) {
        setSession(folder, sessionId);
      }
    }

    if (groups) {
      for (const [jid, group] of Object.entries(groups)) {
        try {
          setRegisteredGroup(jid, group);
        } catch (err) {
          logger.warn(
            { jid, folder: group.folder, err },
            'Skipping migrated registered group with invalid folder',
          );
        }
      }
    }
  });

  migrate();

  // Only rename source files after DB commit succeeded
  for (const { from, to } of filesToRename) {
    fs.renameSync(from, to);
  }
}
