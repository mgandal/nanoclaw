import { VaultDeltaWatcher } from '../watchers/vault-delta-watcher.js';
import { TaskOutcomeWatcher } from '../watchers/task-outcome-watcher.js';
import { ThreadSilenceWatcher } from '../watchers/thread-silence-watcher.js';
import { QmdEmailAdapter } from '../watchers/qmd-email-adapter.js';
import { DeferredSendProcessor } from '../watchers/deferred-send-processor.js';
import type { EventRouter } from '../event-router.js';
import { PROACTIVE_WATCHERS_ENABLED } from '../config.js';
import { logger } from '../logger.js';

export interface ProactiveWiringDeps {
  eventRouter: EventRouter;
  vaultRoots: string[];
  emailExportDir: string;
  hasRecentEmission: (threadId: string) => boolean;
  sendDeferred: (s: {
    toGroup: string;
    text: string;
    correlationId: string;
    fromAgent: string;
    urgency: number;
    ruleId?: string;
    contributingEvents: string[];
  }) => Promise<void>;
}

/**
 * Wire the proactive watchers (vault delta, task outcome, thread silence,
 * deferred send processor) into the running process. All emissions are
 * funneled through the EventRouter; the deferred processor re-enters
 * deliverSendMessage with proactive:true so the governor applies.
 *
 * When PROACTIVE_WATCHERS_ENABLED=false (default), returns a no-op stop handle
 * and does not start any timers or filesystem watches.
 */
export function wireProactiveWatchers(deps: ProactiveWiringDeps): {
  stop: () => void;
} {
  if (!PROACTIVE_WATCHERS_ENABLED) {
    logger.info(
      'proactive watchers disabled by PROACTIVE_WATCHERS_ENABLED flag',
    );
    return {
      stop: () => {
        /* noop */
      },
    };
  }

  logger.info(
    {
      vaultRoots: deps.vaultRoots.length,
      emailExportDir: deps.emailExportDir,
    },
    'starting proactive watchers',
  );

  const vault = new VaultDeltaWatcher({
    roots: deps.vaultRoots,
    onEvent: (e) => {
      void deps.eventRouter.route(e);
    },
  });
  const outcome = new TaskOutcomeWatcher({
    onEvent: (e) => {
      void deps.eventRouter.route(e);
    },
  });
  const silence = new ThreadSilenceWatcher({
    qmd: new QmdEmailAdapter(deps.emailExportDir),
    onEvent: (e) => {
      void deps.eventRouter.route(e);
    },
    hasRecentEmission: deps.hasRecentEmission,
  });
  const deferred = new DeferredSendProcessor({
    send: deps.sendDeferred,
  });

  vault.start();
  outcome.start();
  deferred.start();
  // Poll thread silence every 4 hours (idempotent via hasRecentEmission).
  const silenceTimer = setInterval(() => {
    void silence.poll();
  }, 4 * 3600_000);

  return {
    stop: () => {
      vault.stop();
      outcome.stop();
      deferred.stop();
      clearInterval(silenceTimer);
    },
  };
}
