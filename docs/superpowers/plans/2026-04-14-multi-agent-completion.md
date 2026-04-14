# Multi-Agent Orchestration Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining 20% of the Multi-Agent Orchestration spec — trust enforcement, action logging, bus dispatch fix, registry seeding, and agent-aware task scheduling.

**Architecture:** Four workstreams addressing 10 gaps found in audit. Workstream 1 (registry seeding) is foundational — all others depend on agents being in the DB. Workstream 2 (trust + logging) adds security enforcement to every IPC action. Workstream 3 (bus dispatch) fixes the broken async coordination path. Workstream 4 (task scheduler) enables scheduled tasks to run with agent identity.

**Tech Stack:** TypeScript/Bun, vitest, SQLite (bun:sqlite)

**Spec:** `docs/superpowers/specs/2026-04-09-multi-agent-orchestration-design.md`

---

## File Structure

### Workstream 1: Registry Seeding
- **Modify:** `src/db.ts` — add `upsertAgentRegistry()` function
- **Modify:** `src/index.ts` — call upsert after `scanAgents()`

### Workstream 2: Trust Enforcement + Action Logging
- **Modify:** `src/db.ts` — add `insertAgentAction()` function
- **Create:** `src/trust-enforcement.ts` — trust check + action log helper
- **Modify:** `src/ipc.ts` — wrap IPC actions with trust checks, fix send_file auth

### Workstream 3: Bus Dispatch Fix
- **Modify:** `src/index.ts` — fix bus watcher callback to use chatJid properly
- **Modify:** `src/message-bus.ts` — remove old appendToAgentQueue/readAgentQueue, route publish() through writeAgentMessage
- **Modify:** `src/context-assembler.ts` — remove queue.json clearing from writeContextPacket

### Workstream 4: Task Scheduler Agent Support
- **Modify:** `src/task-scheduler.ts` — pass agent_name to runContainerAgent

---

## Task 1: Add upsertAgentRegistry and seed on startup

**Files:**
- Modify: `src/db.ts`
- Modify: `src/index.ts`
- Test: `src/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/db.test.ts`:

```typescript
describe('upsertAgentRegistry', () => {
  it('inserts new agent-group rows', () => {
    upsertAgentRegistry([
      { agent_name: 'einstein', group_folder: 'telegram_science-claw', enabled: 1 },
      { agent_name: 'claire', group_folder: '*', enabled: 1 },
    ]);

    const db = _getTestDb();
    const rows = db.prepare('SELECT * FROM agent_registry ORDER BY agent_name').all();
    expect(rows).toHaveLength(2);
    expect((rows[0] as any).agent_name).toBe('claire');
    expect((rows[1] as any).group_folder).toBe('telegram_science-claw');
  });

  it('updates enabled status on re-upsert', () => {
    upsertAgentRegistry([
      { agent_name: 'einstein', group_folder: 'telegram_science-claw', enabled: 1 },
    ]);
    upsertAgentRegistry([
      { agent_name: 'einstein', group_folder: 'telegram_science-claw', enabled: 0 },
    ]);

    const db = _getTestDb();
    const row = db.prepare('SELECT * FROM agent_registry WHERE agent_name = ?').get('einstein') as any;
    expect(row.enabled).toBe(0);
  });

  it('preserves existing rows not in the new list', () => {
    upsertAgentRegistry([
      { agent_name: 'claire', group_folder: '*', enabled: 1 },
    ]);
    upsertAgentRegistry([
      { agent_name: 'einstein', group_folder: 'telegram_science-claw', enabled: 1 },
    ]);

    const db = _getTestDb();
    const rows = db.prepare('SELECT * FROM agent_registry').all();
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/db.test.ts -t "upsertAgentRegistry"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement upsertAgentRegistry in db.ts**

Add to `src/db.ts`:

```typescript
export interface AgentRegistryInput {
  agent_name: string;
  group_folder: string;
  enabled: number;
}

/**
 * Upsert agent registry rows. Uses INSERT OR REPLACE to update existing rows.
 * Does NOT delete rows missing from the input — preserves manual DB edits.
 */
export function upsertAgentRegistry(rows: AgentRegistryInput[]): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO agent_registry (agent_name, group_folder, enabled, added_at) VALUES (?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    stmt.run(row.agent_name, row.group_folder, row.enabled, now);
  }
}
```

- [ ] **Step 4: Add to db.test.ts imports**

Add `upsertAgentRegistry` to the import list from `./db.js`.

- [ ] **Step 5: Run tests**

Run: `bun --bun vitest run src/db.test.ts -t "upsertAgentRegistry"`
Expected: all 3 PASS.

- [ ] **Step 6: Wire into startup in index.ts**

In `src/index.ts`, after `loadedAgents = scanAgents(AGENTS_DIR);` (line ~927) and before `agentRegistry = getAgentRegistry();` (line ~936), add:

```typescript
  // Seed agent registry from identity.md group lists
  if (loadedAgents.length > 0) {
    const { upsertAgentRegistry } = await import('./db.js');
    const registryRows: Array<{ agent_name: string; group_folder: string; enabled: number }> = [];
    for (const agent of loadedAgents) {
      if (agent.lead) {
        // Lead agents (Claire) are available to all groups
        registryRows.push({ agent_name: agent.dirName, group_folder: '*', enabled: 1 });
      }
      // Register for each group listed in identity.md frontmatter
      for (const g of agent.groups || []) {
        registryRows.push({ agent_name: agent.dirName, group_folder: g, enabled: 1 });
      }
    }
    if (registryRows.length > 0) {
      upsertAgentRegistry(registryRows);
    }
  }
```

- [ ] **Step 7: Run full test suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/db.ts src/db.test.ts src/index.ts
git commit -m "feat(agents): seed agent_registry from identity.md on startup"
```

---

## Task 2: Create trust enforcement module

**Files:**
- Create: `src/trust-enforcement.ts`
- Create: `src/trust-enforcement.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/trust-enforcement.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { checkTrust, type TrustDecision } from './trust-enforcement.js';

describe('checkTrust', () => {
  it('returns allow for autonomous actions', () => {
    const trust = { actions: { send_message: 'autonomous' } };
    const result = checkTrust('einstein', 'telegram_science-claw', 'send_message', trust);
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('autonomous');
    expect(result.notify).toBe(false);
  });

  it('returns allow + notify for notify actions', () => {
    const trust = { actions: { send_message: 'notify' } };
    const result = checkTrust('einstein', 'telegram_science-claw', 'send_message', trust);
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('notify');
    expect(result.notify).toBe(true);
  });

  it('returns blocked for ask actions', () => {
    const trust = { actions: { schedule_meeting: 'ask' } };
    const result = checkTrust('einstein', 'telegram_science-claw', 'schedule_meeting', trust);
    expect(result.allowed).toBe(false);
    expect(result.level).toBe('ask');
  });

  it('returns blocked for draft actions (treated as ask)', () => {
    const trust = { actions: { send_email: 'draft' } };
    const result = checkTrust('einstein', 'telegram_science-claw', 'send_email', trust);
    expect(result.allowed).toBe(false);
    expect(result.level).toBe('draft');
  });

  it('defaults unknown actions to ask (blocked)', () => {
    const trust = { actions: {} };
    const result = checkTrust('einstein', 'telegram_science-claw', 'unknown_action', trust);
    expect(result.allowed).toBe(false);
    expect(result.level).toBe('ask');
  });

  it('returns allow for null trust (no trust file = legacy mode)', () => {
    const result = checkTrust('einstein', 'telegram_science-claw', 'send_message', null);
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('autonomous');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --bun vitest run src/trust-enforcement.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement trust-enforcement.ts**

Create `src/trust-enforcement.ts`:

```typescript
import { logger } from './logger.js';

export interface TrustDecision {
  allowed: boolean;
  level: string;
  notify: boolean;
}

/**
 * Check whether an agent is allowed to perform an action based on trust.yaml.
 * Returns a decision: allowed (execute), level (for logging), notify (post notification).
 *
 * Null trust = legacy mode (no trust file) — all actions allowed.
 */
export function checkTrust(
  agentName: string,
  groupFolder: string,
  actionType: string,
  trust: { actions: Record<string, string> } | null,
): TrustDecision {
  // Legacy mode: no trust file means agent operates without restrictions
  if (!trust) {
    return { allowed: true, level: 'autonomous', notify: false };
  }

  const level = trust.actions[actionType] || 'ask';

  switch (level) {
    case 'autonomous':
      return { allowed: true, level, notify: false };
    case 'notify':
      return { allowed: true, level, notify: true };
    case 'draft':
    case 'ask':
    default:
      logger.info(
        { agentName, groupFolder, actionType, level },
        'Trust: action blocked',
      );
      return { allowed: false, level, notify: false };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun --bun vitest run src/trust-enforcement.test.ts`
Expected: all 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trust-enforcement.ts src/trust-enforcement.test.ts
git commit -m "feat(agents): add trust enforcement module with check + decision types"
```

---

## Task 3: Add insertAgentAction to db.ts

**Files:**
- Modify: `src/db.ts`
- Test: `src/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/db.test.ts`:

```typescript
describe('insertAgentAction', () => {
  it('inserts an action record', () => {
    insertAgentAction({
      agent_name: 'einstein',
      group_folder: 'telegram_science-claw',
      action_type: 'send_message',
      trust_level: 'notify',
      summary: 'Sent research update to group',
      target: 'tg:-1003835885233',
    });

    const db = _getTestDb();
    const rows = db.prepare('SELECT * FROM agent_actions').all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).agent_name).toBe('einstein');
    expect((rows[0] as any).trust_level).toBe('notify');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/db.test.ts -t "insertAgentAction"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement insertAgentAction**

Add to `src/db.ts`:

```typescript
export interface AgentActionInput {
  agent_name: string;
  group_folder: string;
  action_type: string;
  trust_level: string;
  summary: string;
  target?: string;
  outcome?: string;
}

export function insertAgentAction(action: AgentActionInput): void {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    'INSERT INTO agent_actions (id, agent_name, group_folder, action_type, trust_level, summary, target, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    action.agent_name,
    action.group_folder,
    action.action_type,
    action.trust_level,
    action.summary,
    action.target || null,
    action.outcome || 'completed',
    new Date().toISOString(),
  );
}
```

- [ ] **Step 4: Add to imports in db.test.ts**

Add `insertAgentAction` to the import list from `./db.js`.

- [ ] **Step 5: Run tests**

Run: `bun --bun vitest run src/db.test.ts -t "insertAgentAction"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(agents): add insertAgentAction for trust-gated action logging"
```

---

## Task 4: Wire trust enforcement into IPC handlers

**Files:**
- Modify: `src/ipc.ts`
- Test: `src/ipc.test.ts`

This is the largest task. The key changes:
1. Import trust modules
2. Add trust check before `send_message` and `send_file` for compound groups
3. Fix `send_file` base-group extraction (currently broken for compound keys)
4. Log all agent actions to `agent_actions` table
5. Add test coverage

- [ ] **Step 1: Write the failing tests**

Add to `src/ipc.test.ts`:

```typescript
describe('trust enforcement on send_message', () => {
  it('blocks send_message when trust level is ask', async () => {
    // Mock agent trust: send_message = ask
    vi.doMock('./agent-registry.js', () => ({
      loadAgentTrust: vi.fn().mockReturnValue({ actions: { send_message: 'ask' } }),
      getTrustLevel: vi.fn().mockReturnValue('ask'),
    }));

    const sendMessage = vi.fn();
    const testDeps = { ...deps, sendMessage };

    await processTaskIpc(
      { type: 'send_message', chatJid: 'tg:123', text: 'hello' } as any,
      'telegram_science-claw--einstein',
      false,
      testDeps,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('send_file compound key auth', () => {
  it('allows send_file from compound group when base folder matches', async () => {
    const sendFile = vi.fn().mockResolvedValue(undefined);
    const testDeps = { ...deps, sendFile };

    // sourceGroup is compound: telegram_main--claire
    // targetGroup folder is telegram_main — should match
    await processTaskIpc(
      { type: 'send_file', chatJid: 'tg:123', filePath: '/workspace/group/test.txt' } as any,
      'telegram_main--claire',
      false,
      testDeps,
    );

    // Should not be blocked by authorization
    // (may still fail on file-not-found, but auth should pass)
  });
});
```

- [ ] **Step 2: Add trust enforcement to the message IPC handler**

In `src/ipc.ts`, at the top of the file, add imports:

```typescript
import { loadAgentTrust } from './agent-registry.js';
import { checkTrust } from './trust-enforcement.js';
import { insertAgentAction } from './db.js';
```

In the `processIpcMessage` function (the one that handles `send_message` and `send_file`), after the existing authorization check for `send_message` (line ~216), add trust enforcement:

```typescript
                // Trust enforcement for compound groups
                const { agent: sourceAgent } = parseCompoundKey(
                  fsPathToCompoundKey(sourceGroup),
                );
                if (sourceAgent) {
                  const trust = loadAgentTrust(
                    path.join(AGENTS_DIR, sourceAgent),
                  );
                  const decision = checkTrust(
                    sourceAgent,
                    baseGroupFolder,
                    'send_message',
                    trust,
                  );
                  insertAgentAction({
                    agent_name: sourceAgent,
                    group_folder: baseGroupFolder,
                    action_type: 'send_message',
                    trust_level: decision.level,
                    summary: (data.text as string).slice(0, 200),
                    target: data.chatJid as string,
                    outcome: decision.allowed ? 'completed' : 'blocked',
                  });
                  if (!decision.allowed) {
                    logger.info(
                      { agent: sourceAgent, action: 'send_message', level: decision.level },
                      'Trust: send_message blocked',
                    );
                    return;
                  }
                }
```

- [ ] **Step 3: Fix send_file authorization for compound keys**

In `src/ipc.ts`, in the `send_file` case (line ~272), change:

```typescript
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                )
```

To:

```typescript
                const sfBaseKey = fsPathToCompoundKey(sourceGroup);
                const { group: sfBaseGroup } = parseCompoundKey(sfBaseKey);
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sfBaseGroup)
                )
```

- [ ] **Step 4: Run tests**

Run: `bun --bun vitest run src/ipc.test.ts -t "trust enforcement"`
Run: `bun --bun vitest run src/ipc.test.ts -t "send_file compound"`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(agents): add trust enforcement and action logging to IPC handlers

- Trust check on send_message for compound groups
- Fix send_file auth to extract base group from compound key
- Log all agent actions to agent_actions table"
```

---

## Task 5: Fix bus dispatch to use chatJid not compound key

**Files:**
- Modify: `src/index.ts`
- Test: verify via existing bus-watcher tests

- [ ] **Step 1: Fix the bus watcher callback in index.ts**

In `src/index.ts`, find the bus watcher callback (line ~1143). The current code is:

```typescript
        queue.enqueueMessageCheck(cKey);
```

This passes the compound key as the queue key, but `processGroupMessages(chatJid)` looks up `registeredGroups[chatJid]` which requires a real JID. Change the callback to route through `runAgent` directly instead:

```typescript
        // Route bus messages through runAgent with the correct agent name
        const group = registeredGroups[chatJid];
        if (!group) return;

        // Read pending bus messages as the prompt
        const busMessages = messages
          .map((m: any) => `[Bus message from ${m.from}] ${m.summary}`)
          .join('\n');

        void runAgent(
          group,
          busMessages,
          chatJid,
          undefined, // no images
          agent, // agentName from compound key
        );
```

Remove the old `queue.enqueueMessageCheck(cKey)` line.

- [ ] **Step 2: Verify bus watcher tests pass**

Run: `bun --bun vitest run src/bus-watcher.test.ts`
Expected: all pass.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "fix(agents): route bus dispatch through runAgent instead of queue

Bus watcher now calls runAgent(group, busMessages, chatJid, undefined, agentName)
instead of queue.enqueueMessageCheck(compoundKey). The compound key was failing
because processGroupMessages looks up registeredGroups by JID, not compound key."
```

---

## Task 6: Clean up legacy queue.json code paths

**Files:**
- Modify: `src/message-bus.ts`
- Modify: `src/context-assembler.ts`

- [ ] **Step 1: Route publish() through writeAgentMessage instead of appendToAgentQueue**

In `src/message-bus.ts`, in the `publish()` method (line ~72), change:

```typescript
    if (message.action_needed) {
      this.appendToAgentQueue(message.action_needed, message);
    }
```

To:

```typescript
    if (message.action_needed) {
      this.writeAgentMessage(message.action_needed, message);
    }
```

This routes all bus publishes through the per-message file system instead of the legacy queue.json.

- [ ] **Step 2: Remove queue.json clearing from writeContextPacket**

In `src/context-assembler.ts`, find the `writeContextPacket` function section that copies and clears queue.json (lines ~436-450). Remove or comment out the queue.json copy+clear block:

```typescript
  // REMOVED: Legacy queue.json copy+clear — bus messages are now per-file
  // and delivered by the bus watcher, not consumed by context assembly.
```

Keep the rest of `writeContextPacket` unchanged.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: all tests pass. Some existing tests may reference queue.json — check for failures and fix mocks if needed.

- [ ] **Step 4: Commit**

```bash
git add src/message-bus.ts src/context-assembler.ts
git commit -m "refactor(agents): route publish() through per-message files, remove queue.json clearing

publish() now calls writeAgentMessage() instead of appendToAgentQueue().
Context assembler no longer copies+clears queue.json — bus watcher is the
sole authority for message delivery."
```

---

## Task 7: Pass agent_name from scheduled tasks to container

**Files:**
- Modify: `src/task-scheduler.ts`

- [ ] **Step 1: Read the agent_name from the task and pass it to runContainerAgent**

In `src/task-scheduler.ts`, find the `runContainerAgent` call (line ~323). Add `agentName` to the ContainerInput:

```typescript
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        agentName: task.agent_name || undefined,
        script: task.script || undefined,
      },
```

- [ ] **Step 2: Verify the ScheduledTask type includes agent_name**

Check that the `ScheduledTask` interface or type in `src/db.ts` includes `agent_name`. If it does (from the addColumn migration), this change should compile. If not, add it to the interface.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/task-scheduler.ts
git commit -m "feat(agents): pass agent_name from scheduled tasks to container

Scheduled tasks with agent_name now spawn with the correct agent identity,
enabling compound group sessions for scheduled work."
```

---

## Task 8: Add vincent trust.yaml and verify

**Files:**
- Create: `data/agents/vincent/trust.yaml`

- [ ] **Step 1: Create vincent's trust.yaml**

```yaml
actions:
  send_message: notify
  publish_to_bus: autonomous
  write_agent_state: autonomous
  search_literature: autonomous
```

- [ ] **Step 2: Commit**

```bash
git add data/agents/vincent/trust.yaml
git commit -m "chore: add missing trust.yaml for vincent agent"
```

---

## Post-Implementation Checklist

- [ ] All tests pass: `bun run test`
- [ ] Build succeeds: `bun run build` (no non-test errors)
- [ ] agent_registry seeded on startup: verify with `sqlite3 store/messages.db "SELECT * FROM agent_registry;"`
- [ ] Trust enforcement: compound group send_message is checked against trust.yaml
- [ ] Action logging: `sqlite3 store/messages.db "SELECT * FROM agent_actions;"` shows entries after agent session
- [ ] send_file auth: compound groups can send files when base folder matches
- [ ] Bus dispatch: bus watcher routes through runAgent, not processGroupMessages
- [ ] Task scheduler: tasks with agent_name spawn with agent identity
- [ ] No regressions: legacy (non-compound) groups work unchanged
