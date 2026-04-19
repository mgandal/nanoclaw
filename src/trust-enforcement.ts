import { logger } from './logger.js';
import { insertAgentAction, insertPendingAction } from './db.js';

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

export interface CheckTrustAndStageInput {
  agentName: string;
  groupFolder: string;
  actionType: string;
  summary: string;
  target?: string;
  payloadForStaging: Record<string, unknown>;
  trust: { actions: Record<string, string> } | null;
}

export interface CheckTrustAndStageResult {
  allowed: boolean;
  level: string;
  notify: boolean;
  /** Non-null only when the action was staged into pending_actions. */
  pendingId: string | null;
}

/**
 * Combines checkTrust + agent_actions audit log + (on stage) pending_actions
 * insert. Callers use this instead of re-implementing the trust-gate pattern
 * inline. Behaviour matches the send_message reference path in ipc.ts.
 *
 * C13 migration helper — every privileged IPC action routes through this.
 */
export function checkTrustAndStage(
  input: CheckTrustAndStageInput,
): CheckTrustAndStageResult {
  const decision = checkTrust(
    input.agentName,
    input.groupFolder,
    input.actionType,
    input.trust,
  );

  insertAgentAction({
    agent_name: input.agentName,
    group_folder: input.groupFolder,
    action_type: input.actionType,
    trust_level: decision.level,
    summary: input.summary.slice(0, 200),
    target: input.target,
    outcome: decision.allowed
      ? 'allowed'
      : decision.stage
        ? 'staged'
        : 'blocked',
  });

  let pendingId: string | null = null;
  if (!decision.allowed && decision.stage) {
    pendingId = insertPendingAction({
      agent_name: input.agentName,
      group_folder: input.groupFolder,
      action_type: input.actionType,
      summary: input.summary,
      payload: input.payloadForStaging,
    });
    logger.info(
      {
        pendingId,
        agentName: input.agentName,
        actionType: input.actionType,
        level: decision.level,
      },
      `Trust: ${input.actionType} staged for approval`,
    );
  } else if (!decision.allowed) {
    logger.info(
      {
        agentName: input.agentName,
        actionType: input.actionType,
        groupFolder: input.groupFolder,
        level: decision.level,
      },
      `Trust: ${input.actionType} blocked for agent`,
    );
  }

  return {
    allowed: decision.allowed,
    level: decision.level,
    notify: decision.notify,
    pendingId,
  };
}
