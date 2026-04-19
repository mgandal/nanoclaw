import crypto from 'crypto';

let cachedToken: string | null = null;

/**
 * Return a stable per-process bearer token for MCP-bridge auth.
 *
 * Precedence:
 *   1. `NANOCLAW_BRIDGE_TOKEN` env var (if set and >= 32 chars) — lets
 *      operators pin a token that outlives a single nanoclaw process and
 *      is shared with the bridge servers' server-side config.
 *   2. Random 32-byte URL-safe base64 — minted once per process, stable
 *      across subsequent calls.
 *
 * Why per-process (not per-group): the bridge servers (QMD, Apple Notes,
 * Todoist, Calendar, Honcho, Hindsight) run as sibling launchd jobs that
 * outlive any single nanoclaw process. The proportionate single-user fix
 * is one shared bearer documented in the server's config; per-group
 * tokens would require a mint server.
 */
export function getBridgeToken(): string {
  if (cachedToken) return cachedToken;
  const fromEnv = process.env.NANOCLAW_BRIDGE_TOKEN;
  if (fromEnv && fromEnv.length >= 32) {
    cachedToken = fromEnv;
    return cachedToken;
  }
  cachedToken = crypto.randomBytes(32).toString('base64url');
  return cachedToken;
}

/**
 * Constant-time compare against the current token. Reject empty /
 * different-length inputs before the timing-safe compare (timingSafeEqual
 * throws on length mismatch; we return false).
 */
export function verifyBridgeToken(candidate: string): boolean {
  if (!candidate) return false;
  const expected = getBridgeToken();
  if (candidate.length !== expected.length) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return crypto.timingSafeEqual(a, b);
}

/** Test-only — reset the cached token. */
export function _resetBridgeToken(): void {
  cachedToken = null;
}
