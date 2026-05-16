/**
 * Demonstration script for the 2026-05-16 task-outcome storm fix.
 *
 * Simulates the live-incident shape: 1953 historical successful logs for
 * a task whose surface_outputs is suddenly flipped to 1. Without the fix,
 * the watcher dumps 100 events per poll (and on the live system, fans out
 * to Ollama → AbortError storm). With the fix, only recently completed
 * runs may emit, and the startup migration neutralizes the backlog.
 *
 * Usage: bun run scripts/demo-outcome-watcher-storm.ts
 */
import { _initTestDatabase, getDb } from '../src/db.js';
import {
  TaskOutcomeWatcher,
  markStaleTaskOutcomesEmitted,
} from '../src/watchers/task-outcome-watcher.js';

_initTestDatabase();
const db = getDb();

db.prepare(
  `INSERT INTO scheduled_tasks
    (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
     next_run, last_run, last_result, status, created_at, surface_outputs)
    VALUES ('vault-inbox-ingest', 'main', 'jid', 'p', 'cron', '0 * * * *',
            ?, NULL, NULL, 'active', ?, 1)`,
).run(new Date().toISOString(), new Date().toISOString());

// Seed 1953 historical rows back to 2026-03-13 (matches live count).
const old = new Date('2026-03-13T00:00:00Z').toISOString();
const ins = db.prepare(
  `INSERT INTO task_run_logs
    (task_id, run_at, duration_ms, status, result, error, outcome_emitted)
    VALUES (?, ?, 100, 'success', 'historical output', NULL, 0)`,
);
for (let i = 0; i < 1953; i++) ins.run('vault-inbox-ingest', old);
// Plus one fresh row — should still emit.
ins.run('vault-inbox-ingest', new Date(Date.now() - 60_000).toISOString());

const backlogBefore = (
  db
    .prepare(
      `SELECT COUNT(*) AS c FROM task_run_logs WHERE outcome_emitted = 0`,
    )
    .get() as { c: number }
).c;
console.log(`backlog before fix: ${backlogBefore} unemitted rows`);

// Step 1: startup migration neutralizes stale rows.
const migrated = markStaleTaskOutcomesEmitted();
console.log(`migration marked ${migrated} stale rows as emitted`);

// Step 2: watcher poll — recency filter prevents storm.
const emits: number[] = [];
const w = new TaskOutcomeWatcher({ onEvent: () => emits.push(1) });
w.poll();
console.log(`watcher emitted ${emits.length} events on first poll`);

if (emits.length > 1) {
  console.error('FAIL: storm not contained');
  process.exit(1);
}
console.log('PASS: storm contained — only fresh row emitted');
