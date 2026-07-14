import { AgentIdentity } from './agent-registry.js';
import { compoundKey, compoundKeyToFsPath } from './compound-key.js';
import { ClassifiedEvent } from './event-router.js';
import { routeClassifiedEvent } from './event-routing.js';
import { logger } from './logger.js';
import type { MessageBus } from './message-bus.js';
import type { RegisteredGroup } from './types.js';

/**
 * Turns an escalated ClassifiedEvent into an agent bus dispatch — the
 * EventRouter's onEscalate hook. Routing picks the best-matching agent
 * (routeClassifiedEvent); the bus-watcher later spawns that agent with the
 * event's full payload attached. When no target resolves, or the bus write
 * throws, the event falls back to a main-group system alert so it is never
 * dropped silently. Extracted from the ~70-line closure in main() so the
 * fallback behavior is testable without wiring the world.
 */
export interface EscalationDispatcherDeps {
  getAgents: () => AgentIdentity[];
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  messageBus: Pick<MessageBus, 'writeAgentMessage'>;
  sendSystemAlert: (service: string, detail: string) => Promise<void>;
}

export function createEscalationDispatcher(
  deps: EscalationDispatcherDeps,
): (event: ClassifiedEvent) => Promise<void> {
  return async (event) => {
    const target = routeClassifiedEvent(
      event,
      deps.getAgents(),
      deps.getRegisteredGroups(),
    );

    if (!target) {
      logger.warn(
        { eventId: event.event.id, topic: event.classification.topic },
        'Event escalated but no agent target resolved; falling back to alert',
      );
      void deps.sendSystemAlert('Event Escalation', event.classification.summary);
      return;
    }

    logger.info(
      {
        eventId: event.event.id,
        targetAgent: target.agentName,
        targetGroup: target.groupFolder,
        score: target.score,
        reason: target.reason,
      },
      'Event escalated → dispatching to agent via bus',
    );

    try {
      const targetFsKey = compoundKeyToFsPath(
        compoundKey(target.groupFolder, target.agentName),
      );
      deps.messageBus.writeAgentMessage(targetFsKey, {
        id: `evt-${event.event.id}-${Date.now()}`,
        from: 'event-router',
        topic: `escalate:${event.classification.topic || 'general'}`,
        priority: 'high',
        summary:
          event.classification.summary ||
          `${event.event.type} event requires attention`,
        payload: {
          eventType: event.event.type,
          eventId: event.event.id,
          eventTimestamp: event.event.timestamp,
          eventPayload: event.event.payload,
          classification: event.classification,
          routing: event.routing,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(
        { err, eventId: event.event.id, target },
        'Bus dispatch failed for escalated event; falling back to alert',
      );
      void deps.sendSystemAlert('Event Escalation', event.classification.summary);
    }
  };
}
