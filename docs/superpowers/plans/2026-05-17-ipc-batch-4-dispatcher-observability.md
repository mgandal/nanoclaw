# IPC Batch 4 — Dispatcher Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add synthetic `agent_actions` audit rows for malformed-requestId (path B) and parse-rejected (path C) dispatcher drops, plus `ctx.requestId` propagation, plus per-finding fixes from Round 1+2 peer review (F-A..F-Q). Land an operator runbook and a container-side poller hint so the forensic surface is usable day-one.

**Architecture:** Single dispatcher file (`src/ipc/handler.ts`) gains one helper + two new call sites + one ctx field. Analyzer files get a defense-in-depth allowlist. Three small commits: dispatcher + observability (Commit 1), handler logger pass (Commit 2), container poller hint (Commit 3, requires rebuild).

**Tech Stack:** TypeScript (Bun runtime, vitest, pino logger, bun:sqlite). Files in `src/ipc/`, `scripts/trust/`, `container/agent-runner/src/`, `docs/`.

**Spec reference:** `docs/superpowers/specs/2026-05-17-ipc-batch-4-dispatcher-observability-design.md` (commits `651b7803` + `4a74494e`).

---

## Pre-flight (run BEFORE Task 1)

Verify baseline state. Run these once before starting; they document the starting point so anomalies in later tasks are attributable.

```bash
# Should show clean main, no in-flight IPC work
rtk git log -3 --oneline
rtk git status

# Baseline test count
bun run test 2>&1 | tail -5    # Expect: ~2311 tests pass

# Confirm dispatcher line numbers match spec
rtk grep -n "ctx.agentName" /Users/mgandal/Agents/nanoclaw/src/ipc/handler.ts
# Line 51: agentName: string | null;
# Line 204: agent

# Confirm AgentActionInput.target is optional, NOT nullable
rtk grep -n "target" /Users/mgandal/Agents/nanoclaw/src/db.ts | head -5
# Line 1401: target?: string;  (NOT target: string | null)

# Confirm analyzer SELECT location
rtk grep -n "FROM agent_actions" /Users/mgandal/Agents/nanoclaw/scripts/trust/run-analyzer.ts
# Line 87: SELECT agent_name, action_type, trust_level, outcome, created_at FROM agent_actions

# Confirm container poller error location
rtk grep -n "Request timed out" /Users/mgandal/Agents/nanoclaw/container/agent-runner/src/ipc-mcp-stdio.ts
# Line 759: return { success: false, message: 'Request timed out' };
```

If any of these don't match, STOP and reconcile with the spec before proceeding — line numbers will have drifted from a parallel commit.

---

## Commit 1 — Dispatcher + observability surface

### Task 1: Commit the plan file alongside the first test (F-K from spec, per `feedback_commit_plan_with_first_task`)

**Files:**
- Create: `docs/superpowers/plans/2026-05-17-ipc-batch-4-dispatcher-observability.md` (THIS file — already exists at task start; included in Commit 1)

- [ ] **Step 1:** Stage the plan file (no test yet — Task 2 writes the first test).
```bash
rtk git add docs/superpowers/plans/2026-05-17-ipc-batch-4-dispatcher-observability.md
rtk git status
```
Expected: `A docs/superpowers/plans/2026-05-17-ipc-batch-4-dispatcher-observability.md` shown as staged. Do NOT commit yet — bundle with Task 2's first test commit.

### Task 2: Write the first RED test — T1 ctx.requestId binding (result-kind happy path)

**Files:**
- Create: `src/ipc/handler-batch4-drops.test.ts`

- [ ] **Step 1: Write the failing test (T1)**

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb, setRegisteredGroup } from '../db.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { IpcDeps } from '../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
  type IpcHandler,
  type IpcHandlerContext,
} from './handler.js';

/**
 * Batch 4 dispatcher-observability pins. See
 * docs/superpowers/specs/2026-05-17-ipc-batch-4-dispatcher-observability-design.md
 * for the 10 F-finding resolutions this file enforces.
 */
describe('Batch 4 dispatcher drops', () => {
  const SOURCE_GROUP = 'telegram_aud';
  let dataDir: string;
  let deps: IpcDeps;
  let agentName: string;
  let agentDir: string;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();

    setRegisteredGroup('tg:aud123', {
      name: 'Aud',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: false,
    });

    deps = {
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch4-drops-'));

    agentName = `test-batch4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  wire_z: autonomous\n',
    );
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const dispatch = async (
    data: Record<string, unknown>,
    compoundSource = `${SOURCE_GROUP}--${agentName}`,
  ) => {
    const ctx = buildContext(compoundSource, false, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  describe('ctx.requestId binding', () => {
    it('T1: populates ctx.requestId for result-kind happy path', async () => {
      let capturedCtx: IpcHandlerContext | null = null;
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: (_input, ctx) => {
          capturedCtx = ctx;
          return {
            target: 'tgt',
            notifySummary: 'n',
            payloadForStaging: { type: 'wire_z' },
          };
        },
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);

      await dispatch({ type: 'wire_z', requestId: 'abc123' });

      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.requestId).toBe('abc123');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "T1"
```
Expected: FAIL — either `Property 'requestId' does not exist on type 'IpcHandlerContext'` (TypeScript error) OR `capturedCtx.requestId` is `undefined`. Either is the RED state we want.

- [ ] **Step 3: Add `requestId` field to `IpcHandlerContext`**

Edit `src/ipc/handler.ts`. In the `IpcHandlerContext` interface (currently lines 47-63), add the new field below `agentName`:

```ts
export interface IpcHandlerContext {
  sourceGroup: string;
  isMain: boolean;
  baseGroup: string;
  agentName: string | null;
  /**
   * Per-dispatch requestId for result-kind handlers (populated after the
   * Rule 2 requestId validation block). `null` for notify-kind handlers
   * (no requestId in flow) AND for result-kind handlers whose
   * requestId failed validation (dispatcher returns before this is set).
   *
   * Batch 4 contract: handler logger calls inside `execute()` SHOULD
   * include `requestId: ctx.requestId` so logs can be joined to
   * `agent_actions` and the container-side poller. See
   * docs/context-engineering/ipc-handler-contract.md Rule N.
   */
  requestId: string | null;
  registeredGroups: Record<string, RegisteredGroup>;
  deps: IpcDeps;
  dataDir: string;
}
```

In `buildContext` (currently lines 191-209), add `requestId: null` to the returned object:

```ts
export function buildContext(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  dataDirOverride?: string,
): IpcHandlerContext {
  const { group: baseGroup, agent } = parseCompoundKey(
    fsPathToCompoundKey(sourceGroup),
  );
  return {
    sourceGroup,
    isMain,
    baseGroup,
    agentName: agent,
    requestId: null,
    registeredGroups: deps.registeredGroups(),
    deps,
    dataDir: dataDirOverride ?? DATA_DIR,
  };
}
```

In `dispatchIpcAction`, after the existing requestId validation block (currently line 234 `requestId = raw;`), add:

```ts
    requestId = raw;
  }

  // Batch 4: bind requestId to context so handlers can include it in
  // logger calls per the new contract. Null for notify-kind handlers
  // (where responseKind !== 'result' and the validation block above
  // didn't run).
  ctx.requestId = requestId;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "T1"
```
Expected: PASS (1 test).

- [ ] **Step 5: Commit Task 1 + Task 2 (plan + first test + dispatcher field)**

```bash
rtk git add docs/superpowers/plans/2026-05-17-ipc-batch-4-dispatcher-observability.md src/ipc/handler-batch4-drops.test.ts src/ipc/handler.ts
rtk git commit -m "$(cat <<'EOF'
feat(ipc): Batch 4 Task 1+2 — plan + ctx.requestId on IpcHandlerContext

Spec: docs/superpowers/specs/2026-05-17-ipc-batch-4-dispatcher-observability-design.md

T1 (ctx.requestId binding for result-kind happy path) shipped GREEN.
Plan file committed alongside first test per feedback_commit_plan_with_first_task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3: T2 + T3 — ctx.requestId null cases

- [ ] **Step 1: Write the failing tests**

Inside the existing `describe('ctx.requestId binding', ...)` block in `src/ipc/handler-batch4-drops.test.ts`, after the T1 `it(...)`, add:

```ts
    it('T2: leaves ctx.requestId null for notify-kind handler', async () => {
      let capturedCtx: IpcHandlerContext | null = null;
      const handler: IpcHandler<{ ok: boolean }, void> = {
        type: 'wire_z',
        // No responseKind → defaults to 'notify'
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: (_input, ctx) => {
          capturedCtx = ctx;
          return {
            target: 'tgt',
            notifySummary: 'n',
            payloadForStaging: { type: 'wire_z' },
          };
        },
        execute: () => undefined,
      };
      registerIpcHandler(handler);

      await dispatch({ type: 'wire_z', requestId: 'abc123' }); // requestId ignored for notify

      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.requestId).toBeNull();
    });

    it('T3: leaves ctx.requestId null on malformed-requestId rejection', async () => {
      let authorizeCalled = false;
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: () => {
          authorizeCalled = true;
          return null;
        },
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);

      await dispatch({ type: 'wire_z', requestId: '!!malformed!!' });

      // Validation failed before authorize ran, so authorize was never called
      // and ctx.requestId was never set. We can't capture ctx here (authorize
      // didn't run), but the production code MUST not set ctx.requestId on
      // the dispatcher path until AFTER validation passes.
      expect(authorizeCalled).toBe(false);
    });
```

- [ ] **Step 2: Run tests**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "ctx.requestId binding"
```
Expected: PASS (3 tests — T1, T2, T3).

T2 + T3 should pass without any new production code — T2 because notify-kind handlers skip the validation block, so `ctx.requestId` stays at the `null` initialized in `buildContext`. T3 because validation-failure-before-set means `ctx.requestId` never gets assigned (still null from `buildContext`). If T2 or T3 fail, the dispatcher edit from Task 2 ordered the `ctx.requestId = requestId` assignment before the validation guard — fix the order.

- [ ] **Step 3: Commit**

```bash
rtk git add src/ipc/handler-batch4-drops.test.ts
rtk git commit -m "test(ipc): Batch 4 Task 3 — T2/T3 ctx.requestId null pins"
```

### Task 4: Add `writeSyntheticAuditRow` helper (no production call sites yet)

**Files:**
- Modify: `src/ipc/handler.ts`

- [ ] **Step 1: Add helper at bottom of file (after `writeResultFile`)**

In `src/ipc/handler.ts`, after the existing `writeResultFile` function (ends around line 400), add:

```ts
/**
 * Write a synthetic `agent_actions` row for a pre-execute dispatcher drop
 * (Batch 4 paths B + C). Used when an agent caller's IPC is rejected
 * before `handler.execute()` runs — without this row, the caller leaves
 * zero forensic trail in the canonical audit table.
 *
 * Non-agent callers (`ctx.agentName === null`) skip the write, matching
 * the existing `NON_AGENT_DECISION` convention at trust-gate.ts:27-32 —
 * non-agent calls never write audit rows on any path.
 *
 * `target` is omitted because `AgentActionInput.target` is `target?: string`
 * (optional, NOT nullable) and `insertAgentAction` at db.ts:1416 coerces
 * falsy values to SQL NULL via `action.target || null`. Matches the
 * existing dispatcher pattern at handler.ts:266-274 where target is
 * conditionally omitted on the contract-violation row.
 *
 * Failures are logged-and-continued (not propagated) — a DB hiccup must
 * not crash the IPC watcher and take down all in-flight dispatches.
 * Primary discipline = drop the bad call; forensic write is best-effort.
 */
function writeSyntheticAuditRow(
  ctx: IpcHandlerContext,
  type: string,
  requestId: string | null,
  trust_level: 'dispatch_drop_input',
  summary: string,
  outcome: 'dropped_invalid_requestId' | 'dropped_invalid_input',
): void {
  if (!ctx.agentName) return;
  try {
    insertAgentAction({
      agent_name: ctx.agentName,
      group_folder: ctx.baseGroup,
      action_type: type,
      trust_level,
      summary: requestId
        ? `${summary} (req=${requestId.slice(0, 64)})`
        : summary,
      outcome,
    });
  } catch (err) {
    logger.error(
      { err, type, requestId },
      'Failed to write synthetic drop audit row',
    );
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```
Expected: 0 errors. Helper is unused for now (no call sites until Task 5+).

- [ ] **Step 3: Commit**

```bash
rtk git add src/ipc/handler.ts
rtk git commit -m "feat(ipc): Batch 4 Task 4 — add writeSyntheticAuditRow helper"
```

### Task 5: T4–T7 — Path B (malformed requestId) RED tests + production wiring

- [ ] **Step 1: Write the failing tests**

In `src/ipc/handler-batch4-drops.test.ts`, after the `describe('ctx.requestId binding', ...)` block, add:

```ts
  describe('path B synthetic row (malformed requestId)', () => {
    const registerResultHandler = () => {
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: () => ({
          target: 'tgt',
          notifySummary: 'n',
          payloadForStaging: { type: 'wire_z' },
        }),
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);
    };

    const fetchDropRows = () =>
      getDb()
        .prepare(
          'SELECT trust_level, summary, target, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as Array<{
        trust_level: string;
        summary: string;
        target: string | null;
        outcome: string;
      }>;

    it('T4: writes row with trust_level=dispatch_drop_input', async () => {
      registerResultHandler();
      await dispatch({ type: 'wire_z', requestId: '!!bad!!' });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].trust_level).toBe('dispatch_drop_input');
    });

    it('T5: writes row with outcome=dropped_invalid_requestId', async () => {
      registerResultHandler();
      await dispatch({ type: 'wire_z', requestId: '!!bad!!' });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('dropped_invalid_requestId');
    });

    it('T6: writes row with summary "malformed requestId" (NO req= substring)', async () => {
      registerResultHandler();
      await dispatch({ type: 'wire_z', requestId: '!!bad!!' });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toBe('malformed requestId');
      expect(rows[0].summary).not.toContain('req=');
    });

    it('T7: skips row write when ctx.agentName is null', async () => {
      registerResultHandler();
      // Bare sourceGroup (no compound-key separator) → parseCompoundKey
      // returns {group: 'telegram_aud', agent: null}. F-O induction.
      await dispatch({ type: 'wire_z', requestId: '!!bad!!' }, SOURCE_GROUP);
      const rows = fetchDropRows();
      expect(rows).toHaveLength(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "path B"
```
Expected: FAIL — 4 tests fail because the dispatcher does not yet call `writeSyntheticAuditRow` on path B.

- [ ] **Step 3: Wire path B in dispatcher**

In `src/ipc/handler.ts`, modify the existing path B block (currently lines 227-233):

```ts
  if (responseKind === 'result') {
    const raw = data.requestId;
    if (typeof raw !== 'string' || !REQUEST_ID_PATTERN.test(raw)) {
      logger.warn(
        { type: data.type, sourceGroup: ctx.sourceGroup, requestId: raw },
        'IPC handler rejected: missing or malformed requestId for result-kind',
      );
      writeSyntheticAuditRow(
        ctx,
        data.type,
        null,
        'dispatch_drop_input',
        'malformed requestId',
        'dropped_invalid_requestId',
      );
      return { handled: true };
    }
    requestId = raw;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "path B"
```
Expected: PASS (4 tests).

- [ ] **Step 5: Mutation-check (per spec § Testing F-H table)**

Apply each mutation in turn; confirm the named test fails; revert.

1. **T4 mutation:** Change `'dispatch_drop_input'` → `'wrong'` on line of path-B `writeSyntheticAuditRow`. Run `bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "T4"`. Expect FAIL. Revert.
2. **T5 mutation:** Change `'dropped_invalid_requestId'` → `'wrong'`. Run `bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "T5"`. Expect FAIL. Revert.
3. **T6 mutation:** In `writeSyntheticAuditRow` helper, change the summary ternary to `summary: \`${summary} (req=${requestId})\`,` (always interpolate). Run T6. Expect FAIL (`(req=null)` substring appears). Revert.
4. **T7 mutation:** Remove `if (!ctx.agentName) return;` from helper. Run T7. Expect FAIL (row appears with NULL agent_name — actually wait, the column is NOT NULL? Check db.ts schema. If insertAgentAction would throw on NULL agent_name, the test passes for the wrong reason; in that case the mutation is "force agent_name to ctx.agentName ?? 'unknown'" instead). Revert.

If any mutation does not fail the named test, the test is tautological — strengthen it before proceeding.

- [ ] **Step 6: Commit**

```bash
rtk git add src/ipc/handler-batch4-drops.test.ts src/ipc/handler.ts
rtk git commit -m "feat(ipc): Batch 4 Task 5 — path B synthetic row + T4-T7 pins"
```

### Task 6: T8–T11 — Path C (parse rejected) RED tests + production wiring

- [ ] **Step 1: Write the failing tests**

In `src/ipc/handler-batch4-drops.test.ts`, after the path B describe block, add:

```ts
  describe('path C synthetic row (parse rejected)', () => {
    const registerResultHandlerThatRejectsParse = () => {
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) => {
          // Reject when raw has `bad-parse` flag; accept otherwise
          if (typeof raw === 'object' && raw !== null && (raw as { badParse?: boolean }).badParse) {
            return null;
          }
          return { ok: true };
        },
        authorize: () => ({
          target: 'tgt',
          notifySummary: 'n',
          payloadForStaging: { type: 'wire_z' },
        }),
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);
    };

    const fetchDropRows = () =>
      getDb()
        .prepare(
          'SELECT trust_level, summary, target, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as Array<{
        trust_level: string;
        summary: string;
        target: string | null;
        outcome: string;
      }>;

    it('T8: writes row with trust_level=dispatch_drop_input', async () => {
      registerResultHandlerThatRejectsParse();
      await dispatch({ type: 'wire_z', requestId: 'abc123', badParse: true });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].trust_level).toBe('dispatch_drop_input');
    });

    it('T9: writes row with outcome=dropped_invalid_input', async () => {
      registerResultHandlerThatRejectsParse();
      await dispatch({ type: 'wire_z', requestId: 'abc123', badParse: true });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('dropped_invalid_input');
    });

    it('T10: writes row with summary CONTAINING "req=abc123"', async () => {
      registerResultHandlerThatRejectsParse();
      await dispatch({ type: 'wire_z', requestId: 'abc123', badParse: true });
      const rows = fetchDropRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].summary).toContain('req=abc123');
      expect(rows[0].summary).toContain('parse rejected');
    });

    it('T11: skips row write when ctx.agentName is null', async () => {
      registerResultHandlerThatRejectsParse();
      await dispatch(
        { type: 'wire_z', requestId: 'abc123', badParse: true },
        SOURCE_GROUP, // bare sourceGroup, F-O induction
      );
      const rows = fetchDropRows();
      expect(rows).toHaveLength(0);
    });
  });
```

- [ ] **Step 2: Run tests, verify failure**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "path C"
```
Expected: FAIL (4 tests).

- [ ] **Step 3: Wire path C in dispatcher**

In `src/ipc/handler.ts`, modify the existing path C block (currently lines 237-244):

```ts
  const input = handler.parse(data);
  if (input === null) {
    logger.warn(
      { type: data.type, sourceGroup: ctx.sourceGroup, requestId },
      'IPC handler rejected input shape',
    );
    writeSyntheticAuditRow(
      ctx,
      data.type,
      requestId,
      'dispatch_drop_input',
      'parse rejected',
      'dropped_invalid_input',
    );
    return { handled: true };
  }
```

Note the `requestId` field added to the existing `logger.warn` — F-D fix.

- [ ] **Step 4: Run tests, verify pass**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "path C"
```
Expected: PASS (4 tests).

- [ ] **Step 5: Mutation-check**

1. **T8 mutation:** `'dispatch_drop_input'` → `'wrong'` on path-C helper call. Expect T8 FAIL. Revert.
2. **T9 mutation:** `'dropped_invalid_input'` → `'wrong'`. Expect T9 FAIL. Revert.
3. **T10 mutation:** In helper, comment out the `requestId ? ... : ...` ternary (always use bare summary). Expect T10 FAIL (no `req=` substring). Revert.
4. **T11 mutation:** Same as Task 5 Step 5 mutation #4. Expect T11 FAIL. Revert.

- [ ] **Step 6: Commit**

```bash
rtk git add src/ipc/handler-batch4-drops.test.ts src/ipc/handler.ts
rtk git commit -m "feat(ipc): Batch 4 Task 6 — path C synthetic row + T8-T11 pins"
```

### Task 7: T12 — Path D invariant pin (F-I), no production code

- [ ] **Step 1: Write the test**

In `src/ipc/handler-batch4-drops.test.ts`, after the path C describe block, add:

```ts
  describe('path D invariant pin (F-I — authorize null preserves Rule 3 silent deny)', () => {
    it('T12: authorize-null with agent caller writes ZERO synthetic rows', async () => {
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: () => null, // polite-no per Rule 3
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);

      await dispatch({ type: 'wire_z', requestId: 'abc123' });

      // Strong assertion: ZERO drop rows for this agent. The agent_actions
      // table may have other rows from gate writes on other tests (shared
      // _initTestDatabase across files) but filter by unique agent_name +
      // outcome LIKE 'dropped_%'.
      const dropRows = getDb()
        .prepare(
          "SELECT COUNT(*) as c FROM agent_actions WHERE agent_name = ? AND outcome LIKE 'dropped_%'",
        )
        .get(agentName) as { c: number };
      expect(dropRows.c).toBe(0);
    });
  });
```

- [ ] **Step 2: Run test, expect PASS immediately**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "T12"
```
Expected: PASS (1 test). Production code is unchanged for path D — that's the invariant.

- [ ] **Step 3: Mutation-check (the key invariant pin)**

Add a deliberate regression: in `src/ipc/handler.ts`, in the existing path D block (currently line 246-247):

```ts
  const auth = handler.authorize(input, ctx);
  if (auth === null) {
    // MUTATION: add synthetic row here (this would violate F-A/Rule 3)
    writeSyntheticAuditRow(
      ctx,
      data.type,
      requestId,
      'dispatch_drop_input',
      'authorize null',
      'dropped_invalid_input',
    );
    return { handled: true };
  }
```

Run T12:

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "T12"
```
Expected: FAIL (`dropRows.c` is 1, not 0). Revert the mutation. Re-run; expect PASS.

- [ ] **Step 4: Commit**

```bash
rtk git add src/ipc/handler-batch4-drops.test.ts
rtk git commit -m "test(ipc): Batch 4 Task 7 — T12 path D invariant pin (F-I)"
```

### Task 8: T13 + T14 — Catch-path logger.error pins (F-M spy)

- [ ] **Step 1: Write tests**

In `src/ipc/handler-batch4-drops.test.ts`, after the path D describe block, add:

```ts
  describe('catch path log enhancement (F-M)', () => {
    it('T13: logger.error context on result-kind throw includes requestId', async () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: () => ({
          target: 'tgt',
          notifySummary: 'n',
          payloadForStaging: { type: 'wire_z' },
        }),
        execute: async () => {
          throw new Error('boom');
        },
      };
      registerIpcHandler(handler);

      await dispatch({ type: 'wire_z', requestId: 'abc123' });

      // Find the 'IPC handler execute threw' call (other logger.error calls
      // may exist from synthetic-row failures in other tests).
      const calls = spy.mock.calls.filter(
        (c) => c[1] === 'IPC handler execute threw',
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const ctxArg = calls[0][0] as Record<string, unknown>;
      expect(ctxArg.requestId).toBe('abc123');
    });

    it('T14: logger.error context on throw includes agentName', async () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: () => ({
          target: 'tgt',
          notifySummary: 'n',
          payloadForStaging: { type: 'wire_z' },
        }),
        execute: async () => {
          throw new Error('boom');
        },
      };
      registerIpcHandler(handler);

      await dispatch({ type: 'wire_z', requestId: 'abc123' });

      const calls = spy.mock.calls.filter(
        (c) => c[1] === 'IPC handler execute threw',
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const ctxArg = calls[0][0] as Record<string, unknown>;
      expect(ctxArg.agentName).toBe(agentName);
    });
  });
```

- [ ] **Step 2: Run tests, verify failure**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "catch path"
```
Expected: FAIL (`ctxArg.requestId` is undefined / `ctxArg.agentName` is undefined). Current catch-path logger context is `{ err, type, sourceGroup }` only.

- [ ] **Step 3: Enhance catch-path log**

In `src/ipc/handler.ts`, modify the existing catch block (currently lines 321-328):

```ts
  } catch (err) {
    executeThrew = true;
    throwMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        err,
        type: handler.type,
        sourceGroup: ctx.sourceGroup,
        requestId: ctx.requestId,
        agentName: ctx.agentName,
      },
      'IPC handler execute threw',
    );
  }
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "catch path"
```
Expected: PASS (2 tests).

- [ ] **Step 5: Mutation-check**

Revert just the `requestId` and `agentName` lines in the logger context (leave `{ err, type, sourceGroup }`). Run both tests. Expect both FAIL. Restore.

- [ ] **Step 6: Commit**

```bash
rtk git add src/ipc/handler-batch4-drops.test.ts src/ipc/handler.ts
rtk git commit -m "feat(ipc): Batch 4 Task 8 — T13/T14 catch-path requestId+agentName"
```

### Task 9: T15 — F-O induction discipline pin

- [ ] **Step 1: Write test**

In `src/ipc/handler-batch4-drops.test.ts`, after the catch-path describe, add:

```ts
  describe('F-O induction discipline', () => {
    it('T15: bare sourceGroup (no compound-key separator) produces ctx.agentName=null AND helper short-circuits', async () => {
      // Direct buildContext call: pass bare 'telegram_aud' (no '--<agent>').
      // parseCompoundKey returns { group: 'telegram_aud', agent: null }.
      const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
      expect(ctx.agentName).toBeNull();

      // Confirm the helper's guard fires: dispatch a path-B call with this
      // ctx and assert zero rows.
      const handler: IpcHandler<
        { ok: boolean },
        { executed: true; result: { ok: boolean } }
      > = {
        type: 'wire_z',
        responseKind: 'result',
        parse: (raw) =>
          typeof raw === 'object' && raw !== null ? { ok: true } : null,
        authorize: () => ({
          target: 'tgt',
          notifySummary: 'n',
          payloadForStaging: { type: 'wire_z' },
        }),
        execute: async () => ({ executed: true, result: { ok: true } }),
      };
      registerIpcHandler(handler);

      await dispatchIpcAction(
        { type: 'wire_z', requestId: '!!bad!!' },
        ctx,
      );

      // No rows at all (path B fired, but helper short-circuited).
      // We can't query by agent_name (it's null), so count all rows in fresh
      // _initTestDatabase scope.
      const allRows = getDb()
        .prepare("SELECT COUNT(*) as c FROM agent_actions WHERE outcome LIKE 'dropped_%'")
        .get() as { c: number };
      expect(allRows.c).toBe(0);
    });
  });
});
```

(Note: this is the LAST `it(...)` in the file; the closing `});` matches the outermost `describe('Batch 4 dispatcher drops', ...)`. Verify the brace count.)

- [ ] **Step 2: Run, verify pass**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts -t "T15"
```
Expected: PASS.

- [ ] **Step 3: Mutation-check**

In the helper at `src/ipc/handler.ts`, remove the `if (!ctx.agentName) return;` line. Run T15. Expect FAIL (1 row appears). Restore.

- [ ] **Step 4: Run the full new test file end-to-end**

```bash
bun --bun vitest run src/ipc/handler-batch4-drops.test.ts
```
Expected: 15 tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/ipc/handler-batch4-drops.test.ts
rtk git commit -m "test(ipc): Batch 4 Task 9 — T15 F-O induction discipline"
```

### Task 10: Analyzer SQL filter (run-analyzer.ts) + JS guard (analyze-promotions.ts) + analyzer test

**Files:**
- Modify: `scripts/trust/run-analyzer.ts:87`
- Modify: `scripts/trust/analyze-promotions.ts` (around line 92)
- Modify: `scripts/trust/analyze-promotions.test.ts` (add 1 test)

- [ ] **Step 1: Write the failing test (analyzer JS guard)**

Read the existing `scripts/trust/analyze-promotions.test.ts` to understand the existing test scaffolding, then add this test at an appropriate location (likely a new `describe('Batch 4: synthetic-row filter (F-A)', ...)` block):

```ts
  describe('Batch 4: synthetic-row filter (F-A defense-in-depth)', () => {
    it('filters rows with non-LADDER trust_level before promotion analysis', () => {
      // Mixed input: 30 valid 'autonomous' rows + 30 synthetic
      // 'dispatch_drop_input' rows. Without the guard, the synthetic rows
      // would be the most-recent (sorted[0]?.trust_level === 'dispatch_drop_input'),
      // and nextTrustLevel would return null → agent dropped from analysis.
      const now = Date.UTC(2026, 4, 17);
      const rows: ActionRow[] = [];
      for (let i = 0; i < 30; i++) {
        rows.push({
          agent_name: 'einstein',
          action_type: 'slack_dm_read',
          trust_level: 'autonomous',
          outcome: 'completed',
          created_at: new Date(now - (60 + i) * 60_000).toISOString(),
        });
      }
      for (let i = 0; i < 30; i++) {
        rows.push({
          agent_name: 'einstein',
          action_type: 'slack_dm_read',
          trust_level: 'dispatch_drop_input', // synthetic
          outcome: 'dropped_invalid_input',
          created_at: new Date(now - i * 60_000).toISOString(), // MORE recent
        });
      }

      // After filtering, the function should still find a promotion candidate
      // (or not, depending on the analyzer's other logic — but the synthetic
      // rows must NOT be the deciding factor).
      const proposals = analyzeAgentTrust(rows, {}, {
        windowDays: 30,
        minActions: 30,
        minApprovalRate: 0.95,
        now,
      });

      // The 30 autonomous rows have 100% approval rate (all 'completed') and
      // sampleSize=30. Without the filter, the analyzer would see the synthetic
      // rows as currentLevel and bail. With the filter, the analyzer sees
      // autonomous as currentLevel — and nextTrustLevel('autonomous') is null
      // (top of ladder), so no proposal. The test asserts that the analyzer
      // ran without error and that the result is consistent with currentLevel
      // being 'autonomous', not 'dispatch_drop_input'.
      //
      // The load-bearing assertion: no proposal slot has trust_level coming
      // from a synthetic row. We can't directly inspect internal state, but
      // proposals having length 0 (because top-of-ladder, not because of
      // dropped synthetic) is the expected behavior under the guard.
      expect(proposals).toHaveLength(0);
    });
  });
```

(The exact import list and `analyzeAgentTrust` function name may need adjustment — read `analyze-promotions.ts` exports first. If `analyzeAgentTrust` is not the right name, use whatever the test file uses for existing tests.)

- [ ] **Step 2: Run test, verify failure**

```bash
bun --bun vitest run scripts/trust/analyze-promotions.test.ts -t "Batch 4"
```
Expected: FAIL — without the guard, the synthetic rows are most-recent → `currentLevelRaw = 'dispatch_drop_input'` → `nextTrustLevel(currentLevelRaw)` returns null → group dropped from analysis → proposals length is 0 → test passes for the WRONG reason. Read the actual error. If the test passes-for-wrong-reason, strengthen the assertion to check that the analyzer's internal `currentLevel` (if exposed) or some observable side effect proves the filter ran.

Alternative stronger assertion: spy on `nextTrustLevel` to confirm it's called with `'autonomous'`, not `'dispatch_drop_input'`. If `nextTrustLevel` isn't easily spyable, refactor the test to check observable behavior: e.g., construct input where the autonomous rows would yield a candidate, the synthetic rows would block it, and assert a candidate is found.

- [ ] **Step 3: Add JS guard to `analyze-promotions.ts`**

Find the section that loops over `groupRows` (around line 92 per spec). Before the `sorted[0]?.trust_level` lookup, filter:

```ts
// Batch 4 F-A defense-in-depth: drop rows whose trust_level isn't part of
// the LADDER. These are synthetic dispatcher-drop rows (path B/C) that
// must not poison promotion analysis. The SQL caller at run-analyzer.ts:87
// also filters at the source; this is the second line of defense for any
// future caller that uses analyzeAgentTrust without the SQL filter.
const filteredGroupRows = groupRows.filter((r) =>
  LADDER.includes(r.trust_level as TrustLevel),
);
const droppedCount = groupRows.length - filteredGroupRows.length;
if (droppedCount > 0) {
  // F-N: visible signal that guard fired (vs dead code)
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'analyzer guard filtered non-LADDER rows',
      agent_name: agentRows[0]?.agent_name,
      action_type: actionType,
      filtered: droppedCount,
    }),
  );
}
// Replace subsequent usage of `groupRows` with `filteredGroupRows`.
```

Then replace the existing `groupRows`-based logic (line 92+ area) to use `filteredGroupRows`. EXACT placement depends on the function structure — read the file fully first.

- [ ] **Step 4: Add SQL filter to `run-analyzer.ts`**

In `scripts/trust/run-analyzer.ts` line 87, modify the SELECT:

```ts
      .prepare(
        "SELECT agent_name, action_type, trust_level, outcome, created_at FROM agent_actions WHERE trust_level IN ('ask','draft','notify','autonomous')",
      )
```

- [ ] **Step 5: Run tests, verify pass**

```bash
bun --bun vitest run scripts/trust/analyze-promotions.test.ts
```
Expected: All existing tests still pass + new Batch 4 test passes.

- [ ] **Step 6: Mutation-check**

Remove the `filteredGroupRows` filter, run the new test. Expect FAIL. Restore.

- [ ] **Step 7: Commit**

```bash
rtk git add scripts/trust/run-analyzer.ts scripts/trust/analyze-promotions.ts scripts/trust/analyze-promotions.test.ts
rtk git commit -m "feat(trust): Batch 4 Task 10 — analyzer guard (SQL + JS LADDER filter)"
```

### Task 11: Contract doc update + new runbook (F-K)

**Files:**
- Modify: `docs/context-engineering/ipc-handler-contract.md`
- Create: `docs/incident-response/ipc-drop-outcomes.md`

- [ ] **Step 1: Add new Rule N to contract doc**

In `docs/context-engineering/ipc-handler-contract.md`, find the existing Rules section (Rules 1-6 should exist from prior batches). Add a new Rule:

```markdown
## Rule N: Handler logger calls SHOULD include `requestId: ctx.requestId`

After Batch 4 (commit-range `651b7803..<this batch>`), the dispatcher
populates `ctx.requestId: string | null` on `IpcHandlerContext` after the
Rule 2 requestId validation block. Handler `logger.*` calls inside
`execute()` SHOULD include `requestId: ctx.requestId` so that operators
can join `nanoclaw.log` lines to `agent_actions` rows (and to the
in-container poller via the shared requestId).

Example:

```ts
async execute(input, ctx) {
  logger.info(
    { requestId: ctx.requestId, sourceGroup: ctx.sourceGroup, channel: input.channel },
    'slack_dm_read handler invoked',
  );
  // ... rest of handler ...
}
```

**Doc-enforced only (F-F).** No ESLint rule enforces this; future
batches may add one. Reviewers must catch omissions in code review.

**Mutation-timing constraint (F-E).** `ctx.requestId` is mutated by the
dispatcher between requestId validation and `parse()`. Handlers MUST NOT
capture `ctx` in `parse()` closures via module-level state — `parse()`
runs AFTER the mutation, but a reference held across multiple dispatches
would see ever-changing values. Current handlers do not capture; this
constraint exists to prevent a future regression.

**For non-agent callers (`ctx.agentName === null`):** `requestId` may
still be set (for result-kind calls), but `agent_actions` rows are not
written (synthetic or otherwise). Log lines remain useful for debugging
host-side test fixtures.
```

Also add to the authoring checklist (find existing checklist; add a sub-bullet):

```markdown
- [ ] Inside `execute()`, all `logger.*` calls include `requestId: ctx.requestId` (Rule N)
```

- [ ] **Step 2: Create the runbook**

Create `docs/incident-response/ipc-drop-outcomes.md`:

```markdown
# IPC Dispatcher Drop Outcomes — Operator Runbook

For paging-triggered triage when an agent reports a stuck IPC call or
when `agent_actions` shows unexpected `outcome` values. Created in
Batch 4 (spec: `docs/superpowers/specs/2026-05-17-ipc-batch-4-dispatcher-observability-design.md`).

## Where the DB lives

Absolute path: `store/messages.db` (NOT `data/nanoclaw.db`). Read-only
queries:

```bash
sqlite3 store/messages.db
```

## Outcome glossary

| `outcome` value | Meaning | First-response action |
|---|---|---|
| `dropped_invalid_requestId` | Agent sent malformed/missing requestId on a result-kind call (path B). | Likely agent code bug. Grep container-side logs for the invocation site; the requestId is NOT in the row (see Path B asymmetry below). |
| `dropped_invalid_input` | Agent sent valid requestId but malformed payload — `handler.parse()` returned null (path C). | Likely schema drift between agent's `mcp_call` payload and host's `IpcHandler.parse()`. Find the handler at `src/ipc/handlers/<type>.ts` and compare the input shape. |
| `denied_contract_violation` | Handler declared `skipGate: true` but its type is not on `SKIP_GATE_ALLOWLIST` at `src/ipc/handler.ts:21-43`. | Contributor bug. Revert the handler change or add the type to the allowlist (after security review). |
| Other `dropped_*` | Not yet defined. | Investigate. Likely a future batch added new outcome strings without updating this runbook. |

Note: `authorize() → null` (path D) is INTENTIONALLY silent per contract
Rule 3 — no row is written for legitimate "polite-no" denials. If you
expected a row and don't see one, this may be why.

## Query templates

### "Agent stuck on poll for requestId=X"

```sql
SELECT created_at, agent_name, action_type, outcome, summary
FROM agent_actions
WHERE outcome LIKE 'dropped_%'
  AND summary LIKE '%req=X%'
ORDER BY created_at DESC
LIMIT 5;
```

Replace `X` with the literal requestId. Returns the row if a path-C drop
happened. For path B (malformed requestId), this query returns NOTHING —
see asymmetry below.

### "All drops for agent Y in last hour"

```sql
SELECT created_at, action_type, outcome, summary
FROM agent_actions
WHERE outcome LIKE 'dropped_%'
  AND agent_name = 'Y'
  AND created_at > datetime('now', '-1 hour')
ORDER BY created_at DESC;
```

### "Drop volume by outcome (last 24h)"

```sql
SELECT outcome, COUNT(*) as count
FROM agent_actions
WHERE outcome LIKE 'dropped_%'
  AND created_at > datetime('now', '-1 day')
GROUP BY outcome;
```

Baseline: 0-20/hour normal; >100/hour same outcome same agent = storm.

## Path B asymmetry — IMPORTANT (F-Q)

`dropped_invalid_requestId` rows do NOT carry `req=` in their summary,
because the malformed value is intentionally not stored in the audit
table (sanitization concern). Operators must join path-B rows by
`(agent_name, created_at)` only.

In the most common page scenario — "agent's container poll timed out on
requestId=abc123" — the agent had a VALID requestId from its
perspective; the host rejected it because of regex failure on something
the host saw. Check the host log line at `logs/nanoclaw.log`:

```bash
grep -F "requestId" logs/nanoclaw.log | grep -F "malformed"
```

The malformed value (whatever the host received) appears there, not in
the row.

## Per-outcome resolution decision tree

- **N=0 rows over 1 hour** → no incident; agent's symptom is elsewhere
  (container crash, poll bug, network).
- **N=1-3 rows, all same agent + same action_type** → likely a one-off
  agent bug; check container logs at that timestamp and file a ticket.
- **N>10 rows, all same agent + same action_type, last 5 minutes** →
  agent crash-loop; SSH and `container ls`, kill the agent container,
  restart NanoClaw.
- **N>100 rows, mixed agents + actions** → systemic issue (host change,
  dispatcher regression); revert most recent `src/ipc/handler.ts` change.

## Cross-reference

- Contract: `docs/context-engineering/ipc-handler-contract.md` Rule 3
  (authorize-null silent deny), Rule 6 (skipGate allowlist), Rule N
  (handler logger requestId).
- Dispatcher source: `src/ipc/handler.ts` (paths B, C, D; helper
  `writeSyntheticAuditRow`).
- Schema: `src/db.ts:99-109` (`agent_actions` table), `:1395-1403`
  (`AgentActionInput`).
```

- [ ] **Step 3: Verify both files exist + non-empty**

```bash
test -s docs/context-engineering/ipc-handler-contract.md && echo "contract: OK" || echo "contract: MISSING"
test -s docs/incident-response/ipc-drop-outcomes.md && echo "runbook: OK" || echo "runbook: MISSING"
```
Expected: both OK. Then verify the runbook has all 6 mandatory headings (acceptance criterion #7):

```bash
for heading in "Where the DB lives" "Outcome glossary" "Query templates" "Path B asymmetry" "Per-outcome resolution decision tree" "Cross-reference"; do
  grep -F "$heading" docs/incident-response/ipc-drop-outcomes.md > /dev/null && echo "OK: $heading" || echo "MISSING: $heading"
done
```
Expected: 6 OKs.

- [ ] **Step 4: Commit**

```bash
rtk git add docs/context-engineering/ipc-handler-contract.md docs/incident-response/ipc-drop-outcomes.md
rtk git commit -m "docs(ipc): Batch 4 Task 11 — contract Rule N + drop-outcomes runbook"
```

### Task 12: Pre-commit-1 verification (lint, typecheck, full test suite)

- [ ] **Step 1: Run full verification**

```bash
rtk run typecheck && rtk run lint && rtk run test 2>&1 | tail -10
```
Expected:
- `typecheck`: 0 errors
- `lint`: 0 errors
- `test`: ~2326 tests pass (2311 existing + 15 new)

- [ ] **Step 2: If any failure, FIX, don't bypass**

If lint shows orphan-import errors (the recurring pattern from Batch 2F), fix by deleting unused imports rather than disabling rules. If tests fail, read the diff against the pre-flight baseline.

- [ ] **Step 3: Commit (only if changes needed)**

If verification triggered fixes, commit them:

```bash
rtk git add <fixed files>
rtk git commit -m "fix(ipc): Batch 4 Task 12 — pre-Commit-1 verification fixes"
```

Otherwise skip this commit — Tasks 2-11 already left the tree green.

### Task 13: Push Commit 1 (verify origin/main parity, then push)

- [ ] **Step 1: Verify commit count and content**

```bash
rtk git log --oneline origin/main..HEAD
```
Expected: 10-13 commits since the spec amendment commit `4a74494e` (varies by how many TDD step commits were made). All are Batch 4 work.

- [ ] **Step 2: Push**

```bash
rtk git push
```
Expected: success. Capture the new HEAD SHA.

- [ ] **Step 3: Verify**

```bash
rtk git status
```
Expected: `* main` (no `ahead`).

---

## Commit 2 — Handler logger pass (host-only)

### Task 14: Add `requestId: ctx.requestId` to slack.ts logger.info

**Files:**
- Modify: `src/ipc/handlers/slack.ts:76`
- Modify: `src/ipc/handlers/slack.test.ts` (add 1 pin assertion)

- [ ] **Step 1: Write the failing pin in `slack.test.ts`**

Find the existing test that exercises the `logger.info('slack_dm_read IPC handled')` path (look for `slack_dm_read` test cases). Add a `vi.spyOn(logger, 'info')` and assert:

```ts
  it('logger.info call includes requestId in context (Batch 4 Rule N)', async () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    // ... existing test setup invoking the handler with a valid requestId='req-xyz' ...
    await dispatch(/* ... */);

    const calls = spy.mock.calls.filter(
      (c) => c[1] === 'slack_dm_read IPC handled',
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const ctxArg = calls[0][0] as Record<string, unknown>;
    expect(ctxArg.requestId).toBe('req-xyz');
  });
```

Adapt to whatever the existing test scaffolding looks like. Run:

```bash
bun --bun vitest run src/ipc/handlers/slack.test.ts -t "requestId in context"
```
Expected: FAIL.

- [ ] **Step 2: Add requestId to slack.ts logger.info**

In `src/ipc/handlers/slack.ts:76`, the existing `logger.info(...)` call. Add `requestId: ctx.requestId`:

```ts
    logger.info(
      {
        requestId: ctx.requestId,
        sourceGroup: ctx.sourceGroup,
        channel: input.channel,
        // ... any existing fields ...
      },
      'slack_dm_read IPC handled',
    );
```

- [ ] **Step 3: Run, verify pass**

```bash
bun --bun vitest run src/ipc/handlers/slack.test.ts
```
Expected: all slack tests pass.

- [ ] **Step 4: Commit**

```bash
rtk git add src/ipc/handlers/slack.ts src/ipc/handlers/slack.test.ts
rtk git commit -m "feat(ipc): Batch 4 Task 14 — slack handler logger.info adds requestId"
```

### Task 15: Add `requestId: ctx.requestId` to dashboard-query.ts logger.info

**Files:**
- Modify: `src/ipc/handlers/dashboard-query.ts:95`

- [ ] **Step 1:** Same pattern as Task 14, applied to `dashboard-query.ts:95`. Add a pin test to `dashboard-query.test.ts` and update the logger call.

- [ ] **Step 2: Verify + commit**

```bash
bun --bun vitest run src/ipc/handlers/dashboard-query.test.ts
rtk git add src/ipc/handlers/dashboard-query.ts src/ipc/handlers/dashboard-query.test.ts
rtk git commit -m "feat(ipc): Batch 4 Task 15 — dashboard-query handler logger.info adds requestId"
```

### Task 16: Add `requestId: ctx.requestId` to imessage.ts 4 logger.warn calls (pattern-pin one)

**Files:**
- Modify: `src/ipc/handlers/imessage.ts:67,125,186,242`
- Modify: `src/ipc/handlers/imessage.test.ts` (add 1 pattern-pin assertion)

- [ ] **Step 1: Update all 4 logger.warn calls**

Each currently logs `{ sourceGroup: ctx.sourceGroup, ... }`. Add `requestId: ctx.requestId` to each.

- [ ] **Step 2: Add ONE pattern-pin to imessage.test.ts**

```ts
  it('logger.warn calls include requestId in context (Batch 4 Rule N pattern-pin)', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Trigger any imessage handler with a requestId. The pin is "at least
    // one of the 4 logger.warn calls includes requestId".
    await dispatch(/* setup that triggers a logger.warn */);
    const callsWithRequestId = spy.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>).requestId !== undefined,
    );
    expect(callsWithRequestId.length).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 3: Verify + commit**

```bash
bun --bun vitest run src/ipc/handlers/imessage.test.ts
rtk git add src/ipc/handlers/imessage.ts src/ipc/handlers/imessage.test.ts
rtk git commit -m "feat(ipc): Batch 4 Task 16 — imessage handler 4 logger.warn add requestId"
```

### Task 17: Pre-commit-2 verification

- [ ] **Step 1:** Same as Task 12 — full typecheck + lint + test suite.

- [ ] **Step 2: Push Commit 2**

```bash
rtk git push
rtk git status
```

---

## Commit 3 — Container poller hint (F-L)

### Task 18: Update `ipc-mcp-stdio.ts:759` poller error message

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:759`

- [ ] **Step 1: Edit the error message**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, the current code at line 759 returns:

```ts
return { success: false, message: 'Request timed out' };
```

Change to:

```ts
return {
  success: false,
  message:
    "Request timed out (host may have dropped — query agent_actions WHERE outcome LIKE 'dropped_%' AND agent_name=<agent> ORDER BY created_at DESC)",
};
```

- [ ] **Step 2: Rebuild container**

```bash
./container/build.sh
```
Expected: build success.

- [ ] **Step 3: Invalidate agent-runner-src cache for any test groups**

Per `feedback_stale_dist_restart_loop`:

```bash
# List sessions dirs
ls data/sessions/

# Remove the agent-runner-src cache for ALL groups (forces re-extract on next run)
for d in data/sessions/*/; do
  if [ -d "$d/agent-runner-src" ]; then
    rm -rf "$d/agent-runner-src"
    echo "cleared: $d/agent-runner-src"
  fi
done
```

- [ ] **Step 4: Commit**

```bash
rtk git add container/agent-runner/src/ipc-mcp-stdio.ts
rtk git commit -m "feat(container): Batch 4 Task 18 — poller timeout points at agent_actions"
```

### Task 19: Final verification + push Commit 3

- [ ] **Step 1: Full verification**

```bash
rtk run typecheck && rtk run lint && rtk run test 2>&1 | tail -10
```
Expected: clean, ~2326 tests pass.

- [ ] **Step 2: Verify all acceptance criteria from spec**

```bash
# AC 6: analyzer guards
rtk grep -n "trust_level IN" scripts/trust/run-analyzer.ts                # SQL filter
rtk grep -n "LADDER.includes\|filteredGroupRows" scripts/trust/analyze-promotions.ts  # JS guard

# AC 7: runbook 6 headings
for h in "Where the DB lives" "Outcome glossary" "Query templates" "Path B asymmetry" "decision tree" "Cross-reference"; do
  grep -Fc "$h" docs/incident-response/ipc-drop-outcomes.md
done

# AC 8: container hint
rtk grep -n "outcome LIKE" container/agent-runner/src/ipc-mcp-stdio.ts

# AC 9: agent-runner-src cache cleared (visual check)
ls -la data/sessions/*/agent-runner-src 2>&1 | head -5  # Expect "No such file or directory" mostly
```

- [ ] **Step 3: Push**

```bash
rtk git push
rtk git log -1
rtk git status
```
Expected: `* main` (no `ahead`), HEAD is the container commit.

### Task 20: Manual smoke test (day-1 bake observability per F-P)

- [ ] **Step 1: Restart NanoClaw to pick up new code**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Wait 5 seconds, then:

```bash
tail -20 logs/nanoclaw.log
```
Expected: NanoClaw started cleanly, no panics.

- [ ] **Step 2: Day-1 smoke query**

After 1 hour of production traffic (or send a manual test message to a group to exercise IPC):

```bash
sqlite3 store/messages.db "SELECT outcome, COUNT(*) FROM agent_actions WHERE outcome LIKE 'dropped_%' AND created_at > datetime('now','-1 hour') GROUP BY outcome;"
```
Expected: 0-N rows where N ≤ 20. Zero rows after 24h would indicate the code path is dead (investigate).

- [ ] **Step 3:** Document the observed baseline in a follow-up memory entry once 24h of bake completes.

---

## Self-Review Checklist

After plan is written, before handing off:

1. **Spec coverage:** Every F-A through F-Q finding has a task. ✅
   - F-A (path D excluded): Task 7 invariant pin
   - F-B/F-D (req= in summary): Task 4 helper logic + Task 6 T10 pin
   - F-C (runbook): Task 11
   - F-E (mutation-timing constraint): Task 11 contract doc paragraph
   - F-F (doc-only requestId rule): Task 11 contract doc paragraph
   - F-G (target omitted): Task 4 helper
   - F-H (mutation table): Tasks 5, 6, 8, 9 each include mutation-check steps
   - F-I (path D test): Task 7
   - F-J (target?: string contract): Task 4 helper
   - F-K (runbook 6 headings): Task 11
   - F-L (container poller hint): Tasks 18-19
   - F-M (spy mechanism): Task 8
   - F-N (analyzer filter log): Task 10
   - F-O (induction discipline): Task 9
   - F-P (bake observability): Task 20
   - F-Q (asymmetry in runbook): Task 11 runbook

2. **Placeholder scan:** No TBD/TODO/"add appropriate" in implementation steps. ✅

3. **Type consistency:** `IpcHandlerContext.requestId: string | null` consistent across Tasks 2-19. Helper signature consistent across Tasks 4, 5, 6, 7. `writeSyntheticAuditRow` parameter order matches at all call sites. ✅

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-17-ipc-batch-4-dispatcher-observability.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch fresh subagent per task, review between tasks, fast iteration. Matches Batch 2F's proven cadence.

**2. Inline Execution** — execute tasks in current session using executing-plans, batch execution with checkpoints.

**Which approach?**
