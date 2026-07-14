import { logger } from '../logger.js';

/**
 * The one polling lifecycle for host-side Watchers. Before this helper,
 * the watchers re-implemented scheduling through three incompatible
 * idioms (self-rescheduling setTimeout chains, bare setInterval, and
 * caller-owned timers) and none of the reschedule/stop behavior was
 * tested. The loop is a self-rescheduling setTimeout chain: the next
 * tick is scheduled only AFTER the current run completes, so a slow poll
 * can never overlap itself (the reason calendar-watcher rejected
 * setInterval). A throwing poll is logged (or given to onError) and the
 * chain continues — a watcher never dies silently.
 *
 * NOT used by GmailWatcher: its lifecycle is auth-aware (backoff
 * schedule, Pub/Sub push mode, stop-after-max-attempts) and is
 * separately tested; folding that in would trade tested behavior for
 * uniformity.
 */
export interface PollingLoopOptions {
  /** Log label, e.g. 'task-outcome'. */
  name: string;
  intervalMs: number;
  /** Run the first poll now instead of after one interval. Default false. */
  runImmediately?: boolean;
  /** Default: logger.warn and continue. */
  onError?: (err: unknown) => void;
  /**
   * Warn when a single tick runs longer than this (a hung tick blocks the
   * chain forever — unlike setInterval, this loop never overlaps — so a
   * wedged downstream await, e.g. the 2026-05-21 slack-mcp hang, would
   * otherwise stop the watcher silently). Log-only. Default 5 minutes.
   */
  tickWarnMs?: number;
}

export interface PollingLoopHandle {
  stop(): void;
}

export function startPollingLoop(
  fn: () => void | Promise<void>,
  opts: PollingLoopOptions,
): PollingLoopHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const handleError =
    opts.onError ??
    ((err: unknown) =>
      logger.warn({ err, watcher: opts.name }, 'polling loop tick failed'));

  const tickWarnMs = opts.tickWarnMs ?? 5 * 60_000;

  const runOnce = async (): Promise<void> => {
    timer = null;
    const hungTickWarn = setTimeout(() => {
      logger.warn(
        { watcher: opts.name, tickWarnMs },
        'polling loop tick still running — chain is blocked until it settles',
      );
    }, tickWarnMs);
    try {
      await fn();
    } catch (err) {
      handleError(err);
    } finally {
      clearTimeout(hungTickWarn);
    }
    if (!stopped) {
      timer = setTimeout(() => void runOnce(), opts.intervalMs);
    }
  };

  if (opts.runImmediately) {
    void runOnce();
  } else {
    timer = setTimeout(() => void runOnce(), opts.intervalMs);
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
