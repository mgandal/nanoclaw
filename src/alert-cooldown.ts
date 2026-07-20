/**
 * Per-key cooldown for system alerts. During a sustained failure (e.g. an
 * expired OAuth token 401-ing every request) the same alert fires dozens of
 * times in minutes; delivery channels like Telegram should see it once per
 * window, with repeats counted and reported on the next delivered alert.
 */
export const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

// Prune stale entries once the map exceeds this size (entries are only
// created when alerts fire, so this is a leak guard, not a hot path).
const PRUNE_THRESHOLD = 500;

interface CooldownEntry {
  lastSentAt: number;
  suppressed: number;
}

const entries = new Map<string, CooldownEntry>();

export interface AlertVerdict {
  send: boolean;
  /** When send=true: repeats suppressed since the last delivered alert.
   *  When send=false: repeats suppressed so far in this window. */
  suppressedCount: number;
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
  return { send: true, suppressedCount };
}

export function resetAlertCooldowns(): void {
  entries.clear();
}
