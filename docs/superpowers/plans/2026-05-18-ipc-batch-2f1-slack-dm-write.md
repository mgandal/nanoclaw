# IPC Batch 2F.1 (slack_dm write + postHocNotify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the `slack_dm` write IPC action from the `src/ipc.ts` if-ladder into the typed `IpcHandler` registry under `src/ipc/handlers/slack.ts`, with a contract widening (`postHocNotify?: true` on `IpcAuthorization`) that lets a `responseKind: 'result'` handler also fire a post-hoc Telegram notify after the result file is written.

**Architecture:** Three commits. (1) Extend `IpcAuthorization` with `postHocNotify?: true`. Dispatcher inspects this after `writeResultFile` and, when 5 AND'd guards hold (`postHocNotify && !executeThrew && executed && decision !== null && isSuccessPayload(resultPayload)`), calls `fireNotifyIfRequested`. Also add an authorize-time loud-deny check for the `postHocNotify + skipGate` combination (matches existing off-allowlist skipGate precedent). (2) Add `slackDmHandler` to the existing `src/ipc/handlers/slack.ts` using `actionTypeOverride: 'send_slack_dm'` + `postHocNotify: true` + `resultsDirName: 'slack_results'`. Strip the legacy branch + function from `src/ipc.ts` AND delete/rewrite the C13 describe block at `src/ipc.test.ts:3646-3746`. (3) Prettier pass on the new files if the formatter yields a diff.

**Tech Stack:** TypeScript (strict mode), Vitest (testing — invoked via `bun run test`), bun:sqlite (DB-backed audit-row tests via `_initTestDatabase()`), `src/ipc/handler.ts` (dispatcher) + `src/ipc/trust-gate.ts` (gate + notify helpers) + `src/trust-notify.ts` (firePostHocNotify).

**Spec:** `docs/superpowers/specs/2026-05-18-ipc-batch-2f1-slack-dm-write-design.md` (commits `d06e1be4` round-1 + `9bd8ad19` round-2 peer-review amendments). Read it before starting if you have not already — the Behavior-Preservation Matrix, the documented non-agent policy decision (match imessage_send precedent, not deny), the loud-deny for `postHocNotify + skipGate`, and the operability-regression flag on `logger.info` are the ground truth this plan implements step-by-step.

---

## File Structure

**Created (2 files):**
- `src/ipc/handler-post-hoc-notify.test.ts` — dispatcher contract tests for `postHocNotify` (7 tests including the loud-deny pin). ~330 LOC.

**Modified (5 files):**
- `src/ipc/handler.ts` — add `postHocNotify?: true` field to `IpcAuthorization`, add `isSuccessPayload` helper, add authorize-time loud-deny check for `postHocNotify + skipGate`, wire the new post-write notify branch inside the `responseKind === 'result'` block. ~50 LOC delta.
- `src/ipc/handlers/slack.ts` — append `slackDmHandler` after the existing `slackDmReadHandler`. ~110 LOC added.
- `src/ipc/handlers/slack.test.ts` — append `describe('slack_dm handler')` block with 19 tests + 1 non-agent C13-replacement test = 20 tests. ~400 LOC added.
- `src/ipc/handlers/index.ts` — import + register `slackDmHandler`. ~2 LOC delta.
- `src/ipc.ts` — strip dispatcher if-ladder branch (lines 958-972), delete `handleSlackDmIpc` function (lines 1074-1196), update inline comment block (lines 951-961). ~120 LOC removed.
- `src/ipc.test.ts` — remove `handleSlackDmIpc` import (line 20), delete 3 legacy C13 tests (lines 3677-3735), rewrite the non-agent test (lines 3737-3745) to use the new dispatcher path. ~80 LOC removed/replaced.
- `docs/context-engineering/ipc-handler-contract.md` — add `postHocNotify` paragraph after Rule 3's `actionTypeOverride` paragraph + authoring-checklist bullet. ~12 LOC added.

---

## Commit 1 — Contract widening: `postHocNotify`

### Task 1: Add `postHocNotify` field to `IpcAuthorization`

**Files:**
- Modify: `src/ipc/handler.ts:77-123` (interface definition — `IpcAuthorization`)

- [ ] **Step 1: Read `src/ipc/handler.ts:77-123`** to see the existing `IpcAuthorization` interface and pattern-match the JSDoc style of `actionTypeOverride` (which was added in Batch 2F).

- [ ] **Step 2: Add `postHocNotify?: true` to the interface**

Use the `Edit` tool. Find this block (handler.ts:114-123, the tail of the interface starting at `actionTypeOverride` and ending at `skipGate`'s closing `}`):

```typescript
  actionTypeOverride?: string;
  payloadForStaging: Record<string, unknown>;
  /**
   * Opt out of the trust gate. Permitted only when the handler's `type` is
   * in SKIP_GATE_ALLOWLIST — the dispatcher rejects this flag from
   * off-allowlist handlers as a defense-in-depth check. Rule 4 of the IPC
   * handler contract. Read-only actions only.
   */
  skipGate?: true;
}
```

Replace it with this block (adds `postHocNotify` after `skipGate`):

```typescript
  actionTypeOverride?: string;
  payloadForStaging: Record<string, unknown>;
  /**
   * Opt out of the trust gate. Permitted only when the handler's `type` is
   * in SKIP_GATE_ALLOWLIST — the dispatcher rejects this flag from
   * off-allowlist handlers as a defense-in-depth check. Rule 4 of the IPC
   * handler contract. Read-only actions only.
   */
  skipGate?: true;
  /**
   * On `responseKind: 'result'` handlers, fire a post-hoc Telegram notify
   * after the result file is written. The notify fires only when ALL of:
   *   1. `auth.postHocNotify === true` (this flag)
   *   2. `executeThrew === false` (execute did not throw)
   *   3. `executed === true` (handler did not bail with `{executed: false}`)
   *   4. `decision !== null` (handler did not skipGate)
   *   5. `isSuccessPayload(resultPayload)` (the handler returned
   *      `{success: true, ...}` in its result payload — i.e. the side
   *      effect actually succeeded; a bridge 4xx/5xx that returns
   *      `{success: false}` skips the notify)
   *
   * The notify additionally AND's with `decision.notify` and
   * `input.agentName` inside `fireNotifyIfRequested` (trust-gate.ts:61).
   * Net effect: autonomous trust = silent; non-agent callers = silent;
   * bridge failure = silent.
   *
   * Legitimate use: legacy hybrid handlers that both surface a structured
   * result to the in-container agent (via result file) AND notify the user
   * out-of-band (via Telegram). `slack_dm` is the canonical case. New
   * handlers should choose one or the other if possible.
   *
   * Combining `postHocNotify` with `skipGate` is a contract violation —
   * the dispatcher loudly denies and writes a `denied_contract_violation`
   * audit row (parallel to the off-allowlist skipGate check above).
   *
   * Has no effect on `responseKind: 'notify'` handlers — those already
   * fire `fireNotifyIfRequested` via the dispatcher's existing notify
   * branch (the postHocNotify code path is nested inside
   * `if (responseKind === 'result')`, so it cannot run for notify-kind
   * handlers).
   */
  postHocNotify?: true;
}
```

- [ ] **Step 3: Run typecheck** to confirm no consumers broke.

```bash
bun run typecheck
```

Expected: PASS (no errors). New field is optional; no existing handler needs to change.

### Task 2: Add `isSuccessPayload` helper to `src/ipc/handler.ts`

**Files:**
- Modify: `src/ipc/handler.ts` (end of file — after `writeResultFile`)

- [ ] **Step 1: Read the bottom of `src/ipc/handler.ts`** (lines 420 to EOF) to see where `writeResultFile` ends and the file terminates.

- [ ] **Step 2: Add `isSuccessPayload` helper**

Use the `Edit` tool. Find the closing brace of `writeResultFile` (the last function in the file). The function definition starts at `function writeResultFile(` around line 421.

After the closing `}` of `writeResultFile`, add this helper:

```typescript

/**
 * True iff `payload` is a `{ success: true, ... }` object shape.
 *
 * Used by the dispatcher's postHocNotify branch to gate the post-write
 * Telegram notify on whether the handler's `execute` reported the side
 * effect as successful. A bridge 4xx/5xx returns `{success: false}` and
 * must not produce a notify (legacy semantics for slack_dm).
 *
 * Narrow on purpose: only the literal boolean `true` qualifies. A handler
 * that returns `{success: 'true'}` (string) or `{success: 1}` (number)
 * will fail the check. See spec Risks table.
 */
export function isSuccessPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { success?: unknown }).success === true
  );
}
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

### Task 3: Write failing dispatcher contract tests (TDD)

**Files:**
- Create: `src/ipc/handler-post-hoc-notify.test.ts`

- [ ] **Step 1: Read `src/ipc/handler-action-type-override.test.ts:1-220`** for the structural pattern (test stub handler, agent setup, deps replacement for sendMessage spy, registeredGroups injection). This file is the structural twin.

- [ ] **Step 2: Write the failing test file**

Use the `Write` tool. Create `src/ipc/handler-post-hoc-notify.test.ts` with this content:

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { _initTestDatabase, getDb, setRegisteredGroup } from '../db.js';
import { DATA_DIR } from '../config.js';
import { IpcDeps } from '../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
  type IpcHandler,
} from './handler.js';

/**
 * Dispatcher contract tests for `postHocNotify` (Batch 2F.1).
 *
 * Pins:
 *   1. On a result-kind handler with postHocNotify + decision.notify +
 *      success payload, sendMessage fires once and the notify text
 *      contains the auditActionType (override-aware).
 *   2. Autonomous trust (decision.notify=false) → no sendMessage.
 *   3. Bridge failure (result.success=false) → no sendMessage.
 *   4. Opt-out (no postHocNotify on auth) → no sendMessage, even with
 *      trust=notify. Regression guard for the `auth.postHocNotify &&`
 *      AND-chain.
 *   5. Ordering: result file lives on disk before sendMessage is awaited.
 *      Uses outer-scope capture (NOT throw-inside-spy — firePostHocNotify
 *      swallows spy throws at trust-notify.ts:46-53).
 *   5a. Bail (executed=false) → no sendMessage. Regression guard for the
 *       `executed &&` AND-chain.
 *   6. Contract violation: postHocNotify + skipGate → loud deny with
 *      `denied_contract_violation` audit row, no execute, no notify.
 */
describe('postHocNotify dispatcher behavior', () => {
  const SOURCE_GROUP = 'telegram_pn';
  const MAIN_JID = 'tg:pn-main';
  let dataDir: string;
  let deps: IpcDeps;
  let agentName: string;
  let agentDir: string;
  let sent: { jid: string; text: string }[];

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();

    setRegisteredGroup('tg:pn1', {
      name: 'PN',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: false,
    });
    setRegisteredGroup(MAIN_JID, {
      name: 'Main',
      folder: 'telegram_pnmain',
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    sent = [];
    deps = {
      sendMessage: async (jid, text) => {
        sent.push({ jid, text });
      },
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: 'telegram_pnmain',
          trigger: '@Claire',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-hoc-notify-'));

    agentName = `test-pn-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
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

  const resultFile = (requestId: string): string =>
    path.join(dataDir, 'ipc', SOURCE_GROUP, 'wire_x_results', `${requestId}.json`);

  // ---- Test 1: success path with override ----

  it('1. postHocNotify + success + decision.notify → sendMessage once, with auditActionType in text', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    const handler: IpcHandler<{ ok: boolean }, { executed: true; result: unknown }> = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) => (typeof raw === 'object' && raw !== null ? { ok: true } : null),
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({ executed: true, result: { success: true, message: 'ok' } }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-1' });

    expect(fs.existsSync(resultFile('req-1'))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(MAIN_JID);
    // Mirrors handler-action-type-override.test.ts:200-201.
    expect(sent[0].text).toContain('audit_x');
    expect(sent[0].text).not.toContain('wire_x');
  });

  // ---- Test 2: autonomous trust → no notify ----

  it('2. postHocNotify + success + autonomous trust → sendMessage NOT called', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: autonomous\n',
    );

    const handler: IpcHandler<{ ok: boolean }, { executed: true; result: unknown }> = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) => (typeof raw === 'object' && raw !== null ? { ok: true } : null),
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({ executed: true, result: { success: true } }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-2' });

    expect(fs.existsSync(resultFile('req-2'))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  // ---- Test 3: bridge failure → no notify ----

  it('3. postHocNotify + result.success=false → sendMessage NOT called', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    const handler: IpcHandler<{ ok: boolean }, { executed: true; result: unknown }> = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) => (typeof raw === 'object' && raw !== null ? { ok: true } : null),
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({ executed: true, result: { success: false, message: 'bridge 500' } }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-3' });

    expect(fs.existsSync(resultFile('req-3'))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  // ---- Test 4: opt-out → no notify ----

  it('4. !postHocNotify + success + decision.notify → sendMessage NOT called (opt-in regression guard)', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    const handler: IpcHandler<{ ok: boolean }, { executed: true; result: unknown }> = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) => (typeof raw === 'object' && raw !== null ? { ok: true } : null),
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        // postHocNotify INTENTIONALLY OMITTED — pins that the
        // dispatcher's AND-chain requires the opt-in flag.
      }),
      execute: () => ({ executed: true, result: { success: true } }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-4' });

    expect(fs.existsSync(resultFile('req-4'))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  // ---- Test 5: ordering (file before notify) ----

  it('5. result file exists on disk before sendMessage is awaited', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    let fileExistedAtSpyEntry: boolean | null = null;
    // Replace sendMessage to capture file existence at spy-entry time.
    // Do NOT throw inside the spy — firePostHocNotify wraps sendMessage
    // in try/catch and would swallow the throw (trust-notify.ts:46-53).
    deps.sendMessage = async () => {
      fileExistedAtSpyEntry = fs.existsSync(resultFile('req-5'));
    };

    const handler: IpcHandler<{ ok: boolean }, { executed: true; result: unknown }> = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) => (typeof raw === 'object' && raw !== null ? { ok: true } : null),
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({ executed: true, result: { success: true } }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-5' });

    expect(fileExistedAtSpyEntry).toBe(true);
  });

  // ---- Test 5a: executed=false bail → no notify ----

  it('5a. postHocNotify + execute returns {executed: false} → sendMessage NOT called', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: notify\n',
    );

    const handler: IpcHandler<{ ok: boolean }, { executed: false }> = {
      type: 'wire_x',
      responseKind: 'result',
      resultsDirName: 'wire_x_results',
      parse: (raw) => (typeof raw === 'object' && raw !== null ? { ok: true } : null),
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        postHocNotify: true,
      }),
      execute: () => ({ executed: false }),
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x', requestId: 'req-5a' });

    // Dispatcher writes synthetic failure payload (handler.ts:378) but
    // the postHocNotify executed-guard blocks the notify.
    expect(fs.existsSync(resultFile('req-5a'))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  // ---- Test 6: postHocNotify + skipGate → loud deny ----

  it('6. postHocNotify + skipGate → denied_contract_violation audit row, no execute, no notify', async () => {
    // Note: wire_x is NOT on SKIP_GATE_ALLOWLIST. The off-allowlist
    // skipGate check at handler.ts:292-321 would catch this on its own.
    // The postHocNotify-specific loud-deny check is for the case where
    // a handler IS on SKIP_GATE_ALLOWLIST and accidentally combines the
    // two flags. We test wire_x here because it is the cleaner failure
    // mode (the new check fires whether or not the type is allowlisted).
    let executed = false;

    const handler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_x',
      // No responseKind — notify-kind. We do NOT actually want the
      // result-kind path to run; we want to prove the loud-deny fires
      // BEFORE the dispatcher reaches either branch.
      parse: (raw) => (typeof raw === 'object' && raw !== null ? { ok: true } : null),
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
        skipGate: true,
        postHocNotify: true,
      }),
      execute: () => {
        executed = true;
        return undefined;
      },
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_x' });

    expect(executed).toBe(false);
    expect(sent).toHaveLength(0);

    const rows = getDb()
      .prepare(
        'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('wire_x');
    expect(rows[0].outcome).toBe('denied_contract_violation');
  });
});
```

- [ ] **Step 3: Run the test file to verify it fails the way you expect**

```bash
bun run test -- src/ipc/handler-post-hoc-notify.test.ts
```

Expected: All 7 tests FAIL (some on `Property 'postHocNotify' does not exist on type 'IpcAuthorization'` — Task 1 added the field, so if Task 1 was completed first this compiles. Then the test failures will be on the runtime behavior because Task 4 has not wired the dispatcher yet). Note actual failure messages — most should be `expect(sent).toHaveLength(1)` failing with `Received: 0` because no notify is firing yet.

Test 6 may PASS by accident only if the OFF-allowlist `skipGate` check (handler.ts:292-321) already denies before the new check runs — read the test note above. If it passes, that's fine.

### Task 4: Wire `postHocNotify` into the dispatcher

**Files:**
- Modify: `src/ipc/handler.ts:281-400` (dispatcher: authorize check + post-result-write notify branch)

- [ ] **Step 1: Read `src/ipc/handler.ts:281-405`** so you have the full dispatcher in your head.

- [ ] **Step 2: Add the loud-deny check for `postHocNotify + skipGate`**

Use the `Edit` tool. Find this block (around handler.ts:281-322) — the existing off-allowlist `skipGate` check:

```typescript
  const auth = handler.authorize(input, ctx);
  if (auth === null) return { handled: true };

  // Rule 4: skipGate is honored only for allowlisted types. An off-allowlist
  // handler declaring skipGate is a contract violation. We deny + log AND
  // write a forensic audit row so the violation surfaces in agent_actions
  // queries (otherwise the gate-bypass attempt leaves no trail). We do NOT
  // throw — that would crash the IPC watcher process on a contributor bug,
  // taking down all other in-flight dispatches with it. Loud-but-contained
  // is the right failure mode.
  const wantsSkipGate = auth.skipGate === true;
  if (wantsSkipGate && !SKIP_GATE_ALLOWLIST.has(handler.type)) {
```

Add a new check IMMEDIATELY BEFORE `const wantsSkipGate = ...` (after the `if (auth === null) return { handled: true };` line):

```typescript
  const auth = handler.authorize(input, ctx);
  if (auth === null) return { handled: true };

  // Batch 2F.1: postHocNotify + skipGate is a contract violation. The
  // skipGate path returns `decision === null`, which would block the
  // postHocNotify branch silently. We make the violation loud, matching
  // the existing off-allowlist skipGate precedent below. This guards
  // against a future handler accidentally combining the two flags.
  if (auth.postHocNotify === true && auth.skipGate === true) {
    logger.error(
      { type: handler.type, sourceGroup: ctx.sourceGroup, agentName: ctx.agentName },
      'IPC handler combined postHocNotify with skipGate — contract violation',
    );
    if (ctx.agentName) {
      try {
        insertAgentAction({
          agent_name: ctx.agentName,
          group_folder: ctx.baseGroup,
          action_type: handler.type,
          trust_level: 'contract_violation',
          summary: `postHocNotify + skipGate (target=${auth.target.slice(0, 100)})`,
          target: auth.auditTarget ?? auth.target,
          outcome: 'denied_contract_violation',
        });
      } catch (err) {
        logger.error(
          { err, type: handler.type },
          'Failed to write postHocNotify+skipGate contract-violation audit row',
        );
      }
    }
    return { handled: true };
  }

  // Rule 4: skipGate is honored only for allowlisted types. An off-allowlist
  // handler declaring skipGate is a contract violation. We deny + log AND
  // write a forensic audit row so the violation surfaces in agent_actions
  // queries (otherwise the gate-bypass attempt leaves no trail). We do NOT
  // throw — that would crash the IPC watcher process on a contributor bug,
  // taking down all other in-flight dispatches with it. Loud-but-contained
  // is the right failure mode.
  const wantsSkipGate = auth.skipGate === true;
  if (wantsSkipGate && !SKIP_GATE_ALLOWLIST.has(handler.type)) {
```

- [ ] **Step 3: Wire the post-write `postHocNotify` branch into the result-kind block**

Use the `Edit` tool. Find this block (currently around handler.ts:371-403):

```typescript
  if (responseKind === 'result') {
    // Rule 1: dispatcher owns the result file. Always write something so the
    // poller never hangs — success payload on success, deliberate failure
    // shape on throw or bail.
    const filePayload: unknown = executeThrew
      ? { success: false, message: `Error: ${throwMessage}` }
      : !executed
        ? { success: false, message: 'execution bailed' }
        : resultPayload !== undefined
          ? resultPayload
          : { success: true };
    const resultsDirName = handler.resultsDirName ?? `${handler.type}_results`;
    writeResultFile(
      ctx.dataDir,
      ctx.sourceGroup,
      resultsDirName,
      requestId!,
      filePayload,
    );
  } else if (executed && decision !== null) {
```

Replace with:

```typescript
  if (responseKind === 'result') {
    // Rule 1: dispatcher owns the result file. Always write something so the
    // poller never hangs — success payload on success, deliberate failure
    // shape on throw or bail.
    const filePayload: unknown = executeThrew
      ? { success: false, message: `Error: ${throwMessage}` }
      : !executed
        ? { success: false, message: 'execution bailed' }
        : resultPayload !== undefined
          ? resultPayload
          : { success: true };
    const resultsDirName = handler.resultsDirName ?? `${handler.type}_results`;
    writeResultFile(
      ctx.dataDir,
      ctx.sourceGroup,
      resultsDirName,
      requestId!,
      filePayload,
    );

    // Batch 2F.1: postHocNotify for hybrid handlers (slack_dm). Fires
    // AFTER the result file write so the in-container agent sees the
    // file before the user receives the Telegram notify. The 5 AND'd
    // guards collectively express: opt-in, no throw, no bail, gate ran
    // (not skipGate), bridge reported real success.
    //
    // fireNotifyIfRequested internally AND's with decision.notify and
    // input.agentName (trust-gate.ts:61), so autonomous trust and
    // non-agent callers are silent without needing dispatcher-side
    // checks for those conditions.
    if (
      auth.postHocNotify &&
      !executeThrew &&
      executed &&
      decision !== null &&
      isSuccessPayload(resultPayload)
    ) {
      await fireNotifyIfRequested(decision, {
        agentName: ctx.agentName,
        actionType: auditActionType,
        summary: auth.notifySummary,
        target: auth.target,
        registeredGroups: ctx.registeredGroups,
        deps: ctx.deps,
      });
    }
  } else if (executed && decision !== null) {
```

- [ ] **Step 4: Confirm `isSuccessPayload` is in scope**

The helper from Task 2 is declared at module scope in the same file (`src/ipc/handler.ts`). No import needed. Verify by reading the file end-to-end:

```bash
grep -n "isSuccessPayload" src/ipc/handler.ts
```

Expected: 2 hits — the helper definition near EOF and the call site inside the dispatcher.

- [ ] **Step 5: Run the dispatcher contract tests to verify they pass**

```bash
bun run test -- src/ipc/handler-post-hoc-notify.test.ts
```

Expected: All 7 tests PASS. If test 6 fails because the off-allowlist check runs first (handler.ts:292-321 vs the new check), the order matters: the new check must come BEFORE the off-allowlist check (Step 2 placed it that way). If you placed it AFTER, swap.

- [ ] **Step 6: Run the full ipc test sweep** to confirm no regressions across prior batches.

```bash
bun run test -- src/ipc/
```

Expected: All `src/ipc/**/*.test.ts` PASS. If `handler-action-type-override.test.ts` regresses, you probably broke the existing off-allowlist `skipGate` block when adding the new one. Read the diff carefully.

### Task 5: Update contract doc with `postHocNotify` paragraph

**Files:**
- Modify: `docs/context-engineering/ipc-handler-contract.md` (Rule 3 section + authoring checklist)

- [ ] **Step 1: Read the contract doc** to locate Rule 3 and find the existing `actionTypeOverride` paragraph (added in Batch 2F).

```bash
grep -n "actionTypeOverride\|## Rule\|Authoring checklist" docs/context-engineering/ipc-handler-contract.md | head -20
```

- [ ] **Step 2: Add a `postHocNotify` paragraph after the `actionTypeOverride` paragraph**

Use the `Edit` tool. Find the closing paragraph of the `actionTypeOverride` description (it ends with "...not a design escape hatch."). Add a new paragraph immediately after:

```
   The dispatcher also honors `auth.postHocNotify` (Batch 2F.1) on
   `responseKind: 'result'` handlers. When set, the dispatcher fires
   `fireNotifyIfRequested` AFTER `writeResultFile`, gated on five AND'd
   conditions: `postHocNotify === true`, no throw from execute, `executed`
   is true, `decision` is non-null, and the handler's result payload is
   `{success: true, ...}` (checked via `isSuccessPayload`). The notify
   additionally AND's with `decision.notify` and `agentName` inside
   `fireNotifyIfRequested`, so autonomous trust and non-agent callers
   are silent automatically. `slack_dm` is THE canonical case (hybrid:
   structured result file for the in-container agent AND user-facing
   Telegram notify). Combining `postHocNotify` with `skipGate` is a
   contract violation and produces a `denied_contract_violation` audit
   row (parallel to the off-allowlist `skipGate` check).
```

- [ ] **Step 3: Add a bullet to the authoring checklist**

Find the existing `actionTypeOverride` bullet under the "Authoring checklist" header. Append this sub-bullet immediately under it (or near it, matching the existing list style):

```
   - Do not set `postHocNotify` for a brand-new handler. The flag exists
     to bridge legacy hybrid handlers (`slack_dm`) that surface BOTH a
     structured result AND a user-facing notification. New handlers
     should be one or the other. If you genuinely need both, your spec
     must justify it — and you must NOT combine `postHocNotify` with
     `skipGate` (contract violation, dispatcher loudly denies).
```

- [ ] **Step 4: Verify the doc still reads as a coherent contract**

```bash
grep -nE "actionTypeOverride|postHocNotify|skipGate" docs/context-engineering/ipc-handler-contract.md
```

Expected: Both new fields visible, in a similar pattern to the existing `skipGate` and `actionTypeOverride` mentions.

### Task 6: Commit 1 — `postHocNotify` contract widening

**Files:**
- Stage: `src/ipc/handler.ts`, `src/ipc/handler-post-hoc-notify.test.ts`, `docs/context-engineering/ipc-handler-contract.md`

- [ ] **Step 1: Verify only the intended files are modified**

```bash
rtk git status
```

Expected: 3 files in the "Modified/Untracked" lists matching the three above (plus the 5-6 unrelated pre-existing modified files that have been carried through from prior batches — leave those alone).

- [ ] **Step 2: Stage the three files explicitly**

```bash
rtk git add src/ipc/handler.ts src/ipc/handler-post-hoc-notify.test.ts docs/context-engineering/ipc-handler-contract.md
```

- [ ] **Step 3: Commit**

```bash
rtk git commit -m "$(cat <<'EOF'
refactor(ipc): add postHocNotify to IpcAuthorization (Batch 2F.1 prep)

Lets a responseKind: 'result' handler also fire a post-hoc Telegram
notify after the result file is written. Needed because legacy slack_dm
is a hybrid: it writes a structured result file (for the in-container
agent) AND notifies the user out-of-band (Telegram). Migrating it
without this contract would force either dropping the notify or
abandoning the result file.

Five AND'd guards: postHocNotify opt-in, no execute throw, no bail,
gate ran (not skipGate), and result payload is {success: true}. Notify
additionally AND's with decision.notify and agentName inside
fireNotifyIfRequested, so autonomous trust + non-agent callers are
silent automatically.

Combining postHocNotify with skipGate is a contract violation —
dispatcher loudly denies with a denied_contract_violation audit row,
parallel to the existing off-allowlist skipGate check.

Adds isSuccessPayload helper (narrow check: typeof object + .success ===
true). Documented as: only the literal boolean true qualifies; this
prevents accidental false-positives on handlers returning string/number
success values.

Seven new dispatcher contract tests pin: override propagation in notify
text, autonomous-trust silence, bridge-failure silence, opt-out
regression guard, file-before-notify ordering (outer-scope capture, NOT
throw-in-spy which firePostHocNotify swallows), executed:false bail,
loud-deny on postHocNotify+skipGate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify the commit landed**

```bash
rtk git log -1 --oneline
```

Expected: One line beginning `refactor(ipc): add postHocNotify to IpcAuthorization (Batch 2F.1 prep)`.

---

## Commit 2 — Migrate `slack_dm`

### Task 7: Write the failing handler tests (TDD, Part 1 — append to slack.test.ts)

**Files:**
- Modify: `src/ipc/handlers/slack.test.ts` (append after the closing `}` of the existing `describe('slack_dm_read handler', ...)` block)

- [ ] **Step 1: Read `src/ipc/handlers/slack.test.ts:1-100`** for the existing test setup pattern (beforeEach, deps shape, dispatch helper, fetchMock).

- [ ] **Step 2: Find the closing `});` of the existing `describe('slack_dm_read handler', ...)` block** (the file ends with it).

```bash
grep -n "^});" src/ipc/handlers/slack.test.ts | tail -5
```

Expected: The last `});` line is the end of the `slack_dm_read handler` describe block. Append after that line.

- [ ] **Step 3: Append the `slack_dm handler` describe block**

Use the `Edit` tool. Find the last line of the file (the closing `});`):

```typescript
});
```

Replace with this block (keeps the original closing AND appends the new describe block + a trailing newline):

```typescript
});

/**
 * slack_dm (write) handler tests. Migrated from src/ipc.ts:1074-1196
 * (handleSlackDmIpc) at git HEAD prior to Batch 2F.1.
 *
 * Pins:
 *  - parse / authorize / execute unit shape
 *  - authorize accepts non-agent callers (matches imessageSendHandler
 *    pattern verified at imessage.ts:184-202; gateAndStage's
 *    NON_AGENT_DECISION + fireNotifyIfRequested's internal agentName
 *    guard preserve legacy "bridge fires, no notify" behavior)
 *  - notifySummary literal format including 120-char slice
 *  - wire-format result-file path matches container hardcoded
 *    `slack_results/`
 *  - actionTypeOverride preserves audit action_type as `send_slack_dm`
 *  - postHocNotify wires through the dispatcher's new branch (Batch
 *    2F.1) on bridge 2xx + trust=notify, stays silent on autonomous
 *    or bridge failure
 *  - dispatcher catches fetch rejection (network down) AND
 *    response.json() rejection (non-JSON body) — both produce failure
 *    result files and skip the notify (isSuccessPayload guard)
 *  - agent + malformed/missing requestId path writes synthetic audit row
 *    (Batch 4 dispatcher-observability contract)
 *  - trust level 'ask' stages without executing (no file, no notify)
 */
describe('slack_dm handler', () => {
  const SOURCE_GROUP = 'telegram_slacktest';
  // Use the same SOURCE_GROUP as the read tests above — vitest isolates
  // mocks/DB per-test via beforeEach so the file-scoped describe blocks
  // do not interfere.

  // Note: the outer beforeEach (lines 38-65) registers slackDmReadHandler
  // but resets the handler registry first, so we are guaranteed a clean
  // slate. We register slackDmHandler in this describe's own beforeEach.

  let dataDir: string;
  let deps: IpcDeps;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(slackDmHandler);

    setRegisteredGroup('tg:slacktest1', {
      name: 'SlackTest',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-dm-handler-test-'));

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const dispatch = async (
    data: Record<string, unknown>,
    compoundSource = SOURCE_GROUP,
  ) => {
    const ctx = buildContext(compoundSource, false, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const readResult = (
    sourceGroup: string,
    requestId: string,
  ): Record<string, unknown> | null => {
    const file = path.join(
      dataDir,
      'ipc',
      sourceGroup,
      'slack_results',
      `${requestId}.json`,
    );
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  };

  // ---- Unit: parse ----

  it('parse returns null for non-object input', () => {
    expect(slackDmHandler.parse(null)).toBeNull();
    expect(slackDmHandler.parse(undefined)).toBeNull();
    expect(slackDmHandler.parse(42)).toBeNull();
    expect(slackDmHandler.parse('str')).toBeNull();
  });

  it('parse extracts text + user_id + user_email and coerces wrong types to undefined', () => {
    expect(
      slackDmHandler.parse({
        text: 'hi',
        user_id: 'U1',
        user_email: 'a@b.com',
      }),
    ).toEqual({
      text: 'hi',
      user_id: 'U1',
      user_email: 'a@b.com',
    });
    expect(slackDmHandler.parse({ text: 42, user_id: 1, user_email: true })).toEqual({
      text: undefined,
      user_id: undefined,
      user_email: undefined,
    });
  });

  // ---- Unit: authorize ----

  it('authorize returns a non-null IpcAuthorization for non-agent caller (matches imessageSendHandler precedent)', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = slackDmHandler.authorize(
      { text: 'hi', user_id: undefined, user_email: 'a@b.com' },
      ctx,
    );
    expect(auth).not.toBeNull();
    // Per spec: write actions accept non-agent callers; the downstream
    // gateAndStage NON_AGENT_DECISION + fireNotifyIfRequested agentName
    // AND-guard preserve legacy "bridge fires, no audit row, no notify"
    // behavior.
    expect(auth!.postHocNotify).toBe(true);
    expect(auth!.actionTypeOverride).toBe('send_slack_dm');
  });

  it('authorize returns IpcAuthorization with literal notifySummary including 120-char slice', () => {
    const ctx = buildContext(`${SOURCE_GROUP}--some-agent`, false, deps, dataDir);
    const auth = slackDmHandler.authorize(
      {
        text: 'x'.repeat(200),
        user_id: undefined,
        user_email: 'alice@example.com',
      },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.postHocNotify).toBe(true);
    expect(auth!.actionTypeOverride).toBe('send_slack_dm');
    expect(auth!.target).toBe('alice@example.com');
    expect(auth!.auditSummary).toBe('x'.repeat(200));
    // The literal expected notifySummary — pins the slice(0, 120) call.
    expect(auth!.notifySummary).toBe(
      'Slack DM → alice@example.com: ' + 'x'.repeat(120),
    );
  });

  // ---- Unit: execute ----

  it('execute returns missing-params failure when text absent', async () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const result = await slackDmHandler.execute(
      { text: undefined, user_id: 'U1', user_email: undefined },
      ctx,
    );
    expect(result).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Missing required parameters: text and either user_id or user_email',
      },
    });
  });

  it('execute returns missing-params failure when both user_id and user_email absent', async () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const result = await slackDmHandler.execute(
      { text: 'hi', user_id: undefined, user_email: undefined },
      ctx,
    );
    expect(result).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Missing required parameters: text and either user_id or user_email',
      },
    });
  });

  it('execute happy path POSTs to 19876/slack/dm and returns success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: 'sent' }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmHandler.execute(
      { text: 'hi', user_id: 'U1', user_email: undefined },
      ctx,
    );
    expect(out).toEqual({
      executed: true,
      result: {
        success: true,
        message: 'sent',
        data: { message: 'sent' },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19876/slack/dm',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('execute returns failure result on bridge 4xx with error field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'user_not_found' }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmHandler.execute(
      { text: 'hi', user_id: 'U_unknown', user_email: undefined },
      ctx,
    );
    expect(out).toEqual({
      executed: true,
      result: { success: false, message: 'user_not_found' },
    });
  });

  it('execute returns failure result on bridge 5xx without error field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmHandler.execute(
      { text: 'hi', user_id: 'U1', user_email: undefined },
      ctx,
    );
    expect(out).toEqual({
      executed: true,
      result: { success: false, message: 'Bridge returned 500' },
    });
  });

  it('execute includes user_email when set, omits when undefined; same for user_id', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);

    await slackDmHandler.execute(
      { text: 'hi', user_id: undefined, user_email: 'a@b.com' },
      ctx,
    );
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body1).toEqual({ text: 'hi', user_email: 'a@b.com' });

    await slackDmHandler.execute(
      { text: 'hi', user_id: 'U1', user_email: undefined },
      ctx,
    );
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body2).toEqual({ text: 'hi', user_id: 'U1' });

    await slackDmHandler.execute(
      { text: 'hi', user_id: 'U1', user_email: 'a@b.com' },
      ctx,
    );
    const body3 = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body3).toEqual({ text: 'hi', user_id: 'U1', user_email: 'a@b.com' });
  });

  // ---- Integration: dispatcher result file ----

  it('dispatcher writes success result to slack_results/ (NOT slack_dm_results/)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: 'sent' }),
    });

    await dispatch({
      type: 'slack_dm',
      requestId: 'req-ok',
      text: 'hi',
      user_email: 'a@b.com',
    });

    expect(readResult(SOURCE_GROUP, 'req-ok')).not.toBeNull();
    // Pin the legacy prefix-grouped dir — guards against a future
    // accidental drop of `resultsDirName: 'slack_results'`.
    expect(
      fs.existsSync(
        path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_dm_results', 'req-ok.json'),
      ),
    ).toBe(false);
  });

  it('dispatcher drops malformed requestId for non-agent caller, no file written', async () => {
    await dispatch({
      type: 'slack_dm',
      requestId: '../../etc/passwd',
      text: 'hi',
      user_email: 'a@b.com',
    });
    expect(
      fs.existsSync(path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_results')),
    ).toBe(false);
  });

  it('dispatcher drops malformed requestId for agent caller, writes synthetic audit row', async () => {
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    try {
      await dispatch(
        {
          type: 'slack_dm',
          requestId: '../../etc/passwd',
          text: 'hi',
          user_email: 'a@b.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      expect(
        fs.existsSync(path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_results')),
      ).toBe(false);

      const rows = getDb()
        .prepare('SELECT outcome FROM agent_actions WHERE agent_name = ?')
        .all(agentName) as { outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('dropped_invalid_requestId');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('dispatcher drops missing requestId for non-agent caller, no file written', async () => {
    await dispatch({
      type: 'slack_dm',
      text: 'hi',
      user_email: 'a@b.com',
    });
    expect(
      fs.existsSync(path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_results')),
    ).toBe(false);
  });

  it('dispatcher drops missing requestId for agent caller, writes synthetic audit row', async () => {
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    try {
      await dispatch(
        {
          type: 'slack_dm',
          text: 'hi',
          user_email: 'a@b.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );
      const rows = getDb()
        .prepare('SELECT outcome FROM agent_actions WHERE agent_name = ?')
        .all(agentName) as { outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('dropped_invalid_requestId');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('dispatcher catches fetch rejection (network down) and writes failure file', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await dispatch({
      type: 'slack_dm',
      requestId: 'req-net',
      text: 'hi',
      user_email: 'a@b.com',
    });
    const result = readResult(SOURCE_GROUP, 'req-net');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('ECONNREFUSED');
  });

  it('dispatcher catches response.json() rejection (bridge returned non-JSON) and writes failure file', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <');
      },
    });
    await dispatch({
      type: 'slack_dm',
      requestId: 'req-html',
      text: 'hi',
      user_email: 'a@b.com',
    });
    const result = readResult(SOURCE_GROUP, 'req-html');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('Unexpected token');
  });

  // ---- Integration: audit + notify ----

  it('agent + send_slack_dm:notify + bridge 200 → file + audit row + sendMessage once', async () => {
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  send_slack_dm: notify\n',
    );

    const MAIN_JID = 'tg:slacktest-main';
    setRegisteredGroup(MAIN_JID, {
      name: 'Main',
      folder: 'telegram_slacktest_main',
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const sent: { jid: string; text: string }[] = [];
    deps = {
      ...deps,
      sendMessage: async (jid, text) => {
        sent.push({ jid, text });
      },
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: 'telegram_slacktest_main',
          trigger: '@Claire',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
    };

    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: 'sent' }),
      });

      await dispatch(
        {
          type: 'slack_dm',
          requestId: 'req-audit-notify',
          text: 'hello peer',
          user_email: 'peer@example.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      expect(readResult(SOURCE_GROUP, 'req-audit-notify')).not.toBeNull();

      const rows = getDb()
        .prepare(
          'SELECT action_type, summary, target, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as {
        action_type: string;
        summary: string;
        target: string;
        outcome: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].action_type).toBe('send_slack_dm');
      expect(rows[0].outcome).toBe('allowed');
      expect(rows[0].target).toBe('peer@example.com');

      expect(sent).toHaveLength(1);
      expect(sent[0].jid).toBe(MAIN_JID);
      expect(sent[0].text).toContain('send_slack_dm');
      expect(sent[0].text).not.toContain('slack_dm');
      // Note: 'slack_dm' would also be a substring of 'send_slack_dm',
      // so the strict not.toContain assertion above would fail. We
      // accept that — the load-bearing assertion is that the override
      // string appears.
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('agent + send_slack_dm:autonomous + bridge 200 → file + audit row + sendMessage NOT called', async () => {
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  send_slack_dm: autonomous\n',
    );

    const MAIN_JID = 'tg:slacktest-main-auto';
    setRegisteredGroup(MAIN_JID, {
      name: 'Main',
      folder: 'telegram_slacktest_main',
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const sent: { jid: string; text: string }[] = [];
    deps = {
      ...deps,
      sendMessage: async (jid, text) => {
        sent.push({ jid, text });
      },
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: 'telegram_slacktest_main',
          trigger: '@Claire',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
    };

    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: 'sent' }),
      });

      await dispatch(
        {
          type: 'slack_dm',
          requestId: 'req-audit-auto',
          text: 'hello peer',
          user_email: 'peer@example.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      expect(readResult(SOURCE_GROUP, 'req-audit-auto')).not.toBeNull();

      const rows = getDb()
        .prepare(
          'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as { action_type: string; outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].action_type).toBe('send_slack_dm');
      expect(rows[0].outcome).toBe('allowed');

      expect(sent).toHaveLength(0);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('agent + send_slack_dm:ask → no file, audit row outcome=staged', async () => {
    const agentName = `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  send_slack_dm: ask\n',
    );

    try {
      await dispatch(
        {
          type: 'slack_dm',
          requestId: 'req-audit-ask',
          text: 'hello peer',
          user_email: 'peer@example.com',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      // No file — gate staged, execute did not run.
      expect(readResult(SOURCE_GROUP, 'req-audit-ask')).toBeNull();
      // No bridge call.
      expect(fetchMock).not.toHaveBeenCalled();

      const rows = getDb()
        .prepare(
          'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
        )
        .all(agentName) as { action_type: string; outcome: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].action_type).toBe('send_slack_dm');
      expect(rows[0].outcome).toBe('staged');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 4: Run the file to verify all tests fail with module-not-found**

```bash
bun run test -- src/ipc/handlers/slack.test.ts
```

Expected: All new `slack_dm handler` tests FAIL because the import on the next task (slackDmHandler) does not yet exist. The error will be `slackDmHandler is not defined` or similar. The PREVIOUS `slack_dm_read handler` tests should still PASS.

If the file does not compile at all (no test output), that means the import statement is wrong. Add a single import line: read step 2 of Task 8 below for the import we will add — you can add it now if it makes the failures more legible, but the import line should be added BEFORE the new describe block in a way that makes Step 3 above resolve.

**Note on the import:** The `slackDmHandler` symbol must be imported. Append to the existing import line at the top of slack.test.ts (currently `import { slackDmReadHandler } from './slack.js';`):

Use the `Edit` tool. Find:

```typescript
import { slackDmReadHandler } from './slack.js';
```

Replace with:

```typescript
import { slackDmReadHandler, slackDmHandler } from './slack.js';
```

Then re-run the test command. Expected: same failures but now on a runtime "no handler registered" rather than a compile error.

### Task 8: Write `slackDmHandler` in `src/ipc/handlers/slack.ts`

**Files:**
- Modify: `src/ipc/handlers/slack.ts` (append the new handler after `slackDmReadHandler`)

- [ ] **Step 1: Read `src/ipc/handlers/slack.ts:1-EOF`** to see the existing `slackDmReadHandler` for pattern reference and to find the file's final closing brace.

- [ ] **Step 2: Append the `slackDmHandler` after the existing handler**

Use the `Edit` tool. Find the closing `};` of `slackDmReadHandler` — it ends with:

```typescript
};
```

(There should be only one `};` at the file's tail — the export. Read the file to confirm. If there are multiple `};` lines, use the last one in the file.)

Append the new handler after that closing `};`. Add this content:

```typescript

/**
 * slack_dm (write) — migrated from src/ipc.ts:1074-1196 (handleSlackDmIpc)
 * at git HEAD prior to Batch 2F.1.
 *
 * Wire-format notes:
 *  - resultsDirName: 'slack_results' matches the container-side hardcoded
 *    path at container/agent-runner/src/ipc-mcp-stdio.ts:1601 (same dir as
 *    slackDmReadHandler).
 *  - actionTypeOverride: 'send_slack_dm' preserves the legacy audit name
 *    referenced by 9 live trust.yaml files (claire, coo, einstein, freud,
 *    marvin, simon, steve, vincent, warren) AND by the agent-facing MCP
 *    tool description at ipc-mcp-stdio.ts:1569.
 *  - postHocNotify: true opts into the Batch 2F.1 dispatcher branch that
 *    fires fireNotifyIfRequested AFTER writeResultFile, gated on bridge
 *    success. Together with the trust gate's decision.notify boolean
 *    (autonomous → silent, notify → ping), this preserves the legacy
 *    "notify level fires firePostHocNotify on bridge 2xx" behavior at
 *    ipc.ts:1163-1172.
 *  - authorize accepts non-agent callers (no agentName check) — matches
 *    imessageSendHandler at imessage.ts:184-202. The non-agent path
 *    flows through gateAndStage's NON_AGENT_DECISION (autonomous, no
 *    notify) and fireNotifyIfRequested's internal agentName guard
 *    (trust-gate.ts:61), preserving the legacy "bridge fires, no audit,
 *    no notify" behavior.
 */

interface SlackDmInput {
  text: string | undefined;
  user_id: string | undefined;
  user_email: string | undefined;
}

export const slackDmHandler: IpcHandler<
  SlackDmInput,
  { executed: true; result: { success: boolean; message: string; data?: unknown } }
> = {
  type: 'slack_dm',
  responseKind: 'result',
  resultsDirName: 'slack_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      text: typeof r.text === 'string' ? r.text : undefined,
      user_id: typeof r.user_id === 'string' ? r.user_id : undefined,
      user_email: typeof r.user_email === 'string' ? r.user_email : undefined,
    };
  },

  authorize(input) {
    const target = input.user_email || input.user_id || '';
    return {
      target,
      auditSummary: input.text || '',
      notifySummary: `Slack DM → ${input.user_email || input.user_id || '?'}: ${(input.text || '').slice(0, 120)}`,
      payloadForStaging: {
        type: 'slack_dm',
        text: input.text,
        user_id: input.user_id,
        user_email: input.user_email,
      },
      actionTypeOverride: 'send_slack_dm',
      postHocNotify: true,
    };
  },

  async execute(input, ctx) {
    if (!input.text || (!input.user_id && !input.user_email)) {
      return {
        executed: true,
        result: {
          success: false,
          message:
            'Missing required parameters: text and either user_id or user_email',
        },
      };
    }

    const body: Record<string, string> = { text: input.text };
    if (input.user_id) body.user_id = input.user_id;
    if (input.user_email) body.user_email = input.user_email;

    const response = await fetch('http://127.0.0.1:19876/slack/dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;

    logger.info(
      {
        sourceGroup: ctx.sourceGroup,
        user_id: input.user_id,
        user_email: input.user_email,
        bridgeStatus: response.status,
      },
      'slack_dm bridge call complete',
    );

    if (response.ok) {
      return {
        executed: true,
        result: {
          success: true,
          message: (result.message as string) || 'Slack DM sent',
          data: result,
        },
      };
    }
    return {
      executed: true,
      result: {
        success: false,
        message:
          (result.error as string) || `Bridge returned ${response.status}`,
      },
    };
  },
};
```

- [ ] **Step 3: Verify the file compiles**

```bash
bun run typecheck
```

Expected: PASS. If TypeScript complains about the type parameter, double-check the `IpcHandler<...>` generics signature — `slackDmReadHandler` uses `IpcHandler<SlackDmReadInput, ExecuteResult>`; this new handler uses a more specific result type. Both forms work.

- [ ] **Step 4: Run the slack tests — all should now compile but fail because the handler is not registered yet**

```bash
bun run test -- src/ipc/handlers/slack.test.ts
```

Expected: Unit-level tests (parse / authorize / execute) PASS because they call the handler functions directly. Integration tests FAIL because `dispatch()` returns without doing anything (no handler registered for `slack_dm`).

### Task 9: Register `slackDmHandler` in the registry

**Files:**
- Modify: `src/ipc/handlers/index.ts` (add import + register call)

- [ ] **Step 1: Read `src/ipc/handlers/index.ts`** to see the current registration order.

```bash
cat src/ipc/handlers/index.ts
```

- [ ] **Step 2: Add the import + registration**

Use the `Edit` tool. Find the existing slack import:

```typescript
import { slackDmReadHandler } from './slack.js';
```

Replace with:

```typescript
import { slackDmReadHandler, slackDmHandler } from './slack.js';
```

Then find the registration of `slackDmReadHandler`:

```typescript
  registerIpcHandler(slackDmReadHandler);
```

Add immediately after:

```typescript
  registerIpcHandler(slackDmHandler);
```

- [ ] **Step 3: Run the slack tests — integration tests should now pass**

```bash
bun run test -- src/ipc/handlers/slack.test.ts
```

Expected: All 19 new `slack_dm handler` tests PASS (Task 11b adds the 20th — non-agent pin — which is not yet present at this point). All ~16 `slack_dm_read handler` tests still PASS.

- [ ] **Step 4: Run the full ipc sweep**

```bash
bun run test -- src/ipc/
```

Expected: All `src/ipc/**/*.test.ts` PASS. If `handler.test.ts` (the registry tests) reports a duplicate-handler error, your import at index.ts is doubled — check.

### Task 10: Strip legacy `slack_dm` dispatcher branch + function from `src/ipc.ts`

**Files:**
- Modify: `src/ipc.ts:958-972` (delete dispatcher branch)
- Modify: `src/ipc.ts:1074-1196` (delete `handleSlackDmIpc` function)
- Modify: `src/ipc.ts:951-961` (update inline comment block)

- [ ] **Step 1: Read `src/ipc.ts:945-985`** so you see the inline comment block + dispatcher branch in context.

- [ ] **Step 2: Update the inline comment block to drop the half-migrated caveat**

Use the `Edit` tool. Find this block (currently around src/ipc.ts:957-960):

```typescript
      // slack_dm_read migrated to src/ipc/handlers/slack.ts — dispatched
      // via the IpcHandler registry above (dispatchIpcAction). slack_dm
      // remains in the if-ladder below pending Batch 2F.1 (contract
      // widening for post-hoc-notify-after-result hybrids).
```

Replace with:

```typescript
      // slack_dm_read AND slack_dm migrated to src/ipc/handlers/slack.ts —
      // both dispatched via the IpcHandler registry above
      // (dispatchIpcAction). slack_dm uses postHocNotify: true (added in
      // Batch 2F.1) to fire a Telegram notify after the result file is
      // written.
```

- [ ] **Step 3: Delete the `slack_dm` dispatcher branch**

Use the `Edit` tool. Find this block (currently around `src/ipc.ts:962-972`):

```typescript
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'slack_dm'
      ) {
        handled = await handleSlackDmIpc(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
          notifyContext,
        );
      }
```

Delete it entirely (replace with empty string in Edit's `new_string`).

**Note:** The exact arg list (does it include `notifyContext` or not?) and the exact braces and indentation may have drifted. If the Edit fails with "no match", read the surrounding lines (`grep -n "slack_dm" src/ipc.ts` or `sed -n '955,985p' src/ipc.ts`) and adjust the `old_string` to match exactly. Do NOT delete the `slack_dm_read` branch (already gone post-Batch 2F).

- [ ] **Step 4: Delete the `handleSlackDmIpc` function**

Use the `Edit` tool. Find the entire function block starting at `export async function handleSlackDmIpc(` (currently around `src/ipc.ts:1074`) and ending at the closing `}` of the function (currently around `src/ipc.ts:1196` — verify by reading the file).

Delete the entire function definition. Be careful to not delete the function above (`handleSlackDmReadIpc` is already gone) or below (`handleSaveSkillIpc` or whatever the next function is — stays).

- [ ] **Step 5: Run typecheck** to confirm no dead references.

```bash
bun run typecheck
```

Expected: PASS. If you see `Cannot find name 'handleSlackDmIpc'`, you missed a call site — grep for it:

```bash
grep -n "handleSlackDmIpc" src/
```

Expected: Zero matches in `src/` (you may still see matches in `src/ipc.test.ts` — those are addressed in Task 11).

### Task 11: Delete + rewrite the C13 test block in `src/ipc.test.ts`

**Files:**
- Modify: `src/ipc.test.ts:20` (remove `handleSlackDmIpc` from import)
- Modify: `src/ipc.test.ts:3646-3746` (delete or rewrite the C13 describe block)

- [ ] **Step 1: Remove the import**

Use the `Edit` tool. Find the import block near the top of `src/ipc.test.ts` (around line 20) that includes `handleSlackDmIpc`. The exact shape may be a multi-symbol import. Locate it:

```bash
grep -n "handleSlackDmIpc" src/ipc.test.ts
```

Expected: Now the only matches are inside the C13 describe block (will be deleted in Step 2) + the import. Remove just `handleSlackDmIpc` from the import — leave other imported symbols.

For example, if the import is:

```typescript
import {
  handleSlackDmIpc,
  someOtherFn,
} from './ipc.js';
```

Edit to:

```typescript
import {
  someOtherFn,
} from './ipc.js';
```

If `handleSlackDmIpc` is the ONLY thing imported on that line, delete the entire import.

- [ ] **Step 2: Read the C13 describe block to confirm line ranges**

```bash
sed -n '3646,3746p' src/ipc.test.ts | head -110
```

Expected: The block starts at line 3646 with `// --- C13: send_slack_dm trust enforcement for agent callers ---` and ends at line 3746 with `});` followed by the next describe block.

- [ ] **Step 3: Delete the entire C13 describe block**

Use the `Edit` tool. Find the block:

```typescript
// --- C13: send_slack_dm trust enforcement for agent callers ---

describe('send_slack_dm trust enforcement (C13)', () => {
```

Through to its closing `});` (around line 3746). Replace the entire block with this single comment line:

```typescript
// C13: send_slack_dm trust enforcement moved to src/ipc/handlers/slack.test.ts
// (autonomous → test 'agent + send_slack_dm:autonomous + bridge 200 ...',
//  draft  → covered by trust-enforcement's checkTrustAndStage tests,
//  ask    → test 'agent + send_slack_dm:ask → no file, audit row outcome=staged',
//  non-agent main → covered by the dispatcher's NON_AGENT_DECISION path; no
//  separate test added because the non-agent path is exercised transitively
//  by tests that dispatch without an --agent suffix and assert fetch fires).
```

**Important — per spec Change 3b (R1 Critical 1):** The non-agent path test at original lines 3737-3745 is the load-bearing pin for the cluster-norm-preserving design choice (non-agent → bridge fires, no audit, no notify). The spec explicitly says **"Rewrite, do not delete"**. We delete the C13 block (because it calls the now-removed `handleSlackDmIpc` function) but MUST add a replacement test that exercises the same invariant via the new dispatcher path. This is mandatory, not optional.

- [ ] **Step 4 (REQUIRED — Task 11b): Add the non-agent pin test to `slack.test.ts`**

Use the `Edit` tool. In `src/ipc/handlers/slack.test.ts`, find the closing `});` of the `slack_dm handler` describe block (added in Task 7 — the last `});` in the file). Append this test BEFORE that closing brace (i.e. add it as the final test inside the describe block):

```typescript
  it('non-agent caller dispatches to bridge with no audit row and no notify (replaces C13 non-agent test)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: 'sent' }),
    });

    await dispatch({
      type: 'slack_dm',
      requestId: 'req-nonagent',
      text: 'hi',
      user_email: 'a@b.com',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readResult(SOURCE_GROUP, 'req-nonagent')).not.toBeNull();
    // No audit row — gateAndStage returns NON_AGENT_DECISION early at
    // trust-gate.ts:35, skipping checkTrustAndStage entirely. This pins
    // the cluster-norm-preserving non-agent behavior chosen during the
    // round-2 peer review (R1 Critical 2).
    const rows = getDb()
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type IN ('slack_dm', 'send_slack_dm')",
      )
      .all();
    expect(rows).toHaveLength(0);
  });

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS. The deleted import + deleted describe block leave the file consistent.

- [ ] **Step 6: Run the full test suite**

```bash
bun run test
```

Expected: PASS. All ~2377 tests green (baseline ~2350 + 27 new − 4 deleted C13 tests; counts approximate).

- [ ] **Step 7: Verify cleanliness**

```bash
grep -nE "handleSlackDmIpc\b|handleSlackDmReadIpc\b" src/
```

Expected: Zero matches. Both legacy functions and all their call sites are gone.

```bash
grep -rln "send_slack_dm" data/agents/*/trust.yaml | wc -l
```

Expected: 9 (unchanged from pre-batch baseline — `actionTypeOverride` preserved the audit name).

### Task 12: Commit 2 — `slack_dm` migration

**Files:**
- Stage: `src/ipc/handlers/slack.ts`, `src/ipc/handlers/slack.test.ts`, `src/ipc/handlers/index.ts`, `src/ipc.ts`, `src/ipc.test.ts`

- [ ] **Step 1: Verify only the intended files are modified**

```bash
rtk git status
```

Expected: 5 files in the modified list (plus the unrelated pre-existing modified files carried through from earlier batches — those are NOT staged for this commit).

- [ ] **Step 2: Stage the five files explicitly**

```bash
rtk git add src/ipc/handlers/slack.ts src/ipc/handlers/slack.test.ts src/ipc/handlers/index.ts src/ipc.ts src/ipc.test.ts
```

- [ ] **Step 3: Commit**

```bash
rtk git commit -m "$(cat <<'EOF'
refactor(ipc): migrate slack_dm to IpcHandler registry (Batch 2F.1)

Lifts handleSlackDmIpc out of src/ipc.ts into src/ipc/handlers/slack.ts
where slackDmReadHandler already lives. Uses actionTypeOverride to
preserve the legacy send_slack_dm audit name (9 live trust.yaml files
+ container-side MCP tool description). Opts into the new postHocNotify
contract from commit 1 — fires Telegram notify after the result file
is written when bridge succeeded and trust gate said notify.

Non-agent callers fall through to gateAndStages NON_AGENT_DECISION
(autonomous, no notify) + fireNotifyIfRequested internal agentName
guard. This matches the imessageSendHandler pattern (verified at
imessage.ts:184-202) and preserves legacy bridge-fires-no-audit-no-
notify behavior exactly.

logger.info inside execute renamed from slack_dm IPC handled to
slack_dm bridge call complete and now includes bridgeStatus. The new
log fires inside execute, BEFORE the dispatcher writes the result file
and before postHocNotify, so it has a narrower semantic. Operators
grepping the legacy message must update their alerts.

Tests (19 new in slack.test.ts): parse / authorize / execute unit
shape with literal notifySummary 120-char-slice pin; wire-format result
file must be slack_results/ (NOT slack_dm_results/); requestId rejection
for non-agent AND agent (synthetic audit row for agent path per Batch
4 contract); fetch + json throws caught and produce failure files; agent
+ notify trust + 200 produces file + audit row + sendMessage once with
send_slack_dm in text; agent + autonomous + 200 is silent; agent + ask
stages without executing.

Deletes the C13 describe block at ipc.test.ts:3646-3746 (4 tests + 1
import that called the now-deleted handleSlackDmIpc directly) and adds
a comment pointing readers to the new test locations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify the commit landed**

```bash
rtk git log -2 --oneline
```

Expected: Top two lines begin `refactor(ipc): migrate slack_dm to IpcHandler registry (Batch 2F.1)` and `refactor(ipc): add postHocNotify to IpcAuthorization (Batch 2F.1 prep)`.

---

## Commit 3 — Prettier style pass (conditional)

### Task 13: Run prettier on the new files; commit only if diff

**Files:**
- Maybe-modify: `src/ipc/handler.ts`, `src/ipc/handler-post-hoc-notify.test.ts`, `src/ipc/handlers/slack.ts`, `src/ipc/handlers/slack.test.ts`

- [ ] **Step 1: Run prettier --write on the changed files**

```bash
rtk npx prettier --write src/ipc/handler.ts src/ipc/handler-post-hoc-notify.test.ts src/ipc/handlers/slack.ts src/ipc/handlers/slack.test.ts
```

- [ ] **Step 2: Check if anything actually changed**

```bash
rtk git status
```

Expected outcomes:
- **No diff:** prettier matched our hand-formatted output. Skip Step 3 + Step 4; this batch is done at two commits.
- **Diff present:** Continue to Step 3.

- [ ] **Step 3 (conditional): Re-run the test suite** to confirm formatting did not break anything.

```bash
bun run test -- src/ipc/
```

Expected: PASS.

- [ ] **Step 4 (conditional): Commit the formatting diff**

```bash
rtk git add src/ipc/handler.ts src/ipc/handler-post-hoc-notify.test.ts src/ipc/handlers/slack.ts src/ipc/handlers/slack.test.ts
rtk git commit -m "$(cat <<'EOF'
style(ipc): apply prettier formatting to slack_dm cluster + postHocNotify test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Verify final commit log**

```bash
rtk git log -3 --oneline
```

Expected: Three commits if prettier diffed; two commits otherwise. The Batch 2F.1 sequence is complete.

---

## Acceptance verification (final gate)

Run after all commits land. Do NOT push to remote — that is a separate user-initiated action.

- [ ] **Step 1: Full test sweep**

```bash
bun run test
```

Expected: PASS. Compare against the pre-batch test count + 27 new tests (7 contract + 19 handler + 1 non-agent pin) − 4 deleted C13 tests = net +22. If the count differs significantly, investigate.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 4: trust.yaml preservation grep (spec AC #5)**

```bash
grep -rln "send_slack_dm" data/agents/*/trust.yaml | wc -l
```

Expected: 9. Must match the pre-batch baseline. If changed, `actionTypeOverride` did not preserve correctly — investigate before declaring done.

- [ ] **Step 5: Legacy code removal grep (spec AC #6 + #7 + #8)**

```bash
grep -nE "handleSlackDmIpc\b|handleSlackDmReadIpc\b" src/
grep -n "data.type === 'slack_dm'" src/ipc.ts
grep -n "handleSlackDmIpc" src/ipc.test.ts
```

Expected: All three return zero matches.

- [ ] **Step 6: Confirm new dispatcher path is wired (spec AC #6)**

```bash
grep -n "slackDmHandler" src/ipc/handlers/index.ts
```

Expected: 2 hits — import line + `registerIpcHandler(...)` call.

- [ ] **Step 7: Forward-compat grep (spec AC #9)**

```bash
grep -rn "success: true" src/ipc/handlers/ | grep -v ".test.ts"
```

Expected: Only `slackDmHandler` returns `{success: true}` from a path that has a real side effect. Eyeball that no other handler in this output combines `postHocNotify: true` with a `{success: true}` path that doesn't represent a real side effect.

```bash
grep -rn "postHocNotify: true" src/ipc/handlers/
```

Expected: 1 hit — only `slackDmHandler`.

---

## Self-review checklist (post-write)

Spec coverage:
- Spec § Change 1 → Tasks 1, 2, 4, 5 (interface + helper + dispatcher + contract doc). ✅
- Spec § Change 2 → Tasks 7, 8, 9 (handler + tests + register). ✅
- Spec § Change 3 → Task 10 (strip legacy). ✅
- Spec § Change 3b (R1 amendment, C13 delete) → Task 11. ✅
- Spec § Test plan Section A (tests 1-6 + 5a) → Task 3 covers all 7. ✅
- Spec § Test plan Section B (tests 6-21, 16b, 17b, 18b) → Task 7 covers all 19. ✅
- Spec § Acceptance criteria 1-10 → Acceptance verification section. ✅
- Spec § Commit sequence → Tasks 6, 12, 13. ✅
- Spec § Loud-deny for postHocNotify + skipGate → Task 4 Step 2 + Task 3 Test 6. ✅
- Spec § logger.info DIVERGENCE → Task 8 Step 2 (new message string), commit-2 message documents it. ✅
- Spec § Non-agent policy (match imessage_send) → Task 8 Step 2 (no agentName check) + Task 11 (delete + optionally pin non-agent path). ✅

Placeholder scan: None. All steps have complete code or exact commands.

Type consistency:
- `postHocNotify?: true` named identically in Tasks 1, 3, 4, 8, 9.
- `slackDmHandler` named identically in Tasks 7, 8, 9, 12.
- `resultsDirName: 'slack_results'` matches Tasks 7, 8 + spec.
- `actionTypeOverride: 'send_slack_dm'` matches Tasks 7, 8 + spec.
- `isSuccessPayload` named identically in Tasks 2 and 4.
- `slackNotify` is NOT introduced (legacy-only variable; new code uses `decision.notify` via `fireNotifyIfRequested`).

No gaps found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-ipc-batch-2f1-slack-dm-write.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit here because each task is small and independent within its commit, and the audit-row + notify ordering tests (Tasks 3 + 7) benefit from being checked by a reviewer who hasn't seen the implementation.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints. Faster end-to-end, no subagent context-switching cost, but you do not get the second-pair-of-eyes effect on the Rule 5 audit-row + postHocNotify ordering tests.

Which approach?
