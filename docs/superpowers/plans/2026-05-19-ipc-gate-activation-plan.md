# IPC Gate-Activation (skill_* Cluster) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate trust.yaml gating for `save_skill` + `crystallize_skill` (currently bypassed via `SKIP_GATE_ALLOWLIST`) AND wire `/pending`+`/approve` slash commands into the Telegram message loop. End-state: agent call to `save_skill` lands in `pending_actions` (status `pending`); user runs `/approve pa_xxx`; action replays end-to-end via the new `replayStagedAction` module and writes the real skill file.

**Architecture:** 7-phase batch. Phase 0a/0b/0c fix Batch 2G handler debt (real payload in `payloadForStaging`, drop `isMain` authorize block, write stage-path result file in `handler.ts`) — all gate-activation-neutral. Phase 1 populates trust.yaml entries via one-off TypeScript migration script. Phase 2 ships the `replayStagedAction` host module + tests. Phase 3 wires `/pending`+`/approve` parsing in `src/index.ts` + new test file (separate from `src/index.test.ts` to dodge global-mock conflict). Phase 4 is the single revertible policy flip: strip `skipGate: true` + remove from allowlist. Phase 5 runs 6-mutation matrix per D12.

**Tech Stack:** TypeScript strict, Vitest (invoked via `bun run test` — NOT `bun test`, that runs Bun's built-in runner against stale `dist/`), `bun:sqlite` (DB-backed tests via existing `_initTestDatabase()`), `yaml` lib for trust.yaml mutation, existing `getIpcHandler` + `buildContext` + `gateAndStage` + `handleApprovalCommand` (live infrastructure).

**Spec:** `docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md` (commit `57504055`, R1-amended; 14 findings absorbed).

---

## File Inventory (created/modified across all phases)

| Path | Phase | Action | Purpose |
|---|---|---|---|
| `src/ipc/handlers/skills.ts` | 0a, 0b, 4 | Modify | Phase 0a: real payloadForStaging fields; Phase 0b: drop `isMain` block; Phase 4: strip `skipGate: true` |
| `src/ipc/handlers/skills.test.ts` | 0a, 0b, 4 | Modify | Test changes paired with each phase that touches skills.ts |
| `src/ipc/handler.ts` | 0c, 4 | Modify | Phase 0c: write stage-path result file; Phase 4: remove from `SKIP_GATE_ALLOWLIST` |
| `src/ipc/handler-staged-result-file.test.ts` | 0c | Create | New test file pinning Phase 0c's stage-result-file behavior |
| `scripts/migrations/2026-05-19-add-crystallize-trust.ts` | 1 | Create | One-off migration script (idempotent, dry-run default) |
| `tests/migrations/add-crystallize-trust.test.ts` | 1 | Create | Idempotency + round-trip + malformed-yaml tests |
| `data/agents/{9 agents}/trust.yaml` | 1 | Modify (via script) | Add `crystallize_skill: draft` to each |
| `src/replay-staged-action.ts` | 2 | Create | Host-side replay executor |
| `src/replay-staged-action.test.ts` | 2 | Create | Unit tests for replay executor |
| `src/index.ts` | 3 | Modify | Add slash-command preprocessor (`/pending`, `/approve`) |
| `src/index-approval.test.ts` | 3 | Create | Integration tests for slash-command wiring (separate file to dodge `src/index.test.ts` global mock) |

---

## Phase 0a: Fix `payloadForStaging` Stubs

**Background:** `saveSkillHandler.authorize` and `crystallizeSkillHandler.authorize` currently return `{type: 'save_skill'}` / `{type: 'crystallize_skill'}` as `payloadForStaging`. This stub is what would land in `pending_actions.payload_json` if the gate ever fired. On `/approve` replay, `handler.execute(JSON.parse(payload_json), ctx)` would receive just `{type: 'save_skill'}` and reject with "Missing required parameters." This phase fixes the legacy debt BEFORE the gate activates, so the policy flip in Phase 4 ships a working approve-replay roundtrip.

**This phase is gate-activation-neutral**: the handlers still return `skipGate: true`, so `payloadForStaging` is never actually consulted today. The change becomes load-bearing only in Phase 4.

### Task 0a.1: Add T26.5 — save_skill payloadForStaging roundtrip pin (RED test, written first)

**Files:**
- Modify: `src/ipc/handlers/skills.test.ts` — append new test in the `save_skill handler` describe block

- [ ] **Step 1: Write the failing test**

Locate the existing `describe('save_skill handler', ...)` block in `src/ipc/handlers/skills.test.ts`. Just before the closing `});` of that describe block, add:

```typescript
it('T26.5 — payloadForStaging contains actual skillName + skillContent, not just {type}', () => {
  // Mutation-pin for M4 (revert payloadForStaging to {type:'save_skill'} stub).
  // This test verifies the Phase 0a fix: when the handler stages a real call,
  // the stored payload must be reconstructible into a working replay payload.
  const auth = saveSkillHandler.authorize(
    {
      skillName: 'my-test-skill',
      skillContent: '# Test\nBody',
    },
    {
      sourceGroup: 'telegram_claire',
      isMain: true,
      baseGroup: 'telegram_claire',
      agentName: 'claire',
      requestId: null,
      registeredGroups: {},
      deps: {} as any,
      dataDir: '/tmp/test',
    },
  );
  expect(auth).not.toBeNull();
  expect((auth as any).payloadForStaging).toEqual({
    type: 'save_skill',
    skillName: 'my-test-skill',
    skillContent: '# Test\nBody',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T26.5"`
Expected: FAIL with `Expected: { type: 'save_skill', skillName: 'my-test-skill', skillContent: '# Test\nBody' }` vs `Received: { type: 'save_skill' }`

- [ ] **Step 3: Apply the source fix**

In `src/ipc/handlers/skills.ts`, locate `saveSkillHandler.authorize` (around line 468–477). Change:

```typescript
  authorize(_input, ctx) {
    // Preserve legacy non-main block (ipc.ts:1013-1021).
    if (!ctx.isMain) return null;
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'save_skill' },
      skipGate: true,
    };
  },
```

to:

```typescript
  authorize(input, ctx) {
    // Preserve legacy non-main block (ipc.ts:1013-1021).
    // Phase 0a (gate-activation prep): payloadForStaging now contains the
    // actual skillName + skillContent so a future /approve replay receives
    // the full input. The {type} stub would have failed replay with
    // "Missing required parameters." See spec R3-C2.
    if (!ctx.isMain) return null;
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: {
        type: 'save_skill',
        skillName: input.skillName,
        skillContent: input.skillContent,
      },
      skipGate: true,
    };
  },
```

Note: `_input` → `input` (no longer unused).

- [ ] **Step 4: Run the test again, verify GREEN**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T26.5"`
Expected: PASS

- [ ] **Step 5: Run full skills.test.ts suite — no regressions**

Run: `bun run test src/ipc/handlers/skills.test.ts`
Expected: all tests pass (existing 59 + new 1 = 60)

- [ ] **Step 6: Commit (Task 0a.1 only; hold Phase 0a as a single 2-task batch — commit at end of 0a.2)**

Stage but don't commit yet. Task 0a.2 will land in the same commit.

```bash
git add src/ipc/handlers/skills.ts src/ipc/handlers/skills.test.ts
```

### Task 0a.2: Add T27.5 — crystallize_skill payloadForStaging roundtrip pin

**Files:**
- Modify: `src/ipc/handlers/skills.test.ts`
- Modify: `src/ipc/handlers/skills.ts`

- [ ] **Step 1: Write the failing test**

Locate the existing `describe('crystallize_skill handler', ...)` block. Add at the end:

```typescript
it('T27.5 — payloadForStaging contains actual agent/name/description/source_task/body/confidence, not just {type}', () => {
  // Mutation-pin for M4 (revert payloadForStaging to {type:'crystallize_skill'} stub).
  // Phase 0a fix — see T26.5 docblock.
  const auth = crystallizeSkillHandler.authorize(
    {
      agent: 'claire',
      name: 'my-pattern',
      description: 'a learned pattern',
      source_task: 'task-123',
      body: '# Pattern\nBody',
      confidence: 8,
      agentsRoot: undefined,
    },
    {
      sourceGroup: 'telegram_claire',
      isMain: true,
      baseGroup: 'telegram_claire',
      agentName: 'claire',
      requestId: null,
      registeredGroups: {},
      deps: {} as any,
      dataDir: '/tmp/test',
    },
  );
  expect(auth).not.toBeNull();
  expect((auth as any).payloadForStaging).toEqual({
    type: 'crystallize_skill',
    agent: 'claire',
    name: 'my-pattern',
    description: 'a learned pattern',
    source_task: 'task-123',
    body: '# Pattern\nBody',
    confidence: 8,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T27.5"`
Expected: FAIL — stored payload is only `{type: 'crystallize_skill'}`.

- [ ] **Step 3: Apply the source fix**

In `src/ipc/handlers/skills.ts`, locate `crystallizeSkillHandler.authorize` (around line 620–631). Change:

```typescript
  authorize(_input, ctx) {
    // Preserve legacy non-main block at ipc.ts:1028-1036 (R2 Critical 1 +
    // R1 Medium 1 — both reviewers verified the brainstorm's "no main
    // check" claim was wrong).
    if (!ctx.isMain) return null;
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'crystallize_skill' },
      skipGate: true,
    };
  },
```

to:

```typescript
  authorize(input, ctx) {
    // Preserve legacy non-main block at ipc.ts:1028-1036.
    // Phase 0a (gate-activation prep): payloadForStaging now contains the
    // actual fields a /approve replay needs. The {type} stub would have
    // failed replay validation. See spec R3-C2. agentsRoot is intentionally
    // omitted: it's a test-only seam (skills.ts:693-698 env-gates it on
    // VITEST/NODE_ENV=test) and must never round-trip through production
    // staging — that would let a compromised payload redirect writes.
    if (!ctx.isMain) return null;
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: {
        type: 'crystallize_skill',
        agent: input.agent,
        name: input.name,
        description: input.description,
        source_task: input.source_task,
        body: input.body,
        confidence: input.confidence,
      },
      skipGate: true,
    };
  },
```

- [ ] **Step 4: Run test to verify GREEN**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T27.5"`
Expected: PASS

- [ ] **Step 5: Run full skills.test.ts**

Run: `bun run test src/ipc/handlers/skills.test.ts`
Expected: 61 passed (59 existing + T26.5 + T27.5)

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: clean (no errors)

- [ ] **Step 7: Commit Phase 0a**

```bash
git add src/ipc/handlers/skills.ts src/ipc/handlers/skills.test.ts
git commit -m "$(cat <<'EOF'
fix(ipc): Phase 0a — payloadForStaging real input fields

Both saveSkillHandler.authorize and crystallizeSkillHandler.authorize
now return the actual input fields in payloadForStaging instead of just
{type: X} stubs. This is preparatory work for gate-activation in Phase
4: once skipGate is stripped and these calls actually stage to
pending_actions, the stored payload_json must reconstruct into a
working handler.execute call when /approve fires.

The agentsRoot field is intentionally omitted from
crystallize_skill payloadForStaging — it's an env-gated test seam
(skills.ts:693-698) and must never round-trip through production
staging.

Tests: +2 mutation pins (T26.5, T27.5). Reverting payloadForStaging to
the {type} stub makes both tests fail.

Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
Finding: R3-C2

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 0b: Drop `isMain` Authorize Block

**Background:** Both `saveSkillHandler.authorize` and `crystallizeSkillHandler.authorize` short-circuit with `return null` when `!ctx.isMain`. This makes non-main staging impossible — D6/EC7/T15 in the spec are dead code for these handlers. Drop the block so trust.yaml policy becomes the only restriction.

**Still gate-activation-neutral**: the handlers still return `skipGate: true`, so they still bypass the gate regardless of isMain. Non-main agents COULD have called save_skill before — they would get a `null` authorize → dispatcher would short-circuit at `handler.ts:404` (auth-null return). After this phase, non-main authorize succeeds but the call still bypasses via skipGate.

### Task 0b.1: Add non-main authorize test, then drop the isMain block (save_skill)

**Files:**
- Modify: `src/ipc/handlers/skills.test.ts`
- Modify: `src/ipc/handlers/skills.ts`

- [ ] **Step 1: Write the failing test**

In the `describe('save_skill handler', ...)` block, append:

```typescript
it('T-non-main-save — save_skill authorize succeeds for non-main groups (post-isMain-drop)', () => {
  const auth = saveSkillHandler.authorize(
    { skillName: 'x', skillContent: 'y' },
    {
      sourceGroup: 'telegram_lab-claw--einstein',
      isMain: false,
      baseGroup: 'telegram_lab-claw',
      agentName: 'einstein',
      requestId: null,
      registeredGroups: {},
      deps: {} as any,
      dataDir: '/tmp/test',
    },
  );
  expect(auth).not.toBeNull();
  expect((auth as any).target).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T-non-main-save"`
Expected: FAIL — `Expected: not null` / `Received: null` (current isMain block returns null).

- [ ] **Step 3: Drop the isMain block**

In `src/ipc/handlers/skills.ts`, in `saveSkillHandler.authorize`, remove:

```typescript
    // Preserve legacy non-main block (ipc.ts:1013-1021).
    // Phase 0a (gate-activation prep): ...
    if (!ctx.isMain) return null;
```

Replace the comment with:

```typescript
    // Phase 0b: non-main authorize block dropped — trust.yaml policy is now
    // the only restriction. Non-main agents can stage save_skill calls
    // (which will land in pending_actions once Phase 4 strips skipGate).
    // See spec R2-I2.
    // Phase 0a (gate-activation prep): payloadForStaging now contains the
    // actual skillName + skillContent so a future /approve replay receives
    // the full input. See spec R3-C2.
```

The function body becomes just the `return { ... }` block (no early-return).

- [ ] **Step 4: Run test to verify GREEN**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T-non-main-save"`
Expected: PASS

### Task 0b.2: Same for crystallize_skill

**Files:**
- Modify: `src/ipc/handlers/skills.test.ts`
- Modify: `src/ipc/handlers/skills.ts`

- [ ] **Step 1: Write the failing test**

In the `describe('crystallize_skill handler', ...)` block, append:

```typescript
it('T-non-main-crystallize — crystallize_skill authorize succeeds for non-main groups', () => {
  const auth = crystallizeSkillHandler.authorize(
    {
      agent: 'einstein',
      name: 'x',
      description: 'd',
      source_task: 's',
      body: 'b',
      confidence: 5,
      agentsRoot: undefined,
    },
    {
      sourceGroup: 'telegram_lab-claw--einstein',
      isMain: false,
      baseGroup: 'telegram_lab-claw',
      agentName: 'einstein',
      requestId: null,
      registeredGroups: {},
      deps: {} as any,
      dataDir: '/tmp/test',
    },
  );
  expect(auth).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T-non-main-crystallize"`
Expected: FAIL — returns null.

- [ ] **Step 3: Drop the isMain block**

In `src/ipc/handlers/skills.ts`, in `crystallizeSkillHandler.authorize`, remove:

```typescript
    // Preserve legacy non-main block at ipc.ts:1028-1036.
    // Phase 0a (gate-activation prep): ...
    if (!ctx.isMain) return null;
```

Replace with comment-only:

```typescript
    // Phase 0b: non-main authorize block dropped. See spec R2-I2 + R3-C2.
    // Phase 0a (gate-activation prep): payloadForStaging now contains the
    // actual fields a /approve replay needs. agentsRoot is intentionally
    // omitted: it's a test-only seam (skills.ts:693-698 env-gates it on
    // VITEST/NODE_ENV=test) and must never round-trip through production
    // staging — that would let a compromised payload redirect writes.
```

- [ ] **Step 4: Run test to verify GREEN**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T-non-main-crystallize"`
Expected: PASS

- [ ] **Step 5: Full skills suite + typecheck**

Run: `bun run test src/ipc/handlers/skills.test.ts && bun run typecheck`
Expected: 63 passed (61 + T-non-main-save + T-non-main-crystallize); typecheck clean.

- [ ] **Step 6: Commit Phase 0b**

```bash
git add src/ipc/handlers/skills.ts src/ipc/handlers/skills.test.ts
git commit -m "$(cat <<'EOF'
fix(ipc): Phase 0b — drop isMain authorize block in skill_* handlers

Both saveSkillHandler.authorize and crystallizeSkillHandler.authorize
no longer short-circuit on !ctx.isMain. Trust.yaml policy is now the
only restriction. Non-main agents can stage these calls (which still
bypass via skipGate until Phase 4).

Without this change, D6/EC7/T15 in the spec would be dead code for
these handlers — non-main staging would never produce a row to approve.

Tests: +2 non-main authorize-succeeds pins. Reverting the if-block
makes them fail.

Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
Finding: R2-I2

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 0c: Stage-Path Result File in Dispatcher

**Background:** `src/ipc/handler.ts:421` returns `{handled: true}` when `decision !== null && !decision.allowed` (stage path). For `responseKind: 'result'` handlers, this means NO result file is written. The container poller waits for the file until `IPC_TIMEOUT_MS` (default 15s), then surfaces a timeout error to the agent. After Phase 4 the agent should see "staged for approval" immediately. Fix the dispatcher to write a stage-result file before returning.

### Task 0c.1: Create test pinning stage-result-file behavior

**Files:**
- Create: `src/ipc/handler-staged-result-file.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/ipc/handler-staged-result-file.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  _resetHandlersForTests,
  registerIpcHandler,
  dispatchIpcAction,
  buildContext,
} from './handler.js';
import {
  _initTestDatabase,
  insertRegisteredGroup,
} from '../db.js';

describe('Phase 0c — stage-path result file (R3-C3 amendment)', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    _resetHandlersForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-rf-test-'));
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    _initTestDatabase();
    // Register a fixture group so dispatchIpcAction's group-resolution passes.
    insertRegisteredGroup({
      jid: 'tg:test',
      folder: 'telegram_test--testagent',
      name: 'Test',
      requires_trigger: 0,
      permitted_senders: '[]',
      trigger: null,
      pinned_bot_id: null,
    });
    // Set up trust.yaml that will cause this dispatch to stage.
    const agentDir = path.join(dataDir, 'agents', 'testagent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      "actions:\n  staging_test: draft\n",
    );
  });

  it('T-staged-result-file — stage of result-kind handler writes {executed:false, staged:true, pendingId, message}', async () => {
    // Mutation pin for R3-C3 (handler.ts:421 returning without writing file).
    // Without this fix, the container poller would hang for IPC_TIMEOUT_MS.
    registerIpcHandler({
      type: 'staging_test',
      responseKind: 'result',
      resultsDirName: 'staging_test_results',
      parse: (raw) => raw as any,
      authorize: () => ({
        target: 'unit-test-target',
        notifySummary: '',
        payloadForStaging: { type: 'staging_test', echoField: 'hello' },
        // NOT setting skipGate — flow through gateAndStage.
      }),
      execute: async () => {
        throw new Error('execute() must NOT fire on stage path');
      },
    });

    const ctx = buildContext(
      'telegram_test--testagent',
      false,
      {
        registeredGroups: () => ({
          'telegram_test--testagent': {
            jid: 'tg:test',
            folder: 'telegram_test--testagent',
            name: 'Test',
            requires_trigger: false,
            permitted_senders: [],
            trigger: null,
            pinnedBotId: null,
          } as any,
        }),
      } as any,
      dataDir,
    );

    const requestId = 'req_test_123';
    const result = await dispatchIpcAction(
      { type: 'staging_test', requestId, echoField: 'hello' },
      ctx,
    );
    expect(result.handled).toBe(true);

    // Result file path matches dispatcher's writeResultFile pattern.
    const resultPath = path.join(
      dataDir,
      'ipc-results',
      'telegram_test--testagent',
      'staging_test_results',
      `${requestId}.json`,
    );
    expect(fs.existsSync(resultPath)).toBe(true);

    const payload = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(payload.executed).toBe(false);
    expect(payload.staged).toBe(true);
    expect(typeof payload.pendingId).toBe('string');
    expect(payload.pendingId).toMatch(/^pa_/);
    expect(payload.message).toContain('Staged for approval');
    expect(payload.message).toContain(payload.pendingId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/ipc/handler-staged-result-file.test.ts`
Expected: FAIL — `expect(fs.existsSync(resultPath)).toBe(true)` fails because handler.ts:421 returns before writing the file.

- [ ] **Step 3: Apply the dispatcher fix**

In `src/ipc/handler.ts`, locate line 421:

```typescript
  if (decision !== null && !decision.allowed) return { handled: true };
```

Replace with:

```typescript
  if (decision !== null && !decision.allowed) {
    // Phase 0c (R3-C3 amendment): write stage-result file for result-kind
    // handlers so the container poller doesn't hang IPC_TIMEOUT_MS waiting
    // on a file the old short-circuit never wrote. Notify-kind handlers
    // don't need this — they have no result-file contract.
    if (responseKind === 'result' && requestId !== null && decision.stage) {
      const resultsDirName = handler.resultsDirName ?? `${handler.type}_results`;
      writeResultFile(ctx.dataDir, ctx.sourceGroup, resultsDirName, requestId, {
        executed: false,
        staged: true,
        pendingId: decision.pendingId,
        message: `Staged for approval: ${decision.pendingId}`,
      });
    }
    return { handled: true };
  }
```

(Reuse the existing `writeResultFile` helper in the same file; reuse the existing `resultsDirName` derivation pattern already at line 466.)

- [ ] **Step 4: Run test to verify GREEN**

Run: `bun run test src/ipc/handler-staged-result-file.test.ts`
Expected: PASS

- [ ] **Step 5: Verify no regression in existing dispatcher tests**

Run: `bun run test src/ipc/`
Expected: all handler tests pass.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 7: Commit Phase 0c**

```bash
git add src/ipc/handler.ts src/ipc/handler-staged-result-file.test.ts
git commit -m "$(cat <<'EOF'
fix(ipc): Phase 0c — write stage-path result file for result-kind handlers

Dispatcher previously returned at handler.ts:421 without writing a
result file when decision.stage===true. For responseKind:'result'
handlers, this left the container poller waiting for the file until
IPC_TIMEOUT_MS — the agent saw a timeout instead of a "staged for
approval" reply.

Now writes {executed:false, staged:true, pendingId, message} to the
expected result file path before returning. Notify-kind handlers
unaffected (no result-file contract).

Tests: +1 pin (T-staged-result-file). Reverting the if-block makes
the test fail by timeout-via-missing-file.

Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
Finding: R3-C3

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 1: Migration Script + Trust.yaml Population

**Background:** Per D2, all 9 agents need `crystallize_skill: draft` in `trust.yaml`. Manual edits invite typos. Mechanical sed lacks idempotency + YAML safety. The script approach (D8) validates-all-before-write so partial state is impossible.

### Task 1.1: Write migration-script test fixture + idempotency test (RED)

**Files:**
- Create: `tests/migrations/add-crystallize-trust.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runMigration } from '../../scripts/migrations/2026-05-19-add-crystallize-trust.js';

describe('migration: add crystallize_skill: draft', () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-test-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupAgent(name: string, trustContent: string) {
    const dir = path.join(agentsDir, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'trust.yaml'), trustContent);
    return dir;
  }

  it('T28 — idempotency: running twice produces byte-identical output', async () => {
    // Mutation pin for M5 (whitespace mangling in migration).
    setupAgent(
      'agent1',
      "actions:\n  save_skill: draft\n  send_message: notify\n",
    );
    await runMigration({ agentsDir, apply: true });
    const after1 = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    await runMigration({ agentsDir, apply: true });
    const after2 = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    expect(after2).toBe(after1);
  });

  it('T28.5 — round-trip: loadAgentTrust returns crystallize_skill === "draft"', async () => {
    // Mutation pin for M5: whitespace-mangled value fails this.
    // Pure exact-string idempotency does NOT catch this — must validate
    // through the real loader.
    setupAgent('agent1', "actions:\n  save_skill: draft\n");
    await runMigration({ agentsDir, apply: true });

    const { loadAgentTrust } = await import('../../src/agent-registry.js');
    const trust = loadAgentTrust(path.join(agentsDir, 'agent1'));
    expect(trust).not.toBeNull();
    expect(trust!.actions.crystallize_skill).toBe('draft');
  });

  it('T29 — malformed YAML: rejects without writing any file', async () => {
    setupAgent('agent1', "actions:\n  save_skill: draft\n");
    setupAgent('agent2', "this is not: valid\n  yaml: at all\n  : :");
    setupAgent('agent3', "actions:\n  save_skill: draft\n");
    const beforeA1 = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    const beforeA3 = fs.readFileSync(
      path.join(agentsDir, 'agent3', 'trust.yaml'),
      'utf-8',
    );
    await expect(runMigration({ agentsDir, apply: true })).rejects.toThrow();
    expect(
      fs.readFileSync(path.join(agentsDir, 'agent1', 'trust.yaml'), 'utf-8'),
    ).toBe(beforeA1);
    expect(
      fs.readFileSync(path.join(agentsDir, 'agent3', 'trust.yaml'), 'utf-8'),
    ).toBe(beforeA3);
  });

  it('idempotent on already-migrated file (does not duplicate the key)', async () => {
    setupAgent(
      'agent1',
      "actions:\n  save_skill: draft\n  crystallize_skill: draft\n",
    );
    await runMigration({ agentsDir, apply: true });
    const content = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    const matches = content.match(/crystallize_skill:/g);
    expect(matches).toHaveLength(1);
  });

  it('dry-run (apply: false) does NOT write files', async () => {
    setupAgent('agent1', "actions:\n  save_skill: draft\n");
    const before = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    await runMigration({ agentsDir, apply: false });
    const after = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail with "cannot find module"**

Run: `bun run test tests/migrations/add-crystallize-trust.test.ts`
Expected: FAIL — cannot resolve `../../scripts/migrations/2026-05-19-add-crystallize-trust.js`

### Task 1.2: Write migration script (GREEN)

**Files:**
- Create: `scripts/migrations/2026-05-19-add-crystallize-trust.ts`

- [ ] **Step 1: Write the script**

```typescript
/**
 * One-off migration: add `crystallize_skill: draft` to every agent's
 * trust.yaml under data/agents/. Idempotent, validates-all-before-write,
 * dry-run-by-default.
 *
 * Usage:
 *   bun run scripts/migrations/2026-05-19-add-crystallize-trust.ts           # dry-run
 *   bun run scripts/migrations/2026-05-19-add-crystallize-trust.ts --apply   # write
 *
 * Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md (D8)
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export interface MigrationOpts {
  agentsDir: string;
  apply: boolean;
}

interface ParsedAgent {
  name: string;
  trustPath: string;
  doc: YAML.Document;
  needsWrite: boolean;
}

export async function runMigration(opts: MigrationOpts): Promise<{
  scanned: number;
  needsWrite: string[];
  alreadyDone: string[];
}> {
  const { agentsDir, apply } = opts;

  if (!fs.existsSync(agentsDir)) {
    throw new Error(`agentsDir does not exist: ${agentsDir}`);
  }

  // Phase 1 (validate-all): parse every trust.yaml. If any fails to parse,
  // throw without writing any. Spec D8 (validates parse before write).
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  const parsed: ParsedAgent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const trustPath = path.join(agentsDir, entry.name, 'trust.yaml');
    if (!fs.existsSync(trustPath)) continue;

    const raw = fs.readFileSync(trustPath, 'utf-8');
    const doc = YAML.parseDocument(raw);
    if (doc.errors.length > 0) {
      throw new Error(
        `Malformed YAML in ${trustPath}: ${doc.errors[0].message}`,
      );
    }
    const json = doc.toJS();
    if (
      typeof json !== 'object' ||
      json === null ||
      typeof json.actions !== 'object' ||
      json.actions === null
    ) {
      throw new Error(`${trustPath} missing top-level "actions:" map`);
    }
    const needsWrite = json.actions.crystallize_skill === undefined;
    parsed.push({ name: entry.name, trustPath, doc, needsWrite });
  }

  const needsWrite = parsed.filter((p) => p.needsWrite).map((p) => p.name);
  const alreadyDone = parsed.filter((p) => !p.needsWrite).map((p) => p.name);

  if (!apply) {
    // Dry-run report (no writes).
    return { scanned: parsed.length, needsWrite, alreadyDone };
  }

  // Phase 2 (write): all parses passed. Now mutate + serialize.
  for (const p of parsed) {
    if (!p.needsWrite) continue;
    // Mutate the YAML.Document so we preserve comments + formatting.
    // YAML.Document.set on actions inserts the new key at end of map.
    const actionsNode = p.doc.get('actions', true) as YAML.YAMLMap;
    actionsNode.set('crystallize_skill', 'draft');
    fs.writeFileSync(p.trustPath, p.doc.toString());
  }

  return { scanned: parsed.length, needsWrite, alreadyDone };
}

// CLI entrypoint
if (import.meta.main) {
  const apply = process.argv.includes('--apply');
  const agentsDir = path.resolve(process.cwd(), 'data', 'agents');
  runMigration({ agentsDir, apply }).then(
    (result) => {
      console.log(`Scanned: ${result.scanned} agent dirs`);
      console.log(`Already migrated (skipped): ${result.alreadyDone.join(', ') || '(none)'}`);
      console.log(`${apply ? 'Wrote' : 'Would write'}: ${result.needsWrite.join(', ') || '(none)'}`);
      if (!apply && result.needsWrite.length > 0) {
        console.log('\nDry-run only. Re-run with --apply to commit.');
      }
    },
    (err) => {
      console.error('Migration failed (no files written):', err.message);
      process.exit(1);
    },
  );
}
```

- [ ] **Step 2: Run tests, verify they pass**

Run: `bun run test tests/migrations/add-crystallize-trust.test.ts`
Expected: 5 tests pass.

- [ ] **Step 3: Dry-run the script against real data/agents/**

Run: `bun run scripts/migrations/2026-05-19-add-crystallize-trust.ts`
Expected output: `Scanned: 9 agent dirs ... Would write: claire, coo, einstein, freud, marvin, simon, steve, vincent, warren`

- [ ] **Step 4: Apply the migration**

Run: `bun run scripts/migrations/2026-05-19-add-crystallize-trust.ts --apply`
Expected: `Wrote: claire, coo, einstein, freud, marvin, simon, steve, vincent, warren`

- [ ] **Step 5: Sanity-check the diff**

Run: `git diff data/agents/`
Expected: 9 files each with one added line `  crystallize_skill: draft` (or yaml-equivalent formatting).

- [ ] **Step 6: Verify trust loads cleanly**

Run: `bun --bun -e "import('./src/agent-registry.js').then(m => console.log(m.loadAgentTrust('./data/agents/claire')))"`
Expected: object with `actions: { ..., save_skill: 'draft', crystallize_skill: 'draft', ... }`

- [ ] **Step 7: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 8: Commit Phase 1**

```bash
git add scripts/migrations/2026-05-19-add-crystallize-trust.ts tests/migrations/add-crystallize-trust.test.ts data/agents/
git commit -m "$(cat <<'EOF'
feat(trust): Phase 1 — migration script + crystallize_skill: draft entries

One-off TypeScript migration script adds `crystallize_skill: draft` to
all 9 agent trust.yaml files. Idempotent (skip if present),
validates-all-before-write (any parse error aborts without writing any
file), dry-run by default.

Trust.yaml entries are dormant until Phase 4 strips skipGate from the
crystallize_skill handler. Until then they sit alongside the existing
save_skill: draft entries.

Tests: 5 in tests/migrations/add-crystallize-trust.test.ts
- T28 idempotency (byte-identical second run)
- T28.5 round-trip through loadAgentTrust
- T29 malformed YAML rejection (no files written)
- duplicate-key prevention
- dry-run does not write

Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
Findings: D2, D8, R3-I7

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2: Replay Executor Module

**Background:** When `/approve pa_xxx` fires, `handleApprovalCommand` invokes a host-provided `execute` callback with `{action_type, payload, group_folder, agent_name}`. The callback needs to look up the right IPC handler and invoke its `execute()` directly, bypassing `gateAndStage`. This is the "approval IS authorization" semantic from D5.

Per R2-I1, the replay executor must NOT hand-roll a minimal `IpcHandlerContext`. It must call the existing `buildContext(group_folder, /*isMain=*/true, deps)` so the context is byte-identical to a normal dispatch (except no requestId — host-initiated, not IPC). This requires threading `deps` through the slash-command preprocessor in Phase 3, which we'll wire up there.

### Task 2.1: Replay executor — unit tests first

**Files:**
- Create: `src/replay-staged-action.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  _resetHandlersForTests,
  registerIpcHandler,
} from './ipc/handler.js';
import { _initTestDatabase } from './db.js';

describe('replayStagedAction', () => {
  let tmpDir: string;
  let deps: any;

  beforeEach(() => {
    _resetHandlersForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
    _initTestDatabase();
    deps = {
      registeredGroups: () => ({}),
      messageBus: { publish: vi.fn() },
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('T1 — replayStagedAction(save_skill payload) invoked directly returns formatted result string', async () => {
    const executeMock = vi.fn(async () => ({
      executed: true,
      result: { success: true, message: 'saved skill: foo' },
    }));
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: executeMock,
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    const result = await replayStagedAction({
      action_type: 'save_skill',
      payload: { type: 'save_skill', skillName: 'foo', skillContent: '#x' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('foo');
  });

  it('T2 — replayStagedAction(crystallize_skill payload) invoked directly returns formatted result', async () => {
    const executeMock = vi.fn(async () => ({
      executed: true,
      result: { success: true, message: 'crystallized: pattern-a' },
    }));
    registerIpcHandler({
      type: 'crystallize_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: executeMock,
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    const result = await replayStagedAction({
      action_type: 'crystallize_skill',
      payload: {
        type: 'crystallize_skill',
        agent: 'claire',
        name: 'pattern-a',
        description: 'd',
        source_task: 's',
        body: '# body',
        confidence: 7,
      },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('pattern-a');
  });

  it('T3 — unknown action_type throws "No handler registered for action_type: X"', async () => {
    const { replayStagedAction } = await import('./replay-staged-action.js');
    await expect(
      replayStagedAction({
        action_type: 'definitely_not_a_handler',
        payload: {},
        group_folder: 'telegram_claire',
        agent_name: 'claire',
        deps,
      }),
    ).rejects.toThrow(/No handler registered for action_type: definitely_not_a_handler/);
  });

  it('T5 — handler throw propagates', async () => {
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async () => {
        throw new Error('disk full');
      },
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    await expect(
      replayStagedAction({
        action_type: 'save_skill',
        payload: { skillName: 'x', skillContent: 'y' },
        group_folder: 'telegram_claire',
        agent_name: 'claire',
        deps,
      }),
    ).rejects.toThrow(/disk full/);
  });

  it('T6 — MUTATION PIN: replayStagedAction does NOT call checkTrustAndStage (D5 — approval is the authorization)', async () => {
    const trustEnforcement = await import('./trust-enforcement.js');
    const spy = vi.spyOn(trustEnforcement, 'checkTrustAndStage');

    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async () => ({ executed: true, result: { success: true, message: 'ok' } }),
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    await replayStagedAction({
      action_type: 'save_skill',
      payload: { skillName: 'x', skillContent: 'y' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('T10b — replayStagedAction calls buildContext with real deps, NOT a stubbed object', async () => {
    let capturedCtx: any = null;
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async (_input, ctx) => {
        capturedCtx = ctx;
        return { executed: true, result: { success: true, message: 'ok' } };
      },
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    await replayStagedAction({
      action_type: 'save_skill',
      payload: { skillName: 'x', skillContent: 'y' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.deps).toBe(deps);
    expect(capturedCtx.sourceGroup).toBe('telegram_claire');
    expect(capturedCtx.isMain).toBe(true);
    expect(capturedCtx.requestId).toBe(null);
  });

  it('T9 — handler returning {executed:false} surfaces as "execution bailed" message', async () => {
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async () => ({ executed: false }),
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    const result = await replayStagedAction({
      action_type: 'save_skill',
      payload: { skillName: 'x', skillContent: 'y' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(result).toContain('bailed');
  });

  it('T-result-falsy — handler returning {success:false, message} surfaces the message verbatim', async () => {
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async () => ({
        executed: true,
        result: { success: false, message: 'name already exists' },
      }),
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    const result = await replayStagedAction({
      action_type: 'save_skill',
      payload: { skillName: 'x', skillContent: 'y' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(result).toContain('name already exists');
  });
});
```

- [ ] **Step 2: Run, verify all fail with module-not-found**

Run: `bun run test src/replay-staged-action.test.ts`
Expected: FAIL — cannot resolve `./replay-staged-action.js`.

### Task 2.2: Implement replay-staged-action.ts (GREEN)

**Files:**
- Create: `src/replay-staged-action.ts`

- [ ] **Step 1: Write the module**

```typescript
/**
 * Host-side replay executor for /approve.
 *
 * Called by handleApprovalCommand (src/session-commands.ts) when the user
 * approves a pending_actions row. Looks up the matching IPC handler in
 * the registry, builds a real IpcHandlerContext via the canonical
 * buildContext (NOT a hand-rolled stub — see spec R2-I1), and invokes
 * handler.execute(payload, ctx) DIRECTLY.
 *
 * The replay deliberately bypasses gateAndStage: the user's approval IS
 * the authorization (spec D5). Re-running checkTrust on a `draft` row
 * would just re-stage it — infinite loop.
 *
 * Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
 */
import {
  buildContext,
  getIpcHandler,
  type IpcDeps,
} from './ipc/handler.js';
import { logger } from './logger.js';

export interface ReplayStagedActionInput {
  action_type: string;
  payload: unknown;
  group_folder: string;
  agent_name: string;
  deps: IpcDeps;
}

/**
 * Returns a short human-readable result string suitable for the Telegram
 * reply. Throws if the action_type has no registered handler or if the
 * handler itself throws.
 */
export async function replayStagedAction(
  input: ReplayStagedActionInput,
): Promise<string> {
  const { action_type, payload, group_folder, agent_name, deps } = input;

  const handler = getIpcHandler(action_type);
  if (!handler) {
    throw new Error(`No handler registered for action_type: ${action_type}`);
  }

  // Build a real IpcHandlerContext via the canonical constructor (R2-I1).
  // isMain=true: the user approving the action is the authority; the
  // original caller's isMain status is irrelevant on the replay path.
  // requestId=null: host-initiated, no IPC poller waiting.
  const ctx = buildContext(group_folder, true, deps);

  logger.info(
    {
      action_type,
      group_folder,
      agent_name,
      payloadKeys: Object.keys(payload as object).slice(0, 10),
    },
    'replayStagedAction: invoking handler.execute directly (gate bypassed per D5)',
  );

  // Parse the payload through the handler if the handler defines parse().
  // The stored payload_json was built from the same input the handler
  // originally parsed, so parse should be a no-op or recover the typed
  // shape. If parse returns null, the stored payload is malformed —
  // surface as a clear error rather than crash inside execute.
  const parsed = handler.parse ? handler.parse(payload) : payload;
  if (parsed === null) {
    throw new Error(
      `Handler ${action_type} rejected stored payload at parse() time`,
    );
  }

  const executeResult = await handler.execute(parsed as any, ctx as any);

  // Map executeResult into a single human-readable line.
  if (executeResult && typeof executeResult === 'object') {
    if ('executed' in executeResult && executeResult.executed === false) {
      return `execution bailed (action_type=${action_type})`;
    }
    if (
      'executed' in executeResult &&
      executeResult.executed === true &&
      'result' in executeResult
    ) {
      const result = (executeResult as any).result;
      if (result && typeof result === 'object' && 'message' in result) {
        return String(result.message).slice(0, 200);
      }
      if (result && typeof result === 'object' && 'success' in result) {
        return result.success ? 'ok' : 'failed';
      }
    }
  }
  return 'ok';
}
```

- [ ] **Step 2: Run tests, verify GREEN**

Run: `bun run test src/replay-staged-action.test.ts`
Expected: 8 tests pass.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: 0 errors (warnings OK).

- [ ] **Step 5: Commit Phase 2**

```bash
git add src/replay-staged-action.ts src/replay-staged-action.test.ts
git commit -m "$(cat <<'EOF'
feat(ipc): Phase 2 — replayStagedAction host module

New src/replay-staged-action.ts: host-side replay executor for the
/approve flow. Looks up the IPC handler via getIpcHandler, builds a
real IpcHandlerContext via the canonical buildContext (NOT a
hand-rolled stub), and invokes handler.execute(payload, ctx) directly.

The replay deliberately bypasses gateAndStage: the user's approval IS
the authorization (D5). Re-running checkTrust on a 'draft' row would
just re-stage it.

This module is currently unused; it will be wired into the slash-
command preprocessor in Phase 3 and exercised by /approve once Phase 4
flips the gate.

Tests: 8 in src/replay-staged-action.test.ts
- T1, T2 happy paths for save_skill + crystallize_skill (invoked DIRECTLY)
- T3 unknown action_type throws
- T5 handler throw propagates
- T6 mutation pin: does NOT call checkTrustAndStage
- T10b mutation pin: ctx.deps === passed deps (no stub)
- T9 {executed:false} surfaces "bailed"
- T-result-falsy: {success:false, message} surfaces message

Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
Findings: D5, R2-I1

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: Slash-Command Wiring

**Background:** `extractApprovalCommand` + `handleApprovalCommand` exist in `src/session-commands.ts` but are never called from `src/index.ts`. This phase wires them in alongside the existing `/new` preprocessor, threading `deps` into `replayStagedAction` so the gate-bypassed replay has a real `IpcHandlerContext`.

Per R3-C4, tests go into a NEW file `src/index-approval.test.ts` to avoid the global `extractSessionCommand: vi.fn(() => null)` mock at the top of `src/index.test.ts`.

### Task 3.1: Write index-approval.test.ts (RED)

**Files:**
- Create: `src/index-approval.test.ts`

This file uses a different mocking strategy than `src/index.test.ts`. It does NOT mock `session-commands.js` globally. Instead, each test stubs the DB layer + bot send and observes message handling end-to-end at the preprocessor level.

The actual integration test entrypoint depends on the structure of `src/index.ts`. The slash-command preprocessor we will add MUST be exposed as a named function (e.g. `handleApprovalSlashCommand`) so it's directly testable, then called inline in the message loop.

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { _initTestDatabase, insertPendingAction } from './db.js';

describe('src/index.ts approval slash-command wiring (Phase 3)', () => {
  let tmpDir: string;
  let sentMessages: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-app-test-'));
    sentMessages = [];
    _initTestDatabase();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function stubSendMessage(): (text: string) => Promise<void> {
    return async (text: string) => {
      sentMessages.push(text);
    };
  }

  it('T11 — /pending from main group lists all groups\' pending rows', async () => {
    insertPendingAction({
      id: 'pa_main_1',
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      action_type: 'save_skill',
      summary: 'skill-1',
      target: '',
      payload_json: '{}',
    });
    insertPendingAction({
      id: 'pa_lab_1',
      group_folder: 'telegram_lab-claw',
      agent_name: 'einstein',
      action_type: 'crystallize_skill',
      summary: 'pattern-1',
      target: '',
      payload_json: '{}',
    });

    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: '/pending',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });

    expect(replied).toBe(true);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('pa_main_1');
    expect(sentMessages[0]).toContain('pa_lab_1');
  });

  it('T12 — /pending from LAB-claw lists only LAB-claw rows', async () => {
    insertPendingAction({
      id: 'pa_main_1',
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      action_type: 'save_skill',
      summary: 's',
      target: '',
      payload_json: '{}',
    });
    insertPendingAction({
      id: 'pa_lab_1',
      group_folder: 'telegram_lab-claw',
      agent_name: 'einstein',
      action_type: 'crystallize_skill',
      summary: 'p',
      target: '',
      payload_json: '{}',
    });

    const { handleApprovalSlashCommand } = await import('./index.js');
    await handleApprovalSlashCommand({
      text: '/pending',
      sourceGroupFolder: 'telegram_lab-claw',
      isMainGroup: false,
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });

    expect(sentMessages[0]).toContain('pa_lab_1');
    expect(sentMessages[0]).not.toContain('pa_main_1');
  });

  it('T13 — /pending empty queue replies "No pending actions."', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    await handleApprovalSlashCommand({
      text: '/pending',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(sentMessages[0]).toBe('No pending actions.');
  });

  it('T17 — /approve with no id replies usage hint', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: '/approve',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(replied).toBe(true);
    expect(sentMessages[0]).toContain('Usage');
    expect(sentMessages[0]).toContain('/approve');
  });

  it('T18 — /approve with whitespace args replies usage hint', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: '/approve pa abc def',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(replied).toBe(true);
    expect(sentMessages[0]).toContain('Usage');
  });

  it('T22 — /approve this is a great idea is NOT a command (natural language)', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: '/approve this is a great idea',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    // Strict regex fails for multi-word arg → usage hint (D10).
    expect(replied).toBe(true);
    expect(sentMessages[0]).toContain('Usage');
  });

  it('T-noncmd — random text returns false (let agent handle)', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: 'hello what is the weather',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(replied).toBe(false);
    expect(sentMessages.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails with no `handleApprovalSlashCommand` export**

Run: `bun run test src/index-approval.test.ts`
Expected: FAIL — `handleApprovalSlashCommand is not a function` or export-not-found.

### Task 3.2: Wire handleApprovalSlashCommand into src/index.ts (GREEN)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the function definition**

In `src/index.ts`, add the new function near the top-level helpers (after the imports, before `main`). Locate the existing import block around line 116 (which already imports from `./session-commands.js`) and ADD `extractApprovalCommand, handleApprovalCommand` to the imports.

Current import (around line 116):
```typescript
import {
  handleSessionCommand,
  // … existing imports
} from './session-commands.js';
```

Change to (add the two new imports):
```typescript
import {
  handleSessionCommand,
  extractApprovalCommand,
  handleApprovalCommand,
  // … existing imports
} from './session-commands.js';
```

Then add the new helper function (place it near other top-level helpers, before `main()`):

```typescript
/**
 * Phase 3 (gate-activation): preprocess incoming Telegram messages for
 * /pending and /approve <id> commands BEFORE the agent handoff. Returns
 * true if the message was consumed as a command (the caller should
 * advance the cursor and skip the rest of the message-loop pipeline).
 *
 * Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md (D4)
 */
export async function handleApprovalSlashCommand(opts: {
  text: string;
  sourceGroupFolder: string;
  isMainGroup: boolean;
  deps: IpcDeps;
  sendMessage: (text: string) => Promise<void>;
}): Promise<boolean> {
  const { text, sourceGroupFolder, isMainGroup, deps, sendMessage } = opts;
  const trimmed = text.trim();

  // D10: prefix match (/approve or /pending at start) — if it does not look
  // like an approval command at all, fall through (let agent handle text).
  if (!/^\/(approve|pending)(\s|$)/.test(trimmed)) {
    return false;
  }

  const cmd = extractApprovalCommand(trimmed);
  if (cmd === null) {
    // Prefix matched but argument shape did NOT — usage hint.
    if (/^\/approve(\s|$)/.test(trimmed)) {
      await sendMessage(
        'Usage: /approve <id> (no spaces in id). Use /pending to list.',
      );
      return true;
    }
    // /pending with garbage args is still treated as /pending — pass through.
    // (Unreachable: extractApprovalCommand handles bare /pending; if it
    // returned null on /pending we have a bug worth surfacing.)
    return false;
  }

  const { replayStagedAction } = await import('./replay-staged-action.js');
  const db = await import('./db.js');
  const replyText = await handleApprovalCommand({
    command: cmd,
    sourceGroupFolder,
    isMainGroup,
    db: {
      getPendingAction: db.getPendingAction,
      listPendingActions: db.listPendingActions,
      updatePendingActionStatus: db.updatePendingActionStatus,
    },
    execute: (action) =>
      replayStagedAction({
        action_type: action.action_type,
        payload: action.payload,
        group_folder: action.group_folder,
        agent_name: action.agent_name,
        deps,
      }),
  });

  await sendMessage(replyText);
  return true;
}
```

- [ ] **Step 2: Run tests, verify GREEN**

Run: `bun run test src/index-approval.test.ts`
Expected: 7 tests pass.

- [ ] **Step 3: Wire into the live message loop**

In `src/index.ts`, find the section near line 395 (the `/new` check). Insert the approval-slash check BEFORE the `/new` check (precedence: a literal `/approve pa_xxx` should not be interpreted as `/new`). Actually no — verify the design choice: spec T22b says `/new` takes precedence (the trimmed-equals check at line 399 only matches if the message is EXACTLY `/new`, so `/new /approve pa_xxx` would fall through to `/approve` parsing). So the approval check goes AFTER the `/new` block. Add:

```typescript
  // --- /approve and /pending (Phase 3) ---
  // After /new so that `/new /approve foo` lands on /new (which uses an
  // exact-equals check and does NOT match the compound). Spec T22b.
  for (const m of missedMessages) {
    const text = m.content.trim().replace(groupTriggerPattern, '').trim();
    const isApprovalAllowed = isMainGroup || m.is_from_me === true;
    if (!isApprovalAllowed) continue;
    if (!/^\/(approve|pending)(\s|$)/.test(text)) continue;

    const handled = await handleApprovalSlashCommand({
      text,
      sourceGroupFolder: group.folder,
      isMainGroup,
      deps: ipcDeps,
      sendMessage: async (reply) => {
        const formatted = formatOutbound(reply, channel.name as ChannelType);
        if (formatted) await channel.sendMessage(chatJid, formatted);
      },
    });
    if (handled) {
      lastAgentSeq[chatJid] = m.seq;
      saveState();
      return true;
    }
  }
```

Note: `ipcDeps` is the existing `IpcDeps` instance — locate where it's constructed in `src/index.ts` (search for `IpcDeps` or where `runAgent` is wired) and reuse it. If it's not currently in scope at this line, hoist its construction earlier in `main()` so it's visible.

- [ ] **Step 4: Run full test suite (no regressions)**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (0 errors).

- [ ] **Step 6: Commit Phase 3**

```bash
git add src/index.ts src/index-approval.test.ts
git commit -m "$(cat <<'EOF'
feat(ipc): Phase 3 — wire /approve and /pending into Telegram message loop

src/session-commands.ts has had extractApprovalCommand and
handleApprovalCommand for a while but they were never wired into the
live message loop. This commit adds handleApprovalSlashCommand to
src/index.ts and invokes it from the message preprocessor BEFORE the
agent handoff, alongside the existing /new check.

Order: /personas → /new → /approve+/pending → /remote-control →
session-command intercept → trigger check → agent dispatch. /new takes
precedence over /approve because /new uses an exact-equals check and
the compound `/new /approve foo` is not equal to `/new`.

Tests in new src/index-approval.test.ts (R3-C4 amendment: separate
file to avoid src/index.test.ts global mock of extractSessionCommand):
- T11/T12/T13: /pending scoping (main vs non-main, empty queue)
- T17/T18: /approve malformed args → usage hint
- T22: /approve with multi-word args → not a command (D10)
- T-noncmd: random text → false (let agent handle)

Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
Findings: D4, D10, R3-C4

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: The Policy Flip

**Background:** All preparation is done. Phase 4 strips `skipGate: true` from both handlers' `authorize()` returns AND removes `save_skill` + `crystallize_skill` from `SKIP_GATE_ALLOWLIST`. This is the single revertible commit that takes the policy live.

### Task 4.1: Add tests pinning the post-flip behavior (RED)

**Files:**
- Modify: `src/ipc/handlers/skills.test.ts`

- [ ] **Step 1: Add T23 (membership update), T-allowlist-exact, T26+T27 rewrites**

Locate the existing `describe('SKIP_GATE_ALLOWLIST membership', ...)` or similar block (skills.test.ts has membership assertions around line 1564). Replace the existing membership assertion for `save_skill` + `crystallize_skill` with NOT-in assertions, and add the exact-list pin:

```typescript
// REPLACE existing membership assertion (was: expect(SKIP_GATE_ALLOWLIST.has('save_skill')).toBe(true) etc.)
it('T23 — save_skill and crystallize_skill are NOT in SKIP_GATE_ALLOWLIST (post-Phase-4)', () => {
  // After Phase 4, both handlers flow through gateAndStage.
  expect(SKIP_GATE_ALLOWLIST.has('save_skill')).toBe(false);
  expect(SKIP_GATE_ALLOWLIST.has('crystallize_skill')).toBe(false);
});

it('T-allowlist-exact — exact membership pin (R3-I4)', () => {
  // Single regression sentinel for the WHOLE allowlist. If any entry is
  // added, removed, or renamed without updating this list, the test
  // breaks loudly. Sorted-array compare so ordering changes do not break.
  const expected = [
    'dashboard_query',
    'imessage_list_contacts',
    'imessage_read',
    'imessage_search',
    'kg_query',
    'knowledge_search',
    'pageindex_fetch',
    'pageindex_index',
    'schedule_wakeup',
    'skill_invoked',
    'skill_search',
    'slack_dm_read',
    'task_add',
    'task_close',
    'task_list',
    'task_reopen',
  ].sort();
  expect([...SKIP_GATE_ALLOWLIST].sort()).toEqual(expected);
});
```

Then add T26 (REWRITTEN — compound-source + real on-disk trust.yaml):

```typescript
it('T26 — stage save_skill end-to-end with REAL on-disk trust.yaml (R3-C5)', async () => {
  // Mirror existing T11/T20 fixture pattern (skills.test.ts:875-917):
  // compound-source agentName + on-disk trust.yaml under DATA_DIR/agents/.
  const agentName = `t26-${Math.random().toString(36).slice(2, 8)}`;
  const sourceGroup = `telegram_test--${agentName}`;
  const agentDir = path.join(DATA_DIR, 'agents', agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'trust.yaml'),
    'actions:\n  save_skill: draft\n',
  );

  try {
    insertRegisteredGroup({
      jid: `tg:t26-${agentName}`,
      folder: sourceGroup,
      name: 'T26',
      requires_trigger: 0,
      permitted_senders: '[]',
      trigger: null,
      pinned_bot_id: null,
    });

    const ctx = buildContext(sourceGroup, false, deps);
    const requestId = `req_t26_${agentName}`;
    const result = await dispatchIpcAction(
      {
        type: 'save_skill',
        requestId,
        skillName: 't26-skill',
        skillContent: '# t26',
      },
      ctx,
    );

    expect(result.handled).toBe(true);

    // Stage row in DB.
    const pending = listPendingActions({ groupFolder: sourceGroup });
    expect(pending).toHaveLength(1);
    expect(pending[0].action_type).toBe('save_skill');

    // Skill file NOT written.
    const skillFile = path.join(
      process.cwd(),
      'container',
      'skills',
      't26-skill',
      'SKILL.md',
    );
    expect(fs.existsSync(skillFile)).toBe(false);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

it('T26.5 — pending_actions.payload_json contains actual skillName + skillContent (R3-C6)', async () => {
  // Load-bearing roundtrip pin. Mutation pin for M4.
  const agentName = `t26-5-${Math.random().toString(36).slice(2, 8)}`;
  const sourceGroup = `telegram_test--${agentName}`;
  const agentDir = path.join(DATA_DIR, 'agents', agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'trust.yaml'),
    'actions:\n  save_skill: draft\n',
  );

  try {
    insertRegisteredGroup({
      jid: `tg:t26-5-${agentName}`,
      folder: sourceGroup,
      name: 'T26.5',
      requires_trigger: 0,
      permitted_senders: '[]',
      trigger: null,
      pinned_bot_id: null,
    });

    const ctx = buildContext(sourceGroup, false, deps);
    await dispatchIpcAction(
      {
        type: 'save_skill',
        requestId: `req_t26_5_${agentName}`,
        skillName: 't26-5-skill',
        skillContent: '# real content',
      },
      ctx,
    );

    const pending = listPendingActions({ groupFolder: sourceGroup });
    expect(pending).toHaveLength(1);
    const payload = JSON.parse(pending[0].payload_json);
    expect(payload).toEqual({
      type: 'save_skill',
      skillName: 't26-5-skill',
      skillContent: '# real content',
    });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

it('T27 — stage crystallize_skill end-to-end with REAL on-disk trust.yaml (R3-C5)', async () => {
  const agentName = `t27-${Math.random().toString(36).slice(2, 8)}`;
  const sourceGroup = `telegram_test--${agentName}`;
  const agentDir = path.join(DATA_DIR, 'agents', agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'trust.yaml'),
    'actions:\n  crystallize_skill: draft\n',
  );

  try {
    insertRegisteredGroup({
      jid: `tg:t27-${agentName}`,
      folder: sourceGroup,
      name: 'T27',
      requires_trigger: 0,
      permitted_senders: '[]',
      trigger: null,
      pinned_bot_id: null,
    });

    const ctx = buildContext(sourceGroup, false, deps);
    const result = await dispatchIpcAction(
      {
        type: 'crystallize_skill',
        requestId: `req_t27_${agentName}`,
        agent: 'einstein',
        name: 't27-pattern',
        description: 'd',
        source_task: 's',
        body: '# body',
        confidence: 7,
      },
      ctx,
    );

    expect(result.handled).toBe(true);
    const pending = listPendingActions({ groupFolder: sourceGroup });
    expect(pending).toHaveLength(1);
    expect(pending[0].action_type).toBe('crystallize_skill');
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

it('T27.5 — pending_actions.payload_json contains all crystallize_skill fields (R3-C6)', async () => {
  const agentName = `t27-5-${Math.random().toString(36).slice(2, 8)}`;
  const sourceGroup = `telegram_test--${agentName}`;
  const agentDir = path.join(DATA_DIR, 'agents', agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'trust.yaml'),
    'actions:\n  crystallize_skill: draft\n',
  );

  try {
    insertRegisteredGroup({
      jid: `tg:t27-5-${agentName}`,
      folder: sourceGroup,
      name: 'T27.5',
      requires_trigger: 0,
      permitted_senders: '[]',
      trigger: null,
      pinned_bot_id: null,
    });

    const ctx = buildContext(sourceGroup, false, deps);
    await dispatchIpcAction(
      {
        type: 'crystallize_skill',
        requestId: `req_t27_5_${agentName}`,
        agent: 'einstein',
        name: 't27-5-pattern',
        description: 'desc',
        source_task: 'task-1',
        body: '# body',
        confidence: 7,
      },
      ctx,
    );

    const pending = listPendingActions({ groupFolder: sourceGroup });
    expect(pending).toHaveLength(1);
    const payload = JSON.parse(pending[0].payload_json);
    expect(payload).toEqual({
      type: 'crystallize_skill',
      agent: 'einstein',
      name: 't27-5-pattern',
      description: 'desc',
      source_task: 'task-1',
      body: '# body',
      confidence: 7,
    });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
```

You'll need to add `import { listPendingActions } from '../../db.js'` and any other missing imports at the top of the test file if not already present.

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T23|T-allowlist-exact|T26|T27"`
Expected: FAILs — `save_skill` still in allowlist; old membership assertion still passes (so T23 fails); T26/T27 expect a pending row but file is written via skipGate path.

### Task 4.2: Replace tautological T24/T25 with behavior assertions (RED)

**Files:**
- Modify: `src/ipc/handlers/skills.test.ts`

- [ ] **Step 1: Locate and REMOVE the existing tautological T24/T25**

Search `src/ipc/handlers/skills.test.ts` for tests asserting `skipGate` field shape on `authorize()`. Remove them entirely.

- [ ] **Step 2: Add the rewritten T24/T25 (R3-I3)**

```typescript
it('T24 — dispatch save_skill invokes gateAndStage (not skipGate)', async () => {
  // R3-I3 amendment: behavior assertion, not line-edit assertion.
  // Spy on loadAgentTrust to verify the gate path was taken.
  const agentRegistry = await import('../../agent-registry.js');
  const spy = vi.spyOn(agentRegistry, 'loadAgentTrust');

  const agentName = `t24-${Math.random().toString(36).slice(2, 8)}`;
  const sourceGroup = `telegram_test--${agentName}`;
  const agentDir = path.join(DATA_DIR, 'agents', agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'trust.yaml'),
    'actions:\n  save_skill: draft\n',
  );

  try {
    insertRegisteredGroup({
      jid: `tg:t24-${agentName}`,
      folder: sourceGroup,
      name: 'T24',
      requires_trigger: 0,
      permitted_senders: '[]',
      trigger: null,
      pinned_bot_id: null,
    });

    const ctx = buildContext(sourceGroup, false, deps);
    await dispatchIpcAction(
      {
        type: 'save_skill',
        requestId: `req_t24_${agentName}`,
        skillName: 'x',
        skillContent: 'y',
      },
      ctx,
    );

    // Gate path consults trust.yaml exactly once via loadAgentTrust.
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

it('T25 — dispatch crystallize_skill invokes gateAndStage (not skipGate)', async () => {
  // R3-I3 amendment: same pattern as T24.
  const agentRegistry = await import('../../agent-registry.js');
  const spy = vi.spyOn(agentRegistry, 'loadAgentTrust');

  const agentName = `t25-${Math.random().toString(36).slice(2, 8)}`;
  const sourceGroup = `telegram_test--${agentName}`;
  const agentDir = path.join(DATA_DIR, 'agents', agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'trust.yaml'),
    'actions:\n  crystallize_skill: draft\n',
  );

  try {
    insertRegisteredGroup({
      jid: `tg:t25-${agentName}`,
      folder: sourceGroup,
      name: 'T25',
      requires_trigger: 0,
      permitted_senders: '[]',
      trigger: null,
      pinned_bot_id: null,
    });

    const ctx = buildContext(sourceGroup, false, deps);
    await dispatchIpcAction(
      {
        type: 'crystallize_skill',
        requestId: `req_t25_${agentName}`,
        agent: 'einstein',
        name: 'x',
        description: 'd',
        source_task: 's',
        body: 'b',
        confidence: 5,
      },
      ctx,
    );

    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T24|T25"`
Expected: FAIL — `loadAgentTrust` not called because skipGate bypasses the gate path.

### Task 4.3: Strip skipGate + remove from allowlist (GREEN)

**Files:**
- Modify: `src/ipc/handlers/skills.ts`
- Modify: `src/ipc/handler.ts`

- [ ] **Step 1: Strip `skipGate: true` from saveSkillHandler.authorize**

In `src/ipc/handlers/skills.ts`, in `saveSkillHandler.authorize`, remove the `skipGate: true,` line. Update the comment to reflect Phase 4. Final shape:

```typescript
  authorize(input, ctx) {
    // Phase 0b: non-main authorize block dropped — trust.yaml policy is now
    // the only restriction. See spec R2-I2.
    // Phase 0a (gate-activation prep): payloadForStaging now contains the
    // actual skillName + skillContent so /approve replay receives the full
    // input. See spec R3-C2.
    // Phase 4: skipGate stripped. This handler now flows through
    // gateAndStage; trust.yaml's `save_skill: draft` causes the dispatch
    // to stage in pending_actions instead of executing.
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: {
        type: 'save_skill',
        skillName: input.skillName,
        skillContent: input.skillContent,
      },
    };
  },
```

- [ ] **Step 2: Strip `skipGate: true` from crystallizeSkillHandler.authorize**

In `src/ipc/handlers/skills.ts`, in `crystallizeSkillHandler.authorize`, remove the `skipGate: true,` line. Final shape:

```typescript
  authorize(input, ctx) {
    // Phase 0b: non-main authorize block dropped. See spec R2-I2 + R3-C2.
    // Phase 0a (gate-activation prep): payloadForStaging now contains the
    // actual fields a /approve replay needs.
    // Phase 4: skipGate stripped. This handler now flows through
    // gateAndStage.
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: {
        type: 'crystallize_skill',
        agent: input.agent,
        name: input.name,
        description: input.description,
        source_task: input.source_task,
        body: input.body,
        confidence: input.confidence,
      },
    };
  },
```

- [ ] **Step 3: Remove from SKIP_GATE_ALLOWLIST**

In `src/ipc/handler.ts`, locate the allowlist block. Remove these two lines:

```typescript
  'save_skill',
  'crystallize_skill',
```

Update the comment immediately above to reflect that the policy flip is done. Current comment:

```typescript
  // TODO: gate save_skill / crystallize_skill (currently preserve-bypass
  // per Batch 2G; trust.yaml has 9 dormant save_skill: draft entries on
  // claire/freud/simon/coo/einstein/steve/marvin/vincent/warren that this
  // gate-bypass keeps inactive).
  'save_skill',
  'crystallize_skill',
```

Replace with:

```typescript
  // save_skill and crystallize_skill removed from SKIP_GATE_ALLOWLIST as
  // of 2026-05-20 (Phase 4 of docs/superpowers/specs/2026-05-19-ipc-gate-
  // activation-design.md). They now flow through gateAndStage and honor
  // trust.yaml policy. The 9 agents have `save_skill: draft` and
  // `crystallize_skill: draft` entries; calls land in pending_actions
  // and require /approve.
```

- [ ] **Step 4: Run tests, verify GREEN**

Run: `bun run test src/ipc/handlers/skills.test.ts`
Expected: all skills tests pass (including new T23, T24, T25, T26, T26.5, T27, T27.5, T-allowlist-exact).

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: all pass. Some existing tests may need updates if they depended on the bypass behavior — locate, inspect, and fix in this same commit.

- [ ] **Step 6: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 7: Commit Phase 4**

```bash
git add src/ipc/handlers/skills.ts src/ipc/handler.ts src/ipc/handlers/skills.test.ts
git commit -m "$(cat <<'EOF'
feat(ipc): Phase 4 — gate-activation policy flip for skill_* cluster

Strip skipGate: true from saveSkillHandler.authorize and
crystallizeSkillHandler.authorize, and remove both action types from
SKIP_GATE_ALLOWLIST. As of this commit, both handlers flow through
gateAndStage and honor trust.yaml policy:

- save_skill: draft   (all 9 agents)   → stages in pending_actions
- crystallize_skill: draft (all 9)     → stages in pending_actions

User runs /approve pa_xxx (wired in Phase 3) to invoke the staged
action via replay-staged-action.ts (Phase 2). The dispatcher writes a
{executed:false, staged:true, ...} result file (Phase 0c) so the
in-container agent sees "staged for approval" instead of timing out.

Tests:
- T23 (UPDATED): allowlist membership is NOT-in for both
- T-allowlist-exact (NEW R3-I4): single regression sentinel for the
  whole SKIP_GATE_ALLOWLIST contents
- T24/T25 (REWRITTEN R3-I3): behavior assertions (gateAndStage was
  called) replace tautological "no skipGate field" assertions
- T26/T27 (REWRITTEN R3-C5): end-to-end stage with REAL on-disk
  trust.yaml + compound-source pattern
- T26.5/T27.5 (NEW R3-C6): pending_actions.payload_json roundtrip
  verifies all input fields land in stored payload

Rollback: revert this commit alone. Phase 0–3 stay (gate-activation-
neutral by construction). The replay module + slash-command wiring
become inert (no rows to approve once bypass restored).

Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
Phase 4 of the migration sequence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5: Mutation Testing

**Background:** Per D12 and R3-I6, the 6-mutation matrix must be exercised pre-merge. Each mutation: temporarily revert a load-bearing source line, run the matching test, confirm the test FAILS, restore the source. Any mutation that does NOT break its matching test indicates a tautological test that must be replaced.

### Task 5.1: Execute the 6-mutation matrix

- [ ] **Step 1: M1 — full trust-chain mutation**

Revert M1: in `src/ipc/handlers/skills.ts`, re-add `skipGate: true,` to `saveSkillHandler.authorize`. In `src/ipc/handler.ts`, re-add `'save_skill',` to `SKIP_GATE_ALLOWLIST`. In any new test trust.yaml fixture, change `save_skill: draft` to `save_skill: autonomous`.

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T26"`
Expected: FAIL — file IS written, NO pending row.

Restore the source (revert local edits).

- [ ] **Step 2: M2 — partial revert: skipGate stripped, allowlist not stripped**

Revert: in `src/ipc/handler.ts`, re-add `'save_skill',` to `SKIP_GATE_ALLOWLIST`. Leave `saveSkillHandler.authorize` stripped.

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T24"`
Expected: FAIL — handler falls through cleanly (no `denied_contract_violation` row), `loadAgentTrust` IS called. Actually re-think — if the allowlist still has save_skill but authorize doesn't request skipGate, the wantsSkipGate check at handler.ts (the dispatcher's wantsSkipGate variable) would not deny — let me verify by reading the source.

ACTUALLY: re-checking handler.ts source, `wantsSkipGate` is derived from `auth.skipGate`. If `auth.skipGate` is undefined and the type IS on the allowlist, the gate still runs (the allowlist only matters as an upper-bound: if `wantsSkipGate` is true AND type is NOT in allowlist, deny). So M2 produces: gate path runs normally, file stages, T24 PASSES.

This means M2 as proposed in R3 might not be load-bearing for T24. Re-investigate: would the partial-revert produce the wrong outcome? With skipGate stripped + allowlist entry kept: handler stages normally. Same as Phase 4 GREEN. So actually M2's mutation produces the CORRECT outcome — T24 passes. The "T24 must fail" claim in R3's matrix is wrong.

**Decision:** during plan execution, when M2 produces "T24 passes" instead of failing as R3 claimed, that's a finding — the controller must add a NEW test that DOES catch M2 (e.g., a test that asserts the inverse: allowlist contains EXACTLY these 16 entries, no more). T-allowlist-exact catches this — if allowlist still has save_skill, T-allowlist-exact fails. So mutation M2's matching test is T-allowlist-exact, not T24. Update the plan note before final commit.

Restore source.

- [ ] **Step 3: M3 — inverse partial revert: keep skipGate, remove from allowlist**

Revert: in `src/ipc/handlers/skills.ts`, re-add `skipGate: true` to `saveSkillHandler.authorize`. Leave `'save_skill'` REMOVED from allowlist.

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T-staged-result-file"` (or any test exercising save_skill via dispatch).

Expected: FAIL — at handler.ts:376 (`if (wantsSkipGate && !SKIP_GATE_ALLOWLIST.has(handler.type))`), the dispatcher writes a `denied_contract_violation` audit row and returns. Tests expecting a pending_actions stage row find none.

Restore source.

- [ ] **Step 4: M4 — payloadForStaging stub regression**

Revert: in `src/ipc/handlers/skills.ts`, change `saveSkillHandler.authorize` payloadForStaging back to `{ type: 'save_skill' }`.

Run: `bun run test src/ipc/handlers/skills.test.ts -t "T26.5"`
Expected: FAIL — `JSON.parse(payload_json)` no longer deep-equals the original input.

Restore source.

- [ ] **Step 5: M5 — migration whitespace mangling**

Revert: in `scripts/migrations/2026-05-19-add-crystallize-trust.ts`, change `actionsNode.set('crystallize_skill', 'draft');` to `actionsNode.set('crystallize_skill', 'draft ');` (trailing space).

Run: `bun run test tests/migrations/add-crystallize-trust.test.ts -t "T28.5"`
Expected: FAIL — `trust.actions.crystallize_skill` is `'draft '`, not `'draft'`.

Restore source.

- [ ] **Step 6: M6 — slash-command reorder**

Revert: in `src/index.ts`, move the `/approve+/pending` for-loop block to BEFORE the `/new` check.

This is the trickiest mutation because the precedence test was not added to the original plan. SKIP M6 unless time permits OR add a precedence test now:

In `src/index-approval.test.ts`, append:

```typescript
it('T22b — /new takes precedence over /approve (R3-H4 amendment)', async () => {
  // When a user sends `/new /approve pa_xxx`, the /new exact-equals check
  // SHOULD NOT match (the trimmed text is `/new /approve pa_xxx`, not just
  // `/new`), so it falls through. Then /approve strict regex SHOULD NOT
  // match (the arg has spaces in it). Both result in: text falls through
  // to agent dispatch. Document this explicitly.
  const { handleApprovalSlashCommand } = await import('./index.js');
  const replied = await handleApprovalSlashCommand({
    text: '/new /approve pa_xxx',
    sourceGroupFolder: 'telegram_claire',
    isMainGroup: true,
    deps: { registeredGroups: () => ({}) } as any,
    sendMessage: stubSendMessage(),
  });
  // /approve prefix matches but strict regex rejects "pa_xxx" preceded by garbage.
  expect(replied).toBe(true);
  expect(sentMessages[0]).toContain('Usage');
});
```

If T22b passes BEFORE M6 mutation, then the mutation requires re-ordering BOTH the handler call site AND the test fixture. SKIP M6 entirely as low-value; document the skip in the final report.

- [ ] **Step 7: Verify all source restored, run full suite once more**

Run: `git diff` (expect: empty — all mutations reverted)
Run: `bun run test`
Expected: all pass.

- [ ] **Step 8: Commit mutation-testing log (or just push if no source changes)**

If no source changes resulted from mutation testing (everything restored cleanly), just proceed to push. Optionally add a short note to `data/skill-catalog/healthcheck.md` documenting the pre-merge mutation-test pass.

---

## Final Verification + Push

- [ ] **Step 1: Full suite final pass**

Run: `bun run test 2>&1 | tail -10`
Expected: ALL TESTS PASS.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Lint (0 errors)**

Run: `bun run lint 2>&1 | tail -5`
Expected: 0 errors.

- [ ] **Step 4: Inspect the unpushed commits**

Run: `git log --oneline origin/main..HEAD`
Expected: 7-8 commits (Phase 0a, 0b, 0c, 1, 2, 3, 4, optionally mutation-test note).

- [ ] **Step 5: Holistic post-batch code review**

Invoke `superpowers:requesting-code-review` against the full batch range (BASE = commit before Phase 0a; HEAD = Phase 4 commit). Address any Critical/Important findings before push.

- [ ] **Step 6: Push to origin/main**

Run: `git push`
Expected: ok.

- [ ] **Step 7: Smoke test in production**

After push and restart, monitor `logs/nanoclaw.log` for the first `save_skill` or `crystallize_skill` IPC call from any agent. Expected log line: `outcome='staged', pendingId='pa_xxx'`. User can then test `/approve pa_xxx` end-to-end.

---

## Self-Review Notes

(Run by the plan-writer before finalizing.)

- **Spec coverage**: Verified each finding (C1-C6, I1-I8) maps to one or more tasks in Phase 0–4. Open items: M2 mutation has a flaw (R3's claim "T24 must fail" doesn't hold — corrected to "T-allowlist-exact catches it" in Phase 5 Step 2). M6 mutation requires test fixture beyond plan scope — documented as skip.
- **Placeholder scan**: No "TBD", "TODO", or vague language in step bodies. Code blocks present at every code step.
- **Type consistency**: `replayStagedAction` signature consistent across Phase 2 module + Phase 3 wiring (`{action_type, payload, group_folder, agent_name, deps}`). `IpcDeps` import path consistent (`./ipc/handler.js`).
- **Compound-source pattern**: T26/T27/T24/T25 all use the same `telegram_test--${agentName}` pattern matching skills.test.ts:875-917.
