/**
 * GmailWatcher — polls Gmail API for new messages and routes them through
 * the EventRouter as EmailPayload events.
 *
 * State (last-processed message IDs + historyId) is persisted to
 * stateDir/gmail-state.json so re-starts don't reprocess old messages.
 */

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '../logger.js';
import type { EventRouter } from '../event-router.js';
import type { EmailPayload } from '../classification-prompts.js';

// ─── Auth failure backoff ─────────────────────────────────────────────────────

/** Backoff intervals in ms: 1min, 5min, 30min, then stop (-1). */
export const AUTH_BACKOFF_SCHEDULE = [60_000, 300_000, 1_800_000];

/** Given consecutive auth failure count, return backoff ms or -1 to stop. */
export function computeBackoffMs(failureCount: number): number {
  if (failureCount >= AUTH_BACKOFF_SCHEDULE.length) return -1;
  return AUTH_BACKOFF_SCHEDULE[failureCount];
}

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface GmailWatcherConfig {
  /** Path to credentials.json (contains installed.client_id etc. + token) */
  credentialsPath: string;
  /** Gmail account address (used for logging) */
  account: string;
  /** EventRouter instance to receive parsed emails */
  eventRouter: EventRouter;
  /** How often to poll, in milliseconds */
  pollIntervalMs: number;
  /** Google Cloud Pub/Sub topic for push notifications (optional — falls back to polling) */
  pubsubTopic?: string;
  /** Google Cloud Pub/Sub subscription name */
  pubsubSubscription?: string;
  /** Path to GCP service account JSON for Pub/Sub (separate from Gmail OAuth) */
  pubsubServiceAccountPath?: string;
  /** Directory where gmail-state.json is persisted */
  stateDir: string;
  /** Called on first auth failure (e.g. expired token). Fire-and-forget. */
  onAuthFailure?: (error: string) => void;
}

export interface GmailWatcherStatus {
  mode: 'polling' | 'push';
  account: string;
  lastCheck: string | null;
  messagesProcessed: number;
}

// ─── Internal state shape ─────────────────────────────────────────────────────

interface GmailState {
  processedIds: string[];
  lastHistoryId?: string;
}

// ─── Raw Gmail message shape (partial) ───────────────────────────────────────

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailRawMessage {
  id?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  labelIds?: string[] | null;
  payload?: {
    headers?: GmailHeader[];
    parts?: GmailPart[];
    mimeType?: string;
    body?: { attachmentId?: string; size?: number };
  };
}

// ─── GmailWatcher ────────────────────────────────────────────────────────────

export class GmailWatcher {
  private config: GmailWatcherConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private auth: OAuth2Client | null = null;
  private messagesProcessed = 0;
  private lastCheck: string | null = null;
  private stateFilePath: string;
  private state: GmailState = { processedIds: [] };
  private authFailureCount = 0;
  private historyWatermark: string | null = null;
  private pushModeActive = false;
  private pubsubSubscriptionHandle: { close: () => void } | null = null;

  constructor(config: GmailWatcherConfig) {
    this.config = config;
    this.stateFilePath = path.join(config.stateDir, 'gmail-state.json');
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info({ account: this.config.account }, 'GmailWatcher starting');
    this.auth = await this.authenticate();
    this.loadState();

    // Restore watermark from persisted state
    if (this.state.lastHistoryId) {
      this.historyWatermark = this.state.lastHistoryId;
    }

    // Try push mode first if configured
    if (this.config.pubsubTopic && this.config.pubsubSubscription) {
      const pushStarted = await this.startPushMode();
      if (pushStarted) return;
    }

    const selfScheduled = await this.poll();
    if (!selfScheduled) {
      this.scheduleNext();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopPushMode();
    logger.info({ account: this.config.account }, 'GmailWatcher stopped');
  }

  getStatus(): GmailWatcherStatus {
    return {
      mode: this.pushModeActive ? 'push' : 'polling',
      account: this.config.account,
      lastCheck: this.lastCheck,
      messagesProcessed: this.messagesProcessed,
    };
  }

  setPushModeActive(active: boolean): void {
    this.pushModeActive = active;
  }

  /** Sets the history watermark used for replay protection. */
  setHistoryWatermark(historyId: string): void {
    this.historyWatermark = historyId;
  }

  /**
   * Fetches messages added since `startHistoryId` using the Gmail history API.
   * More efficient than poll() — only retrieves messages newer than the given
   * historyId rather than listing all INBOX messages.
   *
   * Returns the count of new messages processed.
   * Returns 0 if `startHistoryId` is behind the current watermark (replay protection).
   * Falls back to poll() if Gmail reports the historyId is expired/invalid.
   */
  async fetchNewMessagesByHistory(startHistoryId: string): Promise<number> {
    if (!this.auth) return 0;

    // Replay protection: reject stale historyIds
    if (
      this.historyWatermark !== null &&
      BigInt(startHistoryId) <= BigInt(this.historyWatermark)
    ) {
      logger.warn(
        {
          account: this.config.account,
          startHistoryId,
          watermark: this.historyWatermark,
        },
        'GmailWatcher.fetchNewMessagesByHistory: stale historyId — rejecting (replay protection)',
      );
      return 0;
    }

    const gmail = google.gmail({ version: 'v1', auth: this.auth });

    try {
      const historyRes = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
      });

      const historyItems = historyRes.data.history ?? [];
      const processedSet = new Set(this.state.processedIds);
      let newCount = 0;

      for (const record of historyItems) {
        const added = record.messagesAdded ?? [];
        for (const entry of added) {
          const msgId = entry.message?.id;
          if (!msgId || processedSet.has(msgId)) continue;

          try {
            const msgRes = await gmail.users.messages.get({
              userId: 'me',
              id: msgId,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
            });

            const raw = msgRes.data as GmailRawMessage;
            const payload = GmailWatcher.parseMessage(raw);

            await this.config.eventRouter.route({
              type: 'email',
              id: msgId,
              timestamp: new Date().toISOString(),
              payload: payload as unknown as Record<string, unknown>,
            });

            processedSet.add(msgId);
            this.messagesProcessed++;
            newCount++;
          } catch (err) {
            logger.warn(
              { err, messageId: msgId, account: this.config.account },
              'GmailWatcher.fetchNewMessagesByHistory failed to fetch/route message — skipping',
            );
          }
        }
      }

      // Update watermark from the response's historyId
      if (historyRes.data.historyId) {
        this.historyWatermark = historyRes.data.historyId;
        this.state.lastHistoryId = historyRes.data.historyId;
      }

      // Persist processed IDs (bounded to last 2000)
      const MAX_PROCESSED = 2000;
      const allIds = Array.from(processedSet);
      this.state.processedIds = allIds.slice(
        Math.max(0, allIds.length - MAX_PROCESSED),
      );
      this.saveState();

      return newCount;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isExpired =
        message.includes('notFound') ||
        message.includes('invalid') ||
        message.includes('not found') ||
        (err as { code?: number }).code === 404 ||
        (err as { errors?: Array<{ reason?: string }> }).errors?.some(
          (e) => e.reason === 'notFound' || e.reason === 'invalid',
        );

      if (isExpired) {
        logger.warn(
          { account: this.config.account, startHistoryId },
          'GmailWatcher.fetchNewMessagesByHistory: historyId expired — falling back to poll()',
        );
        await this.poll();
        return 0;
      }

      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher.fetchNewMessagesByHistory failed',
      );
      return 0;
    }
  }

  // ─── Static helpers ────────────────────────────────────────────────────────

  /**
   * Parses a raw Gmail API message object into an EmailPayload.
   * Handles missing fields gracefully.
   */
  static parseMessage(msg: GmailRawMessage): EmailPayload {
    const headers: GmailHeader[] = msg.payload?.headers ?? [];

    const getHeader = (name: string): string => {
      const lower = name.toLowerCase();
      return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
    };

    const splitAddresses = (raw: string): string[] => {
      if (!raw.trim()) return [];
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    };

    const hasAttachments = GmailWatcher.detectAttachments(
      msg.payload?.parts ?? [],
    );

    return {
      messageId: msg.id ?? '',
      threadId: msg.threadId ?? '',
      from: getHeader('From'),
      to: splitAddresses(getHeader('To')),
      cc: splitAddresses(getHeader('Cc')),
      subject: getHeader('Subject'),
      snippet: msg.snippet ?? '',
      date: getHeader('Date'),
      labels: msg.labelIds ?? [],
      hasAttachments,
    };
  }

  // ─── Private methods ───────────────────────────────────────────────────────

  private async startPushMode(): Promise<boolean> {
    const { pubsubTopic, pubsubSubscription, pubsubServiceAccountPath } = this.config;
    if (!pubsubTopic || !pubsubSubscription) return false;

    try {
      const { PubSub } = await import('@google-cloud/pubsub');
      const pubsub = pubsubServiceAccountPath
        ? new PubSub({ keyFilename: pubsubServiceAccountPath })
        : new PubSub();

      await this.registerGmailWatch();

      const subscription = pubsub.subscription(pubsubSubscription);
      this.pubsubSubscriptionHandle = subscription;

      subscription.on('message', (message: { data: Buffer; ack: () => void }) => {
        try {
          const data = JSON.parse(message.data.toString());
          const historyId = data.historyId as string | undefined;
          message.ack();
          if (historyId) {
            void this.fetchNewMessagesByHistory(historyId).catch((err) => {
              logger.warn({ err, account: this.config.account }, 'GmailWatcher push handler failed');
            });
          }
        } catch (err) {
          message.ack();
          logger.warn({ err }, 'GmailWatcher failed to parse Pub/Sub message');
        }
      });

      subscription.on('error', (err: Error) => {
        logger.error({ err, account: this.config.account }, 'GmailWatcher Pub/Sub error — falling back to polling');
        this.stopPushMode();
        this.scheduleNext();
      });

      this.setPushModeActive(true);
      logger.info({ account: this.config.account, topic: pubsubTopic }, 'GmailWatcher started in push mode');
      return true;
    } catch (err) {
      logger.warn({ err, account: this.config.account }, 'GmailWatcher failed to start push mode — falling back to polling');
      return false;
    }
  }

  private stopPushMode(): void {
    if (this.pubsubSubscriptionHandle) {
      this.pubsubSubscriptionHandle.close();
      this.pubsubSubscriptionHandle = null;
    }
    this.setPushModeActive(false);
  }

  private async registerGmailWatch(): Promise<void> {
    if (!this.auth || !this.config.pubsubTopic) return;
    const gmail = google.gmail({ version: 'v1', auth: this.auth });
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: this.config.pubsubTopic,
        labelIds: ['INBOX'],
      },
    });
    if (res.data.historyId) {
      this.historyWatermark = res.data.historyId;
      this.state.lastHistoryId = res.data.historyId;
      this.saveState();
    }
    logger.info({ account: this.config.account, expiration: res.data.expiration }, 'Gmail watch registered');

    // Re-register every 6 days (watches expire after 7)
    setTimeout(() => void this.registerGmailWatch(), 6 * 24 * 60 * 60 * 1000);
  }

  private async authenticate(): Promise<OAuth2Client> {
    const raw = fs.readFileSync(this.config.credentialsPath, 'utf-8');
    const creds = JSON.parse(raw) as Record<string, unknown>;

    // Try standard format first (installed/web key with client config)
    let clientConfig = (creds.installed ?? creds.web) as
      | {
          client_id: string;
          client_secret: string;
          redirect_uris: string[];
          token?: Record<string, unknown>;
        }
      | undefined;

    let tokenData: Record<string, unknown> | undefined;

    if (clientConfig) {
      tokenData = clientConfig.token;
    } else {
      // credentials.json is a bare token file — look for a separate OAuth keys file
      const keysPath = path.join(
        path.dirname(this.config.credentialsPath),
        'gcp-oauth.keys.json',
      );
      if (!fs.existsSync(keysPath)) {
        throw new Error(
          `credentials.json at ${this.config.credentialsPath} has no "installed" or "web" key, ` +
            `and no gcp-oauth.keys.json found alongside it`,
        );
      }
      const keysRaw = fs.readFileSync(keysPath, 'utf-8');
      const keys = JSON.parse(keysRaw) as Record<string, unknown>;
      clientConfig = (keys.installed ?? keys.web) as typeof clientConfig;
      if (!clientConfig) {
        throw new Error(
          `gcp-oauth.keys.json at ${keysPath} has no "installed" or "web" key`,
        );
      }
      // The original credentials.json is the token
      tokenData = creds as Record<string, unknown>;
    }

    const client = new OAuth2Client(
      clientConfig.client_id,
      clientConfig.client_secret,
      clientConfig.redirect_uris[0],
    );

    if (tokenData) {
      client.setCredentials(tokenData);
    }

    return client;
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        this.state = JSON.parse(raw) as GmailState;
        logger.debug(
          {
            account: this.config.account,
            processedCount: this.state.processedIds.length,
          },
          'GmailWatcher loaded persisted state',
        );
      }
    } catch (err) {
      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher failed to load state — starting fresh',
      );
      this.state = { processedIds: [] };
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      fs.writeFileSync(
        this.stateFilePath,
        JSON.stringify(this.state, null, 2),
        'utf-8',
      );
    } catch (err) {
      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher failed to save state',
      );
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.poll().then((selfScheduled) => {
        if (!selfScheduled) this.scheduleNext();
      });
    }, this.config.pollIntervalMs);
  }

  /** Returns true if poll set up its own backoff timer (caller should not reschedule). */
  private async poll(): Promise<boolean> {
    if (!this.auth) return false;

    const gmail = google.gmail({ version: 'v1', auth: this.auth });
    this.lastCheck = new Date().toISOString();

    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        maxResults: 50,
      });

      const messages = listRes.data.messages ?? [];
      const processedSet = new Set(this.state.processedIds);

      for (const stub of messages) {
        if (!stub.id || processedSet.has(stub.id)) continue;

        try {
          const msgRes = await gmail.users.messages.get({
            userId: 'me',
            id: stub.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
          });

          const raw = msgRes.data as GmailRawMessage;
          const payload = GmailWatcher.parseMessage(raw);

          await this.config.eventRouter.route({
            type: 'email',
            id: stub.id,
            timestamp: new Date().toISOString(),
            payload: payload as unknown as Record<string, unknown>,
          });

          processedSet.add(stub.id);
          this.messagesProcessed++;
        } catch (err) {
          logger.warn(
            { err, messageId: stub.id, account: this.config.account },
            'GmailWatcher failed to fetch/route message — skipping',
          );
        }
      }

      // Keep only the last 2000 processed IDs to bound memory/file size
      const MAX_PROCESSED = 2000;
      const allIds = Array.from(processedSet);
      this.state.processedIds = allIds.slice(
        Math.max(0, allIds.length - MAX_PROCESSED),
      );

      this.saveState();

      // Reset auth failure counter on successful poll
      this.authFailureCount = 0;

      logger.debug(
        {
          account: this.config.account,
          newMessages: this.messagesProcessed,
          polled: messages.length,
        },
        'GmailWatcher poll complete',
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isAuthError =
        message.includes('invalid_grant') ||
        message.includes('Invalid Credentials') ||
        message.includes('invalid authentication credentials') ||
        message.includes('Token has been expired or revoked');

      if (isAuthError) {
        this.authFailureCount++;
        const backoff = computeBackoffMs(this.authFailureCount - 1);

        if (this.authFailureCount === 1 && this.config.onAuthFailure) {
          this.config.onAuthFailure(
            `Gmail OAuth failed for ${this.config.account}: ${message}. ` +
              `Re-authorize by running the OAuth refresh flow in ~/.gmail-mcp/`,
          );
        }

        if (backoff === -1) {
          logger.error(
            { tag: 'SYSTEM_ALERT', account: this.config.account },
            'GmailWatcher stopping after repeated auth failures',
          );
          this.stop();
          return true; // stopped — don't reschedule
        }

        logger.error(
          {
            tag: 'SYSTEM_ALERT',
            account: this.config.account,
            attempt: this.authFailureCount,
            nextRetryMs: backoff,
          },
          'GmailWatcher auth failure — backing off',
        );

        // Override the normal poll interval for backoff
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void this.poll().then((selfScheduled) => {
            if (!selfScheduled) this.scheduleNext();
          });
        }, backoff);
        return true; // self-scheduled backoff — caller must not reschedule
      }

      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher poll failed',
      );
    }
    return false;
  }

  private static detectAttachments(parts: GmailPart[]): boolean {
    for (const part of parts) {
      // A part with an attachmentId and a non-empty size is a real attachment
      if (part.body?.attachmentId && (part.body.size ?? 0) > 0) {
        return true;
      }
      // Recurse into nested parts (multipart/*)
      if (part.parts && GmailWatcher.detectAttachments(part.parts)) {
        return true;
      }
    }
    return false;
  }
}
