#!/usr/bin/env bun
/**
 * Swarm membership audit: probes whether each persona pinned in
 * data/agents/swarm-membership.yaml can actually reach the groups
 * where it's listed. Writes a JSON report and a Markdown digest;
 * the scheduled task (or any caller) decides whether to alert.
 *
 * Run manually:
 *   bun run scripts/swarm-audit.ts
 */
// Load .env BEFORE importing config — config.ts reads process.env at import time.
// Without this, ad-hoc CLI invocations (smoke-tests, manual reruns) silently see an
// empty TELEGRAM_BOT_POOL and the audit throws.
import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { Database } from 'bun:sqlite';
import { initBotPool, getPoolBotForPersona, getPoolSize } from '../src/channels/telegram.js';
import { TELEGRAM_BOT_POOL, TELEGRAM_POOL_PIN } from '../src/config.js';
import { logger } from '../src/logger.js';

// SCRIPT_ROOT: directory containing the swarm-audit.ts source (worktree or main repo).
// Used for source-controlled files (YAML config lives next to the script).
const SCRIPT_ROOT = path.resolve(import.meta.dirname, '..');
// RUNTIME_ROOT: the working directory from which the script is invoked.
// Runtime data files (DB, output JSON/MD, groups/ state) always live in the
// main nanoclaw working tree — even when running from a worktree during dev.
const RUNTIME_ROOT = process.cwd();
const YAML_PATH = path.join(SCRIPT_ROOT, 'data/agents/swarm-membership.yaml');
const JSON_OUT = path.join(RUNTIME_ROOT, 'data/agents/swarm-membership-audit.json');
const MD_OUT = path.join(
  RUNTIME_ROOT,
  'groups/telegram_claire/state/swarm-audit.md',
);
const DB_PATH = path.join(RUNTIME_ROOT, 'store/messages.db');

interface Membership {
  groups: Record<string, { personas: string[] }>;
}

interface ProbeResult {
  status: 'member' | 'not_member' | 'error' | 'unpinned' | 'no_chat';
  detail: string;
}

interface AuditRow {
  group_folder: string;
  group_jid: string | null;
  persona: string;
  status: ProbeResult['status'];
  detail: string;
  probed_at: string;
}

interface AuditReport {
  generated_at: string;
  rows: AuditRow[];
  summary: {
    total: number;
    member: number;
    not_member: number;
    error: number;
    unpinned: number;
    no_chat: number;
  };
}

export interface AuditDiff {
  group_folder: string;
  persona: string;
  from: ProbeResult['status'] | null;
  to: ProbeResult['status'];
  kind: 'regression' | 'new_miss' | 'recovery';
}

/**
 * Meta-alert about audit infrastructure health (not a per-persona regression).
 * Distinct shape (kind: 'meta', no group_folder/persona) so downstream
 * consumers — the scheduled-task prompt that surfaces diffs to CLAIRE —
 * can route this to OPS rather than treating it as N false-positive
 * regression alerts. See loadPriorReport() for the corruption-recovery
 * pattern this enables.
 */
export interface MetaAlert {
  kind: 'meta';
  reason: 'prior_unreadable';
  detail: string;
  rotated_to?: string;
  detected_at: string;
}

export interface PriorLoadResult {
  report: AuditReport | null;
  recovered: boolean;
  rotatedTo?: string;
  error?: string;
}

/**
 * Load the prior audit report, auto-quarantining a corrupt file aside
 * (`<original>.corrupt-<ISO-timestamp>`). Mirrors the pattern in
 * scripts/sync/email-migrate.py:load_state.
 *
 * Returns `recovered: true` when the prior was unreadable (parse error,
 * read error) — callers should then suppress per-persona diffs and emit
 * a single meta-alert, otherwise a schema drift would spam N
 * false-positive `new_miss` alerts to CLAIRE.
 *
 * If the rotation itself fails (read-only fs, permissions), we log and
 * still return `recovered: true` so the caller's recovery path runs;
 * we just don't have a `rotatedTo` to report.
 */
export function loadPriorReport(priorPath: string): PriorLoadResult {
  if (!fs.existsSync(priorPath)) {
    return { report: null, recovered: false };
  }
  try {
    const raw = fs.readFileSync(priorPath, 'utf8');
    const report = JSON.parse(raw) as AuditReport;
    return { report, recovered: false };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Format matches scripts/sync/email-migrate.py:load_state — hyphens not
    // colons (filesystem-safe), local time via Date.toISOString → strip ms+Z.
    const ts = new Date()
      .toISOString()
      .replace(/\..+$/, '')
      .replace(/:/g, '-');
    const rotatedTo = `${priorPath}.corrupt-${ts}`;
    try {
      fs.renameSync(priorPath, rotatedTo);
      logger.warn(
        { err: errMsg, rotatedTo },
        'Prior audit JSON unreadable; rotated aside, treating as first-run',
      );
      return { report: null, recovered: true, rotatedTo, error: errMsg };
    } catch (renameErr) {
      const renameMsg =
        renameErr instanceof Error ? renameErr.message : String(renameErr);
      logger.warn(
        { err: errMsg, renameErr: renameMsg },
        'Prior audit JSON unreadable; could not rotate, treating as first-run',
      );
      return { report: null, recovered: true, error: errMsg };
    }
  }
}

/**
 * Compute alert payload for one audit run: returns per-persona diffs (only
 * if prior was healthy) and an optional meta-alert (only if prior was
 * corrupt and got quarantined).
 */
export function computeAuditAlerts(
  priorPath: string,
  currentReport: AuditReport,
): { diffs: AuditDiff[]; meta: MetaAlert | null } {
  const prior = loadPriorReport(priorPath);
  if (prior.recovered) {
    return {
      diffs: [],
      meta: {
        kind: 'meta',
        reason: 'prior_unreadable',
        detail: `Prior audit JSON at ${priorPath} was unreadable (${prior.error ?? 'unknown error'}); per-persona diffs suppressed for this run.`,
        rotated_to: prior.rotatedTo,
        detected_at: new Date().toISOString(),
      },
    };
  }
  const diffs = diffAudits(prior.report?.rows ?? [], currentReport.rows);
  return { diffs, meta: null };
}

export function diffAudits(prev: AuditRow[], curr: AuditRow[]): AuditDiff[] {
  const key = (r: AuditRow) => `${r.group_folder}::${r.persona}`;
  const prevMap = new Map(prev.map((r) => [key(r), r.status] as const));
  const out: AuditDiff[] = [];
  for (const r of curr) {
    const before = prevMap.get(key(r)) ?? null;
    if (before === r.status) continue;
    if (r.status === 'member' && before && before !== 'member') {
      out.push({
        group_folder: r.group_folder,
        persona: r.persona,
        from: before,
        to: r.status,
        kind: 'recovery',
      });
    } else if (
      (r.status === 'not_member' || r.status === 'error') &&
      before === 'member'
    ) {
      out.push({
        group_folder: r.group_folder,
        persona: r.persona,
        from: before,
        to: r.status,
        kind: 'regression',
      });
    } else if (
      (r.status === 'not_member' || r.status === 'error') &&
      before === null
    ) {
      out.push({
        group_folder: r.group_folder,
        persona: r.persona,
        from: null,
        to: r.status,
        kind: 'new_miss',
      });
    }
  }
  return out;
}

export function classifyChatProbe(err: unknown, chat: unknown): ProbeResult {
  if (!err && chat) return { status: 'member', detail: 'getChat ok' };
  if (err && typeof err === 'object' && 'error_code' in err) {
    const e = err as { error_code: number; description?: string };
    const desc = e.description || `Telegram error ${e.error_code}`;
    if (
      e.error_code === 403 ||
      (e.error_code === 400 && /chat not found/i.test(desc))
    ) {
      return { status: 'not_member', detail: desc };
    }
    return { status: 'error', detail: desc };
  }
  if (err instanceof Error) return { status: 'error', detail: err.message };
  return { status: 'error', detail: String(err) };
}

async function main() {
  // 1. Load YAML config
  const cfg = yaml.parse(fs.readFileSync(YAML_PATH, 'utf8')) as Membership;
  if (!cfg?.groups) throw new Error(`Bad YAML at ${YAML_PATH}`);

  // 2. Initialize the bot pool (needed for getPoolBotForPersona to work)
  if (TELEGRAM_BOT_POOL.length === 0) {
    throw new Error(
      'TELEGRAM_BOT_POOL is empty in .env — audit cannot run without pool bots',
    );
  }
  // Audit must be read-only against Telegram. initBotPool would otherwise call
  // setMyName on every pinned bot — a write that overwrites any manual rename
  // (e.g., BotFather debugging). skipRename: true tells initBotPool to populate
  // pinnedSenderIdx without touching the bot's display name.
  await initBotPool(TELEGRAM_BOT_POOL, TELEGRAM_POOL_PIN, { skipRename: true });
  if (getPoolSize() === 0) {
    throw new Error(
      'initBotPool completed but no pool bots initialized — check Telegram tokens and network. ' +
        'Without this guard, all audit rows would land as "unpinned" with misleading messages.',
    );
  }

  // 3. Resolve group_folder → chat_jid via DB.
  // IMPORTANT: registered_groups has multiple rows per folder for multi-channel
  // groups (e.g. telegram_lab-claw has both `tg:-100…` and `slack:C0AB…`).
  // Filter to Telegram-only: api.getChat() takes a Telegram numeric id, not a Slack id.
  const db = new Database(DB_PATH, { readonly: true });
  const folderToJid = new Map<string, string>();
  const rows = db
    .prepare("SELECT folder, jid FROM registered_groups WHERE jid LIKE 'tg:%'")
    .all() as Array<{ folder: string; jid: string }>;
  for (const r of rows) folderToJid.set(r.folder, r.jid);
  db.close();

  // 4. Probe each (group, persona) pair
  const auditRows: AuditRow[] = [];
  const probedAt = new Date().toISOString();

  for (const [groupFolder, group] of Object.entries(cfg.groups)) {
    const jid = folderToJid.get(groupFolder);
    const numericId = jid ? jid.replace(/^tg:/, '') : null;

    for (const persona of group.personas) {
      const baseRow: Omit<AuditRow, 'status' | 'detail'> = {
        group_folder: groupFolder,
        group_jid: jid ?? null,
        persona,
        probed_at: probedAt,
      };

      if (!jid) {
        auditRows.push({
          ...baseRow,
          status: 'no_chat',
          detail: `${groupFolder} not in registered_groups`,
        });
        continue;
      }

      const api = getPoolBotForPersona(persona);
      if (!api) {
        auditRows.push({
          ...baseRow,
          status: 'unpinned',
          detail: `No pool bot pinned to "${persona}" — check TELEGRAM_POOL_PIN`,
        });
        continue;
      }

      try {
        const chat = await api.getChat(numericId!);
        const result = classifyChatProbe(null, chat);
        auditRows.push({ ...baseRow, ...result });
      } catch (err) {
        const result = classifyChatProbe(err, null);
        auditRows.push({ ...baseRow, ...result });
      }
    }
  }

  // 5. Build report
  const summary = {
    total: auditRows.length,
    member: auditRows.filter((r) => r.status === 'member').length,
    not_member: auditRows.filter((r) => r.status === 'not_member').length,
    error: auditRows.filter((r) => r.status === 'error').length,
    unpinned: auditRows.filter((r) => r.status === 'unpinned').length,
    no_chat: auditRows.filter((r) => r.status === 'no_chat').length,
  };
  const report: AuditReport = { generated_at: probedAt, rows: auditRows, summary };

  // 6. Diff against previous run for alert-worthy changes.
  // computeAuditAlerts auto-quarantines a corrupt prior to
  // <path>.corrupt-<ts> and returns a single meta-alert in lieu of N
  // false-positive new_miss rows. See loadPriorReport().
  const { diffs, meta } = computeAuditAlerts(JSON_OUT, report);
  if (meta) {
    logger.warn({ meta }, 'Swarm audit meta-alert: prior unreadable');
    console.log('META:', JSON.stringify(meta, null, 2));
  }
  if (diffs.length > 0) {
    logger.info({ diffs }, 'Swarm membership audit diffs detected');
    console.log('DIFFS:', JSON.stringify(diffs, null, 2));
  } else {
    console.log('DIFFS: none');
  }
  // Also write the diffs alongside the report so the scheduled-task prompt can read them
  fs.writeFileSync(
    path.join(RUNTIME_ROOT, 'data/agents/swarm-membership-audit-diffs.json'),
    JSON.stringify({ generated_at: probedAt, diffs, meta }, null, 2),
  );

  // 7. Write JSON
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

  // 8. Write Markdown digest
  const md = renderMarkdown(report, meta ?? undefined);
  fs.mkdirSync(path.dirname(MD_OUT), { recursive: true });
  fs.writeFileSync(MD_OUT, md);

  logger.info({ summary }, 'Swarm membership audit complete');
  console.log(JSON.stringify(summary, null, 2));
}

export function renderMarkdown(report: AuditReport, meta?: MetaAlert): string {
  const { generated_at, rows, summary } = report;
  const groups = new Map<string, AuditRow[]>();
  for (const r of rows) {
    if (!groups.has(r.group_folder)) groups.set(r.group_folder, []);
    groups.get(r.group_folder)!.push(r);
  }
  const lines: string[] = [];
  lines.push(`# Swarm Membership Audit — ${generated_at}`);
  lines.push('');
  lines.push(
    `**Summary:** ${summary.member}/${summary.total} reachable · ${summary.not_member} not_member · ${summary.error} error · ${summary.unpinned} unpinned · ${summary.no_chat} no_chat`,
  );
  lines.push('');
  if (meta) {
    // Distinct section so OPS can route this differently from per-persona
    // regression alerts. Scheduled-task prompt should match on this header.
    lines.push('## Audit health');
    lines.push(
      `- ⚠ **prior file unreadable** — ${meta.detail}${
        meta.rotated_to ? ` Rotated to \`${meta.rotated_to}\`.` : ''
      }`,
    );
    lines.push('');
  }
  for (const [groupFolder, groupRows] of groups) {
    lines.push(`## ${groupFolder}`);
    for (const r of groupRows) {
      const icon =
        r.status === 'member'
          ? '✓'
          : r.status === 'not_member'
            ? '✗'
            : r.status === 'unpinned'
              ? '○'
              : r.status === 'no_chat'
                ? '?'
                : '⚠';
      lines.push(`- ${icon} **${r.persona}** — ${r.status}: ${r.detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error({ err }, 'Swarm audit failed');
    console.error(err);
    process.exit(1);
  });
}
