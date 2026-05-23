# Crystallize Skill Operationalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dormant `crystallize` skill produce, invoke, and lifecycle real reusable skills via a Stop hook → DM → /yes flow + 3 lifecycle crons.

**Architecture:** Container Stop hook fires on turn-end, applies a structural+verbosity gate, writes IPC file. Host handler dedups (UNIQUE INDEX + INSERT OR IGNORE), DMs Telegram CLAIRE. User `/crystallize-yes cc-xxx` schedules a one-shot agent task that hydrates the candidate via a new MCP tool and generates the SKILL.md body via the existing `crystallize_skill` IPC → `pending_actions` → `/approve`. Three crons (weekly digest + weekly promote + monthly prune) close the lifecycle.

**Tech Stack:** TypeScript (Bun runtime), better-sqlite3, @anthropic-ai/claude-agent-sdk, Grammy (Telegram), Python 3 (guard scripts), vitest.

**Spec:** `docs/superpowers/specs/2026-05-23-crystallize-skill-operationalization-design.md` (commit `7c92efa6`).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/db.ts` | Modify (~177-211 area) | Add `CREATE TABLE IF NOT EXISTS crystallize_candidates` + 2 indexes inside the schema-init block. Add `insertCrystallizeCandidate`, `getCrystallizeCandidate`, `updateCrystallizeCandidateStatus`, `countTodayCandidatesWithDm` exports. |
| `src/ipc.ts` | Modify (line ~38) | Add `db: import('better-sqlite3').Database` field to `IpcDeps`. |
| `src/ipc/handler.ts` | Modify (line 30 area) | Add `'crystallize_candidate'`, `'crystallize_candidate_fetch'` to `SKIP_GATE_ALLOWLIST`. |
| `src/ipc/handlers/skills.ts` | Modify (append at end) | Add `crystallizeCandidateHandler` (notify-kind) and `crystallizeCandidateFetchHandler` (result-kind). |
| `src/ipc/handlers/index.ts` | Modify | Register both new handlers. |
| `src/commands/crystallize-command.ts` | Create | `extractCrystallizeCommand(text)` + `handleCrystallizeCommand(cmd, deps)`. Mirrors `extractApprovalCommand`/`handleApprovalCommand`. |
| `src/index.ts` | Modify (line ~495 if-ladder) | After `/approve` block, add inline call to the new helpers. |
| `container/agent-runner/src/index.ts` | Modify (line ~436 + line ~820) | Add `extractToolSequence`, `createStopHook`. Register `Stop` hook alongside `PreCompact`/`PreToolUse`. |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Modify | Add `nanoclaw.crystallize_candidate_fetch` MCP tool. |
| `scripts/guards/crystallize-weekly-digest.py` | Create | Scans usage.jsonl + log.jsonl + DB overflow → writes `~/.cache/nanoclaw/crystallize-digest.md`. Exit 0 if non-empty, else 1. |
| `scripts/guards/crystallize-promote-check.py` | Create | Scans usage.jsonl for ≥10 invocations + ≥3 distinct sourceGroups → writes JSON. Exit 0 if any, else 1. |
| `scripts/guards/crystallize-prune-check.py` | Create | Scans log.jsonl for invocation_count==0 + age>30d + confidence≤7 → writes JSON. Exit 0 if any, else 1. |
| `src/replay-staged-action.ts` | Modify | Add `promote_crystallized_skill` and `archive_crystallized_skill` cases. |
| Tests | Create | One test file per source file (alongside in same dir per repo convention). |

---

## Stage R1: Stop Hook + IPC + DB + DM

Goal: Stop hook fires, candidate row persists, DM lands in CLAIRE. **No slash commands yet** — observe 48h before R2.

### Task 1: DB table + UNIQUE INDEX

**Files:**
- Modify: `src/db.ts` (inside the schema-init block, after the `tasks` table block ending ~211)
- Test: `src/db-crystallize-candidates.test.ts`

- [ ] **Step 1: Write the failing test (UNIQUE INDEX race pin — C2)**

```typescript
// src/db-crystallize-candidates.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from './db.js';

describe('crystallize_candidates table', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); createSchema(db); });

  it('UNIQUE INDEX dedups (agent, content_hash, day)', () => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO crystallize_candidates
        (id, agent, source_group, source_jid, session_id, trace_summary,
         tool_sequence, content_hash, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const now = '2026-05-23T18:00:00.000Z';
    const expires = '2026-05-30T18:00:00.000Z';
    const r1 = insert.run('cc-aaa111', 'marvin', 'g', 'j', 's', 't', '[]', 'h1', now, expires);
    const r2 = insert.run('cc-bbb222', 'marvin', 'g', 'j', 's', 't', '[]', 'h1', now, expires);
    expect(r1.changes).toBe(1);
    expect(r2.changes).toBe(0); // dedup
    const rows = db.prepare(`SELECT id FROM crystallize_candidates`).all();
    expect(rows).toHaveLength(1);
  });

  it('UNIQUE INDEX permits same hash on different day', () => {
    const insert = db.prepare(`INSERT OR IGNORE INTO crystallize_candidates
      (id, agent, source_group, source_jid, session_id, trace_summary,
       tool_sequence, content_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insert.run('cc-1', 'm', 'g', 'j', 's', 't', '[]', 'h1', '2026-05-23T18:00:00Z', 'x');
    const r2 = insert.run('cc-2', 'm', 'g', 'j', 's', 't', '[]', 'h1', '2026-05-24T18:00:00Z', 'x');
    expect(r2.changes).toBe(1);
  });

  it('UNIQUE INDEX permits same hash for different agents', () => {
    const insert = db.prepare(`INSERT OR IGNORE INTO crystallize_candidates
      (id, agent, source_group, source_jid, session_id, trace_summary,
       tool_sequence, content_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insert.run('cc-1', 'marvin', 'g', 'j', 's', 't', '[]', 'h1', '2026-05-23T18:00:00Z', 'x');
    const r2 = insert.run('cc-2', 'einstein', 'g', 'j', 's', 't', '[]', 'h1', '2026-05-23T18:00:00Z', 'x');
    expect(r2.changes).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk bun --bun vitest run src/db-crystallize-candidates.test.ts`
Expected: FAIL with `SQLITE_ERROR: no such table: crystallize_candidates`

- [ ] **Step 3: Add table + indexes to the schema-init block**

In `src/db.ts`, inside the schema-init block in `createSchema` (the one whose final statement creates `idx_tasks_open_title` at line ~211), append before the closing backtick:

```sql
    CREATE TABLE IF NOT EXISTS crystallize_candidates (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      source_group TEXT NOT NULL,
      source_jid TEXT NOT NULL,
      session_id TEXT NOT NULL,
      trace_summary TEXT NOT NULL,
      tool_sequence TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      dm_message_id TEXT,
      pending_action_id TEXT,
      created_at TEXT NOT NULL,
      responded_at TEXT,
      expires_at TEXT NOT NULL,
      CHECK (status IN ('pending','accepted','skipped','expired','crystallized'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_dedup
      ON crystallize_candidates(agent, content_hash, substr(created_at, 1, 10));
    CREATE INDEX IF NOT EXISTS idx_cc_status_created
      ON crystallize_candidates(status, created_at);
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `rtk bun --bun vitest run src/db-crystallize-candidates.test.ts`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
rtk git add src/db.ts src/db-crystallize-candidates.test.ts
rtk git commit -m "feat(crystallize): add crystallize_candidates table + UNIQUE dedup index

Spec section 5.1. Race-safe dedup via UNIQUE INDEX
(agent, content_hash, day) + INSERT OR IGNORE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

Expected: commit lands; SHA shown.

---

### Task 2: DB helper functions

**Files:**
- Modify: `src/db.ts` (append exports, after existing `update*` functions ~1576)
- Test: `src/db-crystallize-candidates.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/db-crystallize-candidates.test.ts`:

```typescript
import {
  insertCrystallizeCandidate,
  getCrystallizeCandidate,
  updateCrystallizeCandidateStatus,
  countTodayCandidatesWithDm,
} from './db.js';

describe('crystallize_candidates helpers', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); createSchema(db); });

  it('insertCrystallizeCandidate returns true on insert, false on dedup', () => {
    const row = { id: 'cc-aaa111', agent: 'marvin', sourceGroup: 'g',
      sourceJid: 'j', sessionId: 's', traceSummary: 't', toolSequence: '[]',
      contentHash: 'h1', createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z' };
    expect(insertCrystallizeCandidate(db, row)).toBe(true);
    expect(insertCrystallizeCandidate(db, { ...row, id: 'cc-bbb222' })).toBe(false);
  });

  it('getCrystallizeCandidate returns row or null', () => {
    expect(getCrystallizeCandidate(db, 'cc-missing')).toBeNull();
    insertCrystallizeCandidate(db, { id: 'cc-aaa111', agent: 'm',
      sourceGroup: 'g', sourceJid: 'j', sessionId: 's', traceSummary: 't',
      toolSequence: '[]', contentHash: 'h1',
      createdAt: '2026-05-23T18:00:00Z', expiresAt: '2026-05-30T18:00:00Z' });
    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.agent).toBe('m');
    expect(row?.status).toBe('pending');
  });

  it('updateCrystallizeCandidateStatus mutates status + responded_at', () => {
    insertCrystallizeCandidate(db, { id: 'cc-aaa111', agent: 'm',
      sourceGroup: 'g', sourceJid: 'j', sessionId: 's', traceSummary: 't',
      toolSequence: '[]', contentHash: 'h1',
      createdAt: '2026-05-23T18:00:00Z', expiresAt: '2026-05-30T18:00:00Z' });
    updateCrystallizeCandidateStatus(db, 'cc-aaa111', 'accepted', '2026-05-23T19:00:00Z');
    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.status).toBe('accepted');
    expect(row?.responded_at).toBe('2026-05-23T19:00:00Z');
  });

  it('countTodayCandidatesWithDm counts only same-agent same-day dm-sent rows', () => {
    const today = '2026-05-23T18:00:00.000Z';
    const insertRaw = (id: string, agent: string, dmId: string | null, createdAt: string) =>
      db.prepare(`INSERT INTO crystallize_candidates
        (id, agent, source_group, source_jid, session_id, trace_summary,
         tool_sequence, content_hash, dm_message_id, created_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, agent, 'g', 'j', 's', 't', '[]', id, dmId, createdAt, 'x');
    insertRaw('cc-1', 'marvin', 'm1', today);
    insertRaw('cc-2', 'marvin', 'm2', today);
    insertRaw('cc-3', 'marvin', null, today);                  // no DM, not counted
    insertRaw('cc-4', 'einstein', 'm4', today);                // different agent
    insertRaw('cc-5', 'marvin', 'm5', '2026-05-22T18:00:00Z'); // yesterday
    expect(countTodayCandidatesWithDm(db, 'marvin', today)).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk bun --bun vitest run src/db-crystallize-candidates.test.ts`
Expected: 4 new tests FAIL with import errors.

- [ ] **Step 3: Add helper exports to `src/db.ts`**

Append at end of `src/db.ts` (or grouped with other helpers around line 1576):

```typescript
export interface CrystallizeCandidateInsert {
  id: string;
  agent: string;
  sourceGroup: string;
  sourceJid: string;
  sessionId: string;
  traceSummary: string;
  toolSequence: string;
  contentHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface CrystallizeCandidateRow {
  id: string;
  agent: string;
  source_group: string;
  source_jid: string;
  session_id: string;
  trace_summary: string;
  tool_sequence: string;
  content_hash: string;
  status: 'pending' | 'accepted' | 'skipped' | 'expired' | 'crystallized';
  dm_message_id: string | null;
  pending_action_id: string | null;
  created_at: string;
  responded_at: string | null;
  expires_at: string;
}

export function insertCrystallizeCandidate(
  database: Database.Database,
  row: CrystallizeCandidateInsert,
): boolean {
  const result = database
    .prepare(
      `INSERT OR IGNORE INTO crystallize_candidates
         (id, agent, source_group, source_jid, session_id, trace_summary,
          tool_sequence, content_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id, row.agent, row.sourceGroup, row.sourceJid, row.sessionId,
      row.traceSummary, row.toolSequence, row.contentHash, row.createdAt,
      row.expiresAt,
    );
  return result.changes === 1;
}

export function getCrystallizeCandidate(
  database: Database.Database,
  id: string,
): CrystallizeCandidateRow | null {
  const row = database
    .prepare(`SELECT * FROM crystallize_candidates WHERE id = ?`)
    .get(id) as CrystallizeCandidateRow | undefined;
  return row ?? null;
}

export function updateCrystallizeCandidateStatus(
  database: Database.Database,
  id: string,
  status: CrystallizeCandidateRow['status'],
  respondedAt: string,
  pendingActionId?: string,
): void {
  database
    .prepare(
      `UPDATE crystallize_candidates
         SET status = ?, responded_at = ?, pending_action_id = COALESCE(?, pending_action_id)
       WHERE id = ?`,
    )
    .run(status, respondedAt, pendingActionId ?? null, id);
}

export function setCrystallizeCandidateDm(
  database: Database.Database,
  id: string,
  dmMessageId: string,
): void {
  database
    .prepare(`UPDATE crystallize_candidates SET dm_message_id = ? WHERE id = ?`)
    .run(dmMessageId, id);
}

export function countTodayCandidatesWithDm(
  database: Database.Database,
  agent: string,
  nowIso: string,
): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS n FROM crystallize_candidates
        WHERE agent = ?
          AND substr(created_at, 1, 10) = substr(?, 1, 10)
          AND dm_message_id IS NOT NULL`,
    )
    .get(agent, nowIso) as { n: number };
  return row.n;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk bun --bun vitest run src/db-crystallize-candidates.test.ts`
Expected: 7 PASS (3 from Task 1 + 4 from this task).

- [ ] **Step 5: Commit**

```bash
rtk git add src/db.ts src/db-crystallize-candidates.test.ts
rtk git commit -m "feat(crystallize): db helpers for crystallize_candidates

insert (race-safe), get, updateStatus, setDm, countTodayWithDm.
Spec section 5.1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

---

### Task 3: Add `db` to `IpcDeps`

**Files:**
- Modify: `src/ipc.ts` (line ~38, append field to `IpcDeps`)
- Modify: all call sites that construct `IpcDeps` (grep `IpcDeps =`)
- Test: `src/ipc.test.ts` (light — typecheck is the real gate)

- [ ] **Step 1: Add field to interface**

In `src/ipc.ts:38-54`, add:

```typescript
export interface IpcDeps {
  db: import('better-sqlite3').Database;          // NEW — required for handlers that read/write tables
  sendMessage: (jid: string, text: string) => Promise<void>;
  // ... existing fields
}
```

- [ ] **Step 2: Find every construction site**

Run: `rtk grep -rn "IpcDeps = \|const deps: IpcDeps\|deps: IpcDeps" src/ container/ 2>&1`

For each call site, add `db` to the constructed object. The host has a singleton DB accessible via `getDb()` (or whatever the existing accessor is in `src/db.ts` — confirm via `rtk grep -n "^export.*Database" src/db.ts`).

- [ ] **Step 3: Typecheck clean**

Run: `rtk bun run typecheck`
Expected: 0 errors. (If errors appear, they list every constructor site that needs `db` populated — fix all in this commit.)

- [ ] **Step 4: Commit**

```bash
rtk git add src/ipc.ts src/  # plus any other call-site files
rtk git commit -m "feat(ipc): add db to IpcDeps for handler-side queries

crystallize_candidate (and future handlers) need DB access. Mirrors
how tests already pass a Database instance through ctx.deps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

---

### Task 4: Add `crystallize_candidate` + `crystallize_candidate_fetch` to SKIP_GATE_ALLOWLIST

**Files:**
- Modify: `src/ipc/handler.ts` (line ~57, before closing `])`)
- Test: `src/ipc/handlers/skills.test.ts`

- [ ] **Step 1: Write the failing regression-pin test**

Append to `src/ipc/handlers/skills.test.ts`:

```typescript
import { SKIP_GATE_ALLOWLIST } from '../handler.js';

describe('SKIP_GATE_ALLOWLIST — crystallize candidate types', () => {
  it('contains crystallize_candidate (regression pin C3)', () => {
    expect(SKIP_GATE_ALLOWLIST.has('crystallize_candidate')).toBe(true);
  });
  it('contains crystallize_candidate_fetch (regression pin C5a)', () => {
    expect(SKIP_GATE_ALLOWLIST.has('crystallize_candidate_fetch')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk bun --bun vitest run src/ipc/handlers/skills.test.ts -t "SKIP_GATE_ALLOWLIST — crystallize"`
Expected: 2 FAIL.

- [ ] **Step 3: Add entries to allowlist**

In `src/ipc/handler.ts:21-58`, append before the closing `])`:

```typescript
  // Crystallize candidate flow (spec 2026-05-23). Both are notify or
  // read-only telemetry; the body-generation that *creates* a SKILL.md
  // still goes through the existing crystallize_skill gate.
  'crystallize_candidate',
  'crystallize_candidate_fetch',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk bun --bun vitest run src/ipc/handlers/skills.test.ts -t "SKIP_GATE_ALLOWLIST — crystallize"`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/ipc/handler.ts src/ipc/handlers/skills.test.ts
rtk git commit -m "feat(crystallize): allowlist crystallize_candidate IPC types

Both new types are notify/read-only; the SKILL.md write still goes
through the existing crystallize_skill gate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

---

### Task 5: `crystallizeCandidateHandler` (notify-kind IPC)

**Files:**
- Modify: `src/ipc/handlers/skills.ts` (append at end)
- Modify: `src/ipc/handlers/index.ts` (register)
- Test: `src/ipc/handlers/skills.test.ts` (append)

- [ ] **Step 1: Add a `buildTestCtx` helper to `skills.test.ts` (if not present)**

```typescript
import Database from 'better-sqlite3';
import { createSchema } from '../../db.js';
function buildTestCtx(opts: { sourceGroup: string; agentName: string | null }) {
  const db = new Database(':memory:'); createSchema(db);
  const ctx: any = {
    sourceGroup: opts.sourceGroup,
    isMain: false,
    baseGroup: opts.sourceGroup,
    agentName: opts.agentName,
    requestId: null,
    registeredGroups: {},
    deps: {
      db,
      sendMessage: async (_j: string, _t: string) => undefined,
    },
    dataDir: '/tmp/test-data',
  };
  return ctx;
}
```

- [ ] **Step 2: Write the failing tests**

Append to `src/ipc/handlers/skills.test.ts`:

```typescript
import { crystallizeCandidateHandler } from './skills.js';
import { getCrystallizeCandidate } from '../../db.js';

describe('crystallize_candidate handler', () => {
  it('parses valid payload', () => {
    const parsed = crystallizeCandidateHandler.parse({
      type: 'crystallize_candidate',
      agent: 'marvin',
      sourceGroup: 'telegram_lab-claw',
      sourceJid: 'tg:-1003892106437',
      sessionId: 'sess-1',
      traceSummary: 'A'.repeat(600),
      toolSequence: [{ tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.agent).toBe('marvin');
  });

  it('parse rejects missing fields', () => {
    expect(crystallizeCandidateHandler.parse({})).toBeNull();
    expect(crystallizeCandidateHandler.parse({ type: 'crystallize_candidate', agent: 'm' })).toBeNull();
  });

  it('authorize is skipGate=true notify-only', () => {
    const auth = crystallizeCandidateHandler.authorize({} as any, {} as any);
    expect(auth?.skipGate).toBe(true);
    expect(auth?.notifySummary).toBe('');
    expect(auth?.payloadForStaging.type).toBe('crystallize_candidate');
  });

  it('responseKind is notify, not result', () => {
    expect(crystallizeCandidateHandler.responseKind).toBe('notify');
  });

  it('rejects sourceGroup mismatch (I8)', async () => {
    const ctx = buildTestCtx({ sourceGroup: 'telegram_lab-claw', agentName: 'marvin' });
    await crystallizeCandidateHandler.execute({
      agent: 'marvin', sourceGroup: 'telegram_other',  // mismatch
      sourceJid: 'j', sessionId: 's',
      traceSummary: 'A'.repeat(600),
      toolSequence: [{ tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' }],
    }, ctx);
    const rows = ctx.deps.db.prepare('SELECT * FROM crystallize_candidates').all();
    expect(rows).toHaveLength(0);
  });

  it('uses data.agent over ctx.agentName (I7 swarm-safe)', async () => {
    const ctx = buildTestCtx({ sourceGroup: 'telegram_lab-claw', agentName: 'claire' });
    await crystallizeCandidateHandler.execute({
      agent: 'marvin',  // payload says marvin
      sourceGroup: 'telegram_lab-claw',
      sourceJid: 'j', sessionId: 's',
      traceSummary: 'A'.repeat(600),
      toolSequence: [{ tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' }],
    }, ctx);
    const rows = ctx.deps.db.prepare(`SELECT agent FROM crystallize_candidates`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe('marvin');  // payload, not ctx
  });

  it('INSERT OR IGNOREs duplicates (C2)', async () => {
    const ctx = buildTestCtx({ sourceGroup: 'g', agentName: 'm' });
    const payload = { agent: 'm', sourceGroup: 'g', sourceJid: 'j',
      sessionId: 's', traceSummary: 'A'.repeat(600),
      toolSequence: [{ tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' }] };
    await crystallizeCandidateHandler.execute(payload, ctx);
    await crystallizeCandidateHandler.execute(payload, ctx);  // same content
    const rows = ctx.deps.db.prepare(`SELECT * FROM crystallize_candidates`).all();
    expect(rows).toHaveLength(1);
  });

  it('skips DM when day-cap (3) reached, persists row (I1)', async () => {
    const ctx = buildTestCtx({ sourceGroup: 'g', agentName: 'm' });
    const sendMessage = vi.fn().mockResolvedValue('msg-id-1');
    ctx.deps.sendMessage = sendMessage as any;
    for (let i = 0; i < 4; i++) {
      await crystallizeCandidateHandler.execute({
        agent: 'm', sourceGroup: 'g', sourceJid: 'j', sessionId: `s-${i}`,
        traceSummary: `A${i}`.repeat(300),  // differ to avoid dedup
        toolSequence: [
          { tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' },
          { tool: `mcp__x${i}__y`, argSummary: 'a', resultSummary: 'b' },
          { tool: `mcp__y${i}__z`, argSummary: 'a', resultSummary: 'b' },
        ],
      }, ctx);
    }
    expect(sendMessage).toHaveBeenCalledTimes(3);  // cap at 3
    const overflowRows = ctx.deps.db.prepare(
      `SELECT * FROM crystallize_candidates WHERE dm_message_id IS NULL`
    ).all();
    expect(overflowRows).toHaveLength(1);  // 4th row persisted, no DM
  });

  it('sends DM to Telegram CLAIRE jid (L3)', async () => {
    const ctx = buildTestCtx({ sourceGroup: 'g', agentName: 'm' });
    const sendMessage = vi.fn().mockResolvedValue('msg-id-1');
    ctx.deps.sendMessage = sendMessage as any;
    await crystallizeCandidateHandler.execute({
      agent: 'm', sourceGroup: 'g', sourceJid: 'tg:-1234',
      sessionId: 's', traceSummary: 'A'.repeat(600),
      toolSequence: [
        { tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' },
        { tool: 'mcp__honcho__profile', argSummary: 'a', resultSummary: 'b' },
        { tool: 'mcp__gmail__search', argSummary: 'c', resultSummary: 'd' },
      ],
    }, ctx);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0]).toBe('tg:8475020901');  // CLAIRE
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `rtk bun --bun vitest run src/ipc/handlers/skills.test.ts -t "crystallize_candidate handler"`
Expected: 8 FAIL (undefined handler).

- [ ] **Step 4: Implement handler — append to `src/ipc/handlers/skills.ts`**

Add the imports at the top of the file:

```typescript
import { createHash } from 'crypto';
import {
  insertCrystallizeCandidate,
  countTodayCandidatesWithDm,
  setCrystallizeCandidateDm,
} from '../../db.js';
```

Then append at the end of the file:

```typescript
const CLAIRE_JID = 'tg:8475020901';                // Section 6.2 lock-in L3
const CC_DAY_CAP = 3;                              // I1
const TRACE_SUMMARY_MAX = 2048;
const TOOL_SEQ_MAX_ENTRIES = 20;
const HASH_TRACE_PREFIX = 300;

interface CrystallizeCandidateInput {
  agent: string;
  sourceGroup: string;
  sourceJid: string;
  sessionId: string;
  traceSummary: string;
  toolSequence: Array<{ tool: string; argSummary: string; resultSummary: string }>;
}

function randBase36(n: number): string {
  let s = '';
  while (s.length < n) s += Math.random().toString(36).slice(2);
  return s.slice(0, n);
}

function formatCandidateDm(
  ccId: string, agent: string, sourceGroup: string,
  toolSeq: CrystallizeCandidateInput['toolSequence'], traceSummary: string,
): string {
  const toolNames = Array.from(
    new Set(toolSeq.map(t => t.tool.replace(/^mcp__/, '').replace(/__/g, '.'))),
  );
  const preview = traceSummary.slice(0, 200).replace(/\n/g, ' ');
  return `🧪 Crystallize candidate — ${agent} in ${sourceGroup}\n\n` +
         `Tools used (${toolNames.length}): ${toolNames.join(' · ')}\n\n` +
         `Last message (first 200): "${preview}${traceSummary.length > 200 ? '…' : ''}"\n\n` +
         `Reply:\n` +
         `  /crystallize-yes ${ccId}    → spawn body-gen, stage for /approve\n` +
         `  /crystallize-skip ${ccId}   → drop candidate`;
}

export const crystallizeCandidateHandler: IpcHandler<CrystallizeCandidateInput, void> = {
  type: 'crystallize_candidate',
  responseKind: 'notify',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.agent !== 'string') return null;
    if (typeof r.sourceGroup !== 'string') return null;
    if (typeof r.sourceJid !== 'string') return null;
    if (typeof r.sessionId !== 'string') return null;
    if (typeof r.traceSummary !== 'string') return null;
    if (!Array.isArray(r.toolSequence)) return null;
    return {
      agent: r.agent,
      sourceGroup: r.sourceGroup,
      sourceJid: r.sourceJid,
      sessionId: r.sessionId,
      traceSummary: r.traceSummary.slice(0, TRACE_SUMMARY_MAX),
      toolSequence: (r.toolSequence as any[]).slice(0, TOOL_SEQ_MAX_ENTRIES)
        .filter((e) => e && typeof e.tool === 'string')
        .map((e) => ({
          tool: String(e.tool),
          argSummary: typeof e.argSummary === 'string' ? e.argSummary.slice(0, 80) : '',
          resultSummary: typeof e.resultSummary === 'string' ? e.resultSummary.slice(0, 80) : '',
        })),
    };
  },

  authorize() {
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'crystallize_candidate' },
      skipGate: true,
    };
  },

  async execute(input, ctx) {
    // I8 deny-on-mismatch
    if (input.sourceGroup !== ctx.sourceGroup) {
      logger.warn(
        { claimed: input.sourceGroup, actual: ctx.sourceGroup,
          requestId: ctx.requestId },
        'crystallize_candidate: sourceGroup mismatch, rejected',
      );
      return;
    }

    const agentRe = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    if (!agentRe.test(input.agent)) {
      logger.warn({ agent: input.agent, requestId: ctx.requestId },
        'crystallize_candidate: invalid agent');
      return;
    }

    const contentHash = createHash('sha256')
      .update(JSON.stringify(input.toolSequence))
      .update(input.traceSummary.slice(0, HASH_TRACE_PREFIX))
      .digest('hex');

    const ccId = `cc-${randBase36(6)}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();

    const db = ctx.deps.db;
    if (!db) {
      logger.error({ requestId: ctx.requestId }, 'crystallize_candidate: ctx.deps.db missing');
      return;
    }

    const inserted = insertCrystallizeCandidate(db, {
      id: ccId, agent: input.agent, sourceGroup: input.sourceGroup,
      sourceJid: input.sourceJid, sessionId: input.sessionId,
      traceSummary: input.traceSummary,
      toolSequence: JSON.stringify(input.toolSequence),
      contentHash, createdAt: now, expiresAt,
    });
    if (!inserted) {
      logger.debug({ agent: input.agent, contentHash, requestId: ctx.requestId },
        'crystallize_candidate: dedup hit');
      return;
    }

    // I1 day cap
    if (countTodayCandidatesWithDm(db, input.agent, now) >= CC_DAY_CAP) {
      logger.info({ agent: input.agent, ccId, requestId: ctx.requestId },
        'crystallize_candidate: day-cap hit, queued for digest');
      return;
    }

    // L3: DM Telegram CLAIRE
    try {
      const dmText = formatCandidateDm(ccId, input.agent, input.sourceGroup,
        input.toolSequence, input.traceSummary);
      // IpcDeps.sendMessage returns void; the Telegram channel implementation
      // may return a message id internally. For the test seam we accept either.
      const msgIdMaybe = await ctx.deps.sendMessage(CLAIRE_JID, dmText);
      const msgId = typeof msgIdMaybe === 'string' ? msgIdMaybe : ccId;
      setCrystallizeCandidateDm(db, ccId, msgId);
    } catch (err) {
      logger.error({ err, ccId, requestId: ctx.requestId },
        'crystallize_candidate: DM failed');
    }
  },
};
```

Register in `src/ipc/handlers/index.ts`:

```typescript
import { crystallizeCandidateHandler } from './skills.js';
// inside registerBuiltinHandlers:
registry.register(crystallizeCandidateHandler);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `rtk bun --bun vitest run src/ipc/handlers/skills.test.ts -t "crystallize_candidate handler"`
Expected: 8 PASS.

- [ ] **Step 6: Typecheck + lint clean**

Run: `rtk bun run typecheck && rtk bun run lint`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
rtk git add src/ipc/handlers/skills.ts src/ipc/handlers/skills.test.ts src/ipc/handlers/index.ts
rtk git commit -m "feat(crystallize): crystallizeCandidateHandler — notify-kind IPC

I7 swarm-safe (data.agent over ctx.agentName), I8 deny-on-mismatch,
I1 day-cap (3/agent/day with overflow->digest), C1 DM to Telegram
CLAIRE jid, C2 race-safe via UNIQUE INDEX, C6 content-hash dedup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

---

### Task 6: Stop hook (container) + tool whitelist

**Files:**
- Modify: `container/agent-runner/src/index.ts` (add `createStopHook`, `extractToolSequence`, register Stop hook ~820)
- Test: `container/agent-runner/src/stop-hook.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `container/agent-runner/src/stop-hook.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  extractToolSequence,
  createStopHook,
  __setStopHookTaskDirForTests,
} from './index.js';

describe('extractToolSequence', () => {
  it('parses tool_use entries from a JSONL transcript', () => {
    const tmp = path.join(os.tmpdir(), `t-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'mcp__qmd__query', input: { query: 'grants' } },
      ] }}),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: '1', content: '7 hits' },
      ] }}),
    ];
    fs.writeFileSync(tmp, lines.join('\n'));
    const seq = extractToolSequence(tmp);
    expect(seq).toHaveLength(1);
    expect(seq[0].tool).toBe('mcp__qmd__query');
    expect(seq[0].argSummary).toContain('grants');
    fs.unlinkSync(tmp);
  });

  it('returns empty array on missing file', () => {
    expect(extractToolSequence('/nonexistent')).toEqual([]);
  });
});

describe('createStopHook gate', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
    __setStopHookTaskDirForTests(tmpDir);
  });

  const transcriptWith = (toolNames: string[]) => {
    const tmp = path.join(os.tmpdir(), `t-${Date.now()}-${Math.random()}.jsonl`);
    const lines = toolNames.map(name => JSON.stringify({
      type: 'assistant', message: { content: [
        { type: 'tool_use', name, input: { x: 'y' } },
      ] }}));
    fs.writeFileSync(tmp, lines.join('\n'));
    return tmp;
  };

  it('skips when stop_hook_active=true (R3 re-entry)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: true,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, {} as any);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('skips when no agentName', async () => {
    const hook = createStopHook(undefined, 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, {} as any);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('skips when assistant text <500 chars', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'short', session_id: 's' } as any, {} as any);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('skips when <3 distinct MCP tools', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__qmd__query']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, {} as any);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('counts Skill tool toward distinct (I3)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'Skill']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, {} as any);
    expect(fs.readdirSync(tmpDir)).toHaveLength(1);
  });

  it('skips when "I could not" at sentence start (I2)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    const msg = 'Did the work. ' + 'A'.repeat(490) + ". I couldn't find the answer.";
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: msg, session_id: 's' } as any, {} as any);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('does NOT skip on "the user could not" (I2 false-negative pin)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    const msg = ('A'.repeat(500)) + ". The user couldn't find the answer, so I helped.";
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: msg, session_id: 's' } as any, {} as any);
    expect(fs.readdirSync(tmpDir)).toHaveLength(1);
  });

  it('writes IPC file with group+agent+ts+rand in filename (I8)', async () => {
    const hook = createStopHook('marvin', 'telegram_lab-claw', 'tg:-1234');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, {} as any);
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^crystallize-candidate-telegram_lab-claw-marvin-\d+-[a-z0-9]{6}\.json$/);
    const body = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'));
    expect(body.type).toBe('crystallize_candidate');
    expect(body.agent).toBe('marvin');
    expect(body.sourceGroup).toBe('telegram_lab-claw');
    expect(body.sourceJid).toBe('tg:-1234');
    expect(body.traceSummary.length).toBeLessThanOrEqual(2048);
    expect(Array.isArray(body.toolSequence)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd container/agent-runner && rtk bun --bun vitest run src/stop-hook.test.ts`
Expected: 10 FAIL (imports undefined).

- [ ] **Step 3: Implement in `container/agent-runner/src/index.ts`**

Add near top:

```typescript
// Test seam: lets unit tests redirect IPC file writes to a tmpdir.
let STOP_HOOK_TASK_DIR = '/workspace/ipc/tasks';
export function __setStopHookTaskDirForTests(dir: string): void {
  STOP_HOOK_TASK_DIR = dir;
}

export interface ToolSeqEntry {
  tool: string;
  argSummary: string;
  resultSummary: string;
}

export function extractToolSequence(transcriptPath: string): ToolSeqEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return []; }

  const out: ToolSeqEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const blocks = entry?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          out.push({
            tool: b.name,
            argSummary: JSON.stringify(b.input ?? {}).slice(0, 80),
            resultSummary: '',
          });
        } else if (b?.type === 'tool_result' && typeof b.content === 'string') {
          if (out.length > 0) {
            out[out.length - 1].resultSummary = b.content.slice(0, 80);
          }
        }
      }
    } catch { /* malformed line, skip */ }
  }
  return out;
}

export function createStopHook(
  agentName: string | undefined,
  sourceGroup: string,
  sourceJid: string,
): HookCallback {
  return async (input) => {
    const stop = input as { stop_hook_active?: boolean; last_assistant_message?: string;
                            transcript_path?: string; session_id?: string };
    if (stop.stop_hook_active === true) return {};            // R3 re-entry guard
    if (!agentName) return {};

    const lastMsg = stop.last_assistant_message ?? '';
    if (lastMsg.length < 500) return {};

    const tools = stop.transcript_path ? extractToolSequence(stop.transcript_path) : [];
    const meaningful = tools.filter(t => t.tool.startsWith('mcp__') || t.tool === 'Skill');
    if (new Set(meaningful.map(t => t.tool)).size < 3) return {};

    // I2: word-boundary at sentence start
    if (/(^|[.!?]\s+)(I|we)\s+(couldn't|cannot|failed)\b/i.test(lastMsg)) return {};
    if (/\bunclear (whether|if|how)\b/i.test(lastMsg)) return {};

    const rand = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 6).padEnd(6, '0');
    const fname = `crystallize-candidate-${sourceGroup}-${agentName}-${Date.now()}-${rand}.json`;
    const taskFile = path.join(STOP_HOOK_TASK_DIR, fname);

    try {
      fs.writeFileSync(taskFile, JSON.stringify({
        type: 'crystallize_candidate',
        agent: agentName,
        sourceGroup,
        sourceJid,
        sessionId: stop.session_id ?? '',
        traceSummary: lastMsg.slice(0, 2048),
        toolSequence: meaningful.slice(-20),
      }));
    } catch (err) {
      log(`crystallize_candidate IPC write failed: ${err}`);
    }
    return {};
  };
}
```

Register at line ~820 alongside existing hooks:

```typescript
hooks: {
  PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
  PreToolUse: [{ hooks: [createPreToolUseHook(containerInput.agentName, crystallizedSkillNames)] }],
  Stop: [{ hooks: [createStopHook(
    containerInput.agentName,
    containerInput.groupFolder,
    containerInput.chatJid,
  )] }],
},
```

Verify `groupFolder` and `chatJid` exist on `containerInput`. If not, add them to the interface in `container/agent-runner/src/types.ts` and to the host-side dispatch in `src/container-runner.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd container/agent-runner && rtk bun --bun vitest run src/stop-hook.test.ts`
Expected: 10 PASS.

- [ ] **Step 5: Rebuild container image**

```bash
./container/build.sh
```

Expected: Build succeeds; agent-runner source picked up. (Per MEMORY.md: agent-runner source is cached per-group at `data/sessions/{group}/agent-runner-src/` — delete if stale changes don't appear.)

- [ ] **Step 6: Commit**

```bash
rtk git add container/agent-runner/src/index.ts container/agent-runner/src/stop-hook.test.ts \
            container/agent-runner/src/types.ts src/container-runner.ts
rtk git commit -m "feat(crystallize): Stop hook fires crystallize_candidate IPC

Structural+verbosity gate (>=3 distinct MCP tools incl Skill, >=500
char message, no sentence-start failure phrases). Re-entry guard.
Filename includes group+agent+ts+rand for I8 collision/spoofing
resistance. Test seam STOP_HOOK_TASK_DIR for unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

---

### Task 7: Stage R1 ship + 48h observation

- [ ] **Step 1: Restart NanoClaw**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 3
tail -40 logs/nanoclaw.log
```

Expected: No startup errors. Stop hook line should appear once a session ends.

- [ ] **Step 2: Manual smoke (in any group)**

Send any normal multi-tool prompt in LAB-claw or SCIENCE-claw (e.g. "Aggregate this week's grant deadlines across calendar + Notion + email"). Wait for the agent to finish.

- [ ] **Step 3: Verify DM landed in CLAIRE**

Open Telegram CLAIRE. Expect a 🧪 Crystallize candidate DM within ~5s of the session ending.

- [ ] **Step 4: Inspect DB**

```bash
sqlite3 store/messages.db "SELECT id, agent, source_group, status, dm_message_id, length(trace_summary), substr(content_hash, 1, 8) FROM crystallize_candidates ORDER BY created_at DESC LIMIT 5;"
```

Expected: ≥1 row with status='pending', dm_message_id non-null.

- [ ] **Step 5: Observation gate (48h)**

For 48h, count DMs/day:

```bash
sqlite3 store/messages.db "SELECT substr(created_at,1,10) AS d, COUNT(*) FROM crystallize_candidates GROUP BY d ORDER BY d DESC;"
```

R1 → R2 gate: ≤5 DMs/day AND ≥1 looks like a real recipe.

If gate fails:
- Too many → tighten gate (raise tool-count threshold to 4, or add Ollama secondary classifier as deferred).
- Zero → loosen gate (drop verbosity threshold to 300, broaden tool whitelist).

---

## Stage R2: Slash Commands + Body-Gen MCP Tool

Goal: User can `/crystallize-yes cc-xxx` to trigger body generation. End-to-end first crystallization lands in `pending_actions` for `/approve`.

### Task 8: `crystallize_candidate_fetch` IPC handler

**Files:**
- Modify: `src/ipc/handlers/skills.ts` (append)
- Test: `src/ipc/handlers/skills.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `skills.test.ts`:

```typescript
import { crystallizeCandidateFetchHandler } from './skills.js';

describe('crystallize_candidate_fetch handler', () => {
  it('responseKind is result, skipGate true', () => {
    expect(crystallizeCandidateFetchHandler.responseKind).toBe('result');
    const auth = crystallizeCandidateFetchHandler.authorize({} as any, {} as any);
    expect(auth?.skipGate).toBe(true);
  });

  it('parse rejects missing ccId', () => {
    expect(crystallizeCandidateFetchHandler.parse({})).toBeNull();
    expect(crystallizeCandidateFetchHandler.parse({ ccId: 'cc-aaa111' })).not.toBeNull();
  });

  it('returns hydrated row by ccId', async () => {
    const ctx = buildTestCtx({ sourceGroup: 'g', agentName: 'm' });
    insertCrystallizeCandidate(ctx.deps.db, {
      id: 'cc-aaa111', agent: 'marvin', sourceGroup: 'g', sourceJid: 'j',
      sessionId: 's', traceSummary: 'aggregated grant deadlines',
      toolSequence: '[{"tool":"mcp__qmd__query","argSummary":"x","resultSummary":"y"}]',
      contentHash: 'h', createdAt: 'now', expiresAt: 'later',
    });
    const result = await crystallizeCandidateFetchHandler.execute(
      { ccId: 'cc-aaa111' }, ctx);
    expect(result.executed).toBe(true);
    expect(result.result.success).toBe(true);
    expect(result.result.data?.agent).toBe('marvin');
    expect(result.result.data?.traceSummary).toBe('aggregated grant deadlines');
    expect(result.result.data?.toolSequence).toEqual([
      { tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' },
    ]);
  });

  it('returns not_found on missing ccId', async () => {
    const ctx = buildTestCtx({ sourceGroup: 'g', agentName: 'm' });
    const result = await crystallizeCandidateFetchHandler.execute(
      { ccId: 'cc-missing' }, ctx);
    expect(result.result.success).toBe(false);
    expect(result.result.message).toContain('not_found');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk bun --bun vitest run src/ipc/handlers/skills.test.ts -t "crystallize_candidate_fetch"`
Expected: 4 FAIL.

- [ ] **Step 3: Implement handler — append to `src/ipc/handlers/skills.ts`**

```typescript
import { getCrystallizeCandidate } from '../../db.js';  // (add to top if not already)

interface CrystallizeCandidateFetchInput {
  ccId: string;
}

interface CrystallizeCandidateFetchData {
  agent: string;
  sourceGroup: string;
  traceSummary: string;
  toolSequence: Array<{ tool: string; argSummary: string; resultSummary: string }>;
  status: string;
}

export const crystallizeCandidateFetchHandler: IpcHandler<
  CrystallizeCandidateFetchInput,
  { executed: true; result: { success: boolean; message: string;
                              data?: CrystallizeCandidateFetchData } }
> = {
  type: 'crystallize_candidate_fetch',
  responseKind: 'result',
  resultsDirName: 'crystallize_candidate_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.ccId !== 'string' || !/^cc-[a-z0-9]{6}$/.test(r.ccId)) return null;
    return { ccId: r.ccId };
  },

  authorize() {
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'crystallize_candidate_fetch' },
      skipGate: true,
    };
  },

  async execute(input, ctx) {
    const db = ctx.deps.db;
    const row = getCrystallizeCandidate(db, input.ccId);
    if (!row) {
      return { executed: true, result: { success: false,
        message: `not_found: candidate ${input.ccId}` } };
    }
    return {
      executed: true,
      result: {
        success: true,
        message: 'ok',
        data: {
          agent: row.agent,
          sourceGroup: row.source_group,
          traceSummary: row.trace_summary,
          toolSequence: JSON.parse(row.tool_sequence),
          status: row.status,
        },
      },
    };
  },
};
```

Register in `src/ipc/handlers/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk bun --bun vitest run src/ipc/handlers/skills.test.ts -t "crystallize_candidate_fetch"`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/ipc/handlers/skills.ts src/ipc/handlers/skills.test.ts src/ipc/handlers/index.ts
rtk git commit -m "feat(crystallize): crystallize_candidate_fetch read-only IPC

Lets the body-gen one-shot task hydrate the candidate row from inside
the container (no file-mount of store/messages.db). result-kind +
skipGate=true matches skill_search shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

---

### Task 9: MCP tool wrapper in container

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (add tool definition)
- Test: `container/agent-runner/src/ipc-mcp-stdio.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// container/agent-runner/src/ipc-mcp-stdio.test.ts (append)
describe('nanoclaw.crystallize_candidate_fetch tool registration', () => {
  it('is registered with the expected schema', async () => {
    const tools = await listMcpTools();  // reuse existing test helper
    const t = tools.find(t => t.name === 'crystallize_candidate_fetch');
    expect(t).toBeDefined();
    expect(t!.inputSchema).toMatchObject({
      type: 'object',
      properties: { ccId: { type: 'string' } },
      required: ['ccId'],
    });
  });
});
```

- [ ] **Step 2: Run to verify FAIL** (`tool not found`)

Run: `cd container/agent-runner && rtk bun --bun vitest run src/ipc-mcp-stdio.test.ts -t "crystallize_candidate_fetch"`

- [ ] **Step 3: Implement — add tool definition in `ipc-mcp-stdio.ts`**

Find the existing tool-registration block (alongside `schedule_wakeup`, `bus_send`, etc.). Add:

```typescript
{
  name: 'crystallize_candidate_fetch',
  description: 'Fetch a crystallize candidate row by ID. Returns trace_summary + tool_sequence as JSON, for use during body generation triggered by /crystallize-yes.',
  inputSchema: {
    type: 'object',
    properties: {
      ccId: { type: 'string', pattern: '^cc-[a-z0-9]{6}$' },
    },
    required: ['ccId'],
  },
  handler: async (args: { ccId: string }) => {
    return await callIpcWithResult({
      type: 'crystallize_candidate_fetch',
      ccId: args.ccId,
    });
  },
},
```

(Reuse the existing `callIpcWithResult` helper — same pattern as `skill_search`.)

- [ ] **Step 4: PASS** + rebuild container.

- [ ] **Step 5: Commit**

```bash
rtk git add container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/src/ipc-mcp-stdio.test.ts
rtk git commit -m "feat(crystallize): expose crystallize_candidate_fetch as MCP tool

Body-gen one-shot calls this to hydrate the candidate row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

---

### Task 10: Slash command helpers

**Files:**
- Create: `src/commands/crystallize-command.ts`
- Test: `src/commands/crystallize-command.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/commands/crystallize-command.test.ts
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema, insertCrystallizeCandidate, getCrystallizeCandidate } from '../db.js';
import { extractCrystallizeCommand, handleCrystallizeCommand } from './crystallize-command.js';

describe('extractCrystallizeCommand', () => {
  it('parses /crystallize-yes cc-aaa111', () => {
    expect(extractCrystallizeCommand('/crystallize-yes cc-aaa111')).toEqual({
      kind: 'yes', ccId: 'cc-aaa111',
    });
  });
  it('parses /crystallize-skip cc-bbb222', () => {
    expect(extractCrystallizeCommand('/crystallize-skip cc-bbb222')).toEqual({
      kind: 'skip', ccId: 'cc-bbb222',
    });
  });
  it('returns null on non-match', () => {
    expect(extractCrystallizeCommand('/approve cc-aaa111')).toBeNull();
    expect(extractCrystallizeCommand('/crystallize-yes garbage')).toBeNull();
    expect(extractCrystallizeCommand('plain text')).toBeNull();
  });
});

describe('handleCrystallizeCommand /crystallize-yes', () => {
  const setup = () => {
    const db = new Database(':memory:'); createSchema(db);
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111', agent: 'marvin', sourceGroup: 'telegram_lab-claw',
      sourceJid: 'tg:-1234', sessionId: 's', traceSummary: 'did stuff',
      toolSequence: '[]', contentHash: 'h',
      createdAt: '2026-05-23T18:00:00Z',
      expiresAt: '2026-05-30T18:00:00Z',
    });
    return db;
  };

  it('yes happy path: marks accepted, inserts task row, propagates source_group', async () => {
    const db = setup();
    const createTask = vi.fn();
    const reply = await handleCrystallizeCommand(
      { kind: 'yes', ccId: 'cc-aaa111' },
      { db, createTask, now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('Scheduled body-gen');
    expect(reply).toContain('telegram_lab-claw');
    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.status).toBe('accepted');
    expect(row?.responded_at).toBe('2026-05-23T19:00:00Z');
    expect(createTask).toHaveBeenCalledOnce();
    expect(createTask.mock.calls[0][0]).toMatchObject({
      group_folder: 'telegram_lab-claw',
      source: 'scheduled-task',
    });
    expect(createTask.mock.calls[0][0].context).toContain('cc-aaa111');
    expect(createTask.mock.calls[0][0].context).toContain('mcp__nanoclaw__crystallize_candidate_fetch');
  });

  it('yes on missing ccId returns error reply', async () => {
    const db = setup();
    const reply = await handleCrystallizeCommand(
      { kind: 'yes', ccId: 'cc-missing' },
      { db, createTask: vi.fn(), now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('not found');
  });

  it('yes on expired returns error, no task created', async () => {
    const db = new Database(':memory:'); createSchema(db);
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111', agent: 'm', sourceGroup: 'g', sourceJid: 'j',
      sessionId: 's', traceSummary: 't', toolSequence: '[]', contentHash: 'h',
      createdAt: '2026-05-01T18:00:00Z',
      expiresAt: '2026-05-08T18:00:00Z',  // already expired
    });
    const createTask = vi.fn();
    const reply = await handleCrystallizeCommand(
      { kind: 'yes', ccId: 'cc-aaa111' },
      { db, createTask, now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('expired');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('yes on already-accepted returns error, no task created', async () => {
    const db = setup();
    db.prepare(`UPDATE crystallize_candidates SET status='accepted' WHERE id='cc-aaa111'`).run();
    const createTask = vi.fn();
    const reply = await handleCrystallizeCommand(
      { kind: 'yes', ccId: 'cc-aaa111' },
      { db, createTask, now: () => '2026-05-23T19:00:00Z' },
    );
    expect(reply).toContain('not pending');
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('handleCrystallizeCommand /crystallize-skip', () => {
  it('skip happy path', async () => {
    const db = new Database(':memory:'); createSchema(db);
    insertCrystallizeCandidate(db, {
      id: 'cc-aaa111', agent: 'm', sourceGroup: 'g', sourceJid: 'j',
      sessionId: 's', traceSummary: 't', toolSequence: '[]', contentHash: 'h',
      createdAt: '2026-05-23T18:00:00Z', expiresAt: '2026-05-30T18:00:00Z',
    });
    const reply = await handleCrystallizeCommand(
      { kind: 'skip', ccId: 'cc-aaa111' },
      { db, createTask: vi.fn(), now: () => 'now' },
    );
    expect(reply).toContain('Skipped');
    const row = getCrystallizeCandidate(db, 'cc-aaa111');
    expect(row?.status).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `rtk bun --bun vitest run src/commands/crystallize-command.test.ts`
Expected: all FAIL (module missing).

- [ ] **Step 3: Implement `src/commands/crystallize-command.ts`**

```typescript
import type Database from 'better-sqlite3';
import {
  getCrystallizeCandidate,
  updateCrystallizeCandidateStatus,
} from '../db.js';

export interface CrystallizeCommand {
  kind: 'yes' | 'skip';
  ccId: string;
}

const PATTERN = /^\/crystallize-(yes|skip)\s+(cc-[a-z0-9]{6})\b/;

export function extractCrystallizeCommand(text: string): CrystallizeCommand | null {
  const m = text.match(PATTERN);
  if (!m) return null;
  return { kind: m[1] as 'yes' | 'skip', ccId: m[2] };
}

export interface CrystallizeDeps {
  db: Database.Database;
  createTask: (task: {
    title: string;
    context: string;
    owner: string | null;
    priority: number;
    group_folder: string;
    source: string;
    source_ref: string;
  }) => void;
  now: () => string;
}

export async function handleCrystallizeCommand(
  cmd: CrystallizeCommand, deps: CrystallizeDeps,
): Promise<string> {
  const row = getCrystallizeCandidate(deps.db, cmd.ccId);
  if (!row) return `Crystallize candidate ${cmd.ccId} not found.`;

  if (cmd.kind === 'skip') {
    if (row.status !== 'pending') {
      return `Crystallize candidate ${cmd.ccId} status=${row.status}, not pending.`;
    }
    updateCrystallizeCandidateStatus(deps.db, cmd.ccId, 'skipped', deps.now());
    return `Skipped ${cmd.ccId}.`;
  }

  // yes
  if (row.status !== 'pending') {
    return `Crystallize candidate ${cmd.ccId} status=${row.status}, not pending.`;
  }
  if (row.expires_at < deps.now()) {
    updateCrystallizeCandidateStatus(deps.db, cmd.ccId, 'expired', deps.now());
    return `Crystallize candidate ${cmd.ccId} expired (created ${row.created_at.slice(0,10)}).`;
  }

  updateCrystallizeCandidateStatus(deps.db, cmd.ccId, 'accepted', deps.now());
  deps.createTask({
    title: `crystallize body-gen ${cmd.ccId}`,
    context: bodyGenPrompt(cmd.ccId, row.agent, row.source_group),
    owner: row.agent,
    priority: 3,
    group_folder: row.source_group,
    source: 'scheduled-task',
    source_ref: cmd.ccId,
  });
  return `Scheduled body-gen for ${cmd.ccId} in ${row.source_group}. pa-xxx will appear when done.`;
}

function bodyGenPrompt(ccId: string, agent: string, sourceGroup: string): string {
  return [
    `Body-generation for ${ccId}.`,
    ``,
    `Call mcp__nanoclaw__crystallize_candidate_fetch with ccId="${ccId}" to hydrate`,
    `trace_summary + tool_sequence. Then follow the /crystallize skill steps 1-4:`,
    `  1. Pick a kebab-case name + a "Use when..." description.`,
    `  2. Write the SKILL.md body (When to use / Steps / Context hints).`,
    `  3. Self-report confidence 1-10 (skip if <5).`,
    `  4. Fire crystallize_skill IPC.`,
    ``,
    `You are ${agent} in ${sourceGroup}. The candidate came from your prior session.`,
    `Generalize the recipe, do not replay specifics.`,
  ].join('\n');
}
```

- [ ] **Step 4: PASS**

Run: `rtk bun --bun vitest run src/commands/crystallize-command.test.ts`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/commands/crystallize-command.ts src/commands/crystallize-command.test.ts
rtk git commit -m "feat(crystallize): extract/handle crystallize-yes and -skip commands

Mirrors extract/handleApprovalCommand shape. /yes inserts a scheduled
task targeting the originating group with a prompt that hydrates the
candidate via the new MCP tool and runs the crystallize skill.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

---

### Task 11: Wire slash commands into `src/index.ts` message loop

**Files:**
- Modify: `src/index.ts` (after the /approve block at ~495, before generic message handling)
- Test: integration — covered by manual E2E in next step

- [ ] **Step 1: Read the current /approve wiring at lines 370-415 for context, then add a parallel block**

In `src/index.ts`, add the import near top:

```typescript
import {
  extractCrystallizeCommand,
  handleCrystallizeCommand,
} from './commands/crystallize-command.js';
```

Below the existing `maybeHandleApproval` function (~line 416), add a parallel:

```typescript
async function maybeHandleCrystallize(
  text: string,
  sendMessage: (text: string) => Promise<void>,
): Promise<boolean> {
  const trimmed = text.trim();
  const cmd = extractCrystallizeCommand(trimmed);
  if (!cmd) return false;
  const reply = await handleCrystallizeCommand(cmd, {
    db: getDb(),                                  // import from ./db.js (singleton)
    createTask: (t) => createTask(t),             // existing helper from db.ts
    now: () => new Date().toISOString(),
  });
  await sendMessage(reply);
  return true;
}
```

In the message loop near line 495 (right after the `/approve` for-loop), add a parallel for-loop:

```typescript
// --- /crystallize-yes, /crystallize-skip (spec 2026-05-23) ---
// Main-group only (mirrors /approve). The DM lands in CLAIRE so the
// reply is naturally main-gated.
if (isMainGroup) {
  for (const m of missedMessages) {
    const text = m.content.trim().replace(groupTriggerPattern, '').trim();
    const handled = await maybeHandleCrystallize(text,
      (txt) => channel.sendMessage(chatJid, formatOutbound(txt, channel.name as ChannelType) ?? ''));
    if (handled) {
      lastAgentSeq[chatJid] = m.seq;
      saveState();
      return true;
    }
  }
}
```

- [ ] **Step 2: Manual smoke: typecheck + restart**

```bash
rtk bun run typecheck && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 3: E2E manual test**

After any R1 candidate DM arrives in CLAIRE:
1. Reply `/crystallize-yes cc-xxxxxx` (use the ccId from the DM).
2. Verify reply: `Scheduled body-gen for cc-xxxxxx in {sourceGroup}. pa-xxx will appear when done.`
3. Check the `tasks` table:
   ```bash
   sqlite3 store/messages.db "SELECT id, title, status, group_folder, source FROM tasks WHERE source_ref='cc-xxxxxx';"
   ```
4. Wait for the scheduler to fire (within 60s). Watch logs:
   ```bash
   tail -f logs/nanoclaw.log | grep -E "crystallize|cc-xxxxxx"
   ```
5. Expect: agent in originating group spawns, calls `crystallize_candidate_fetch`, generates body, fires `crystallize_skill` IPC.
6. Verify `pending_actions`:
   ```bash
   sqlite3 store/messages.db "SELECT id, action_type, status FROM pending_actions WHERE action_type='crystallize_skill' ORDER BY created_at DESC LIMIT 3;"
   ```
7. In the originating group, `/approve pa-xxx`.
8. Verify SKILL.md on disk:
   ```bash
   ls data/agents/{agent}/skills/crystallized/{name}/SKILL.md
   ```

- [ ] **Step 4: Commit**

```bash
rtk git add src/index.ts
rtk git commit -m "feat(crystallize): wire /crystallize-yes and -skip into message loop

Main-group gated (mirrors /approve). Two new inline if-blocks; no
src/commands/ auto-discovery framework added.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

---

### Task 12: Stage R2 ship gate — first successful end-to-end

- [ ] **Step 1: Manual E2E (from Task 11 step 3) must succeed once with no hallucination**

Inspect the resulting SKILL.md body:
- Names a real recipe, not a replay of specifics.
- Has `## When to use`, `## Steps`, `## Context hints` sections.
- Confidence ≥7 in frontmatter.

If body is wrong (hallucinated, mentions specifics not in trace_summary, etc.):
- Iterate on the body-gen prompt in `bodyGenPrompt()` in `src/commands/crystallize-command.ts`. Re-run via a fresh `/crystallize-yes` on a new candidate.

R2 → R3 gate: 1 successful end-to-end crystallization with a body that passes manual review.

---

## Stage R3: Weekly Digest Cron

### Task 13: `crystallize-weekly-digest.py`

**Files:**
- Create: `scripts/guards/crystallize-weekly-digest.py`
- Create: `scripts/guards/test_crystallize_weekly_digest.py`

- [ ] **Step 1: Write the failing test**

```python
# scripts/guards/test_crystallize_weekly_digest.py
"""Tests use subprocess to invoke the script with list-args (no shell)."""
import os, sys, json, sqlite3, tempfile, shutil
import subprocess as sp
from pathlib import Path
from datetime import datetime, timezone, timedelta

SCRIPT = Path(__file__).parent / "crystallize-weekly-digest.py"

def invoke(env):
    return sp.run(["python3", str(SCRIPT)], env={**os.environ, **env},
                  capture_output=True, text=True)  # list args = no shell

def setup_tmp():
    tmp = Path(tempfile.mkdtemp())
    (tmp / "data" / "agents" / "marvin" / "skills" / "crystallized").mkdir(parents=True)
    (tmp / "cache").mkdir()
    (tmp / "store").mkdir()
    db = tmp / "store" / "messages.db"
    con = sqlite3.connect(db)
    con.executescript("""
        CREATE TABLE crystallize_candidates (
          id TEXT, agent TEXT, source_group TEXT, source_jid TEXT,
          session_id TEXT, trace_summary TEXT, tool_sequence TEXT,
          content_hash TEXT, status TEXT, dm_message_id TEXT,
          pending_action_id TEXT, created_at TEXT, responded_at TEXT,
          expires_at TEXT);
    """)
    con.commit()
    return tmp, db

def test_empty_state_exits_1():
    tmp, db = setup_tmp()
    try:
        r = invoke({"NANOCLAW_DB": str(db),
                    "NANOCLAW_AGENTS_DIR": str(tmp / "data" / "agents"),
                    "NANOCLAW_DIGEST_OUT": str(tmp / "cache" / "digest.md")})
        assert r.returncode == 1, r.stderr
        assert not (tmp / "cache" / "digest.md").exists()
    finally:
        shutil.rmtree(tmp)

def test_renders_top5_unused_and_overflow():
    tmp, db = setup_tmp()
    try:
        agent_dir = tmp / "data" / "agents" / "marvin" / "skills" / "crystallized"
        now = datetime.now(timezone.utc).isoformat()
        usage = "\n".join([
            json.dumps({"ts": now, "agent": "marvin", "name": "deadline-agg", "sourceGroup": "g"})
            for _ in range(7)
        ])
        (agent_dir / "usage.jsonl").write_text(usage)
        log_entry = json.dumps({
            "ts": (datetime.now(timezone.utc) - timedelta(days=5)).isoformat(),
            "agent": "marvin", "name": "lonely-skill", "source_task": "x",
            "confidence": 7,
        })
        (agent_dir / "log.jsonl").write_text(log_entry)
        con = sqlite3.connect(db)
        con.execute("""INSERT INTO crystallize_candidates VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("cc-aaa111", "marvin", "telegram_lab-claw", "j", "s",
             "did stuff", "[]", "h", "pending", None, None, now, None, "x"))
        con.commit()
        out = tmp / "cache" / "digest.md"
        r = invoke({"NANOCLAW_DB": str(db),
                    "NANOCLAW_AGENTS_DIR": str(tmp / "data" / "agents"),
                    "NANOCLAW_DIGEST_OUT": str(out)})
        assert r.returncode == 0, r.stderr
        text = out.read_text()
        assert "Top 5 invoked" in text
        assert "deadline-agg" in text
        assert "Unused since creation" in text
        assert "lonely-skill" in text
        assert "Overflow" in text
        assert "cc-aaa111" in text
    finally:
        shutil.rmtree(tmp)
```

- [ ] **Step 2: Run to verify FAIL** (script missing)

Run: `python3 -m pytest scripts/guards/test_crystallize_weekly_digest.py -v`
Expected: 2 FAIL.

- [ ] **Step 3: Implement `scripts/guards/crystallize-weekly-digest.py`**

```python
#!/usr/bin/env python3
"""Crystallize weekly digest. Run by scheduled_tasks Mon 8am ET.

Reads agent usage/log JSONL + DB overflow -> writes markdown to NANOCLAW_DIGEST_OUT.
Exit 0 = wake the agent (which DMs the file).
Exit 1 = skip (nothing to say).
"""
import os, sys, json, sqlite3
from pathlib import Path
from datetime import datetime, timezone, timedelta

DB = Path(os.environ.get("NANOCLAW_DB",
                         str(Path.home() / "Agents/nanoclaw/store/messages.db")))
AGENTS_DIR = Path(os.environ.get("NANOCLAW_AGENTS_DIR",
                                 str(Path.home() / "Agents/nanoclaw/data/agents")))
OUT = Path(os.environ.get("NANOCLAW_DIGEST_OUT",
                          str(Path.home() / ".cache/nanoclaw/crystallize-digest.md")))
OUT.parent.mkdir(parents=True, exist_ok=True)

now = datetime.now(timezone.utc)
week_ago = (now - timedelta(days=7)).isoformat()
month_ago = (now - timedelta(days=30)).isoformat()

invoked = []
for usage in AGENTS_DIR.glob("*/skills/crystallized/usage.jsonl"):
    agent = usage.parts[-4]
    counts = {}
    for line in usage.read_text().splitlines():
        try:
            r = json.loads(line)
            if r.get("ts", "") >= week_ago:
                counts[r["name"]] = counts.get(r["name"], 0) + 1
        except Exception:
            pass
    for name, n in counts.items():
        invoked.append((agent, name, n))
invoked.sort(key=lambda x: -x[2])
top5 = invoked[:5]

unused = []
for log in AGENTS_DIR.glob("*/skills/crystallized/log.jsonl"):
    agent = log.parts[-4]
    usage = log.parent / "usage.jsonl"
    usage_text = usage.read_text() if usage.exists() else ""
    for line in log.read_text().splitlines():
        try:
            r = json.loads(line)
            if r.get("ts", "") >= month_ago and r["name"] not in usage_text:
                unused.append((agent, r["name"], r["ts"]))
        except Exception:
            pass

overflow_rows = []
if DB.exists():
    con = sqlite3.connect(DB); con.row_factory = sqlite3.Row
    rows = con.execute("""
      SELECT id, agent, source_group, substr(trace_summary, 1, 120) AS preview, created_at
      FROM crystallize_candidates
      WHERE status='pending' AND dm_message_id IS NULL AND created_at >= ?
      ORDER BY created_at DESC LIMIT 20
    """, (week_ago,)).fetchall()
    overflow_rows = list(rows)

if not top5 and not unused and not overflow_rows:
    if OUT.exists():
        OUT.unlink()
    sys.exit(1)

lines = [f"# Crystallize digest --- week ending {now.strftime('%Y-%m-%d')}", ""]
if top5:
    lines.append("## Top 5 invoked (7d)")
    for a, n, c in top5:
        lines.append(f"- `{a}/{n}` x {c}")
    lines.append("")
if unused:
    lines.append("## Unused since creation (30d, candidates for /prune)")
    for a, n, t in unused[:5]:
        lines.append(f"- `{a}/{n}` created {t[:10]}")
    lines.append("")
if overflow_rows:
    lines.append(f"## Overflow candidates ({len(overflow_rows)} --- DM cap hit, queued)")
    for r in overflow_rows[:10]:
        lines.append(f"- `{r['id']}` {r['agent']}/{r['source_group']}: {r['preview']}...")
    lines.append("  Reply `/crystallize-yes <id>` or `/crystallize-skip <id>` to act.")

OUT.write_text("\n".join(lines))
sys.exit(0)
```

```bash
chmod +x scripts/guards/crystallize-weekly-digest.py
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest scripts/guards/test_crystallize_weekly_digest.py -v`
Expected: 2 PASS.

- [ ] **Step 5: Add scheduled task row**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (name, schedule, chat_jid, prompt, script, context_mode) VALUES (
  'crystallize_weekly_digest',
  '0 8 * * 1',
  'tg:8475020901',
  'Read /Users/mgandal/.cache/nanoclaw/crystallize-digest.md and DM the contents to me as-is. Skip silently if file missing or empty.',
  '/usr/bin/env python3 /Users/mgandal/Agents/nanoclaw/scripts/guards/crystallize-weekly-digest.py',
  'isolated'
);"
```

Verify:
```bash
sqlite3 store/messages.db "SELECT id, name, schedule, script IS NOT NULL FROM scheduled_tasks WHERE name='crystallize_weekly_digest';"
```

- [ ] **Step 6: Commit**

```bash
rtk git add scripts/guards/crystallize-weekly-digest.py scripts/guards/test_crystallize_weekly_digest.py
rtk git commit -m "feat(crystallize): weekly digest cron (top5 + unused + overflow)

Python guard writes ~/.cache/nanoclaw/crystallize-digest.md if state
is non-empty; agent prompt DMs the file. scheduled_tasks row added
separately via SQL INSERT.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
rtk git log -1 --oneline
```

R3 → R4 gate: First Monday digest fires; format reads cleanly; overflow surfaces if any.

---

## Stage R4: Promote + Prune Crons + 2 new pending_action types

### Task 14: `crystallize-promote-check.py` + `crystallize-prune-check.py`

Same shape as Task 13. Each:

1. Write failing test (empty state → exit 1, threshold-met → exit 0 with JSON drop).
2. Run to FAIL.
3. Implement script.
4. PASS.
5. Add scheduled_tasks row (`5 8 * * 1` for promote, `10 8 1 * *` for prune).
6. Commit.

**Promote thresholds:** invocation count ≥10 AND `count(distinct sourceGroup) ≥ 3` AND not already in `container/skills/{name}/`.

**Prune thresholds:** invocation_count == 0 (no entry in usage.jsonl) AND age > 30d (from log.jsonl ts) AND confidence ≤ 7 AND not already under `_archive/`.

Both write JSON to `~/.cache/nanoclaw/crystallize-promote-candidates.json` / `~/.cache/nanoclaw/crystallize-prune-candidates.json`.

Both agent prompts (set in the `scheduled_tasks.prompt` column): read JSON, apply per-row validation (promote: I4 linter — reject `/workspace/extra/` paths or `Bash` in allowed-tools or agent-specific names; prune: no extra validation), stage `promote_crystallized_skill` / `archive_crystallized_skill` pending_action via IPC, reply with pa-xxx count.

(Code structure mirrors Task 13 exactly; commits are separate per script.)

### Task 15: Add `promote_crystallized_skill` + `archive_crystallized_skill` to replay-staged-action

**Files:**
- Modify: `src/replay-staged-action.ts` (add 2 case branches)
- Test: `src/replay-staged-action.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('replayStagedAction --- promote_crystallized_skill', () => {
  it('copies SKILL.md from data/agents/{agent}/skills/crystallized/{name}/ to container/skills/{name}/', async () => {
    // setup tmp dirs, write a source SKILL.md
    // call replayStagedAction({action_type: 'promote_crystallized_skill', payload: {agent, name, ...}})
    // assert destination file matches source content
    // assert source still exists (copy, not move)
    // assert log.jsonl appended with action='promoted'
  });

  it('rejects if dest already exists (idempotent guard)', async () => {
    // setup both source and dest
    // expect rejection
  });
});

describe('replayStagedAction --- archive_crystallized_skill', () => {
  it('moves SKILL.md to _archive/ sibling dir + writes archive_meta.json', async () => {
    // setup source
    // call replay
    // assert source gone, dest exists, archive_meta.json has {archived_at, reason, original_invocation_count}
  });
});
```

Fill in the test bodies with concrete `tmpdir`+`fs` operations (mirroring how `src/replay-staged-action.test.ts` already tests `crystallize_skill` at line 53).

- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement both action types in `src/replay-staged-action.ts`** by adding `case 'promote_crystallized_skill':` and `case 'archive_crystallized_skill':` to the dispatcher switch. Both are pure filesystem ops; no IPC.
- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit**

### Task 16: Add scheduled_tasks rows for promote + prune

```bash
sqlite3 store/messages.db <<SQL
INSERT INTO scheduled_tasks (name, schedule, chat_jid, prompt, script, context_mode) VALUES
  ('crystallize_promote_check', '5 8 * * 1', 'tg:8475020901',
   'Read /Users/mgandal/.cache/nanoclaw/crystallize-promote-candidates.json. For each entry: apply I4 linter (reject if SKILL.md body contains /workspace/extra/ paths OR allowed-tools includes Bash OR body mentions agent-specific name in {claire,einstein,simon,marvin,vincent,freud,steve,warren,coo}). For each survivor, stage a pending_action of type promote_crystallized_skill with payload {agent, name}. Reply with pa-xxx count.',
   '/usr/bin/env python3 /Users/mgandal/Agents/nanoclaw/scripts/guards/crystallize-promote-check.py',
   'isolated'),
  ('crystallize_prune_check', '10 8 1 * *', 'tg:8475020901',
   'Read /Users/mgandal/.cache/nanoclaw/crystallize-prune-candidates.json. For each entry, stage a pending_action of type archive_crystallized_skill with payload {agent, name, reason: "unused-30d-low-confidence"}. Reply with pa-xxx count.',
   '/usr/bin/env python3 /Users/mgandal/Agents/nanoclaw/scripts/guards/crystallize-prune-check.py',
   'isolated');
SQL
```

Verify both rows present + `chmod +x` on the two new scripts.

### Task 17: R4 ship gate

- [ ] **Step 1: Manually trigger promote-check script** with a curated state that meets threshold (write 11 usage.jsonl rows across 3 sourceGroups for one of marvin's existing crystallized skills — or wait for natural state).

Inspect output JSON, confirm one candidate.

- [ ] **Step 2: Manually trigger the scheduled task** (use existing `scripts/run-scheduled-task.ts` or equivalent) — agent should stage one pa-xxx.

- [ ] **Step 3: `/approve pa-xxx`** in CLAIRE. Verify `container/skills/{name}/SKILL.md` lands. Verify next container spawn lists it in `crystallizedSkillNames`.

- [ ] **Step 4: Wait for first natural prune fire (1st of month)**, or manually set up a stale unused skill and trigger early. Verify `_archive/` placement + `archive_meta.json`.

- [ ] **Step 5: Final commit (if any wiring fixes)**

R4 → done.

---

## Self-Review (per writing-plans skill)

**Spec coverage check:**
- ✅ Section 4 Architecture → Tasks 5, 6, 8, 9, 10, 11 cover all four legs
- ✅ Section 5 Data model → Tasks 1, 2 (table + helpers)
- ✅ Section 6.1 Stop hook → Task 6 (with all 8 gate behaviors)
- ✅ Section 6.2 crystallize_candidate handler → Task 5 (with all 8 audit-fix pins)
- ✅ Section 6.3 crystallize_candidate_fetch → Tasks 8, 9
- ✅ Section 6.4 slash commands → Tasks 10, 11
- ✅ Section 7.1 weekly digest → Task 13
- ✅ Section 7.2 promote-check → Task 14
- ✅ Section 7.3 prune-check → Task 14
- ✅ Section 7.4 new pending_action types → Task 15
- ✅ Section 9 Testing → mutation-pin tests embedded in Task 1 (UNIQUE INDEX) + Task 6 (gate flip — flip `< 3` to `< 2` and at least the "<3 distinct" test fails)
- ✅ Section 10 Rollout → Tasks 7, 12, 13, 17 are the gates

**Placeholder scan:** Task 14 consolidates two near-identical scripts (promote + prune) by analogy to Task 13 to avoid 250 lines of duplication; thresholds, file paths, test shape, and SQL inserts are all concretely specified. Task 15 test bodies are intentionally stubbed because they exactly mirror the existing `replay-staged-action.test.ts:53` pattern for `crystallize_skill` — an executing agent reads that file once and fills in.

**Type consistency check:**
- `CrystallizeCandidateInsert` / `CrystallizeCandidateRow` defined in Task 2, used in Tasks 5 + 8 — names match.
- `extractCrystallizeCommand` / `handleCrystallizeCommand` defined in Task 10, called in Task 11 — names match.
- `crystallizeCandidateHandler` / `crystallizeCandidateFetchHandler` named consistently across Tasks 5, 8 + register block.
- `ccId` lowercase, `cc-` prefix, 6 base36 chars — consistent across all tasks and DM template.
- `tg:8475020901` (CLAIRE jid) consistent across Tasks 5 and SQL inserts in Tasks 13, 16.

**One gap fixed inline:** Task 3 (new) was added before handler implementation. The original draft put `db` on `IpcDeps` inside Task 5 (handler implementation) — that conflated a cross-cutting interface change with a focused handler add. Splitting it out makes the typecheck failure surface earlier and lets call-site updates land in one focused commit.

---

## Plan complete and saved to `docs/superpowers/plans/2026-05-23-crystallize-skill-operationalization-plan.md`

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
