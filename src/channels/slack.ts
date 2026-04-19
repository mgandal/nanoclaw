import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { withRetry } from './reconnect.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// Maximum number of messages to hold in the outgoing queue while disconnected.
// When the queue is full, the oldest message is dropped to make room.
const MAX_QUEUE_SIZE = 100;

// How often (ms) to attempt a background reconnect after startup failure.
const RECONNECT_INTERVAL_MS = 60_000;

// Number of retry attempts for initial startup.
const STARTUP_RETRY_ATTEMPTS = 3;

// Base delay (ms) for exponential backoff on startup retries.
const STARTUP_RETRY_BASE_MS = 2000;

// Slack error codes that indicate the token is permanently invalid.
// Retrying these is futile — stop and alert immediately.
const AUTH_ERROR_CODES = new Set([
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'token_expired',
]);

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAlert?: (message: string) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';

  // app is assigned in createApp(), called from the constructor.
  private app!: App;
  private botToken: string;
  private appToken: string;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private reconnecting = false;

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.botToken = botToken;
    this.appToken = appToken;
    this.createApp();
  }

  /**
   * Create a fresh Bolt App instance with event handlers.
   * Must be called for each retry/reconnect attempt because the Bolt SDK's
   * Socket Mode creates internal WebSocket state that does not reset after failure.
   */
  private createApp(): void {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers(this.app);
  }

  private setupEventHandlers(app: App): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      // C4: is_from_me must be true only for this bot's own user id.
      // is_bot_message stays broad (any bot, including peers in the pool).
      // Session commands (/new, /compact) gate on is_from_me, so conflating
      // these would let peer bots issue admin commands.
      const isFromMe = !!this.botUserId && msg.user === this.botUserId;
      const isBotMessage = !!msg.bot_id || isFromMe;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isBotMessage,
      });
    });
  }

  /**
   * Check whether an error represents a permanent auth failure.
   * Auth errors are not retryable — stop immediately and alert.
   */
  private isAuthError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    for (const code of AUTH_ERROR_CODES) {
      if (msg.includes(code)) return true;
    }
    return false;
  }

  /**
   * Start a background timer that periodically calls attemptReconnect().
   * Does nothing if a timer is already running.
   */
  private startReconnectTimer(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setInterval(() => {
      void this.attemptReconnect();
    }, RECONNECT_INTERVAL_MS);
    logger.info('Slack reconnect timer started (60s interval)');
  }

  /** Stop the background reconnect timer. */
  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
      logger.info('Slack reconnect timer stopped');
    }
  }

  /**
   * Attempt a single reconnect cycle, guarded by `this.reconnecting` so
   * concurrent timer firings don't pile up.
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting || this.connected) return;
    this.reconnecting = true;
    try {
      logger.info('Slack: attempting background reconnect');

      // Stop any half-open sockets on the current App instance before
      // creating a fresh one — Bolt's Socket Mode state is not reusable.
      try {
        await this.app.stop();
      } catch {
        // ignore errors on stop
      }

      this.createApp();
      await this.app.start();
      await this.finishConnect();

      // Success — no more need for the reconnect timer
      this.stopReconnectTimer();
      logger.info('Slack: background reconnect succeeded');
    } catch (err) {
      logger.warn({ err }, 'Slack: background reconnect attempt failed');
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Post-connect logic shared by `connect()` and `attemptReconnect()`.
   * Resolves the bot user ID, marks the channel connected, flushes the
   * outgoing queue, and syncs channel metadata.
   */
  private async finishConnect(): Promise<void> {
    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async connect(): Promise<void> {
    try {
      await withRetry(
        () => this.app.start(),
        STARTUP_RETRY_ATTEMPTS,
        STARTUP_RETRY_BASE_MS,
        (attempt, error) => {
          if (this.isAuthError(error)) {
            const msg = `Slack auth error (${error.message}) — stopping retries`;
            logger.error({ error }, msg);
            this.opts.onAlert?.(msg);
            // Re-throw to break out of withRetry immediately
            throw error;
          }
          logger.warn(
            { attempt, error },
            `Slack connect attempt ${attempt} failed, retrying...`,
          );
        },
      );
    } catch (err) {
      // All retry attempts exhausted (or auth error short-circuited)
      const error = err instanceof Error ? err : new Error(String(err));

      if (this.isAuthError(error)) {
        // Auth errors are permanent — don't schedule reconnects
        logger.error(
          { error },
          'Slack: permanent auth error, not scheduling reconnect',
        );
        return;
      }

      logger.warn(
        { error },
        'Slack: all startup attempts failed, scheduling background reconnect',
      );
      this.startReconnectTimer();
      return;
    }

    await this.finishConnect();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      // Enforce queue size cap — drop oldest entry if at limit
      if (this.outgoingQueue.length >= MAX_QUEUE_SIZE) {
        const dropped = this.outgoingQueue.shift();
        logger.warn(
          { droppedJid: dropped?.jid },
          'Slack queue full, dropping oldest message',
        );
      }
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      // Enforce queue size cap on error-path queuing too
      if (this.outgoingQueue.length >= MAX_QUEUE_SIZE) {
        const dropped = this.outgoingQueue.shift();
        logger.warn(
          { droppedJid: dropped?.jid },
          'Slack queue full, dropping oldest message',
        );
      }
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.stopReconnectTimer();
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
