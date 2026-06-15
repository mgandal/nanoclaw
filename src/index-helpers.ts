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
 * Decide whether an active (already-piping) container has exceeded max age
 * and should be killed so the next message spawns a fresh session.
 *
 * Semantic divergence from `checkSessionExpiry` (see lines 23-25) is
 * INTENTIONAL: this predicate is consulted ONLY when a container is
 * already active (queue.isActive(chatJid) === true). If `createdAt` is
 * undefined at that point, the session row is missing or has null
 * created_at — a race between container spawn and row insert. Killing
 * on that uncertainty creates a SIGKILL kill-loop (closeStdin → enqueue
 * → re-spawn → same check → kill again). So we MUST fail-open here.
 *
 * `checkSessionExpiry` runs BEFORE container spawn and CAN fail-closed
 * safely; the kill there means "don't reuse this stale-looking row,
 * spawn a fresh one" — terminal, no loop. Do NOT normalize the two
 * sites without understanding this asymmetry.
 *
 * Historical incident: 2026-05-13 SCIENCE-claw kill-loop (47k-min-old
 * created_at; container was actively running; old code used Infinity
 * fallback and looped).
 */
export function shouldKillActiveContainer(
  createdAt: string | undefined,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  if (!createdAt) return false; // fail-open: see comment above
  const totalAge = now - new Date(createdAt).getTime();
  return totalAge > maxAgeMs;
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
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Detect errors that mean the session is unusable and must be cleared so the
 * next retry starts fresh:
 *  - stale/corrupt session: the .jsonl can go missing after a crash, manual
 *    deletion, or disk-full.
 *  - poison image block: a malformed/oversized/over-dimension screenshot saved
 *    into the session triggers a 400/413 image rejection that replays on every
 *    resume, wedging the session permanently. We match the known image-error
 *    wordings but deliberately NOT a bare oversize message ("prompt is too
 *    long" / generic request_too_large), which is recoverable without nuking
 *    the session.
 *
 * Callers should prefer shouldClearSession(), which adds the status gate.
 * isStaleSessionError stays exported for direct unit coverage.
 */
export function isStaleSessionError(error: string | null | undefined): boolean {
  if (!error) return false;
  // The phrase "image" appearing alongside an exceed/unsupported/too-large
  // wording, or the canonical "could not process image", marks a poison block.
  return /no conversation found|ENOENT.*\.jsonl|session.*not found|could not process image|image\b[^]{0,40}\b(exceeds|too large|unsupported|invalid)|(exceeds|too large|unsupported|invalid)\b[^]{0,40}\bimage|unsupported image type/i.test(
    error,
  );
}

/**
 * Decide whether a failed container turn should clear the session. The host's
 * final error envelope now carries the clean container error (extractContainerError
 * parses the stdout marker before falling back to the stderr tail), so checking
 * output.error alone is sufficient and works for every caller — including
 * bus-routed turns that pass no streaming onOutput hook. Only fires on
 * status === 'error' so a *successful* turn whose result text merely mentions an
 * image error never destroys the session.
 */
export function shouldClearSession(output: {
  status: 'success' | 'error';
  error?: string | null;
}): boolean {
  if (output.status !== 'error') return false;
  return isStaleSessionError(output.error);
}
