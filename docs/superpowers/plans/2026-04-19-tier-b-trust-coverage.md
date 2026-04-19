# Tier B — Trust-Enforcement Coverage (C13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `checkTrust` enforcement from the two IPC actions that have it today (`send_message`, `send_slack_dm`) to every IPC action that produces a privileged side effect, so that `trust.yaml` policies are actually honored at runtime instead of silently ignored.

**Architecture:** Extract the inline trust-gate pattern from `ipc.ts:363-441` into a shared helper `checkTrustAndStage(...)` in `trust-enforcement.ts`. Retrofit 11 IPC actions to call it, each wiring up an `action_type` string, a `summary` for the audit log, a `payload` shape for pending-action rehydration, and handling the three outcome branches (allowed / staged / blocked). Add default trust levels for the new action types to every `trust.yaml` file so agents carry sane defaults rather than falling through to `ask`.

**Tech Stack:** TypeScript, Vitest, better-sqlite3 (via `db.ts`), existing `trust-enforcement.ts` primitives.

**Source:** Finding C13 in `docs/superpowers/specs/2026-04-18-hardening-audit-design.md`. Architecture observation #2 in the same doc prescribes doing this in one systematic pass.

---

## Context the executing engineer needs

### Why this matters

Today, `trust.yaml` files declare policies for actions that the runtime silently ignores. Example: `data/agents/claire/trust.yaml` has `publish_to_bus: autonomous`, `schedule_task: notify`, `write_agent_memory: autonomous`. The handlers for all three never call `checkTrust` — so whatever the operator wrote in trust.yaml is fiction. A compromised agent can exercise these privileged actions regardless of policy.

This plan closes the gap between the policy vocabulary and the enforcement runtime.

### The existing pattern (what to copy)

`src/ipc.ts:363-441` (`send_message` handler) is the reference implementation. It:

1. Extracts `{group, agent}` from the compound key via `parseCompoundKey`.
2. Only runs trust enforcement if `agentName` is non-null (main-group messages bypass trust).
3. Loads the agent's trust.yaml via `loadAgentTrust`.
4. Calls `checkTrust(agentName, groupFolder, actionType, trust)` — returns `{allowed, level, notify, stage}`.
5. Records the attempt in `agent_actions` via `insertAgentAction`.
6. On `!allowed && stage`: calls `insertPendingAction` with an action-specific payload, then breaks out of the handler.
7. On `!allowed && !stage`: logs and breaks.
8. On `allowed`: continues to the actual side effect. If `decision.notify` is true, the caller is responsible for firing the post-hoc notification (today only `send_message` does this).

`send_slack_dm` (`ipc.ts:1575-1604`) shows the shorter variant when staging isn't wired up.

### Trust levels (recap from `trust-enforcement.ts`)

| Level | `allowed` | `stage` | `notify` | Meaning |
|-------|-----------|---------|----------|---------|
| `autonomous` | true | false | false | Execute silently |
| `notify` | true | false | true | Execute, then post-hoc ping main |
| `draft` | false | true | false | Stage in `pending_actions` for `/approve` |
| `ask` | false | true | false | Same as draft (reserved for future distinction) |
| *unknown* | false | true | false | Fail-safe to `ask` with a warning log |
| *no trust.yaml* | true | false | false | Legacy bypass |

### The 11 ungated action types (C13 target list)

Per the spec:

1. `publish_to_bus` — agent-to-agent messaging bus.
2. `schedule_task` — creates recurring/one-off tasks; can execute `script` on host (main-only already enforced by A1).
3. `knowledge_publish` — writes to `data/agent-knowledge/`.
4. `write_agent_memory` — writes to agent's own `memory.md`.
5. `write_agent_state` — writes to agent's own state JSON.
6. `save_skill` — creates/updates skill files (A4 covers content validation separately).
7. `deploy_mini_app` — Vercel deploy.
8. `kg_query` — reads KG (low-privilege but cross-agent info leak; see C20).
9. `dashboard_query` — reads dashboard data (same category as kg_query).
10. `update_task` — mutates existing scheduled tasks (already has A1-gate script-path, needs trust too).
11. `pause_task` / `resume_task` / `cancel_task` — task lifecycle.

Note: `imessage_*` actions are main-only already (skipped here).

### Default trust-level suggestions

These go into every agent's `trust.yaml` as part of Task 14. Calibration rationale: **read-style actions autonomous, write-style notify, cross-agent or privileged write draft.**

| Action | Default level | Rationale |
|--------|--------------|-----------|
| `publish_to_bus` | `notify` | Cross-agent influence; user should see the traffic |
| `schedule_task` | `draft` | Creates future-executing code; high blast radius |
| `knowledge_publish` | `autonomous` | Append-only, scoped to own knowledge file |
| `write_agent_memory` | `autonomous` | Scoped to own memory |
| `write_agent_state` | `autonomous` | Scoped to own state |
| `save_skill` | `draft` | New code path surfaces in future sessions |
| `deploy_mini_app` | `draft` | External deploy; irreversible URL publish |
| `kg_query` | `autonomous` | Read-only |
| `dashboard_query` | `autonomous` | Read-only |
| `update_task` | `notify` | Mutates scheduled code |
| `pause_task` | `notify` | Cheap; reversible |
| `resume_task` | `notify` | Cheap; reversible |
| `cancel_task` | `notify` | Destructive but bounded |

Operators can override per-agent after initial rollout.

### Testing conventions in this codebase

- `vitest` via `bun --bun vitest run <path>`. Full suite hangs — **always target specific test files**.
- `src/trust-enforcement.test.ts` (100 lines) already covers `checkTrust` directly. Extend it for the new helper.
- `src/ipc.test.ts` (2662 lines) tests IPC dispatch end-to-end. Each new trust-gated action gets its own test covering (a) agent bypass for main group, (b) autonomous passes through, (c) notify passes through + side-effect recorded, (d) draft stages into `pending_actions`, (e) ask stages, (f) unknown level stages.
- Use `_initTestDatabase()` to get a clean SQLite in memory; helpers in `db.test.ts` and `ipc.test.ts` show the pattern.

### Don't do

- **Don't change the trust enforcement for `send_message` / `send_slack_dm`** — they're shipping; refactor *toward* the shared helper, not a rewrite.
- **Don't add `checkTrust` to read-only main-group paths** — main bypasses agent trust (no agentName in compound key). The guard is `if (agentName) { ... }` — preserve it.
- **Don't add `checkTrust` to `refresh_groups`, `register_group`** — these are infrastructure, not privileged side effects.
- **Don't introduce new trust levels or change the vocabulary** — C13 is coverage only.

---

## File Structure

```
src/
├── trust-enforcement.ts       # extend: new helper checkTrustAndStage
├── trust-enforcement.test.ts  # extend: test the new helper
├── ipc.ts                     # modify: retrofit 11 handlers
└── ipc.test.ts                # extend: ~3 tests per retrofitted action

data/agents/*/trust.yaml       # extend: add defaults for all 11 actions
```

No new files. All changes are extensions of existing files.

---

## Task 1: Extract `checkTrustAndStage` helper

**Files:**
- Modify: `src/trust-enforcement.ts` (add new exported function)
- Test: `src/trust-enforcement.test.ts` (add tests for helper)

The helper encapsulates: load trust → checkTrust → insertAgentAction → on-stage insertPendingAction. Callers stop caring about the wiring; they supply `{agentName, groupFolder, actionType, summary, payloadForStaging, target?}` and receive back `{allowed, level, notify, pendingId?}`.

- [ ] **Step 1: Write the failing test**

Append to `src/trust-enforcement.test.ts`:

```typescript
import { checkTrustAndStage } from './trust-enforcement.js';
import { _initTestDatabase, insertPendingAction as _ip } from './db.js';

describe('checkTrustAndStage', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns allowed=true and no pendingId when trust is null (legacy)', () => {
    const result = checkTrustAndStage({
      agentName: 'claire',
      groupFolder: 'telegram_claire',
      actionType: 'publish_to_bus',
      summary: 'test',
      payloadForStaging: { foo: 'bar' },
      trust: null,
    });
    expect(result).toEqual({
      allowed: true,
      level: 'autonomous',
      notify: false,
      pendingId: null,
    });
  });

  it('returns allowed=true, notify=true for notify level, no pendingId', () => {
    const result = checkTrustAndStage({
      agentName: 'claire',
      groupFolder: 'telegram_claire',
      actionType: 'publish_to_bus',
      summary: 'test',
      payloadForStaging: { foo: 'bar' },
      trust: { actions: { publish_to_bus: 'notify' } },
    });
    expect(result.allowed).toBe(true);
    expect(result.notify).toBe(true);
    expect(result.pendingId).toBeNull();
  });

  it('stages on draft, returns pendingId', () => {
    const result = checkTrustAndStage({
      agentName: 'claire',
      groupFolder: 'telegram_claire',
      actionType: 'publish_to_bus',
      summary: 'test',
      payloadForStaging: { foo: 'bar' },
      trust: { actions: { publish_to_bus: 'draft' } },
    });
    expect(result.allowed).toBe(false);
    expect(result.pendingId).toMatch(/^pa-\d+-[a-z0-9]+$/);
  });

  it('returns allowed=false with pendingId=null on unknown level (blocked + logged)', () => {
    const result = checkTrustAndStage({
      agentName: 'claire',
      groupFolder: 'telegram_claire',
      actionType: 'publish_to_bus',
      summary: 'test',
      payloadForStaging: { foo: 'bar' },
      trust: { actions: { publish_to_bus: 'nonsense' } },
    });
    // Unknown levels stage (fail-safe per checkTrust contract)
    expect(result.allowed).toBe(false);
    expect(result.pendingId).toMatch(/^pa-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/trust-enforcement.test.ts`
Expected: FAIL — `checkTrustAndStage is not a function`.

- [ ] **Step 3: Implement the helper**

Add to `src/trust-enforcement.ts` (after the `checkTrust` export):

```typescript
import { insertAgentAction, insertPendingAction } from './db.js';

export interface CheckTrustAndStageInput {
  agentName: string;
  groupFolder: string;
  actionType: string;
  summary: string;
  target?: string;
  payloadForStaging: Record<string, unknown>;
  trust: { actions: Record<string, string> } | null;
}

export interface CheckTrustAndStageResult {
  allowed: boolean;
  level: string;
  notify: boolean;
  /** Non-null only when the action was staged. */
  pendingId: string | null;
}

/**
 * Combines checkTrust + audit-log insert + (on stage) pending_actions insert.
 * Callers retrofit this into their IPC handlers instead of re-implementing
 * the pattern inline. Behaviour matches the send_message reference path.
 */
export function checkTrustAndStage(
  input: CheckTrustAndStageInput,
): CheckTrustAndStageResult {
  const decision = checkTrust(
    input.agentName,
    input.groupFolder,
    input.actionType,
    input.trust,
  );

  insertAgentAction({
    agent_name: input.agentName,
    group_folder: input.groupFolder,
    action_type: input.actionType,
    trust_level: decision.level,
    summary: input.summary.slice(0, 200),
    target: input.target,
    outcome: decision.allowed
      ? 'allowed'
      : decision.stage
        ? 'staged'
        : 'blocked',
  });

  let pendingId: string | null = null;
  if (!decision.allowed && decision.stage) {
    pendingId = insertPendingAction({
      agent_name: input.agentName,
      group_folder: input.groupFolder,
      action_type: input.actionType,
      summary: input.summary,
      payload: input.payloadForStaging,
    });
    logger.info(
      {
        pendingId,
        agentName: input.agentName,
        actionType: input.actionType,
        level: decision.level,
      },
      `Trust: ${input.actionType} staged for approval`,
    );
  } else if (!decision.allowed) {
    logger.info(
      {
        agentName: input.agentName,
        actionType: input.actionType,
        groupFolder: input.groupFolder,
        level: decision.level,
      },
      `Trust: ${input.actionType} blocked for agent`,
    );
  }

  return {
    allowed: decision.allowed,
    level: decision.level,
    notify: decision.notify,
    pendingId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run src/trust-enforcement.test.ts`
Expected: PASS — all 4 new tests green.

- [ ] **Step 5: Commit**

```bash
git add src/trust-enforcement.ts src/trust-enforcement.test.ts
git commit -m "feat(trust): extract checkTrustAndStage helper

Combines checkTrust + agent_actions audit log + pending_actions staging
into one call. Preparatory refactor for C13 — retrofitting all 11
ungated IPC actions in follow-up commits.

No behavioral change to send_message or send_slack_dm; they still
inline the pattern and will migrate later."
```

---

## Task 2: Retrofit `schedule_task` — proof-of-pattern

**Files:**
- Modify: `src/ipc.ts:707-831` (the `schedule_task` case)
- Test: `src/ipc.test.ts` (add scheduled-task trust cases near existing schedule_task tests)

This is the first real retrofit. `schedule_task` is the highest-impact single action in the ungated list — it creates future-executing code. The `script` field is already main-only (A1). This adds trust for the `prompt`-only path when invoked by an agent.

- [ ] **Step 1: Write the failing tests**

Append to `src/ipc.test.ts` (find an existing `describe('processIpcFile schedule_task', ...)` block or add one if absent):

```typescript
describe('processIpcFile schedule_task trust enforcement', () => {
  it('schedules autonomously when trust.yaml says autonomous', async () => {
    _initTestDatabase();
    writeAgentTrust('claire', { schedule_task: 'autonomous' });
    registerGroup('telegram_claire', 'tg:123', { isMain: false });

    await processIpcFile(makeScheduleIpc({
      sourceGroup: 'telegram_claire--claire',
      prompt: 'ping',
      schedule_type: 'interval',
      schedule_value: '60000',
      targetJid: 'tg:123',
    }));

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('ping');
    const staged = getAllPendingActions();
    expect(staged).toHaveLength(0);
  });

  it('stages for approval when trust.yaml says draft', async () => {
    _initTestDatabase();
    writeAgentTrust('claire', { schedule_task: 'draft' });
    registerGroup('telegram_claire', 'tg:123', { isMain: false });

    await processIpcFile(makeScheduleIpc({
      sourceGroup: 'telegram_claire--claire',
      prompt: 'ping',
      schedule_type: 'interval',
      schedule_value: '60000',
      targetJid: 'tg:123',
    }));

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(0);
    const staged = getAllPendingActions();
    expect(staged).toHaveLength(1);
    expect(staged[0].action_type).toBe('schedule_task');
    const payload = JSON.parse(staged[0].payload_json);
    expect(payload.prompt).toBe('ping');
    expect(payload.schedule_type).toBe('interval');
  });

  it('bypasses trust for main-group callers (no agentName)', async () => {
    _initTestDatabase();
    registerGroup('telegram_claire', 'tg:123', { isMain: true });

    await processIpcFile(makeScheduleIpc({
      sourceGroup: 'telegram_claire',
      prompt: 'ping',
      schedule_type: 'interval',
      schedule_value: '60000',
      targetJid: 'tg:123',
      isMain: true,
    }));

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
  });
});
```

If `writeAgentTrust`, `makeScheduleIpc`, `getAllPendingActions`, `getAllTasks` helpers don't exist in the test file already, find their nearest equivalent and adapt or define them at the top of the `describe` block. Look for `_makeIpcFile` / `_setupGroup` patterns already present in `ipc.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --bun vitest run src/ipc.test.ts -t 'schedule_task trust enforcement'`
Expected: FAIL — tasks created regardless of trust, no pending_actions rows written.

- [ ] **Step 3: Retrofit the handler**

Edit `src/ipc.ts`. In the `case 'schedule_task':` block (starts at line 707), after the existing validation (cron/interval parsing, A1 script check, agent_name validation), and **before** the `createTask` call at line 811, insert:

```typescript
        // C13: trust enforcement. Main-group bypass preserved via agentName check.
        const { group: sourceBaseGroup, agent: sourceAgent } =
          parseCompoundKey(fsPathToCompoundKey(sourceGroup));
        if (sourceAgent) {
          const trust = loadAgentTrust(path.join(AGENTS_DIR, sourceAgent));
          const decision = checkTrustAndStage({
            agentName: sourceAgent,
            groupFolder: sourceBaseGroup,
            actionType: 'schedule_task',
            summary: String(data.prompt).slice(0, 500),
            target: targetFolder,
            payloadForStaging: {
              type: 'schedule_task',
              prompt: data.prompt,
              schedule_type: data.schedule_type,
              schedule_value: data.schedule_value,
              targetJid: targetJid,
              context_mode: contextMode,
              agent_name: agentName,
              // script intentionally omitted — main-only path (A1)
            },
            trust,
          });
          if (!decision.allowed) break;
          // decision.notify handling: we don't yet notify on schedule_task
          // creation. TODO: wire post-hoc ping if/when user asks for it.
        }
```

Also add the imports at the top of `ipc.ts` if they aren't already present:

```typescript
import { checkTrustAndStage } from './trust-enforcement.js';
import { loadAgentTrust, parseCompoundKey, fsPathToCompoundKey } from './agent-registry.js';
```

(Some of these may already be imported — check before adding.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --bun vitest run src/ipc.test.ts -t 'schedule_task trust enforcement'`
Expected: PASS — all 3 new tests green.

Also run the existing schedule_task tests to confirm no regressions:

Run: `bun --bun vitest run src/ipc.test.ts -t 'schedule_task'`
Expected: PASS — all existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(trust): gate schedule_task via checkTrustAndStage (C13)

First IPC action migrated to the new helper. agentName=null (main
group) bypasses trust as before; non-null agent callers now get their
trust.yaml policy honored. Staged tasks carry full rehydration payload
in pending_actions for /approve.

Part of C13. See 2026-04-19-tier-b-trust-coverage.md for remaining
10 actions."
```

---

## Task 3: Retrofit `publish_to_bus`

**Files:**
- Modify: `src/ipc.ts:1070-1130`
- Test: `src/ipc.test.ts` (add near existing publish_to_bus tests)

Same pattern. `publish_to_bus` already has an authorization gate (cross-group publishes blocked at line 1090) — keep that gate first, then add trust check after.

- [ ] **Step 1: Write the failing tests**

Add tests analogous to Task 2 but for `publish_to_bus`. Cover autonomous (msg written to bus), draft (staged, nothing written), notify (msg written + notify=true reflected in agent_actions.trust_level). Payload for staging: `{type, to_agent, to_group, topic, summary, priority, payload}`.

- [ ] **Step 2: Run tests — expected FAIL.**

Run: `bun --bun vitest run src/ipc.test.ts -t 'publish_to_bus trust'`

- [ ] **Step 3: Retrofit**

In `src/ipc.ts` at the `case 'publish_to_bus':` block, after the cross-group authorization check (line 1090-1096) and before the `deps.messageBus.writeAgentMessage` call (line 1113), insert:

```typescript
      if (sourceAgent) {
        const trust = loadAgentTrust(path.join(AGENTS_DIR, sourceAgent));
        const decision = checkTrustAndStage({
          agentName: sourceAgent,
          groupFolder: pubBaseGroup,
          actionType: 'publish_to_bus',
          summary: safeSummary,
          target: `${targetGroup}--${toAgent}`,
          payloadForStaging: {
            type: 'publish_to_bus',
            to_agent: toAgent,
            to_group: targetGroup,
            topic: safeTopic,
            priority: d.priority,
            summary: safeSummary,
            payload: d.payload,
          },
          trust,
        });
        if (!decision.allowed) break;
      }
```

Note that `sourceAgent` + `pubBaseGroup` are already in scope from line 1080-1082; reuse them rather than re-deriving.

- [ ] **Step 4: Run tests — expected PASS.**

- [ ] **Step 5: Commit.**

```bash
git commit -m "feat(trust): gate publish_to_bus via checkTrustAndStage (C13)"
```

---

## Task 4: Retrofit `knowledge_publish`

**Files:**
- Modify: `src/ipc.ts:1132-` (find the `case 'knowledge_publish':` block, extent ~40 lines)
- Test: `src/ipc.test.ts`

- [ ] **Step 1: Tests** — autonomous writes to knowledge file, draft stages, notify writes.
- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Retrofit** — insert the trust block at the start of the case body, after unpacking `data` but before the `publishKnowledge` call. Payload for staging: `{type, topic, finding, evidence, tags}`. Action type: `'knowledge_publish'`.
- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** `feat(trust): gate knowledge_publish via checkTrustAndStage (C13)`.

---

## Task 5: Retrofit `write_agent_memory`

**Files:**
- Modify: `src/ipc.ts:1160-` (`case 'write_agent_memory':`)
- Test: `src/ipc.test.ts`

Note: this is the action whose SOP was just codified in `docs/memory-writeback-sop.md` (commit `be9864b7`). Trust gating is layered on top of those content rules.

- [ ] **Step 1: Tests.**
- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Retrofit.** Action type: `'write_agent_memory'`. Payload: `{type, section, content}`. Summary: `section` (it's short, <100 chars typically).
- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** `feat(trust): gate write_agent_memory via checkTrustAndStage (C13)`.

---

## Task 6: Retrofit `write_agent_state`

**Files:**
- Modify: `src/ipc.ts:1232-` (`case 'write_agent_state':`)
- Test: `src/ipc.test.ts`

- [ ] **Step 1: Tests.**
- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Retrofit.** Action type: `'write_agent_state'`. Payload: the full state-write body minus any secrets.
- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** `feat(trust): gate write_agent_state via checkTrustAndStage (C13)`.

---

## Task 7: Retrofit `save_skill`

**Files:**
- Modify: `src/ipc.ts` — find `case 'save_skill':` (grep if line has drifted).
- Test: `src/ipc.test.ts`

**Note:** A4 in the hardening spec covers *content validation* for `save_skill` (allowlist, block `allowed-tools: Bash`, content cap). This task only covers **trust gating** — the content validation layers on top in a separate commit. Keep the two concerns separate.

- [ ] **Step 1: Tests.**
- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Retrofit.** Action type: `'save_skill'`. Default trust: `draft`. Payload: `{type, skill_name, content}`.
- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** `feat(trust): gate save_skill via checkTrustAndStage (C13)`.

---

## Task 8: Retrofit `deploy_mini_app`

**Files:**
- Modify: `src/ipc.ts` — find `case 'deploy_mini_app':`.
- Test: `src/ipc.test.ts`

- [ ] **Step 1: Tests.**
- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Retrofit.** Action type: `'deploy_mini_app'`. Default: `draft`. Payload: the full deployment spec.
- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** `feat(trust): gate deploy_mini_app via checkTrustAndStage (C13)`.

---

## Task 9: Retrofit `kg_query` and `dashboard_query`

**Files:**
- Modify: `src/ipc.ts` — find `case 'kg_query':` and `case 'dashboard_query':`.
- Test: `src/ipc.test.ts`

These are read-only; default trust is `autonomous`. Still gate them — autonomous-as-default just means the audit-log entry fires without branching side effects.

- [ ] **Step 1: Tests** (one per action).
- [ ] **Step 2: Verify FAIL** (audit log row count).
- [ ] **Step 3: Retrofit both.**
- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** `feat(trust): gate kg_query and dashboard_query via checkTrustAndStage (C13)`.

---

## Task 10: Retrofit `update_task`

**Files:**
- Modify: `src/ipc.ts:914-` (`case 'update_task':`)
- Test: `src/ipc.test.ts`

**Context:** `update_task` has an A1 gate for the `script` field (main-only). Trust layers on top of that — the script check runs first, trust second.

- [ ] **Step 1: Tests.**
- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Retrofit.** After the A1 script gate, before the `updateTask(...)` call. Payload: `{type, taskId, updates}`.
- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** `feat(trust): gate update_task via checkTrustAndStage (C13)`.

---

## Task 11: Retrofit `pause_task`, `resume_task`, `cancel_task`

**Files:**
- Modify: `src/ipc.ts:833-914` (three adjacent cases)
- Test: `src/ipc.test.ts`

All three share a shape: read the task, authorize caller, mutate. Add trust before the mutate.

- [ ] **Step 1: Tests** (one per case, focused on draft-stages-correctly since these are the most common user-facing cases).
- [ ] **Step 2: Verify FAIL.**
- [ ] **Step 3: Retrofit.** Action types: `'pause_task'`, `'resume_task'`, `'cancel_task'`. Payload: `{type, taskId}`.
- [ ] **Step 4: Verify PASS.**
- [ ] **Step 5: Commit** `feat(trust): gate pause/resume/cancel_task via checkTrustAndStage (C13)`.

---

## Task 12: Migrate `send_message` to `checkTrustAndStage`

**Files:**
- Modify: `src/ipc.ts:363-441` (drop the inline pattern, call the helper)
- Test: `src/ipc.test.ts` — existing send_message trust tests must still pass

**Risk:** this is a migration, not a new gate. Behaviour MUST be unchanged.

- [ ] **Step 1: Locate the existing send_message trust test** (search for `'Trust: send_message staged for approval'` or similar).
- [ ] **Step 2: Run it to confirm it's green** before you touch the code.

Run: `bun --bun vitest run src/ipc.test.ts -t 'send_message'`

- [ ] **Step 3: Refactor.** Replace the inline `checkTrust` + `insertAgentAction` + `insertPendingAction` block with a single `checkTrustAndStage` call. Preserve the `trustDecisionForNotify` local so the post-hoc notify path (later in the function) still works.

- [ ] **Step 4: Re-run the test.**

Run: `bun --bun vitest run src/ipc.test.ts -t 'send_message'`
Expected: PASS with no changes.

- [ ] **Step 5: Commit** `refactor(trust): migrate send_message to checkTrustAndStage helper`.

---

## Task 13: Migrate `send_slack_dm` to `checkTrustAndStage`

**Files:**
- Modify: `src/ipc.ts:1575-1604` (drop the inline pattern)
- Test: `src/ipc.test.ts`

Same shape as Task 12. `send_slack_dm` doesn't currently stage (just blocks on not-allowed). After migration it *will* stage if trust.yaml says `draft`/`ask` — which is a behavior change but in the direction users already expect (the system says "staged for approval" instead of silently dropping).

- [ ] **Step 1: Locate existing test.**
- [ ] **Step 2: Run it green.**
- [ ] **Step 3: Refactor** — replace inline block with helper call. Remove the now-unused early-return on `!decision.allowed` (helper handles it).
- [ ] **Step 4: Add a new test:** `draft level stages in pending_actions` (net-new behavior). Run and confirm it passes.
- [ ] **Step 5: Commit** `refactor(trust): migrate send_slack_dm to checkTrustAndStage, add draft staging`.

---

## Task 14: Update trust.yaml defaults for all 9 agents

**Files:**
- Modify: `data/agents/claire/trust.yaml`
- Modify: `data/agents/coo/trust.yaml`
- Modify: `data/agents/einstein/trust.yaml`
- Modify: `data/agents/freud/trust.yaml`
- Modify: `data/agents/marvin/trust.yaml`
- Modify: `data/agents/simon/trust.yaml`
- Modify: `data/agents/steve/trust.yaml`
- Modify: `data/agents/vincent/trust.yaml`
- Modify: `data/agents/warren/trust.yaml`

Add the 11 new action keys with the default levels from the Context section table. Keep existing keys as-is.

- [ ] **Step 1: Draft the merged trust.yaml for `claire`.** Open the existing file, add each new action key if missing. Expected final shape:

```yaml
actions:
  send_message: notify
  send_slack_dm: notify
  read_slack_dm: notify
  publish_to_bus: notify           # was: autonomous (upgraded — user wants visibility)
  write_group_memory: autonomous
  schedule_task: draft             # was: notify (downgraded — creates code)
  write_agent_memory: autonomous
  # === C13 additions ===
  knowledge_publish: autonomous
  write_agent_state: autonomous
  save_skill: draft
  deploy_mini_app: draft
  kg_query: autonomous
  dashboard_query: autonomous
  update_task: notify
  pause_task: notify
  resume_task: notify
  cancel_task: notify
```

If an existing key contradicts the C13 default (like `schedule_task: notify` → `draft`), **preserve the existing value** unless the operator-level call was clearly a mistake. Flag the conflict in the commit message.

- [ ] **Step 2: Apply the same merge to the other 8 trust.yaml files.** Each agent will have slightly different existing keys — preserve their customizations. Add only the missing ones.

- [ ] **Step 3: Sanity-check.** Every trust.yaml should now have all 13+ action keys (4 original + 11 C13). `for f in data/agents/*/trust.yaml; do echo "== $f ==" && cat $f; done` and eyeball.

- [ ] **Step 4: No tests to run** — these are data files. Run the full trust-enforcement test suite as a smoke test to confirm nothing blows up.

Run: `bun --bun vitest run src/trust-enforcement.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(trust): add C13 action defaults to all agent trust.yaml files`.

---

## Task 15: Documentation

**Files:**
- Modify: `docs/SECURITY.md` — update to reflect the new trust-gate coverage
- Modify: `docs/superpowers/specs/2026-04-18-hardening-audit-design.md` — mark C13 complete

- [ ] **Step 1:** Update `docs/SECURITY.md`. Find the section describing trust enforcement (search for `checkTrust` or `trust.yaml`). Replace any statement of the form "only send_message and send_slack_dm are gated" with the new list.

- [ ] **Step 2:** Add a C13-completion entry to the hardening-audit design doc. Near line 446-456 (the C13 finding), add a status line:

```markdown
#### C13. Trust-enforcement coverage gaps

**Status: resolved 2026-04-NN** (plan: `docs/superpowers/plans/2026-04-19-tier-b-trust-coverage.md`). All 13 IPC action types now route through `checkTrustAndStage`. Default trust levels added to all agent trust.yaml files. See `src/trust-enforcement.ts` + `src/ipc.ts`.

[original finding text follows]
```

- [ ] **Step 3: Commit** `docs: mark C13 resolved, update SECURITY.md trust-gate coverage`.

---

## Self-Review (filled in by the plan author)

**1. Spec coverage.** Every one of the 11 IPC actions named in C13 has a task (Tasks 2-11). The two existing gated actions get a migration task (12-13) to keep the code DRY. Trust.yaml defaults per architecture observation #2 are covered by Task 14. Documentation is Task 15.

**2. Placeholder scan.** None. Every task has concrete file paths, line numbers, and code.

**3. Type consistency.** `checkTrustAndStage` input/output types are defined in Task 1 and referenced verbatim by every retrofit task. `insertAgentAction` / `insertPendingAction` signatures match `db.ts:1234` and `db.ts:1281`. Action-type strings are canonical (match the existing IPC dispatch `case` keys).

**Known gaps and follow-ups (NOT part of C13):**

- **A4** (`save_skill` content validation) — layers on top of Task 7 in a separate plan.
- **Post-hoc notify wiring for non-`send_message` actions** — `decision.notify` returns the signal, but most retrofits today ignore it (leaving a TODO comment). Notify is cheap to wire but crosses scope; tracked as a follow-up. When it lands, each retrofit adds ~5 lines near the comment.
- **`imessage_*` actions** — currently main-only; adding agent-level trust requires the compound-key path to be extended through the iMessage handlers. Out of scope for C13.
- **Migration of trust.yaml files in user forks** — operators who have hand-edited their agent trust.yaml will need to merge the new action keys. `update-nanoclaw` skill should be updated to flag this.
