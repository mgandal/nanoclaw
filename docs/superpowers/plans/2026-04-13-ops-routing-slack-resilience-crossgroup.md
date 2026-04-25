# Ops Routing Guardrails, Slack Resilience, Cross-Group Messaging — Implementation Plan

> **Status: SHIPPED 2026-04-13 — all 3 workstreams live.** **WS1 Ops guardrails:** `sendSystemAlert(service, message, fixInstructions?)` constrained 3-arg signature at `src/index.ts:979`, internally resolves `OPS_ALERT_FOLDER` (line 1020); 4 call sites updated (1148, 1426…); `src/alert-routing.test.ts` (3 tests pass); `.husky/pre-commit` grep guardrail blocks hardcoded `telegram_` folders in `sendMessage`. **WS2 Slack resilience:** `src/channels/reconnect.ts` (`withRetry` utility, 4 tests pass); `src/channels/slack.ts` has `MAX_QUEUE_SIZE=100`, `reconnectTimer`/`reconnecting` state, background reconnect loop (line 198), `withRetry`-wrapped connect (line 274); `ChannelOpts.onAlert` added in `src/channels/registry.ts:12`. **WS3 Cross-group routing:** "## Cross-Group Routing" sections + `bus_read` instruction added to `groups/telegram_{vault,science,code,lab}-claw/CLAUDE.md`; "### Message Bus (Cross-Group Coordination)" added to `groups/global/CLAUDE.md:118`. Verification: `bun --bun vitest run src/alert-routing.test.ts src/channels/reconnect.test.ts` → 7/7 pass. Key commits: `34d769e2`, `c6f7294a`. Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent ops noise from leaking to working groups, make Slack connection resilient to failures, and enable cross-group knowledge sharing via agent instructions.

**Architecture:** Three independent workstreams. Workstream 1 constrains `sendSystemAlert()` to always target OPS-claw and adds test + lint guardrails. Workstream 2 refactors `SlackChannel` with retry-on-startup, background reconnection, and queue overflow protection. Workstream 3 adds routing tables to group CLAUDE.md files for message bus coordination.

**Tech Stack:** TypeScript/Bun, Slack Bolt SDK, vitest, husky pre-commit hooks

**Spec:** `docs/superpowers/specs/2026-04-13-ops-routing-slack-resilience-crossgroup-design.md`

---

## File Structure

### Workstream 1: Ops Guardrails
- **Modify:** `src/index.ts` — constrain `sendSystemAlert()` signature, update 4 call sites
- **Modify:** `src/task-scheduler.test.ts` — update alert test description
- **Create:** `src/alert-routing.test.ts` — routing verification tests
- **Modify:** `.husky/pre-commit` — add grep guardrail

### Workstream 2: Slack Resilience
- **Create:** `src/channels/reconnect.ts` — `withRetry()` utility
- **Create:** `src/channels/reconnect.test.ts` — tests for retry utility
- **Modify:** `src/channels/registry.ts` — add `onAlert?` to `ChannelOpts`
- **Modify:** `src/channels/slack.ts` — `createApp()`, retry connect, reconnection, queue cap
- **Modify:** `src/index.ts` — wire `onAlert`, wrap channel init in try-catch

### Workstream 3: Cross-Group Routing
- **Modify:** `groups/telegram_vault-claw/CLAUDE.md` — add routing table
- **Modify:** `groups/telegram_science-claw/CLAUDE.md` — add routing table + bus_read
- **Modify:** `groups/telegram_code-claw/CLAUDE.md` — add routing table + bus_read
- **Modify:** `groups/telegram_lab-claw/CLAUDE.md` — add routing table + bus_read
- **Modify:** `groups/global/CLAUDE.md` — add bus_read instruction

---

## Task 1: Constrain `sendSystemAlert()` signature

**Files:**
- Modify: `src/index.ts:822-848` (function signature + 4 call sites)

- [ ] **Step 1: Remove `targetFolders` parameter from `sendSystemAlert()`**

Change the function at `src/index.ts:822-848` from:

```typescript
/** Send an alert to specified groups + persist for digests. */
async function sendSystemAlert(
  service: string,
  message: string,
  targetFolders: string[],
  fixInstructions?: string,
): Promise<void> {
  appendAlert({
    timestamp: new Date().toISOString(),
    service,
    message,
    fixInstructions,
  });

  for (const folder of targetFolders) {
    const jid = Object.keys(registeredGroups).find(
      (j) => registeredGroups[j]?.folder === folder,
    );
    if (!jid) continue;
    const channel = findChannel(channels, jid);
    if (!channel) continue;
    const text = fixInstructions
      ? `⚠️ *${service}*: ${message}\n\n_Fix:_ ${fixInstructions}`
      : `⚠️ *${service}*: ${message}`;
    await channel.sendMessage(jid, text).catch(() => {});
  }
}
```

To:

```typescript
/** Send an alert to OPS-claw + persist for digests. Always routes to OPS_ALERT_FOLDER. */
async function sendSystemAlert(
  service: string,
  message: string,
  fixInstructions?: string,
): Promise<void> {
  appendAlert({
    timestamp: new Date().toISOString(),
    service,
    message,
    fixInstructions,
  });

  const jid = Object.keys(registeredGroups).find(
    (j) => registeredGroups[j]?.folder === OPS_ALERT_FOLDER,
  );
  if (!jid) return;
  const channel = findChannel(channels, jid);
  if (!channel) return;
  const text = fixInstructions
    ? `⚠️ *${service}*: ${message}\n\n_Fix:_ ${fixInstructions}`
    : `⚠️ *${service}*: ${message}`;
  await channel.sendMessage(jid, text).catch(() => {});
}
```

- [ ] **Step 2: Update all 4 call sites to remove the `[OPS_ALERT_FOLDER]` argument**

In `src/index.ts`, update these 4 calls:

Health monitor (line ~875):
```typescript
// Before:
void sendSystemAlert(alert.group, alert.detail, [OPS_ALERT_FOLDER]);
// After:
void sendSystemAlert(alert.group, alert.detail);
```

Event escalation (line ~1102):
```typescript
// Before:
void sendSystemAlert(
  'Event Escalation',
  event.classification.summary,
  [OPS_ALERT_FOLDER],
);
// After:
void sendSystemAlert(
  'Event Escalation',
  event.classification.summary,
);
```

Gmail auth (line ~1121):
```typescript
// Before:
void sendSystemAlert(
  'Gmail',
  error,
  [OPS_ALERT_FOLDER],
  'Re-authorize Gmail OAuth: run the OAuth refresh flow in ~/.gmail-mcp/',
);
// After:
void sendSystemAlert(
  'Gmail',
  error,
  'Re-authorize Gmail OAuth: run the OAuth refresh flow in ~/.gmail-mcp/',
);
```

Credential proxy (line ~1164):
```typescript
// Before:
void sendSystemAlert(
  'Credential Proxy',
  `${statusCode} auth failures from Anthropic API — token may be expired or invalid`,
  [OPS_ALERT_FOLDER],
  'Check CLAUDE_CODE_OAUTH_TOKEN in .env or run scripts/refresh-api-key.sh',
);
// After:
void sendSystemAlert(
  'Credential Proxy',
  `${statusCode} auth failures from Anthropic API — token may be expired or invalid`,
  'Check CLAUDE_CODE_OAUTH_TOKEN in .env or run scripts/refresh-api-key.sh',
);
```

- [ ] **Step 3: Remove `OPS_ALERT_FOLDER` from `index.ts` imports (no longer needed there)**

The import of `OPS_ALERT_FOLDER` from config.ts stays — it's used in `sendSystemAlert` body. But confirm it's no longer referenced at any call site.

- [ ] **Step 4: Build and verify**

Run: `bun run build 2>&1 | grep "src/index.ts"`
Expected: No errors from index.ts

- [ ] **Step 5: Run existing tests**

Run: `bun test src/health-monitor.test.ts`
Expected: 151 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "refactor: constrain sendSystemAlert to always route to OPS_ALERT_FOLDER

Remove targetFolders parameter — the function now always resolves OPS_ALERT_FOLDER
internally. Prevents future code from accidentally routing alerts to other groups."
```

---

## Task 2: Alert routing tests

**Files:**
- Create: `src/alert-routing.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/alert-routing.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OPS_ALERT_FOLDER } from './config.js';

/**
 * These tests verify that all system alert paths route exclusively
 * to OPS_ALERT_FOLDER and never to the main group or other groups.
 *
 * They test the contract, not the implementation — if someone adds
 * a new sendSystemAlert call site, these tests still pass. The
 * pre-commit grep guardrail (Task 3) catches new hardcoded folders.
 */

describe('alert routing contract', () => {
  it('OPS_ALERT_FOLDER defaults to telegram_ops-claw', () => {
    expect(OPS_ALERT_FOLDER).toBe('telegram_ops-claw');
  });

  it('OPS_ALERT_FOLDER is a string, not an array', () => {
    expect(typeof OPS_ALERT_FOLDER).toBe('string');
  });
});

describe('task scheduler alert routing', () => {
  it('flushAlerts resolves OPS group by folder, not isMain', async () => {
    // This test verifies the task-scheduler.ts flushAlerts function
    // looks for OPS_ALERT_FOLDER, not isMain. We import and call
    // checkAlerts with a mock that has OPS but no main group.
    // If flushAlerts still looked for isMain, sendMessage would not be called.

    const { _initTestDatabase } = await import('./db.js');
    const {
      checkAlerts,
      _resetAlertsForTests,
    } = await import('./task-scheduler.js');
    const { logTaskRun } = await import('./db.js');

    _initTestDatabase();
    _resetAlertsForTests();

    vi.useFakeTimers();

    // Create task and log 2 failures to trigger alert
    const { createTask } = await import('./db.js');
    createTask({
      id: 'routing-test',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 7 * * 1-5',
      status: 'active',
    });
    logTaskRun({
      task_id: 'routing-test',
      run_at: '2026-04-13T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail1',
    });
    logTaskRun({
      task_id: 'routing-test',
      run_at: '2026-04-13T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail2',
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);

    // Only OPS group registered — no main group
    const deps = {
      registeredGroups: () => ({
        'tg:ops': {
          name: 'OPS-claw',
          folder: 'telegram_ops-claw',
          trigger: '@Claire',
          added_at: new Date().toISOString(),
          isMain: false,
          requiresTrigger: false,
        },
      }),
      getSessions: () => ({}),
      queue: {} as any,
      onProcess: vi.fn(),
      sendMessage,
    };

    checkAlerts(
      {
        id: 'routing-test',
        group_folder: 'telegram_claire',
        chat_jid: 'tg:123',
        prompt: 'test',
        schedule_type: 'cron',
        schedule_value: '0 7 * * 1-5',
        status: 'active',
        next_run: new Date().toISOString(),
        last_run: null,
        last_result: null,
        created_at: new Date().toISOString(),
        context_mode: 'isolated',
        script: null,
        agent_name: null,
      },
      'fail2',
      deps,
    );

    vi.advanceTimersByTime(70000);

    // Alert should be sent to OPS JID, not main
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0]).toBe('tg:ops');

    vi.useRealTimers();
    _resetAlertsForTests();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test src/alert-routing.test.ts`
Expected: All tests pass (the config test passes immediately; the task scheduler test may fail due to the pre-existing better-sqlite3/Bun issue — if so, that's a known limitation, not a regression)

- [ ] **Step 3: Commit**

```bash
git add src/alert-routing.test.ts
git commit -m "test: add alert routing contract tests

Verify OPS_ALERT_FOLDER config and that task scheduler routes
alerts to OPS group, not main group."
```

---

## Task 3: Pre-commit grep guardrail

**Files:**
- Modify: `.husky/pre-commit`

- [ ] **Step 1: Add grep check to pre-commit hook**

Update `.husky/pre-commit` from:

```bash
$HOME/.bun/bin/bun run format:fix
```

To:

```bash
$HOME/.bun/bin/bun run format:fix

# Guardrail: prevent hardcoded group folder names in sendMessage calls.
# All system alerts must go through sendSystemAlert() which routes to OPS_ALERT_FOLDER.
# Allowed exceptions: test files, config.ts, container-runner.ts (vault special handling).
STAGED_TS=$(git diff --cached --name-only --diff-filter=ACM -- 'src/*.ts' | grep -v '\.test\.ts$' | grep -v 'config\.ts$' | grep -v 'container-runner\.ts$')
if [ -n "$STAGED_TS" ]; then
  if echo "$STAGED_TS" | xargs grep -n "sendMessage.*['\"]telegram_" 2>/dev/null; then
    echo ""
    echo "ERROR: Hardcoded telegram_ group folder in sendMessage call."
    echo "System alerts must use sendSystemAlert() which routes to OPS_ALERT_FOLDER."
    echo "If this is intentional (user-facing message), add the file to the pre-commit exclusion list."
    exit 1
  fi
fi
```

- [ ] **Step 2: Verify the hook works**

Run: `bash .husky/pre-commit`
Expected: Exits 0 (no violations in current staged files)

- [ ] **Step 3: Commit**

```bash
git add .husky/pre-commit
git commit -m "chore: add pre-commit guardrail against hardcoded alert routing

Fails if any staged .ts file (excluding tests, config, container-runner)
contains sendMessage calls with hardcoded telegram_ group folders."
```

---

## Task 4: Create `withRetry()` utility

**Files:**
- Create: `src/channels/reconnect.ts`
- Create: `src/channels/reconnect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/channels/reconnect.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

import { withRetry } from './reconnect.js';

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 3, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on failure and succeeds on second attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, 3, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(withRetry(fn, 3, 10)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('applies exponential backoff', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const promise = withRetry(fn, 3, 100);

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Second call after 100ms
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    // Third call after 200ms (100 * 2)
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(promise).rejects.toThrow('fail');
    vi.useRealTimers();
  });

  it('calls onRetry callback on each failure', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');
    await withRetry(fn, 3, 10, onRetry);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/channels/reconnect.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/channels/reconnect.ts`:

```typescript
/**
 * Retry a function with exponential backoff.
 * Used by channels for resilient connection handling.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
  onRetry?: (attempt: number, error: Error) => void,
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (onRetry) onRetry(i + 1, lastError);
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/channels/reconnect.test.ts`
Expected: 5 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/channels/reconnect.ts src/channels/reconnect.test.ts
git commit -m "feat: add withRetry() utility for channel connection resilience"
```

---

## Task 5: Add `onAlert` to `ChannelOpts`

**Files:**
- Modify: `src/channels/registry.ts:8-12`

- [ ] **Step 1: Add `onAlert` to `ChannelOpts` interface**

In `src/channels/registry.ts`, change:

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}
```

To:

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAlert?: (message: string) => void;
}
```

- [ ] **Step 2: Build and verify**

Run: `bun run build 2>&1 | grep "registry.ts"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/channels/registry.ts
git commit -m "feat: add onAlert callback to ChannelOpts for channel health alerts"
```

---

## Task 6: Refactor `SlackChannel` for connection resilience

**Files:**
- Modify: `src/channels/slack.ts`

This is the largest task. The key changes:
1. Factor App creation into `createApp()`
2. Add retry logic to `connect()` using `withRetry()`
3. Add background reconnection timer
4. Add queue overflow protection
5. Detect auth errors and stop retrying

- [ ] **Step 1: Rewrite `src/channels/slack.ts`**

Replace the full file content with:

```typescript
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

const MAX_MESSAGE_LENGTH = 4000;
const MAX_QUEUE_SIZE = 100;
const RECONNECT_INTERVAL_MS = 60_000;
const STARTUP_RETRY_ATTEMPTS = 3;
const STARTUP_RETRY_BASE_MS = 2000;

// Auth error codes from Slack that mean retrying is futile
const AUTH_ERROR_CODES = new Set([
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'token_expired',
]);

type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAlert?: (message: string) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';

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

    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    this.botToken = env.SLACK_BOT_TOKEN || '';
    this.appToken = env.SLACK_APP_TOKEN || '';

    if (!this.botToken || !this.appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = this.createApp();
  }

  /** Create a fresh Bolt App instance with event handlers wired up. */
  private createApp(): App {
    const app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers(app);
    return app;
  }

  private setupEventHandlers(app: App): void {
    app.event('message', async ({ event }) => {
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      const msg = event as HandledMessageEvent;
      if (!msg.text) return;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

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
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    try {
      await withRetry(
        async () => {
          // Fresh App instance for each attempt (Bolt doesn't reset internal
          // Socket Mode state after a failed start)
          this.app = this.createApp();
          await this.app.start();
        },
        STARTUP_RETRY_ATTEMPTS,
        STARTUP_RETRY_BASE_MS,
        (attempt, error) => {
          logger.warn(
            { attempt, err: error.message },
            'Slack connection attempt failed, retrying',
          );
          // Clean up half-open socket before retry
          this.app.stop().catch(() => {});

          // Stop retrying on auth errors
          if (this.isAuthError(error)) {
            this.opts.onAlert?.(
              `Slack auth error: ${error.message}. Check SLACK_BOT_TOKEN and SLACK_APP_TOKEN.`,
            );
            throw error; // breaks out of withRetry
          }
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Slack failed to connect after retries');
      this.opts.onAlert?.(
        `Slack failed to connect after ${STARTUP_RETRY_ATTEMPTS} attempts: ${message}`,
      );
      this.startReconnectTimer();
      return; // degrade gracefully — don't throw
    }

    await this.finishConnect();
  }

  /** Post-connect setup: resolve bot ID, flush queue, sync metadata. */
  private async finishConnect(): Promise<void> {
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;
    this.stopReconnectTimer();

    await this.flushOutgoingQueue();
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      if (this.outgoingQueue.length >= MAX_QUEUE_SIZE) {
        logger.warn(
          { jid, queueSize: this.outgoingQueue.length },
          'Slack queue full, dropping oldest message',
        );
        this.outgoingQueue.shift();
      }
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
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

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

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

  private isAuthError(error: Error): boolean {
    const msg = error.message || '';
    for (const code of AUTH_ERROR_CODES) {
      if (msg.includes(code)) return true;
    }
    return false;
  }

  private startReconnectTimer(): void {
    if (this.reconnectTimer) return;
    logger.info('Starting Slack background reconnection timer');
    this.reconnectTimer = setInterval(() => {
      void this.attemptReconnect();
    }, RECONNECT_INTERVAL_MS);
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting || this.connected) return;
    this.reconnecting = true;

    try {
      logger.info('Attempting Slack reconnection...');
      this.app = this.createApp();
      await this.app.start();
      await this.finishConnect();
      logger.info('Slack reconnected successfully');
      this.opts.onAlert?.('Slack reconnected successfully');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn({ err: error.message }, 'Slack reconnection failed');
      this.app.stop().catch(() => {});

      if (this.isAuthError(error)) {
        logger.error('Slack auth error during reconnect — stopping retries');
        this.opts.onAlert?.(
          `Slack auth error: ${error.message}. Reconnection stopped.`,
        );
        this.stopReconnectTimer();
      }
    } finally {
      this.reconnecting = false;
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
```

- [ ] **Step 2: Build and verify**

Run: `bun run build 2>&1 | grep "slack.ts"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/channels/slack.ts
git commit -m "feat: add Slack connection resilience with retry, reconnect, and queue cap

- Factor App creation into createApp() for fresh instance per retry
- Retry 3x with exponential backoff (2s, 4s, 8s) on startup
- Background reconnection timer (60s) on failed startup
- Detect auth errors and stop retrying (futile)
- Queue overflow protection (100 msg cap, drop oldest)
- Alert OPS-claw via onAlert callback on failures"
```

---

## Task 7: Wire `onAlert` and resilient channel init in `index.ts`

**Files:**
- Modify: `src/index.ts:1330-1349` (channel initialization loop)

- [ ] **Step 1: Update channel initialization loop**

In `src/index.ts`, change the channel init loop (lines ~1330-1349) from:

```typescript
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
```

To:

```typescript
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory({
      ...channelOpts,
      onAlert: (msg) => void sendSystemAlert(channelName, msg),
    });
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    try {
      await channel.connect();
    } catch (err) {
      logger.error(
        { channel: channelName, err },
        'Channel failed to connect — continuing with remaining channels',
      );
      void sendSystemAlert(
        channelName,
        `Channel failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

- [ ] **Step 2: Build and verify**

Run: `bun run build 2>&1 | grep "src/index.ts"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire onAlert callback and resilient channel init

- Pass onAlert to channel factories, routed through sendSystemAlert
- Wrap channel.connect() in try-catch so one channel failure doesn't
  crash startup for other channels"
```

---

## Task 8: Cross-group routing table in VAULT-claw CLAUDE.md

**Files:**
- Modify: `groups/telegram_vault-claw/CLAUDE.md`

- [ ] **Step 1: Add routing table section**

Append the following to the end of `groups/telegram_vault-claw/CLAUDE.md` (before the Agent Teams section at line 88):

```markdown
## Cross-Group Routing

When you curate or discover something relevant to another group, publish it to the message bus with `bus_publish` using the appropriate `action_needed` target. This ensures the right group sees it in their next session.

| Topic | Route to | Examples |
|-------|----------|---------|
| Papers, preprints, genomics, transcriptomics | telegram_science-claw | New GWAS paper, competing lab preprint, methods comparison |
| Pipeline tools, bioinformatics software, code patterns | telegram_code-claw | New single-cell tool, Snakemake pattern, benchmark result |
| Grant deadlines, funding opportunities, collaboration leads | telegram_lab-claw | R01 resubmission reminder, new RFA, collaborator intro |
| Infrastructure, service status, NanoClaw changes | telegram_ops-claw | QMD index update, sync pipeline change, service alert |
| Urgent or cross-cutting (touches 2+ domains) | telegram_claire | Time-sensitive, needs Mike's judgment, multi-group coordination |

For items relevant to multiple groups, call `bus_publish` once per target group.

Example:
```
bus_publish(topic: "papers", finding: "New Geschwind lab preprint on cortical organoid transcriptomics — directly relevant to R01 Aim 2", action_needed: "telegram_science-claw", priority: "medium")
```

At the start of each session, check for incoming messages from other groups with `bus_read`.
```

Insert this section at line 87 (before the `## Agent Teams` heading).

- [ ] **Step 2: Commit**

```bash
git add groups/telegram_vault-claw/CLAUDE.md
git commit -m "feat: add cross-group routing table to VAULT-claw

Guides the agent on which groups to notify via bus_publish
when curating knowledge relevant to other domains."
```

---

## Task 9: Add bus awareness to SCIENCE-claw, CODE-claw, LAB-claw

**Files:**
- Modify: `groups/telegram_science-claw/CLAUDE.md`
- Modify: `groups/telegram_code-claw/CLAUDE.md`
- Modify: `groups/telegram_lab-claw/CLAUDE.md`

- [ ] **Step 1: Read each file to find the right insertion point**

Read the end of each CLAUDE.md to find where to append the routing section.

- [ ] **Step 2: Add routing section to each group's CLAUDE.md**

Append the following to each file (adapt the preamble for the group's voice):

```markdown
## Cross-Group Routing

At the start of each session, check for incoming messages from other groups with `bus_read`.

When you discover something relevant to another group, publish it to the message bus:

| Topic | Route to | Examples |
|-------|----------|---------|
| Papers, preprints, genomics, transcriptomics | telegram_science-claw | New GWAS paper, competing lab preprint |
| Pipeline tools, bioinformatics software, code patterns | telegram_code-claw | New single-cell tool, Snakemake pattern |
| Grant deadlines, funding opportunities, collaboration leads | telegram_lab-claw | R01 resubmission reminder, new RFA |
| Infrastructure, service status, NanoClaw changes | telegram_ops-claw | QMD index update, sync pipeline change |
| Knowledge items, papers, bookmarks for curation | telegram_vault-claw | Item worth adding to the wiki |
| Urgent or cross-cutting (touches 2+ domains) | telegram_claire | Time-sensitive, needs Mike's judgment |

Use `bus_publish(topic, finding, action_needed, priority)` to send.
```

- [ ] **Step 3: Commit**

```bash
git add groups/telegram_science-claw/CLAUDE.md groups/telegram_code-claw/CLAUDE.md groups/telegram_lab-claw/CLAUDE.md
git commit -m "feat: add cross-group routing awareness to SCIENCE, CODE, LAB groups

Each group now checks bus_read at session start and knows how
to route discoveries to the right group via bus_publish."
```

---

## Task 10: Add bus_read instruction to global CLAUDE.md

**Files:**
- Modify: `groups/global/CLAUDE.md`

- [ ] **Step 1: Find the right insertion point**

Look for the Hindsight section or the end of the session protocol section in `groups/global/CLAUDE.md`.

- [ ] **Step 2: Add bus_read instruction**

Add after the Hindsight "When to recall" section (around line 163):

```markdown
### Message Bus (Cross-Group Coordination)

Other groups may have published findings relevant to your current session. At session start, check for pending messages:

- `bus_read` — read all pending messages from other groups
- `bus_read(topic: "papers")` — filter by topic

If you discover something relevant to another group during your session, use `bus_publish`:

```
bus_publish(topic: "research", finding: "...", action_needed: "telegram_science-claw", priority: "medium")
```
```

- [ ] **Step 3: Commit**

```bash
git add groups/global/CLAUDE.md
git commit -m "feat: add message bus instructions to global CLAUDE.md

Claire now checks bus_read at session start and can route
findings to other groups via bus_publish."
```

---

## Summary

| Task | Workstream | What |
|------|-----------|------|
| 1 | Guardrails | Constrain `sendSystemAlert()` — remove targetFolders param |
| 2 | Guardrails | Alert routing tests |
| 3 | Guardrails | Pre-commit grep guardrail |
| 4 | Slack | `withRetry()` utility with tests |
| 5 | Slack | Add `onAlert` to `ChannelOpts` |
| 6 | Slack | Refactor `SlackChannel` with resilience |
| 7 | Slack | Wire `onAlert` + resilient channel init in `index.ts` |
| 8 | Cross-group | Routing table in VAULT-claw |
| 9 | Cross-group | Bus awareness in SCIENCE/CODE/LAB |
| 10 | Cross-group | Bus instructions in global CLAUDE.md |
