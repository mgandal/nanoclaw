import {
  AGENT_COOLDOWN_MINUTES,
  DEDUP_WINDOW_HOURS,
  QUIET_OVERRIDE_THRESHOLD,
} from './config.js';
import {
  hasDeliveredOrDispatchedRecent,
  getLastAgentSend,
  insertLog,
} from './proactive-log.js';

export interface ProactiveSend {
  fromAgent: string;
  toGroup: string;
  message: string;
  urgency: number;
  correlationId: string;
  ruleId?: string;
  contributingEvents: string[];
}

export interface GovernorDecision {
  decision: 'send' | 'defer' | 'drop';
  reason: string;
  deliverAt?: string;
  logId: number;
}

export interface GovernorContext {
  enabled: boolean;
  governorOn: boolean;
  isPaused: (file: string) => boolean;
  isInQuiet: (now: Date) => boolean;
  nextQuietEnd: (now: Date) => Date;
  now: () => Date;
  pauseFile: string;
}

export function decide(
  send: ProactiveSend,
  ctx: GovernorContext,
): GovernorDecision {
  const now = ctx.now();
  const nowIso = now.toISOString();

  const write = (
    decision: 'send' | 'defer' | 'drop',
    reason: string,
    deliverAt?: string,
  ): GovernorDecision => {
    const logId = insertLog({
      timestamp: nowIso,
      fromAgent: send.fromAgent,
      toGroup: send.toGroup,
      decision,
      reason,
      urgency: send.urgency,
      ruleId: send.ruleId,
      correlationId: send.correlationId || '(missing)',
      messagePreview: send.message.slice(0, 200),
      contributingEvents: send.contributingEvents,
      deliverAt,
    });
    return { decision, reason, deliverAt, logId };
  };

  // Decision order matters. See spec Task 6 decision-order tests.
  if (!send.correlationId) return write('drop', 'missing_correlation_id');
  if (!ctx.enabled) return write('drop', 'kill_switch');
  if (ctx.isPaused(ctx.pauseFile)) return write('drop', 'paused');
  if (hasDeliveredOrDispatchedRecent(send.correlationId, DEDUP_WINDOW_HOURS)) {
    return write('drop', 'duplicate_recent');
  }
  const last = getLastAgentSend(send.fromAgent);
  if (last) {
    const ageMin =
      (now.getTime() - new Date(last.timestamp).getTime()) / 60_000;
    if (ageMin < AGENT_COOLDOWN_MINUTES) {
      const remainMs = (AGENT_COOLDOWN_MINUTES - ageMin) * 60_000;
      return write(
        'defer',
        'agent_cooldown',
        new Date(now.getTime() + remainMs).toISOString(),
      );
    }
  }
  if (ctx.isInQuiet(now) && send.urgency < QUIET_OVERRIDE_THRESHOLD) {
    return write('defer', 'quiet_hours', ctx.nextQuietEnd(now).toISOString());
  }
  return write('send', 'approved');
}
