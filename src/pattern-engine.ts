import { logger } from './logger.js';

export interface ActionLogRow {
  tool_name: string;
  params_hash: string;
  timestamp: string;
}

export interface RepeatedToolPattern {
  tool: string;
  paramsHash: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface TimePattern {
  tool: string;
  paramsHash: string;
  dayOfWeek: number; // 0=Sun ... 6=Sat
  count: number;
}

export interface PatternProposal {
  proposed_at: string;
  status: string;
}

const MAX_PROPOSALS_PER_DAY = 2;

/**
 * Detect tools called N+ times with the same params hash.
 */
export function detectRepeatedTools(
  rows: ActionLogRow[],
  threshold: number,
): RepeatedToolPattern[] {
  const counts = new Map<
    string,
    { count: number; firstSeen: string; lastSeen: string }
  >();

  for (const row of rows) {
    const key = `${row.tool_name}:${row.params_hash}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
      if (row.timestamp < existing.firstSeen)
        existing.firstSeen = row.timestamp;
      if (row.timestamp > existing.lastSeen) existing.lastSeen = row.timestamp;
    } else {
      counts.set(key, {
        count: 1,
        firstSeen: row.timestamp,
        lastSeen: row.timestamp,
      });
    }
  }

  const patterns: RepeatedToolPattern[] = [];
  for (const [key, data] of counts) {
    if (data.count >= threshold) {
      const [tool, ...hashParts] = key.split(':');
      patterns.push({
        tool,
        paramsHash: hashParts.join(':'),
        count: data.count,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
      });
    }
  }

  logger.debug({ count: patterns.length }, 'detectRepeatedTools result');
  return patterns.sort((a, b) => b.count - a.count);
}

/**
 * Detect actions that occur on the same day of the week.
 */
export function detectTimePatterns(
  rows: ActionLogRow[],
  threshold: number,
): TimePattern[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const day = new Date(row.timestamp).getUTCDay();
    const key = `${row.tool_name}:${row.params_hash}:${day}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const patterns: TimePattern[] = [];
  for (const [key, count] of counts) {
    if (count >= threshold) {
      const parts = key.split(':');
      const dayOfWeek = parseInt(parts.pop()!, 10);
      const paramsHash = parts.pop()!;
      const tool = parts.join(':');
      patterns.push({ tool, paramsHash, dayOfWeek, count });
    }
  }

  logger.debug({ count: patterns.length }, 'detectTimePatterns result');
  return patterns.sort((a, b) => b.count - a.count);
}

/**
 * Check if we can make more proposals today (max 2 per calendar day).
 */
export function canProposeToday(
  proposals: PatternProposal[],
  today: string,
): boolean {
  const todayCount = proposals.filter((p) => p.proposed_at === today).length;
  return todayCount < MAX_PROPOSALS_PER_DAY;
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Run the daily pattern detection cycle.
 * Queries action_log for the last 30 days, detects patterns,
 * and returns formatted proposals (if any and under daily cap).
 */
export async function runPatternDetection(): Promise<string | null> {
  const { getActionLogRows, getPatternProposals, insertPatternProposal } =
    await import('./db.js');

  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const proposals = getPatternProposals();

  if (!canProposeToday(proposals, today)) {
    logger.debug('Pattern detection: daily proposal cap reached');
    return null;
  }

  const rows = getActionLogRows(thirtyDaysAgo);

  const repeated = detectRepeatedTools(rows, 3);
  const timeBased = detectTimePatterns(rows, 3);

  if (repeated.length === 0 && timeBased.length === 0) return null;

  const rejected = new Set(
    proposals.filter((p) => p.status === 'rejected').map((p) => p.description),
  );

  const proposalTexts: string[] = [];

  for (const p of repeated.slice(0, 2)) {
    const desc = `Automate ${p.tool} (called ${p.count}x with same params since ${p.firstSeen.slice(0, 10)})`;
    if (rejected.has(desc)) continue;
    proposalTexts.push(
      `Pattern detected: ${p.tool} has been called ${p.count} times with the same parameters.\n` +
        `First: ${p.firstSeen.slice(0, 10)}, Last: ${p.lastSeen.slice(0, 10)}.\n` +
        `Want me to schedule this as a recurring task?`,
    );
  }

  for (const p of timeBased.slice(0, 1)) {
    const desc = `Weekly ${p.tool} on ${DAY_NAMES[p.dayOfWeek]}`;
    if (rejected.has(desc)) continue;
    proposalTexts.push(
      `Weekly pattern: ${p.tool} runs every ${DAY_NAMES[p.dayOfWeek]} (${p.count} weeks).\n` +
        `Want me to schedule this automatically?`,
    );
  }

  if (proposalTexts.length === 0) return null;

  for (const text of proposalTexts) {
    const id = `prop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    insertPatternProposal({
      id,
      description: text.slice(0, 200),
      proposed_at: today,
    });
  }

  return proposalTexts.join('\n\n---\n\n');
}
