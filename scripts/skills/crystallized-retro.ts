#!/usr/bin/env bun
/**
 * Weekly retro for crystallized skills (Phase 2 §B1).
 *
 * Reads:
 *   data/agents/{name}/skills/crystallized/log.jsonl   — write events
 *   data/agents/{name}/skills/crystallized/usage.jsonl — invocation events
 *   data/agents/{name}/skills/crystallized/{slug}/SKILL.md — frontmatter source
 *
 * Reports three buckets:
 *   - Promotion candidates (≥3 invocations)
 *   - Stale (>14 days old, 0 invocations)
 *   - Recent (≤14 days old, 0 invocations — too soon to judge)
 *
 * Output is plain text, suitable for a digest, Telegram message, or
 * piping into a weekly cron summary.
 *
 * Usage:
 *   bun scripts/skills/crystallized-retro.ts                # all agents
 *   bun scripts/skills/crystallized-retro.ts --agent claire # single agent
 *   bun scripts/skills/crystallized-retro.ts --json         # machine-readable
 */

import fs from 'fs';
import path from 'path';

interface SkillRecord {
  agent: string;
  name: string;
  crystallizedAt: string;
  sourceTask: string;
  confidence: number;
  invocationCount: number;
  lastInvokedAt: string | null;
}

const STALE_DAYS = 14;
const PROMOTION_THRESHOLD = 3;

function parseFrontmatter(skillFile: string): Record<string, string> | null {
  if (!fs.existsSync(skillFile)) return null;
  const content = fs.readFileSync(skillFile, 'utf-8');
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    // Strip surrounding double quotes if JSON-stringified.
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        // Leave raw.
      }
    }
    fm[kv[1]] = v;
  }
  return fm;
}

function listAgentDirs(agentsRoot: string, filter?: string): string[] {
  if (!fs.existsSync(agentsRoot)) return [];
  return fs
    .readdirSync(agentsRoot)
    .filter((entry) => {
      if (filter && entry !== filter) return false;
      const dir = path.join(agentsRoot, entry);
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

function loadSkillsForAgent(
  agentsRoot: string,
  agent: string,
): SkillRecord[] {
  const crystallizedDir = path.join(
    agentsRoot,
    agent,
    'skills',
    'crystallized',
  );
  if (!fs.existsSync(crystallizedDir)) return [];

  const records: SkillRecord[] = [];
  for (const entry of fs.readdirSync(crystallizedDir)) {
    const full = path.join(crystallizedDir, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    const fm = parseFrontmatter(path.join(full, 'SKILL.md'));
    if (!fm || !fm.name) continue;
    records.push({
      agent,
      name: fm.name,
      crystallizedAt: fm.crystallized_at ?? '',
      sourceTask: fm.source_task ?? '',
      confidence: Number(fm.confidence) || 0,
      invocationCount: Number(fm.invocation_count) || 0,
      lastInvokedAt: fm.last_invoked_at ?? null,
    });
  }
  return records;
}

function categorize(record: SkillRecord, now: number): 'promote' | 'stale' | 'recent' {
  if (record.invocationCount >= PROMOTION_THRESHOLD) return 'promote';
  const ts = Date.parse(record.crystallizedAt);
  if (!Number.isFinite(ts)) return 'recent';
  const ageDays = (now - ts) / (1000 * 60 * 60 * 24);
  if (ageDays > STALE_DAYS && record.invocationCount === 0) return 'stale';
  return 'recent';
}

function formatTextReport(buckets: {
  promote: SkillRecord[];
  stale: SkillRecord[];
  recent: SkillRecord[];
}): string {
  const lines: string[] = [];
  lines.push('=== Crystallized Skill Retro ===');
  lines.push(`Promotion candidates (≥${PROMOTION_THRESHOLD} invocations): ${buckets.promote.length}`);
  for (const r of buckets.promote) {
    lines.push(
      `  • ${r.agent}/${r.name} — ${r.invocationCount} invocations, conf=${r.confidence}`,
    );
    if (r.sourceTask) lines.push(`      source: ${r.sourceTask.slice(0, 80)}`);
  }
  lines.push('');
  lines.push(`Stale (>${STALE_DAYS}d, never invoked): ${buckets.stale.length}`);
  for (const r of buckets.stale) {
    lines.push(`  • ${r.agent}/${r.name} — crystallized ${r.crystallizedAt}`);
  }
  lines.push('');
  lines.push(`Recent (within ${STALE_DAYS}d, no invocations yet): ${buckets.recent.length}`);
  for (const r of buckets.recent) {
    lines.push(
      `  • ${r.agent}/${r.name} — crystallized ${r.crystallizedAt}, conf=${r.confidence}`,
    );
  }
  if (
    buckets.promote.length === 0 &&
    buckets.stale.length === 0 &&
    buckets.recent.length === 0
  ) {
    lines.push('(no crystallized skills found)');
  }
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const agentFlag = args.indexOf('--agent');
  const filterAgent = agentFlag !== -1 ? args[agentFlag + 1] : undefined;
  const json = args.includes('--json');
  const customRoot = (() => {
    const i = args.indexOf('--agents-root');
    return i !== -1 ? args[i + 1] : undefined;
  })();

  const agentsRoot =
    customRoot ?? path.join(process.cwd(), 'data', 'agents');

  const buckets: {
    promote: SkillRecord[];
    stale: SkillRecord[];
    recent: SkillRecord[];
  } = { promote: [], stale: [], recent: [] };
  const now = Date.now();

  for (const agent of listAgentDirs(agentsRoot, filterAgent)) {
    const records = loadSkillsForAgent(agentsRoot, agent);
    for (const r of records) buckets[categorize(r, now)].push(r);
  }

  if (json) {
    process.stdout.write(JSON.stringify(buckets, null, 2) + '\n');
  } else {
    process.stdout.write(formatTextReport(buckets) + '\n');
  }
}

if (import.meta.main) {
  main();
}

export { categorize, loadSkillsForAgent, parseFrontmatter, formatTextReport };
export type { SkillRecord };
