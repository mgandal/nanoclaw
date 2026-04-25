# Smarter Claw Phase 1 — Implementation Plan

> **Status: SHIPPED 2026-04-13.** All 3 features landed. **Feature A (Gmail Pub/Sub):** 4 commits — `36d48df5` (types), `9ee0c809` (history fetch), `8c80f44c` (status tracking), `e2e0ef1b` (Pub/Sub wiring). Verified at `src/watchers/gmail-watcher.ts:40-44, 105, 125, 172, 339-404`. **Feature B (Shared Intelligence):** `knowledge_publish` IPC handler at `src/ipc.ts:1419`; tests at `src/ipc.test.ts:1631, 1660` (incl. C13 trust enforcement). **Feature C (Pattern Engine):** `action_log` and `pattern_proposals` tables in `src/db.ts:110, 122`; helpers at `db.ts:1139-1211`; tests at `src/db.test.ts:2473, 2498`. Note: pattern-detection scheduled task was later retired (see `src/task-scheduler.ts:329` comment "Pattern detection was removed") — table writes retained for downstream consumers. Plan-tracking commit: `018f90eb`. Phase 2 followup shipped at commit `95dda1c2` (see `2026-04-25-skill-crystallization-phase2-3.md`). Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NanoClaw agents smarter and more aware: instant email perception (Gmail Push), cross-agent knowledge sharing (Shared Intelligence), and pattern recognition with outcome tracking (Pattern Engine).

**Architecture:** Three independent features that share no code dependencies between each other. Gmail Push replaces the polling loop in GmailWatcher. Shared Intelligence adds a new QMD collection and IPC handler for cross-agent knowledge. Pattern Engine adds container-side tool call emission, host-side collection, and a daily detection task. Each can be implemented and shipped independently.

**Tech Stack:** TypeScript (Bun), vitest, `@google-cloud/pubsub`, QMD, Ollama phi4-mini, SQLite

**Spec:** `docs/superpowers/specs/2026-04-13-smarter-claw-roadmap-design.md` (v2, peer-reviewed)

---

## Feature A: Gmail Push Monitoring

### Task A1: Add Pub/Sub dependency and push mode types

**Files:**
- Modify: `package.json` — add `@google-cloud/pubsub`
- Modify: `src/watchers/gmail-watcher.ts` — update interfaces

- [ ] **Step 1: Install @google-cloud/pubsub**

Run: `bun add @google-cloud/pubsub`

- [ ] **Step 2: Update GmailWatcherConfig interface**

In `src/watchers/gmail-watcher.ts`, add optional Pub/Sub fields to the config interface:

```typescript
// Add after the existing pollIntervalMs field in GmailWatcherConfig:
  /** Google Cloud Pub/Sub topic for push notifications (optional — falls back to polling) */
  pubsubTopic?: string;
  /** Google Cloud Pub/Sub subscription name */
  pubsubSubscription?: string;
  /** Path to GCP service account JSON for Pub/Sub (separate from Gmail OAuth) */
  pubsubServiceAccountPath?: string;
```

- [ ] **Step 3: Update GmailWatcherStatus to support push mode**

In `src/watchers/gmail-watcher.ts`, change the `mode` field:

```typescript
export interface GmailWatcherStatus {
  mode: 'polling' | 'push';
  account: string;
  lastCheck: string | null;
  messagesProcessed: number;
}
```

- [ ] **Step 4: Commit**

Stage: `package.json bun.lock src/watchers/gmail-watcher.ts`
Message: `feat(gmail): add pubsub dependency and push mode types`

### Task A2: Implement historyId-based message fetching

**Files:**
- Modify: `src/watchers/gmail-watcher.ts` — add `fetchNewMessagesByHistory()` method
- Test: `src/watchers/gmail-watcher.test.ts` — test history-based fetching

The existing `poll()` method lists all INBOX messages and filters by processed IDs. Pub/Sub notifications provide a `historyId` — we need a method that fetches only messages newer than that history point.

- [ ] **Step 1: Write the failing test**

Add to `src/watchers/gmail-watcher.test.ts`:

```typescript
// Add to the mock setup (top-level, alongside existing mocks):
const mockHistoryList = vi.fn();

// Update the googleapis mock to include history:
vi.mock('googleapis', () => ({
  google: {
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
        },
        history: {
          list: mockHistoryList,
        },
      },
    })),
  },
}));

// Add this test inside the describe block:
describe('fetchNewMessagesByHistory', () => {
  it('fetches messages added since a historyId', async () => {
    const tmpDir = makeTempDir();
    const credsPath = makeCredentials(tmpDir);
    const router = makeEventRouter();

    const watcher = new GmailWatcher({
      credentialsPath: credsPath,
      account: 'test@gmail.com',
      eventRouter: router,
      pollIntervalMs: 60000,
      stateDir: tmpDir,
    });

    // Simulate: history.list returns one messagesAdded event
    mockHistoryList.mockResolvedValueOnce({
      data: {
        history: [
          {
            messagesAdded: [{ message: { id: 'hist-msg-1' } }],
          },
        ],
        historyId: '54322',
      },
    });

    mockMessagesGet.mockResolvedValueOnce({
      data: {
        id: 'hist-msg-1',
        threadId: 'thread-1',
        snippet: 'Hello from history',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'Subject', value: 'History test' },
          ],
        },
      },
    });

    // Need to start to authenticate first
    await watcher.start();
    watcher.stop(); // stop polling — we're testing the method directly

    const count = await watcher.fetchNewMessagesByHistory('54321');
    expect(count).toBe(1);
    expect(router.route).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'email',
        id: 'hist-msg-1',
      }),
    );

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates historyId against watermark — rejects replay', async () => {
    const tmpDir = makeTempDir();
    const credsPath = makeCredentials(tmpDir);
    const router = makeEventRouter();

    const watcher = new GmailWatcher({
      credentialsPath: credsPath,
      account: 'test@gmail.com',
      eventRouter: router,
      pollIntervalMs: 60000,
      stateDir: tmpDir,
    });

    await watcher.start();
    watcher.stop();

    // Set the internal watermark high
    watcher.setHistoryWatermark('99999');

    // Try fetching with an old historyId (replay)
    const count = await watcher.fetchNewMessagesByHistory('50000');
    expect(count).toBe(0);
    expect(mockHistoryList).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/watchers/gmail-watcher.test.ts --reporter verbose`
Expected: FAIL — `fetchNewMessagesByHistory` and `setHistoryWatermark` don't exist yet.

- [ ] **Step 3: Implement fetchNewMessagesByHistory**

Add to the `GmailWatcher` class in `src/watchers/gmail-watcher.ts`:

```typescript
  // Add to the private fields section:
  private historyWatermark: string | null = null;

  // Add public methods:

  /** Set the history watermark (for testing and Pub/Sub replay protection). */
  setHistoryWatermark(historyId: string): void {
    this.historyWatermark = historyId;
  }

  /**
   * Fetch messages added since startHistoryId using Gmail history API.
   * Returns the number of new messages processed.
   * Rejects if historyId is behind the watermark (replay protection).
   */
  async fetchNewMessagesByHistory(startHistoryId: string): Promise<number> {
    if (!this.auth) return 0;

    // Replay protection: reject if historyId is behind watermark
    if (
      this.historyWatermark &&
      BigInt(startHistoryId) < BigInt(this.historyWatermark)
    ) {
      logger.warn(
        {
          account: this.config.account,
          startHistoryId,
          watermark: this.historyWatermark,
        },
        'GmailWatcher rejected stale historyId (replay protection)',
      );
      return 0;
    }

    const gmail = google.gmail({ version: 'v1', auth: this.auth });
    this.lastCheck = new Date().toISOString();

    try {
      const histRes = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
      });

      const histories = histRes.data.history ?? [];
      let newCount = 0;
      const processedSet = new Set(this.state.processedIds);

      for (const entry of histories) {
        for (const added of entry.messagesAdded ?? []) {
          const msgId = added.message?.id;
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
              'GmailWatcher failed to fetch/route message via history — skipping',
            );
          }
        }
      }

      // Update watermark
      if (histRes.data.historyId) {
        this.historyWatermark = histRes.data.historyId;
      }

      // Persist processed IDs
      const MAX_PROCESSED = 2000;
      const allIds = Array.from(processedSet);
      this.state.processedIds = allIds.slice(
        Math.max(0, allIds.length - MAX_PROCESSED),
      );
      if (histRes.data.historyId) {
        this.state.lastHistoryId = histRes.data.historyId;
      }
      this.saveState();

      this.authFailureCount = 0;
      return newCount;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher history fetch failed',
      );

      // If historyId is invalid/expired, fall through to a full poll
      if (message.includes('notFound') || message.includes('invalid')) {
        logger.info(
          { account: this.config.account },
          'History ID expired — falling back to full poll',
        );
        await this.poll();
      }
      return 0;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/watchers/gmail-watcher.test.ts --reporter verbose`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

Stage: `src/watchers/gmail-watcher.ts src/watchers/gmail-watcher.test.ts`
Message: `feat(gmail): add history-based message fetching with replay protection`

### Task A3: Add Pub/Sub push mode status tracking

**Files:**
- Modify: `src/watchers/gmail-watcher.ts` — add push mode flag and status
- Test: `src/watchers/gmail-watcher.test.ts` — test mode switching

- [ ] **Step 1: Write the failing test**

Add to `src/watchers/gmail-watcher.test.ts`:

```typescript
describe('push mode status', () => {
  it('reports polling mode by default', () => {
    const tmpDir = makeTempDir();
    const credsPath = makeCredentials(tmpDir);
    const router = makeEventRouter();

    const watcher = new GmailWatcher({
      credentialsPath: credsPath,
      account: 'test@gmail.com',
      eventRouter: router,
      pollIntervalMs: 60000,
      stateDir: tmpDir,
    });

    expect(watcher.getStatus().mode).toBe('polling');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports push mode when active', () => {
    const tmpDir = makeTempDir();
    const credsPath = makeCredentials(tmpDir);
    const router = makeEventRouter();

    const watcher = new GmailWatcher({
      credentialsPath: credsPath,
      account: 'test@gmail.com',
      eventRouter: router,
      pollIntervalMs: 60000,
      stateDir: tmpDir,
    });

    watcher.setPushModeActive(true);
    expect(watcher.getStatus().mode).toBe('push');

    watcher.setPushModeActive(false);
    expect(watcher.getStatus().mode).toBe('polling');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/watchers/gmail-watcher.test.ts --reporter verbose -t "push mode"`
Expected: FAIL — `setPushModeActive` doesn't exist.

- [ ] **Step 3: Implement push mode tracking**

Add to `GmailWatcher` class:

```typescript
  // Add to private fields:
  private pushModeActive = false;

  // Add public method:
  setPushModeActive(active: boolean): void {
    this.pushModeActive = active;
  }

  // Replace getStatus():
  getStatus(): GmailWatcherStatus {
    return {
      mode: this.pushModeActive ? 'push' : 'polling',
      account: this.config.account,
      lastCheck: this.lastCheck,
      messagesProcessed: this.messagesProcessed,
    };
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test src/watchers/gmail-watcher.test.ts --reporter verbose`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage: `src/watchers/gmail-watcher.ts src/watchers/gmail-watcher.test.ts`
Message: `feat(gmail): add push mode status tracking`

### Task A4: Wire Pub/Sub listener into GmailWatcher.start()

**Files:**
- Modify: `src/watchers/gmail-watcher.ts` — add Pub/Sub start/stop logic, gmail.users.watch() registration
- Modify: `src/index.ts` — pass Pub/Sub env vars to GmailWatcher config

This is the integration step. Pub/Sub connection requires a real GCP project, so unit test coverage comes from Tasks A2 and A3. This task wires it up.

- [ ] **Step 1: Add Pub/Sub lifecycle methods to GmailWatcher**

Add to `GmailWatcher` class in `src/watchers/gmail-watcher.ts`:

```typescript
  // Add private fields:
  private pubsubSubscriptionHandle: { close: () => void } | null = null;

  /**
   * Start Pub/Sub push mode. Returns true if started successfully.
   */
  private async startPushMode(): Promise<boolean> {
    const { pubsubTopic, pubsubSubscription, pubsubServiceAccountPath } =
      this.config;
    if (!pubsubTopic || !pubsubSubscription) return false;

    try {
      const { PubSub } = await import('@google-cloud/pubsub');
      const pubsub = pubsubServiceAccountPath
        ? new PubSub({ keyFilename: pubsubServiceAccountPath })
        : new PubSub();

      // Register Gmail watch (refreshed every 6 days — watches expire after 7)
      await this.registerGmailWatch();

      // Subscribe to Pub/Sub notifications
      const subscription = pubsub.subscription(pubsubSubscription);
      this.pubsubSubscriptionHandle = subscription;

      subscription.on('message', (message: { data: Buffer; ack: () => void }) => {
        try {
          const data = JSON.parse(message.data.toString());
          const historyId = data.historyId as string | undefined;
          message.ack();

          if (historyId) {
            void this.fetchNewMessagesByHistory(historyId).catch((err) => {
              logger.warn(
                { err, account: this.config.account },
                'GmailWatcher push handler failed',
              );
            });
          }
        } catch (err) {
          message.ack(); // Ack to prevent re-delivery of malformed messages
          logger.warn({ err }, 'GmailWatcher failed to parse Pub/Sub message');
        }
      });

      subscription.on('error', (err: Error) => {
        logger.error(
          { err, account: this.config.account },
          'GmailWatcher Pub/Sub error — falling back to polling',
        );
        this.stopPushMode();
        this.scheduleNext();
      });

      this.setPushModeActive(true);
      logger.info(
        { account: this.config.account, topic: pubsubTopic },
        'GmailWatcher started in push mode',
      );
      return true;
    } catch (err) {
      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher failed to start push mode — falling back to polling',
      );
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
    logger.info(
      { account: this.config.account, expiration: res.data.expiration },
      'Gmail watch registered',
    );

    // Re-register every 6 days (watches expire after 7)
    setTimeout(
      () => void this.registerGmailWatch(),
      6 * 24 * 60 * 60 * 1000,
    );
  }
```

- [ ] **Step 2: Update start() to try push mode first**

Replace the existing `start()` method body:

```typescript
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
```

- [ ] **Step 3: Update stop() to handle push mode**

Replace the existing `stop()` method:

```typescript
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopPushMode();
    logger.info({ account: this.config.account }, 'GmailWatcher stopped');
  }
```

- [ ] **Step 4: Pass Pub/Sub config from index.ts**

Find where `GmailWatcher` is constructed in `src/index.ts` and add the optional pubsub fields from environment variables:

```typescript
// Add to the GmailWatcher config object:
pubsubTopic: process.env.GMAIL_PUBSUB_TOPIC,
pubsubSubscription: process.env.GMAIL_PUBSUB_SUBSCRIPTION,
pubsubServiceAccountPath: process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT_PATH,
```

- [ ] **Step 5: Run all tests**

Run: `bun test src/watchers/gmail-watcher.test.ts --reporter verbose`
Expected: all tests PASS (push mode is optional — existing polling tests unchanged).

- [ ] **Step 6: Run build to verify no type errors**

Run: `bun run build`
Expected: clean build.

- [ ] **Step 7: Commit**

Stage: `src/watchers/gmail-watcher.ts src/index.ts`
Message: `feat(gmail): wire Pub/Sub push mode with polling fallback`

---

## Feature B: Shared Intelligence Layer

### Task B1: Create knowledge publishing module

**Files:**
- Create: `src/knowledge.ts` — knowledge file writing with sourceGroup validation
- Test: `src/knowledge.test.ts` — test publishing and identity validation

- [ ] **Step 1: Write the failing test**

Create `src/knowledge.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { publishKnowledge, type KnowledgeEntry } from './knowledge.js';

describe('publishKnowledge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a markdown file with correct YAML frontmatter', () => {
    const entry: KnowledgeEntry = {
      topic: 'APA regulation',
      finding: 'ChromBERT can predict TF binding at APA sites',
      evidence: 'Paper DOI 10.1234/test',
      tags: ['GWAS', 'APA'],
    };

    const filePath = publishKnowledge(entry, 'telegram_science-claw', tmpDir);

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');

    // Agent field must come from sourceGroup, not from entry
    expect(content).toContain('agent: telegram_science-claw');
    expect(content).toContain('topic: APA regulation');
    expect(content).toContain('tags:');
    expect(content).toContain('- GWAS');
    expect(content).toContain('ChromBERT can predict TF binding');
  });

  it('overwrites agent field from sourceGroup — ignores payload agent', () => {
    const entry: KnowledgeEntry = {
      topic: 'test',
      finding: 'test finding',
      evidence: 'none',
      tags: [],
      agent: 'claire', // Attacker tries to forge identity
    };

    const filePath = publishKnowledge(entry, 'telegram_science-claw', tmpDir);
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain('agent: telegram_science-claw');
    expect(content).not.toContain('agent: claire');
  });

  it('generates unique filenames for concurrent writes', () => {
    const entry: KnowledgeEntry = {
      topic: 'test',
      finding: 'finding 1',
      evidence: 'none',
      tags: [],
    };

    const path1 = publishKnowledge(entry, 'group-a', tmpDir);
    const path2 = publishKnowledge(
      { ...entry, finding: 'finding 2' },
      'group-b',
      tmpDir,
    );

    expect(path1).not.toBe(path2);
    expect(fs.existsSync(path1)).toBe(true);
    expect(fs.existsSync(path2)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/knowledge.test.ts --reporter verbose`
Expected: FAIL — module `./knowledge.js` not found.

- [ ] **Step 3: Implement knowledge.ts**

Create `src/knowledge.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface KnowledgeEntry {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
  /** Ignored — overwritten by verified sourceGroup. */
  agent?: string;
}

/**
 * Write a knowledge entry as a markdown file with YAML frontmatter.
 * The agent field is ALWAYS set from sourceGroup, never from the entry payload.
 * This prevents cross-agent knowledge poisoning.
 *
 * Returns the absolute path of the written file.
 */
export function publishKnowledge(
  entry: KnowledgeEntry,
  sourceGroup: string,
  knowledgeDir: string,
): string {
  fs.mkdirSync(knowledgeDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const id = crypto.randomUUID().slice(0, 8);
  const slug = entry.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  const fileName = `${date}-${slug}-${id}.md`;
  const filePath = path.join(knowledgeDir, fileName);

  const tagsYaml =
    entry.tags.length > 0
      ? `tags:\n${entry.tags.map((t) => `  - ${t}`).join('\n')}`
      : 'tags: []';

  const content = `---
agent: ${sourceGroup}
topic: ${entry.topic}
date: ${date}
${tagsYaml}
---

${entry.finding}

**Evidence:** ${entry.evidence}
`;

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/knowledge.test.ts --reporter verbose`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

Stage: `src/knowledge.ts src/knowledge.test.ts`
Message: `feat(knowledge): add publishKnowledge with sourceGroup validation`

### Task B2: Wire knowledge_publish into IPC handler

**Files:**
- Modify: `src/ipc.ts` — add `knowledge_publish` case to `processTaskIpc`
- Test: `src/ipc.test.ts` — test the new IPC action

- [ ] **Step 1: Write the failing test**

Add to `src/ipc.test.ts`. First, add the mock at the top level:

```typescript
// Add import:
import { publishKnowledge } from './knowledge.js';

// Add mock (alongside existing mocks):
vi.mock('./knowledge.js', () => ({
  publishKnowledge: vi.fn().mockReturnValue('/tmp/fake-knowledge-file.md'),
}));
```

Then add the test case inside the `processTaskIpc` describe block:

```typescript
it('knowledge_publish writes file and stamps sourceGroup', async () => {
  await processTaskIpc(
    {
      type: 'knowledge_publish',
      topic: 'test topic',
      finding: 'test finding',
      evidence: 'test evidence',
      tags: ['tag1', 'tag2'],
      agent: 'forged-identity', // should be overwritten
    } as any,
    'telegram_science-claw', // verified sourceGroup
    false, // isMain
    deps,
  );

  expect(publishKnowledge).toHaveBeenCalledWith(
    expect.objectContaining({
      topic: 'test topic',
      finding: 'test finding',
    }),
    'telegram_science-claw', // sourceGroup must be passed, not forged identity
    expect.stringContaining('agent-knowledge'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ipc.test.ts --reporter verbose -t "knowledge_publish"`
Expected: FAIL — no `knowledge_publish` case in processTaskIpc.

- [ ] **Step 3: Add knowledge_publish case to processTaskIpc**

In `src/ipc.ts`, add to the `switch (data.type)` block inside `processTaskIpc`:

```typescript
    case 'knowledge_publish': {
      const { publishKnowledge } = await import('./knowledge.js');
      const knowledgeDir = path.join(DATA_DIR, 'agent-knowledge');
      const entry = {
        topic: (data as any).topic || 'unknown',
        finding: (data as any).finding || '',
        evidence: (data as any).evidence || '',
        tags: (data as any).tags || [],
      };
      const filePath = publishKnowledge(entry, sourceGroup, knowledgeDir);
      logger.info(
        { sourceGroup, topic: entry.topic, filePath },
        'Knowledge entry published',
      );

      // Publish notification to message bus if available
      if (deps.messageBus) {
        deps.messageBus.publish({
          from: sourceGroup,
          topic: `knowledge:${entry.topic}`,
          summary: entry.finding.slice(0, 200),
          action_needed: '',
          priority: 'low',
        });
      }
      break;
    }
```

- [ ] **Step 4: Run the test**

Run: `bun test src/ipc.test.ts --reporter verbose -t "knowledge_publish"`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `bun test --reporter verbose`
Expected: all tests pass.

- [ ] **Step 6: Commit**

Stage: `src/ipc.ts src/ipc.test.ts`
Message: `feat(knowledge): wire knowledge_publish IPC handler with bus notification`

### Task B3: Add knowledge MCP tools to agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts` — add knowledge_publish and knowledge_search tool definitions

- [ ] **Step 1: Find the MCP tool definitions section**

In `container/agent-runner/src/index.ts`, find the existing tool definitions (search for `bus_publish` or `send_message`). The knowledge tools follow the same pattern.

- [ ] **Step 2: Add knowledge_publish tool definition**

Add alongside existing tool definitions:

```typescript
{
  name: 'knowledge_publish',
  description:
    'Publish a structured finding to the shared knowledge base. ' +
    'Use when you discover something other agents should know about. ' +
    'Findings are searchable by all agents across all groups.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Topic category (e.g., "APA regulation", "lab scheduling")',
      },
      finding: {
        type: 'string',
        description: 'The finding — clear, specific, actionable',
      },
      evidence: {
        type: 'string',
        description: 'Source (DOI, URL, conversation reference)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for discoverability',
      },
    },
    required: ['topic', 'finding', 'evidence', 'tags'],
  },
},
```

- [ ] **Step 3: Add knowledge_publish handler**

In the tool execution switch statement:

```typescript
case 'knowledge_publish': {
  const ipcDir = '/workspace/ipc/tasks';
  fs.mkdirSync(ipcDir, { recursive: true });
  const taskFile = path.join(ipcDir, `knowledge-${Date.now()}.json`);
  fs.writeFileSync(
    taskFile,
    JSON.stringify({
      type: 'knowledge_publish',
      topic: args.topic,
      finding: args.finding,
      evidence: args.evidence,
      tags: args.tags,
    }),
  );
  return { content: [{ type: 'text', text: `Published knowledge: "${args.topic}"` }] };
}
```

- [ ] **Step 4: Add knowledge_search tool**

```typescript
{
  name: 'knowledge_search',
  description:
    'Search the shared knowledge base for findings published by any agent.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (semantic)' },
      from_agent: { type: 'string', description: 'Filter by publishing agent (optional)' },
      topic: { type: 'string', description: 'Filter by topic (optional)' },
    },
    required: ['query'],
  },
},
```

Handler (delegates to QMD which is already available):

```typescript
case 'knowledge_search': {
  return {
    content: [{
      type: 'text',
      text: `To search shared knowledge, use the qmd tool with collection "agent-knowledge" and query: "${args.query}". ` +
        (args.from_agent ? `Filter by agent: ${args.from_agent}. ` : '') +
        (args.topic ? `Filter by topic: ${args.topic}.` : ''),
    }],
  };
}
```

- [ ] **Step 5: Build container**

Run: `cd container && bun run build && cd ..`
Expected: clean build.

- [ ] **Step 6: Commit**

Stage: `container/agent-runner/src/index.ts`
Message: `feat(knowledge): add knowledge_publish and knowledge_search MCP tools`

### Task B4: Set up QMD collection and knowledge directory

**Files:**
- Create: `data/agent-knowledge/.gitkeep`

- [ ] **Step 1: Create directory**

Run: `mkdir -p data/agent-knowledge && touch data/agent-knowledge/.gitkeep`

- [ ] **Step 2: Add QMD collection**

Run: `qmd add agent-knowledge data/agent-knowledge --ext md && qmd embed agent-knowledge`

- [ ] **Step 3: Verify**

Run: `qmd status`
Expected: `agent-knowledge` listed with 0 documents.

- [ ] **Step 4: Commit**

Stage: `data/agent-knowledge/.gitkeep`
Message: `feat(knowledge): add agent-knowledge directory and QMD collection`

---

## Feature C: Pattern Engine + Outcome Tracking

### Task C1: Add action_log and pattern_proposals tables

**Files:**
- Modify: `src/db.ts` — add tables
- Test: `src/db.test.ts` — test CRUD

- [ ] **Step 1: Write the failing test**

Add to `src/db.test.ts`:

```typescript
describe('action_log table', () => {
  it('inserts and queries action log entries', () => {
    const db = getDb();
    db.exec(`
      INSERT INTO action_log (id, agent, group_folder, tool_name, params_hash, context_category, timestamp)
      VALUES ('test-1', 'einstein', 'telegram_science-claw', 'qmd_query', 'abc123', 'research', '2026-04-13T10:00:00Z')
    `);

    const rows = db
      .prepare('SELECT * FROM action_log WHERE agent = ?')
      .all('einstein');
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).tool_name).toBe('qmd_query');
    expect((rows[0] as any).params_hash).toBe('abc123');
  });
});

describe('pattern_proposals table', () => {
  it('inserts and queries proposals', () => {
    const db = getDb();
    db.exec(`
      INSERT INTO pattern_proposals (id, description, proposed_at, status, proposal_count_date, proposal_count)
      VALUES ('prop-1', 'Weekly lab summary', '2026-04-13', 'pending', '2026-04-13', 1)
    `);

    const rows = db
      .prepare('SELECT * FROM pattern_proposals WHERE status = ?')
      .all('pending');
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).description).toBe('Weekly lab summary');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/db.test.ts --reporter verbose -t "action_log"`
Expected: FAIL — table doesn't exist.

- [ ] **Step 3: Add tables to createSchema**

In `src/db.ts`, add inside the `createSchema` function's `database.exec()` template literal, after the existing `agent_actions` table:

```sql
    CREATE TABLE IF NOT EXISTS action_log (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      context_category TEXT DEFAULT '',
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_log_agent ON action_log(agent, tool_name);
    CREATE INDEX IF NOT EXISTS idx_action_log_time ON action_log(timestamp);

    CREATE TABLE IF NOT EXISTS pattern_proposals (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      proposed_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
      proposal_count_date TEXT,
      proposal_count INTEGER DEFAULT 0
    );
```

- [ ] **Step 4: Run tests**

Run: `bun test src/db.test.ts --reporter verbose -t "action_log"`
Run: `bun test src/db.test.ts --reporter verbose -t "pattern_proposals"`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage: `src/db.ts src/db.test.ts`
Message: `feat(pattern): add action_log and pattern_proposals tables`

### Task C2: Implement pattern detection logic

**Files:**
- Create: `src/pattern-engine.ts` — detection queries and proposal formatting
- Test: `src/pattern-engine.test.ts` — test detection algorithms

- [ ] **Step 1: Write the failing test**

Create `src/pattern-engine.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  detectRepeatedTools,
  detectTimePatterns,
  canProposeToday,
  type ActionLogRow,
} from './pattern-engine.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('detectRepeatedTools', () => {
  it('finds tools called 3+ times with same params hash', () => {
    const rows: ActionLogRow[] = [
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-10T10:00:00Z' },
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-11T10:00:00Z' },
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-12T10:00:00Z' },
      { tool_name: 'send_message', params_hash: 'xyz', timestamp: '2026-04-10T10:00:00Z' },
    ];

    const patterns = detectRepeatedTools(rows, 3);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].tool).toBe('qmd_query');
    expect(patterns[0].count).toBe(3);
  });

  it('ignores tools below threshold', () => {
    const rows: ActionLogRow[] = [
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-10T10:00:00Z' },
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-11T10:00:00Z' },
    ];

    const patterns = detectRepeatedTools(rows, 3);
    expect(patterns).toHaveLength(0);
  });
});

describe('detectTimePatterns', () => {
  it('detects actions on the same day of week', () => {
    // 2026-04-06, 2026-04-13, 2026-04-20 are Mondays
    const rows: ActionLogRow[] = [
      { tool_name: 'send_message', params_hash: 'weekly', timestamp: '2026-04-06T09:00:00Z' },
      { tool_name: 'send_message', params_hash: 'weekly', timestamp: '2026-04-13T09:00:00Z' },
      { tool_name: 'send_message', params_hash: 'weekly', timestamp: '2026-04-20T09:00:00Z' },
    ];

    const patterns = detectTimePatterns(rows, 3);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].dayOfWeek).toBe(1); // Monday = 1
  });
});

describe('canProposeToday', () => {
  it('returns true when no proposals made today', () => {
    expect(canProposeToday([], '2026-04-13')).toBe(true);
  });

  it('returns false when 2 proposals already made today', () => {
    const proposals = [
      { proposed_at: '2026-04-13', status: 'pending' },
      { proposed_at: '2026-04-13', status: 'approved' },
    ];
    expect(canProposeToday(proposals as any[], '2026-04-13')).toBe(false);
  });

  it('ignores proposals from other days', () => {
    const proposals = [
      { proposed_at: '2026-04-12', status: 'pending' },
      { proposed_at: '2026-04-12', status: 'approved' },
    ];
    expect(canProposeToday(proposals as any[], '2026-04-13')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/pattern-engine.test.ts --reporter verbose`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement pattern-engine.ts**

Create `src/pattern-engine.ts`:

```typescript
import { logger } from './logger.js';

export interface ActionLogRow {
  tool_name: string;
  params_hash: string;
  timestamp: string;
}

export interface RepeatedToolPattern {
  tool: string;
  paramsHash: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface TimePattern {
  tool: string;
  paramsHash: string;
  dayOfWeek: number; // 0=Sun ... 6=Sat
  count: number;
}

export interface PatternProposal {
  proposed_at: string;
  status: string;
}

const MAX_PROPOSALS_PER_DAY = 2;

/**
 * Detect tools called N+ times with the same params hash.
 */
export function detectRepeatedTools(
  rows: ActionLogRow[],
  threshold: number,
): RepeatedToolPattern[] {
  const counts = new Map<
    string,
    { count: number; firstSeen: string; lastSeen: string }
  >();

  for (const row of rows) {
    const key = `${row.tool_name}:${row.params_hash}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
      if (row.timestamp < existing.firstSeen) existing.firstSeen = row.timestamp;
      if (row.timestamp > existing.lastSeen) existing.lastSeen = row.timestamp;
    } else {
      counts.set(key, {
        count: 1,
        firstSeen: row.timestamp,
        lastSeen: row.timestamp,
      });
    }
  }

  const patterns: RepeatedToolPattern[] = [];
  for (const [key, data] of counts) {
    if (data.count >= threshold) {
      const [tool, ...hashParts] = key.split(':');
      patterns.push({
        tool,
        paramsHash: hashParts.join(':'),
        count: data.count,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
      });
    }
  }

  return patterns.sort((a, b) => b.count - a.count);
}

/**
 * Detect actions that occur on the same day of the week.
 */
export function detectTimePatterns(
  rows: ActionLogRow[],
  threshold: number,
): TimePattern[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const day = new Date(row.timestamp).getUTCDay();
    const key = `${row.tool_name}:${row.params_hash}:${day}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const patterns: TimePattern[] = [];
  for (const [key, count] of counts) {
    if (count >= threshold) {
      const parts = key.split(':');
      const dayOfWeek = parseInt(parts.pop()!, 10);
      const paramsHash = parts.pop()!;
      const tool = parts.join(':');
      patterns.push({ tool, paramsHash, dayOfWeek, count });
    }
  }

  return patterns.sort((a, b) => b.count - a.count);
}

/**
 * Check if we can make more proposals today (max 2 per calendar day).
 */
export function canProposeToday(
  proposals: PatternProposal[],
  today: string,
): boolean {
  const todayCount = proposals.filter((p) => p.proposed_at === today).length;
  return todayCount < MAX_PROPOSALS_PER_DAY;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/pattern-engine.test.ts --reporter verbose`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

Stage: `src/pattern-engine.ts src/pattern-engine.test.ts`
Message: `feat(pattern): add pattern detection with repeated-tool and time-pattern algorithms`

### Task C3: Add tool-call emission to agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts` — track and emit tool calls to IPC output

- [ ] **Step 1: Add tool-call tracking array**

Near the top of `container/agent-runner/src/index.ts`, after imports:

```typescript
import crypto from 'crypto';

interface ToolCallRecord {
  tool: string;
  paramsHash: string;
  timestamp: string;
}

const sessionToolCalls: ToolCallRecord[] = [];

function hashToolParams(params: unknown): string {
  const sorted = JSON.stringify(params, Object.keys((params ?? {}) as Record<string, unknown>).sort());
  return crypto.createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}
```

- [ ] **Step 2: Capture tool calls in the message loop**

Find the section in `runQuery` that processes SDK messages. Where tool_use content blocks are encountered (look for content block processing), add:

```typescript
// When a tool_use content block is processed:
sessionToolCalls.push({
  tool: content.name,
  paramsHash: hashToolParams(content.input),
  timestamp: new Date().toISOString(),
});
```

The exact insertion point depends on how the SDK exposes tool use events in the message stream — read the existing `runQuery` function to find where content blocks with `type === 'tool_use'` are handled.

- [ ] **Step 3: Write tool-call summary at session end**

Find the final `writeOutput({ status: 'success' ... })` call in the main function. Add BEFORE it:

```typescript
// Emit tool-call summary for host-side pattern engine
if (sessionToolCalls.length > 0) {
  const outputDir = '/workspace/ipc/output';
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'tool-calls.json'),
    JSON.stringify(sessionToolCalls),
    'utf-8',
  );
}
```

- [ ] **Step 4: Build container**

Run: `cd container && bun run build && cd ..`
Expected: clean build.

- [ ] **Step 5: Commit**

Stage: `container/agent-runner/src/index.ts`
Message: `feat(pattern): emit tool-call summary to IPC output after session`

### Task C4: Collect tool-call summaries on the host

**Files:**
- Modify: `src/container-runner.ts` — read tool-calls.json, insert into action_log
- Test: `src/container-runner.test.ts` — test collection

- [ ] **Step 1: Write the failing test**

Add to `src/container-runner.test.ts`:

```typescript
import { collectToolCalls } from './container-runner.js';

describe('collectToolCalls', () => {
  it('reads tool-calls.json and returns parsed records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcall-test-'));
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
      path.join(outputDir, 'tool-calls.json'),
      JSON.stringify([
        { tool: 'qmd_query', paramsHash: 'abc123', timestamp: '2026-04-13T10:00:00Z' },
        { tool: 'send_message', paramsHash: 'def456', timestamp: '2026-04-13T10:01:00Z' },
      ]),
    );

    const records = collectToolCalls(outputDir);
    expect(records).toHaveLength(2);
    expect(records[0].tool).toBe('qmd_query');
    expect(records[1].paramsHash).toBe('def456');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no tool-calls.json exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcall-test-'));
    const records = collectToolCalls(path.join(tmpDir, 'nonexistent'));
    expect(records).toHaveLength(0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/container-runner.test.ts --reporter verbose -t "collectToolCalls"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement collectToolCalls**

Add to `src/container-runner.ts`:

```typescript
export interface ToolCallRecord {
  tool: string;
  paramsHash: string;
  timestamp: string;
}

/**
 * Read tool-call summary from container IPC output.
 * Cleans up the file after reading.
 */
export function collectToolCalls(ipcOutputDir: string): ToolCallRecord[] {
  const filePath = path.join(ipcOutputDir, 'tool-calls.json');
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const records = JSON.parse(raw) as ToolCallRecord[];
    fs.unlinkSync(filePath);
    return records;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Wire into container completion path**

Find where the container result is collected after the process exits. Add after output parsing:

```typescript
// Collect tool calls and insert into action_log
const toolCalls = collectToolCalls(path.join(ipcDir, 'output'));
if (toolCalls.length > 0) {
  const { getDb } = await import('./db.js');
  const db = getDb();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO action_log (id, agent, group_folder, tool_name, params_hash, context_category, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const tc of toolCalls) {
    insert.run(
      `${groupFolder}-${tc.timestamp}-${tc.paramsHash.slice(0, 8)}`,
      groupFolder,
      groupFolder,
      tc.tool,
      tc.paramsHash,
      '',
      tc.timestamp,
    );
  }
}
```

- [ ] **Step 5: Run tests**

Run: `bun test src/container-runner.test.ts --reporter verbose -t "collectToolCalls"`
Expected: PASS.

- [ ] **Step 6: Commit**

Stage: `src/container-runner.ts src/container-runner.test.ts`
Message: `feat(pattern): collect tool-call summaries into action_log`

---

## Post-Implementation Checklist

- [ ] All tests pass: `bun test --reporter verbose`
- [ ] Build succeeds: `bun run build`
- [ ] Gmail Push: verify with `GMAIL_PUBSUB_TOPIC` unset → falls back to polling (no regression)
- [ ] Gmail Push: if GCP is set up, verify push notifications work
- [ ] Shared Intelligence: write a test knowledge file to `data/agent-knowledge/`, verify QMD indexes it
- [ ] Pattern Engine: verify `action_log` table exists after restart
- [ ] Ship Telegram slash commands ad hoc (~10 lines in `src/channels/telegram.ts`)
