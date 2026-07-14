import { describe, it, expect, vi } from 'vitest';

import { deliverText } from './outbound.js';
import type { Channel } from './types.js';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'telegram',
    connect: async () => {},
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith('tg:'),
    disconnect: async () => {},
    ...overrides,
  } as Channel;
}

describe('deliverText — the one outbound text door', () => {
  it('formats exactly once for the owning channel and sends', async () => {
    const ch = makeChannel();
    const res = await deliverText([ch], 'tg:123', '**bold** move', {
      kind: 'reply',
    });
    expect(res.sent).toBe(true);
    // Telegram Markdown v1: **bold** → *bold*. A double transform would
    // corrupt the marker (the documented non-idempotency hazard).
    expect(ch.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ch.sendMessage).mock.calls[0][1]).toBe('*bold* move');
  });

  it('routes to the channel that owns the jid', async () => {
    const tg = makeChannel();
    const slack = makeChannel({
      name: 'slack',
      ownsJid: (jid: string) => jid.startsWith('slack:'),
    });
    await deliverText([tg, slack], 'slack:C1', 'hi', { kind: 'reply' });
    expect(slack.sendMessage).toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('reports no-channel without throwing (caller decides severity)', async () => {
    const ch = makeChannel();
    const res = await deliverText([ch], 'gmail:x@y.z', 'hi', {
      kind: 'system',
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('no-channel');
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it('skips an empty post-format payload', async () => {
    const ch = makeChannel();
    const res = await deliverText([ch], 'tg:123', '', { kind: 'reply' });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('empty');
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it('throws on kind proactive without a governor decision (structural guard)', async () => {
    const ch = makeChannel();
    await expect(
      deliverText([ch], 'tg:123', 'psst', { kind: 'proactive' }),
    ).rejects.toThrow(/governor/i);
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });

  it('allows kind proactive when the caller attests the governor ran', async () => {
    const ch = makeChannel();
    const res = await deliverText([ch], 'tg:123', 'psst', {
      kind: 'proactive',
      governed: true,
    });
    expect(res.sent).toBe(true);
  });
});
