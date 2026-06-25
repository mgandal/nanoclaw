import { spawn } from 'child_process';
import path from 'path';

import { logger } from './logger.js';

/**
 * Follow-up Hub write-back poller (host side).
 *
 * The published hub page (here.now) is public, but the follow-up data lives on
 * this Mac. When Mike checks items and taps "Mark done", the page POSTs the
 * checked ids to a public ntfy.sh topic. This poller long-polls that topic and,
 * the moment a real submission lands, runs `followup-hub-publish.py --apply`,
 * which flips those follow-ups open -> done in followups.md and republishes the
 * page. End-to-end latency is seconds, not the old 30-minute cron round-trip.
 *
 * The id-matching + status-flip logic is shared with email-ingest
 * (email_ingest.followups.mark_done_by_ids) so the page and the matcher can
 * never drift. This module is the thin host-side driver: detect a submission,
 * shell out to the proven Python path, log the result.
 */

const RELAY_TOPIC = 'nanoclaw-relay-7406c450';
const NTFY_STREAM_URL = `https://ntfy.sh/${RELAY_TOPIC}/json`;
// Reconnect backoff for the long-poll (ntfy or network hiccup).
const RECONNECT_MS = 5_000;
// Coalesce a burst of submissions into one --apply run.
const APPLY_DEBOUNCE_MS = 1_500;

/**
 * Decide whether an ntfy stream line represents a real Follow-up Hub submission
 * that warrants running --apply. Pure + total: any parse failure or
 * non-actionable event returns false. Extracted so the trigger logic is unit
 * tested independently of the network/subprocess glue.
 */
export function shouldTriggerApply(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let env: unknown;
  try {
    env = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof env !== 'object' || env === null) return false;
  const e = env as Record<string, unknown>;
  if (e.event !== 'message') return false;
  if (typeof e.message !== 'string') return false;
  let body: unknown;
  try {
    body = JSON.parse(e.message);
  } catch {
    return false;
  }
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b.test === true || b.processed === true) return false;
  if (!Array.isArray(b.items)) return false;
  return b.items.some(
    (it) =>
      it &&
      typeof it === 'object' &&
      ((it as Record<string, unknown>).itemType === 'followup' ||
        (it as Record<string, unknown>).type === 'followup'),
  );
}

function runApply(projectRoot: string): Promise<void> {
  return new Promise((resolve) => {
    const script = path.join(
      projectRoot,
      'groups/global/state/followup-hub-publish.py',
    );
    const env = {
      ...process.env,
      FOLLOWUPS_PATH: path.join(
        projectRoot,
        'groups/global/state/followups.md',
      ),
      HUB_STATE_PATH: path.join(
        projectRoot,
        'groups/global/state/followup-hub-state.json',
      ),
      RELAY_STATE_PATH: path.join(
        projectRoot,
        'groups/global/state/relay-last-id.txt',
      ),
      EMAIL_INGEST_PATH: path.join(projectRoot, 'scripts/sync'),
    };
    const child = spawn('python3', [script, '--apply'], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      logger.error({ err: e }, 'Follow-up Hub --apply failed to spawn');
      resolve();
    });
    child.on('close', (code) => {
      const markedMatch = out.match(/MARKED_JSON=(.*)$/m);
      let marked: string[] = [];
      if (markedMatch) {
        try {
          marked = JSON.parse(markedMatch[1]);
        } catch {
          /* ignore */
        }
      }
      if (code === 0) {
        if (marked.length > 0) {
          logger.info(
            { count: marked.length, marked },
            'Follow-up Hub: marked items done from mini-app submission',
          );
        } else {
          logger.debug('Follow-up Hub: --apply ran, nothing new to mark');
        }
      } else {
        logger.warn(
          { code, stderr: err.slice(0, 500) },
          'Follow-up Hub --apply exited non-zero',
        );
      }
      resolve();
    });
  });
}

/**
 * Start long-polling the relay topic. Returns a stop handle for graceful
 * shutdown. Safe to call once at startup; never throws.
 */
export function startFollowupHubPoller(projectRoot: string = process.cwd()): {
  stop: () => void;
} {
  let stopped = false;
  let controller: AbortController | null = null;
  let applyTimer: NodeJS.Timeout | null = null;
  let applyInFlight = false;
  let pendingApply = false;

  const triggerApply = () => {
    if (applyTimer) return; // already debouncing
    applyTimer = setTimeout(() => {
      applyTimer = null;
      void drainApply();
    }, APPLY_DEBOUNCE_MS);
  };

  const drainApply = async () => {
    if (applyInFlight) {
      pendingApply = true;
      return;
    }
    applyInFlight = true;
    try {
      await runApply(projectRoot);
    } finally {
      applyInFlight = false;
      if (pendingApply) {
        pendingApply = false;
        void drainApply();
      }
    }
  };

  const loop = async () => {
    // Catch-up pass on startup: drain anything submitted while we were down.
    void drainApply();

    while (!stopped) {
      controller = new AbortController();
      try {
        // Long-poll: omit poll=1 so ntfy holds the connection open and streams
        // new messages as they arrive. `since=all` on first connect would replay
        // history, but --apply is idempotent (cursor in relay-last-id.txt), so we
        // ask only for live messages here and let the catch-up drainApply handle
        // backlog.
        const res = await fetch(`${NTFY_STREAM_URL}?since=0s`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'nanoclaw-followup-hub/1' },
        });
        if (!res.ok || !res.body) {
          throw new Error(`ntfy stream ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (shouldTriggerApply(line)) {
              logger.info('Follow-up Hub: submission detected, applying');
              triggerApply();
            }
          }
        }
      } catch (err) {
        if (stopped) break;
        if ((err as Error)?.name !== 'AbortError') {
          logger.debug(
            { err: (err as Error)?.message },
            'Follow-up Hub poller stream dropped, reconnecting',
          );
        }
      }
      if (!stopped) {
        await new Promise((r) => setTimeout(r, RECONNECT_MS));
      }
    }
  };

  void loop();
  logger.info('Follow-up Hub write-back poller started (ntfy long-poll)');

  return {
    stop: () => {
      stopped = true;
      controller?.abort();
      if (applyTimer) clearTimeout(applyTimer);
    },
  };
}
