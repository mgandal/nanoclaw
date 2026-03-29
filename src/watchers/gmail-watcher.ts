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
  /** Directory where gmail-state.json is persisted */
  stateDir: string;
  /** Called on first auth failure (e.g. expired token). Fire-and-forget. */
  onAuthFailure?: (error: string) => void;
}

export interface GmailWatcherStatus {
  mode: 'polling';
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

  constructor(config: GmailWatcherConfig) {
    this.config = config;
    this.stateFilePath = path.join(config.stateDir, 'gmail-state.json');
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info({ account: this.config.account }, 'GmailWatcher starting');
    this.auth = await this.authenticate();
    this.loadState();
    const selfScheduled = await this.poll();
    // Only schedule if poll didn't already set up its own backoff timer
    if (!selfScheduled) {
      this.scheduleNext();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info({ account: this.config.account }, 'GmailWatcher stopped');
  }

  getStatus(): GmailWatcherStatus {
    return {
      mode: 'polling',
      account: this.config.account,
      lastCheck: this.lastCheck,
      messagesProcessed: this.messagesProcessed,
    };
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
