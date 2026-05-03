import { logger } from './logger.js';

export interface FirePostHocNotifyInput {
  /** Whether the trust decision requested a post-hoc notification. */
  notify: boolean;
  /** The agent that performed the action; null for non-agent callers. */
  agentName: string | null;
  /** Action type from the trust.yaml taxonomy (e.g. 'schedule_task'). */
  actionType: string;
  /** Human-readable description; truncated to 200 chars before send. */
  summary: string;
  /** Optional target identifier (taskId, chatJid, etc.) included if present. */
  target?: string;
  /** Caller's registered groups map; used to find the main jid. */
  registeredGroups: Record<string, { isMain?: boolean; name?: string }>;
  /** Caller's send-message dependency. */
  deps: { sendMessage: (jid: string, text: string) => Promise<void> | void };
}

const MAX_SUMMARY_LEN = 200;

export async function firePostHocNotify(
  input: FirePostHocNotifyInput,
): Promise<void> {
  const {
    notify,
    agentName,
    actionType,
    summary,
    target,
    registeredGroups,
    deps,
  } = input;

  if (!notify || !agentName) return;

  const mainJid = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain,
  )?.[0];
  if (!mainJid) return;

  const truncated = summary.slice(0, MAX_SUMMARY_LEN);
  const targetSuffix = target ? ` (target: ${target})` : '';
  const text = `ℹ️ ${agentName} → ${actionType}: ${truncated}${targetSuffix}`;

  try {
    await deps.sendMessage(mainJid, text);
  } catch (err) {
    logger.warn(
      { err, agentName, actionType, target },
      'notify-level post-hoc notification failed',
    );
  }
}
