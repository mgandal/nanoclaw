import { logger } from './logger.js';

export interface TrustDecision {
  allowed: boolean;
  level: string;
  notify: boolean;
}

/**
 * Check whether an agent is allowed to perform an action based on trust.yaml.
 * Returns a decision: allowed (execute), level (for logging), notify (post notification).
 *
 * Null trust = legacy mode (no trust file) — all actions allowed.
 */
export function checkTrust(
  agentName: string,
  groupFolder: string,
  actionType: string,
  trust: { actions: Record<string, string> } | null,
): TrustDecision {
  if (!trust) {
    return { allowed: true, level: 'autonomous', notify: false };
  }

  const level = trust.actions[actionType] || 'ask';

  switch (level) {
    case 'autonomous':
      return { allowed: true, level, notify: false };
    case 'notify':
      return { allowed: true, level, notify: true };
    case 'draft':
    case 'ask':
    default:
      logger.info(
        { agentName, groupFolder, actionType, level },
        'Trust: action blocked',
      );
      return { allowed: false, level, notify: false };
  }
}
