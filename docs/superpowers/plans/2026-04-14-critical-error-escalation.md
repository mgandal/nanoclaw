# Critical Error Escalation — Implementation Plan

> **Status: SHIPPED 2026-04-14.** All 8 tasks landed. Container OOM detection: `ContainerOutput` carries `exitCode`/`timedOut`; `src/index.ts:766-768` triggers `sendSystemAlert('Container OOM',...)` on `exitCode === 137 && !timedOut`. Alert fallback chain at `src/index.ts:976-1081`: `isSendingAlert` re-entrancy guard → OPS-claw → Telegram main DM → Slack DM → `appendAlertToFile`. `ESCALATION_SLACK_JID` constant in `src/config.ts:194` (default `slack:D0AQ09RSF1B`). Supergroup migration: `src/db.ts:1220 migrateGroupJid`; `src/channels/telegram.ts:167` calls `opts.onMigrate`; `src/channels/registry.ts:13-14` declares `onMigrate`/`onSendFailure` on `ChannelOpts`; `src/index.ts:1759-1779` wires both (calls `migrateGroupJid` + updates in-memory state + sends alert). Send-failure escalation: `src/send-failure-tracker.ts` + `.test.ts` exist; `src/channels/telegram.ts:945-956` routes structural vs. transient errors via `classifySendError`/`trackTransientFailure`. All tests pass. Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make critical errors (supergroup migrations, message delivery failures, container OOM) escalate to the user instead of silently logging.

**Architecture:** Four independent changes: (1) alert fallback chain in `sendSystemAlert`, (2) supergroup auto-migration in Telegram channel, (3) tiered send failure escalation, (4) container OOM alerting via `ContainerOutput.exitCode`. Each can be implemented and committed independently.

**Tech Stack:** TypeScript (Bun), vitest, Grammy (Telegram Bot API)

**Spec:** `docs/superpowers/specs/2026-04-13-critical-error-escalation-design.md` (v2, peer-reviewed)

---

## File Structure

### New files
- `src/send-failure-tracker.ts` — error classifier + per-group + global failure tracking
- `src/send-failure-tracker.test.ts` — tests for failure tracking

### Modified files
- `src/index.ts` — `sendSystemAlert` fallback chain, OOM check after container run
- `src/config.ts` — `ESCALATION_SLACK_JID` constant
- `src/channels/telegram.ts` — migration detection, failure escalation callbacks, `TelegramChannelOpts`
- `src/channels/registry.ts` — `onMigrate` and `onSendFailure` on `ChannelOpts`
- `src/container-runner.ts` — `exitCode` and `timedOut` on `ContainerOutput`
- `src/db.ts` — `migrateGroupJid()` function

---

## Task 1: Add `exitCode` and `timedOut` to ContainerOutput

**Files:**
- Modify: `src/container-runner.ts:80-85` — update interface
- Modify: `src/container-runner.ts:895-913` — set exitCode in legacy exit handler
- Modify: `src/container-runner.ts:764-810` — set exitCode/timedOut in timeout+streaming paths

- [ ] **Step 1: Update ContainerOutput interface**

In `src/container-runner.ts`, change the interface at line 80:

```typescript
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  exitCode?: number;
  timedOut?: boolean;
}
```

- [ ] **Step 2: Set exitCode in the legacy (non-streaming) error path**

In `src/container-runner.ts` at line 908, change:

```typescript
        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
```

To:

```typescript
        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
          exitCode: code ?? undefined,
        });
```

- [ ] **Step 3: Set timedOut in timeout paths**

In `src/container-runner.ts`, in the `container.on('close')` handler (line 764), the `timedOut` flag is already a local variable. Add it to all resolve calls within the `if (timedOut)` block.

At line 794 (timeout after output, success):
```typescript
              resolve({
                status: 'success',
                result: null,
                newSessionId,
                timedOut: true,
              });
```

At line 805 (timeout after output, chain error):
```typescript
              resolve({
                status: 'error',
                result: null,
                error: `Output chain error: ...`,
                timedOut: true,
              });
```

Find the timeout-without-output resolve (around line 815-830) and add `timedOut: true` there as well.

- [ ] **Step 4: Set exitCode in streaming success path**

In the streaming mode success resolve (around line 930-940 in the `outputChain.then`), add `exitCode: code ?? undefined`:

```typescript
            resolve({
              status: 'success',
              result: null,
              newSessionId,
              exitCode: code ?? undefined,
            });
```

- [ ] **Step 5: Build and verify**

Run: `bun run build 2>&1 | grep "container-runner.ts" | grep error`
Expected: no new errors.

- [ ] **Step 6: Commit**

Stage: `src/container-runner.ts`
Message: `feat: add exitCode and timedOut to ContainerOutput`

---

## Task 2: OOM alert in index.ts

**Files:**
- Modify: `src/index.ts:597-624` — add OOM check after container run

- [ ] **Step 1: Add OOM check after runContainerAgent**

In `src/index.ts`, after the existing `output.status === 'error'` block (after line 621), add before the `return 'success'` at line 624:

```typescript
    // Immediate alert on OOM (exit 137 not from timeout)
    if (output.exitCode === 137 && !output.timedOut) {
      void sendSystemAlert(
        'Container OOM',
        `${group.name} killed (exit 137). Task too large for container memory.`,
      );
    }
```

- [ ] **Step 2: Build and verify**

Run: `bun run build 2>&1 | grep "src/index.ts" | grep error`
Expected: no errors.

- [ ] **Step 3: Commit**

Stage: `src/index.ts`
Message: `feat: immediate OOM alert on container exit 137 (non-timeout)`

---

## Task 3: sendSystemAlert fallback chain

**Files:**
- Modify: `src/config.ts:152` — add `ESCALATION_SLACK_JID`
- Modify: `src/index.ts:822-845` — rewrite `sendSystemAlert`

- [ ] **Step 1: Add escalation config**

In `src/config.ts`, after the `OPS_ALERT_FOLDER` export (line 152), add:

```typescript
export const ESCALATION_SLACK_JID =
  process.env.ESCALATION_SLACK_JID || 'slack:D0AQ09RSF1B';
```

- [ ] **Step 2: Rewrite sendSystemAlert with fallback chain**

Replace the entire function at `src/index.ts:822-845`:

```typescript
let isSendingAlert = false;

/** Send an alert with fallback chain: OPS-claw -> CLAIRE TG DM -> CLAIRE Slack DM -> file. */
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

  const text = fixInstructions
    ? `⚠️ *${service}*: ${message}\n\n_Fix:_ ${fixInstructions}`
    : `⚠️ *${service}*: ${message}`;

  // Re-entrancy guard: if we're already in the fallback chain, go straight to file
  if (isSendingAlert) {
    appendAlertToFile(text);
    return;
  }

  isSendingAlert = true;
  try {
    // 1. Try OPS-claw
    const opsJid = Object.keys(registeredGroups).find(
      (j) => registeredGroups[j]?.folder === OPS_ALERT_FOLDER,
    );
    if (opsJid) {
      const opsCh = findChannel(channels, opsJid);
      if (opsCh) {
        try {
          await opsCh.sendMessage(opsJid, text);
          return;
        } catch {
          // fall through
        }
      }
    }

    // 2. Try CLAIRE Telegram DM (first isMain tg: group)
    const tgMainJid = Object.keys(registeredGroups).find(
      (j) => j.startsWith('tg:') && registeredGroups[j]?.isMain,
    );
    if (tgMainJid) {
      const tgCh = findChannel(channels, tgMainJid);
      if (tgCh) {
        try {
          await tgCh.sendMessage(tgMainJid, text);
          return;
        } catch {
          // fall through
        }
      }
    }

    // 3. Try CLAIRE Slack DM
    const slackJid = ESCALATION_SLACK_JID;
    const slackCh = findChannel(channels, slackJid);
    if (slackCh) {
      try {
        await slackCh.sendMessage(slackJid, text);
        return;
      } catch {
        // fall through
      }
    }

    // 4. File fallback (always available, even during startup)
    appendAlertToFile(text);
  } finally {
    isSendingAlert = false;
  }
}

function appendAlertToFile(text: string): void {
  const logPath = path.join(STORE_DIR, 'critical-alerts.log');
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${text}\n`);
  logger.warn({ logPath }, 'Alert written to file fallback (all channels failed)');
}
```

- [ ] **Step 3: Add ESCALATION_SLACK_JID import**

In `src/index.ts`, add `ESCALATION_SLACK_JID` to the config imports (around line 10):

```typescript
import {
  // ... existing imports
  ESCALATION_SLACK_JID,
  OPS_ALERT_FOLDER,
  STORE_DIR,
  // ...
} from './config.js';
```

Verify `STORE_DIR` is already imported; if not, add it.

- [ ] **Step 4: Build and verify**

Run: `bun run build 2>&1 | grep "src/index.ts\|src/config.ts" | grep error`
Expected: no errors.

- [ ] **Step 5: Commit**

Stage: `src/index.ts src/config.ts`
Message: `feat: add alert fallback chain with re-entrancy guard and file fallback`

---

## Task 4: Send failure tracker module

**Files:**
- Create: `src/send-failure-tracker.ts`
- Create: `src/send-failure-tracker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/send-failure-tracker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifySendError,
  trackTransientFailure,
  resetTrackers,
} from './send-failure-tracker.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  resetTrackers();
});

describe('classifySendError', () => {
  it('classifies 403 as structural', () => {
    expect(classifySendError(403, 'Forbidden')).toBe('structural');
  });

  it('classifies 401 as structural', () => {
    expect(classifySendError(401, 'Unauthorized')).toBe('structural');
  });

  it('classifies 400 chat not found as structural', () => {
    expect(classifySendError(400, 'chat not found')).toBe('structural');
  });

  it('classifies 400 bot was blocked as structural', () => {
    expect(classifySendError(400, 'bot was blocked by the user')).toBe('structural');
  });

  it('classifies 429 as transient', () => {
    expect(classifySendError(429, 'Too Many Requests')).toBe('transient');
  });

  it('classifies 500 as transient', () => {
    expect(classifySendError(500, 'Internal Server Error')).toBe('transient');
  });

  it('classifies 0 (network error) as transient', () => {
    expect(classifySendError(0, 'ECONNRESET')).toBe('transient');
  });
});

describe('trackTransientFailure', () => {
  it('returns null below threshold', () => {
    const result = trackTransientFailure('tg:123');
    expect(result).toBeNull();
  });

  it('returns per-group alert after 3 failures', () => {
    trackTransientFailure('tg:123');
    trackTransientFailure('tg:123');
    const result = trackTransientFailure('tg:123');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('per-group');
    expect(result!.count).toBe(3);
  });

  it('returns global outage alert after 3 distinct groups fail', () => {
    trackTransientFailure('tg:111');
    trackTransientFailure('tg:222');
    const result = trackTransientFailure('tg:333');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('global-outage');
  });

  it('resets per-group counter after 10-minute window', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    trackTransientFailure('tg:123');
    trackTransientFailure('tg:123');

    // Jump 11 minutes
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    const result = trackTransientFailure('tg:123');
    expect(result).toBeNull(); // reset, count is 1 not 3
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/send-failure-tracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement send-failure-tracker.ts**

Create `src/send-failure-tracker.ts`:

```typescript
import { logger } from './logger.js';

const STRUCTURAL_CODES = new Set([401, 403]);
const STRUCTURAL_MESSAGES = [
  'chat not found',
  'bot was blocked by the user',
  'bot was kicked',
];

const THRESHOLD = 3;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

interface PerGroupEntry {
  count: number;
  firstSeen: number;
}

interface GlobalEntry {
  jids: Set<string>;
  firstSeen: number;
}

export interface FailureAlert {
  type: 'per-group' | 'global-outage';
  jid?: string;
  count: number;
  windowMinutes: number;
}

const perGroup = new Map<string, PerGroupEntry>();
let globalTracker: GlobalEntry = { jids: new Set(), firstSeen: 0 };

export function classifySendError(
  errorCode: number,
  description: string,
): 'structural' | 'transient' {
  if (STRUCTURAL_CODES.has(errorCode)) return 'structural';
  if (
    errorCode === 400 &&
    STRUCTURAL_MESSAGES.some((m) => description.toLowerCase().includes(m))
  ) {
    return 'structural';
  }
  return 'transient';
}

export function trackTransientFailure(jid: string): FailureAlert | null {
  const now = Date.now();

  // Per-group tracking
  const entry = perGroup.get(jid);
  if (entry && now - entry.firstSeen > WINDOW_MS) {
    perGroup.delete(jid);
  }

  const current = perGroup.get(jid) ?? { count: 0, firstSeen: now };
  current.count++;
  perGroup.set(jid, current);

  // Global tracking
  if (now - globalTracker.firstSeen > WINDOW_MS) {
    globalTracker = { jids: new Set(), firstSeen: now };
  }
  globalTracker.jids.add(jid);

  // Check global outage first (higher priority)
  if (globalTracker.jids.size >= THRESHOLD) {
    const alert: FailureAlert = {
      type: 'global-outage',
      count: globalTracker.jids.size,
      windowMinutes: Math.round((now - globalTracker.firstSeen) / 60_000),
    };
    globalTracker = { jids: new Set(), firstSeen: now }; // reset after alert
    logger.warn({ alert }, 'Global Telegram outage detected');
    return alert;
  }

  // Check per-group threshold
  if (current.count >= THRESHOLD) {
    const alert: FailureAlert = {
      type: 'per-group',
      jid,
      count: current.count,
      windowMinutes: Math.round((now - current.firstSeen) / 60_000),
    };
    perGroup.delete(jid); // reset after alert
    return alert;
  }

  return null;
}

/** Reset all trackers. Exported for testing. */
export function resetTrackers(): void {
  perGroup.clear();
  globalTracker = { jids: new Set(), firstSeen: 0 };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/send-failure-tracker.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

Stage: `src/send-failure-tracker.ts src/send-failure-tracker.test.ts`
Message: `feat: add send failure tracker with per-group and global outage detection`

---

## Task 5: Add `onMigrate` and `onSendFailure` to channel opts

**Files:**
- Modify: `src/channels/registry.ts:8-13`
- Modify: `src/channels/telegram.ts:191-195`

- [ ] **Step 1: Update ChannelOpts**

In `src/channels/registry.ts`, change:

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAlert?: (message: string) => void;
}
```

To:

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAlert?: (message: string) => void;
  onMigrate?: (oldJid: string, newJid: string) => Promise<void>;
  onSendFailure?: (service: string, message: string) => void;
}
```

- [ ] **Step 2: Update TelegramChannelOpts**

In `src/channels/telegram.ts`, change:

```typescript
export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}
```

To:

```typescript
export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAlert?: (message: string) => void;
  onMigrate?: (oldJid: string, newJid: string) => Promise<void>;
  onSendFailure?: (service: string, message: string) => void;
}
```

- [ ] **Step 3: Build and verify**

Run: `bun run build 2>&1 | grep "registry.ts\|telegram.ts" | grep error`
Expected: no new errors.

- [ ] **Step 4: Commit**

Stage: `src/channels/registry.ts src/channels/telegram.ts`
Message: `feat: add onMigrate and onSendFailure to channel opts`

---

## Task 6: Add `migrateGroupJid` to db.ts

**Files:**
- Modify: `src/db.ts` — add migration function
- Modify: `src/db.test.ts` — test migration

- [ ] **Step 1: Write the failing test**

Add to the end of `src/db.test.ts`:

```typescript
describe('migrateGroupJid', () => {
  it('updates registered_groups, chats, scheduled_tasks, and router_state', () => {
    const { migrateGroupJid, _getTestDb } = require('./db.js');
    const db = _getTestDb();

    // Set up test data
    db.prepare('INSERT INTO chats (jid, name) VALUES (?, ?)').run(
      'tg:-100',
      'Test Group',
    );
    db.prepare(
      "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at) VALUES (?, ?, ?, ?, ?)",
    ).run('tg:-100', 'TEST', 'telegram_test', '@Claire', new Date().toISOString());
    db.prepare(
      "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run('task-1', 'telegram_test', 'tg:-100', 'test', 'once', '', 'active', new Date().toISOString());

    migrateGroupJid('tg:-100', 'tg:-200');

    // Verify registered_groups updated
    const group = db
      .prepare('SELECT * FROM registered_groups WHERE jid = ?')
      .get('tg:-200');
    expect(group).toBeTruthy();
    expect(db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get('tg:-100')).toBeUndefined();

    // Verify scheduled_tasks updated
    const task = db
      .prepare('SELECT chat_jid FROM scheduled_tasks WHERE id = ?')
      .get('task-1') as any;
    expect(task.chat_jid).toBe('tg:-200');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./src/db.test.ts -t "migrateGroupJid"`
Expected: FAIL — function not found.

- [ ] **Step 3: Implement migrateGroupJid**

Add to `src/db.ts`, before the agent registry section:

```typescript
/**
 * Migrate a group from an old JID to a new JID (e.g., supergroup upgrade).
 * Updates registered_groups, chats, scheduled_tasks, and router_state.
 * Does NOT update the messages table (historical messages stay with old JID).
 */
export function migrateGroupJid(oldJid: string, newJid: string): void {
  db.exec('BEGIN');
  try {
    // registered_groups: update JID
    db.prepare('UPDATE registered_groups SET jid = ? WHERE jid = ?').run(
      newJid,
      oldJid,
    );

    // chats: delete old if new exists, otherwise update
    const newChatExists = db
      .prepare('SELECT 1 FROM chats WHERE jid = ?')
      .get(newJid);
    if (newChatExists) {
      db.prepare('DELETE FROM chats WHERE jid = ?').run(oldJid);
    } else {
      db.prepare('UPDATE chats SET jid = ? WHERE jid = ?').run(newJid, oldJid);
    }

    // scheduled_tasks
    db.prepare('UPDATE scheduled_tasks SET chat_jid = ? WHERE chat_jid = ?').run(
      newJid,
      oldJid,
    );

    // router_state: swap key in last_agent_seq JSON
    const seqRow = db
      .prepare("SELECT value FROM router_state WHERE key = 'last_agent_seq'")
      .get() as { value: string } | undefined;
    if (seqRow) {
      const data = JSON.parse(seqRow.value) as Record<string, number>;
      if (oldJid in data) {
        data[newJid] = data[oldJid];
        delete data[oldJid];
        db.prepare("UPDATE router_state SET value = ? WHERE key = 'last_agent_seq'").run(
          JSON.stringify(data),
        );
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test ./src/db.test.ts -t "migrateGroupJid"`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage: `src/db.ts src/db.test.ts`
Message: `feat: add migrateGroupJid for supergroup upgrades`

---

## Task 7: Supergroup migration detection in telegram.ts

**Files:**
- Modify: `src/channels/telegram.ts` — add migration handling to sendMessage and sendPoolMessage

- [ ] **Step 1: Add migration guard and GrammyError import**

At the top of `src/channels/telegram.ts`, add to the Grammy import:

```typescript
import { GrammyError } from 'grammy';
```

After the existing module-level variables (around line 100), add:

```typescript
const migratingJids = new Set<string>();
let poolOpts: TelegramChannelOpts | null = null;
```

- [ ] **Step 2: Add migration helper function**

After the `migratingJids` declaration, add:

```typescript
async function handleMigration(
  err: unknown,
  chatId: string,
  text: string,
  api: { sendMessage: Api['sendMessage'] },
  opts: TelegramChannelOpts,
): Promise<boolean> {
  if (!(err instanceof GrammyError)) return false;
  const params = (err as any).parameters as
    | { migrate_to_chat_id?: number }
    | undefined;
  if (err.error_code !== 400 || !params?.migrate_to_chat_id) return false;

  const oldJid = `tg:${chatId}`;
  const newChatId = params.migrate_to_chat_id;
  const newJid = `tg:${newChatId}`;

  // Concurrency guard: another send is already migrating this JID
  if (migratingJids.has(oldJid)) {
    await sendTelegramMessage(api, String(newChatId), text);
    return true;
  }

  migratingJids.add(oldJid);
  try {
    await opts.onMigrate?.(oldJid, newJid);
    await sendTelegramMessage(api, String(newChatId), text);
  } finally {
    migratingJids.delete(oldJid);
  }
  return true;
}
```

- [ ] **Step 3: Add send-failure-tracker import**

At the top of `src/channels/telegram.ts`, add:

```typescript
import {
  classifySendError,
  trackTransientFailure,
} from '../send-failure-tracker.js';
```

- [ ] **Step 4: Update sendPoolMessage error handling**

In `sendPoolMessage` (around line 174), replace the catch block:

```typescript
  } catch (err: unknown) {
    // Handle supergroup migration
    if (poolOpts) {
      try {
        const migrated = await handleMigration(
          err,
          chatId.replace(/^tg:/, ''),
          text,
          api,
          poolOpts,
        );
        if (migrated) return true;
      } catch {
        // migration retry failed — fall through
      }
    }

    const errorCode =
      err && typeof err === 'object' && 'error_code' in err
        ? (err as { error_code: number }).error_code
        : 0;
    if (errorCode === 403) {
      logger.info(
        { chatId, sender },
        'Pool bot cannot reach chat, falling back to main bot',
      );
      return false;
    }
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
    return false;
  }
```

- [ ] **Step 5: Update sendMessage error handling**

In `TelegramChannel.sendMessage` (around line 751), replace the catch block:

```typescript
    } catch (err) {
      const numericId = jid.replace(/^tg:/, '');

      // Handle supergroup migration
      try {
        const migrated = await handleMigration(
          err,
          numericId,
          text,
          this.bot!.api,
          this.opts,
        );
        if (migrated) return;
      } catch {
        // migration retry failed — fall through
      }

      // Classify and escalate
      const errorCode =
        err && typeof err === 'object' && 'error_code' in err
          ? (err as { error_code: number }).error_code
          : 0;
      const description =
        err instanceof Error ? err.message : String(err);

      const category = classifySendError(errorCode, description);

      if (category === 'structural') {
        this.opts.onSendFailure?.(
          'Telegram',
          `Structural error sending to ${jid}: ${description}. Messages will continue failing until fixed.`,
        );
      } else {
        const alert = trackTransientFailure(jid);
        if (alert) {
          const msg =
            alert.type === 'global-outage'
              ? `Telegram API outage: ${alert.count} groups affected in ${alert.windowMinutes}m`
              : `${alert.count} failures to ${jid} in ${alert.windowMinutes}m — possible Telegram API issue`;
          this.opts.onSendFailure?.('Telegram', msg);
        }
      }

      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
```

- [ ] **Step 6: Store opts reference for pool messages**

In the `TelegramChannel` constructor, after `this.opts = opts;`, add:

```typescript
    poolOpts = opts;
```

- [ ] **Step 7: Build and verify**

Run: `bun run build 2>&1 | grep "telegram.ts" | grep error`
Expected: no new errors.

- [ ] **Step 8: Commit**

Stage: `src/channels/telegram.ts`
Message: `feat: add supergroup auto-migration and send failure escalation`

---

## Task 8: Wire callbacks in index.ts

**Files:**
- Modify: `src/index.ts` — wire `onMigrate` and `onSendFailure` into channel init

- [ ] **Step 1: Add migrateGroupJid import**

In `src/index.ts`, add to the db.ts imports:

```typescript
import {
  // ... existing imports
  migrateGroupJid,
} from './db.js';
```

- [ ] **Step 2: Wire callbacks in channel init loop**

In `src/index.ts`, find the channel init loop (around line 1331). Change:

```typescript
    const channel = factory({
      ...channelOpts,
      onAlert: (msg) => void sendSystemAlert(channelName, msg),
    });
```

To:

```typescript
    const channel = factory({
      ...channelOpts,
      onAlert: (msg) => void sendSystemAlert(channelName, msg),
      onMigrate: async (oldJid, newJid) => {
        const group = registeredGroups[oldJid];
        const groupName = group?.name || oldJid;
        migrateGroupJid(oldJid, newJid);
        // Update in-memory state
        if (group) {
          registeredGroups[newJid] = group;
          delete registeredGroups[oldJid];
          if (lastAgentSeq[oldJid] !== undefined) {
            lastAgentSeq[newJid] = lastAgentSeq[oldJid];
            delete lastAgentSeq[oldJid];
          }
        }
        void sendSystemAlert(
          'Telegram Migration',
          `Auto-migrated ${groupName} from ${oldJid} to ${newJid} (supergroup upgrade)`,
        );
        logger.info({ oldJid, newJid, groupName }, 'Group auto-migrated');
      },
      onSendFailure: (service, msg) => void sendSystemAlert(service, msg),
    });
```

- [ ] **Step 3: Build and verify**

Run: `bun run build 2>&1 | grep "src/index.ts" | grep error`
Expected: no errors.

- [ ] **Step 4: Run all tests**

Run: `bun test ./src/db.test.ts ./src/send-failure-tracker.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

Stage: `src/index.ts`
Message: `feat: wire migration and send failure callbacks into channel init`

---

## Post-Implementation Checklist

- [ ] All tests pass: `bun test ./src/db.test.ts ./src/send-failure-tracker.test.ts`
- [ ] Build succeeds (no new errors): `bun run build`
- [ ] Manual verify: `sendSystemAlert` with OPS-claw unreachable falls back to CLAIRE DM
- [ ] Manual verify: send message to old supergroup ID triggers auto-migration
- [ ] Rebuild and restart: `bun run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
