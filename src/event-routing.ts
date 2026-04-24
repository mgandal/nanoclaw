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

// ─── C12b: haystack hardening constants ──────────────────────────────────────
//
// The haystack is Ollama-derived → adversarial. Three defenses:
// 1. HAYSTACK_MAX_LEN caps the substring-match surface.
// 2. Word-boundary regex replaces raw includes() to prevent plural-suffix
//    bleeds ('grant' matching 'grants') and separator-less keyword stacking
//    ('grantnihvincent' matching three).
// 3. URGENT_CONFIDENCE_FLOOR gates the urgent-match +3 bonus — low-confidence
//    classifications cannot single-handedly escalate to specialist dispatch.

export const HAYSTACK_MAX_LEN = 500;
export const URGENT_CONFIDENCE_FLOOR = 0.6;
const URGENT_SCORE = 3;
const ROUTINE_SCORE = 1;
const URGENT_DOWNGRADED_SCORE = ROUTINE_SCORE;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary keyword match. `\b` anchors at ASCII word char transitions,
 * so hyphenated keywords like 'pull-request' still match on both sides
 * (the hyphen is non-word, giving a clean boundary on each end of the
 * compound). Case-insensitive by compile flag.
 */
function matchesKeyword(haystack: string, keyword: string): boolean {
  const kw = keyword.trim();
  if (!kw) return false;
  const re = new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i');
  return re.test(haystack);
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
  // C12b.1: bound the keyword-match surface even if upstream (C12)
  // sanitization is bypassed.
  const haystack = `${topic} ${summary}`.slice(0, HAYSTACK_MAX_LEN);

  // C12b.3: low-confidence Ollama classifications cannot drive urgent
  // specialist dispatch. Matches still score (preserving signal) but
  // only at the routine weight.
  const confidence = event.classification.confidence ?? 0;
  const urgentWeight =
    confidence >= URGENT_CONFIDENCE_FLOOR
      ? URGENT_SCORE
      : URGENT_DOWNGRADED_SCORE;

  let best: { agent: AgentIdentity; score: number; reason: string } | null =
    null;

  for (const agent of agents) {
    let score = 0;
    const matched: string[] = [];

    // C12b.2: word-boundary match, not substring. Prevents 'grant'
    // matching 'grants', and compound-planted 'grantnihvincent' from
    // scoring three unrelated keywords at once.
    if (agent.urgentTopics) {
      for (const kw of agent.urgentTopics) {
        if (matchesKeyword(haystack, kw)) {
          score += urgentWeight;
          matched.push(`urgent:${kw}`);
        }
      }
    }
    if (agent.routineTopics) {
      for (const kw of agent.routineTopics) {
        if (matchesKeyword(haystack, kw)) {
          score += ROUTINE_SCORE;
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
    best = {
      agent: lead,
      score: 0,
      reason: 'fallback to lead (no topic match)',
    };
  }

  // Resolve the agent's target group. Use the first entry in identity.groups
  // that has a registered JID; if no groups declared or none registered, use
  // the main group (so the lead can at least surface it).
  const candidateFolders =
    best.agent.groups && best.agent.groups.length > 0 ? best.agent.groups : [];

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
  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
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
