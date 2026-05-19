# Phase 1.1 — Agent Self-Wakeup (`schedule_wakeup`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `schedule_wakeup` IPC action + MCP tool that lets an in-container agent schedule a one-shot future invocation of itself in the same group, with an optional context blob. Host inserts a `scheduled_tasks` row with `kind='agent_wakeup'`; the existing scheduler fires it unmodified.

**Architecture:** Single atomic commit per the spec's round-1 amendment (the original two-commit split was collapsed to avoid a deployment window where the handler INSERT would crash on a DB without the new `kind` column). Five components: (1) a `kind` column migration on `scheduled_tasks`; (2) two new DB exports — `createWakeupTask` (omits `script`, forces `kind='agent_wakeup'`) and `countActiveWakeups` (per-(group,agent) rate-limit counter); (3) a new `scheduleWakeupHandler` (`notify`-kind, `skipGate: true`, audit row written AFTER successful INSERT to prevent phantom rows on PK collision); (4) handler registration + SKIP_GATE_ALLOWLIST entry; (5) container-side `schedule_wakeup` MCP tool. Rate limit: 10 active wakeups per (group, agent), 5-minute min delay, 7-day max delay.

**Tech Stack:** TypeScript (strict mode), Vitest (testing — invoked via `bun run test`), bun:sqlite (DB-backed tests via `_initTestDatabase()`), `src/ipc/handler.ts` (dispatcher) + `src/ipc/handlers/index.ts` (registry) + `container/agent-runner/src/ipc-mcp-stdio.ts` (MCP tools).

**Spec:** `docs/superpowers/specs/2026-05-19-ipc-agent-self-wakeup-design.md` (commit `13fa035d` round-1 amended). Read it before starting if you have not already — the round-1 amendments header documents the audit-ordering, single-commit, and `authorize()`-time-mutation decisions that this plan implements step-by-step.

---

## File Structure

**Created (2 files):**
- `src/ipc/handlers/schedule-wakeup.ts` — the new handler. ~180 LOC.
- `src/ipc/handlers/schedule-wakeup.test.ts` — 18 handler tests (parse, authorize, execute, integration). ~520 LOC.

**Modified (6 files):**
- `src/db.ts` — add `addColumn` call for `kind` (1 line after line 231); add `createWakeupTask` and `countActiveWakeups` exports near the other `scheduled_tasks` helpers (~50 LOC).
- `src/db.test.ts` — add 3 tests for `createWakeupTask` and `countActiveWakeups`. ~75 LOC.
- `src/ipc/handler.ts:21-43` — add `'schedule_wakeup'` to `SKIP_GATE_ALLOWLIST`. ~2 LOC.
- `src/ipc/handlers/index.ts` — import + register `scheduleWakeupHandler` after `scheduleTaskHandler`. ~2 LOC.
- `src/ipc/handler-post-hoc-notify.test.ts` — append 2 dispatcher-contract tests pinning the skipGate-allowlist behavior (on-allowlist honored / off-allowlist denied) for the new wire type. Pattern mirrors existing Test 6 at lines 341-388. ~80 LOC.
- `container/agent-runner/src/ipc-mcp-stdio.ts` — append `schedule_wakeup` MCP tool after the existing `schedule_task` tool. ~70 LOC.

**Total: 23 new tests** (18 handler + 3 DB + 2 dispatcher).

---

## Pre-flight

### Task 0: Read the spec and inspect the current code

- [ ] **Step 1: Read the spec, especially the round-1 amendments header.**

Run: open `docs/superpowers/specs/2026-05-19-ipc-agent-self-wakeup-design.md`.

The amendments matter:
- §4 audit row MUST be written AFTER the INSERT succeeds.
- §11 is a single commit, not two.
- §2.1 documents the `authorize()`-time input-mutation pattern for `precomputedNextRun` and `chatJid` — this is NOT novel; `scheduleTaskHandler` at `src/ipc/handlers/schedule-task.ts:125,173` already does it with a comment at lines 22-24 calling it out.

- [ ] **Step 2: Read the closest analogue handler.**

Run: open `src/ipc/handlers/schedule-task.ts`.

This is the structural template for `scheduleWakeupHandler` — same `notify`-kind, same DB-write pattern, same `precomputedNextRun` mutation. Pay attention to the `parse → authorize → execute` flow and the JSDoc on the `Input` interface lines 22-26.

- [ ] **Step 3: Read the existing column-migration block.**

Run: open `src/db.ts:214-231`. The `addColumn` helper is a local arrow function at line 215; my new column goes as another `addColumn(...)` call at line 232 (after `permitted_senders`).

- [ ] **Step 4: Read the SKIP_GATE_ALLOWLIST.**

Run: open `src/ipc/handler.ts:21-43`. Notice `task_add`, `task_close`, `task_reopen` are already in the list with the same rationale (writes that bypass the gate; rate-limited inside the handler). `schedule_wakeup` joins this category.

- [ ] **Step 5: Run the full test suite to confirm the starting baseline.**

Run: `bun run test 2>&1 | tail -10`
Expected: All tests pass. Note the count (e.g. "2330 passed"). The end-of-plan acceptance criterion is "baseline + 23 = ~2353".

---

## DB Layer

### Task 1: Add the `kind` column to `scheduled_tasks`

**Files:**
- Modify: `src/db.ts:231` (after the existing `addColumn` calls block)

- [ ] **Step 1: Write the failing migration test first.**

Open `src/db.test.ts`. Find an existing `describe(` block testing schema (search for `scheduled_tasks`). Append a new describe block at the end of the file:

```typescript
import { _initTestDatabase, db } from './db.js';

describe('scheduled_tasks.kind column', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('kind column exists on scheduled_tasks', () => {
    const row = db
      .prepare("PRAGMA table_info(scheduled_tasks)")
      .all() as Array<{ name: string }>;
    const columnNames = row.map((r) => r.name);
    expect(columnNames).toContain('kind');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun --bun vitest run src/db.test.ts -t 'kind column' 2>&1 | tail -20`
Expected: FAIL with `expect(columnNames).toContain('kind')` — assertion error showing the array does NOT include `'kind'`.

- [ ] **Step 3: Add the migration.**

Use the `Edit` tool on `src/db.ts`. Find this block (lines 224-231):

```typescript
  addColumn(
    `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
  );
  addColumn(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  addColumn(`ALTER TABLE scheduled_tasks ADD COLUMN agent_name TEXT`);
  addColumn(`ALTER TABLE sessions ADD COLUMN last_used TEXT`);
  addColumn(`ALTER TABLE sessions ADD COLUMN created_at TEXT`);
  addColumn(`ALTER TABLE registered_groups ADD COLUMN permitted_senders TEXT`);
```

Replace with (one new line inserted before `sessions.last_used` for proximity to the other `scheduled_tasks` migrations):

```typescript
  addColumn(
    `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
  );
  addColumn(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  addColumn(`ALTER TABLE scheduled_tasks ADD COLUMN agent_name TEXT`);
  // Discriminates self-wakeup rows from operator-created scheduled_tasks.
  // 'agent_wakeup' set by createWakeupTask; NULL for legacy/operator rows.
  // Phase 1.1 self-wakeup feature — see docs/superpowers/specs/2026-05-19-ipc-agent-self-wakeup-design.md
  addColumn(`ALTER TABLE scheduled_tasks ADD COLUMN kind TEXT DEFAULT NULL`);
  addColumn(`ALTER TABLE sessions ADD COLUMN last_used TEXT`);
  addColumn(`ALTER TABLE sessions ADD COLUMN created_at TEXT`);
  addColumn(`ALTER TABLE registered_groups ADD COLUMN permitted_senders TEXT`);
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun --bun vitest run src/db.test.ts -t 'kind column' 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

(No commit yet — we're building toward one atomic commit at the end.)

### Task 2: Add the `createWakeupTask` DB helper

**Files:**
- Modify: `src/db.ts` (after `createTask` at line 674 — same neighborhood as the other `scheduled_tasks` write helpers)
- Modify: `src/db.test.ts` (append new describe block)

- [ ] **Step 1: Write the failing test first.**

Append to `src/db.test.ts` (after the describe block from Task 1):

```typescript
import {
  createWakeupTask,
  getTaskById,
} from './db.js';

describe('createWakeupTask', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('inserts row with kind=agent_wakeup, script=NULL, schedule_type=once', () => {
    const now = new Date().toISOString();
    const next = new Date(Date.now() + 10 * 60_000).toISOString();
    createWakeupTask({
      id: 'wu-test-001',
      group_folder: 'telegram_claire',
      chat_jid: '8475020901',
      prompt: 'check inbox in 10 min',
      agent_name: 'claire',
      context_mode: 'isolated',
      next_run: next,
      created_at: now,
    });
    const row = getTaskById('wu-test-001');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('agent_wakeup');
    expect(row?.script).toBeNull();
    expect(row?.schedule_type).toBe('once');
    expect(row?.status).toBe('active');
    expect(row?.next_run).toBe(next);
    expect(row?.context_mode).toBe('isolated');
  });

  it('succeeds with next_run only 5 minutes away (no validateTaskSchedule guard)', () => {
    // validateTaskSchedule rejects interval-type schedules <30min but does NOT
    // run for once-type schedules. createWakeupTask bypasses it entirely either
    // way — explicit defense in depth.
    const next = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(() => {
      createWakeupTask({
        id: 'wu-test-002',
        group_folder: 'telegram_claire',
        chat_jid: '8475020901',
        prompt: 'short wakeup',
        agent_name: 'claire',
        context_mode: 'isolated',
        next_run: next,
        created_at: new Date().toISOString(),
      });
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `bun --bun vitest run src/db.test.ts -t 'createWakeupTask' 2>&1 | tail -15`
Expected: FAIL with `createWakeupTask is not exported` or `is not a function`.

- [ ] **Step 3: Add the export.**

Use the `Edit` tool on `src/db.ts`. Find this block (lines 670-674, end of `createTask`):

```typescript
    task.next_run,
    task.status,
    task.created_at,
  );
}
```

After the closing `}` of `createTask`, add (preserving the next function which begins at line 676):

```typescript
    task.next_run,
    task.status,
    task.created_at,
  );
}

/**
 * Insert an agent self-wakeup row into scheduled_tasks. Discriminates from
 * operator-created tasks via kind='agent_wakeup'. Bypasses validateTaskSchedule
 * (which only guards interval schedules anyway — once schedules pass through
 * regardless). The `script` field is FORCED to NULL: setting it would cause
 * runGuardScript to execute the prompt text as /bin/bash -c at fire time
 * (see [script-field-dual-contract-footgun] memory note).
 *
 * Caller (scheduleWakeupHandler.authorize) is responsible for:
 *   - next_run within [now+5min, now+7d]
 *   - rate limit (≤ 10 active wakeups per group+agent) is satisfied
 *
 * Phase 1.1 — see docs/superpowers/specs/2026-05-19-ipc-agent-self-wakeup-design.md
 */
export function createWakeupTask(task: {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  agent_name: string;
  context_mode: 'group' | 'isolated';
  next_run: string;
  created_at: string;
}): void {
  db.prepare(
    `INSERT INTO scheduled_tasks
       (id, group_folder, chat_jid, prompt, script, agent_name,
        schedule_type, schedule_value, context_mode, next_run, status,
        kind, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'once', ?, ?, ?, 'active', 'agent_wakeup', ?)`,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.agent_name,
    task.next_run,        // schedule_value = next_run for once-tasks
    task.context_mode,
    task.next_run,
    task.created_at,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `bun --bun vitest run src/db.test.ts -t 'createWakeupTask' 2>&1 | tail -10`
Expected: PASS (2 tests).

- [ ] **Step 5: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS. The `kind` field on the returned row implies `ScheduledTask` type may need extending — see Task 3.

### Task 3: Extend `ScheduledTask` type with `kind`

**Files:**
- Modify: `src/types.ts` (the `ScheduledTask` interface)

- [ ] **Step 1: Locate the interface.**

Run: `grep -n "interface ScheduledTask\|kind\?: " src/types.ts | head -10`

You're looking for the `ScheduledTask` interface definition.

- [ ] **Step 2: Add the optional `kind` field.**

Inside the `ScheduledTask` interface, add (as the last field before the closing brace):

```typescript
  /**
   * Discriminates row provenance. 'agent_wakeup' set by createWakeupTask (Phase
   * 1.1 self-wakeup). NULL for legacy/operator rows created via createTask or
   * scheduleTaskHandler.
   */
  kind?: string | null;
```

- [ ] **Step 3: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS. If any consumer code spreads `ScheduledTask` and uses `kind`, it now type-checks.

- [ ] **Step 4: Re-run the Task 2 tests to confirm nothing regressed.**

Run: `bun --bun vitest run src/db.test.ts -t 'createWakeupTask' 2>&1 | tail -10`
Expected: PASS.

### Task 4: Add `countActiveWakeups` DB helper

**Files:**
- Modify: `src/db.ts` (right after `createWakeupTask`)
- Modify: `src/db.test.ts` (append a third test to the `createWakeupTask` describe block — or new block)

- [ ] **Step 1: Write the failing test first.**

Append to `src/db.test.ts`:

```typescript
import { countActiveWakeups } from './db.js';

describe('countActiveWakeups', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns the correct count: counts active+running, excludes completed+paused, scoped by (group, agent)', () => {
    const now = new Date().toISOString();
    const next = new Date(Date.now() + 10 * 60_000).toISOString();

    // Insert: 2 active for (claire, claire) — count target
    createWakeupTask({
      id: 'wu-a1', group_folder: 'telegram_claire', chat_jid: 'j',
      prompt: 'p', agent_name: 'claire', context_mode: 'isolated',
      next_run: next, created_at: now,
    });
    createWakeupTask({
      id: 'wu-a2', group_folder: 'telegram_claire', chat_jid: 'j',
      prompt: 'p', agent_name: 'claire', context_mode: 'isolated',
      next_run: next, created_at: now,
    });

    // 1 completed for (claire, claire) — should NOT count
    createWakeupTask({
      id: 'wu-completed', group_folder: 'telegram_claire', chat_jid: 'j',
      prompt: 'p', agent_name: 'claire', context_mode: 'isolated',
      next_run: next, created_at: now,
    });
    db.prepare("UPDATE scheduled_tasks SET status='completed' WHERE id=?")
      .run('wu-completed');

    // 1 paused for (claire, claire) — should NOT count
    createWakeupTask({
      id: 'wu-paused', group_folder: 'telegram_claire', chat_jid: 'j',
      prompt: 'p', agent_name: 'claire', context_mode: 'isolated',
      next_run: next, created_at: now,
    });
    db.prepare("UPDATE scheduled_tasks SET status='paused' WHERE id=?")
      .run('wu-paused');

    // 1 active for (claire, simon) — different agent, should NOT count
    createWakeupTask({
      id: 'wu-other-agent', group_folder: 'telegram_claire', chat_jid: 'j',
      prompt: 'p', agent_name: 'simon', context_mode: 'isolated',
      next_run: next, created_at: now,
    });

    // 1 active for (lab-claw, claire) — different group, should NOT count
    createWakeupTask({
      id: 'wu-other-group', group_folder: 'telegram_lab-claw', chat_jid: 'j',
      prompt: 'p', agent_name: 'claire', context_mode: 'isolated',
      next_run: next, created_at: now,
    });

    expect(countActiveWakeups('telegram_claire', 'claire')).toBe(2);
    expect(countActiveWakeups('telegram_claire', 'simon')).toBe(1);
    expect(countActiveWakeups('telegram_lab-claw', 'claire')).toBe(1);
    expect(countActiveWakeups('telegram_claire', 'nobody')).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun --bun vitest run src/db.test.ts -t 'countActiveWakeups' 2>&1 | tail -10`
Expected: FAIL with `countActiveWakeups is not a function` or not exported.

- [ ] **Step 3: Add the export.**

Use the `Edit` tool on `src/db.ts`. Find the end of `createWakeupTask` (the closing `}` after the `.run(...)` call from Task 2). Append after it:

```typescript

/**
 * Count active and running wakeup rows for a (group_folder, agent_name) pair.
 * Used by scheduleWakeupHandler.authorize() for the 10-wakeup rate limit.
 * Excludes 'completed' (fired) and 'paused' rows.
 */
export function countActiveWakeups(
  groupFolder: string,
  agentName: string,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM scheduled_tasks
     WHERE kind = 'agent_wakeup'
       AND group_folder = ?
       AND agent_name = ?
       AND status IN ('active', 'running')`,
  ).get(groupFolder, agentName) as { cnt: number };
  return row.cnt;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun --bun vitest run src/db.test.ts -t 'countActiveWakeups' 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

---

## Handler

### Task 5: Create the handler skeleton with `parse` only

**Files:**
- Create: `src/ipc/handlers/schedule-wakeup.ts`
- Create: `src/ipc/handlers/schedule-wakeup.test.ts`

- [ ] **Step 1: Write the failing parse tests first.**

Create `src/ipc/handlers/schedule-wakeup.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { scheduleWakeupHandler } from './schedule-wakeup.js';

describe('scheduleWakeupHandler.parse', () => {
  it('returns null for non-object input', () => {
    expect(scheduleWakeupHandler.parse(null)).toBeNull();
    expect(scheduleWakeupHandler.parse(42)).toBeNull();
    expect(scheduleWakeupHandler.parse('string')).toBeNull();
  });

  it('returns null when both delay_minutes and fire_at are absent', () => {
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: 'check x',
      }),
    ).toBeNull();
  });

  it('returns null when both delay_minutes and fire_at are present', () => {
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: 'check x',
        delay_minutes: 30,
        fire_at: '2026-05-20T09:00:00',
      }),
    ).toBeNull();
  });

  it('returns null when prompt is absent, empty, or exceeds 4000 chars', () => {
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        delay_minutes: 30,
      }),
    ).toBeNull();
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: '',
        delay_minutes: 30,
      }),
    ).toBeNull();
    expect(
      scheduleWakeupHandler.parse({
        wakeupId: 'wu-1-abc',
        prompt: 'x'.repeat(4001),
        delay_minutes: 30,
      }),
    ).toBeNull();
  });

  it('returns valid input with defaults for minimal payload', () => {
    const result = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc',
      prompt: 'check x',
      delay_minutes: 30,
    });
    expect(result).not.toBeNull();
    expect(result?.wakeupId).toBe('wu-1-abc');
    expect(result?.prompt).toBe('check x');
    expect(result?.delayMinutes).toBe(30);
    expect(result?.fireAt).toBeNull();
    expect(result?.contextBlob).toBeNull();
    expect(result?.contextMode).toBe('isolated');
    expect(result?.precomputedNextRun).toBeNull();
    expect(result?.chatJid).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts 2>&1 | tail -15`
Expected: FAIL with `Cannot find module './schedule-wakeup.js'`.

- [ ] **Step 3: Create the handler with `parse` only.**

Create `src/ipc/handlers/schedule-wakeup.ts`:

```typescript
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

const WAKEUP_ID_PATTERN = /^wu-[A-Za-z0-9_-]{1,64}$/;
const MIN_DELAY_MINUTES = 5;
const MAX_DELAY_MINUTES = 10080; // 7 days
const MAX_PROMPT_LENGTH = 4000;
const MAX_CONTEXT_BLOB_LENGTH = 8000;

interface Input {
  wakeupId: string;
  prompt: string;
  contextBlob: string | null;
  contextMode: 'group' | 'isolated';
  delayMinutes: number | null;
  fireAt: string | null;
  // Populated by authorize before the gate runs. Same pattern as
  // scheduleTaskHandler's precomputedNextRun — see schedule-task.ts:22-26.
  precomputedNextRun: string | null;
  chatJid: string | null;
}

export const scheduleWakeupHandler: IpcHandler<Input> = {
  type: 'schedule_wakeup',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;

    if (typeof r.wakeupId !== 'string' || !WAKEUP_ID_PATTERN.test(r.wakeupId)) {
      return null;
    }
    if (
      typeof r.prompt !== 'string' ||
      r.prompt.length === 0 ||
      r.prompt.length > MAX_PROMPT_LENGTH
    ) {
      return null;
    }

    const hasDelay = r.delay_minutes !== undefined && r.delay_minutes !== null;
    const hasFireAt = r.fire_at !== undefined && r.fire_at !== null;
    if (hasDelay === hasFireAt) {
      // Both absent OR both present — invalid.
      return null;
    }

    let delayMinutes: number | null = null;
    if (hasDelay) {
      if (typeof r.delay_minutes !== 'number' || !Number.isInteger(r.delay_minutes)) {
        return null;
      }
      delayMinutes = r.delay_minutes;
    }

    let fireAt: string | null = null;
    if (hasFireAt) {
      if (typeof r.fire_at !== 'string') return null;
      fireAt = r.fire_at;
    }

    let contextBlob: string | null = null;
    if (r.context_blob !== undefined && r.context_blob !== null) {
      if (
        typeof r.context_blob !== 'string' ||
        r.context_blob.length > MAX_CONTEXT_BLOB_LENGTH
      ) {
        return null;
      }
      contextBlob = r.context_blob;
    }

    const contextMode =
      r.context_mode === 'group' || r.context_mode === 'isolated'
        ? r.context_mode
        : 'isolated';

    return {
      wakeupId: r.wakeupId,
      prompt: r.prompt,
      contextBlob,
      contextMode,
      delayMinutes,
      fireAt,
      precomputedNextRun: null, // populated in authorize
      chatJid: null,            // populated in authorize
    };
  },

  authorize(_input, _ctx) {
    // Implemented in Task 6.
    logger.warn('scheduleWakeupHandler.authorize not yet implemented');
    return null;
  },

  execute(_input, _ctx) {
    // Implemented in Task 7.
    logger.warn('scheduleWakeupHandler.execute not yet implemented');
    return { executed: false };
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts 2>&1 | tail -15`
Expected: PASS (5 parse tests).

- [ ] **Step 5: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

### Task 6: Implement `authorize` with rate limit + delay validation + audit-row writes

**Files:**
- Modify: `src/ipc/handlers/schedule-wakeup.ts`
- Modify: `src/ipc/handlers/schedule-wakeup.test.ts`

- [ ] **Step 1: Write the 7 authorize tests first.**

Append to `src/ipc/handlers/schedule-wakeup.test.ts`. The tests use a helper `buildContext` that mirrors the test pattern in other handler tests. First add the helper near the top (after the imports):

```typescript
import {
  _initTestDatabase,
  db,
  insertAgentAction,
  createWakeupTask,
} from '../../db.js';
import type { IpcHandlerContext } from '../handler.js';

function buildCtx(overrides: Partial<IpcHandlerContext> = {}): IpcHandlerContext {
  return {
    sourceGroup: 'telegram_claire',
    isMain: true,
    baseGroup: 'telegram_claire',
    agentName: 'claire',
    requestId: null,
    registeredGroups: {
      '8475020901': {
        jid: '8475020901',
        name: 'CLAIRE',
        folder: 'telegram_claire',
        triggerPattern: '',
        requiresTrigger: false,
        permittedSenders: null,
        addedAt: new Date().toISOString(),
        isMain: true,
        containerConfig: null,
      } as any,
    },
    deps: {
      onTasksChanged: () => {},
      // Other deps not used by this handler — cast through unknown.
    } as any,
    dataDir: '/tmp/test',
    ...overrides,
  };
}

function getAuditRows(): Array<{ action_type: string; outcome: string; summary: string }> {
  return db
    .prepare("SELECT action_type, outcome, summary FROM agent_actions WHERE action_type='schedule_wakeup' ORDER BY created_at ASC")
    .all() as Array<{ action_type: string; outcome: string; summary: string }>;
}
```

Then append the describe block:

```typescript
describe('scheduleWakeupHandler.authorize', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns null with no audit row when ctx.agentName is null', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc', prompt: 'p', delay_minutes: 30,
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx({ agentName: null }));
    expect(result).toBeNull();
    expect(getAuditRows()).toHaveLength(0);
  });

  it('returns null and writes denied_rate_limit audit row when 10 active wakeups exist', () => {
    const now = new Date().toISOString();
    const next = new Date(Date.now() + 10 * 60_000).toISOString();
    for (let i = 0; i < 10; i++) {
      createWakeupTask({
        id: `wu-pre-${i}`, group_folder: 'telegram_claire', chat_jid: 'j',
        prompt: 'p', agent_name: 'claire', context_mode: 'isolated',
        next_run: next, created_at: now,
      });
    }
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-new', prompt: 'p', delay_minutes: 30,
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_rate_limit');
    expect(rows[0].summary).toContain('10/10');
  });

  it('returns null and writes denied_invalid_delay audit row when delay_minutes < 5', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc', prompt: 'p', delay_minutes: 3,
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_invalid_delay');
    expect(rows[0].summary).toContain('< 5');
  });

  it('returns null and writes denied_invalid_delay audit row when delay_minutes > 10080', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc', prompt: 'p', delay_minutes: 10081,
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_invalid_delay');
    expect(rows[0].summary).toContain('> 10080');
  });

  it('returns null and writes denied_invalid_delay audit row when fire_at resolves to < 5 min', () => {
    const fireAt = new Date(Date.now() + 2 * 60_000).toISOString().replace(/Z$/, '');
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc', prompt: 'p', fire_at: fireAt,
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_invalid_delay');
  });

  it('returns null and writes denied_no_chat_jid audit row when group not in registeredGroups', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc', prompt: 'p', delay_minutes: 30,
    })!;
    const result = scheduleWakeupHandler.authorize(input, buildCtx({ registeredGroups: {} }));
    expect(result).toBeNull();
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied_no_chat_jid');
  });

  it('returns non-null IpcAuthorization with skipGate:true and resolves precomputedNextRun + chatJid', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-1-abc', prompt: 'p', delay_minutes: 30,
    })!;
    const auth = scheduleWakeupHandler.authorize(input, buildCtx());
    expect(auth).not.toBeNull();
    expect(auth?.skipGate).toBe(true);
    expect(input.precomputedNextRun).not.toBeNull();
    expect(input.chatJid).toBe('8475020901');
    const ms = new Date(input.precomputedNextRun!).getTime() - Date.now();
    expect(ms).toBeGreaterThan(25 * 60_000);
    expect(ms).toBeLessThan(35 * 60_000);
    expect(getAuditRows()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts -t 'authorize' 2>&1 | tail -20`
Expected: FAIL (current authorize is a stub that always returns null without writing any row).

- [ ] **Step 3: Implement `authorize`.**

Open `src/ipc/handlers/schedule-wakeup.ts`. Add a top-level import for the DB:

```typescript
import { countActiveWakeups, insertAgentAction } from '../../db.js';
```

Replace the stub `authorize` with this implementation:

```typescript
  authorize(input, ctx) {
    // Non-agent callers cannot self-wake. No audit row — non-agent IPC is
    // operator-driven and should use createTask / schedule_task directly.
    if (ctx.agentName === null) {
      return null;
    }

    // Resolve chat_jid from registeredGroups. baseGroup is the calling group.
    const groupEntry = Object.values(ctx.registeredGroups).find(
      (g) => g.folder === ctx.baseGroup,
    );
    if (!groupEntry) {
      insertAgentAction({
        agent_name: ctx.agentName,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary: `no chat_jid for group_folder ${ctx.baseGroup}`,
        target: input.wakeupId,
        outcome: 'denied_no_chat_jid',
      });
      return null;
    }

    // Resolve next_run from delay_minutes XOR fire_at. parse already
    // guaranteed exactly one is non-null.
    let nextRunDate: Date;
    if (input.delayMinutes !== null) {
      nextRunDate = new Date(Date.now() + input.delayMinutes * 60_000);
    } else {
      // fire_at is a local-time ISO string without Z/offset. Date.parse
      // treats it as local time. If unparseable, reject.
      nextRunDate = new Date(input.fireAt!);
      if (isNaN(nextRunDate.getTime())) {
        insertAgentAction({
          agent_name: ctx.agentName,
          group_folder: ctx.baseGroup,
          action_type: 'schedule_wakeup',
          trust_level: 'skipGate',
          summary: `fire_at unparseable: ${input.fireAt}`,
          target: input.wakeupId,
          outcome: 'denied_invalid_delay',
        });
        return null;
      }
    }

    const deltaMs = nextRunDate.getTime() - Date.now();
    const deltaMinutes = deltaMs / 60_000;

    if (deltaMinutes < MIN_DELAY_MINUTES) {
      const summary =
        input.delayMinutes !== null
          ? `delay_minutes ${input.delayMinutes} < 5 (minimum)`
          : `fire_at resolves to ${Math.round(deltaMinutes)}min from now (minimum 5)`;
      insertAgentAction({
        agent_name: ctx.agentName,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary,
        target: input.wakeupId,
        outcome: 'denied_invalid_delay',
      });
      return null;
    }
    if (deltaMinutes > MAX_DELAY_MINUTES) {
      const summary =
        input.delayMinutes !== null
          ? `delay_minutes ${input.delayMinutes} > 10080 (7-day max)`
          : `fire_at resolves to ${Math.round(deltaMinutes / 1440)}d from now (maximum 7)`;
      insertAgentAction({
        agent_name: ctx.agentName,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary,
        target: input.wakeupId,
        outcome: 'denied_invalid_delay',
      });
      return null;
    }

    // Rate-limit check AFTER delay validation — bad delay should not consume
    // a rate slot but should still produce an audit row.
    const active = countActiveWakeups(ctx.baseGroup, ctx.agentName);
    if (active >= 10) {
      insertAgentAction({
        agent_name: ctx.agentName,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary: `rate limit: ${active}/10 active wakeups for ${ctx.agentName} in ${ctx.baseGroup}`,
        target: input.wakeupId,
        outcome: 'denied_rate_limit',
      });
      return null;
    }

    // Pin resolved values onto input for execute(). Same mutation pattern as
    // scheduleTaskHandler — see schedule-task.ts:22-26 and 173.
    input.precomputedNextRun = nextRunDate.toISOString();
    input.chatJid = groupEntry.jid;

    return {
      target: input.wakeupId,
      auditSummary: `wakeup ${input.wakeupId} in ${Math.round(deltaMinutes)}min: ${input.prompt.slice(0, 100)}`,
      notifySummary: `wakeup scheduled in ${Math.round(deltaMinutes)} min`,
      payloadForStaging: {
        type: 'schedule_wakeup',
        wakeupId: input.wakeupId,
        prompt: input.prompt,
        delay_minutes: input.delayMinutes,
        fire_at: input.fireAt,
      },
      skipGate: true,
    };
  },
```

- [ ] **Step 4: Run the authorize tests.**

Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts -t 'authorize' 2>&1 | tail -15`
Expected: PASS (7 tests).

- [ ] **Step 5: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

### Task 7: Implement `execute` with audit-row-AFTER-INSERT ordering

**Files:**
- Modify: `src/ipc/handlers/schedule-wakeup.ts`
- Modify: `src/ipc/handlers/schedule-wakeup.test.ts`

This task implements the Critical round-1 amendment: audit row written ONLY after `createWakeupTask` succeeds. On PK collision, write a `denied_collision` row instead.

- [ ] **Step 1: Write the 4 execute tests first.**

Append to `src/ipc/handlers/schedule-wakeup.test.ts`:

```typescript
import { getTaskById } from '../../db.js';

describe('scheduleWakeupHandler.execute', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates row with kind=agent_wakeup, status=active, schedule_type=once, script=NULL', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-exec-1', prompt: 'check inbox', delay_minutes: 30,
    })!;
    const ctx = buildCtx();
    scheduleWakeupHandler.authorize(input, ctx); // populates chatJid, precomputedNextRun
    scheduleWakeupHandler.execute(input, ctx);
    const row = getTaskById('wu-exec-1');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('agent_wakeup');
    expect(row?.status).toBe('active');
    expect(row?.schedule_type).toBe('once');
    expect(row?.script).toBeNull();
  });

  it('composes prompt with <wakeup-context> fence when contextBlob is set', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-exec-2',
      prompt: 'do thing',
      delay_minutes: 30,
      context_blob: 'STATE=foo',
    })!;
    const ctx = buildCtx();
    scheduleWakeupHandler.authorize(input, ctx);
    scheduleWakeupHandler.execute(input, ctx);
    const row = getTaskById('wu-exec-2');
    expect(row?.prompt).toBe(
      'do thing\n\n<wakeup-context>\nSTATE=foo\n</wakeup-context>',
    );
  });

  it('writes audit row with outcome=allowed, trust_level=skipGate AFTER INSERT succeeds', () => {
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-exec-3', prompt: 'p', delay_minutes: 30,
    })!;
    const ctx = buildCtx();
    scheduleWakeupHandler.authorize(input, ctx);
    scheduleWakeupHandler.execute(input, ctx);
    const rows = getAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('allowed');
    // Pin: only one row, no phantom row from before-INSERT write.
    const all = db.prepare(
      "SELECT * FROM agent_actions WHERE action_type='schedule_wakeup'",
    ).all();
    expect(all).toHaveLength(1);
  });

  it('calls deps.onTasksChanged after successful insert', () => {
    let called = 0;
    const input = scheduleWakeupHandler.parse({
      wakeupId: 'wu-exec-4', prompt: 'p', delay_minutes: 30,
    })!;
    const ctx = buildCtx({ deps: { onTasksChanged: () => { called++; } } as any });
    scheduleWakeupHandler.authorize(input, ctx);
    scheduleWakeupHandler.execute(input, ctx);
    expect(called).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts -t 'execute' 2>&1 | tail -15`
Expected: FAIL (execute stub returns `{executed: false}` and doesn't INSERT).

- [ ] **Step 3: Implement `execute` with the audit-after-INSERT ordering.**

Open `src/ipc/handlers/schedule-wakeup.ts`. Add the `createWakeupTask` import:

```typescript
import { countActiveWakeups, createWakeupTask, insertAgentAction } from '../../db.js';
```

Replace the stub `execute`:

```typescript
  execute(input, ctx) {
    // Compose the wakeup prompt with optional context envelope.
    const composedPrompt = input.contextBlob
      ? `${input.prompt}\n\n<wakeup-context>\n${input.contextBlob}\n</wakeup-context>`
      : input.prompt;

    const now = new Date().toISOString();

    // Audit-row ordering (round-1 amendment): INSERT first, then audit row.
    // Writing the audit row first would leave a phantom outcome='allowed'
    // entry on PK collision — the bug pattern from [Task id=1 doesn't exist]
    // memory note.
    try {
      createWakeupTask({
        id: input.wakeupId,
        group_folder: ctx.baseGroup,
        chat_jid: input.chatJid!,
        prompt: composedPrompt,
        agent_name: ctx.agentName!,
        context_mode: input.contextMode,
        next_run: input.precomputedNextRun!,
        created_at: now,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      insertAgentAction({
        agent_name: ctx.agentName!,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary: `wakeup ${input.wakeupId} INSERT failed: ${message}`,
        target: input.wakeupId,
        outcome: 'denied_collision',
      });
      logger.warn(
        { wakeupId: input.wakeupId, err: message },
        'createWakeupTask INSERT failed (likely PK collision)',
      );
      return { executed: false };
    }

    // INSERT succeeded — write the allowed audit row.
    const deltaMinutes = Math.round(
      (new Date(input.precomputedNextRun!).getTime() - Date.now()) / 60_000,
    );
    insertAgentAction({
      agent_name: ctx.agentName!,
      group_folder: ctx.baseGroup,
      action_type: 'schedule_wakeup',
      trust_level: 'skipGate',
      summary: `wakeup ${input.wakeupId} in ${deltaMinutes}min: ${input.prompt.slice(0, 100)}`,
      target: input.wakeupId,
      outcome: 'allowed',
    });

    logger.info(
      {
        wakeupId: input.wakeupId,
        sourceGroup: ctx.sourceGroup,
        baseGroup: ctx.baseGroup,
        agent: ctx.agentName,
        delayMinutes: deltaMinutes,
        contextMode: input.contextMode,
      },
      'Wakeup scheduled via IPC',
    );
    ctx.deps.onTasksChanged();
  },
```

- [ ] **Step 4: Run the execute tests.**

Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts -t 'execute' 2>&1 | tail -15`
Expected: PASS (4 tests).

- [ ] **Step 5: Run all handler tests to confirm no regression.**

Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts 2>&1 | tail -10`
Expected: PASS (16 tests total: 5 parse + 7 authorize + 4 execute).

- [ ] **Step 6: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

---

## Wiring

### Task 8: Register handler in `index.ts`

**Files:**
- Modify: `src/ipc/handlers/index.ts`

- [ ] **Step 1: Open the file and verify current state.**

Read `src/ipc/handlers/index.ts`. Confirm the existing import block (lines 1-29) and registration block (lines 33-61).

- [ ] **Step 2: Add the import.**

Use the `Edit` tool. Find this line:

```typescript
import { scheduleTaskHandler } from './schedule-task.js';
```

Replace with:

```typescript
import { scheduleTaskHandler } from './schedule-task.js';
import { scheduleWakeupHandler } from './schedule-wakeup.js';
```

- [ ] **Step 3: Add the registration.**

Find this line in `registerBuiltinHandlers`:

```typescript
  registerIpcHandler(scheduleTaskHandler);
```

Replace with:

```typescript
  registerIpcHandler(scheduleTaskHandler);
  registerIpcHandler(scheduleWakeupHandler);
```

- [ ] **Step 4: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

### Task 9: Add `schedule_wakeup` to `SKIP_GATE_ALLOWLIST`

**Files:**
- Modify: `src/ipc/handler.ts:21-43`

- [ ] **Step 1: Read the current allowlist.**

Look at `src/ipc/handler.ts:21-43`. The allowlist already contains `task_add`, `task_close`, `task_reopen` as known "writes that bypass the gate" with a `TODO(Batch4)` comment.

- [ ] **Step 2: Add the new entry.**

Use the `Edit` tool. Find this block:

```typescript
  // TODO(Batch4): gate task_add / task_close / task_reopen / pageindex_index.
  'task_add',
  'task_close',
  'task_reopen',
  'pageindex_index',
]);
```

Replace with:

```typescript
  // TODO(Batch4): gate task_add / task_close / task_reopen / pageindex_index.
  'task_add',
  'task_close',
  'task_reopen',
  'pageindex_index',
  // Self-directed agent wakeup. Rate-limited (10/agent/group) in
  // scheduleWakeupHandler.authorize; handler writes its own audit row.
  // Phase 1.1 — see docs/superpowers/specs/2026-05-19-ipc-agent-self-wakeup-design.md
  'schedule_wakeup',
]);
```

- [ ] **Step 3: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

---

## Dispatcher Contract Tests

### Task 10: Add 2 dispatcher tests pinning skipGate-allowlist behavior

**Files:**
- Modify: `src/ipc/handler-post-hoc-notify.test.ts` (the closest existing dispatcher-contract file — its Test 6 at lines 341-388 already pins `denied_contract_violation` for `postHocNotify+skipGate`; our tests pin the simpler `schedule_wakeup` allowlist on/off cases at the same dispatcher layer)

**Why this file, not `handler-batch4-drops.test.ts`:** I initially scoped this to `handler-batch4-drops.test.ts`, but inspection shows that file pins malformed-requestId and parse-rejected drops — NOT skipGate-allowlist behavior. The off-allowlist skipGate pattern is exercised at `handler-post-hoc-notify.test.ts:341-388` against a `wire_x` stub handler. The new tests follow that exact pattern.

- [ ] **Step 1: Read the existing Test 6 in `handler-post-hoc-notify.test.ts:341-388`.**

This is your template. Note the structure:
- Define a stub `IpcHandler` with a chosen `type`.
- Call `registerIpcHandler(handler)`.
- Call `await dispatch({type: ...})` (where `dispatch` is the file-level helper that builds the context and calls `dispatchIpcAction`).
- Assert against `executed` (flag set inside `execute`), `sent` (notify capture), and rows queried from `agent_actions`.

- [ ] **Step 2: Append the two new tests at the end of `src/ipc/handler-post-hoc-notify.test.ts`, inside the existing describe block (before the closing `});` at line 389).**

```typescript
  // ---- Test 7: schedule_wakeup-style on-allowlist skipGate → execute runs ----

  it('7. on-allowlist handler with skipGate → execute runs, no denied_contract_violation', async () => {
    // Pins that SKIP_GATE_ALLOWLIST honors skipGate when the wire type is on
    // the list. This is the on-allowlist control: a handler whose type IS
    // 'schedule_wakeup' (allowlisted) and uses skipGate:true should execute
    // normally and produce NO denied_contract_violation row.
    let executed = false;

    const handler: IpcHandler<{ ok: boolean }, void> = {
      type: 'schedule_wakeup', // ON SKIP_GATE_ALLOWLIST per src/ipc/handler.ts
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'wu-stub',
        notifySummary: 'wakeup stub',
        payloadForStaging: { type: 'schedule_wakeup' },
        skipGate: true,
      }),
      execute: () => {
        executed = true;
        return undefined;
      },
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'schedule_wakeup' });

    expect(executed).toBe(true);

    const rows = getDb()
      .prepare(
        'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    // No denied_contract_violation row — the allowlist honored skipGate.
    expect(rows.map((r) => r.outcome)).not.toContain('denied_contract_violation');
  });

  // ---- Test 8: off-allowlist skipGate → denied_contract_violation ----

  it('8. off-allowlist handler with skipGate → denied_contract_violation, no execute', async () => {
    // Pins the off-allowlist branch of the skipGate check at handler.ts:292-321.
    // wire_off_allowlist is NOT on SKIP_GATE_ALLOWLIST; the dispatcher must
    // refuse skipGate, write denied_contract_violation, and skip execute.
    // This is the parallel control for Test 7 — confirms the allowlist
    // gate actually fires when the type is not listed.
    let executed = false;

    const handler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_off_allowlist',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-off',
        notifySummary: 'should never fire',
        payloadForStaging: { type: 'wire_off_allowlist' },
        skipGate: true,
      }),
      execute: () => {
        executed = true;
        return undefined;
      },
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_off_allowlist' });

    expect(executed).toBe(false);

    const rows = getDb()
      .prepare(
        'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('wire_off_allowlist');
    expect(rows[0].outcome).toBe('denied_contract_violation');
  });
```

**Note:** The `getDb`, `agentName`, `dispatch`, `registerIpcHandler`, `IpcHandler` symbols are already in scope from the file's existing imports and `beforeEach` block — no new imports needed.

- [ ] **Step 3: Run the two new tests.**

Run: `bun --bun vitest run src/ipc/handler-post-hoc-notify.test.ts -t '7. on-allowlist|8. off-allowlist' 2>&1 | tail -15`
Expected: PASS (2 tests).

- [ ] **Step 4: Run the full file to confirm no regression.**

Run: `bun --bun vitest run src/ipc/handler-post-hoc-notify.test.ts 2>&1 | tail -10`
Expected: PASS (all 8 tests — 6 existing + 2 new).

---

## Integration Tests

### Task 11: Add 2 end-to-end integration tests via `dispatchIpcAction`

**Files:**
- Modify: `src/ipc/handlers/schedule-wakeup.test.ts`

- [ ] **Step 1: Write the integration tests.**

Append to `src/ipc/handlers/schedule-wakeup.test.ts`:

```typescript
import { dispatchIpcAction } from '../handler.js';
import { registerBuiltinHandlers, _resetBuiltinHandlersForTests } from './index.js';

describe('scheduleWakeupHandler integration (via dispatchIpcAction)', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetBuiltinHandlersForTests();
    registerBuiltinHandlers();
    db.prepare(
      "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main) VALUES (?, ?, ?, ?, ?, 1)",
    ).run('8475020901', 'CLAIRE', 'telegram_claire', '', new Date().toISOString());
  });

  afterEach(() => {
    _resetBuiltinHandlersForTests();
  });

  it('full dispatch with valid agent creates row + audit row outcome=allowed', async () => {
    const ctx = buildCtx(); // override registeredGroups to load from DB
    // Construct the IPC payload as it would arrive on disk from the container.
    const payload = {
      type: 'schedule_wakeup',
      wakeupId: 'wu-int-1',
      prompt: 'check inbox',
      delay_minutes: 30,
      groupFolder: 'telegram_claire',
      timestamp: new Date().toISOString(),
    };
    const result = await dispatchIpcAction(payload, ctx);
    expect(result.handled).toBe(true);
    const row = getTaskById('wu-int-1');
    expect(row?.kind).toBe('agent_wakeup');
    expect(row?.script).toBeNull();
    const audits = getAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('allowed');
  });

  it('full dispatch with rate-limit-saturated state writes denied_rate_limit', async () => {
    const now = new Date().toISOString();
    const next = new Date(Date.now() + 10 * 60_000).toISOString();
    for (let i = 0; i < 10; i++) {
      createWakeupTask({
        id: `wu-pre-${i}`, group_folder: 'telegram_claire', chat_jid: '8475020901',
        prompt: 'p', agent_name: 'claire', context_mode: 'isolated',
        next_run: next, created_at: now,
      });
    }
    const ctx = buildCtx();
    const result = await dispatchIpcAction(
      {
        type: 'schedule_wakeup',
        wakeupId: 'wu-int-overflow',
        prompt: 'p',
        delay_minutes: 30,
        groupFolder: 'telegram_claire',
        timestamp: new Date().toISOString(),
      },
      ctx,
    );
    expect(result.handled).toBe(true);
    expect(getTaskById('wu-int-overflow')).toBeUndefined();
    const audits = getAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('denied_rate_limit');
  });
});
```

**Note:** The `buildCtx()` helper used in earlier tests builds an in-memory `registeredGroups` map. For integration tests through `dispatchIpcAction`, you may need to load `registeredGroups` from the DB instead (since the dispatcher reads from it). Look at how other handler tests in this codebase (e.g., `slack.test.ts`) construct integration-test contexts. If `buildCtx` needs an override for the integration block, add it.

- [ ] **Step 2: Run the integration tests.**

Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts -t 'integration' 2>&1 | tail -15`
Expected: PASS (2 tests).

- [ ] **Step 3: Run all 18 handler-file tests.**

Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts 2>&1 | tail -10`
Expected: PASS (5 parse + 7 authorize + 4 execute + 2 integration = 18).

---

## Container-Side MCP Tool

### Task 12: Add the `schedule_wakeup` MCP tool

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (append after the existing `schedule_task` tool)

- [ ] **Step 1: Locate the schedule_task tool definition.**

Run: `grep -n "schedule_task\b\|^server\.tool(" container/agent-runner/src/ipc-mcp-stdio.ts | head -20`

Find the line where `schedule_task` tool registration ends (`)` of `server.tool('schedule_task', ...)`). The new tool registration goes immediately after.

- [ ] **Step 2: Append the new tool definition.**

After the closing of `server.tool('schedule_task', ...)`, insert:

```typescript
server.tool(
  'schedule_wakeup',
  `Schedule a one-shot future invocation of yourself in the current group.

Use when:
- You want to check back on something in N minutes without the user creating a cron job.
- You need to defer a task to a later session ("process this after the inbox syncs in 20 min").
- You want async self-thinking: start work now, continue it in a future fresh context.

Do not use for:
- Recurring tasks (use schedule_task with cron or interval).
- Scheduling work in a different group (use schedule_task with target_group_jid — main only).
- Sending a deferred message to another agent (use publish_to_bus).
- Anything that needs to fire in less than 5 minutes.

Important: the woken agent starts in a FRESH container with no memory of this conversation.
All state the woken agent needs must be in prompt or context_blob. Use context_mode="group"
only when the group session will still be alive at wake time (sessions expire after 2h idle).

Inputs:
- prompt: what to do when woken. Required, max 4000 chars. Write it as if to a fresh agent.
- delay_minutes: minutes from now (integer, min 5, max 10080). Provide this OR fire_at, not both.
- fire_at: absolute local time without timezone suffix (e.g. "2026-05-20T09:00:00").
- context_blob: optional freeform context, max 8000 chars. Injected under a <wakeup-context> fence.
- context_mode: "isolated" (default, fresh session) or "group" (reuse current if alive).

Returns: "Wakeup wu-<id> scheduled for <timestamp>." on success. Use the wu-<id> with
cancel_task to abort if needed. Error string on validation failure.

Rate limit: max 10 pending wakeups per agent per group. Cancel existing ones with cancel_task.`,
  {
    prompt: z.string().max(4000).describe('What to do when woken. Required.'),
    delay_minutes: z.number().int().optional().describe('Minutes from now (5–10080). XOR with fire_at.'),
    fire_at: z.string().optional().describe('Local time "YYYY-MM-DDTHH:MM:SS" (no Z). XOR with delay_minutes.'),
    context_blob: z.string().max(8000).optional().describe('Optional context injected under <wakeup-context> fence.'),
    context_mode: z.enum(['group', 'isolated']).optional().describe('"isolated" (default) or "group".'),
  },
  async (args) => {
    const hasDelay = args.delay_minutes !== undefined;
    const hasFireAt = args.fire_at !== undefined;

    if (hasDelay === hasFireAt) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Provide exactly one of delay_minutes or fire_at, not both (or neither).' }],
        isError: true,
      };
    }
    if (hasDelay && (args.delay_minutes! < 5 || args.delay_minutes! > 10080)) {
      return {
        content: [{ type: 'text' as const, text: `Error: delay_minutes must be 5–10080. Got ${args.delay_minutes}.` }],
        isError: true,
      };
    }
    if (hasFireAt && (/[Zz]$/.test(args.fire_at!) || /[+-]\d{2}:\d{2}$/.test(args.fire_at!))) {
      return {
        content: [{ type: 'text' as const, text: `Error: fire_at must be local time without timezone suffix. Example: "2026-05-20T09:00:00"` }],
        isError: true,
      };
    }

    const wakeupId = `wu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fireAtPreview = hasDelay
      ? new Date(Date.now() + args.delay_minutes! * 60_000).toLocaleString()
      : new Date(args.fire_at!).toLocaleString();

    writeIpcFile(TASKS_DIR, {
      type: 'schedule_wakeup',
      wakeupId,
      prompt: args.prompt,
      delay_minutes: args.delay_minutes,
      fire_at: args.fire_at,
      context_blob: args.context_blob,
      context_mode: args.context_mode ?? 'isolated',
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Wakeup ${wakeupId} scheduled for ${fireAtPreview}. The woken agent starts fresh — make your prompt self-contained. Cancel with cancel_task if needed.`,
        },
      ],
    };
  },
);
```

**Note:** Confirm that `z`, `writeIpcFile`, `TASKS_DIR`, and `groupFolder` are already in scope at this insertion point — they are used by the surrounding tool definitions, so they should be.

- [ ] **Step 3: Build the container source to confirm no compile errors.**

Run: `cd container/agent-runner && bun run tsc --noEmit 2>&1 | tail -10`
Expected: PASS (no TypeScript errors). If `tsc --noEmit` is not configured, run the container's normal build command and verify no errors.

---

## Verification

### Task 13: Run the full test suite

- [ ] **Step 1: Run all tests.**

Run: `bun run test 2>&1 | tail -15`
Expected: All tests pass. Count should be baseline + at least 18 new (handler tests) + 3 (DB tests) + 2 (dispatcher tests) = baseline + 23.

If any test fails, investigate the failure before proceeding. Common causes:
- An integration test's `buildCtx` doesn't match the dispatcher's expectations — check how other integration tests construct the `IpcHandlerContext`.
- The `_resetBuiltinHandlersForTests` call missed — tests don't see `scheduleWakeupHandler` registered.

### Task 14: Run typecheck and lint

- [ ] **Step 1: Typecheck.**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 2: Lint.**

Run: `bun run lint`
Expected: PASS (the baseline has ~550 warnings — confirm we didn't add new errors; warnings are pre-existing).

### Task 15: Verify all acceptance criteria from spec §10

The spec defines 10 acceptance criteria. Verify each by running the listed command and confirming the expected output:

- [ ] **AC #1**: `bun run test` passes (Task 13).
- [ ] **AC #2**: `bun run typecheck` passes (Task 14).
- [ ] **AC #3**: `bun run lint` passes (Task 14).
- [ ] **AC #4**: After running a wakeup test, query confirms the column exists.
  Run: `sqlite3 store/messages.db "SELECT name FROM pragma_table_info('scheduled_tasks') WHERE name='kind'"` (or use the test DB instead of production).
  Expected: `kind`.
- [ ] **AC #5**: No `kind='agent_wakeup'` row ever has a non-null script.
  Run: `sqlite3 store/messages.db "SELECT COUNT(*) FROM scheduled_tasks WHERE kind='agent_wakeup' AND script IS NOT NULL"` (or against the test DB).
  Expected: `0`.
- [ ] **AC #6**: SKIP_GATE_ALLOWLIST contains the entry.
  Run: `grep -n "'schedule_wakeup'" src/ipc/handler.ts`
  Expected: A line inside the `SKIP_GATE_ALLOWLIST` Set literal.
- [ ] **AC #7**: Handler is registered.
  Run: `grep -n "scheduleWakeupHandler" src/ipc/handlers/index.ts`
  Expected: An import line and a `registerIpcHandler` line.
- [ ] **AC #8**: Tests 13 (Task 7, `createWakeupTask sets script=NULL`) and 15 (Task 7, `execute() writes audit row AFTER INSERT`) both pass.
  Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts -t 'creates row with kind' && bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts -t 'writes audit row with outcome=allowed'`
  Expected: Both PASS.
- [ ] **AC #9**: Rate limit enforced end-to-end.
  Run: `bun --bun vitest run src/ipc/handlers/schedule-wakeup.test.ts -t 'rate-limit-saturated'`
  Expected: PASS.
- [ ] **AC #10**: Manual smoke test (optional — skip if all automated tests pass and you don't need to verify in production).
  If you do run it: dispatch a `schedule_wakeup` IPC from a real agent in a dev environment. Confirm the `scheduled_tasks` row with `kind='agent_wakeup'`, `script=NULL`, `status='active'`; confirm `agent_actions` row with `outcome='allowed'`; confirm scheduler `onTasksChanged` fires.

### Task 16: Commit the atomic change

The spec's round-1 amendment specifies a SINGLE commit (not two). Two commits would create a window where the handler ships without the `kind` column migration.

- [ ] **Step 1: Verify staging area.**

Run: `git status`
Expected: 7 modified or new files (the 6 from the file structure + the test file).

- [ ] **Step 2: Stage the files explicitly (no `git add .`).**

Run:
```bash
git add src/db.ts src/db.test.ts src/types.ts src/ipc/handler.ts \
        src/ipc/handlers/index.ts src/ipc/handlers/schedule-wakeup.ts \
        src/ipc/handlers/schedule-wakeup.test.ts \
        src/ipc/handler-post-hoc-notify.test.ts \
        container/agent-runner/src/ipc-mcp-stdio.ts
```

- [ ] **Step 3: Verify staged diff.**

Run: `git diff --cached --stat`
Expected: 9 files. No file should be in the staged list that wasn't in Step 2 (in particular, don't pull in pre-existing modifications to CLAUDE.md, healthcheck.md, etc.).

- [ ] **Step 4: Write the commit message to a temp file and commit.**

The HEREDOC-with-RTK interaction is known to break; use `-F` instead. Create the temp file:

```bash
cat > /tmp/wakeup-commit-msg.txt <<'EOF_MSG'
feat(ipc): add schedule_wakeup IPC + MCP tool + kind column (Phase 1.1 self-wakeup)

Implements docs/superpowers/specs/2026-05-19-ipc-agent-self-wakeup-design.md
(round-1 amended at 13fa035d).

Lets in-container agents schedule one-shot future invocations of themselves
in the same group, with optional context blob. Inserts a scheduled_tasks
row with kind='agent_wakeup' (new column); the existing scheduler fires it
unmodified.

Key design choices (from round-1 amendments):
- Single atomic commit (not two) — handler INSERT references the new kind
  column, so two-commit deployment would crash any wakeup attempt during
  the window between commits.
- Audit row written AFTER successful INSERT, not before — prevents the
  phantom-row bug pattern from [Task id=1 doesn't exist] memory note.
- skipGate:true + SKIP_GATE_ALLOWLIST entry — rate limit (10/agent/group)
  and 5min-7day delay window are the load-bearing protections; handler
  writes its own audit row since gateAndStage is bypassed.
- createWakeupTask explicitly omits the script field from its type
  signature; INSERT hardcodes NULL. Avoids the script-field dual-contract
  footgun (host parses as bash, container parses as JSON).

Test scope: 23 new tests
  - 18 handler tests (5 parse + 7 authorize + 4 execute + 2 integration)
  - 3 DB tests (kind column + createWakeupTask + countActiveWakeups)
  - 2 dispatcher contract tests (skipGate allowlist on/off)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF_MSG
```

Then commit:

```bash
git commit -F /tmp/wakeup-commit-msg.txt
rm /tmp/wakeup-commit-msg.txt
```

- [ ] **Step 5: Verify the commit.**

Run: `git log -1 --stat`
Expected: A new commit with ~9 files changed, the commit message above, your authorship.

- [ ] **Step 6: Run the full test suite one more time on the committed state.**

Run: `bun run test 2>&1 | tail -10`
Expected: All tests pass. Same count as Task 13.

---

## Done

The plan is complete. The feature is implemented, tested, type-checked, lint-clean, and committed atomically. Agents in any registered group can now call `mcp__nanoclaw__schedule_wakeup({prompt, delay_minutes})` to schedule a one-shot future invocation of themselves.

**Next steps (out of scope for this plan, future Phase 1.2+):**
- Phase 1.2 (shared knowledge layer) — separate plan, see `docs/superpowers/specs/2026-05-19-shared-knowledge-layer-design.md`.
- Operational metrics: track `agent_actions WHERE action_type='schedule_wakeup'` outcome distribution to see how often `denied_rate_limit` fires (signal of runaway agents) and how often wakeups produce `outcome='allowed'` rows vs. fire-time errors.
- Q3 open question: should `context_mode` default to `'group'` (matches `schedule_task`) or `'isolated'` (current choice)? Re-evaluate after a week of usage data.
