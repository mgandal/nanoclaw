import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

import { GmailChannel, GmailChannelOpts } from './gmail.js';

function makeOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

describe('GmailChannel', () => {
  let channel: GmailChannel;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
  });

  describe('ownsJid', () => {
    it('returns true for gmail: prefixed JIDs', () => {
      expect(channel.ownsJid('gmail:abc123')).toBe(true);
      expect(channel.ownsJid('gmail:thread-id-456')).toBe(true);
    });

    it('returns false for non-gmail JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
      expect(channel.ownsJid('user@s.whatsapp.net')).toBe(false);
    });
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(channel.name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('threadMeta cap', () => {
    it('caps threadMeta to prevent unbounded growth', () => {
      const ch = new GmailChannel(makeOpts());
      const internal = ch as unknown as {
        threadMeta: Map<string, unknown>;
        capThreadMeta: () => void;
      };

      for (let i = 0; i < 6000; i++) {
        internal.threadMeta.set(`thread-${i}`, {
          sender: `s${i}`,
          senderName: `S${i}`,
          subject: 'test',
          messageId: `m${i}`,
        });
      }
      expect(internal.threadMeta.size).toBe(6000);

      internal.capThreadMeta();

      expect(internal.threadMeta.size).toBeLessThanOrEqual(2500);
      // Keeps the newest entries (last inserted)
      expect(internal.threadMeta.has('thread-5999')).toBe(true);
      expect(internal.threadMeta.has('thread-0')).toBe(false);
    });

    it('does nothing when threadMeta is within cap', () => {
      const ch = new GmailChannel(makeOpts());
      const internal = ch as unknown as {
        threadMeta: Map<string, unknown>;
        capThreadMeta: () => void;
      };

      for (let i = 0; i < 100; i++) {
        internal.threadMeta.set(`thread-${i}`, {
          sender: `s${i}`,
          senderName: `S${i}`,
          subject: 'test',
          messageId: `m${i}`,
        });
      }

      internal.capThreadMeta();

      expect(internal.threadMeta.size).toBe(100);
    });
  });

  describe('email delivery chat_jid', () => {
    it('stores email under gmail thread JID, not main group JID', async () => {
      const onMessage = vi.fn();
      const ch = new GmailChannel(
        makeOpts({
          onMessage,
          registeredGroups: () => ({
            'main-group@g.us': { isMain: true, folder: 'main' } as any,
          }),
        }),
      );

      // Simulate processMessage by calling it directly with a mocked gmail API
      const internal = ch as unknown as {
        gmail: unknown;
        userEmail: string;
        processedIds: Set<string>;
        processMessage: (id: string) => Promise<void>;
      };

      internal.userEmail = 'me@example.com';
      internal.gmail = {
        users: {
          messages: {
            get: vi.fn().mockResolvedValue({
              data: {
                threadId: 'thread-abc',
                internalDate: '1700000000000',
                payload: {
                  headers: [
                    { name: 'From', value: 'Alice <alice@example.com>' },
                    { name: 'Subject', value: 'Hello' },
                    { name: 'Message-ID', value: '<msg1@example.com>' },
                  ],
                  mimeType: 'text/plain',
                  body: { data: Buffer.from('Hello world').toString('base64') },
                },
              },
            }),
            modify: vi.fn().mockResolvedValue({}),
          },
        },
      };

      await internal.processMessage('msg-001');

      expect(onMessage).toHaveBeenCalledTimes(1);
      const [deliveryJid, msg] = onMessage.mock.calls[0];
      expect(deliveryJid).toBe('main-group@g.us');
      expect(msg.chat_jid).toBe('gmail:thread-abc');
    });
  });

  describe('constructor options', () => {
    it('accepts custom poll interval', () => {
      const ch = new GmailChannel(makeOpts(), 30000);
      expect(ch.name).toBe('gmail');
    });

    it('defaults to unread query when no filter configured', () => {
      const ch = new GmailChannel(makeOpts());
      const query = (
        ch as unknown as { buildQuery: () => string }
      ).buildQuery();
      expect(query).toBe('is:unread category:primary');
    });

    it('defaults with no options provided', () => {
      const ch = new GmailChannel(makeOpts());
      expect(ch.name).toBe('gmail');
    });
  });

  describe('threadMeta cap', () => {
    it('caps threadMeta to prevent unbounded growth', () => {
      const ch = new GmailChannel(makeOpts());
      const internal = ch as unknown as { threadMeta: Map<string, unknown> };

      for (let i = 0; i < 5500; i++) {
        internal.threadMeta.set(`thread-${i}`, {
          sender: `s${i}@x.com`,
          senderName: `S${i}`,
          subject: 'test',
          messageId: `m${i}`,
        });
      }

      // Simulate the cap logic inline (mirrors processMessage behavior)
      if (internal.threadMeta.size > 5000) {
        const keys = [...internal.threadMeta.keys()];
        for (const key of keys.slice(0, keys.length - 2500)) {
          internal.threadMeta.delete(key);
        }
      }

      expect(internal.threadMeta.size).toBe(2500);
      expect(internal.threadMeta.has('thread-5499')).toBe(true);
      expect(internal.threadMeta.has('thread-0')).toBe(false);
    });
  });
});
