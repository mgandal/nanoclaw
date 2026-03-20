# Vision Phase 1: Infrastructure Foundation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three infrastructure components that every subsequent vision phase depends on: precomputed context injection (eliminates cold starts), the system health monitor (prevents runaway costs), and the inter-agent message bus (enables agent coordination without human routing).

**Architecture:** Extend NanoClaw's existing Node.js orchestrator, IPC filesystem, and container runner. No new services — just new modules within the existing process. The message bus uses the existing `data/ipc/` filesystem pattern. The context assembler is a host-side script that runs before each container spawn. The health monitor is a lightweight loop within the main process.

**Tech Stack:** TypeScript (Node.js), SQLite (better-sqlite3), filesystem IPC (JSON), existing container-runner.ts, existing config.ts.

**Spec:** `docs/VISION3.md` — sections "Token Conservation", "System Self-Awareness", and "How They Coordinate"

**Phase Roadmap:**
- **Phase 1 (this plan):** Precomputed context, anomaly monitor, message bus
- **Phase 2:** Ollama classification tier, event-driven email/calendar perception
- **Phase 3:** Trust/autonomy framework, knowledge graph (Layer 5)
- **Phase 4:** Coherent temporal identity, advanced judgment under ambiguity

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

| File | Changes |
|------|---------|
| `src/container-runner.ts` | Call context assembler before container spawn, inject context packet as env var or file |
| `src/index.ts` | Start health monitor loop, initialize message bus |
| `src/config.ts` | Add health monitor thresholds and bus configuration |
| `src/ipc.ts` | Wire message bus events into IPC handler |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `bus_publish` and `bus_read` MCP tools for agents |

---

## Task 1: Precomputed Context Assembler

The single highest-impact change. Instead of agents spending 10-30 seconds querying SimpleMem, QMD, and state files at session start, the host pre-assembles a context packet and injects it into the container.

**Files:**
- Create: `src/context-assembler.ts`
- Create: `src/context-assembler.test.ts`
- Modify: `src/container-runner.ts:294-310` (inject context before spawn)
- Modify: `src/config.ts` (add context config)
- Modify: `container/agent-runner/src/index.ts:370-400` (read injected context into system prompt)

### Step 1.1: Define context packet schema and config

- [ ] **Add context config to `src/config.ts`**

```typescript
// Context assembler configuration
export const CONTEXT_PACKET_MAX_SIZE = parseInt(
  process.env.CONTEXT_PACKET_MAX_SIZE || '8000',
  10,
); // max chars for context packet
```

- [ ] **Commit:** `feat: add context assembler config`

### Step 1.2: Write failing tests for context assembler

- [ ] **Create `src/context-assembler.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assembleContextPacket } from './context-assembler.js';

// Mock filesystem
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

// Mock db
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
    const { getRecentMessages } = require('./db.js');
    getRecentMessages.mockReturnValue([
      { sender: 'user1', content: 'hello', timestamp: '2026-03-20T10:00:00Z' },
    ]);
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Recent messages');
    expect(packet).toContain('hello');
  });

  it('includes active scheduled tasks', () => {
    const { getAllTasks } = require('./db.js');
    getAllTasks.mockReturnValue([
      { id: 'task-1', prompt: 'Morning briefing', schedule_value: '0 7 * * 1-5', status: 'active', group_folder: 'main' },
    ]);
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Scheduled tasks');
    expect(packet).toContain('Morning briefing');
  });

  it('reads group memory.md if it exists', () => {
    const fs = require('fs').default;
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('# Team Memory\n- Einstein: researcher');
    const packet = assembleContextPacket('telegram_science-claw', false);
    expect(packet).toContain('Einstein');
  });

  it('reads current.md for priorities', () => {
    const fs = require('fs').default;
    fs.existsSync.mockImplementation((p: string) => p.includes('current.md'));
    fs.readFileSync.mockReturnValue('## Top 3\n1) Grant deadline Friday');
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Grant deadline');
  });

  it('truncates to max size', () => {
    const { getRecentMessages } = require('./db.js');
    getRecentMessages.mockReturnValue(
      Array.from({ length: 200 }, (_, i) => ({
        sender: 'user', content: 'x'.repeat(100), timestamp: '2026-03-20T10:00:00Z',
      })),
    );
    const packet = assembleContextPacket('main', true);
    expect(packet.length).toBeLessThanOrEqual(8200); // some overhead allowed
  });
});
```

- [ ] **Run tests to verify they fail:**
  Run: `npx vitest run src/context-assembler.test.ts`
  Expected: FAIL — module not found

- [ ] **Commit:** `test: add context assembler tests`

### Step 1.3: Implement context assembler

- [ ] **Create `src/context-assembler.ts`**

```typescript
/**
 * Context Assembler for NanoClaw
 *
 * Pre-assembles a context packet for each agent container, including:
 * - Current date/time/timezone
 * - Recent messages in the group
 * - Active scheduled tasks
 * - Group memory.md content
 * - current.md priorities
 * - Pending message bus items for this group
 *
 * This eliminates the 10-30 second cold start where agents query
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
  sections.push(`Current time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`);
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

  // 4. Recent messages (last 10 in this group's chat)
  try {
    // Find the chat JID for this group
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
    // DB query failed, skip
  }

  // 5. Active scheduled tasks for this group
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
    // DB query failed, skip
  }

  // 6. Message bus items pending for this group (if bus exists)
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
        sections.push(`\n--- Pending items from other agents ---\n${formatted}`);
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
 * Write the context packet to a file in the group's IPC directory
 * so the container can read it at startup.
 */
export function writeContextPacket(
  groupFolder: string,
  isMain: boolean,
  ipcDir: string,
): string {
  const packet = assembleContextPacket(groupFolder, isMain);
  const packetPath = path.join(ipcDir, 'context-packet.txt');
  fs.writeFileSync(packetPath, packet);
  return packetPath;
}
```

- [ ] **Run tests:**
  Run: `npx vitest run src/context-assembler.test.ts`
  Expected: Tests should pass (may need mock adjustments)

- [ ] **Commit:** `feat: implement context assembler`

### Step 1.4: Add `getRecentMessages` to db.ts if missing

- [ ] **Check if `getRecentMessages` exists with the right signature. If not, add it to `src/db.ts`:**

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

- [ ] **Commit:** `feat: add getRecentMessages to db`

### Step 1.5: Wire context assembler into container-runner.ts

- [ ] **Modify `src/container-runner.ts` — in `buildVolumeMounts` or `runContainerAgent`, call `writeContextPacket` before spawning the container:**

In `runContainerAgent`, before the `spawn` call, add:

```typescript
import { writeContextPacket } from './context-assembler.js';

// In runContainerAgent, before spawn:
const groupIpcDir = resolveGroupIpcPath(group.folder);
writeContextPacket(group.folder, input.isMain, groupIpcDir);
```

- [ ] **Modify `container/agent-runner/src/index.ts` — in `runQuery`, read the context packet and prepend to the system prompt:**

In the `runQuery` function, after loading `globalClaudeMd`, add:

```typescript
// Load precomputed context packet (assembled by host before container start)
const contextPacketPath = '/workspace/ipc/context-packet.txt';
let contextPacket = '';
if (fs.existsSync(contextPacketPath)) {
  contextPacket = fs.readFileSync(contextPacketPath, 'utf-8');
  log(`Loaded context packet (${contextPacket.length} chars)`);
}

// Combine into system prompt
const systemPromptAppend = [globalClaudeMd, contextPacket]
  .filter(Boolean)
  .join('\n\n---\n\n');
```

Then use `systemPromptAppend` instead of just `globalClaudeMd` in the systemPrompt option.

- [ ] **Build and test:**
  Run: `npm run build && npm test`
  Expected: All 333+ tests pass

- [ ] **Commit:** `feat: inject precomputed context into agent containers`

---

## Task 2: System Health Monitor

A lightweight deterministic loop (not an LLM) that monitors system health and pauses offending components before they burn tokens.

**Files:**
- Create: `src/health-monitor.ts`
- Create: `src/health-monitor.test.ts`
- Modify: `src/index.ts` (start monitor in `main()`)
- Modify: `src/config.ts` (add thresholds)

### Step 2.1: Define health monitor config

- [ ] **Add to `src/config.ts`:**

```typescript
// Health monitor thresholds
export const HEALTH_MONITOR_INTERVAL = 60_000; // check every 60 seconds
export const MAX_CONTAINER_SPAWNS_PER_HOUR = 30; // alert if exceeded
export const MAX_ERRORS_PER_HOUR = 20; // alert if exceeded
export const MCP_HEALTH_CHECK_INTERVAL = 5 * 60_000; // probe MCP endpoints every 5 minutes
```

- [ ] **Commit:** `feat: add health monitor config`

### Step 2.2: Write failing tests

- [ ] **Create `src/health-monitor.test.ts`:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthMonitor } from './health-monitor.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: vi.fn(),
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
    expect(alerts).toContainEqual(
      expect.objectContaining({ type: 'excessive_spawns', group: 'main' }),
    );
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
    expect(alerts).toContainEqual(
      expect.objectContaining({ type: 'excessive_errors', group: 'main' }),
    );
  });

  it('expires old events from sliding window', () => {
    // Manually inject old timestamps
    monitor['spawnLog'].push({ group: 'main', timestamp: Date.now() - 7200_000 });
    monitor.recordSpawn('main');
    expect(monitor.getSpawnCount('main', 3600_000)).toBe(1); // only the recent one
  });
});
```

- [ ] **Run tests to verify they fail**
- [ ] **Commit:** `test: add health monitor tests`

### Step 2.3: Implement health monitor

- [ ] **Create `src/health-monitor.ts`:**

```typescript
/**
 * System Health Monitor for NanoClaw
 *
 * Lightweight deterministic monitoring (no LLM calls). Tracks:
 * - Container spawn rates per group
 * - Error rates per group
 * - MCP endpoint reachability
 *
 * Alerts via callback when thresholds are exceeded.
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

interface Alert {
  type: 'excessive_spawns' | 'excessive_errors' | 'mcp_unreachable';
  group?: string;
  detail: string;
  timestamp: number;
}

interface HealthMonitorConfig {
  maxSpawnsPerHour: number;
  maxErrorsPerHour: number;
  onAlert: (alert: Alert) => void;
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

  checkThresholds(): Alert[] {
    const alerts: Alert[] = [];
    const windowMs = 3600_000; // 1 hour

    // Check spawn rates per group
    const groups = new Set(this.spawnLog.map((e) => e.group));
    for (const group of groups) {
      const count = this.getSpawnCount(group, windowMs);
      if (count > this.config.maxSpawnsPerHour) {
        const alert: Alert = {
          type: 'excessive_spawns',
          group,
          detail: `${count} container spawns in the last hour (threshold: ${this.config.maxSpawnsPerHour})`,
          timestamp: Date.now(),
        };
        alerts.push(alert);
        this.config.onAlert(alert);
      }
    }

    // Check error rates per group
    const errorGroups = new Set(this.errorLog.map((e) => e.group));
    for (const group of errorGroups) {
      const count = this.getErrorCount(group, windowMs);
      if (count > this.config.maxErrorsPerHour) {
        const alert: Alert = {
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
    const cutoff = Date.now() - 2 * 3600_000; // keep 2 hours
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

- [ ] **Run tests:**
  Run: `npx vitest run src/health-monitor.test.ts`
  Expected: All pass

- [ ] **Commit:** `feat: implement health monitor`

### Step 2.4: Wire health monitor into index.ts

- [ ] **Modify `src/index.ts` — import and start the monitor in `main()`:**

```typescript
import { HealthMonitor } from './health-monitor.js';

// In main(), after initDatabase():
const healthMonitor = new HealthMonitor({
  maxSpawnsPerHour: MAX_CONTAINER_SPAWNS_PER_HOUR,
  maxErrorsPerHour: MAX_ERRORS_PER_HOUR,
  onAlert: async (alert) => {
    logger.error({ alert }, 'Health monitor alert');
    // Auto-pause the offending group
    if (alert.group) {
      healthMonitor.pauseGroup(alert.group, alert.detail);
    }
    // Notify via main group's Telegram
    try {
      const mainJid = Object.values(registeredGroups).find((g) => g.isMain)?.jid;
      if (mainJid) {
        await sendToChat(mainJid, `⚠️ System alert: ${alert.detail}`);
      }
    } catch { /* best effort */ }
  },
});
```

Then in the message processing, call `healthMonitor.recordSpawn` when spawning containers and `healthMonitor.recordError` on container errors. Check `healthMonitor.isGroupPaused(group.folder)` before processing messages.

- [ ] **Build and test:**
  Run: `npm run build && npm test`

- [ ] **Commit:** `feat: wire health monitor into main loop`

---

## Task 3: Inter-Agent Message Bus

A filesystem-based pub/sub system that enables agents to coordinate without you as the router.

**Files:**
- Create: `src/message-bus.ts`
- Create: `src/message-bus.test.ts`
- Modify: `src/ipc.ts` (add `bus_publish` handler)
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (add `bus_publish` and `bus_read` MCP tools)

### Step 3.1: Write failing tests

- [ ] **Create `src/message-bus.test.ts`:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MessageBus, BusMessage } from './message-bus.js';

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
    bus.publish({
      from: 'einstein',
      topic: 'research',
      finding: 'New paper relevant to SFARI grant',
    });
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
    // Inbox should be empty after claim
    expect(bus.readInbox()).toHaveLength(0);
  });

  it('prevents double-claiming', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    bus.claim(messages[0].id, 'sep');
    const secondClaim = bus.claim(messages[0].id, 'jennifer');
    expect(secondClaim).toBe(false);
  });

  it('completes a message', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    bus.claim(messages[0].id, 'sep');
    bus.complete(messages[0].id);
    // Should be in done dir
    const doneFiles = fs.readdirSync(path.join(busDir, 'done'));
    expect(doneFiles.length).toBe(1);
  });

  it('reads messages by topic', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'paper' });
    bus.publish({ from: 'jennifer', topic: 'scheduling', finding: 'meeting' });
    const research = bus.readByTopic('research');
    expect(research).toHaveLength(1);
    expect(research[0].from).toBe('einstein');
  });

  it('reads agent queue', () => {
    bus.publish({ from: 'einstein', topic: 'research', action_needed: 'sep', finding: 'test' });
    const queue = bus.readAgentQueue('sep');
    expect(queue).toHaveLength(1);
  });

  it('prunes old done messages', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    bus.claim(messages[0].id, 'sep');
    bus.complete(messages[0].id);
    // Manually backdate the done file
    const doneFiles = fs.readdirSync(path.join(busDir, 'done'));
    const donePath = path.join(busDir, 'done', doneFiles[0]);
    const old = new Date(Date.now() - 4 * 24 * 3600_000); // 4 days ago
    fs.utimesSync(donePath, old, old);
    bus.pruneOld(3 * 24 * 3600_000); // 72h retention
    expect(fs.readdirSync(path.join(busDir, 'done'))).toHaveLength(0);
  });
});
```

- [ ] **Run to verify failure**
- [ ] **Commit:** `test: add message bus tests`

### Step 3.2: Implement message bus

- [ ] **Create `src/message-bus.ts`:**

```typescript
/**
 * Inter-Agent Message Bus for NanoClaw
 *
 * Filesystem-based pub/sub. No Redis, no RabbitMQ. Debuggable with ls.
 * Survives reboots. Costs zero tokens.
 *
 * Directory structure:
 *   data/bus/
 *   ├── inbox/           New messages (timestamped JSON)
 *   ├── processing/      Claimed by an agent (moved atomically)
 *   ├── done/            Completed (retained 72h for undo)
 *   └── agents/
 *       └── {group}/
 *           └── queue.json  Items waiting for this agent
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
  timestamp: string;
  [key: string]: unknown;
}

export class MessageBus {
  private basePath: string;
  private inboxDir: string;
  private processingDir: string;
  private doneDir: string;
  private agentsDir: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    this.inboxDir = path.join(basePath, 'inbox');
    this.processingDir = path.join(basePath, 'processing');
    this.doneDir = path.join(basePath, 'done');
    this.agentsDir = path.join(basePath, 'agents');

    for (const dir of [
      this.inboxDir,
      this.processingDir,
      this.doneDir,
      this.agentsDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  publish(data: Omit<BusMessage, 'id' | 'timestamp'>): BusMessage {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message: BusMessage = {
      ...data,
      id,
      timestamp: new Date().toISOString(),
    };

    const filename = `${id}.json`;
    const tmpPath = path.join(this.inboxDir, `.${filename}.tmp`);
    const finalPath = path.join(this.inboxDir, filename);

    fs.writeFileSync(tmpPath, JSON.stringify(message, null, 2));
    fs.renameSync(tmpPath, finalPath); // atomic

    // Update agent queues if action_needed is specified
    if (message.action_needed) {
      this.appendToAgentQueue(message.action_needed, message);
    }

    logger.debug(
      { messageId: id, from: data.from, topic: data.topic },
      'Bus message published',
    );

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
      // Atomic move = claim
      fs.renameSync(inboxPath, processingPath);

      // Add claimedBy metadata
      const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
      data._claimedBy = claimedBy;
      data._claimedAt = new Date().toISOString();
      fs.writeFileSync(processingPath, JSON.stringify(data, null, 2));

      return true;
    } catch {
      return false; // race condition — someone else claimed it
    }
  }

  complete(messageId: string): void {
    const processingPath = path.join(
      this.processingDir,
      `${messageId}.json`,
    );
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
        const data = JSON.parse(
          fs.readFileSync(path.join(dir, file), 'utf-8'),
        );
        messages.push(data);
      } catch {
        // Malformed file, skip
      }
    }
    return messages;
  }

  private appendToAgentQueue(
    agentOrGroup: string,
    message: BusMessage,
  ): void {
    const agentDir = path.join(this.agentsDir, agentOrGroup);
    fs.mkdirSync(agentDir, { recursive: true });
    const queuePath = path.join(agentDir, 'queue.json');

    let queue: BusMessage[] = [];
    if (fs.existsSync(queuePath)) {
      try {
        queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
      } catch {
        queue = [];
      }
    }
    queue.push(message);
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  }
}
```

- [ ] **Run tests:**
  Run: `npx vitest run src/message-bus.test.ts`
  Expected: All pass

- [ ] **Commit:** `feat: implement filesystem-based message bus`

### Step 3.3: Add MCP tools for agents to use the bus

- [ ] **Modify `container/agent-runner/src/ipc-mcp-stdio.ts` — add `bus_publish` and `bus_read` tools:**

Add two new tools that agents can call to publish findings and read items from other agents. These write/read JSON files in the IPC tasks directory, which the host's IPC handler processes.

```typescript
// bus_publish — publish a finding/request to the inter-agent message bus
registerTool(
  'bus_publish',
  'Publish a finding, request, or status update to the inter-agent message bus. Other agents subscribed to the topic will see it.',
  {
    topic: z.string().describe('Topic tag: research, scheduling, lab-ops, personal, or custom'),
    finding: z.string().describe('What you found or want to communicate'),
    action_needed: z.string().optional().describe('Agent/group that should act on this (e.g., "sep", "jennifer")'),
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
      content: [{ type: 'text' as const, text: `Published to bus: topic=${args.topic}, finding=${args.finding.slice(0, 80)}...` }],
    };
  },
);

// bus_read — read pending items from the message bus for this group
registerTool(
  'bus_read',
  'Read pending messages from the inter-agent bus for your group. Returns items other agents published that need your attention.',
  {
    topic: z.string().optional().describe('Filter by topic (optional)'),
  },
  async (args) => {
    // Read from the context packet (pre-assembled by host) or the queue file
    const queuePath = `/workspace/ipc/bus-queue.json`;
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
          `[${m.priority || 'medium'}] From ${m.from}: ${m.finding}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `Pending bus messages:\n${formatted}` }] };
    } catch {
      return { content: [{ type: 'text' as const, text: 'Error reading bus queue.' }] };
    }
  },
);
```

- [ ] **Modify `src/ipc.ts` — handle `bus_publish` events:**

Add a case in the IPC task handler:

```typescript
case 'bus_publish':
  if (deps.messageBus) {
    deps.messageBus.publish({
      from: data.from || sourceGroup,
      topic: data.topic,
      finding: data.finding,
      action_needed: data.action_needed,
      priority: data.priority,
    });
  }
  break;
```

- [ ] **Modify `src/index.ts` — initialize the message bus and pass to IPC:**

```typescript
import { MessageBus } from './message-bus.js';

// In main():
const messageBus = new MessageBus(path.join(process.cwd(), 'data', 'bus'));
```

Pass `messageBus` to the IPC handler dependencies.

- [ ] **Wire bus queue into context assembler** — before each container spawn, write the group's bus queue to `/workspace/ipc/bus-queue.json`:

```typescript
// In context-assembler.ts writeContextPacket, also write bus queue:
const busQueueSrc = path.join(process.cwd(), 'data', 'bus', 'agents', groupFolder, 'queue.json');
const busQueueDst = path.join(ipcDir, 'bus-queue.json');
if (fs.existsSync(busQueueSrc)) {
  fs.copyFileSync(busQueueSrc, busQueueDst);
  // Clear the queue after copying (agent will process it)
  fs.writeFileSync(busQueueSrc, '[]');
}
```

- [ ] **Build and test:**
  Run: `npm run build && npm test`

- [ ] **Commit:** `feat: add message bus MCP tools and IPC handling`

### Step 3.4: Add `mcp__nanoclaw__bus_*` to allowed tools in agent runner

- [ ] **Modify `container/agent-runner/src/index.ts` — the tools are already under `mcp__nanoclaw__*` wildcard, so no change needed if the tools are registered on the nanoclaw MCP server.**

  Verify by checking that `ipc-mcp-stdio.ts` registers the tools (already done in 3.3).

- [ ] **Clear agent-runner cache and restart:**

```bash
rm -rf data/sessions/*/agent-runner-src/
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Commit:** `feat: enable bus tools in agent containers`

---

## Task 4: Integration Test — End-to-End Validation

### Step 4.1: Manual validation

- [ ] **Send a message to SCIENCE-claw and verify the context packet is loaded:**

  Check container logs for `Loaded context packet (N chars)`.

- [ ] **Verify health monitor is running:**

  Check logs for health-related entries. Trigger a test by sending several rapid messages and verifying spawn counts are tracked.

- [ ] **Test bus_publish from an agent:**

  Tell Einstein in SCIENCE-claw: "Post a finding to the bus about the new spatial transcriptomics dataset."

  Verify a JSON file appears in `data/bus/inbox/`.

- [ ] **Verify context assembler includes bus items:**

  If Einstein published a finding for Sep, verify Sep's next container run includes it in the context packet.

### Step 4.2: Commit and push

- [ ] **Final commit:**

```bash
git add -A
git commit -m "feat: Phase 1 complete — context assembler, health monitor, message bus

Three infrastructure components for the VISION:
1. Context assembler: pre-builds context packets so agents never start cold
2. Health monitor: tracks spawn/error rates, auto-pauses runaway groups
3. Message bus: filesystem-based pub/sub for inter-agent coordination

These are prerequisites for Phase 2 (Ollama tier, event-driven perception)."
```

- [ ] **Push:** `git push`

---

## Phase 2 Preview (Next Plan)

Phase 2 builds on this infrastructure to add:

1. **Ollama classification tier** — local model classifies incoming events (email, calendar, Slack) into structured JSON with confidence scores and routing decisions
2. **Event-driven email perception** — Gmail push notifications + IMAP IDLE replace the 8-hour polling cron
3. **Event-driven calendar perception** — EventKit change callbacks instead of periodic sync
4. **Structured agent outputs** — agents write findings to the bus in structured format, enabling Claire to compose briefings from pre-digested data

Each of these uses the message bus (Task 3) for routing, the context assembler (Task 1) for injecting Ollama's structured outputs into Claude sessions, and the health monitor (Task 2) for catching anomalies in the new event-driven pipeline.
