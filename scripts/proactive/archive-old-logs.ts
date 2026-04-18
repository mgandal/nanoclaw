#!/usr/bin/env bun
/**
 * Archive proactive_log rows older than PROACTIVE_LOG_RETENTION_DAYS
 * to JSONL files under data/proactive/archive/, then delete from the table.
 *
 * Run periodically (e.g. daily via launchd or a scheduled task).
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
const stream = fs.createWriteStream(file, { flags: 'a' });
for (const r of rows) stream.write(JSON.stringify(r) + '\n');
await new Promise<void>((resolve) => stream.end(resolve));

db.prepare('DELETE FROM proactive_log WHERE timestamp < ?').run(cutoff);
console.log(`Archived ${rows.length} rows to ${file}`);
