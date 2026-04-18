#!/usr/bin/env bun
/**
 * Archive proactive_log rows older than PROACTIVE_LOG_RETENTION_DAYS
 * to JSONL files under data/proactive/archive/, then delete from the table.
 *
 * Run periodically (e.g. daily via launchd or a scheduled task).
 *
 * Safety: the DELETE only runs if the archive file flushed without error.
 * A disk-full / permissions failure aborts before deletion so data isn't lost.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from '../../src/db.js';
import { PROACTIVE_LOG_RETENTION_DAYS } from '../../src/config.js';

const cutoff = new Date(
  Date.now() - PROACTIVE_LOG_RETENTION_DAYS * 86400_000,
).toISOString();

const db = getDb();
const rows = db
  .prepare('SELECT * FROM proactive_log WHERE timestamp < ?')
  .all(cutoff);

if (rows.length === 0) {
  console.log('nothing to archive');
  process.exit(0);
}

const archiveDir = path.resolve('data/proactive/archive');
fs.mkdirSync(archiveDir, { recursive: true });
const month = new Date().toISOString().slice(0, 7);
const file = path.join(archiveDir, `${month}.jsonl`);

// Wait for the stream to flush OR emit 'error'. createWriteStream errors fire
// on the 'error' event, not through end(cb), so we must listen explicitly.
// Only DELETE after a clean flush.
await new Promise<void>((resolve, reject) => {
  const stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', reject);
  for (const r of rows) {
    if (!stream.write(JSON.stringify(r) + '\n')) {
      // Backpressure: stream will emit 'drain' when ready for more.
      // For simplicity we don't await here because write buffers remain
      // in memory; total archive volume per run is bounded by the cutoff
      // window and is small in practice.
    }
  }
  stream.end((err?: Error | null) => {
    if (err) reject(err);
    else resolve();
  });
});

db.prepare('DELETE FROM proactive_log WHERE timestamp < ?').run(cutoff);
console.log(`Archived ${rows.length} rows to ${file}`);
