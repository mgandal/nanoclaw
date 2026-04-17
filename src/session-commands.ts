import type { NewMessage } from './types.js';
import { logger } from './logger.js';

export type ApprovalCommand =
  | { kind: 'approve'; id: string }
  | { kind: 'reject'; id: string }
  | { kind: 'pending' };

/**
 * Extract an approval-queue command from a message. Returns null if the
 * message is not an approval command. Accepts:
 *   /approve <id>
 *   /reject <id>
 *   /pending        (list pending actions for this group)
 */
export function extractApprovalCommand(
  content: string,
  triggerPattern: RegExp,
): ApprovalCommand | null {
  const text = content.trim().replace(triggerPattern, '').trim();
  if (text === '/pending') return { kind: 'pending' };
  const approve = text.match(/^\/approve\s+([A-Za-z0-9_-]{1,80})$/);
  if (approve) return { kind: 'approve', id: approve[1] };
  const reject = text.match(/^\/reject\s+([A-Za-z0-9_-]{1,80})$/);
  if (reject) return { kind: 'reject', id: reject[1] };
  return null;
}

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact') or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  if (text === '/compact') return '/compact';
  if (text === '/new') return '/new';
  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender (is_from_me) in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
): boolean {
  return isMainGroup || isFromMe;
}

/**
 * Handle an approval-queue command host-side. Does NOT involve the agent —
 * reads the pending_actions row, replays the action via the provided
 * executor, updates DB status, and returns a short status line for the
 * calling group.
 *
 * Authorization: main group can approve/reject any pending action. Non-main
 * groups can only touch their own pending actions.
 */
export async function handleApprovalCommand(opts: {
  command: ApprovalCommand;
  sourceGroupFolder: string;
  isMainGroup: boolean;
  db: {
    getPendingAction: (id: string) => {
      id: string;
      group_folder: string;
      action_type: string;
      summary: string;
      payload_json: string;
      status: string;
      created_at: string;
      agent_name: string;
    } | null;
    listPendingActions: (opts: {
      groupFolder?: string;
      status?: 'pending';
      limit?: number;
    }) => Array<{
      id: string;
      created_at: string;
      agent_name: string;
      action_type: string;
      summary: string;
    }>;
    updatePendingActionStatus: (
      id: string,
      status: 'approved' | 'rejected' | 'executed' | 'failed',
      result?: string,
    ) => void;
  };
  /**
   * Replay an approved payload. Return a short text result or throw on failure.
   * The payload is the JSON-decoded stored payload; action_type identifies
   * the handler (e.g. 'send_message' → route through IPC message path).
   */
  execute: (action: {
    action_type: string;
    payload: unknown;
    group_folder: string;
    agent_name: string;
  }) => Promise<string>;
}): Promise<string> {
  const { command, sourceGroupFolder, isMainGroup, db } = opts;

  if (command.kind === 'pending') {
    const scope = isMainGroup ? undefined : sourceGroupFolder;
    const rows = db.listPendingActions({ groupFolder: scope, limit: 20 });
    if (rows.length === 0) return 'No pending actions.';
    const lines = rows.map((r) => {
      const ageMin = Math.round(
        (Date.now() - new Date(r.created_at).getTime()) / 60000,
      );
      const ageLabel =
        ageMin < 60
          ? `${ageMin}m`
          : ageMin < 1440
            ? `${Math.round(ageMin / 60)}h`
            : `${Math.round(ageMin / 1440)}d`;
      return `• ${r.id} — ${r.agent_name} ${r.action_type} (${ageLabel} ago): ${r.summary.slice(0, 100)}`;
    });
    return `Pending (${rows.length}):\n${lines.join('\n')}`;
  }

  const row = db.getPendingAction(command.id);
  if (!row) return `No pending action with id ${command.id}.`;

  // Authorization: non-main can only touch own-group rows.
  if (!isMainGroup && row.group_folder !== sourceGroupFolder) {
    logger.warn(
      {
        id: command.id,
        sourceGroupFolder,
        rowGroup: row.group_folder,
        command: command.kind,
      },
      'Approval command denied: cross-group access',
    );
    return `Pending action ${command.id} is not in this group.`;
  }

  if (row.status !== 'pending') {
    return `Pending action ${command.id} is already ${row.status}.`;
  }

  if (command.kind === 'reject') {
    db.updatePendingActionStatus(command.id, 'rejected');
    logger.info({ id: command.id, sourceGroupFolder }, 'Action rejected');
    return `Rejected ${command.id}.`;
  }

  // approve → replay
  db.updatePendingActionStatus(command.id, 'approved');
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (err) {
    db.updatePendingActionStatus(
      command.id,
      'failed',
      `payload parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return `Failed to parse payload for ${command.id}.`;
  }

  try {
    const result = await opts.execute({
      action_type: row.action_type,
      payload,
      group_folder: row.group_folder,
      agent_name: row.agent_name,
    });
    db.updatePendingActionStatus(command.id, 'executed', result.slice(0, 200));
    logger.info(
      { id: command.id, sourceGroupFolder, result: result.slice(0, 80) },
      'Action approved + executed',
    );
    return `Approved ${command.id}: ${result}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.updatePendingActionStatus(command.id, 'failed', msg.slice(0, 200));
    logger.error({ err, id: command.id }, 'Action execution failed');
    return `Approved but execution failed for ${command.id}: ${msg}`;
  }
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (seq: number) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: (NewMessage & { seq: number })[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (!isSessionCommandAllowed(isMainGroup, cmdMsg.is_from_me === true)) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.seq);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-compact messages first, then run the command
  logger.info({ group: groupName, command }, 'Session command');

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in the session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-compact messages, leave command pending.
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].seq);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.seq);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
