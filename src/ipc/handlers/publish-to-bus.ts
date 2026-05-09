import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  toAgent: string;
  toGroup: string; // empty string means "default to caller's base group"
  topic: string;
  /**
   * Raw summary if the payload provided a string; null if the field was
   * absent or non-string. Preserves the original switch's distinction
   * between "no summary" (renders `(no summary)`) and "explicit empty
   * string" (renders empty after the colon).
   */
  summary: string | null;
  priority?: 'low' | 'medium' | 'high';
  payload: unknown;
}

const SUMMARY_AUDIT_MAX = 500;
const SUMMARY_NOTIFY_MAX = 120;
const TOPIC_MAX = 100;

export const publishToBusHandler: IpcHandler<Input> = {
  type: 'publish_to_bus',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;

    if (typeof r.to_agent !== 'string' || r.to_agent.length === 0) return null;
    if (typeof r.topic !== 'string' || r.topic.length === 0) return null;

    // Path-traversal hardening — to_agent and to_group flow into a filesystem
    // key (`${targetGroup}--${toAgent}`) used by MessageBus.writeAgentMessage.
    if (r.to_agent.includes('..') || r.to_agent.includes('/')) return null;
    const toGroup = typeof r.to_group === 'string' ? r.to_group : '';
    if (toGroup.includes('..') || toGroup.includes('/')) return null;

    const priority =
      r.priority === 'low' || r.priority === 'medium' || r.priority === 'high'
        ? r.priority
        : undefined;

    return {
      toAgent: r.to_agent,
      toGroup,
      topic: r.topic,
      summary: typeof r.summary === 'string' ? r.summary : null,
      priority,
      payload: r.payload,
    };
  },

  authorize(input, ctx) {
    // toGroup defaults to the caller's base group when unspecified.
    const targetGroup = input.toGroup || ctx.baseGroup;

    // Non-main senders can only publish into their own base group. Otherwise
    // a specialist could inject a prompt into another group's lead agent via
    // the bus-watcher dispatch, which renders summary directly into the
    // runAgent prompt.
    if (!ctx.isMain && targetGroup !== ctx.baseGroup) {
      logger.warn(
        {
          sourceGroup: ctx.sourceGroup,
          targetGroup,
          sourceAgent: ctx.agentName,
        },
        'Unauthorized publish_to_bus attempt blocked (cross-group)',
      );
      return null;
    }

    const compositeTarget = `${targetGroup}--${input.toAgent}`;
    const auditSummary = (input.summary ?? '').slice(0, SUMMARY_AUDIT_MAX);
    // Parity with the original switch: only an absent/non-string summary
    // renders '(no summary)'. An explicit empty string still renders empty
    // after the colon — preserving the unchanged user-facing behavior.
    const notifySummary =
      input.summary === null
        ? `→ ${input.toAgent}@${targetGroup}: (no summary)`
        : `→ ${input.toAgent}@${targetGroup}: ${input.summary.slice(0, SUMMARY_NOTIFY_MAX)}`;

    return {
      target: compositeTarget,
      auditSummary,
      notifySummary,
      payloadForStaging: {
        type: 'publish_to_bus',
        to_agent: input.toAgent,
        to_group: targetGroup,
        topic: input.topic.slice(0, TOPIC_MAX),
        priority: input.priority,
        summary: auditSummary,
        payload: input.payload,
      },
    };
  },

  execute(input, ctx) {
    if (!ctx.deps.messageBus) {
      // Latent original behavior: silently no-op the publish when no bus is
      // wired. The post-hoc notify still fires (dispatcher-level), preserving
      // the prior "send notification for an undelivered message" quirk.
      return;
    }

    const targetGroup = input.toGroup || ctx.baseGroup;
    const safeSummary = (input.summary ?? '').slice(0, SUMMARY_AUDIT_MAX);
    const safeTopic = input.topic.slice(0, TOPIC_MAX);
    if (safeTopic !== input.topic) {
      logger.warn(
        { topicLen: input.topic.length },
        'publish_to_bus: topic truncated to 100 chars',
      );
    }

    const targetFsKey = `${targetGroup}--${input.toAgent}`;
    ctx.deps.messageBus.writeAgentMessage(targetFsKey, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: ctx.agentName || ctx.sourceGroup,
      topic: safeTopic,
      priority: input.priority,
      summary: safeSummary,
      to_agent: input.toAgent,
      to_group: targetGroup,
      payload: input.payload,
      timestamp: new Date().toISOString(),
    });
    logger.info(
      { from: ctx.agentName, to: input.toAgent, topic: safeTopic },
      'Bus message published via IPC',
    );
  },
};
