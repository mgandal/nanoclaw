import { getDb } from '../db.js';
import { logger } from '../logger.js';
import type { RawEvent } from '../event-router.js';
import { startPollingLoop, PollingLoopHandle } from './polling-loop.js';

export interface TaskOutcomeConfig {
  onEvent: (event: RawEvent) => void;
}

/**
 * Only emit task outcomes for runs completed within this window. Older rows
 * are treated as already-handled — even if `outcome_emitted=0`. This is the
 * storm guard for 2026-05-16: flipping `surface_outputs=1` on a task with
 * months of accumulated history was making the watcher dump 100 events per
 * tick into the event router → Ollama AbortError storm.
 */
export const TASK_OUTCOME_RECENCY_MS = 24 * 3600_000;

/**
 * One-shot startup helper. Marks pre-existing `task_run_logs` rows that are
 * older than the recency horizon as `outcome_emitted=1`, so a future flip of
 * `surface_outputs` cannot resurface them. Returns the number of rows
 * updated. Safe to call repeatedly (idempotent — only touches rows with
 * `outcome_emitted=0`).
 */
export function markStaleTaskOutcomesEmitted(
  recencyMs: number = TASK_OUTCOME_RECENCY_MS,
): number {
  const db = getDb();
  if (!db) return 0;
  const horizon = new Date(Date.now() - recencyMs).toISOString();
  const res = db
    .prepare(
      `UPDATE task_run_logs
         SET outcome_emitted = 1
       WHERE (outcome_emitted IS NULL OR outcome_emitted = 0)
         AND run_at < ?`,
    )
    .run(horizon);
  if (res.changes > 0) {
    logger.info(
      { changes: res.changes, horizon },
      'task-outcome-watcher: marked stale rows as emitted (storm guard)',
    );
  }
  return res.changes;
}

export class TaskOutcomeWatcher {
  private cfg: TaskOutcomeConfig;
  private loop: PollingLoopHandle | null = null;

  constructor(cfg: TaskOutcomeConfig) {
    this.cfg = cfg;
  }

  poll(): void {
    const db = getDb();
    const horizon = new Date(
      Date.now() - TASK_OUTCOME_RECENCY_MS,
    ).toISOString();
    const rows = db
      .prepare(
        `SELECT l.id AS log_id, l.task_id, l.result, l.run_at
       FROM task_run_logs l
       JOIN scheduled_tasks t ON t.id = l.task_id
       WHERE l.status = 'success'
         AND (l.outcome_emitted IS NULL OR l.outcome_emitted = 0)
         AND t.surface_outputs = 1
         AND l.result IS NOT NULL AND TRIM(l.result) <> ''
         AND l.run_at >= ?
       ORDER BY l.run_at ASC LIMIT 100`,
      )
      .all(horizon) as {
      log_id: number;
      task_id: string;
      result: string;
      run_at: string;
    }[];

    for (const r of rows) {
      this.cfg.onEvent({
        type: 'task_outcome',
        id: `task-${r.task_id}-${r.log_id}`,
        timestamp: r.run_at,
        payload: {
          taskId: r.task_id,
          taskName: r.task_id,
          outputPreview: r.result.slice(0, 300),
        },
      });
      db.prepare(
        'UPDATE task_run_logs SET outcome_emitted = 1 WHERE id = ?',
      ).run(r.log_id);
    }
    if (rows.length > 0)
      logger.info({ emitted: rows.length }, 'task-outcome emitted');
  }

  start(intervalMs = 60_000): void {
    if (!this.loop)
      this.loop = startPollingLoop(() => this.poll(), {
        name: 'task-outcome',
        intervalMs,
      });
  }

  stop(): void {
    this.loop?.stop();
    this.loop = null;
  }
}
