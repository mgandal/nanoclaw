/**
 * Match classified events to the right agent for action.
 *
 * The event-router classifies emails/calendar items into a Classification
 * {importance, urgency, topic, summary, routing}. But classification alone
 * doesn't pick a handler — someone has to act on the event. This module
 * picks the target agent + group and produces the bus message payload that
 * dispatches the event to that agent via the bus-watcher.
 *
 * Scoring (higher = better fit):
 *   +3  topic text matches an urgent_topic keyword
 *   +1  topic text matches a routine_topic keyword
 *   +1  agent has a `groups` list that includes a group that looks
 *       related to the event (lab-claw, code-claw, etc.)
 *
 * Fallback: the lead agent (claire). Every registered agent has some
 * access to the user via its group chat, so the lead is always a valid
 * default rather than dropping the event.
 */

import type { AgentIdentity } from './agent-registry.js';
import type { ClassifiedEvent } from './event-router.js';
import type { RegisteredGroup } from './types.js';

export interface RouteTarget {
  /** The agent dirName to wake up. */
  agentName: string;
  /** Group folder the agent runs in (first from identity.groups, or main). */
  groupFolder: string;
  /** JID the group is registered on — used to address runAgent. */
  chatJid: string;
  /** Score the routing decision won with (for logs). */
  score: number;
  /** Why this agent was chosen (for logs). */
  reason: string;
}

/**
 * Route a classified event to the agent who should act on it.
 *
 * Returns null if no usable target can be found (e.g. no lead agent
 * registered, no groups registered) — caller should fall back to a
 * system alert rather than dropping the event silently.
 */
export function routeClassifiedEvent(
  event: ClassifiedEvent,
  agents: AgentIdentity[],
  registeredGroups: Record<string, RegisteredGroup>,
): RouteTarget | null {
  const topic = (event.classification.topic || '').toLowerCase();
  const summary = (event.classification.summary || '').toLowerCase();
  const haystack = `${topic} ${summary}`;

  let best: { agent: AgentIdentity; score: number; reason: string } | null =
    null;

  for (const agent of agents) {
    let score = 0;
    const matched: string[] = [];

    if (agent.urgentTopics) {
      for (const kw of agent.urgentTopics) {
        if (kw && haystack.includes(kw.toLowerCase())) {
          score += 3;
          matched.push(`urgent:${kw}`);
        }
      }
    }
    if (agent.routineTopics) {
      for (const kw of agent.routineTopics) {
        if (kw && haystack.includes(kw.toLowerCase())) {
          score += 1;
          matched.push(`routine:${kw}`);
        }
      }
    }

    // Prefer scored matches; tie-breaking picks the lead agent if no topics matched.
    if (score > 0 && (!best || score > best.score)) {
      best = {
        agent,
        score,
        reason: `topics matched [${matched.join(', ')}]`,
      };
    }
  }

  if (!best) {
    // No topic match — fall back to lead agent.
    const lead = agents.find((a) => a.lead === true);
    if (!lead) return null;
    best = { agent: lead, score: 0, reason: 'fallback to lead (no topic match)' };
  }

  // Resolve the agent's target group. Use the first entry in identity.groups
  // that has a registered JID; if no groups declared or none registered, use
  // the main group (so the lead can at least surface it).
  const candidateFolders =
    best.agent.groups && best.agent.groups.length > 0
      ? best.agent.groups
      : [];

  for (const folder of candidateFolders) {
    for (const [jid, g] of Object.entries(registeredGroups)) {
      if (g.folder === folder) {
        return {
          agentName: best.agent.dirName,
          groupFolder: folder,
          chatJid: jid,
          score: best.score,
          reason: best.reason,
        };
      }
    }
  }

  // Final fallback: any registered group that has this agent by name
  // (e.g. lead in main) — use the main group if available.
  const mainEntry = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain,
  );
  if (mainEntry) {
    return {
      agentName: best.agent.dirName,
      groupFolder: mainEntry[1].folder,
      chatJid: mainEntry[0],
      score: best.score,
      reason: `${best.reason} (main fallback)`,
    };
  }

  return null;
}
