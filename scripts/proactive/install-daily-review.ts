#!/usr/bin/env bun
/**
 * Install or update the proactive-daily-review scheduled task.
 * Run once from the repo root: `bun run scripts/proactive/install-daily-review.ts`
 */
import fs from 'fs';
import path from 'path';
import { getDb } from '../../src/db.js';

const promptPath = path.resolve(
  'groups/global/state/proactive-daily-review-prompt.md',
);
if (!fs.existsSync(promptPath)) {
  console.error(`Prompt template not found: ${promptPath}`);
  process.exit(1);
}
const prompt = fs.readFileSync(promptPath, 'utf-8');

const db = getDb();
const existing = db
  .prepare('SELECT id FROM scheduled_tasks WHERE id = ?')
  .get('proactive-daily-review');

if (existing) {
  db.prepare(
    `UPDATE scheduled_tasks
     SET prompt = ?, schedule_value = '30 19 * * 1-5', proactive = 1
     WHERE id = 'proactive-daily-review'`,
  ).run(prompt);
  console.log('Updated existing proactive-daily-review task');
} else {
  // Use main group folder (check if 'main' exists, else first available group).
  const mainChat = db
    .prepare(`SELECT jid FROM chats WHERE is_group = 1 LIMIT 1`)
    .get() as { jid?: string } | undefined;
  const chatJid = mainChat?.jid ?? '';
  db.prepare(
    `INSERT INTO scheduled_tasks
      (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       next_run, status, created_at, proactive)
      VALUES ('proactive-daily-review', 'main', ?, ?, 'cron', '30 19 * * 1-5',
              ?, 'active', ?, 1)`,
  ).run(
    chatJid,
    prompt,
    new Date(Date.now() + 60_000).toISOString(),
    new Date().toISOString(),
  );
  console.log('Installed proactive-daily-review task');
}
