import { logger } from './logger.js';

export interface TrustDecision {
  /** Whether the action should execute immediately. */
  allowed: boolean;
  /** Raw trust level from trust.yaml (for audit logging). */
  level: string;
  /**
   * If true, the action was allowed — but the caller should also send a
   * post-hoc notification to main so the user sees what happened.
   * Distinct from `autonomous` (silent).
   */
  notify: boolean;
  /**
   * If true, the action should NOT execute immediately — the caller should
   * instead insert a pending_actions row and surface it in the approval
   * queue. The user unblocks execution via /approve <id>.
   * Set for levels 'draft' and 'ask'. Distinct from legacy "blocked"
   * which silently dropped the action.
   */
  stage: boolean;
}

/**
 * Check whether an agent is allowed to perform an action based on trust.yaml.
 *
 * Null trust = legacy mode (no trust file) — all actions allowed immediately.
 *
 * Levels:
 *   autonomous — execute silently.
 *   notify     — execute, then send a post-hoc notification to main.
 *   draft      — stage the action for user approval (DO NOT execute).
 *   ask        — same as draft today; distinction reserved for future policy
 *                (e.g. ask = "require re-confirmation per invocation" vs.
 *                draft = "promote to autonomous after N approvals").
 *
 * Unknown levels default to 'ask' (fail-safe stage, not silent drop).
 */
export function checkTrust(
  agentName: string,
  groupFolder: string,
  actionType: string,
  trust: { actions: Record<string, string> } | null,
): TrustDecision {
  if (!trust) {
    return { allowed: true, level: 'autonomous', notify: false, stage: false };
  }

  const level = trust.actions[actionType] || 'ask';

  switch (level) {
    case 'autonomous':
      return { allowed: true, level, notify: false, stage: false };
    case 'notify':
      return { allowed: true, level, notify: true, stage: false };
    case 'draft':
    case 'ask':
      logger.info(
        { agentName, groupFolder, actionType, level },
        'Trust: action staged for approval',
      );
      return { allowed: false, level, notify: false, stage: true };
    default:
      logger.warn(
        { agentName, groupFolder, actionType, level },
        'Trust: unknown level, defaulting to stage (ask)',
      );
      return { allowed: false, level: 'ask', notify: false, stage: true };
  }
}
