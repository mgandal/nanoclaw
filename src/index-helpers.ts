/**
 * Pure helper functions extracted from src/index.ts for testability.
 * These contain critical logic that has been the source of multiple bugs.
 */

/**
 * Check whether a session should be expired.
 * Returns the expiry reason string, or null if the session is still valid.
 *
 * Three thresholds (checked in priority order):
 *   MAX_AGE: session older than maxAgeMs total → expire (checked first)
 *   IDLE: no activity for idleMs → expire
 *   SIZE: transcript jsonl larger than maxSizeBytes → expire
 *
 * The SIZE check guards a failure mode the age/idle checks cannot: a session
 * can grow large enough (big tool outputs, memory-context injections, pasted
 * blobs) that each turn auto-compacts and exceeds CONTAINER_TIMEOUT, killing
 * the container before it replies — and this happens *within* the age window,
 * so age never trips. `sizeBytes` is supplied by the caller (kept out of this
 * pure function so it stays fs-free and unit-testable); pass `undefined` when
 * the transcript file does not exist yet. Size args are optional and trailing
 * so existing four-arg callers keep their exact behavior.
 *
 * Root cause: 2026-06-23 CLAIRE incident (19MB session → 30+ min turns → killed
 * pre-reply). See src/index.test.ts "checkSessionExpiry: size cap".
 */
export function checkSessionExpiry(
  createdAt: string | undefined,
  lastUsed: string | undefined,
  idleMs: number,
  maxAgeMs: number,
  sizeBytes?: number,
  maxSizeBytes?: number,
): string | null {
  const idleAge = lastUsed
    ? Date.now() - new Date(lastUsed).getTime()
    : Infinity;
  const totalAge = createdAt
    ? Date.now() - new Date(createdAt).getTime()
    : Infinity;

  if (totalAge > maxAgeMs) return 'max age (4h)';
  if (idleAge > idleMs) return 'idle (2h)';
  if (
    maxSizeBytes !== undefined &&
    sizeBytes !== undefined &&
    sizeBytes > maxSizeBytes
  ) {
    const mb = Math.round(sizeBytes / (1024 * 1024));
    return `size (${mb}MB)`;
  }
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
 * Decide whether to issue a belt-and-suspenders `container stop` when an agent
 * container's process closes.
 *
 * Apple Container's runtime sometimes leaves the agent VM in state=running
 * after the `container run --rm` client exits cleanly (code 0) — `--rm` is
 * silently not honored, so the VM lingers (holding ~1GB + a container slot)
 * until the boot-time orphan reaper runs at the next restart. To close that
 * leak at the source we fire a redundant `container stop` on close.
 *
 * It must NOT fire when the container was already torn down on the way to the
 * close event, or we'd issue a pointless double-stop:
 *   - `timedOut`     → the hard-timeout handler (`killOnTimeout`) already called
 *                      `stopContainer` (and may have force-killed on top).
 *   - `forceKilled`  → a SIGKILL was issued for this container.
 *
 * Pure + boolean-only so it can be unit-tested exhaustively (mirrors the
 * extract-pure-helper pattern used by shouldKillActiveContainer / shouldClearSession);
 * the close handler in container-runner.ts wires the result into a non-blocking
 * `setImmediate(stopContainer)` so the sync exec never stalls the event loop.
 */
export function shouldStopOnClose(
  timedOut: boolean,
  forceKilled: boolean,
): boolean {
  return !timedOut && !forceKilled;
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
  // Deliberately NOT "invalid": it appears in every API 400 (invalid_request_error)
  // and in recoverable tool-validation errors like "invalid argument: expected
  // image url", so matching it near "image" would nuke healthy sessions.
  return /no conversation found|ENOENT.*\.jsonl|session.*not found|could not process image|image\b[^]{0,40}\b(exceeds|too large|unsupported)|(exceeds|too large|unsupported)\b[^]{0,40}\bimage/i.test(
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

/**
 * Normalize a raw OLLAMA_HOST value into a URL safe to use as a CLIENT fetch
 * target. The env var is reused for two opposite roles: it is set to the Ollama
 * SERVER bind address `0.0.0.0` (so Apple Container VMs can reach Ollama on all
 * interfaces) by com.nanoclaw.ollama-host-env.plist, but the host process also
 * reads it as the base URL it fetches (event-router.ts:270). A bind-all address
 * is not connectable, and a scheme-less value throws in `new URL()`, so the
 * unnormalized value floods the log with ERR_INVALID_URL on every vault change.
 *
 * Rules:
 *  - already has http:// or https:// → keep the scheme, otherwise prepend http://
 *  - host of `0.0.0.0` (or empty) → rewrite to 127.0.0.1 (loopback is connectable)
 *  - a scheme-less input with no port → append the Ollama default 11434
 *
 * The default port is applied ONLY when the input lacked an explicit scheme
 * (i.e. it is a bare host/bind address we are interpreting as the local Ollama).
 * A fully-formed URL the operator wrote, like `https://example.com`, is trusted
 * verbatim — its port (or the scheme default) is left as-is rather than forced
 * to 11434. The result is always parseable by `new URL()`; an unparseable input
 * falls back to the canonical local default.
 */
export function normalizeOllamaHost(raw: string): string {
  const DEFAULT = 'http://127.0.0.1:11434';
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return DEFAULT;

  const hadScheme = /^https?:\/\//i.test(trimmed);
  const withScheme = hadScheme ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return DEFAULT;
  }

  // A bind-all address (or an empty host) is not a valid connect target.
  if (url.hostname === '0.0.0.0' || url.hostname === '') {
    url.hostname = '127.0.0.1';
  }
  // Only default the port for bare host inputs; trust an operator-written URL.
  if (!url.port && !hadScheme) {
    url.port = '11434';
  }

  // Preserve the simple `scheme://host:port` shape callers expect (no trailing
  // slash) when there is no path/query/hash, so equality assertions stay stable.
  if (url.pathname === '/' && !url.search && !url.hash) {
    return `${url.protocol}//${url.host}`;
  }
  return url.toString();
}
