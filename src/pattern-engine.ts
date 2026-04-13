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
      if (row.timestamp < existing.firstSeen) existing.firstSeen = row.timestamp;
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
