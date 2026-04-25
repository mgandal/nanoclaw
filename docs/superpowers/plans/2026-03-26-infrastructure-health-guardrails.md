# Infrastructure Health Guardrails Implementation Plan

> **Status: SHIPPED 2026-03-26 → 2026-03-28.** All required files exist: `src/system-alerts.ts` (Mar 28), `src/health-check.ts` (Mar 28); infra alerting wired into `HealthMonitor`. Direct task-for-task commit chain: `1d54adfa feat: add system-alerts module for infrastructure health persistence` (Task 1), `b37aa513 feat: add infra_error support to HealthMonitor` (Task 7), `9a937376 feat: wire infrastructure health guardrails — alerts to CODE-claw, MCP checks in health monitor` (Task 8), `cd608dcb docs: add system-alerts.json to CLAIRE digest instructions` (Task 9). Post-ship hardening: `7bbed870 fix: require 3 consecutive failures before MCP infra alerts`; `468d9598 chore: add pre-commit guardrail against hardcoded alert routing`. The later `2026-04-04-health-watchdog.md` and the C-class audit extended this work (different scope: cron/launchd watchdog vs. in-process alerts) — related, not superseding. Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tests verifying recent infrastructure fixes, runtime guardrails that detect and alert on failures proactively, and exponential backoff to prevent log spam.

**Architecture:** New `system-alerts.ts` module handles alert persistence + delivery. Gmail watcher gets backoff + callback on auth failure. Credential proxy gets failure tracking. MCP health check extracted to testable module and moved into HealthMonitor periodic sweep. Alerts go to CODE-claw immediately and persist to `data/system-alerts.json` for CLAIRE's digests.

**Tech Stack:** TypeScript, Vitest, Node.js http module

---

### Task 1: System Alerts Module

**Files:**
- Create: `src/system-alerts.ts`
- Create: `src/system-alerts.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/system-alerts.test.ts
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendAlert,
  cleanupAlerts,
  getUnresolvedAlerts,
  resolveAlert,
  type SystemAlert,
} from './system-alerts.js';

const TEST_DIR = path.join(import.meta.dirname, '..', 'data', 'test-alerts');
const ALERTS_FILE = path.join(TEST_DIR, 'system-alerts.json');

describe('system-alerts', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // Clear any existing alerts file
    if (fs.existsSync(ALERTS_FILE)) fs.unlinkSync(ALERTS_FILE);
  });

  afterEach(() => {
    if (fs.existsSync(ALERTS_FILE)) fs.unlinkSync(ALERTS_FILE);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('appends an alert and reads it back', () => {
    appendAlert(
      {
        timestamp: new Date().toISOString(),
        service: 'gmail',
        message: 'OAuth token expired (invalid_grant)',
        fixInstructions: 'Re-authorize Gmail OAuth',
      },
      ALERTS_FILE,
    );

    const alerts = getUnresolvedAlerts(ALERTS_FILE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].service).toBe('gmail');
    expect(alerts[0].resolved).toBeFalsy();
  });

  it('resolves an alert by id', () => {
    appendAlert(
      {
        timestamp: new Date().toISOString(),
        service: 'mcp:QMD',
        message: 'Unreachable at startup',
      },
      ALERTS_FILE,
    );

    const before = getUnresolvedAlerts(ALERTS_FILE);
    expect(before).toHaveLength(1);

    resolveAlert(before[0].id, ALERTS_FILE);

    const after = getUnresolvedAlerts(ALERTS_FILE);
    expect(after).toHaveLength(0);
  });

  it('cleans up alerts older than 24h', () => {
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    const recent = new Date().toISOString();

    appendAlert(
      { timestamp: old, service: 'gmail', message: 'old alert' },
      ALERTS_FILE,
    );
    appendAlert(
      { timestamp: recent, service: 'gmail', message: 'new alert' },
      ALERTS_FILE,
    );

    cleanupAlerts(ALERTS_FILE);

    const all = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8')) as SystemAlert[];
    expect(all).toHaveLength(1);
    expect(all[0].message).toBe('new alert');
  });

  it('handles missing file gracefully', () => {
    const alerts = getUnresolvedAlerts(ALERTS_FILE);
    expect(alerts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/system-alerts.test.ts`
Expected: FAIL — module `./system-alerts.js` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/system-alerts.ts
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface SystemAlert {
  id: string;
  timestamp: string;
  service: string;
  message: string;
  fixInstructions?: string;
  resolved?: boolean;
}

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'system-alerts.json');

function readAlerts(filePath = DEFAULT_PATH): SystemAlert[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SystemAlert[];
  } catch {
    return [];
  }
}

function writeAlerts(alerts: SystemAlert[], filePath = DEFAULT_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(alerts, null, 2), 'utf-8');
}

export function appendAlert(
  alert: Omit<SystemAlert, 'id'>,
  filePath = DEFAULT_PATH,
): SystemAlert {
  const full: SystemAlert = { id: randomUUID(), ...alert };
  const alerts = readAlerts(filePath);
  alerts.push(full);
  writeAlerts(alerts, filePath);
  logger.error(
    { tag: 'SYSTEM_ALERT', service: full.service },
    full.message,
  );
  return full;
}

export function getUnresolvedAlerts(filePath = DEFAULT_PATH): SystemAlert[] {
  return readAlerts(filePath).filter((a) => !a.resolved);
}

export function resolveAlert(id: string, filePath = DEFAULT_PATH): void {
  const alerts = readAlerts(filePath);
  const alert = alerts.find((a) => a.id === id);
  if (alert) {
    alert.resolved = true;
    writeAlerts(alerts, filePath);
  }
}

export function cleanupAlerts(filePath = DEFAULT_PATH): void {
  const cutoff = Date.now() - 24 * 3600_000;
  const alerts = readAlerts(filePath).filter(
    (a) => new Date(a.timestamp).getTime() > cutoff,
  );
  writeAlerts(alerts, filePath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/system-alerts.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/system-alerts.ts src/system-alerts.test.ts
git commit -m "feat: add system-alerts module for infrastructure health persistence"
```

---

### Task 2: MCP Health Check Module

**Files:**
- Create: `src/health-check.ts`
- Create: `src/health-check.test.ts`
- Modify: `src/index.ts:693-760` (remove `checkMcpEndpoints`, replace with import)

- [ ] **Step 1: Write the failing tests**

```typescript
// src/health-check.test.ts
import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkMcpEndpoint } from './health-check.js';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const accept = req.headers['accept'];
    if (!accept?.includes('text/event-stream')) {
      res.writeHead(406);
      res.end('Not Acceptable');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

describe('checkMcpEndpoint', () => {
  it('reports reachable for a running server', async () => {
    const result = await checkMcpEndpoint(
      `http://127.0.0.1:${port}/mcp`,
      2000,
    );
    expect(result.reachable).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('sends the correct Accept header', async () => {
    // The test server returns 406 without the right Accept header.
    // If our function sends the right header, we get 200.
    const result = await checkMcpEndpoint(
      `http://127.0.0.1:${port}/mcp`,
      2000,
    );
    expect(result.statusCode).toBe(200);
  });

  it('reports reachable even on non-200 status codes', async () => {
    // Hit a path the server doesn't explicitly handle — still reachable
    const result = await checkMcpEndpoint(
      `http://127.0.0.1:${port}/unknown`,
      2000,
    );
    expect(result.reachable).toBe(true);
    // Server returns 406 for missing Accept header on unknown paths
    expect(result.statusCode).toBeDefined();
  });

  it('reports unreachable for a dead port', async () => {
    const result = await checkMcpEndpoint(
      'http://127.0.0.1:19999/mcp',
      1000,
    );
    expect(result.reachable).toBe(false);
    expect(result.statusCode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/health-check.test.ts`
Expected: FAIL — module `./health-check.js` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/health-check.ts
import http from 'http';

export interface HealthCheckResult {
  reachable: boolean;
  statusCode?: number;
}

export function checkMcpEndpoint(
  url: string,
  timeoutMs = 3000,
): Promise<HealthCheckResult> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'GET',
          headers: { Accept: 'application/json, text/event-stream' },
          timeout: timeoutMs,
        },
        (res) => {
          res.resume(); // drain response to free socket
          resolve({ reachable: true, statusCode: res.statusCode });
        },
      );
      req.on('error', () => {
        resolve({ reachable: false });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ reachable: false });
      });
      req.end();
    } catch {
      resolve({ reachable: false });
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/health-check.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/health-check.ts src/health-check.test.ts
git commit -m "feat: extract MCP health check into testable module"
```

---

### Task 3: Calendar Watcher Tests

**Files:**
- Create: `src/watchers/calendar-watcher.test.ts`

- [ ] **Step 1: Write the tests**

The `detectConflicts` method is static and pure — no mocking needed. Test the fix for missing start/end fields.

```typescript
// src/watchers/calendar-watcher.test.ts
import { describe, expect, it } from 'vitest';

import { CalendarWatcher, type CalendarEvent } from './calendar-watcher.js';

describe('CalendarWatcher.detectConflicts', () => {
  it('detects overlapping events', () => {
    const events: CalendarEvent[] = [
      { title: 'Meeting A', start: '2026-03-26T10:00:00', end: '2026-03-26T11:00:00' },
      { title: 'Meeting B', start: '2026-03-26T10:30:00', end: '2026-03-26T11:30:00' },
    ];
    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].changeType).toBe('conflict');
    expect(conflicts[0].event.title).toBe('Meeting A');
    expect(conflicts[0].conflictsWith?.title).toBe('Meeting B');
  });

  it('does not flag back-to-back events', () => {
    const events: CalendarEvent[] = [
      { title: 'Meeting A', start: '2026-03-26T10:00:00', end: '2026-03-26T11:00:00' },
      { title: 'Meeting B', start: '2026-03-26T11:00:00', end: '2026-03-26T12:00:00' },
    ];
    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts).toHaveLength(0);
  });

  it('handles events with missing start/end without crashing', () => {
    const events = [
      { title: 'Good', start: '2026-03-26T10:00:00', end: '2026-03-26T11:00:00' },
      { title: 'Broken', start: '', end: '' },
      { title: 'Also broken' } as unknown as CalendarEvent,
    ] as CalendarEvent[];
    // Should not throw
    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts).toHaveLength(0); // only 1 complete event, need 2 for conflicts
  });

  it('handles empty array', () => {
    expect(CalendarWatcher.detectConflicts([])).toEqual([]);
  });

  it('handles single event', () => {
    const events: CalendarEvent[] = [
      { title: 'Solo', start: '2026-03-26T10:00:00', end: '2026-03-26T11:00:00' },
    ];
    expect(CalendarWatcher.detectConflicts(events)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/watchers/calendar-watcher.test.ts`
Expected: All 5 tests PASS (these test existing behavior, not new code)

- [ ] **Step 3: Commit**

```bash
git add src/watchers/calendar-watcher.test.ts
git commit -m "test: add calendar watcher conflict detection tests"
```

---

### Task 4: DB Schema Round-Trip Test

**Files:**
- Create: `src/db.test.ts`

- [ ] **Step 1: Write the tests**

Uses the existing `_initTestDatabase` and `_closeDatabase` test helpers already exported from `src/db.ts`.

```typescript
// src/db.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getAllRegisteredGroups,
  setRegisteredGroup,
} from './db.js';

describe('registered_groups schema', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('round-trips a registered group with all fields', () => {
    const jid = 'tg:-1234567890';
    setRegisteredGroup(jid, {
      name: 'TEST-GROUP',
      folder: 'telegram_test-group',
      trigger: '@Test',
      added_at: '2026-03-26T00:00:00.000Z',
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '/Volumes/sandisk4TB/marvin-vault',
            containerPath: 'claire-vault',
            readonly: false,
          },
        ],
      },
      requiresTrigger: false,
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups[jid];

    expect(group).toBeDefined();
    expect(group.name).toBe('TEST-GROUP');
    expect(group.folder).toBe('telegram_test-group');
    expect(group.trigger).toBe('@Test');
    expect(group.added_at).toBe('2026-03-26T00:00:00.000Z');
    expect(group.containerConfig?.additionalMounts).toHaveLength(1);
    expect(group.requiresTrigger).toBe(false);
    expect(group.isMain).toBe(true);
  });

  it('round-trips a group with no optional fields', () => {
    const jid = 'tg:999';
    setRegisteredGroup(jid, {
      name: 'MINIMAL',
      folder: 'telegram_minimal',
      trigger: '@Bot',
      added_at: '2026-03-26T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups[jid];

    expect(group).toBeDefined();
    expect(group.name).toBe('MINIMAL');
    expect(group.containerConfig).toBeUndefined();
    expect(group.requiresTrigger).toBe(true); // default
    expect(group.isMain).toBeUndefined(); // false stored as 0, read as undefined
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts`
Expected: All 2 tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/db.test.ts
git commit -m "test: add registered_groups schema round-trip tests"
```

---

### Task 5: Gmail Watcher Auth Failure Backoff + Alert

**Files:**
- Modify: `src/watchers/gmail-watcher.ts` (add `onAuthFailure` to config, backoff logic in poll)
- Create: `src/watchers/gmail-watcher.test.ts`

- [ ] **Step 1: Write the failing test for auth backoff**

```typescript
// src/watchers/gmail-watcher.test.ts
import { describe, expect, it } from 'vitest';

import { computeBackoffMs, AUTH_BACKOFF_SCHEDULE } from './gmail-watcher.js';

describe('Gmail auth failure backoff', () => {
  it('returns the correct backoff for each failure count', () => {
    expect(computeBackoffMs(0)).toBe(AUTH_BACKOFF_SCHEDULE[0]); // 60_000
    expect(computeBackoffMs(1)).toBe(AUTH_BACKOFF_SCHEDULE[1]); // 300_000
    expect(computeBackoffMs(2)).toBe(AUTH_BACKOFF_SCHEDULE[2]); // 1_800_000
  });

  it('returns -1 (stop) when failures exceed schedule length', () => {
    expect(computeBackoffMs(3)).toBe(-1);
    expect(computeBackoffMs(10)).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/watchers/gmail-watcher.test.ts`
Expected: FAIL — `computeBackoffMs` not exported

- [ ] **Step 3: Add backoff schedule, callback, and logic to gmail-watcher.ts**

In `src/watchers/gmail-watcher.ts`, add the following changes:

After the imports (line 15), add:

```typescript
// ─── Auth failure backoff ─────────────────────────────────────────────────────

/** Backoff intervals in ms: 1min, 5min, 30min, then stop (-1). */
export const AUTH_BACKOFF_SCHEDULE = [60_000, 300_000, 1_800_000];

/** Given consecutive auth failure count, return backoff ms or -1 to stop. */
export function computeBackoffMs(failureCount: number): number {
  if (failureCount >= AUTH_BACKOFF_SCHEDULE.length) return -1;
  return AUTH_BACKOFF_SCHEDULE[failureCount];
}
```

Add `onAuthFailure` to `GmailWatcherConfig` (after `stateDir` field, line 29):

```typescript
  /** Called on first auth failure (e.g. expired token). Fire-and-forget. */
  onAuthFailure?: (error: string) => void;
```

Add a private field to `GmailWatcher` class (after `state` on line 82):

```typescript
  private authFailureCount = 0;
```

Replace the outer catch block in `poll()` (lines 313-318) with:

```typescript
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      const isAuthError =
        message.includes('invalid_grant') ||
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
          return;
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
          void this.poll().then(() => this.scheduleNext());
        }, backoff);
        return;
      }

      logger.warn(
        { err, account: this.config.account },
        'GmailWatcher poll failed',
      );
    }
```

Note: The early return after the backoff setTimeout prevents `scheduleNext()` from being called at the normal interval. When the backoff timer fires, poll() runs and calls scheduleNext() normally if auth succeeds. If auth fails again, the catch block sets another backoff timer.

Also add after the `this.saveState()` call (around line 303) to reset on success:

```typescript
      // Reset auth failure counter on successful poll
      this.authFailureCount = 0;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/watchers/gmail-watcher.test.ts`
Expected: All 2 tests PASS

- [ ] **Step 5: Build to verify compilation**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 6: Commit**

```bash
git add src/watchers/gmail-watcher.ts src/watchers/gmail-watcher.test.ts
git commit -m "feat: add auth failure backoff and alert callback to Gmail watcher"
```

---

### Task 6: Credential Proxy Failure Tracking

**Files:**
- Modify: `src/credential-proxy.ts`

- [ ] **Step 1: Add onAuthFailure callback and failure counter**

In `src/credential-proxy.ts`, change the `startCredentialProxy` signature (line 59) to:

```typescript
export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  onAuthFailure?: (statusCode: number) => void,
): Promise<Server> {
```

After `const makeRequest = isHttps ? httpsRequest : httpRequest;` (line 78), add:

```typescript
  let consecutiveAuthFailures = 0;
  const AUTH_FAILURE_THRESHOLD = 3;
```

After `const upstreamUrl = ...` block and before the `return new Promise(...)`, add a startup validation. Insert after `const makeRequest` line:

```typescript
  if (authMode === 'oauth' && !oauthToken) {
    logger.error(
      { tag: 'SYSTEM_ALERT' },
      'Credential proxy: no OAuth token found (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN both missing)',
    );
  }
```

In the upstream response callback (line 151), before `res.writeHead(upRes.statusCode!, upRes.headers);`, add auth failure tracking:

```typescript
          (upRes) => {
            const status = upRes.statusCode ?? 0;

            // Track auth failures from upstream API
            if (status === 401 || status === 403) {
              consecutiveAuthFailures++;
              if (
                consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD &&
                onAuthFailure
              ) {
                onAuthFailure(status);
                // Reset to avoid firing on every subsequent request
                consecutiveAuthFailures = 0;
              }
            } else {
              consecutiveAuthFailures = 0;
            }

            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
```

- [ ] **Step 2: Build to verify compilation**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Commit**

```bash
git add src/credential-proxy.ts
git commit -m "feat: add auth failure tracking and startup validation to credential proxy"
```

---

### Task 7: Extend HealthMonitor for Infrastructure Events

**Files:**
- Modify: `src/health-monitor.ts`

- [ ] **Step 1: Add infra_error type and recordInfraEvent method**

In `src/health-monitor.ts`, update the `HealthAlert` type union (line 25):

```typescript
export interface HealthAlert {
  type: 'excessive_spawns' | 'excessive_errors' | 'infra_error';
  group: string;
  detail: string;
  timestamp: number;
}
```

Add a new private field after `ollamaLatencyLog` (line 44):

```typescript
  private infraAlerts: Map<string, string> = new Map(); // service → message
```

Add the `recordInfraEvent` method after `recordError` (after line 58):

```typescript
  recordInfraEvent(service: string, message: string): void {
    this.infraAlerts.set(service, message);
  }

  clearInfraEvent(service: string): void {
    this.infraAlerts.delete(service);
  }
```

At the end of `checkThresholds()`, before `return alerts;` (line 136), add:

```typescript
    // Infrastructure alerts
    for (const [service, message] of this.infraAlerts) {
      const alertKey = `infra_error:${service}`;
      const lastAlerted = this.recentAlerts.get(alertKey) ?? 0;
      const alert: HealthAlert = {
        type: 'infra_error',
        group: service,
        detail: message,
        timestamp: now,
      };
      alerts.push(alert);
      if (now - lastAlerted > alertCooldownMs) {
        this.recentAlerts.set(alertKey, now);
        this.config.onAlert(alert);
      }
    }
```

- [ ] **Step 2: Build to verify compilation**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Commit**

```bash
git add src/health-monitor.ts
git commit -m "feat: add infra_error support to HealthMonitor"
```

---

### Task 8: Wire Everything in index.ts

**Files:**
- Modify: `src/index.ts`

This task replaces the inline `checkMcpEndpoints` function with the extracted module, adds a `sendSystemAlert` utility, wires the Gmail watcher and credential proxy callbacks, and moves MCP checks into the HealthMonitor sweep.

- [ ] **Step 1: Add sendSystemAlert utility and import new modules**

At the top of `src/index.ts`, add imports (near the other imports):

```typescript
import { checkMcpEndpoint } from './health-check.js';
import { appendAlert } from './system-alerts.js';
```

Remove the entire `checkMcpEndpoints()` function (lines 693-760) and replace it with:

```typescript
/** Send an alert to specified groups + persist for digests. */
async function sendSystemAlert(
  service: string,
  message: string,
  targetFolders: string[],
  fixInstructions?: string,
): Promise<void> {
  appendAlert({ timestamp: new Date().toISOString(), service, message, fixInstructions });

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

- [ ] **Step 2: Update the HealthMonitor onAlert callback**

Replace the `onAlert` callback in the HealthMonitor config (lines 774-786) to also send to CODE-claw:

```typescript
    onAlert: (alert) => {
      logger.error({ tag: 'SYSTEM_ALERT', alert }, 'Health monitor alert');
      // Send to main group (existing behavior)
      const mainJid = Object.keys(registeredGroups).find(
        (jid) => registeredGroups[jid]?.isMain,
      );
      if (mainJid) {
        const channel = findChannel(channels, mainJid);
        channel
          ?.sendMessage(mainJid, `System alert: ${alert.detail}`)
          .catch(() => {});
      }
      // Also send infra alerts to CODE-claw
      if (alert.type === 'infra_error') {
        void sendSystemAlert(alert.group, alert.detail, ['telegram_code-claw']);
      }
    },
```

- [ ] **Step 3: Add periodic MCP health checks to the HealthMonitor interval**

After the `setInterval(() => healthMonitor.checkThresholds(), ...)` line (line 790), add MCP health checks that run in the same interval. Replace that line with:

```typescript
  // Periodically check health thresholds + MCP endpoints
  const mcpEndpoints = [
    { name: 'QMD', url: 'http://localhost:8181/mcp' },
    { name: 'SimpleMem', url: process.env.SIMPLEMEM_URL },
    { name: 'Apple Notes', url: process.env.APPLE_NOTES_URL },
    { name: 'Todoist', url: process.env.TODOIST_URL },
  ];

  setInterval(async () => {
    healthMonitor.checkThresholds();

    // Check MCP endpoints (only after channels are connected)
    if (channels.length === 0) return;
    for (const ep of mcpEndpoints) {
      if (!ep.url) continue;
      const result = await checkMcpEndpoint(ep.url);
      if (result.reachable) {
        healthMonitor.clearInfraEvent(`mcp:${ep.name}`);
      } else {
        healthMonitor.recordInfraEvent(
          `mcp:${ep.name}`,
          `MCP server ${ep.name} is unreachable`,
        );
      }
    }
  }, HEALTH_MONITOR_INTERVAL);
```

Also read MCP URLs from env. Add after the `const mcpEndpoints` block:

```typescript
  // Read URLs from .env if not in process.env
  if (!mcpEndpoints[1].url || !mcpEndpoints[2].url || !mcpEndpoints[3].url) {
    const envUrls = readEnvFile(['SIMPLEMEM_URL', 'APPLE_NOTES_URL', 'TODOIST_URL']);
    if (!mcpEndpoints[1].url) mcpEndpoints[1].url = envUrls.SIMPLEMEM_URL;
    if (!mcpEndpoints[2].url) mcpEndpoints[2].url = envUrls.APPLE_NOTES_URL;
    if (!mcpEndpoints[3].url) mcpEndpoints[3].url = envUrls.TODOIST_URL;
  }
```

Ensure `readEnvFile` is imported — check existing imports; it should already be imported from `./env.js`.

- [ ] **Step 4: Remove the `checkMcpEndpoints()` call from main()**

In `main()` (line 767), remove the line:
```
  checkMcpEndpoints();
```

- [ ] **Step 5: Wire Gmail watcher onAuthFailure callback**

Replace the Gmail watcher instantiation (lines 837-846) with:

```typescript
    if (fs.existsSync(GMAIL_CREDENTIALS_PATH)) {
      const gmailWatcher = new GmailWatcher({
        credentialsPath: GMAIL_CREDENTIALS_PATH,
        account: GMAIL_ACCOUNT,
        eventRouter,
        pollIntervalMs: GMAIL_POLL_INTERVAL,
        stateDir: watcherStateDir,
        onAuthFailure: (error) => {
          void sendSystemAlert(
            'Gmail',
            error,
            ['telegram_code-claw'],
            'Re-authorize Gmail OAuth: run the OAuth refresh flow in ~/.gmail-mcp/',
          );
        },
      });
      gmailWatcher
        .start()
        .catch((err) => logger.error({ err }, 'Gmail watcher failed to start'));
    } else {
      logger.info('Gmail credentials not found, Gmail watcher disabled');
    }
```

- [ ] **Step 6: Wire credential proxy onAuthFailure callback**

Replace the credential proxy startup (lines 869-872) with:

```typescript
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
    (statusCode) => {
      void sendSystemAlert(
        'Credential Proxy',
        `${statusCode} auth failures from Anthropic API — token may be expired or invalid`,
        ['telegram_code-claw'],
        'Check CLAUDE_CODE_OAUTH_TOKEN in .env or run scripts/refresh-api-key.sh',
      );
    },
  );
```

- [ ] **Step 7: Build to verify compilation**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 8: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire infrastructure health guardrails — alerts to CODE-claw, MCP checks in health monitor"
```

---

### Task 9: Update CLAIRE's CLAUDE.md for Digest Integration

**Files:**
- Modify: `groups/telegram_claire/CLAUDE.md`

- [ ] **Step 1: Add system alerts instruction**

Open `groups/telegram_claire/CLAUDE.md` and add the following section before the end of the file:

```markdown
## System Alerts

When composing daily digests or summaries, check `/workspace/project/data/system-alerts.json` for unresolved infrastructure alerts. If any exist, include them prominently at the top of the digest with the service name, error message, and fix instructions. Example:

> **Infrastructure Alert (unresolved):**
> - Gmail: OAuth token expired — Re-authorize by running the OAuth refresh flow in ~/.gmail-mcp/
```

- [ ] **Step 2: Commit**

```bash
git add groups/telegram_claire/CLAUDE.md
git commit -m "docs: add system-alerts.json to CLAIRE digest instructions"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (system-alerts, health-check, calendar-watcher, db, gmail-watcher)

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Restart service and verify no warnings**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 5
tail -20 logs/nanoclaw.log | grep -E 'SYSTEM_ALERT|MCP|reachable|WARN|ERROR'
```

Expected: No MCP timeout warnings. May see `MCP endpoint reachable` in later health monitor sweeps.

- [ ] **Step 4: Verify system-alerts.json is created on failure**

```bash
cat data/system-alerts.json 2>/dev/null || echo "No alerts (good)"
```

Expected: File doesn't exist (no current failures) or contains only resolved alerts.
