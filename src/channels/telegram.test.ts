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
  apiMock: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn().mockResolvedValue({ file_path: 'documents/file.pdf' }),
    getMe: vi.fn().mockResolvedValue({ username: 'test_bot', id: 123 }),
    setMyName: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('grammy', () => ({
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
    getMe = vi.fn().mockResolvedValue({ username: 'pool_bot', id: 456 });
    setMyName = vi.fn().mockResolvedValue(undefined);
    constructor(token: string) {}
  },
  InlineKeyboard: class MockInlineKeyboard {
    url(label: string, url: string) {
      return this;
    }
  },
  InputFile: class MockInputFile {
    constructor(filePath: string) {}
  },
}));

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
        extra: { photo: [{ file_id: 'abc', file_unique_id: 'u1', width: 800, height: 600 }] },
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
        extra: { photo: [{ file_id: 'abc', file_unique_id: 'u1', width: 800, height: 600 }] },
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
