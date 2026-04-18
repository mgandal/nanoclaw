import { getDb } from '../db.js';
import { logger } from '../logger.js';
import type { RawEvent } from '../event-router.js';

export interface TaskOutcomeConfig {
  onEvent: (event: RawEvent) => void;
}

export class TaskOutcomeWatcher {
  private cfg: TaskOutcomeConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: TaskOutcomeConfig) {
    this.cfg = cfg;
  }

  poll(): void {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT l.id AS log_id, l.task_id, l.result, l.run_at
       FROM task_run_logs l
       JOIN scheduled_tasks t ON t.id = l.task_id
       WHERE l.status = 'success'
         AND (l.outcome_emitted IS NULL OR l.outcome_emitted = 0)
         AND t.surface_outputs = 1
         AND l.result IS NOT NULL AND TRIM(l.result) <> ''
       ORDER BY l.run_at ASC LIMIT 100`,
      )
      .all() as {
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
    if (!this.timer) this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
