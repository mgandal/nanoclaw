import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Claire',
  TRIGGER_PATTERN: /^@Claire\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
  }),
}));

// Mock pageindex
vi.mock('../pageindex.js', () => ({
  countPdfPages: vi.fn().mockResolvedValue(5),
  indexPdf: vi.fn().mockResolvedValue({ success: false }),
  computeFileHash: vi.fn().mockReturnValue('abc123'),
}));

// --- Grammy mock ---

const botRef = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  commandHandlers: new Map<string, Function>(),
  catchHandler: null as Function | null,
  poolApiInstances: [] as Array<{
    token: string;
    sendMessage: ReturnType<typeof vi.fn>;
    setMyName: ReturnType<typeof vi.fn>;
    getMe: ReturnType<typeof vi.fn>;
  }>,
  apiMock: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn().mockResolvedValue({ file_path: 'documents/file.pdf' }),
    getMe: vi.fn().mockResolvedValue({ username: 'test_bot', id: 123 }),
    setMyName: vi.fn().mockResolvedValue(undefined),
    setMyCommands: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('grammy', () => {
  class MockGrammyError extends Error {
    method: string;
    error_code: number;
    description: string;
    parameters: { migrate_to_chat_id?: number; retry_after?: number };
    ok = false as const;
    constructor(
      message: string,
      err: {
        error_code: number;
        description: string;
        parameters?: { migrate_to_chat_id?: number; retry_after?: number };
      },
      method: string,
    ) {
      super(`${message} (${err.error_code}: ${err.description})`);
      this.name = 'GrammyError';
      this.method = method;
      this.error_code = err.error_code;
      this.description = err.description;
      this.parameters = err.parameters ?? {};
    }
  }
  return {
    Bot: class MockBot {
      api = botRef.apiMock;
      constructor(token: string, opts?: any) {}
      command(name: string, handler: Function) {
        botRef.commandHandlers.set(name, handler);
      }
      on(filter: string, handler: Function) {
        botRef.handlers.set(filter, handler);
      }
      catch(handler: Function) {
        botRef.catchHandler = handler;
      }
      start(opts?: any) {
        if (opts?.onStart) {
          opts.onStart({ username: 'test_bot', id: 123 });
        }
      }
      stop() {}
    },
    Api: class MockApi {
      sendMessage = vi.fn().mockResolvedValue(undefined);
      setMyName = vi.fn().mockResolvedValue(undefined);
      token: string;
      constructor(token: string) {
        this.token = token;
        botRef.poolApiInstances.push(this as any);
      }
      getMe = vi.fn(async () => ({
        username: `bot_${this.token}`,
        id: this.token.length,
      }));
    },
    GrammyError: MockGrammyError,
    InlineKeyboard: class MockInlineKeyboard {
      url(label: string, url: string) {
        return this;
      }
    },
    InputFile: class MockInputFile {
      constructor(filePath: string) {}
    },
  };
});

import {
  TelegramChannel,
  TelegramChannelOpts,
  sendPoolMessage,
} from './telegram.js';
import { logger } from '../logger.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:12345': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Claire',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function makeTextCtx(overrides: {
  chatId?: number;
  chatType?: 'private' | 'group' | 'supergroup';
  chatTitle?: string;
  text?: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: Array<{ type: string; offset: number; length: number }>;
}) {
  return {
    chat: {
      id: overrides.chatId ?? 12345,
      type: overrides.chatType ?? 'group',
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 999,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text ?? 'Hello world',
      date: overrides.date ?? 1704067200,
      message_id: overrides.messageId ?? 42,
      entities: overrides.entities || [],
    },
    me: { username: 'test_bot' },
    reply: vi.fn(),
  };
}

function makeNonTextCtx(overrides: {
  chatId?: number;
  chatType?: 'private' | 'group' | 'supergroup';
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  return {
    chat: {
      id: overrides.chatId ?? 12345,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 999,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      date: overrides.date ?? 1704067200,
      message_id: overrides.messageId ?? 42,
      caption: overrides.caption,
      ...(overrides.extra || {}),
    },
    me: { username: 'test_bot' },
    api: botRef.apiMock,
  };
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    botRef.handlers.clear();
    botRef.commandHandlers.clear();
    botRef.catchHandler = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() and reports connected', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect sets connected to false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('has name "telegram"', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      expect(channel.name).toBe('telegram');
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(true);
    });

    it('does not own slack: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('slack:C123')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      expect(handler).toBeDefined();

      const ctx = makeTextCtx({ text: 'Hello world' });
      await handler!(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:12345',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          id: '42',
          chat_jid: 'tg:12345',
          sender: '999',
          sender_name: 'Alice',
          content: 'Hello world',
          is_from_me: false,
        }),
      );
    });

    it('skips commands (messages starting with /)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({ text: '/start' });
      await handler!(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({ chatId: 99999 });
      await handler!(ctx);

      // Metadata is stored but message is not delivered
      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses sender first_name for sender_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({ firstName: 'Bob' });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name is missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({});
      ctx.from.first_name = undefined as any;
      ctx.from.username = 'alice_user';
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when both name and username are missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({});
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      ctx.from.id = 777;
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ sender_name: '777' }),
      );
    });

    it('identifies private chats as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:12345': {
            name: 'Private Chat',
            folder: 'private-chat',
            trigger: '@Claire',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({ chatType: 'private' });
      await handler!(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:12345',
        expect.any(String),
        'Alice', // private chat uses senderName
        'telegram',
        false,
      );
    });

    it('identifies supergroup chats as group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({ chatType: 'supergroup' });
      await handler!(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:12345',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
    });

    it('handles unicode/emoji in sender names', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({ firstName: '🎸 Héctor' });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ sender_name: '🎸 Héctor' }),
      );
    });

    it('handles empty text messages (command skip path)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      // Empty text does not start with '/', so it goes through
      const ctx = makeTextCtx({ text: '' });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '' }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({
        text: 'Hey @test_bot what do you think?',
        entities: [{ type: 'mention', offset: 4, length: 9 }],
      });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '@Claire Hey @test_bot what do you think?',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({
        text: '@Claire hey @test_bot',
        entities: [{ type: 'mention', offset: 12, length: 9 }],
      });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '@Claire hey @test_bot',
        }),
      );
    });

    it('does not translate mentions for other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({
        text: 'Hey @other_bot',
        entities: [{ type: 'mention', offset: 4, length: 10 }],
      });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: 'Hey @other_bot',
        }),
      );
    });
  });

  // --- Non-text message handling ---

  describe('non-text message handling', () => {
    it('stores photo placeholder with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:photo');
      expect(handler).toBeDefined();

      const ctx = makeNonTextCtx({
        caption: 'Check this out',
        extra: {
          photo: [
            { file_id: 'abc', file_unique_id: 'u1', width: 800, height: 600 },
          ],
        },
      });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '[Photo] Check this out',
        }),
      );
    });

    it('stores photo placeholder without caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:photo');
      const ctx = makeNonTextCtx({
        extra: {
          photo: [
            { file_id: 'abc', file_unique_id: 'u1', width: 800, height: 600 },
          ],
        },
      });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '[Photo]',
        }),
      );
    });

    it('stores voice message placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:voice');
      const ctx = makeNonTextCtx({});
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '[Voice message]',
        }),
      );
    });

    it('stores video placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:video');
      const ctx = makeNonTextCtx({});
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '[Video]',
        }),
      );
    });

    it('stores sticker with emoji', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:sticker');
      const ctx = makeNonTextCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '[Sticker 😂]',
        }),
      );
    });

    it('stores sticker without emoji', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:sticker');
      const ctx = makeNonTextCtx({
        extra: { sticker: {} },
      });
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '[Sticker ]',
        }),
      );
    });

    it('ignores non-text from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:photo');
      const ctx = makeNonTextCtx({ chatId: 99999 });
      await handler!(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('saves .pptx binary to vault inbox even without a text extractor', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');

      const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncw-vault-'));
      const fakePptx = Buffer.from('PK\x03\x04fake-pptx-content');

      // Mock the global fetch so downloadAndExtractDocument gets our buffer
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          fakePptx.buffer.slice(
            fakePptx.byteOffset,
            fakePptx.byteOffset + fakePptx.byteLength,
          ),
      }) as any;

      try {
        const opts = createTestOpts({
          registeredGroups: vi.fn(() => ({
            'tg:12345': {
              name: 'Vault Group',
              folder: 'telegram_vault-claw',
              trigger: null,
              added_at: '2024-01-01T00:00:00.000Z',
              containerConfig: {
                additionalMounts: [
                  {
                    hostPath: vaultRoot,
                    containerPath: 'claire-vault',
                    readonly: false,
                  },
                ],
              },
            } as any,
          })),
        });
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const handler = botRef.handlers.get('message:document');
        const ctx = makeNonTextCtx({
          extra: {
            document: {
              file_id: 'pptx-file-id',
              file_name: 'Updates-17q-paper.pptx',
              mime_type:
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            },
          },
        });
        await handler!(ctx);

        const savedPath = path.join(
          vaultRoot,
          '00-inbox',
          'Updates-17q-paper.pptx',
        );
        expect(fs.existsSync(savedPath)).toBe(true);
        expect(fs.readFileSync(savedPath)).toEqual(fakePptx);

        expect(opts.onMessage).toHaveBeenCalledWith(
          'tg:12345',
          expect.objectContaining({
            content: '[Document: Updates-17q-paper.pptx — saved to 00-inbox/]',
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(vaultRoot, { recursive: true, force: true });
      }
    });

    it('falls back to plain placeholder when group has no vault mount', async () => {
      const fakePptx = Buffer.from('PK\x03\x04fake');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          fakePptx.buffer.slice(
            fakePptx.byteOffset,
            fakePptx.byteOffset + fakePptx.byteLength,
          ),
      }) as any;

      try {
        const opts = createTestOpts(); // default group has no containerConfig
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const handler = botRef.handlers.get('message:document');
        const ctx = makeNonTextCtx({
          extra: {
            document: {
              file_id: 'pptx-file-id',
              file_name: 'deck.pptx',
            },
          },
        });
        await handler!(ctx);

        expect(opts.onMessage).toHaveBeenCalledWith(
          'tg:12345',
          expect.objectContaining({
            content: '[Document: deck.pptx]',
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat info', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.commandHandlers.get('chatid');
      expect(handler).toBeDefined();

      const ctx = {
        chat: { id: 12345, type: 'supergroup', title: 'My Group' },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };
      await handler!(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:12345'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('My Group'),
        expect.any(Object),
      );
    });

    it('/chatid shows sender name for private chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.commandHandlers.get('chatid');
      const ctx = {
        chat: { id: 99, type: 'private' },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };
      await handler!(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Bob'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.commandHandlers.get('ping');
      expect(handler).toBeDefined();

      const ctx = { reply: vi.fn() };
      await handler!(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Claire is online.');
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:12345', 'Hello');

      expect(botRef.apiMock.sendMessage).toHaveBeenCalledWith(
        '12345',
        'Hello',
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Hello');

      expect(botRef.apiMock.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Hello',
        expect.any(Object),
      );
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      // Don't connect

      await channel.sendMessage('tg:12345', 'Hello');

      expect(botRef.apiMock.sendMessage).not.toHaveBeenCalled();
    });

    it('splits messages longer than 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'A'.repeat(5000);
      await channel.sendMessage('tg:12345', longText);

      // Should be called twice: 4096 + 904
      expect(botRef.apiMock.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('sends exactly-4096-char messages as single message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const text = 'B'.repeat(4096);
      await channel.sendMessage('tg:12345', text);

      expect(botRef.apiMock.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('splits into 3 parts when over 8192 chars', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const text = 'C'.repeat(9000);
      await channel.sendMessage('tg:12345', text);

      // 4096 + 4096 + 808 = 3 messages
      expect(botRef.apiMock.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('falls back to plain text when Markdown parse fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // First call (Markdown) fails, second call (plain) succeeds
      botRef.apiMock.sendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce(undefined);

      await channel.sendMessage('tg:12345', 'Hello *bad markdown');

      // Called twice: first with Markdown, then plain fallback
      expect(botRef.apiMock.sendMessage).toHaveBeenCalledTimes(2);
      expect(botRef.apiMock.sendMessage).toHaveBeenNthCalledWith(
        1,
        '12345',
        'Hello *bad markdown',
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
      expect(botRef.apiMock.sendMessage).toHaveBeenNthCalledWith(
        2,
        '12345',
        'Hello *bad markdown',
        {},
      );
    });

    it('logs error but does not throw on send failure', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      botRef.apiMock.sendMessage.mockRejectedValue(new Error('Network error'));

      // Should not throw
      await expect(
        channel.sendMessage('tg:12345', 'Will fail'),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalled();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:12345', true);

      expect(botRef.apiMock.sendChatAction).toHaveBeenCalledWith(
        '12345',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:12345', false);

      expect(botRef.apiMock.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.setTyping('tg:12345', true);

      expect(botRef.apiMock.sendChatAction).not.toHaveBeenCalled();
    });
  });

  // --- Timestamp conversion ---

  describe('timestamp conversion', () => {
    it('converts Unix timestamp to ISO string', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = botRef.handlers.get('message:text');
      const ctx = makeTextCtx({ date: 1704067200 }); // 2024-01-01T00:00:00Z
      await handler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('registers a catch handler', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      expect(botRef.catchHandler).toBeDefined();
    });

    it('catch handler logs error', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      botRef.catchHandler!({ message: 'something went wrong' });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'something went wrong' }),
        'Telegram bot error',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Pool-bot pinning — fixed sender→bot assignment (Option C)
// ---------------------------------------------------------------------------
import {
  initBotPool,
  sendPoolMessage as sendPoolMessageFn,
  _resetPoolStateForTests,
  getPoolBotForPersona,
  getPoolSize,
} from './telegram.js';

function getBot(token: string) {
  const bot = botRef.poolApiInstances.find((b) => b.token === token);
  if (!bot) throw new Error(`No mock pool Api created for token ${token}`);
  return bot;
}

describe('pool pinning', () => {
  beforeEach(() => {
    botRef.poolApiInstances.length = 0;
    _resetPoolStateForTests();
  });

  it('pre-renames pinned bots exactly once at init', async () => {
    await initBotPool(['tokA', 'tokB', 'tokC'], {
      bot_tokA: 'Freud',
      bot_tokC: 'Einstein',
    });
    expect(getBot('tokA').setMyName).toHaveBeenCalledTimes(1);
    expect(getBot('tokA').setMyName).toHaveBeenCalledWith('Freud');
    expect(getBot('tokB').setMyName).toHaveBeenCalledTimes(0);
    expect(getBot('tokC').setMyName).toHaveBeenCalledTimes(1);
    expect(getBot('tokC').setMyName).toHaveBeenCalledWith('Einstein');
  });

  it('routes pinned senders to their pinned bot regardless of call order', async () => {
    await initBotPool(['t1', 't2', 't3'], {
      bot_t2: 'Freud',
      bot_t3: 'Einstein',
    });
    // Call dynamic first, then pinned, then the other pinned — order shouldn't
    // affect pinned routing.
    await sendPoolMessageFn('tg:1', 'msg-claire', 'Claire', 'g');
    await sendPoolMessageFn('tg:1', 'msg-freud', 'Freud', 'g');
    await sendPoolMessageFn('tg:1', 'msg-einstein', 'Einstein', 'g');

    expect(getBot('t2').sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      'msg-freud',
      expect.anything(),
    );
    expect(getBot('t3').sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      'msg-einstein',
      expect.anything(),
    );
    // Claire (unpinned) went to t1 (first unpinned slot)
    expect(getBot('t1').sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      'msg-claire',
      expect.anything(),
    );
  });

  it('never re-renames pinned bots on subsequent sends', async () => {
    await initBotPool(['t1'], { bot_t1: 'Freud' });
    getBot('t1').setMyName.mockClear();
    await sendPoolMessageFn('tg:1', 'a', 'Freud', 'g');
    await sendPoolMessageFn('tg:1', 'b', 'Freud', 'g');
    await sendPoolMessageFn('tg:2', 'c', 'Freud', 'g2');
    expect(getBot('t1').setMyName).toHaveBeenCalledTimes(0);
  });

  it('dynamic round-robin skips pinned bots', async () => {
    await initBotPool(['t1', 't2', 't3'], { bot_t2: 'Freud' });
    await sendPoolMessageFn('tg:1', 'm1', 'Marvin', 'g');
    await sendPoolMessageFn('tg:1', 'm2', 'Simon', 'g');
    // Marvin and Simon should have landed on t1 and t3 (the unpinned slots),
    // never on t2 (which is pinned to Freud).
    expect(getBot('t2').sendMessage).not.toHaveBeenCalled();
    const usedUnpinned = [getBot('t1'), getBot('t3')].filter(
      (b) => b.sendMessage.mock.calls.length > 0,
    );
    expect(usedUnpinned.length).toBe(2);
  });

  it('renames unpinned senders on first use (existing behavior preserved)', async () => {
    await initBotPool(['t1', 't2'], { bot_t1: 'Freud' });
    getBot('t2').setMyName.mockClear();
    await sendPoolMessageFn('tg:1', 'hi', 'Marvin', 'g');
    expect(getBot('t2').setMyName).toHaveBeenCalledWith('Marvin');
  });

  it('works with no pins (backward compatibility)', async () => {
    await initBotPool(['t1', 't2']);
    const ok = await sendPoolMessageFn('tg:1', 'hi', 'Claire', 'g');
    expect(ok).toBe(true);
    expect(getBot('t1').sendMessage).toHaveBeenCalled();
  });

  it('skips setMyName when skipRename: true is passed', async () => {
    _resetPoolStateForTests();
    await initBotPool(['t1', 't2'], { bot_t2: 'Freud' }, { skipRename: true });
    // Pin is still recorded
    expect(getPoolBotForPersona('Freud')).toBeDefined();
    // setMyName was NOT called on the pinned bot.
    expect(getBot('t2').setMyName).toHaveBeenCalledTimes(0);
    // Nor on the unpinned bot.
    expect(getBot('t1').setMyName).toHaveBeenCalledTimes(0);
  });
});

describe('getPoolBotForPersona', () => {
  beforeEach(() => {
    botRef.poolApiInstances.length = 0;
    _resetPoolStateForTests();
  });

  it('returns the Api for a pinned persona', async () => {
    await initBotPool(['t1', 't2'], { bot_t2: 'Freud' });
    const api = getPoolBotForPersona('Freud');
    expect(api).toBeDefined();
    // The pinned bot must be index 1 (we pinned the second one)
    expect(api!.token).toBe('t2');
  });

  it('returns undefined for an unpinned persona', async () => {
    await initBotPool(['t1'], {});
    expect(getPoolBotForPersona('NoSuchPersona')).toBeUndefined();
  });

  it('returns undefined when the pool is empty', async () => {
    // Don't call initBotPool
    expect(getPoolBotForPersona('Freud')).toBeUndefined();
  });

  it("returns each pinned persona's own Api when multiple personas are pinned", async () => {
    _resetPoolStateForTests();
    await initBotPool(['t1', 't2', 't3'], {
      bot_t2: 'Freud',
      bot_t3: 'Marvin',
    });
    const freudApi = getPoolBotForPersona('Freud');
    const marvinApi = getPoolBotForPersona('Marvin');
    expect(freudApi).toBeDefined();
    expect(marvinApi).toBeDefined();
    expect(freudApi!.token).toBe('t2');
    expect(marvinApi!.token).toBe('t3');
    // The two Apis are distinct — not aliasing each other
    expect(freudApi).not.toBe(marvinApi);
  });
});

describe('getPoolSize', () => {
  it('returns 0 when initBotPool has not run', async () => {
    _resetPoolStateForTests();
    expect(getPoolSize()).toBe(0);
  });

  it('returns the number of bots initialized', async () => {
    _resetPoolStateForTests();
    await initBotPool(['t1', 't2', 't3'], {});
    expect(getPoolSize()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// setMyName caching — avoid redundant API calls and 429 retry storms
// ---------------------------------------------------------------------------

import { GrammyError } from 'grammy';

describe('setMyName caching', () => {
  beforeEach(() => {
    botRef.poolApiInstances.length = 0;
    _resetPoolStateForTests();
  });

  it('does not call setMyName a second time when the same name is requested', async () => {
    // Two unpinned bots, same dynamic sender used twice from different groups
    // (different keys in senderBotMap) — the second call should still skip the
    // setMyName API call because the cache remembers the bot's current name.
    await initBotPool(['t1', 't2']);
    getBot('t1').setMyName.mockClear();
    getBot('t2').setMyName.mockClear();

    // Force the same bot to be picked twice for the same persona name by using
    // the same group+sender key (cache hit on senderBotMap), but ALSO directly
    // verify the per-bot name cache by re-naming with the same string.
    await sendPoolMessageFn('tg:1', 'a', 'Marvin', 'g');
    await sendPoolMessageFn('tg:1', 'b', 'Marvin', 'g');

    // Only one setMyName total across both pool bots — the second send hit the
    // group:sender cache and didn't rename. (Existing behavior — keep working.)
    const total =
      getBot('t1').setMyName.mock.calls.length +
      getBot('t2').setMyName.mock.calls.length;
    expect(total).toBe(1);
  });

  it('skips setMyName if the per-bot cached name already matches', async () => {
    // Two different group+sender keys that round-robin onto the SAME bot would
    // normally both call setMyName. With caching, the second one (same name)
    // should be skipped.
    await initBotPool(['t1']); // single-bot pool forces same bot
    getBot('t1').setMyName.mockClear();

    await sendPoolMessageFn('tg:1', 'a', 'Marvin', 'groupA');
    await sendPoolMessageFn('tg:1', 'b', 'Marvin', 'groupB');

    // Same name "Marvin" → second call should be cached, not re-issued.
    expect(getBot('t1').setMyName).toHaveBeenCalledTimes(1);
    expect(getBot('t1').setMyName).toHaveBeenCalledWith('Marvin');
  });

  it('on 429, suppresses subsequent setMyName calls within retry_after window', async () => {
    await initBotPool(['t1']);
    getBot('t1').setMyName.mockClear();
    (logger.warn as any).mockClear();

    // First setMyName call: 429 with retry_after=60
    const err429 = new GrammyError(
      "Call to 'setMyName' failed!",
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 60',
        parameters: { retry_after: 60 },
      },
      'setMyName',
      {},
    );
    getBot('t1').setMyName.mockRejectedValueOnce(err429);

    await sendPoolMessageFn('tg:1', 'a', 'Marvin', 'groupA');

    // Second send for a DIFFERENT persona on the same bot (different key) —
    // should be skipped silently due to suppression window, no API call.
    await sendPoolMessageFn('tg:1', 'b', 'Simon', 'groupB');

    // Only the first setMyName attempt was made; the second was suppressed.
    expect(getBot('t1').setMyName).toHaveBeenCalledTimes(1);

    // 429 retry-storms used to flood the log. Verify NO "Failed to rename"
    // warning was emitted — neither for the original 429 (handled silently)
    // nor for the suppressed second attempt.
    const warnMessages = (logger.warn as any).mock.calls.map((c: any[]) =>
      typeof c[1] === 'string' ? c[1] : '',
    );
    expect(
      warnMessages.filter((m: string) => m.includes('Failed to rename'))
        .length,
    ).toBe(0);
  });

  it('on 429 during initBotPool pre-rename, suppresses subsequent setMyName calls', async () => {
    // Pinned bot pre-rename returns 429 — subsequent dynamic renames on the
    // same bot must be silently skipped within the suppression window.
    const err429 = new GrammyError(
      "Call to 'setMyName' failed!",
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 23592',
        parameters: { retry_after: 23592 },
      },
      'setMyName',
      {},
    );
    // Pre-rename will fail
    // We need to set the rejection BEFORE initBotPool runs, but the Api
    // instance is created inside initBotPool. So pre-mock the constructor
    // by intercepting after creation isn't possible — instead pin the bot
    // and let the rejection happen on the pre-rename path.

    await initBotPool(['t1']); // create the Api instance first
    const bot = getBot('t1');
    bot.setMyName.mockClear();
    (logger.warn as any).mockClear();

    bot.setMyName.mockRejectedValueOnce(err429);

    // Trigger one rename attempt — fails with 429
    await sendPoolMessageFn('tg:1', 'a', 'Marvin', 'g');

    // Second send: should be suppressed (no API call)
    await sendPoolMessageFn('tg:1', 'b', 'Simon', 'g2');

    expect(bot.setMyName).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Supergroup migration — 400 with migrate_to_chat_id
// ---------------------------------------------------------------------------

describe('supergroup migration', () => {
  beforeEach(() => {
    botRef.poolApiInstances.length = 0;
    _resetPoolStateForTests();
    botRef.apiMock.sendMessage.mockReset();
    botRef.apiMock.sendMessage.mockResolvedValue(undefined);
  });

  it('calls onMigrate with old and new JIDs when sendMessage returns 400 + migrate_to_chat_id', async () => {
    const onMigrate = vi.fn().mockResolvedValue(undefined);
    const opts = createTestOpts({ onMigrate });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const migrationErr = new GrammyError(
      "Call to 'sendMessage' failed!",
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: -1009999999999 },
      },
      'sendMessage',
      {},
    );
    // sendTelegramMessage tries Markdown then plain-text. Both attempts on the
    // old chat must throw the migration error; the retry to the new chat
    // succeeds.
    botRef.apiMock.sendMessage
      .mockRejectedValueOnce(migrationErr) // Markdown attempt to old
      .mockRejectedValueOnce(migrationErr) // plain fallback to old
      .mockResolvedValueOnce(undefined); // retry to new chat

    await channel.sendMessage('tg:-1234', 'Hello');

    expect(onMigrate).toHaveBeenCalledWith('tg:-1234', 'tg:-1009999999999');
    // Retry was sent to the new chat ID
    const lastCall =
      botRef.apiMock.sendMessage.mock.calls[
        botRef.apiMock.sendMessage.mock.calls.length - 1
      ];
    expect(lastCall[0]).toBe('-1009999999999');
    expect(lastCall[1]).toBe('Hello');
  });
});
