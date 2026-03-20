# Vision Phase 1: Infrastructure Foundation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three infrastructure components that every subsequent vision phase depends on: precomputed context injection (eliminates cold starts), the system health monitor (prevents runaway costs), and the inter-agent message bus (enables agent coordination without human routing).

**Architecture:** Extend NanoClaw's existing Node.js orchestrator, IPC filesystem, and container runner. No new services — just new modules within the existing process. The message bus uses the existing `data/ipc/` filesystem pattern. The context assembler is a host-side script that runs before each container spawn. The health monitor is a lightweight loop within the main process.

**Tech Stack:** TypeScript (Node.js), SQLite (better-sqlite3), filesystem IPC (JSON), vitest for tests (ESM-compatible mocking via `vi.mock` + `vi.mocked`).

**Spec:** `docs/VISION3.md` — sections "Token Conservation", "System Self-Awareness", and "How They Coordinate"

**Phase Roadmap:**
- **Phase 1 (this plan):** Precomputed context, anomaly monitor, message bus
- **Phase 2:** Ollama classification tier, event-driven email/calendar perception
- **Phase 3:** Trust/autonomy framework, knowledge graph (Layer 5)
- **Phase 4:** Coherent temporal identity, advanced judgment under ambiguity

**Key codebase facts (verified against actual files):**
- `src/container-runner.ts`: `runContainerAgent` at line 345, `spawn` at line 388
- `src/index.ts`: `main()` at line 701, `startIpcWatcher` called at line 851, `channels` at line 85, `findChannel` imported from `router.js` at line 55
- `container/agent-runner/src/index.ts`: `runQuery` at line 332, `systemPrompt` at line 399-400, `globalClaudeMd` at line 370-373
- `src/ipc.ts`: `IpcDeps` interface at line 20-33, `startIpcWatcher` at line 37, task switch default at line 484
- `src/db.ts`: `getAllTasks` at line 434, `createTask` at line 386. **No `getRecentMessages` function exists — must be created.**
- ESM project: all imports use `import`, no `require()`. Tests use vitest with `vi.mock()` and `vi.mocked()`.
- Messages are sent via `deps.sendMessage(jid, text)` in IPC, or `findChannel(channels, jid)?.sendMessage(jid, text)` in index.ts.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/context-assembler.ts` | Assembles per-group context packets before container spawn |
| `src/context-assembler.test.ts` | Tests for context assembly |
| `src/health-monitor.ts` | Deterministic daemon monitoring container rates, errors, MCP health |
| `src/health-monitor.test.ts` | Tests for health monitor |
| `src/message-bus.ts` | Filesystem-based pub/sub for inter-agent communication |
| `src/message-bus.test.ts` | Tests for message bus |

### Modified Files

| File | Line Range | Changes |
|------|-----------|---------|
| `src/db.ts` | after line 434 | Add `getRecentMessages()` function |
| `src/config.ts` | end of file | Add context, health, and bus configuration constants |
| `src/container-runner.ts` | ~line 370 (before spawn) | Call `writeContextPacket` before container spawn |
| `src/index.ts` | line 701+ (`main()`) | Initialize health monitor and message bus, pass to deps |
| `src/ipc.ts` | line 20-33 (`IpcDeps`), before line 484 (`default`) | Extend IpcDeps with `messageBus`, add `bus_publish` case |
| `container/agent-runner/src/index.ts` | line 370-401 | Read context packet, prepend to system prompt append |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | after existing tools | Add `bus_publish` and `bus_read` MCP tools |

---

## Task 1: Database and Config Prerequisites

Create the `getRecentMessages` function and config constants that other tasks depend on. **This must be done first** because the context assembler imports from db.ts.

**Files:**
- Modify: `src/db.ts` (add `getRecentMessages` after line 434)
- Modify: `src/config.ts` (add constants at end of file)

### Step 1.1: Add `getRecentMessages` to db.ts

- [ ] **Add the function after `getAllTasks()` (line ~440) in `src/db.ts`:**

```typescript
export function getRecentMessages(
  groupFolder: string,
  limit: number = 10,
): Array<{ sender: string; content: string; timestamp: string }> {
  return db
    .prepare(
      `SELECT m.sender, m.content, m.timestamp
       FROM messages m
       JOIN registered_groups rg ON m.chat_jid = rg.jid
       WHERE rg.folder = ?
       ORDER BY m.timestamp DESC
       LIMIT ?`,
    )
    .all(groupFolder, limit) as Array<{
    sender: string;
    content: string;
    timestamp: string;
  }>;
}
```

- [ ] **Verify it compiles:** `npm run build`
- [ ] **Commit:** `feat: add getRecentMessages to db`

### Step 1.2: Add config constants

- [ ] **Add to end of `src/config.ts`:**

```typescript
// Context assembler configuration
export const CONTEXT_PACKET_MAX_SIZE = parseInt(
  process.env.CONTEXT_PACKET_MAX_SIZE || '8000',
  10,
);

// Health monitor thresholds
export const HEALTH_MONITOR_INTERVAL = 60_000;
export const MAX_CONTAINER_SPAWNS_PER_HOUR = 30;
export const MAX_ERRORS_PER_HOUR = 20;
```

- [ ] **Commit:** `feat: add context and health monitor config`

---

## Task 2: Context Assembler

Pre-builds a context packet for each agent container so agents never start cold.

**Files:**
- Create: `src/context-assembler.ts`
- Create: `src/context-assembler.test.ts`
- Modify: `src/container-runner.ts` (line ~370, before spawn at line 388)
- Modify: `container/agent-runner/src/index.ts` (line 370-401, systemPrompt)

### Step 2.1: Write failing tests

- [ ] **Create `src/context-assembler.test.ts`:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { assembleContextPacket } from './context-assembler.js';
import { getRecentMessages, getAllTasks } from './db.js';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock('./db.js', () => ({
  getRecentMessages: vi.fn(() => []),
  getAllTasks: vi.fn(() => []),
}));

describe('assembleContextPacket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes current date and timezone', () => {
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Current date:');
    expect(packet).toContain('Timezone:');
  });

  it('includes recent messages when available', () => {
    vi.mocked(getRecentMessages).mockReturnValue([
      { sender: 'user1', content: 'hello world', timestamp: '2026-03-20T10:00:00Z' },
    ]);
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Recent messages');
    expect(packet).toContain('hello world');
  });

  it('includes active scheduled tasks', () => {
    vi.mocked(getAllTasks).mockReturnValue([
      {
        id: 'task-1', prompt: 'Morning briefing', schedule_type: 'cron',
        schedule_value: '0 7 * * 1-5', status: 'active', group_folder: 'main',
        chat_jid: 'tg:123', context_mode: 'group', next_run: null,
        last_run: null, last_result: null, created_at: '2026-03-20',
      },
    ]);
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Scheduled tasks');
    expect(packet).toContain('Morning briefing');
  });

  it('reads group memory.md if it exists', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('memory.md'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('# Team Memory\n- Einstein: researcher');
    const packet = assembleContextPacket('telegram_science-claw', false);
    expect(packet).toContain('Einstein');
  });

  it('reads current.md for priorities', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('current.md'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('## Top 3\n1) Grant deadline Friday');
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Grant deadline');
  });

  it('truncates to max size', () => {
    vi.mocked(getRecentMessages).mockReturnValue(
      Array.from({ length: 200 }, (_, i) => ({
        sender: 'user', content: 'x'.repeat(100), timestamp: '2026-03-20T10:00:00Z',
      })),
    );
    const packet = assembleContextPacket('main', true);
    expect(packet.length).toBeLessThanOrEqual(8200);
  });
});
```

- [ ] **Run to verify failure:** `npx vitest run src/context-assembler.test.ts`
  Expected: FAIL — module `./context-assembler.js` not found

- [ ] **Commit:** `test: add context assembler tests`

### Step 2.2: Implement context assembler

- [ ] **Create `src/context-assembler.ts`:**

```typescript
/**
 * Context Assembler for NanoClaw
 *
 * Pre-assembles a context packet for each agent container, including:
 * - Current date/time/timezone
 * - Group memory.md content
 * - current.md priorities
 * - Recent messages in the group
 * - Active scheduled tasks
 * - Pending message bus items
 *
 * Eliminates the 10-30s cold start where agents query
 * SimpleMem, QMD, and state files before responding.
 */
import fs from 'fs';
import path from 'path';

import {
  CONTEXT_PACKET_MAX_SIZE,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { getRecentMessages, getAllTasks } from './db.js';

export function assembleContextPacket(
  groupFolder: string,
  isMain: boolean,
): string {
  const sections: string[] = [];

  // 1. Date and timezone
  const now = new Date();
  sections.push(
    `Current date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
  );
  sections.push(
    `Current time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`,
  );
  sections.push(`Timezone: ${TIMEZONE}`);

  // 2. Group memory.md
  const memoryPath = path.join(GROUPS_DIR, groupFolder, 'memory.md');
  if (fs.existsSync(memoryPath)) {
    const memory = fs.readFileSync(memoryPath, 'utf-8');
    if (memory.trim()) {
      sections.push(`\n--- Group Memory ---\n${memory.slice(0, 2000)}`);
    }
  }

  // 3. current.md priorities
  const currentPath = path.join(GROUPS_DIR, 'global', 'state', 'current.md');
  if (fs.existsSync(currentPath)) {
    const current = fs.readFileSync(currentPath, 'utf-8');
    if (current.trim()) {
      sections.push(`\n--- Current Priorities ---\n${current.slice(0, 1500)}`);
    }
  }

  // 4. Recent messages (last 10)
  try {
    const messages = getRecentMessages(groupFolder);
    if (messages.length > 0) {
      const formatted = messages
        .slice(-10)
        .map(
          (m) =>
            `[${new Date(m.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}] ${m.sender}: ${m.content.slice(0, 200)}`,
        )
        .join('\n');
      sections.push(`\n--- Recent messages ---\n${formatted}`);
    }
  } catch {
    // DB not initialized yet or query failed, skip
  }

  // 5. Active scheduled tasks
  try {
    const tasks = getAllTasks();
    const groupTasks = tasks
      .filter((t) => t.status === 'active')
      .filter((t) => isMain || t.group_folder === groupFolder);
    if (groupTasks.length > 0) {
      const formatted = groupTasks
        .map(
          (t) =>
            `- ${t.prompt.slice(0, 80)}... (${t.schedule_type}: ${t.schedule_value})`,
        )
        .join('\n');
      sections.push(`\n--- Scheduled tasks ---\n${formatted}`);
    }
  } catch {
    // DB not initialized, skip
  }

  // 6. Message bus items pending for this group
  const busQueuePath = path.join(
    process.cwd(),
    'data',
    'bus',
    'agents',
    groupFolder,
    'queue.json',
  );
  if (fs.existsSync(busQueuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(busQueuePath, 'utf-8'));
      if (Array.isArray(queue) && queue.length > 0) {
        const formatted = queue
          .slice(0, 5)
          .map(
            (item: { from: string; finding: string }) =>
              `- From ${item.from}: ${(item.finding || '').slice(0, 150)}`,
          )
          .join('\n');
        sections.push(
          `\n--- Pending items from other agents ---\n${formatted}`,
        );
      }
    } catch {
      // Malformed queue, skip
    }
  }

  // Assemble and truncate
  let packet = sections.join('\n');
  if (packet.length > CONTEXT_PACKET_MAX_SIZE) {
    packet = packet.slice(0, CONTEXT_PACKET_MAX_SIZE) + '\n[...truncated]';
  }

  return packet;
}

/**
 * Write the context packet + bus queue to the group's IPC directory
 * so the container can read them at startup.
 */
export function writeContextPacket(
  groupFolder: string,
  isMain: boolean,
  ipcDir: string,
): void {
  const packet = assembleContextPacket(groupFolder, isMain);
  const packetPath = path.join(ipcDir, 'context-packet.txt');
  fs.writeFileSync(packetPath, packet);

  // Also copy bus queue if it exists, then clear it (agent will process)
  const busQueueSrc = path.join(
    process.cwd(),
    'data',
    'bus',
    'agents',
    groupFolder,
    'queue.json',
  );
  const busQueueDst = path.join(ipcDir, 'bus-queue.json');
  if (fs.existsSync(busQueueSrc)) {
    fs.copyFileSync(busQueueSrc, busQueueDst);
    fs.writeFileSync(busQueueSrc, '[]');
  }
}
```

- [ ] **Run tests:** `npx vitest run src/context-assembler.test.ts`
  Expected: All pass

- [ ] **Commit:** `feat: implement context assembler`

### Step 2.3: Wire into container-runner.ts

- [ ] **Add import at top of `src/container-runner.ts`:**

```typescript
import { writeContextPacket } from './context-assembler.js';
```

- [ ] **Add call in `runContainerAgent` (line ~370, BEFORE the `return new Promise` at line 387). Insert after the container args are built and logs are written:**

```typescript
  // Pre-assemble context packet for the agent
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  writeContextPacket(group.folder, input.isMain, groupIpcDir);
```

Note: `resolveGroupIpcPath` is already imported at line 19.

- [ ] **Build:** `npm run build`
- [ ] **Commit:** `feat: inject context packet before container spawn`

### Step 2.4: Read context packet in agent runner

- [ ] **Modify `container/agent-runner/src/index.ts` — after the `globalClaudeMd` loading (line 370-373), add:**

```typescript
  // Load precomputed context packet (assembled by host before container start)
  const contextPacketPath = '/workspace/ipc/context-packet.txt';
  let contextPacket = '';
  if (fs.existsSync(contextPacketPath)) {
    contextPacket = fs.readFileSync(contextPacketPath, 'utf-8');
    log(`Loaded context packet (${contextPacket.length} chars)`);
  }

  // Combine global instructions + context packet for system prompt
  const systemPromptAppend = [globalClaudeMd, contextPacket]
    .filter(Boolean)
    .join('\n\n---\n\n');
```

- [ ] **Then update the systemPrompt option (line 399-400) from:**

```typescript
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
```

**To:**

```typescript
      systemPrompt: systemPromptAppend
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend }
        : undefined,
```

- [ ] **Build:** `npm run build`
- [ ] **Test:** `npm test` — all 333+ tests pass
- [ ] **Commit:** `feat: agent runner reads precomputed context packet`

---

## Task 3: Health Monitor

Lightweight deterministic loop that watches container spawn rates, error rates, and auto-pauses runaway groups. Sends alerts via Telegram.

**Files:**
- Create: `src/health-monitor.ts`
- Create: `src/health-monitor.test.ts`
- Modify: `src/index.ts` (line 701+ in `main()`)
- Modify: `src/config.ts` (already done in Task 1)

### Step 3.1: Write failing tests

- [ ] **Create `src/health-monitor.test.ts`:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthMonitor } from './health-monitor.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;
  let alertFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    alertFn = vi.fn();
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: alertFn,
    });
  });

  it('tracks container spawns', () => {
    monitor.recordSpawn('main');
    expect(monitor.getSpawnCount('main', 3600_000)).toBe(1);
  });

  it('alerts when spawn rate exceeds threshold', () => {
    for (let i = 0; i < 31; i++) {
      monitor.recordSpawn('main');
    }
    const alerts = monitor.checkThresholds();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toMatchObject({ type: 'excessive_spawns', group: 'main' });
    expect(alertFn).toHaveBeenCalled();
  });

  it('tracks errors by group', () => {
    monitor.recordError('main', 'Container timeout');
    expect(monitor.getErrorCount('main', 3600_000)).toBe(1);
  });

  it('alerts when error rate exceeds threshold', () => {
    for (let i = 0; i < 21; i++) {
      monitor.recordError('main', 'fail');
    }
    const alerts = monitor.checkThresholds();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toMatchObject({ type: 'excessive_errors', group: 'main' });
  });

  it('pauses and resumes groups', () => {
    monitor.pauseGroup('main', 'test');
    expect(monitor.isGroupPaused('main')).toBe(true);
    monitor.resumeGroup('main');
    expect(monitor.isGroupPaused('main')).toBe(false);
  });

  it('only counts events within the time window', () => {
    // Inject an old event directly
    monitor['spawnLog'].push({ group: 'main', timestamp: Date.now() - 7200_000 });
    monitor.recordSpawn('main');
    expect(monitor.getSpawnCount('main', 3600_000)).toBe(1);
  });

  it('returns status summary', () => {
    monitor.recordSpawn('main');
    monitor.recordError('main', 'test');
    const status = monitor.getStatus();
    expect(status['main']).toMatchObject({
      spawns_1h: 1,
      errors_1h: 1,
      paused: false,
    });
  });
});
```

- [ ] **Run to verify failure:** `npx vitest run src/health-monitor.test.ts`
- [ ] **Commit:** `test: add health monitor tests`

### Step 3.2: Implement health monitor

- [ ] **Create `src/health-monitor.ts`:**

```typescript
/**
 * System Health Monitor for NanoClaw
 *
 * Deterministic monitoring (no LLM calls). Tracks:
 * - Container spawn rates per group (detects runaway tasks)
 * - Error rates per group (detects degraded performance)
 *
 * Alerts via callback. In-memory only (resets on restart — acceptable
 * since the 2-hour sliding window means most state rebuilds quickly).
 */
import { logger } from './logger.js';

interface SpawnEvent {
  group: string;
  timestamp: number;
}

interface ErrorEvent {
  group: string;
  message: string;
  timestamp: number;
}

export interface HealthAlert {
  type: 'excessive_spawns' | 'excessive_errors';
  group: string;
  detail: string;
  timestamp: number;
}

export interface HealthMonitorConfig {
  maxSpawnsPerHour: number;
  maxErrorsPerHour: number;
  onAlert: (alert: HealthAlert) => void;
}

export class HealthMonitor {
  private spawnLog: SpawnEvent[] = [];
  private errorLog: ErrorEvent[] = [];
  private config: HealthMonitorConfig;
  private pausedGroups: Set<string> = new Set();

  constructor(config: HealthMonitorConfig) {
    this.config = config;
  }

  recordSpawn(group: string): void {
    this.spawnLog.push({ group, timestamp: Date.now() });
    this.pruneOldEvents();
  }

  recordError(group: string, message: string): void {
    this.errorLog.push({ group, message, timestamp: Date.now() });
    this.pruneOldEvents();
  }

  getSpawnCount(group: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.spawnLog.filter(
      (e) => e.group === group && e.timestamp > cutoff,
    ).length;
  }

  getErrorCount(group: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.errorLog.filter(
      (e) => e.group === group && e.timestamp > cutoff,
    ).length;
  }

  isGroupPaused(group: string): boolean {
    return this.pausedGroups.has(group);
  }

  pauseGroup(group: string, reason: string): void {
    this.pausedGroups.add(group);
    logger.warn({ group, reason }, 'Group paused by health monitor');
  }

  resumeGroup(group: string): void {
    this.pausedGroups.delete(group);
    logger.info({ group }, 'Group resumed');
  }

  checkThresholds(): HealthAlert[] {
    const alerts: HealthAlert[] = [];
    const windowMs = 3600_000;

    const spawnGroups = new Set(this.spawnLog.map((e) => e.group));
    for (const group of spawnGroups) {
      const count = this.getSpawnCount(group, windowMs);
      if (count > this.config.maxSpawnsPerHour) {
        const alert: HealthAlert = {
          type: 'excessive_spawns',
          group,
          detail: `${count} container spawns in the last hour (threshold: ${this.config.maxSpawnsPerHour})`,
          timestamp: Date.now(),
        };
        alerts.push(alert);
        this.config.onAlert(alert);
      }
    }

    const errorGroups = new Set(this.errorLog.map((e) => e.group));
    for (const group of errorGroups) {
      const count = this.getErrorCount(group, windowMs);
      if (count > this.config.maxErrorsPerHour) {
        const alert: HealthAlert = {
          type: 'excessive_errors',
          group,
          detail: `${count} errors in the last hour (threshold: ${this.config.maxErrorsPerHour})`,
          timestamp: Date.now(),
        };
        alerts.push(alert);
        this.config.onAlert(alert);
      }
    }

    return alerts;
  }

  private pruneOldEvents(): void {
    const cutoff = Date.now() - 2 * 3600_000;
    this.spawnLog = this.spawnLog.filter((e) => e.timestamp > cutoff);
    this.errorLog = this.errorLog.filter((e) => e.timestamp > cutoff);
  }

  getStatus(): Record<string, unknown> {
    const groups = new Set([
      ...this.spawnLog.map((e) => e.group),
      ...this.errorLog.map((e) => e.group),
    ]);
    const status: Record<string, unknown> = {};
    for (const group of groups) {
      status[group] = {
        spawns_1h: this.getSpawnCount(group, 3600_000),
        errors_1h: this.getErrorCount(group, 3600_000),
        paused: this.pausedGroups.has(group),
      };
    }
    return status;
  }
}
```

- [ ] **Run tests:** `npx vitest run src/health-monitor.test.ts`
  Expected: All pass

- [ ] **Commit:** `feat: implement health monitor`

### Step 3.3: Wire into index.ts

- [ ] **Add imports at top of `src/index.ts`:**

```typescript
import { HealthMonitor } from './health-monitor.js';
import {
  MAX_CONTAINER_SPAWNS_PER_HOUR,
  MAX_ERRORS_PER_HOUR,
} from './config.js';
```

(Note: `MAX_CONTAINER_SPAWNS_PER_HOUR` and `MAX_ERRORS_PER_HOUR` need to be added to the existing config import.)

- [ ] **In `main()` (line 701), after `checkMcpEndpoints()` and `loadState()`, add:**

```typescript
  // Health monitor — tracks spawn/error rates, alerts on anomalies
  const healthMonitor = new HealthMonitor({
    maxSpawnsPerHour: MAX_CONTAINER_SPAWNS_PER_HOUR,
    maxErrorsPerHour: MAX_ERRORS_PER_HOUR,
    onAlert: (alert) => {
      logger.error({ alert }, 'Health monitor alert');
      if (alert.group) {
        healthMonitor.pauseGroup(alert.group, alert.detail);
      }
      // Best-effort Telegram notification to main group
      const mainJid = Object.keys(registeredGroups).find(
        (jid) => registeredGroups[jid]?.isMain,
      );
      if (mainJid) {
        const channel = findChannel(channels, mainJid);
        channel?.sendMessage(mainJid, `System alert: ${alert.detail}`).catch(() => {});
      }
    },
  });
```

Note: `findChannel` is already imported at line 55. `channels` is at line 85. `registeredGroups` is loaded by `loadState()`. The JID is the *key* of `registeredGroups`, not a field on the value — this is correct in the code above.

The `onAlert` callback is synchronous (matches the `(alert: HealthAlert) => void` signature). The `sendMessage` call returns a Promise but we fire-and-forget with `.catch(() => {})` to avoid unhandled rejections.

- [ ] **Add `healthMonitor.recordSpawn` to the container spawn path and `healthMonitor.isGroupPaused` check to the message processing path.** These integrations will be in the `startMessageLoop` function and the `runContainerAgent` callback. The exact wiring depends on the callback structure — the key points are:

  1. Before spawning a container, check `healthMonitor.isGroupPaused(group.folder)` and skip if paused
  2. After spawning, call `healthMonitor.recordSpawn(group.folder)`
  3. On container error, call `healthMonitor.recordError(group.folder, errorMessage)`
  4. Run `healthMonitor.checkThresholds()` periodically (in the scheduler loop or a dedicated interval)

- [ ] **Build and test:** `npm run build && npm test`
- [ ] **Commit:** `feat: wire health monitor into main loop`

---

## Task 4: Inter-Agent Message Bus

Filesystem-based pub/sub for inter-agent coordination.

**Files:**
- Create: `src/message-bus.ts`
- Create: `src/message-bus.test.ts`
- Modify: `src/ipc.ts` (extend `IpcDeps`, add `bus_publish` case)
- Modify: `src/index.ts` (initialize bus, pass to IPC deps)
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (add MCP tools)

### Step 4.1: Write failing tests

- [ ] **Create `src/message-bus.test.ts`:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MessageBus } from './message-bus.js';

describe('MessageBus', () => {
  let busDir: string;
  let bus: MessageBus;

  beforeEach(() => {
    busDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-test-'));
    bus = new MessageBus(busDir);
  });

  afterEach(() => {
    fs.rmSync(busDir, { recursive: true, force: true });
  });

  it('publishes a message to the inbox', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe('einstein');
    expect(messages[0].topic).toBe('research');
  });

  it('claims a message atomically', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    const claimed = bus.claim(messages[0].id, 'sep');
    expect(claimed).toBe(true);
    expect(bus.readInbox()).toHaveLength(0);
  });

  it('prevents double-claiming', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    bus.claim(messages[0].id, 'sep');
    expect(bus.claim(messages[0].id, 'jennifer')).toBe(false);
  });

  it('completes a message', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    bus.claim(messages[0].id, 'sep');
    bus.complete(messages[0].id);
    expect(fs.readdirSync(path.join(busDir, 'done'))).toHaveLength(1);
  });

  it('filters messages by topic', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'paper' });
    bus.publish({ from: 'jennifer', topic: 'scheduling', finding: 'meeting' });
    expect(bus.readByTopic('research')).toHaveLength(1);
  });

  it('routes to agent queue when action_needed is set', () => {
    bus.publish({ from: 'einstein', topic: 'research', action_needed: 'sep', finding: 'test' });
    const queue = bus.readAgentQueue('sep');
    expect(queue).toHaveLength(1);
  });

  it('prunes old done messages', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    bus.claim(messages[0].id, 'sep');
    bus.complete(messages[0].id);
    const doneFiles = fs.readdirSync(path.join(busDir, 'done'));
    const donePath = path.join(busDir, 'done', doneFiles[0]);
    const old = new Date(Date.now() - 4 * 24 * 3600_000);
    fs.utimesSync(donePath, old, old);
    bus.pruneOld(3 * 24 * 3600_000);
    expect(fs.readdirSync(path.join(busDir, 'done'))).toHaveLength(0);
  });
});
```

- [ ] **Run to verify failure**
- [ ] **Commit:** `test: add message bus tests`

### Step 4.2: Implement message bus

- [ ] **Create `src/message-bus.ts`:**

```typescript
/**
 * Inter-Agent Message Bus for NanoClaw
 *
 * Filesystem-based pub/sub. No Redis, no RabbitMQ. Debuggable with ls.
 * Survives reboots. Costs zero tokens.
 *
 * Limitation: single-process (NanoClaw is single-process, so this is fine).
 * Bus items are injected into containers via context-assembler at spawn time.
 * Items published during a container's lifetime are only visible on next spawn.
 *
 * Directory structure:
 *   data/bus/
 *   ├── inbox/        New messages
 *   ├── processing/   Claimed by an agent
 *   ├── done/         Completed (retained 72h)
 *   └── agents/
 *       └── {group}/
 *           └── queue.json
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface BusMessage {
  id: string;
  from: string;
  topic: string;
  action_needed?: string;
  priority?: 'low' | 'medium' | 'high';
  finding?: string;
  timestamp: string;
  [key: string]: unknown;
}

export class MessageBus {
  private inboxDir: string;
  private processingDir: string;
  private doneDir: string;
  private agentsDir: string;

  constructor(basePath: string) {
    this.inboxDir = path.join(basePath, 'inbox');
    this.processingDir = path.join(basePath, 'processing');
    this.doneDir = path.join(basePath, 'done');
    this.agentsDir = path.join(basePath, 'agents');

    for (const dir of [this.inboxDir, this.processingDir, this.doneDir, this.agentsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  publish(data: Omit<BusMessage, 'id' | 'timestamp'>): BusMessage {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message: BusMessage = { ...data, id, timestamp: new Date().toISOString() };

    const tmpPath = path.join(this.inboxDir, `.${id}.json.tmp`);
    const finalPath = path.join(this.inboxDir, `${id}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(message, null, 2));
    fs.renameSync(tmpPath, finalPath);

    if (message.action_needed) {
      this.appendToAgentQueue(message.action_needed, message);
    }

    logger.debug({ messageId: id, from: data.from, topic: data.topic }, 'Bus message published');
    return message;
  }

  readInbox(): BusMessage[] {
    return this.readDir(this.inboxDir);
  }

  readByTopic(topic: string): BusMessage[] {
    return this.readInbox().filter((m) => m.topic === topic);
  }

  readAgentQueue(agentOrGroup: string): BusMessage[] {
    const queuePath = path.join(this.agentsDir, agentOrGroup, 'queue.json');
    if (!fs.existsSync(queuePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
    } catch {
      return [];
    }
  }

  claim(messageId: string, claimedBy: string): boolean {
    const inboxPath = path.join(this.inboxDir, `${messageId}.json`);
    const processingPath = path.join(this.processingDir, `${messageId}.json`);
    if (!fs.existsSync(inboxPath)) return false;
    try {
      fs.renameSync(inboxPath, processingPath);
      const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
      data._claimedBy = claimedBy;
      data._claimedAt = new Date().toISOString();
      fs.writeFileSync(processingPath, JSON.stringify(data, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  complete(messageId: string): void {
    const processingPath = path.join(this.processingDir, `${messageId}.json`);
    const donePath = path.join(this.doneDir, `${messageId}.json`);
    if (fs.existsSync(processingPath)) {
      const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
      data._completedAt = new Date().toISOString();
      fs.writeFileSync(donePath, JSON.stringify(data, null, 2));
      fs.unlinkSync(processingPath);
    }
  }

  pruneOld(retentionMs: number): void {
    const cutoff = Date.now() - retentionMs;
    for (const file of fs.readdirSync(this.doneDir)) {
      const filePath = path.join(this.doneDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  }

  private readDir(dir: string): BusMessage[] {
    const messages: BusMessage[] = [];
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      try {
        messages.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')));
      } catch { /* skip malformed */ }
    }
    return messages;
  }

  private appendToAgentQueue(agentOrGroup: string, message: BusMessage): void {
    const agentDir = path.join(this.agentsDir, agentOrGroup);
    fs.mkdirSync(agentDir, { recursive: true });
    const queuePath = path.join(agentDir, 'queue.json');
    let queue: BusMessage[] = [];
    if (fs.existsSync(queuePath)) {
      try { queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8')); } catch { queue = []; }
    }
    queue.push(message);
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  }
}
```

- [ ] **Run tests:** `npx vitest run src/message-bus.test.ts`
  Expected: All pass

- [ ] **Commit:** `feat: implement filesystem-based message bus`

### Step 4.3: Extend IPC to handle bus_publish

- [ ] **Modify `src/ipc.ts` — extend the `IpcDeps` interface (line 20-33):**

Add to the interface:

```typescript
  messageBus?: import('./message-bus.js').MessageBus;
```

- [ ] **Add a case BEFORE the `default:` at line 484:**

```typescript
    case 'bus_publish': {
      if (deps.messageBus) {
        deps.messageBus.publish({
          from: data.from || sourceGroup,
          topic: data.topic,
          finding: data.finding,
          action_needed: data.action_needed,
          priority: data.priority,
        });
        logger.info(
          { from: data.from, topic: data.topic },
          'Bus message published via IPC',
        );
      }
      break;
    }
```

- [ ] **Commit:** `feat: add bus_publish to IPC handler`

### Step 4.4: Initialize bus in index.ts and pass to IPC deps

- [ ] **Add import in `src/index.ts`:**

```typescript
import { MessageBus } from './message-bus.js';
```

- [ ] **In `main()`, after the health monitor initialization, add:**

```typescript
  // Inter-agent message bus
  const messageBus = new MessageBus(path.join(process.cwd(), 'data', 'bus'));
```

- [ ] **Modify the `startIpcWatcher` call (line 851) to include `messageBus`:**

Add `messageBus,` to the deps object passed to `startIpcWatcher`.

- [ ] **Build and test:** `npm run build && npm test`
- [ ] **Commit:** `feat: initialize message bus and pass to IPC`

### Step 4.5: Add MCP tools for agents

- [ ] **Modify `container/agent-runner/src/ipc-mcp-stdio.ts` — add two tools after the existing tool registrations:**

```typescript
// bus_publish — post a finding to the inter-agent message bus
registerTool(
  'bus_publish',
  'Publish a finding or status update to the inter-agent message bus. Other agents subscribed to the topic will see it on their next invocation.',
  {
    topic: z.string().describe('Topic: research, scheduling, lab-ops, personal, or custom'),
    finding: z.string().describe('What you found or want to communicate'),
    action_needed: z.string().optional().describe('Group folder that should act on this (e.g., "telegram_science-claw")'),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
  },
  async (args) => {
    const data = {
      type: 'bus_publish',
      from: groupFolder,
      topic: args.topic,
      finding: args.finding,
      action_needed: args.action_needed,
      priority: args.priority,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{ type: 'text' as const, text: `Published to bus: [${args.topic}] ${args.finding.slice(0, 80)}...` }],
    };
  },
);

// bus_read — read pending items from the message bus
registerTool(
  'bus_read',
  'Read pending messages from other agents. Items are loaded at container start from the bus queue. Note: only includes items published before your current session started.',
  {
    topic: z.string().optional().describe('Filter by topic (optional)'),
  },
  async (args) => {
    const queuePath = '/workspace/ipc/bus-queue.json';
    if (!fs.existsSync(queuePath)) {
      return { content: [{ type: 'text' as const, text: 'No pending bus messages.' }] };
    }
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
      const filtered = args.topic
        ? queue.filter((m: { topic: string }) => m.topic === args.topic)
        : queue;
      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No pending bus messages.' }] };
      }
      const formatted = filtered
        .map((m: { from: string; topic: string; finding: string; priority: string }) =>
          `[${m.priority || 'medium'}] From ${m.from} (${m.topic}): ${m.finding}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `Pending bus messages:\n${formatted}` }] };
    } catch {
      return { content: [{ type: 'text' as const, text: 'Error reading bus queue.' }] };
    }
  },
);
```

- [ ] **Build:** `npm run build`
- [ ] **Commit:** `feat: add bus_publish and bus_read MCP tools for agents`

---

## Task 5: Integration Validation

### Step 5.1: Build, test, clear cache

- [ ] **Full build and test:**

```bash
npm run build && npm test
```

Expected: All tests pass (333+ existing + new context/health/bus tests).

- [ ] **Clear agent-runner cache and restart:**

```bash
rm -rf data/sessions/*/agent-runner-src/
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 5.2: Verify context packet loading

- [ ] **Send a message to any group and check container logs:**

```bash
tail -100 logs/nanoclaw.log | grep "context packet"
```

Expected: `Loaded context packet (N chars)` in the container stderr.

### Step 5.3: Verify health monitor

- [ ] **Check logs for health monitor initialization:**

```bash
tail -50 logs/nanoclaw.log | grep -i "health\|monitor\|spawn"
```

### Step 5.4: Verify bus

- [ ] **Check bus directory was created:**

```bash
ls -la data/bus/
```

Expected: `inbox/`, `processing/`, `done/`, `agents/` directories.

### Step 5.5: Final commit and push

- [ ] **Commit all remaining changes:**

```bash
git add -A
git commit -m "feat: Phase 1 complete — context assembler, health monitor, message bus

Three infrastructure components for the VISION:
1. Context assembler: pre-builds context packets (date, memory, priorities,
   recent messages, tasks, bus items) so agents never start cold
2. Health monitor: tracks spawn/error rates per group, auto-pauses runaway
   groups, alerts via Telegram
3. Message bus: filesystem pub/sub (data/bus/) for inter-agent coordination
   with bus_publish and bus_read MCP tools

Prerequisites for Phase 2 (Ollama tier, event-driven perception)."

git push
```

---

## Known Limitations (Acceptable for Phase 1)

1. **Bus items are snapshot-at-spawn**: Items published by other agents after a container starts are only visible on the next container invocation. Acceptable because containers are short-lived (minutes) and the bus is designed for async coordination, not real-time chat.

2. **Health monitor state is in-memory only**: Resets on NanoClaw restart. Acceptable because the 2-hour sliding window rebuilds quickly and restarts are infrequent.

3. **Context packet in system prompt**: The packet is injected once at session start and can't update during a long session. Acceptable because sessions are typically short (one message → response) and the SDK's session resume handles multi-turn context.

4. **Single-process bus**: The `renameSync` claim is atomic only because NanoClaw is single-process. If ever multi-process, need file locking. Not a concern for current architecture.

---

## Phase 2 Preview (Next Plan)

Phase 2 builds on this infrastructure:

1. **Ollama classification tier** — local models classify incoming events into structured JSON
2. **Event-driven email** — Gmail push notifications replace 8-hour polling cron
3. **Event-driven calendar** — EventKit callbacks instead of periodic sync
4. **Structured agent outputs** — agents write to the bus in structured format, enabling Claire to compose briefings from pre-digested data

Each uses: the message bus (routing), the context assembler (injecting Ollama outputs into Claude sessions), and the health monitor (catching anomalies in the event pipeline).
