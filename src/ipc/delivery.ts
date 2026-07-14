import {
  PROACTIVE_ENABLED,
  PROACTIVE_GOVERNOR,
  PROACTIVE_PAUSE_PATH,
  QUIET_DAYS_OFF,
  QUIET_HOURS_END,
  QUIET_HOURS_START,
  TIMEZONE,
} from '../config.js';
import { logger } from '../logger.js';
import { decide as governorDecide } from '../outbound-governor.js';
import {
  clearDispatch,
  markDelivered,
  markDispatched,
} from '../proactive-log.js';
import { isPaused } from '../proactive-pause.js';
import { isInQuietHours, nextQuietEnd } from '../quiet-hours.js';
import { RegisteredGroup } from '../types.js';
import type { IpcDeps } from '../ipc.js';

/**
 * Tracks chatJids that received IPC send_message deliveries recently.
 * Used by the streaming output callback to suppress duplicate sends
 * when pool bots already delivered the agent's message via IPC.
 * Entries auto-expire after 60 seconds.
 */
const recentIpcSends = new Map<string, number>(); // chatJid → timestamp

export function markIpcSend(chatJid: string): void {
  recentIpcSends.set(chatJid, Date.now());
}

export function hasRecentIpcSend(chatJid: string): boolean {
  const ts = recentIpcSends.get(chatJid);
  if (!ts) return false;
  // Expire after 60 seconds
  if (Date.now() - ts > 60_000) {
    recentIpcSends.delete(chatJid);
    return false;
  }
  return true;
}

export function clearIpcSend(chatJid: string): void {
  recentIpcSends.delete(chatJid);
}

/**
 * Policy: is `sender` allowed to fire a pooled/pinned Telegram bot in
 * `group`? `undefined` permittedSenders = allow any (legacy rows, backwards
 * compat). Empty array = no personas; every `sender` is downgraded to the
 * main bot. Non-empty array = strict allowlist (exact-match, case-sensitive).
 *
 * Named distinctly from `isSenderAllowed` in `sender-allowlist.ts`, which
 * gates whether a raw incoming message is processed at all.
 */
export function isSenderAllowedForPool(
  group: RegisteredGroup,
  sender: string,
): boolean {
  if (group.permittedSenders === undefined) return true;
  return group.permittedSenders.includes(sender);
}

/**
 * Deliver a send_message payload through the appropriate channel path:
 * WebApp button → pool bot with sender prefix → plain main-bot send.
 *
 * Pure delivery: no trust check, no audit log. Callers (processIpcMessage
 * for fresh actions, approval executor for replayed ones) are responsible
 * for those concerns so they can attribute outcomes correctly.
 *
 * On pool-bot delivery, marks the chatJid as recently-IPC-sent to suppress
 * duplicate output from the streaming callback.
 */
export async function deliverSendMessage(
  data: {
    chatJid: string;
    text: string;
    sender?: string;
    webAppUrl?: string;
    proactive?: boolean;
    correlationId?: string;
    urgency?: number;
    ruleId?: string;
    contributingEvents?: string[];
    fromAgent?: string;
    // Per-target-group allowlist. When set, disallowed senders are
    // downgraded from the bot pool to the main bot (with a *Sender:*
    // prefix). Callers compute this from the registered group;
    // `deliverSendMessage` stays a pure delivery primitive.
    permittedSenders?: string[];
  },
  deps: Pick<IpcDeps, 'sendMessage' | 'sendWebAppButton' | 'sendAs'>,
  sourceGroup: string,
): Promise<void> {
  if (data.proactive && PROACTIVE_GOVERNOR) {
    if (!data.correlationId) {
      throw new Error('proactive=true requires correlationId');
    }
    const pauseFile =
      process.env.PROACTIVE_PAUSE_PATH_OVERRIDE || PROACTIVE_PAUSE_PATH;
    const decision = governorDecide(
      {
        fromAgent: data.fromAgent || sourceGroup,
        toGroup: data.chatJid,
        message: data.text,
        urgency: data.urgency ?? 0.5,
        correlationId: data.correlationId,
        ruleId: data.ruleId,
        contributingEvents: data.contributingEvents || [],
      },
      {
        enabled: PROACTIVE_ENABLED,
        governorOn: true,
        isPaused,
        isInQuiet: (now) =>
          isInQuietHours(now, {
            start: QUIET_HOURS_START,
            end: QUIET_HOURS_END,
            daysOff: QUIET_DAYS_OFF,
            timezone: TIMEZONE,
          }),
        nextQuietEnd: (now) =>
          nextQuietEnd(now, {
            start: QUIET_HOURS_START,
            end: QUIET_HOURS_END,
            daysOff: QUIET_DAYS_OFF,
            timezone: TIMEZONE,
          }),
        now: () => new Date(),
        pauseFile,
      },
    );

    if (decision.decision !== 'send') return; // drop or defer; already logged

    markDispatched(decision.logId, new Date().toISOString());
    try {
      await deps.sendMessage(data.chatJid, data.text);
      markDelivered(decision.logId, new Date().toISOString());
    } catch (err) {
      clearDispatch(decision.logId);
      throw err;
    }
    return;
  }

  if (
    data.webAppUrl &&
    typeof data.webAppUrl === 'string' &&
    deps.sendWebAppButton
  ) {
    await deps.sendWebAppButton(data.chatJid, data.text, data.webAppUrl);
    logger.info(
      { chatJid: data.chatJid, sourceGroup },
      'IPC WebApp button sent',
    );
    return;
  }

  // Enforce per-group sender allowlist. Disallowed senders skip the pool
  // entirely and go out as a prefixed message from the main bot. This
  // stops an agent in group A from firing a pinned pool bot (e.g. Freud)
  // just because it picked that string as its sender in a group that
  // isn't authorized to surface that persona.
  if (
    data.sender &&
    data.permittedSenders !== undefined &&
    !data.permittedSenders.includes(data.sender)
  ) {
    logger.warn(
      {
        chatJid: data.chatJid,
        sourceGroup,
        sender: data.sender,
        permitted: data.permittedSenders,
      },
      'Sender not in group allowlist — downgrading to main-bot prefixed send',
    );
    const prefixed = `*${data.sender}:*\n${data.text}`;
    await deps.sendMessage(data.chatJid, prefixed);
    return;
  }

  // Persona delivery goes through the channel-agnostic sendAs seam
  // (Telegram implements it via the bot pool). 'unavailable' — no persona
  // transport for this jid/config — falls through to the plain send below,
  // matching the old tg:-prefix + TELEGRAM_BOT_POOL check. 'failed' —
  // configured transport couldn't deliver — downgrades to a prefixed
  // main-bot send.
  if (data.sender && deps.sendAs) {
    const personaResult = await deps.sendAs(
      data.chatJid,
      data.text,
      data.sender,
      sourceGroup,
    );
    if (personaResult !== 'unavailable') {
      if (personaResult === 'failed') {
        const prefixed = `*${data.sender}:*\n${data.text}`;
        await deps.sendMessage(data.chatJid, prefixed);
      }
      markIpcSend(data.chatJid);
      logger.info(
        { chatJid: data.chatJid, sourceGroup, sender: data.sender },
        'IPC message sent',
      );
      return;
    }
  }

  await deps.sendMessage(data.chatJid, data.text);
  logger.info(
    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
    'IPC message sent',
  );
}
