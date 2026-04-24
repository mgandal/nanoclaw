// Task-table operations — the single source of truth for Mike's task list.
// Called via IPC from container agents (task_add / task_list / task_close)
// and by host-side scripts (bulk migration, renderers).
//
// Schema lives in src/db.ts (`CREATE TABLE tasks`, added in Phase A).

import type { Database } from 'bun:sqlite';

import { getDb } from './db.js';
import { logger } from './logger.js';

export type TaskStatus = 'open' | 'done' | 'archived';

export interface TaskRow {
  id: number;
  title: string;
  context: string | null;
  owner: string | null;
  priority: number;
  due_date: string | null;
  status: TaskStatus;
  source: string;
  source_ref: string | null;
  group_folder: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskAddInput {
  title: string;
  context?: string;
  owner?: string;
  priority?: number;
  due_date?: string;
  source?: string;
  source_ref?: string;
  group_folder?: string;
  /** When true, bypass case-insensitive dedup against open tasks. */
  force?: boolean;
}

export interface TaskAddResult {
  success: boolean;
  id?: number;
  error?: string;
  duplicate_of?: number;
}

export interface TaskListInput {
  status?: TaskStatus | 'all';
  owner?: string;
  due_before?: string;
  group_folder?: string;
  limit?: number;
}

export interface TaskListResult {
  tasks: TaskRow[];
  count: number;
  /** True when count === limit, so callers know more rows may exist. */
  truncated: boolean;
  limit: number;
}

export interface TaskCloseInput {
  id?: number;
  title_match?: string;
  outcome: 'done' | 'archived';
  reason?: string;
  callerGroup: string;
  callerIsMain: boolean;
}

export interface TaskCloseResult {
  success: boolean;
  matched?: number;
  status?: 'done' | 'archived';
  completed_at?: string;
  error?: string;
  candidates?: Array<{
    id: number;
    title: string;
    group_folder: string | null;
  }>;
}

function db(): Database {
  return getDb();
}

// --- task_add -----------------------------------------------------------

export function addTask(input: TaskAddInput): TaskAddResult {
  const title = input.title?.trim();
  if (!title) {
    return { success: false, error: 'title is required' };
  }

  const owner = input.owner ? input.owner.trim().toLowerCase() : 'mike';
  const priority = input.priority ?? 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
    return { success: false, error: 'priority must be integer 1-4' };
  }
  const source = input.source ?? 'manual';
  // Match schema CHECK: 'manual' | email/slack/scheduled-task | migration-*
  const sourceValid =
    source === 'manual' ||
    source === 'email' ||
    source === 'slack' ||
    source === 'scheduled-task' ||
    source.startsWith('migration-');
  if (!sourceValid) {
    return {
      success: false,
      error: `source must be one of manual|email|slack|scheduled-task|migration-*, got ${source}`,
    };
  }

  // Dedup: case-insensitive match on open tasks unless force=true.
  if (!input.force) {
    const existing = db()
      .query(
        "SELECT id FROM tasks WHERE lower(title) = lower(?) AND status = 'open' LIMIT 1",
      )
      .get(title) as { id: number } | undefined;
    if (existing) {
      return {
        success: false,
        error: 'duplicate: an open task with this title already exists',
        duplicate_of: existing.id,
      };
    }
  }

  try {
    const result = db()
      .query(
        `INSERT INTO tasks (title, context, owner, priority, due_date, source, source_ref, group_folder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        title,
        input.context ?? null,
        owner,
        priority,
        input.due_date ?? null,
        source,
        input.source_ref ?? null,
        input.group_folder ?? null,
      ) as { id: number };
    return { success: true, id: result.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The partial unique index on lower(title) WHERE status='open' catches
    // the SELECT-then-INSERT race that slipped past the explicit dedup check.
    // Surface it as a normal duplicate response, not a generic SQL error.
    if (/UNIQUE constraint failed.*idx_tasks_open_title/i.test(msg)) {
      const existing = db()
        .query(
          "SELECT id FROM tasks WHERE lower(title) = lower(?) AND status = 'open' LIMIT 1",
        )
        .get(title) as { id: number } | undefined;
      return {
        success: false,
        error: 'duplicate: an open task with this title already exists',
        duplicate_of: existing?.id,
      };
    }
    logger.error({ err, input }, 'addTask failed');
    return { success: false, error: msg };
  }
}

// --- task_list -----------------------------------------------------------

export function listTasksDetailed(input: TaskListInput): TaskListResult {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  const rows = listTasks(input);
  return {
    tasks: rows,
    count: rows.length,
    truncated: rows.length === limit,
    limit,
  };
}

export function listTasks(input: TaskListInput): TaskRow[] {
  const status = input.status ?? 'open';
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (status !== 'all') {
    clauses.push('status = ?');
    params.push(status);
  }
  if (input.owner) {
    clauses.push('owner = ?');
    params.push(input.owner.toLowerCase());
  }
  if (input.due_before) {
    clauses.push('due_date IS NOT NULL AND due_date <= ?');
    params.push(input.due_before);
  }
  if (input.group_folder) {
    clauses.push('group_folder = ?');
    params.push(input.group_folder);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));

  // Order: overdue (due_date <= today) first, then by priority desc, then due_date asc, then id.
  const sql = `
    SELECT id, title, context, owner, priority, due_date, status, source, source_ref,
           group_folder, created_at, updated_at, completed_at
    FROM tasks
    ${where}
    ORDER BY
      CASE WHEN due_date IS NOT NULL AND due_date <= date('now') THEN 0 ELSE 1 END,
      priority DESC,
      CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
      due_date ASC,
      id ASC
    LIMIT ?
  `;
  params.push(limit);

  return db()
    .query(sql)
    .all(...(params as (string | number)[])) as TaskRow[];
}

// --- task_close ----------------------------------------------------------

export function closeTask(input: TaskCloseInput): TaskCloseResult {
  if (input.outcome !== 'done' && input.outcome !== 'archived') {
    return { success: false, error: "outcome must be 'done' or 'archived'" };
  }
  if (!input.id && !input.title_match) {
    return { success: false, error: 'id or title_match required' };
  }

  // Resolve target task(s).
  let rows: Array<{ id: number; title: string; group_folder: string | null }>;
  if (input.id) {
    rows = db()
      .query(
        "SELECT id, title, group_folder FROM tasks WHERE id = ? AND status = 'open'",
      )
      .all(input.id) as typeof rows;
  } else {
    const q = `%${input.title_match!.toLowerCase()}%`;
    // LIMIT 50: cap scan/response size so a permissive title_match like 'a'
    // cannot return the entire table as candidates.
    rows = db()
      .query(
        "SELECT id, title, group_folder FROM tasks WHERE lower(title) LIKE ? AND status = 'open' ORDER BY id LIMIT 50",
      )
      .all(q) as typeof rows;
  }

  if (rows.length === 0) {
    return { success: false, error: 'no open task matches' };
  }
  if (rows.length > 1) {
    return {
      success: false,
      error: 'ambiguous match',
      candidates: rows.slice(0, 20),
    };
  }

  const target = rows[0];

  // Auth: caller must be main, OR task group_folder matches caller, OR task is global (NULL).
  const allowed =
    input.callerIsMain ||
    target.group_folder === null ||
    target.group_folder === input.callerGroup;
  if (!allowed) {
    logger.warn(
      {
        taskId: target.id,
        taskGroup: target.group_folder,
        callerGroup: input.callerGroup,
      },
      'task_close: auth denied (caller is not creator/main)',
    );
    return {
      success: false,
      error:
        'not authorized: only the creator group or main may close this task',
    };
  }

  const now = new Date().toISOString();
  const newContext = input.reason
    ? `[closed: ${input.reason.slice(0, 200)}]`
    : null;

  // Double-close guard via WHERE status='open'.
  const updated = db()
    .query(
      `UPDATE tasks
         SET status = ?, completed_at = ?,
             context = CASE WHEN ? IS NULL THEN context
                            WHEN context IS NULL THEN ?
                            ELSE context || char(10) || ? END
         WHERE id = ? AND status = 'open'
         RETURNING id, status, completed_at`,
    )
    .get(input.outcome, now, newContext, newContext, newContext, target.id) as
    | { id: number; status: 'done' | 'archived'; completed_at: string }
    | undefined;

  if (!updated) {
    return { success: false, error: 'task was already closed (race)' };
  }
  return {
    success: true,
    matched: updated.id,
    status: updated.status,
    completed_at: updated.completed_at,
  };
}
