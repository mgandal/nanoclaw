/**
 * Pure helper functions extracted from src/index.ts for testability.
 * These contain critical logic that has been the source of multiple bugs.
 */

/**
 * Check whether a session should be expired.
 * Returns the expiry reason string, or null if the session is still valid.
 *
 * Two thresholds:
 *   MAX_AGE: session older than maxAgeMs total → expire (checked first)
 *   IDLE: no activity for idleMs → expire
 */
export function checkSessionExpiry(
  createdAt: string | undefined,
  lastUsed: string | undefined,
  idleMs: number,
  maxAgeMs: number,
): string | null {
  const idleAge = lastUsed
    ? Date.now() - new Date(lastUsed).getTime()
    : Infinity;
  const totalAge = createdAt
    ? Date.now() - new Date(createdAt).getTime()
    : Infinity;

  if (totalAge > maxAgeMs) return 'max age (4h)';
  if (idleAge > idleMs) return 'idle (2h)';
  return null;
}

/**
 * Parse the last_agent_seq JSON from the DB.
 * Returns empty object on any error (corruption, null, etc.)
 */
export function parseLastAgentSeq(
  raw: string | null | undefined,
): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Detect stale/corrupt session errors from container output.
 * The session .jsonl can go missing after a crash, manual deletion, or disk-full.
 */
export function isStaleSessionError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
    error,
  );
}

