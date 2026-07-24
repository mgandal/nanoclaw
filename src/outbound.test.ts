import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  initAuthFailureHandling,
  resetAuthFailureState,
} from './auth-failure.js';
import { deliverText } from './outbound.js';
import type { Channel } from './types.js';

const AUTH_401 =
  'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."},"request_id":null}';

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

describe('deliverText — Anthropic auth-failure containment', () => {
  afterEach(() => resetAuthFailureState());

  it('never lets the SDK 401 text reach a chat, and reports it once', async () => {
    const alert = vi.fn();
    initAuthFailureHandling({ alert, selfHeal: vi.fn() });
    const tg = makeChannel();
    const slack = makeChannel({
      name: 'slack',
      ownsJid: (jid: string) => jid.startsWith('slack:'),
    });

    // Every group's turn fails the same way during one incident.
    const r1 = await deliverText([tg, slack], 'tg:1', AUTH_401, {
      kind: 'reply',
    });
    const r2 = await deliverText([tg, slack], 'tg:2', AUTH_401, {
      kind: 'reply',
    });
    const r3 = await deliverText([tg, slack], 'slack:C1', AUTH_401, {
      kind: 'proactive',
      governed: true,
    });

    expect([r1, r2, r3].every((r) => !r.sent)).toBe(true);
    expect(r1.reason).toBe('auth-failure');
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(slack.sendMessage).not.toHaveBeenCalled();
    // One channel, one alert — not one per group.
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('still delivers the system alert that describes the incident', async () => {
    initAuthFailureHandling({ alert: vi.fn(), selfHeal: vi.fn() });
    const ch = makeChannel();
    const res = await deliverText(
      [ch],
      'tg:ops',
      '⚠️ *Anthropic Auth*: Failed to authenticate. API Error: 401',
      { kind: 'system' },
    );
    expect(res.sent).toBe(true);
    expect(ch.sendMessage).toHaveBeenCalledTimes(1);
  });
});
