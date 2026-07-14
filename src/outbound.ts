import { logger } from './logger.js';
import { findChannel, formatOutbound } from './router.js';
import type { ChannelType } from './text-styles.js';
import type { Channel } from './types.js';

/**
 * The one outbound door for text. Every host-side text send — interactive
 * replies, IPC notifies, scheduler results, system alerts — goes through
 * deliverText, which owns the pairing of channel resolution and the
 * markdown → channel-native transform.
 *
 * INVARIANT (was comment-enforced across ~14 call sites, now structural):
 * parseTextStyles is non-idempotent — a double transform corrupts _italic_
 * markers. Callers therefore always pass RAW text and never format. The
 * only transforms outside this module are inside channel-specific senders
 * that bypass Channel.sendMessage (telegram sendPoolMessage and the
 * sendFile caption), which likewise receive raw text.
 *
 * kind declares what the send is:
 *   'reply'     — user-facing output of a turn the user initiated
 *   'system'    — alerts, notifies, receipts
 *   'proactive' — agent-initiated; MUST have passed the outbound governor
 *                 (deliverSendMessage in ipc/delivery.ts). Calling with
 *                 kind 'proactive' without `governed: true` throws — a new
 *                 proactive path cannot silently escape policy.
 */
export type SendKind = 'reply' | 'system' | 'proactive';

export interface DeliverTextOptions {
  kind: SendKind;
  /** Attests the outbound governor already ran (proactive sends only). */
  governed?: boolean;
  /** Log context: originating group/task. */
  sourceGroup?: string;
}

export interface DeliverTextResult {
  sent: boolean;
  reason?: 'no-channel' | 'empty';
}

export async function deliverText(
  channels: Channel[],
  jid: string,
  rawText: string,
  opts: DeliverTextOptions,
): Promise<DeliverTextResult> {
  if (opts.kind === 'proactive' && !opts.governed) {
    throw new Error(
      'proactive sends must pass the outbound governor (deliverSendMessage) — direct deliverText(kind: proactive) is not a policy door',
    );
  }

  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn(
      { jid, kind: opts.kind, sourceGroup: opts.sourceGroup },
      'deliverText: no channel owns JID',
    );
    return { sent: false, reason: 'no-channel' };
  }

  const text = formatOutbound(rawText, channel.name as ChannelType);
  if (!text) return { sent: false, reason: 'empty' };

  await channel.sendMessage(jid, text);
  return { sent: true };
}
