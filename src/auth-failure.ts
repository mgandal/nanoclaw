import { execFile } from 'child_process';
import { resolve as resolvePath } from 'path';

import { logger } from './logger.js';

/**
 * Anthropic auth-failure containment.
 *
 * When the OAuth token expires, the Claude Agent SDK does not throw — it
 * returns a normal result whose *text* is the failure ("Failed to
 * authenticate. API Error: 401 …"). The host used to deliver that text as
 * the agent's reply, so a single expired token produced one 401 message in
 * every group that happened to have a turn or a scheduled task during the
 * outage, and each of those turns was recorded as a success (its messages
 * consumed, never retried).
 *
 * This module is the single place that decides such text is an auth failure.
 * Detection feeds three responses:
 *   1. deliverText drops the text instead of sending it to a chat.
 *   2. One system alert goes out per incident (OPS-claw only, via
 *      sendSystemAlert's own cooldown).
 *   3. A bounded, self-expiring backoff stops the host spawning more
 *      containers that can only fail the same way, plus a self-heal that
 *      re-syncs the OAuth token from the keychain.
 *
 * An incident ends when auth is observed working again (clearAuthIncident,
 * called from the credential proxy on any non-401/403 upstream response).
 */

/**
 * Fixed prefixes the SDK emits for authentication failures (cli.js: the
 * `error:"authentication_failed"` branches). Anchored at the start of the
 * trimmed text so an agent *discussing* a 401 mid-reply is not suppressed.
 */
const AUTH_FAILURE_PREFIXES = [
  'Failed to authenticate.',
  'Please run /login',
  'Authentication error · This may be a temporary network issue',
  'Your account does not have access to Claude',
  'Your organization does not have access to Claude',
];

/** How long to stop spawning agent containers after an auth failure. */
export const AUTH_BACKOFF_MS = 5 * 60 * 1000;

/** Minimum gap between self-heal (token re-sync) attempts. */
export const AUTH_SELF_HEAL_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Constant alert body. sendSystemAlert dedupes on `${service}:${message}`,
 * so the varying request_id from the raw SDK text must never appear here.
 */
export const AUTH_ALERT_SERVICE = 'Anthropic Auth';
export const AUTH_ALERT_MESSAGE =
  'Agent turns are failing to authenticate (401). Replies carrying the raw error were suppressed and the affected messages will be retried.';
export const AUTH_ALERT_FIX =
  'Check CLAUDE_CODE_OAUTH_TOKEN in .env against the keychain (scripts/refresh-oauth.sh). If the keychain token itself has expired, run Claude Code once to rotate it.';

export interface AuthFailureHandlers {
  /** Delivered through sendSystemAlert → one channel, cooldown-deduped. */
  alert: (service: string, message: string, fixInstructions?: string) => void;
  /** Re-sync the OAuth token (scripts/refresh-oauth.sh). May reject. */
  selfHeal: () => Promise<unknown>;
}

let handlers: AuthFailureHandlers | null = null;
let backoffUntil = 0;
let alertedThisIncident = false;
let lastSelfHealAt = 0;

export function isAuthFailureText(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trimStart();
  return AUTH_FAILURE_PREFIXES.some((p) => trimmed.startsWith(p));
}

export function initAuthFailureHandling(h: AuthFailureHandlers): void {
  handlers = h;
}

/** True while the host should refuse to spawn further agent containers. */
export function isAuthBackoffActive(now: number = Date.now()): boolean {
  return now < backoffUntil;
}

/**
 * Auth is working again: end the incident so the next failure alerts
 * immediately and agent spawns resume without waiting out the backoff.
 */
export function clearAuthIncident(): void {
  if (backoffUntil === 0 && !alertedThisIncident) return;
  backoffUntil = 0;
  alertedThisIncident = false;
  logger.info('Anthropic auth recovered — incident cleared');
}

/**
 * Record an auth failure seen by `source`. Safe to call from every group and
 * every request: at most one alert per incident and one self-heal per
 * cooldown. Never rejects — callers are fire-and-forget paths.
 */
export async function reportAuthFailure(source: string): Promise<void> {
  const now = Date.now();
  backoffUntil = now + AUTH_BACKOFF_MS;

  // Claim both one-shots synchronously. Every group reports the same incident
  // within the same tick; deciding after an await would let each concurrent
  // caller read a stale "not alerted yet" and re-open the flood this fixes.
  const firstOfIncident = !alertedThisIncident;
  if (firstOfIncident) alertedThisIncident = true;
  const shouldSelfHeal =
    handlers !== null && now - lastSelfHealAt >= AUTH_SELF_HEAL_COOLDOWN_MS;
  if (shouldSelfHeal) lastSelfHealAt = now;

  logger.error(
    { source, firstOfIncident, tag: 'SYSTEM_ALERT' },
    'Anthropic authentication failure',
  );

  if (!handlers) return;

  if (firstOfIncident) {
    handlers.alert(AUTH_ALERT_SERVICE, AUTH_ALERT_MESSAGE, AUTH_ALERT_FIX);
  }

  if (shouldSelfHeal) {
    try {
      const outcome = await handlers.selfHeal();
      logger.info({ source, outcome }, 'Auth self-heal attempted');
    } catch (err) {
      logger.warn({ err, source }, 'Auth self-heal failed');
    }
  }
}

/**
 * The self-heal: re-copy the OAuth token from the Claude Code keychain entry
 * into .env (the credential proxy re-reads .env per request, so no restart).
 * Fixes a .env that has drifted behind the keychain without waiting for the
 * 15-minute launchd tick. It cannot revive a keychain token that has itself
 * expired — that still needs the alert, which is why both run.
 */
export const OAUTH_REFRESH_SCRIPT = 'scripts/refresh-oauth.sh';
const OAUTH_REFRESH_TIMEOUT_MS = 30_000;

export function runOAuthRefreshScript(
  scriptPath: string = resolvePath(OAUTH_REFRESH_SCRIPT),
): Promise<string> {
  return new Promise((resolveOutcome, reject) => {
    execFile(
      '/bin/bash',
      [scriptPath],
      { timeout: OAUTH_REFRESH_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${OAUTH_REFRESH_SCRIPT} failed: ${err.message}${
                stderr ? ` — ${stderr.trim().slice(0, 200)}` : ''
              }`,
            ),
          );
          return;
        }
        resolveOutcome(stdout.trim().slice(0, 200) || 'ok');
      },
    );
  });
}

/** Test-only: drop wiring and incident state. */
export function resetAuthFailureState(): void {
  handlers = null;
  backoffUntil = 0;
  alertedThisIncident = false;
  lastSelfHealAt = 0;
}
