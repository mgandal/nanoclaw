import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';

import { SCHEMA_VERSION } from './types.js';
import type { Snapshot, TaskSnapshot, WatchlistGroup } from './types.js';
import { getGroupsWithActivity, getTasksWithStatus } from './sql.js';
import { scanVault } from './vault-scan.js';
import { humanizeCron } from './cron-humanize.js';
import { readPapersLog } from './papers-log.js';
import { readEmailsState } from './emails-log.js';
import { readBlogs } from './blogs.js';
import { parsePriorities } from './priorities.js';
import { extractSection, parseWatchlistBullets } from './watchlist-parser.js';

export interface BuildArgs {
  db: Database;
  vaultPath: string;
  agentsDir: string;
  groupsDir: string;
  currentMdPath: string;
  papersLogPath: string;
  emailsStatePath: string;
  blogsPath: string;
  previousSnapshot: Snapshot | null;
  now: Date;
}

export function buildSnapshot(args: BuildArgs): Snapshot {
  const { db, vaultPath, agentsDir, groupsDir, currentMdPath, papersLogPath, emailsStatePath, blogsPath, now } = args;

  const vault = scanVault(vaultPath, now);
  const groupRows = getGroupsWithActivity(db, now);
  const taskRows = getTasksWithStatus(db);
  const tasks: TaskSnapshot[] = taskRows.map(t => ({
    id: t.id,
    group: t.group,
    name: deriveName(t.prompt, t.agent_name),
    schedule_raw: t.schedule_value,
    schedule_human: humanizeCron(t.schedule_value),
    last_run: t.last_run,
    last_status: t.last_status,
    last_result_excerpt: t.last_result ? t.last_result.slice(0, 200) : null,
    next_run: t.next_run,
    success_7d: t.success_7d,
    consecutive_failures: countConsecutiveFailures(db, t.id),
  }));

  const papers = readPapersLog(papersLogPath, now);
  const emails = readEmailsState(emailsStatePath, now);
  const blogs = readBlogs(blogsPath);
  const priorities = fs.existsSync(currentMdPath) ? parsePriorities(fs.readFileSync(currentMdPath, 'utf-8')) : [];

  const watchlists: WatchlistGroup[] = [
    ...collectGroupWatchlists(groupsDir),
    ...collectAgentWatchlists(agentsDir),
  ];

  return {
    generated_at: now.toISOString(),
    schema_version: SCHEMA_VERSION,
    groups: groupRows,
    tasks,
    ingestion: {
      emails,
      papers,
      vault: {
        count_24h: vault.count_24h,
        last_at: vault.last_at,
        recent: vault.recent,
      },
    },
    watchlists,
    blogs,
    priorities,
    vault_tree: vault.tree,
    vault_pages_available: vault.bundle.map(b => b.slug),
  };
}

function deriveName(prompt: string, agentName: string | null): string {
  const firstLine = prompt.split('\n').map(s => s.trim()).find(s => s.length > 0);
  if (firstLine && firstLine.length <= 80) return firstLine;
  if (agentName) return agentName;
  return firstLine ? firstLine.slice(0, 80) + '…' : '(unnamed)';
}

function countConsecutiveFailures(db: Database, taskId: string): number {
  const rows = db
    .prepare('SELECT status FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 20')
    .all(taskId) as Array<{ status: string }>;
  let count = 0;
  for (const row of rows) {
    if (row.status !== 'error') break;
    count++;
  }
  return count;
}

function collectGroupWatchlists(groupsDir: string): WatchlistGroup[] {
  if (!fs.existsSync(groupsDir)) return [];
  const result: WatchlistGroup[] = [];
  for (const name of fs.readdirSync(groupsDir)) {
    if (name.endsWith('.archived')) continue;
    const groupPath = path.join(groupsDir, name);
    try {
      if (fs.lstatSync(groupPath).isSymbolicLink()) continue;
      if (!fs.statSync(groupPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const items = [
      ...readBulletFile(path.join(groupPath, 'bookmarks.md')),
      ...readBulletFile(path.join(groupPath, 'watchlist.md')),
    ];
    if (items.length > 0) result.push({ scope: 'group', scope_name: name, items });
  }
  return result;
}

function collectAgentWatchlists(agentsDir: string): WatchlistGroup[] {
  if (!fs.existsSync(agentsDir)) return [];
  const result: WatchlistGroup[] = [];
  for (const name of fs.readdirSync(agentsDir)) {
    const memPath = path.join(agentsDir, name, 'memory.md');
    if (!fs.existsSync(memPath)) continue;
    const md = fs.readFileSync(memPath, 'utf-8');
    const section = extractSection(md, 'Watchlist');
    if (section === null) continue;
    const items = parseWatchlistBullets(section);
    if (items.length > 0) result.push({ scope: 'agent', scope_name: name, items });
  }
  return result;
}

function readBulletFile(filePath: string): ReturnType<typeof parseWatchlistBullets> {
  if (!fs.existsSync(filePath)) return [];
  return parseWatchlistBullets(fs.readFileSync(filePath, 'utf-8'));
}
