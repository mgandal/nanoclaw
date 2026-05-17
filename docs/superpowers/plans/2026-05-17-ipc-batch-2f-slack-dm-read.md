# IPC Batch 2F (slack_dm_read + actionTypeOverride) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the `slack_dm_read` IPC action from the legacy if-ladder in `src/ipc.ts` into the typed `IpcHandler` registry, with a small contract widening (`actionTypeOverride`) that preserves the legacy audit `action_type` string (`read_slack_dm`) so 7 live `trust.yaml` policies and the container-side MCP tool description stay valid.

**Architecture:** Three commits. (1) Extend `IpcAuthorization` with optional `actionTypeOverride: string`. Dispatcher reads it once after `authorize`, passes the resolved value into `gateAndStage` and `fireNotifyIfRequested` instead of `handler.type`. The `outcome: 'denied_contract_violation'` audit row keeps using `handler.type` because that's about the handler, not the user action. (2) Add `src/ipc/handlers/slack.ts` with `slackDmReadHandler` using `actionTypeOverride: 'read_slack_dm'`, the `'slack_results'` legacy-prefix dir, and conditional `skipGate` for non-agent callers (matches imessage_read pattern). Strip the legacy branch + function from `src/ipc.ts`. (3) Prettier pass on the new files if the formatter yields a diff.

**Tech Stack:** TypeScript (strict mode), Vitest (testing — invoked via `bun run test`), bun:sqlite (DB-backed audit-row tests via `_initTestDatabase()`), `src/ipc/handler.ts` (dispatcher) + `src/ipc/trust-gate.ts` (gate helper).

**Spec:** `docs/superpowers/specs/2026-05-17-ipc-batch-2f-slack-dm-read-design.md` (commit `1738f6ce`). Read it before starting if you have not already — the Behavior-Preservation Matrix and Test Plan in the spec are the ground truth this plan implements step-by-step.

---

## File Structure

**Created (2 files):**
- `src/ipc/handlers/slack.ts` — `slackDmReadHandler` only. ~70 LOC. One handler per file is the cluster norm for single-handler clusters; future `slack_dm` (Batch 2F.1) joins this file.
- `src/ipc/handlers/slack.test.ts` — full unit + integration coverage. ~250 LOC.

**Modified (4 files):**
- `src/ipc/handler.ts` — `IpcAuthorization` interface (+1 field), `dispatchIpcAction` (+1 line to resolve override, replace 2 references). ~5 LOC delta.
- `src/ipc/handlers/index.ts` — import + register. ~2 LOC delta.
- `src/ipc.ts` — delete `handleSlackDmReadIpc` (lines 1205–1314), delete dispatcher branch (lines 970–980), update inline comment block (~951–957). ~115 LOC removed.
- `docs/context-engineering/ipc-handler-contract.md` — add `actionTypeOverride` paragraph to Rule 3 + add bullet to authoring checklist. ~10 LOC added.

**Pre-existing test extended (1 file, optional split):**
- Tests for the dispatcher contract widening can live in a new file `src/ipc/handler-action-type-override.test.ts` (recommended — keeps the override behavior surface small and grep-able) OR be appended to an existing handler dispatcher test. **This plan creates the new file** because the override is a contract feature, not a handler feature, and deserves its own test surface for future maintainers.

---

## Commit 1 — Contract widening: `actionTypeOverride`

### Task 1: Add `actionTypeOverride` field to `IpcAuthorization`

**Files:**
- Modify: `src/ipc/handler.ts:65-92` (interface definition)

- [ ] **Step 1: Read `src/ipc/handler.ts:65-92`** to see the existing `IpcAuthorization` interface and pattern-match the JSDoc style of `auditTarget`.

- [ ] **Step 2: Add `actionTypeOverride?: string` to the interface**

Use the `Edit` tool. Find this block (handler.ts:65-92):

```typescript
export interface IpcAuthorization {
  /** Default target identifier — used for both audit and notify when not split. */
  target: string;
  /** User-facing post-hoc notification text (e.g. "paused task X-123"). */
  notifySummary: string;
  /**
   * Forensic audit-log summary written to agent_actions.summary. Defaults to
   * `target` when omitted, matching the original switch-case convention where
   * the audit summary was the bare identifier.
   */
  auditSummary?: string;
  /**
   * Override for the audit-log target (agent_actions.target). Defaults to
   * `target` when omitted. Use this when the gate's audit row should reference
   * a different identifier than the user-facing notification (e.g.
   * schedule_task gates against the target group folder, but the post-hoc
   * notify references the newly-generated taskId).
   */
  auditTarget?: string;
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

Replace it with this block (adds `actionTypeOverride` after `auditTarget`):

```typescript
export interface IpcAuthorization {
  /** Default target identifier — used for both audit and notify when not split. */
  target: string;
  /** User-facing post-hoc notification text (e.g. "paused task X-123"). */
  notifySummary: string;
  /**
   * Forensic audit-log summary written to agent_actions.summary. Defaults to
   * `target` when omitted, matching the original switch-case convention where
   * the audit summary was the bare identifier.
   */
  auditSummary?: string;
  /**
   * Override for the audit-log target (agent_actions.target). Defaults to
   * `target` when omitted. Use this when the gate's audit row should reference
   * a different identifier than the user-facing notification (e.g.
   * schedule_task gates against the target group folder, but the post-hoc
   * notify references the newly-generated taskId).
   */
  auditTarget?: string;
  /**
   * Override for the action_type string written to agent_actions and looked
   * up in trust.yaml. Defaults to `handler.type` (the wire type). The
   * contract-violation audit row (handler.ts off-allowlist skipGate) keeps
   * using `handler.type` regardless — that row describes the handler, not
   * the user action.
   *
   * Use this when migrating a legacy handler whose audit action_type does
   * not match the wire type. Example: the legacy slack cluster used
   * verb_noun audit names (`read_slack_dm`, `send_slack_dm`) but the wire
   * types are noun_verb (`slack_dm_read`, `slack_dm`). Without this
   * override, the migration would silently invalidate every existing
   * trust.yaml policy keyed on the legacy name and break the agent-facing
   * MCP tool description that references the legacy name.
   *
   * NEW handlers should NOT use this — design the wire type and audit type
   * to match. The override exists only to bridge legacy mismatches.
   */
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

- [ ] **Step 3: Run typecheck** to confirm no consumers broke.

```bash
bun run typecheck
```

Expected: PASS (no errors). New field is optional; no existing handler needs to change.

### Task 2: Test that override propagates to the gate + notify (failing first)

**Files:**
- Create: `src/ipc/handler-action-type-override.test.ts`

- [ ] **Step 1: Write the failing test file**

Use the `Write` tool. Create the file with this content:

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
 * Dispatcher contract test for `actionTypeOverride`. Pins three invariants:
 *
 *   1. When a handler returns `actionTypeOverride: 'X'`, the
 *      `agent_actions.action_type` row is `'X'` (not `handler.type`).
 *   2. When a handler returns no override, the `agent_actions.action_type`
 *      row is `handler.type` (backward-compat — all prior batches).
 *   3. The contract-violation audit row (off-allowlist skipGate) keeps
 *      using `handler.type` regardless of override — that row describes
 *      the handler bug, not the user's action.
 */
describe('actionTypeOverride dispatcher behavior', () => {
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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-type-override-'));

    agentName = `test-override-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  it('writes audit row with actionTypeOverride when handler provides one', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  audit_x: autonomous\n',
    );

    const overrideHandler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_x',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-x',
        notifySummary: 'did x',
        payloadForStaging: { type: 'wire_x' },
        actionTypeOverride: 'audit_x',
      }),
      execute: () => undefined,
    };
    registerIpcHandler(overrideHandler);

    await dispatch({ type: 'wire_x' });

    const rows = getDb()
      .prepare(
        "SELECT action_type FROM agent_actions WHERE agent_name = ?",
      )
      .all(agentName) as { action_type: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('audit_x');
  });

  it('writes audit row with handler.type when no override (backward-compat)', async () => {
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  wire_y: autonomous\n',
    );

    const plainHandler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_y',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-y',
        notifySummary: 'did y',
        payloadForStaging: { type: 'wire_y' },
      }),
      execute: () => undefined,
    };
    registerIpcHandler(plainHandler);

    await dispatch({ type: 'wire_y' });

    const rows = getDb()
      .prepare("SELECT action_type FROM agent_actions WHERE agent_name = ?")
      .all(agentName) as { action_type: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('wire_y');
  });

  it('contract-violation audit row uses handler.type, not override (off-allowlist skipGate)', async () => {
    const violatingHandler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_z',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-z',
        notifySummary: 'did z',
        payloadForStaging: { type: 'wire_z' },
        actionTypeOverride: 'audit_z',
        skipGate: true,
      }),
      execute: () => undefined,
    };
    registerIpcHandler(violatingHandler);

    await dispatch({ type: 'wire_z' });

    const rows = getDb()
      .prepare(
        "SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?",
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('wire_z');
    expect(rows[0].outcome).toBe('denied_contract_violation');
  });
});
```

- [ ] **Step 2: Run the test file to verify all three fail**

```bash
bun run test -- src/ipc/handler-action-type-override.test.ts
```

Expected: All three tests FAIL with `expected 'wire_x' to be 'audit_x'` (test 1), `wire_z` audit row missing the override semantics expected check (test 3 still passes by accident if dispatcher already uses handler.type for contract-violation), and test 2 PASSES (no override → already uses handler.type today).

Note the actual failure modes. Test 2 may pass on current code (no behavior change for that path); tests 1 + 3 prove the dispatcher does/does-not honor the override.

### Task 3: Wire `actionTypeOverride` into the dispatcher

**Files:**
- Modify: `src/ipc/handler.ts:269-345` (dispatcher: gate call + notify call + contract-violation audit row)

- [ ] **Step 1: Read `src/ipc/handler.ts:240-345`** so you have the full dispatcher in your head.

- [ ] **Step 2: Compute `auditActionType` after `authorize`, before the contract-violation check**

Use the `Edit` tool. Find this block (currently around handler.ts:269-281):

```typescript
  const auditSummary = auth.auditSummary ?? auth.target;
  const auditTarget = auth.auditTarget ?? auth.target;

  const decision = wantsSkipGate
    ? null
    : gateAndStage({
        agentName: ctx.agentName,
        baseGroup: ctx.baseGroup,
        actionType: handler.type,
        summary: auditSummary,
        target: auditTarget,
        payloadForStaging: auth.payloadForStaging,
      });
```

Replace with:

```typescript
  const auditSummary = auth.auditSummary ?? auth.target;
  const auditTarget = auth.auditTarget ?? auth.target;
  const auditActionType = auth.actionTypeOverride ?? handler.type;

  const decision = wantsSkipGate
    ? null
    : gateAndStage({
        agentName: ctx.agentName,
        baseGroup: ctx.baseGroup,
        actionType: auditActionType,
        summary: auditSummary,
        target: auditTarget,
        payloadForStaging: auth.payloadForStaging,
      });
```

- [ ] **Step 3: Pass `auditActionType` to `fireNotifyIfRequested`**

Find this block (currently around handler.ts:329-342):

```typescript
  } else if (executed && decision !== null) {
    // Notify path (existing behaviour). decision is null only for skipGate
    // calls, which are read-only and on the allowlist — by construction they
    // never produce a notify, and skipping fireNotifyIfRequested here keeps
    // that invariant explicit.
    await fireNotifyIfRequested(decision, {
      agentName: ctx.agentName,
      actionType: handler.type,
      summary: auth.notifySummary,
      target: auth.target,
      registeredGroups: ctx.registeredGroups,
      deps: ctx.deps,
    });
  }
```

Replace with:

```typescript
  } else if (executed && decision !== null) {
    // Notify path (existing behaviour). decision is null only for skipGate
    // calls, which are read-only and on the allowlist — by construction they
    // never produce a notify, and skipping fireNotifyIfRequested here keeps
    // that invariant explicit.
    await fireNotifyIfRequested(decision, {
      agentName: ctx.agentName,
      actionType: auditActionType,
      summary: auth.notifySummary,
      target: auth.target,
      registeredGroups: ctx.registeredGroups,
      deps: ctx.deps,
    });
  }
```

- [ ] **Step 4: Verify the contract-violation audit row at handler.ts:243-256 still uses `handler.type`**

Read `src/ipc/handler.ts:243-265`. Confirm the `insertAgentAction` call inside the off-allowlist `wantsSkipGate` branch uses `action_type: handler.type`. **Do not change it.** The contract-violation row describes the handler bug, not the user action — keeping `handler.type` lets a reviewer grep for the actual handler.

- [ ] **Step 5: Run the three override tests to verify they pass**

```bash
bun run test -- src/ipc/handler-action-type-override.test.ts
```

Expected: All three tests PASS.

- [ ] **Step 6: Run the full handler-test sweep** to confirm no prior batch regressed.

```bash
bun run test -- src/ipc/
```

Expected: PASS for all `src/ipc/**/*.test.ts` files (handler-action-type-override, dashboard-query, kg-query, imessage, pageindex, tasks, deploy-mini-app). No new failures.

### Task 4: Update contract doc with `actionTypeOverride` paragraph

**Files:**
- Modify: `docs/context-engineering/ipc-handler-contract.md` (Rule 3 section + authoring checklist)

- [ ] **Step 1: Read the contract doc**, especially Rule 3 (lines ~98-115 of the existing doc).

- [ ] **Step 2: Add a paragraph after the existing Rule 3 dispatch-order list**

Use the `Edit` tool. Find the line:

```
   **Result write** (for `responseKind: 'result'`) — dispatcher writes the
   `{requestId}.json` file from the `result` field.
```

Add this paragraph immediately after (preserving any existing newline structure):

```
   The dispatcher passes `auth.actionTypeOverride ?? handler.type` to the
   gate and to the post-hoc notify. Use `actionTypeOverride` ONLY when
   bridging legacy verb_noun audit names whose wire type is noun_verb (the
   slack cluster's `read_slack_dm` / `send_slack_dm` is the canonical
   example — without the override, migration silently invalidates live
   `trust.yaml` policies and the container-side MCP tool descriptions
   that reference the legacy name). New handlers must design the wire and
   audit types to match — the override is a one-way bridge for existing
   mismatches, not a design escape hatch.
```

- [ ] **Step 3: Add a bullet to the authoring checklist**

Find the bullet "4. Write `authorize(input, ctx)`. Return `null` to deny silently..." in the "Authoring checklist" section.

Append this sub-bullet immediately under it:

```
   - Do not set `actionTypeOverride` for a brand-new handler. The override
     exists only to preserve legacy `trust.yaml` keys during migration.
     If you find yourself wanting it for a new action, rename the wire
     type to match instead.
```

- [ ] **Step 4: Verify no markdown linter complaints** (optional, but cheap).

```bash
# If a markdown linter is configured in the repo, run it. Otherwise skip.
ls /Users/mgandal/Agents/nanoclaw/.markdownlint* 2>/dev/null || echo "No markdownlint config — skipping"
```

### Task 5: Commit 1 — `actionTypeOverride` contract widening

**Files:**
- Stage: `src/ipc/handler.ts`, `src/ipc/handler-action-type-override.test.ts`, `docs/context-engineering/ipc-handler-contract.md`

- [ ] **Step 1: Stage the three files explicitly**

```bash
rtk git add src/ipc/handler.ts src/ipc/handler-action-type-override.test.ts docs/context-engineering/ipc-handler-contract.md
```

- [ ] **Step 2: Commit**

```bash
rtk git commit -m "$(cat <<'EOF'
refactor(ipc): add actionTypeOverride to IpcAuthorization (Batch 2F prep)

Lets a handler decouple its wire `type` from the action_type string
written to agent_actions and looked up in trust.yaml. Needed because the
legacy slack cluster uses verb_noun audit names (read_slack_dm,
send_slack_dm) while the wire types are noun_verb. Without this,
migrating slack_dm_read silently invalidates 7 live trust.yaml entries
and breaks the container-side MCP tool description.

Dispatcher resolves `auth.actionTypeOverride ?? handler.type` once after
authorize and passes it into gateAndStage + fireNotifyIfRequested. The
off-allowlist contract-violation audit row keeps using `handler.type`
because it describes the handler bug, not the user's action.

Three new tests pin: override propagates to gate, no-override defaults
to handler.type (backward-compat for all prior batches), and the
contract-violation row uses handler.type regardless of override.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify the commit landed**

```bash
rtk git log -1 --oneline
```

Expected: One line beginning `refactor(ipc): add actionTypeOverride to IpcAuthorization (Batch 2F prep)`.

---

## Commit 2 — Migrate `slack_dm_read`

### Task 6: Write the failing test file `slack.test.ts`

**Files:**
- Create: `src/ipc/handlers/slack.test.ts`

- [ ] **Step 1: Read `src/ipc/handlers/imessage.test.ts`** for the pattern reference (mock fetch, `mkdtempSync` dataDir, `dispatch()` helper, `readResult()` helper, audit-row SQL spy via `getDb()`).

- [ ] **Step 2: Write the test file**

Use the `Write` tool. Create `src/ipc/handlers/slack.test.ts` with:

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

import { _initTestDatabase, getDb, setRegisteredGroup } from '../../db.js';
import { DATA_DIR } from '../../config.js';
import { IpcDeps } from '../../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
} from '../handler.js';
import { slackDmReadHandler } from './slack.js';

/**
 * slack_dm_read handler tests. Migrated from the if-ladder arm at
 * src/ipc.ts:1205-1314. Pins:
 *  - parse / authorize / execute unit behavior
 *  - wire-format result-file path matches container hardcoded
 *    `slack_results/` (NOT default `slack_dm_read_results/`)
 *  - actionTypeOverride preserves audit action_type as `read_slack_dm`
 *  - throw-from-execute (network down, non-JSON response) covered by
 *    the dispatcher's catch
 *
 * fetch is stubbed at the global boundary — the goal here is the
 * dispatcher seam + wire format, not the Slack bridge integration.
 */
describe('slack_dm_read handler', () => {
  const SOURCE_GROUP = 'telegram_slacktest';

  let dataDir: string;
  let deps: IpcDeps;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(slackDmReadHandler);

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

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-handler-test-'));

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
    expect(slackDmReadHandler.parse(null)).toBeNull();
    expect(slackDmReadHandler.parse(undefined)).toBeNull();
    expect(slackDmReadHandler.parse(42)).toBeNull();
    expect(slackDmReadHandler.parse('str')).toBeNull();
  });

  it('parse extracts channel + limit and coerces wrong types to undefined', () => {
    expect(slackDmReadHandler.parse({ channel: 'D123', limit: 50 })).toEqual({
      channel: 'D123',
      limit: 50,
    });
    expect(slackDmReadHandler.parse({ channel: 42 })).toEqual({
      channel: undefined,
      limit: undefined,
    });
    expect(
      slackDmReadHandler.parse({ channel: 'D123', limit: 'fifty' }),
    ).toEqual({
      channel: 'D123',
      limit: undefined,
    });
  });

  // ---- Unit: authorize ----

  it('authorize sets skipGate for non-agent caller, with actionTypeOverride always present', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = slackDmReadHandler.authorize(
      { channel: 'D123', limit: undefined },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBe(true);
    expect(auth!.actionTypeOverride).toBe('read_slack_dm');
  });

  it('authorize omits skipGate for agent caller, override still set', () => {
    const ctx = buildContext(
      `${SOURCE_GROUP}--some-agent`,
      false,
      deps,
      dataDir,
    );
    const auth = slackDmReadHandler.authorize(
      { channel: 'D123', limit: undefined },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBeUndefined();
    expect(auth!.actionTypeOverride).toBe('read_slack_dm');
  });

  // ---- Unit: execute ----

  it('execute returns missing-channel failure when channel absent', async () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const result = await slackDmReadHandler.execute(
      { channel: undefined, limit: undefined },
      ctx,
    );
    expect(result).toEqual({
      executed: true,
      result: {
        success: false,
        message: 'Missing required parameter: channel',
      },
    });
  });

  it('execute returns success result with JSON-stringified messages on 200', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'm1', text: 'hi' }] }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmReadHandler.execute(
      { channel: 'D123', limit: undefined },
      ctx,
    );
    expect(out).toMatchObject({ executed: true });
    const payload = (out as { result: Record<string, unknown> }).result;
    expect(payload.success).toBe(true);
    // load-bearing: container poller reads .message
    expect(JSON.parse(payload.message as string)).toEqual([
      { id: 'm1', text: 'hi' },
    ]);
  });

  it('execute returns failure result on bridge 4xx with error field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'channel not found' }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmReadHandler.execute(
      { channel: 'D999', limit: undefined },
      ctx,
    );
    expect(out).toMatchObject({
      executed: true,
      result: { success: false, message: 'channel not found' },
    });
  });

  it('execute returns failure result on bridge 5xx without error field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await slackDmReadHandler.execute(
      { channel: 'D123', limit: undefined },
      ctx,
    );
    expect(out).toMatchObject({
      executed: true,
      result: { success: false, message: 'Bridge returned 500' },
    });
  });

  it('execute includes limit in fetch body when set, omits when undefined', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);

    await slackDmReadHandler.execute({ channel: 'D1', limit: 25 }, ctx);
    const bodyWith = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(bodyWith).toEqual({ channel: 'D1', limit: 25 });

    await slackDmReadHandler.execute(
      { channel: 'D1', limit: undefined },
      ctx,
    );
    const bodyWithout = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(bodyWithout).toEqual({ channel: 'D1' });
  });

  // ---- Integration: dispatcher writes result file at the legacy path ----

  it('dispatcher writes success result to slack_results/ (NOT slack_dm_read_results/)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'm1' }] }),
    });

    await dispatch({
      type: 'slack_dm_read',
      requestId: 'req-ok',
      channel: 'D123',
    });

    expect(readResult(SOURCE_GROUP, 'req-ok')).not.toBeNull();
    // Pin the legacy prefix-grouped dir — guards against a future
    // accidental drop of `resultsDirName: 'slack_results'`.
    expect(
      fs.existsSync(
        path.join(
          dataDir,
          'ipc',
          SOURCE_GROUP,
          'slack_dm_read_results',
          'req-ok.json',
        ),
      ),
    ).toBe(false);
  });

  it('dispatcher drops malformed requestId, no file written (Rule 2)', async () => {
    await dispatch({
      type: 'slack_dm_read',
      requestId: '../../etc/passwd',
      channel: 'D123',
    });
    expect(
      fs.existsSync(path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_results')),
    ).toBe(false);
  });

  it('dispatcher drops missing requestId, no file written (Rule 2)', async () => {
    await dispatch({
      type: 'slack_dm_read',
      channel: 'D123',
    });
    expect(
      fs.existsSync(path.join(dataDir, 'ipc', SOURCE_GROUP, 'slack_results')),
    ).toBe(false);
  });

  it('dispatcher catches fetch rejection (network down) and writes failure file', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await dispatch({
      type: 'slack_dm_read',
      requestId: 'req-net',
      channel: 'D123',
    });
    const result = readResult(SOURCE_GROUP, 'req-net');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('ECONNREFUSED');
  });

  it('dispatcher catches response.json() rejection (bridge returned non-JSON)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    });
    await dispatch({
      type: 'slack_dm_read',
      requestId: 'req-html',
      channel: 'D123',
    });
    const result = readResult(SOURCE_GROUP, 'req-html');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('Unexpected token');
  });

  // ---- Integration: audit-row pinning (THE Rule 5 test) ----

  it('agent caller produces audit row with action_type=read_slack_dm (NOT slack_dm_read)', async () => {
    const agentName = `test-slack-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  read_slack_dm: autonomous\n',
    );

    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ messages: [] }),
      });

      await dispatch(
        {
          type: 'slack_dm_read',
          requestId: 'req-audit',
          channel: 'D123',
        },
        `${SOURCE_GROUP}--${agentName}`,
      );

      const rows = getDb()
        .prepare(
          "SELECT action_type, summary, target, outcome FROM agent_actions WHERE agent_name = ?",
        )
        .all(agentName) as {
          action_type: string;
          summary: string;
          target: string;
          outcome: string;
        }[];

      expect(rows).toHaveLength(1);
      expect(rows[0].action_type).toBe('read_slack_dm');
      expect(rows[0].action_type).not.toBe('slack_dm_read');
      expect(rows[0].summary).toBe('Read DM channel: D123');
      expect(rows[0].target).toBe('D123');
      expect(rows[0].outcome).toBe('allowed');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('non-agent caller produces ZERO audit rows for both action_type strings', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
    });

    await dispatch({
      type: 'slack_dm_read',
      requestId: 'req-no-audit',
      channel: 'D123',
    });

    const rows = getDb()
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type IN ('read_slack_dm', 'slack_dm_read')",
      )
      .all();
    expect(rows).toHaveLength(0);
    expect(readResult(SOURCE_GROUP, 'req-no-audit')).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the test file to verify it fails because `slack.js` does not exist**

```bash
bun run test -- src/ipc/handlers/slack.test.ts
```

Expected: All tests FAIL with module-not-found error for `./slack.js`. This is the RED phase.

### Task 7: Write the `slackDmReadHandler`

**Files:**
- Create: `src/ipc/handlers/slack.ts`

- [ ] **Step 1: Write the handler**

Use the `Write` tool. Create `src/ipc/handlers/slack.ts` with:

```typescript
import { logger } from '../../logger.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

/**
 * slack_dm_read — migrated from src/ipc.ts:1205-1314 (handleSlackDmReadIpc)
 * at git HEAD prior to Batch 2F.
 *
 * Wire-format notes:
 *  - resultsDirName: 'slack_results' matches the container-side hardcoded
 *    path at container/agent-runner/src/ipc-mcp-stdio.ts:1597.
 *  - actionTypeOverride: 'read_slack_dm' preserves the legacy audit name
 *    referenced by 7 live trust.yaml policies (data/agents/{claire, simon,
 *    coo, einstein, marvin, vincent}/trust.yaml + comments in freud/steve/
 *    warren) AND by the agent-facing MCP tool description at
 *    ipc-mcp-stdio.ts:1603. Renaming would silently void all of them.
 *  - slack_dm_read is on SKIP_GATE_ALLOWLIST (handler.ts:27) — read-only.
 *    skipGate fires only for non-agent callers; agent callers still go
 *    through the gate so the audit row is written.
 *
 * The slack_dm write handler is deferred to Batch 2F.1 because it fires
 * a post-hoc Telegram notify *after* writing its result file — a hybrid
 * the IpcHandler contract does not yet express.
 */

interface SlackDmReadInput {
  channel: string | undefined;
  limit: number | undefined;
}

export const slackDmReadHandler: IpcHandler<SlackDmReadInput, ExecuteResult> = {
  type: 'slack_dm_read',
  responseKind: 'result',
  resultsDirName: 'slack_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      channel: typeof r.channel === 'string' ? r.channel : undefined,
      limit: typeof r.limit === 'number' ? r.limit : undefined,
    };
  },

  authorize(input, ctx) {
    return {
      target: input.channel || '',
      auditSummary: `Read DM channel: ${input.channel || 'unknown'}`,
      notifySummary: 'read slack dm',
      payloadForStaging: { type: 'slack_dm_read' },
      actionTypeOverride: 'read_slack_dm',
      ...(ctx.agentName === null ? { skipGate: true as const } : {}),
    };
  },

  async execute(input, ctx): Promise<ExecuteResult> {
    if (!input.channel) {
      return {
        executed: true,
        result: {
          success: false,
          message: 'Missing required parameter: channel',
        },
      };
    }

    const body: Record<string, unknown> = { channel: input.channel };
    if (input.limit) body.limit = input.limit;

    const response = await fetch('http://127.0.0.1:19876/slack/dm/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;

    logger.info(
      { sourceGroup: ctx.sourceGroup, channel: input.channel },
      'slack_dm_read IPC handled',
    );

    if (response.ok) {
      const messages = result.messages as unknown[];
      return {
        executed: true,
        result: {
          success: true,
          message: JSON.stringify(messages || [], null, 2),
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

- [ ] **Step 2: Run the test file to verify all tests pass**

```bash
bun run test -- src/ipc/handlers/slack.test.ts
```

Expected: All 15 tests in `slack_dm_read handler` PASS.

### Task 8: Register the handler

**Files:**
- Modify: `src/ipc/handlers/index.ts` (add import + register call)

- [ ] **Step 1: Read `src/ipc/handlers/index.ts`** so you have the current registration order.

- [ ] **Step 2: Add the import**

Use the `Edit` tool. Find this import block in `src/ipc/handlers/index.ts`:

```typescript
import { pageindexFetchHandler, pageindexIndexHandler } from './pageindex.js';
```

Add immediately after:

```typescript
import { slackDmReadHandler } from './slack.js';
```

- [ ] **Step 3: Add the registration call**

Find this line in the `registerBuiltinHandlers` function:

```typescript
  registerIpcHandler(pageindexIndexHandler);
```

Add immediately after:

```typescript
  registerIpcHandler(slackDmReadHandler);
```

- [ ] **Step 4: Run the index registration test** (or the full ipc test sweep) to confirm no duplicate-type error.

```bash
bun run test -- src/ipc/
```

Expected: PASS for all `src/ipc/**/*.test.ts`. The duplicate-handler check in `registerIpcHandler` will throw at import time if `slack_dm_read` was already registered elsewhere — if you see `Duplicate IPC handler registered: slack_dm_read`, you have a stale `_resetHandlersForTests` call ordering issue in one of the tests. Investigate before continuing.

### Task 9: Strip the legacy dispatcher branch + function from `src/ipc.ts`

**Files:**
- Modify: `src/ipc.ts:970-980` (delete dispatcher branch)
- Modify: `src/ipc.ts:1205-1314` (delete `handleSlackDmReadIpc` function)
- Modify: `src/ipc.ts:951-957` (update inline comment block)

- [ ] **Step 1: Read `src/ipc.ts:945-985`** so you can see the inline comment block + dispatcher branch in context.

- [ ] **Step 2: Update the inline comment block at lines 945-957**

Use the `Edit` tool. Find this block:

```typescript
      // deploy_mini_app migrated to src/ipc/handlers/deploy-mini-app.ts.
      // dashboard_query migrated to src/ipc/handlers/dashboard-query.ts —
      // both dispatched via the IpcHandler registry above (dispatchIpcAction).
      // pageindex_* migrated to src/ipc/handlers/pageindex.ts — dispatched
      // via the IpcHandler registry above. The per-call mount resolution
      // lives in pageindex.ts:resolveMountsForGroup (execute-time).
      // kg_query migrated to src/ipc/handlers/kg-query.ts — dispatched via
      // the IpcHandler registry above (dispatchIpcAction).
      // task_add / task_list / task_close / task_reopen migrated to
      // src/ipc/handlers/tasks.ts — dispatched via the IpcHandler registry
      // above (dispatchIpcAction).
      // imessage_* migrated to src/ipc/handlers/imessage.ts — dispatched
      // via the IpcHandler registry above (dispatchIpcAction).
```

Append a new comment line immediately after the imessage line:

```typescript
      // slack_dm_read migrated to src/ipc/handlers/slack.ts — dispatched
      // via the IpcHandler registry above (dispatchIpcAction). slack_dm
      // remains in the if-ladder below pending Batch 2F.1 (contract
      // widening for post-hoc-notify-after-result hybrids).
```

- [ ] **Step 3: Delete the `slack_dm_read` dispatcher branch**

Use the `Edit` tool. Find this block (currently around `src/ipc.ts:970-980`):

```typescript
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'slack_dm_read'
      ) {
        handled = await handleSlackDmReadIpc(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
        );
      }
```

Delete it entirely (replace with empty string in Edit's `new_string`).

- [ ] **Step 4: Delete the `handleSlackDmReadIpc` function**

Use the `Edit` tool. Find the entire function block starting at `async function handleSlackDmReadIpc(` (currently around `src/ipc.ts:1205`) and ending at the closing `}` of the function (currently around `src/ipc.ts:1314` — verify by reading the file).

Delete the entire function definition. Be careful to not delete `handleSlackDmIpc` (which precedes it and stays for Batch 2F.1) or `handleSaveSkillIpc` (which follows it).

- [ ] **Step 5: Run typecheck** to confirm no dead references.

```bash
bun run typecheck
```

Expected: PASS. If you see `Cannot find name 'handleSlackDmReadIpc'`, you missed a call site — grep for it and remove.

- [ ] **Step 6: Run the full test suite** to confirm no regressions across the codebase.

```bash
bun run test
```

Expected: PASS. All ~2274 tests green (baseline from prior batches per memory; verify actual baseline matches by reading the test summary line).

- [ ] **Step 7: Manually verify `slack_dm` still works through the if-ladder**

This is a smoke check, not a test — confirms the half-migrated cluster is still operable.

```bash
grep -n "handleSlackDmIpc\b" src/ipc.ts
```

Expected: Two matches — the call site at `src/ipc.ts:~963` AND the function definition (currently around line 1082). If only one match appears, you accidentally deleted the function.

- [ ] **Step 8: Verify trust.yaml entries still resolve to the legacy name**

```bash
grep -rn "read_slack_dm" data/agents/*/trust.yaml
```

Expected: Same 7 lines as before the migration (claire, simon, coo, einstein, marvin, vincent active; freud/steve/warren comments). If the count changed, something went wrong.

### Task 10: Commit 2 — `slack_dm_read` migration

**Files:**
- Stage: `src/ipc/handlers/slack.ts`, `src/ipc/handlers/slack.test.ts`, `src/ipc/handlers/index.ts`, `src/ipc.ts`

- [ ] **Step 1: Stage the four files explicitly**

```bash
rtk git add src/ipc/handlers/slack.ts src/ipc/handlers/slack.test.ts src/ipc/handlers/index.ts src/ipc.ts
```

- [ ] **Step 2: Commit**

```bash
rtk git commit -m "$(cat <<'EOF'
refactor(ipc): migrate slack_dm_read to IpcHandler registry (Batch 2F/N)

Lifts handleSlackDmReadIpc out of src/ipc.ts into
src/ipc/handlers/slack.ts. Uses actionTypeOverride: 'read_slack_dm' to
preserve the legacy audit string referenced by 7 live trust.yaml
policies and the agent-facing MCP tool description at
ipc-mcp-stdio.ts:1603.

resultsDirName: 'slack_results' matches the container hardcoded prefix
path. skipGate fires only for non-agent callers (slack_dm_read is on
SKIP_GATE_ALLOWLIST at handler.ts:27); agent callers go through the
gate so the audit row is still written.

Tests pin: parse / authorize / execute unit shape; wire-format path
must be slack_results/ (NOT slack_dm_read_results/); requestId rejection
(Rule 2); throw-from-execute caught by dispatcher (network down +
non-JSON response); audit row uses action_type=read_slack_dm (Rule 5
preservation); zero audit rows for non-agent callers.

slack_dm (write sibling) deferred to Batch 2F.1 pending contract
widening for post-hoc-notify-after-result hybrids.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify the commit landed**

```bash
rtk git log -2 --oneline
```

Expected: Top two lines beginning `refactor(ipc): migrate slack_dm_read ...` and `refactor(ipc): add actionTypeOverride ...`.

---

## Commit 3 — Prettier style pass (conditional)

### Task 11: Run prettier on the new files; commit only if diff

**Files:**
- Maybe-modify: `src/ipc/handlers/slack.ts`, `src/ipc/handlers/slack.test.ts`, `src/ipc/handler-action-type-override.test.ts`, `src/ipc/handler.ts`

- [ ] **Step 1: Run prettier --write on the new + modified files**

```bash
rtk npx prettier --write src/ipc/handlers/slack.ts src/ipc/handlers/slack.test.ts src/ipc/handler-action-type-override.test.ts src/ipc/handler.ts
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
rtk git add src/ipc/handlers/slack.ts src/ipc/handlers/slack.test.ts src/ipc/handler-action-type-override.test.ts src/ipc/handler.ts
rtk git commit -m "$(cat <<'EOF'
style(ipc): apply prettier formatting to slack cluster + override test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Verify final commit log**

```bash
rtk git log -3 --oneline
```

Expected: Three commits if prettier diffed; two commits otherwise. The Batch 2F sequence is complete.

---

## Acceptance verification (final gate)

Run after all commits land. Do NOT push to remote — that is a separate user-initiated action.

- [ ] **Step 1: Full test sweep**

```bash
bun run test
```

Expected: PASS (~2274 tests, exact count may vary). Compare against the test count from prior batch commits — should be higher by ~18 (16 new slack tests + 3 new override tests minus any test reorg).

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

- [ ] **Step 4: trust.yaml preservation grep**

```bash
grep -rln "read_slack_dm" data/agents/ | wc -l
```

Expected: 9 (6 active actions/policy lines + 3 comment references). Number must match the pre-batch baseline. If it changed, the migration silently broke a policy entry — investigate before declaring done.

- [ ] **Step 5: Half-migrated cluster smoke check**

```bash
grep -nE "handleSlackDmIpc\b|data\.type === 'slack_dm'" src/ipc.ts
```

Expected: 2 hits — the call site `handled = await handleSlackDmIpc(...)` and the function definition. If either is gone, you over-deleted.

- [ ] **Step 6: Confirm new dispatcher path is wired**

```bash
grep -n "slackDmReadHandler" src/ipc/handlers/index.ts
```

Expected: 2 hits — the import line and the `registerIpcHandler(...)` call.

---

## Self-review checklist (post-write)

This was run during plan-writing. Findings:

**Spec coverage:**
- Spec § Architecture Change 1 → Tasks 1, 3, 4 (interface + dispatcher + doc). ✅
- Spec § Architecture Change 2 → Tasks 7, 8 (handler + register). ✅
- Spec § Architecture Change 3 → Task 9 (strip legacy). ✅
- Spec § Test plan unit tests 1–9 → Task 6 covers all 9. ✅
- Spec § Test plan integration tests 10–14 → Task 6 covers all 5. ✅
- Spec § Test plan audit-row tests 15–16 → Task 6 covers both. ✅
- Spec § Test plan dispatcher contract tests 17–19 → Task 2 covers all 3. ✅
- Spec § Acceptance criteria 1–6 → Acceptance verification section. ✅
- Spec § Commit sequence → Tasks 5, 10, 11. ✅

**Placeholder scan:** None.

**Type consistency:**
- `actionTypeOverride?: string` named identically in Tasks 1, 2, 3, 7.
- `slackDmReadHandler` named identically in Tasks 6, 7, 8.
- `resultsDirName: 'slack_results'` matches Tasks 6, 7 + spec.
- `auditActionType` local variable named identically in Task 3 Step 2 + Step 3.

**Type / signature consistency:**
- Task 2's stub handlers use `IpcHandler<{ ok: boolean }, void>` (notify-kind, default responseKind). Backward-compat with the existing handler.ts signature. Tests do not need a `responseKind: 'result'` because they pin gate behavior, not the result-file path.
- Task 6 imports `slackDmReadHandler` from `./slack.js` (TS compiled output) — matches the `.js` extension pattern used in `imessage.test.ts:19`. Not `.ts`.

No gaps found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-ipc-batch-2f-slack-dm-read.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit here because each task is small and independent within its commit, and the audit-row tests (Tasks 2 + 6) benefit from being checked by a reviewer who hasn't seen the implementation.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints. Faster end-to-end, no subagent context-switching cost, but you do not get the second-pair-of-eyes effect on the Rule 5 audit-row pinning tests.

Which approach?
