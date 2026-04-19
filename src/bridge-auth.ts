import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function bridgeTokenFilePath(): string {
  // Prefer $HOME over os.homedir() — on macOS os.homedir() reads
  // /etc/passwd and ignores $HOME overrides, which tests and operators
  // may set. Fall back to os.homedir() only if $HOME is unset.
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.cache', 'nanoclaw', 'bridge-token');
}

/**
 * Write the current bridge token to ~/.cache/nanoclaw/bridge-token with
 * mode 0600. Called at nanoclaw startup so launchd-spawned bridge
 * proxies (QMD, Apple Notes, Todoist, Calendar) can read the same
 * token from disk — they don't share nanoclaw's process env.
 *
 * Idempotent: re-running with the same cached token produces the same
 * file. New process → new token → file overwritten.
 */
export function writeBridgeTokenFile(): void {
  const filePath = bridgeTokenFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // writeFileSync with { mode } honours the mode on create; chmod
  // afterwards covers the umask-filtered case.
  fs.writeFileSync(filePath, getBridgeToken(), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/** Test-only — reset the cached token. */
export function _resetBridgeToken(): void {
  cachedToken = null;
}
