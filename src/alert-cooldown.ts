import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Per-key cooldown for system alerts. During a sustained failure (e.g. an
 * expired OAuth token 401-ing every request) the same alert fires dozens of
 * times in minutes; delivery channels like Telegram should see it once per
 * window, with repeats counted and reported on the next delivered alert.
 *
 * State is persisted to disk (initAlertCooldownPersistence) so a process
 * restart mid-incident cannot re-deliver the same alert within the window.
 */
export const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

// Prune stale entries once the map exceeds this size (entries are only
// created when alerts fire, so this is a leak guard, not a hot path).
const PRUNE_THRESHOLD = 500;

interface CooldownEntry {
  lastSentAt: number;
  suppressed: number;
}

let entries = new Map<string, CooldownEntry>();
let persistPath: string | null = null;

export interface AlertVerdict {
  send: boolean;
  /** When send=true: repeats suppressed since the last delivered alert.
   *  When send=false: repeats suppressed so far in this window. */
  suppressedCount: number;
}

/**
 * Point the cooldown state at a JSON file and load whatever is there.
 * Corrupt or missing files start fresh; load/save failures never throw.
 */
export function initAlertCooldownPersistence(filePath: string): void {
  persistPath = filePath;
  entries = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      CooldownEntry
    >;
    for (const [key, entry] of Object.entries(raw)) {
      if (
        typeof entry?.lastSentAt === 'number' &&
        typeof entry?.suppressed === 'number'
      ) {
        entries.set(key, {
          lastSentAt: entry.lastSentAt,
          suppressed: entry.suppressed,
        });
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        { err, filePath },
        'Alert cooldown state unreadable; starting fresh',
      );
    }
  }
}

function persist(): void {
  if (!persistPath) return;
  try {
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(persistPath, JSON.stringify(Object.fromEntries(entries)));
  } catch (err) {
    logger.warn(
      { err, filePath: persistPath },
      'Failed to persist alert cooldown state',
    );
  }
}

export function shouldDeliverAlert(
  key: string,
  now: number = Date.now(),
): AlertVerdict {
  if (entries.size > PRUNE_THRESHOLD) {
    for (const [k, e] of entries) {
      if (now - e.lastSentAt >= ALERT_COOLDOWN_MS) entries.delete(k);
    }
  }

  const entry = entries.get(key);
  if (entry && now - entry.lastSentAt < ALERT_COOLDOWN_MS) {
    entry.suppressed++;
    return { send: false, suppressedCount: entry.suppressed };
  }

  const suppressedCount = entry?.suppressed ?? 0;
  entries.set(key, { lastSentAt: now, suppressed: 0 });
  // Persist only on delivery (rare); suppressed increments stay in memory so
  // a flood of duplicates does not turn into a flood of disk writes.
  persist();
  return { send: true, suppressedCount };
}

export function resetAlertCooldowns(): void {
  entries.clear();
  persistPath = null;
}
