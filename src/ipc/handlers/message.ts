import { logger } from '../../logger.js';
import { deliverSendMessage } from '../delivery.js';
import type { IpcHandler, IpcHandlerContext } from '../handler.js';

/**
 * `message` (send_message) — deliver an agent/group message to a chatJid.
 *
 * Migrated out of the inline processIpcMessage branch onto the registry. The
 * generic dispatcher owns trust gating + staging (keyed on the `send_message`
 * action type) and the post-hoc notify; this handler owns the target-group
 * authorization cross-check and the delivery routing (pool / allowlist
 * downgrade / plain send, all inside deliverSendMessage).
 *
 * Self-echo: when the message is delivered TO the main jid, the post-hoc
 * receipt (which also goes to main) would echo into the same chat. We express
 * that via `suppressNotifyWhenTargetIs: mainJid` so the dispatcher skips the
 * receipt — reproducing the inline guard `mainJidForSelfCheck !== chatJid`.
 */
interface Input {
  chatJid: string;
  text: string;
  sender?: string;
  webAppUrl?: string;
}

function mainJidOf(ctx: IpcHandlerContext): string | undefined {
  return Object.entries(ctx.registeredGroups).find(([, g]) => g.isMain)?.[0];
}

export const messageHandler: IpcHandler<Input> = {
  type: 'message',
  responseKind: 'notify',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.chatJid !== 'string' || r.chatJid.length === 0) return null;
    if (typeof r.text !== 'string' || r.text.length === 0) return null;
    return {
      chatJid: r.chatJid,
      text: r.text,
      sender: typeof r.sender === 'string' ? r.sender : undefined,
      webAppUrl: typeof r.webAppUrl === 'string' ? r.webAppUrl : undefined,
    };
  },

  authorize(input, ctx) {
    // Authorization: a group may send to its own jid; main may send anywhere.
    // baseGroup is the compound-key caller's base group (agent stripped).
    const targetGroup = ctx.registeredGroups[input.chatJid];
    const authorized =
      ctx.isMain || (targetGroup && targetGroup.folder === ctx.baseGroup);
    if (!authorized) {
      logger.warn(
        { chatJid: input.chatJid, sourceGroup: ctx.sourceGroup },
        'Unauthorized IPC message attempt blocked',
      );
      return null;
    }

    return {
      // Gate + audit on the send_message action type (the wire type is
      // 'message' but trust.yaml and the legacy audit rows key on
      // 'send_message').
      actionTypeOverride: 'send_message',
      target: input.chatJid,
      auditSummary: input.text,
      notifySummary: `→ ${targetGroup?.name || input.chatJid}: ${input.text}`,
      payloadForStaging: {
        type: 'message',
        chatJid: input.chatJid,
        text: input.text,
        sender: input.sender,
        webAppUrl: input.webAppUrl,
      },
      // Self-echo guard: skip the receipt when delivering to main itself.
      suppressNotifyWhenTargetIs: mainJidOf(ctx),
    };
  },

  async execute(input, ctx) {
    const targetGroup = ctx.registeredGroups[input.chatJid];
    await deliverSendMessage(
      {
        chatJid: input.chatJid,
        text: input.text,
        sender: input.sender,
        webAppUrl: input.webAppUrl,
        permittedSenders: targetGroup?.permittedSenders,
      },
      ctx.deps,
      ctx.sourceGroup,
    );
  },
};
