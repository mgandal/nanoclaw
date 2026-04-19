// scripts/cockpit/sql.ts
import type { Database } from 'bun:sqlite';

export interface GroupRow {
  folder: string;
  display_name: string;
  last_active_at: string | null;
  messages_24h: number;
}

export interface TaskRow {
  id: string;
  group: string;
  prompt: string;
  agent_name: string | null;
  schedule_value: string;
  last_run: string | null;
  last_result: string | null;
  next_run: string | null;
  last_status: 'success' | 'error' | 'skipped' | null;
  success_7d: [number, number];
}

const MS_PER_DAY = 24 * 3600 * 1000;

export function getGroupsWithActivity(db: Database, now: Date): GroupRow[] {
  const cutoff24h = new Date(now.getTime() - MS_PER_DAY).toISOString();
  const groups = db
    .prepare('SELECT folder, name, jid FROM registered_groups')
    .all() as Array<{ folder: string; name: string; jid: string }>;

  const result: GroupRow[] = [];
  for (const g of groups) {
    const sessionRow = db
      .prepare(
        `SELECT MAX(last_used) AS last_active FROM sessions WHERE group_folder = ? OR group_folder LIKE ?`,
      )
      .get(g.folder, `${g.folder}:%`) as { last_active: string | null };

    const msgRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE chat_jid = ? AND timestamp > ?`,
      )
      .get(g.jid, cutoff24h) as { c: number };

    result.push({
      folder: g.folder,
      display_name: g.name ?? prettify(g.folder),
      last_active_at: sessionRow.last_active ?? null,
      messages_24h: msgRow.c,
    });
  }
  return result;
}

export function getTasksWithStatus(db: Database): TaskRow[] {
  const tasks = db
    .prepare(
      `SELECT id, group_folder, prompt, agent_name, schedule_value, last_run, last_result, next_run
       FROM scheduled_tasks
       WHERE status = 'active'`,
    )
    .all() as Array<{
      id: string; group_folder: string; prompt: string; agent_name: string | null;
      schedule_value: string; last_run: string | null; last_result: string | null;
      next_run: string | null;
    }>;

  const rows: TaskRow[] = [];
  const cutoff7d = new Date(Date.now() - 7 * MS_PER_DAY).toISOString();

  for (const t of tasks) {
    const latest = db
      .prepare(
        `SELECT status FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 1`,
      )
      .get(t.id) as { status: 'success' | 'error' | 'skipped' } | undefined;

    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS ok
         FROM task_run_logs WHERE task_id = ? AND run_at > ?`,
      )
      .get(t.id, cutoff7d) as { total: number; ok: number };

    rows.push({
      id: t.id,
      group: t.group_folder,
      prompt: t.prompt,
      agent_name: t.agent_name,
      schedule_value: t.schedule_value,
      last_run: t.last_run,
      last_result: t.last_result,
      next_run: t.next_run,
      last_status: latest?.status ?? null,
      success_7d: [totals.ok ?? 0, totals.total ?? 0],
    });
  }
  return rows;
}

function prettify(folder: string): string {
  return folder
    .replace(/^telegram_/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}
