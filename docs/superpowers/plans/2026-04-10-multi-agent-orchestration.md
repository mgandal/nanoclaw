# Multi-Agent Orchestration Implementation Plan

> **Status: SHIPPED 2026-04-13.** All 11 tasks landed (commits `8f4d366e..0b9104e7`). Compound keys (`src/compound-key.ts` with `compoundKey`/`parseCompoundKey`/`compoundKeyToFsPath`/`fsPathToCompoundKey`/`isCompoundKey`), agent registry (`src/agent-registry.ts` 6.3K), bus watcher (`src/bus-watcher.ts` 8.3K), per-message bus (`src/message-bus.ts` 7.2K), and 9 agent identity dirs under `data/agents/{claire,coo,einstein,freud,marvin,simon,steve,vincent,warren}/` (vs 3 originally specified) all live. `agent_registry` table at `src/db.ts:92` (read at `db.ts:1271`). `task-scheduler.ts:11,215,382` plumbs `parseCompoundKey` and `agentName` through. Tests: 67/67 pass across compound-key/agent-registry/trust-enforcement/bus-watcher. Phase 2 (gaps) tracked in `2026-04-14-multi-agent-completion.md`. Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent named agents (Claire, Jennifer, Einstein) that can be invoked within groups, coordinate via message bus, and operate under a trust enforcement layer.

**Architecture:** Compound group keys (`{group}:{agent}`) reuse existing infrastructure (sessions, health monitor, warm pool). Agent identity files live in `data/agents/`. State writes serialize through IPC. Trust enforced at host IPC layer, never inside containers.

**Tech Stack:** TypeScript/Bun, SQLite (better-sqlite3), filesystem-based IPC, YAML (js-yaml), Claude Code Agent SDK

**Spec:** `docs/superpowers/specs/2026-04-09-multi-agent-orchestration-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/compound-key.ts` | Create, parse, encode/decode compound keys |
| `src/agent-registry.ts` | Scan `data/agents/`, validate identity files, manage SQLite registry |
| `src/bus-watcher.ts` | Poll agent bus queues, dispatch to warm/cold containers |
| `data/agents/claire/identity.md` | Claire persona + instructions |
| `data/agents/claire/trust.yaml` | Claire trust levels |
| `data/agents/claire/state.md` | Claire working memory (initially empty) |
| `data/agents/jennifer/identity.md` | Jennifer persona + instructions |
| `data/agents/jennifer/trust.yaml` | Jennifer trust levels |
| `data/agents/jennifer/state.md` | Jennifer working memory |
| `data/agents/einstein/identity.md` | Einstein persona + instructions |
| `data/agents/einstein/trust.yaml` | Einstein trust levels |
| `data/agents/einstein/state.md` | Einstein working memory |

### Modified Files
| File | What Changes |
|------|-------------|
| `src/group-folder.ts:13` | Reject `--` in folder names |
| `src/config.ts:54,86-88,133-135` | New constants, raised limits |
| `src/db.ts:19-91,103-108` | Two new tables, one new column |
| `src/container-runner.ts:66-76,258-265` | `agentName` on ContainerInput, agent mount |
| `src/context-assembler.ts:146-150,237-252` | Agent identity sections, base group JID, read-only bus scan |
| `src/group-queue.ts:17-28` | `agentName` on GroupState |
| `src/message-bus.ts:90-98,153-169` | Per-message files replacing queue.json |
| `src/ipc.ts:91-134,165-203,731-746` | Replace `bus_publish`, add `write_agent_state`, compound auth, trust, path resolution |
| `src/task-scheduler.ts:110-163` | Base-group extraction for compound keys |
| `src/index.ts:275-315,440-540` | Agent detection, bus watcher startup, registry init |
| `container/agent-runner/src/ipc-mcp-stdio.ts:70-95` | Two new tools |
| `container/agent-runner/src/index.ts:228,770` | Honcho aiPeer from agentName |

---

## Task 1: Compound Key Module

**Files:**
- Create: `src/compound-key.ts`
- Create: `src/__tests__/compound-key.test.ts`

- [ ] **Step 1: Write failing tests for compound key helpers**

```typescript
// src/__tests__/compound-key.test.ts
import { describe, it, expect } from 'vitest';
import {
  compoundKey,
  parseCompoundKey,
  compoundKeyToFsPath,
  fsPathToCompoundKey,
  isCompoundKey,
} from '../compound-key';

describe('compound-key', () => {
  describe('compoundKey', () => {
    it('creates a compound key from group and agent', () => {
      expect(compoundKey('telegram_lab-claw', 'einstein')).toBe(
        'telegram_lab-claw:einstein',
      );
    });
  });

  describe('parseCompoundKey', () => {
    it('parses compound key into group and agent', () => {
      expect(parseCompoundKey('telegram_lab-claw:einstein')).toEqual({
        group: 'telegram_lab-claw',
        agent: 'einstein',
      });
    });

    it('returns null agent for plain group key', () => {
      expect(parseCompoundKey('telegram_lab-claw')).toEqual({
        group: 'telegram_lab-claw',
        agent: null,
      });
    });

    it('handles multiple colons by splitting on first', () => {
      expect(parseCompoundKey('telegram_lab-claw:einstein:extra')).toEqual({
        group: 'telegram_lab-claw',
        agent: 'einstein:extra',
      });
    });
  });

  describe('isCompoundKey', () => {
    it('returns true for compound keys', () => {
      expect(isCompoundKey('telegram_lab-claw:einstein')).toBe(true);
    });

    it('returns false for plain keys', () => {
      expect(isCompoundKey('telegram_lab-claw')).toBe(false);
    });
  });

  describe('filesystem encoding', () => {
    it('converts colon to double-dash', () => {
      expect(compoundKeyToFsPath('telegram_lab-claw:einstein')).toBe(
        'telegram_lab-claw--einstein',
      );
    });

    it('converts double-dash back to colon', () => {
      expect(fsPathToCompoundKey('telegram_lab-claw--einstein')).toBe(
        'telegram_lab-claw:einstein',
      );
    });

    it('round-trips correctly', () => {
      const key = 'telegram_science-claw:jennifer';
      expect(fsPathToCompoundKey(compoundKeyToFsPath(key))).toBe(key);
    });

    it('passes through plain keys unchanged', () => {
      expect(compoundKeyToFsPath('telegram_lab-claw')).toBe('telegram_lab-claw');
      expect(fsPathToCompoundKey('telegram_lab-claw')).toBe('telegram_lab-claw');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/__tests__/compound-key.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement compound-key module**

```typescript
// src/compound-key.ts
const SEPARATOR = ':';
const FS_SEPARATOR = '--';

export function compoundKey(groupFolder: string, agentName: string): string {
  return `${groupFolder}${SEPARATOR}${agentName}`;
}

export function parseCompoundKey(key: string): {
  group: string;
  agent: string | null;
} {
  const idx = key.indexOf(SEPARATOR);
  if (idx === -1) return { group: key, agent: null };
  return { group: key.slice(0, idx), agent: key.slice(idx + 1) };
}

export function isCompoundKey(key: string): boolean {
  return key.includes(SEPARATOR);
}

export function compoundKeyToFsPath(key: string): string {
  return key.replace(SEPARATOR, FS_SEPARATOR);
}

export function fsPathToCompoundKey(fsPath: string): string {
  const idx = fsPath.lastIndexOf(FS_SEPARATOR);
  if (idx === -1) return fsPath;
  const group = fsPath.slice(0, idx);
  const agent = fsPath.slice(idx + FS_SEPARATOR.length);
  if (!group || !agent) return fsPath;
  return `${group}${SEPARATOR}${agent}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/__tests__/compound-key.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```
git add src/compound-key.ts src/__tests__/compound-key.test.ts
git commit -m "feat(multi-agent): add compound key module"
```

---

## Task 2: Group Folder Validation and Config Constants

**Files:**
- Modify: `src/group-folder.ts:13`
- Modify: `src/config.ts:54,86-88,133-135`

- [ ] **Step 1: Add failing test for `--` rejection**

Append to `src/__tests__/compound-key.test.ts`:

```typescript
import { isValidGroupFolder } from '../group-folder';

describe('group-folder -- rejection', () => {
  it('rejects folder names containing consecutive hyphens', () => {
    expect(isValidGroupFolder('telegram_lab--claw')).toBe(false);
  });

  it('still allows single hyphens', () => {
    expect(isValidGroupFolder('telegram_lab-claw')).toBe(true);
  });

  it('still allows other valid names', () => {
    expect(isValidGroupFolder('telegram_claire')).toBe(true);
    expect(isValidGroupFolder('CODE-claw')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/__tests__/compound-key.test.ts -t "rejects folder"`
Expected: FAIL (returns true, expected false)

- [ ] **Step 3: Add `--` rejection to isValidGroupFolder**

In `src/group-folder.ts`, add after line 13 (`if (folder.includes('..')) return false;`):

```typescript
  if (folder.includes('--')) return false;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/__tests__/compound-key.test.ts`
Expected: All PASS

- [ ] **Step 5: Update config constants**

In `src/config.ts`:

After line 54 (`export const DATA_DIR = ...`), add:
```typescript
export const AGENTS_DIR = path.join(DATA_DIR, 'agents');
```

Change line 86-88 default from `'5'` to `'8'`:
```typescript
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '8', 10) || 8,
);
```

Change line 133-135 default from `'8000'` to `'16000'`:
```typescript
export const CONTEXT_PACKET_MAX_SIZE = parseInt(
  process.env.CONTEXT_PACKET_MAX_SIZE || '16000',
  10,
);
```

Add after that block:
```typescript
export const BUS_POLL_INTERVAL = parseInt(
  process.env.BUS_POLL_INTERVAL || '30000',
  10,
);
export const BUS_HIGH_PRIORITY_INTERVAL = 5000;
```

- [ ] **Step 6: Run existing tests for regressions**

Run: `bunx vitest run src/config.test.ts src/group-folder.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```
git add src/group-folder.ts src/config.ts src/__tests__/compound-key.test.ts
git commit -m "feat(multi-agent): reject -- in folder names, add agent config constants"
```

---

## Task 3: Database Schema

**Files:**
- Modify: `src/db.ts:19-91,103-108`
- Extend: `src/db.test.ts`

- [ ] **Step 1: Write failing test for new tables**

Add to `src/db.test.ts`:

```typescript
describe('agent tables', () => {
  it('creates agent_registry table', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'")
      .all();
    expect(rows).toHaveLength(1);
  });

  it('creates agent_actions table', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_actions'")
      .all();
    expect(rows).toHaveLength(1);
  });

  it('has agent_name column on scheduled_tasks', () => {
    const info = db.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>;
    expect(info.map((c) => c.name)).toContain('agent_name');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/db.test.ts -t "agent tables"`
Expected: FAIL

- [ ] **Step 3: Add tables and migration**

In `src/db.ts`, inside the `database.exec()` block (after `registered_groups` CREATE TABLE, before closing backtick), add:

```sql
    CREATE TABLE IF NOT EXISTS agent_registry (
      agent_name TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      added_at TEXT NOT NULL,
      PRIMARY KEY (agent_name, group_folder)
    );
    CREATE TABLE IF NOT EXISTS agent_actions (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      action_type TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      summary TEXT NOT NULL,
      target TEXT,
      outcome TEXT DEFAULT 'completed',
      created_at TEXT NOT NULL
    );
```

After existing `addColumn` calls (~line 108), add:

```typescript
  addColumn(`ALTER TABLE scheduled_tasks ADD COLUMN agent_name TEXT`);
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/db.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add src/db.ts src/db.test.ts
git commit -m "feat(multi-agent): add agent_registry, agent_actions tables"
```

---

## Task 4: Agent Registry

**Files:**
- Create: `src/agent-registry.ts`
- Create: `src/__tests__/agent-registry.test.ts`
- Create: `data/agents/{claire,einstein,jennifer}/{identity.md,trust.yaml,state.md}`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/agent-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  scanAgents,
  loadAgentTrust,
  getAgentsForGroup,
  getTrustLevel,
} from '../agent-registry';

describe('agent-registry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, identity: string, trust: string): void {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'identity.md'), identity);
    fs.writeFileSync(path.join(dir, 'trust.yaml'), trust);
  }

  describe('scanAgents', () => {
    it('finds valid agent directories', () => {
      writeAgent(
        'einstein',
        '---\nname: Einstein\nrole: Researcher\ndescription: Science\n---\nPersona',
        'actions:\n  send_message: notify\n',
      );
      const agents = scanAgents(tmpDir);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('Einstein');
    });

    it('skips agents with missing identity.md', () => {
      const dir = path.join(tmpDir, 'broken');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'trust.yaml'), 'actions:\n  x: notify\n');
      expect(scanAgents(tmpDir)).toHaveLength(0);
    });

    it('skips agents with invalid YAML frontmatter', () => {
      writeAgent('bad', '---\n: invalid yaml [[\n---\nBody', 'actions:\n  x: notify\n');
      expect(scanAgents(tmpDir)).toHaveLength(0);
    });

    it('skips agents missing required fields', () => {
      writeAgent('incomplete', '---\nname: Test\n---\nBody', 'actions:\n  x: notify\n');
      expect(scanAgents(tmpDir)).toHaveLength(0);
    });
  });

  describe('loadAgentTrust', () => {
    it('loads trust actions', () => {
      writeAgent(
        'test',
        '---\nname: T\nrole: R\ndescription: D\n---\n',
        'actions:\n  send_message: notify\n  write_vault: autonomous\n',
      );
      const trust = loadAgentTrust(path.join(tmpDir, 'test'));
      expect(trust.actions.send_message).toBe('notify');
      expect(trust.actions.write_vault).toBe('autonomous');
    });

    it('returns empty actions for missing trust.yaml', () => {
      const dir = path.join(tmpDir, 'notrust');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'identity.md'), '---\nname: X\nrole: R\ndescription: D\n---\n');
      expect(loadAgentTrust(dir).actions).toEqual({});
    });
  });

  describe('getTrustLevel', () => {
    it('returns configured level for known actions', () => {
      expect(getTrustLevel({ actions: { x: 'notify' } }, 'x')).toBe('notify');
    });

    it('returns ask for unknown actions', () => {
      expect(getTrustLevel({ actions: {} }, 'x')).toBe('ask');
    });

    it('returns ask for invalid trust levels', () => {
      expect(getTrustLevel({ actions: { x: 'magic' } }, 'x')).toBe('ask');
    });
  });

  describe('getAgentsForGroup', () => {
    it('returns agents registered for a specific group', () => {
      writeAgent('einstein', '---\nname: Einstein\nrole: R\ndescription: D\n---\n', 'actions:\n  x: notify\n');
      const agents = scanAgents(tmpDir);
      const registry = [{ agent_name: 'einstein', group_folder: 'telegram_lab-claw', enabled: 1 }];
      expect(getAgentsForGroup('telegram_lab-claw', agents, registry)).toHaveLength(1);
    });

    it('includes wildcard registrations', () => {
      writeAgent('claire', '---\nname: Claire\nrole: R\ndescription: D\n---\n', 'actions:\n  x: notify\n');
      const agents = scanAgents(tmpDir);
      const registry = [{ agent_name: 'claire', group_folder: '*', enabled: 1 }];
      expect(getAgentsForGroup('any-group', agents, registry)).toHaveLength(1);
    });

    it('excludes disabled agents', () => {
      writeAgent('test', '---\nname: T\nrole: R\ndescription: D\n---\n', 'actions:\n  x: notify\n');
      const agents = scanAgents(tmpDir);
      const registry = [{ agent_name: 'test', group_folder: '*', enabled: 0 }];
      expect(getAgentsForGroup('any-group', agents, registry)).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/__tests__/agent-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement agent-registry**

```typescript
// src/agent-registry.ts
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from './logger';

export interface AgentIdentity {
  name: string;
  role: string;
  description: string;
  dirName: string;
  dirPath: string;
  model?: string;
  urgentTopics?: string[];
  routineTopics?: string[];
  bodyMarkdown: string;
}

export interface AgentTrust {
  actions: Record<string, string>;
}

export interface AgentRegistryRow {
  agent_name: string;
  group_folder: string;
  enabled: number;
}

export function scanAgents(agentsDir: string): AgentIdentity[] {
  if (!fs.existsSync(agentsDir)) return [];
  const agents: AgentIdentity[] = [];

  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(agentsDir, entry.name);
    const identityPath = path.join(dirPath, 'identity.md');

    if (!fs.existsSync(identityPath)) {
      logger.warn({ agent: entry.name }, 'Agent missing identity.md, skipping');
      continue;
    }

    try {
      const identity = loadAgentIdentity(dirPath);
      if (!identity) continue;
      agents.push(identity);
    } catch (err) {
      logger.error({ agent: entry.name, err }, 'Failed to load agent, skipping');
    }
  }

  return agents;
}

export function loadAgentIdentity(dirPath: string): AgentIdentity | null {
  const raw = fs.readFileSync(path.join(dirPath, 'identity.md'), 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    logger.warn({ path: dirPath }, 'No YAML frontmatter found');
    return null;
  }

  let fm: Record<string, unknown>;
  try {
    fm = yaml.load(match[1]) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ path: dirPath, err }, 'Invalid YAML frontmatter');
    return null;
  }

  if (!fm.name || !fm.role || !fm.description) {
    logger.warn({ path: dirPath }, 'Missing required fields (name, role, description)');
    return null;
  }

  return {
    name: String(fm.name),
    role: String(fm.role),
    description: String(fm.description),
    dirName: path.basename(dirPath),
    dirPath,
    model: fm.model ? String(fm.model) : undefined,
    urgentTopics: Array.isArray(fm.urgent_topics) ? fm.urgent_topics.map(String) : undefined,
    routineTopics: Array.isArray(fm.routine_topics) ? fm.routine_topics.map(String) : undefined,
    bodyMarkdown: match[2].trim(),
  };
}

export function loadAgentTrust(dirPath: string): AgentTrust {
  const trustPath = path.join(dirPath, 'trust.yaml');
  if (!fs.existsSync(trustPath)) return { actions: {} };

  try {
    const parsed = yaml.load(fs.readFileSync(trustPath, 'utf-8')) as { actions?: Record<string, string> };
    return { actions: parsed?.actions || {} };
  } catch {
    return { actions: {} };
  }
}

export function getAgentsForGroup(
  groupFolder: string,
  agents: AgentIdentity[],
  registry: AgentRegistryRow[],
): AgentIdentity[] {
  const enabledNames = new Set(
    registry
      .filter((r) => r.enabled === 1 && (r.group_folder === groupFolder || r.group_folder === '*'))
      .map((r) => r.agent_name),
  );
  return agents.filter((a) => enabledNames.has(a.dirName));
}

export function getTrustLevel(trust: AgentTrust, actionType: string): string {
  const level = trust.actions[actionType];
  if (!level || !['autonomous', 'notify', 'draft', 'ask'].includes(level)) return 'ask';
  return level;
}
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/__tests__/agent-registry.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Create agent identity files**

Create these 9 files (see spec Appendix for full content):

`data/agents/claire/identity.md` — Claire Chief of Staff persona
`data/agents/claire/trust.yaml` — send_message=notify, publish_to_bus=autonomous, write_group_memory=autonomous, schedule_task=notify, write_agent_state=autonomous
`data/agents/claire/state.md` — "# Claire - Working State\n\nNo active threads yet."

`data/agents/einstein/identity.md` — Einstein Research Scientist persona
`data/agents/einstein/trust.yaml` — send_message=notify, publish_to_bus=autonomous, write_vault=notify, search_literature=autonomous, write_agent_state=autonomous
`data/agents/einstein/state.md` — "# Einstein - Working State\n\nNo active threads yet."

`data/agents/jennifer/identity.md` — Jennifer Executive Assistant persona
`data/agents/jennifer/trust.yaml` — send_message=notify, send_email=draft, schedule_meeting=notify, publish_to_bus=autonomous, write_agent_state=autonomous
`data/agents/jennifer/state.md` — "# Jennifer - Working State\n\nNo active threads yet."

- [ ] **Step 6: Commit**

```
git add src/agent-registry.ts src/__tests__/agent-registry.test.ts data/agents/
git commit -m "feat(multi-agent): agent registry and identity files"
```

---

## Task 5: Message Bus — Per-Message Files

**Files:**
- Modify: `src/message-bus.ts:90-98,153-169`
- Extend: `src/message-bus.test.ts`

- [ ] **Step 1: Write failing tests for per-message file operations**

Add to `src/message-bus.test.ts`:

```typescript
describe('per-message agent files', () => {
  it('writeAgentMessage writes individual JSON file', () => {
    bus.writeAgentMessage('telegram_lab-claw--einstein', {
      id: 'test-1', from: 'test', topic: 'test_topic',
      timestamp: new Date().toISOString(), summary: 'Test',
    });
    const dir = path.join(busDir, 'agents', 'telegram_lab-claw--einstein');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
  });

  it('listAgentMessages reads all pending JSON files', () => {
    bus.writeAgentMessage('telegram_lab-claw--einstein', { id: '1', from: 'a', topic: 't1', timestamp: new Date().toISOString() });
    bus.writeAgentMessage('telegram_lab-claw--einstein', { id: '2', from: 'b', topic: 't2', timestamp: new Date().toISOString() });
    expect(bus.listAgentMessages('telegram_lab-claw--einstein')).toHaveLength(2);
  });

  it('listAgentMessages ignores .processing files', () => {
    const dir = path.join(busDir, 'agents', 'telegram_lab-claw--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '123-abc.json'), '{"id":"1"}');
    fs.writeFileSync(path.join(dir, '456-def.processing'), '{"id":"2"}');
    expect(bus.listAgentMessages('telegram_lab-claw--einstein')).toHaveLength(1);
  });

  it('claimAgentMessage renames to .processing', () => {
    bus.writeAgentMessage('telegram_lab-claw--einstein', { id: 'c1', from: 'x', topic: 'y', timestamp: new Date().toISOString() });
    const dir = path.join(busDir, 'agents', 'telegram_lab-claw--einstein');
    const [file] = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    bus.claimAgentMessage('telegram_lab-claw--einstein', file);
    const remaining = fs.readdirSync(dir);
    expect(remaining.some((f) => f.endsWith('.processing'))).toBe(true);
    expect(remaining.filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/message-bus.test.ts -t "per-message"`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Add per-message file methods to MessageBus class**

Add these methods to the `MessageBus` class in `src/message-bus.ts`:

```typescript
  writeAgentMessage(agentFsKey: string, message: Partial<BusMessage>): void {
    if (agentFsKey.includes('..') || agentFsKey.includes('/')) return;
    const dir = path.join(this.agentsDir, agentFsKey);
    fs.mkdirSync(dir, { recursive: true });
    const msg: BusMessage = {
      id: message.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: message.from || 'unknown',
      topic: message.topic || '',
      timestamp: message.timestamp || new Date().toISOString(),
      ...message,
    };
    const filename = `${Date.now()}-${msg.id.slice(0, 8)}.json`;
    const tmpPath = path.join(dir, `${filename}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(msg, null, 2));
    fs.renameSync(tmpPath, path.join(dir, filename));
  }

  listAgentMessages(agentFsKey: string): BusMessage[] {
    const dir = path.join(this.agentsDir, agentFsKey);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((file) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')); }
        catch { return null; }
      })
      .filter(Boolean);
  }

  claimAgentMessage(agentFsKey: string, filename: string): boolean {
    try {
      const dir = path.join(this.agentsDir, agentFsKey);
      fs.renameSync(path.join(dir, filename), path.join(dir, filename.replace('.json', '.processing')));
      return true;
    } catch { return false; }
  }

  completeAgentMessage(agentFsKey: string, filename: string): void {
    const dir = path.join(this.agentsDir, agentFsKey);
    const doneDir = path.join(this.baseDir, 'done');
    fs.mkdirSync(doneDir, { recursive: true });
    try {
      fs.renameSync(
        path.join(dir, filename.replace('.json', '.processing')),
        path.join(doneDir, `${agentFsKey}-${filename}`),
      );
    } catch { /* already moved */ }
  }
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/message-bus.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add src/message-bus.ts src/message-bus.test.ts
git commit -m "feat(multi-agent): per-message file bus operations"
```

---

## Task 6: Container-Side IPC Tools and Honcho Fix

**Files:**
- Modify: `src/container-runner.ts:66-76` (ContainerInput)
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:95`
- Modify: `container/agent-runner/src/index.ts:228,770`

- [ ] **Step 1: Add `agentName` to ContainerInput**

In `src/container-runner.ts`, add to the `ContainerInput` interface after the `images` field (~line 75):

```typescript
  agentName?: string;
```

- [ ] **Step 2: Add `publish_to_bus` and `write_agent_state` tools**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, after the `send_file` tool (~line 95), add both tool definitions for `publish_to_bus` and `write_agent_state`. (See spec Section 4 for schemas. The tools write IPC task files to TASKS_DIR with `type: 'publish_to_bus'` and `type: 'write_agent_state'` respectively.)

- [ ] **Step 3: Fix Honcho aiPeer**

In `container/agent-runner/src/index.ts`:

Line 228 — change `containerInput.groupFolder.replace(/^telegram_/, '')` to:
```typescript
containerInput.agentName || containerInput.groupFolder.replace(/^telegram_/, '')
```

Line 770 — same change.

- [ ] **Step 4: Verify container build**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 5: Commit**

```
git add src/container-runner.ts container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/src/index.ts
git commit -m "feat(multi-agent): container IPC tools and Honcho aiPeer fix"
```

---

## Task 7: Host IPC — Auth, Trust, Path Resolution, New Handlers

**Files:**
- Modify: `src/ipc.ts:91-134,165-203,731-746`
- Extend: `src/ipc.test.ts`

- [ ] **Step 1: Write trust enforcement tests**

Add to `src/ipc.test.ts`:

```typescript
import { parseCompoundKey, fsPathToCompoundKey } from '../compound-key';
import { getTrustLevel } from '../agent-registry';

describe('compound key IPC', () => {
  it('extracts base group from compound IPC path', () => {
    const parsed = parseCompoundKey(fsPathToCompoundKey('telegram_lab-claw--einstein'));
    expect(parsed).toEqual({ group: 'telegram_lab-claw', agent: 'einstein' });
  });
});

describe('trust fail-safe', () => {
  it('returns ask for unknown levels', () => {
    expect(getTrustLevel({ actions: { x: 'magic' } }, 'x')).toBe('ask');
  });
  it('returns ask for undefined actions', () => {
    expect(getTrustLevel({ actions: {} }, 'x')).toBe('ask');
  });
});
```

- [ ] **Step 2: Run to confirm these pass** (test already-implemented functions)

Run: `bunx vitest run src/ipc.test.ts -t "compound key IPC|trust fail"`
Expected: PASS

- [ ] **Step 3: Add `/workspace/agent/` path resolution**

In `src/ipc.ts` `resolveContainerFilePathToHost()`, after the `/workspace/extra/` case (~line 130), add:

```typescript
  if (containerFilePath.startsWith('/workspace/agent/')) {
    const { agent } = parseCompoundKey(fsPathToCompoundKey(sourceGroup));
    if (!agent) return null;
    const rel = containerFilePath.slice('/workspace/agent/'.length);
    if (rel.includes('..')) return null;
    return path.join(AGENTS_DIR, agent, rel);
  }
```

Add imports at top:
```typescript
import { parseCompoundKey, fsPathToCompoundKey } from './compound-key';
import { AGENTS_DIR } from './config';
import { loadAgentTrust, getTrustLevel } from './agent-registry';
```

- [ ] **Step 4: Update IPC authorization for compound groups**

At ~line 198-203, replace the authorization check:

```typescript
      const targetGroup = registeredGroups[data.chatJid];
      const baseKey = fsPathToCompoundKey(sourceGroup);
      const { group: baseGroupFolder } = parseCompoundKey(baseKey);
      if (
        isMain ||
        (targetGroup && targetGroup.folder === baseGroupFolder)
      ) {
```

- [ ] **Step 5: Replace `bus_publish` with `publish_to_bus` and add `write_agent_state`**

At ~lines 731-746, replace the `case 'bus_publish'` block with handlers for `publish_to_bus` and `write_agent_state`. (See Task 7 in the earlier detailed plan for exact code.) The `publish_to_bus` handler validates inputs, derives agent identity from filesystem path, and calls `deps.messageBus.writeAgentMessage()`. The `write_agent_state` handler writes atomically to `data/agents/{agent}/state.md`.

- [ ] **Step 6: Run IPC tests**

Run: `bunx vitest run src/ipc.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(multi-agent): compound key auth, trust enforcement, new IPC handlers"
```

---

## Task 8: Container Runner — Agent Mount

**Files:**
- Modify: `src/container-runner.ts:258-265`
- Extend: `src/container-runner.test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/container-runner.test.ts`:

```typescript
describe('agent mount', () => {
  it('includes read-only /workspace/agent/ for compound groups', () => {
    // Test buildVolumeMounts with agentName parameter
    // Verify mount exists, is read-only, points to data/agents/{name}
  });

  it('omits /workspace/agent/ for non-agent containers', () => {
    // Test buildVolumeMounts without agentName
    // Verify no /workspace/agent/ mount
  });
});
```

- [ ] **Step 2: Add agent mount logic**

In `buildVolumeMounts`, add optional `agentName` parameter. After the `additionalMounts` block (~line 265), add the agent mount (read-only). Import `AGENTS_DIR` from config.

- [ ] **Step 3: Pass agentName through to `runContainerAgent`**

Update the call chain so `containerInput.agentName` reaches `buildVolumeMounts`.

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/container-runner.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat(multi-agent): read-only agent mount for compound groups"
```

---

## Task 9: Context Assembler — Agent Identity Sections

**Files:**
- Modify: `src/context-assembler.ts:146-150,237-252`
- Extend: `src/context-assembler.test.ts`

- [ ] **Step 1: Update signature to accept `agentName`**

Change `assembleContextPacket(groupFolder, isMain)` to `assembleContextPacket(groupFolder, isMain, agentName?)`.

- [ ] **Step 2: Add agent identity/state/trust/bus sections**

When `agentName` is provided, read from `data/agents/{agentName}/` and add `<agent-identity>`, `<agent-state>`, `<agent-trust>`, and `<pending-bus-messages>` sections. Bus messages are read-only (scan .json files, do NOT claim or delete).

- [ ] **Step 3: Update existing bus queue read for agent groups**

When `agentName` is set, skip the existing queue.json read-and-clear. The per-message files are handled by the new sections above.

- [ ] **Step 4: Write and run tests**

Test that the packet includes agent identity content when agentName is provided, and excludes it when not.

- [ ] **Step 5: Commit**

```
git add src/context-assembler.ts src/context-assembler.test.ts
git commit -m "feat(multi-agent): agent identity in context packets"
```

---

## Task 10: Group Queue — Compound Key Support

**Files:**
- Modify: `src/group-queue.ts:17-28`
- Extend: `src/group-queue.test.ts`

- [ ] **Step 1: Add `agentName` to GroupState interface**

- [ ] **Step 2: Add `setAgentName` and `getGroupState` helpers**

- [ ] **Step 3: Test compound key state tracking**

- [ ] **Step 4: Commit**

```
git add src/group-queue.ts src/group-queue.test.ts
git commit -m "feat(multi-agent): compound key support in group queue"
```

---

## Task 11: Task Scheduler — Compound Key Extraction

**Files:**
- Modify: `src/task-scheduler.ts:110-163`
- Extend: `src/task-scheduler.test.ts`

- [ ] **Step 1: Extract base group before `resolveGroupFolderPath` call (line 117)**

Use `parseCompoundKey` to get base folder. Pass base folder to `resolveGroupFolderPath` and to the group lookup at line 144.

- [ ] **Step 2: Test that compound key tasks don't throw**

- [ ] **Step 3: Commit**

```
git add src/task-scheduler.ts src/task-scheduler.test.ts
git commit -m "feat(multi-agent): compound key support in task scheduler"
```

---

## Task 12: Bus Watcher

**Files:**
- Create: `src/bus-watcher.ts`
- Create: `src/__tests__/bus-watcher.test.ts`

- [ ] **Step 1: Write tests for poll, dispatch, and priority detection**

- [ ] **Step 2: Implement `BusWatcher` class with `poll()` and `start()`/`stop()` methods**

The watcher scans `data/bus/agents/` directories, claims pending `.json` files, dispatches via callback, moves to `done/` on success or restores on failure.

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```
git add src/bus-watcher.ts src/__tests__/bus-watcher.test.ts
git commit -m "feat(multi-agent): bus watcher for agent message dispatch"
```

---

## Task 13: Main Orchestrator Integration

**Files:**
- Modify: `src/index.ts:275-315,440-540`

- [ ] **Step 1: Initialize agent registry on startup**

Scan `data/agents/`, register Claire to `*`, load registry from SQLite.

- [ ] **Step 2: Add agent routing to message handler**

Detect `@AgentName` mentions, route to compound key. Fall back to Claire if registered.

- [ ] **Step 3: Wire compound key through session management**

Use `effectiveGroupFolder` (compound key when agent detected, plain key otherwise) for session lookup, creation, and persistence.

- [ ] **Step 4: Start bus watcher**

Create `BusWatcher` with dispatch callback that routes through `queue.enqueueMessageCheck`.

- [ ] **Step 5: Build and test**

Run: `bun run build && bunx vitest run src/index.test.ts`
Expected: Compiles, existing tests pass

- [ ] **Step 6: Commit**

```
git add src/index.ts
git commit -m "feat(multi-agent): agent detection, registry, bus watcher in orchestrator"
```

---

## Task 14: Full Build and Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `bunx vitest run`
Expected: All tests PASS

- [ ] **Step 2: TypeScript build**

Run: `bun run build`
Expected: No errors

- [ ] **Step 3: Verify agent files**

Run: `ls data/agents/*/`
Expected: claire/, einstein/, jennifer/ each with identity.md, trust.yaml, state.md

- [ ] **Step 4: Smoke test startup**

Run: `timeout 10 bun run dev 2>&1 | head -20`
Expected: Logs "Loaded agent identities" and "Bus watcher started", no crashes

- [ ] **Step 5: Final summary**

Run: `git log --oneline feature/multi-agent-orchestration --not main`
Expected: ~14 focused commits
