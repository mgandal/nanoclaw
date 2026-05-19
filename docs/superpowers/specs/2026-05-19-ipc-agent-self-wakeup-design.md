# Phase 1.1 — Agent-initiated self-wakeup (`schedule_wakeup`)

**Status:** Spec — round-1 peer-review amendments applied. Awaiting user review before plan-writing.
**Owner:** mgandal
**Date:** 2026-05-19 (spec); round-1 amendments same day
**Predecessor:** Batch 4 dispatcher observability (commits `651b7803..342d8769`); Batch 2F.1 (`slack_dm` write migration + `postHocNotify`) — both concurrent, no dependency on Batch 2F.1.
**Successor:** Phase 1.2 (wakeup chaining, per-action trust.yaml defaults) — out of scope.

**Round-1 amendments (peer review on 2026-05-19):**
- **Critical**: §4 audit-row contract now mandates write-AFTER-INSERT ordering with explicit code showing the try/catch that writes a `denied_collision` row on PK failure. Prevents the `[Task id=1 doesn't exist]` phantom-audit-row bug pattern. §5.6 updated to reference §4 as the source of truth (was previously contradictory).
- **Critical**: §11 commit sequence collapsed from two commits to one. The handler's `createWakeupTask()` INSERT references the `kind` column added in (former) Commit 1; two-commit deployment created a window where Commit 2 was live on a DB without the `kind` column, causing every wakeup attempt to throw.
- **Important**: §2.1 now explicitly documents the `authorize()`-time input mutation pattern for `precomputedNextRun` and `chatJid`. This is novel for the `IpcHandler<TInput>` contract and no existing handler does it — the spec now states the choice and its rationale, with implementer guidance on non-null assertions in `execute()`.

---

## TL;DR

Add a `schedule_wakeup` IPC action + MCP tool that lets an in-container agent schedule a one-shot future invocation of itself in the same group, with an optional context blob. The host inserts a `scheduled_tasks` row with `kind='agent_wakeup'` and `schedule_type='once'`; the existing scheduler fires it unmodified. Minimum delay 5 minutes, maximum 7 days, cap of 10 pending wakeups per (group, agent) pair. No `script` field ever set. No new container-spawning logic. Agents can say "check back on this in 30 minutes" without a human creating a cron job.

Three changes ship together across two commits:

1. **DB layer** — `kind TEXT DEFAULT NULL` column on `scheduled_tasks`; new `createWakeupTask()` helper that bypasses `validateTaskSchedule`'s 30-minute minimum; new `countActiveWakeups()` for rate limiting.
2. **Host handler** — `scheduleWakeupHandler` in `src/ipc/handlers/schedule-wakeup.ts`. `notify`-kind, `skipGate: true` (with `SKIP_GATE_ALLOWLIST` entry in `src/ipc/handler.ts`). Rate limit and delay validation in `authorize()`. Handler writes its own audit row (skipGate bypasses `gateAndStage`'s normal row).
3. **Container MCP tool** — `schedule_wakeup` in `container/agent-runner/src/ipc-mcp-stdio.ts`, after the existing `schedule_task` tool. Fire-and-forget (no result file). Wakeup ID generated client-side.

---

## Why This Matters

Today, if an agent wants to "check back in 30 minutes," its options are:

- Ask the user to create a `schedule_task` (requires human action).
- Hope it stays alive (containers close after `IDLE_TIMEOUT=30 min`).
- Call `schedule_task` itself — but that requires `schedule_task: autonomous` in trust.yaml, targets by JID (fragile), and creates a persistent task visible to the user.

Self-wakeup is fundamentally different: ephemeral, agent-directed, invisible by default, bounded by the agent's own group. It unlocks async self-thinking workflows: "process this email and check again in 20 minutes," "remind me to follow up on the grant deadline in 3 days," "resume this analysis after the external data is ready." None of these requires the user to create or manage a cron job.

---

## Source-of-Truth References

- Dispatcher: `src/ipc/handler.ts:21-43` (`SKIP_GATE_ALLOWLIST`), `src/ipc/handler.ts:257-497` (`dispatchIpcAction`)
- Closest analogue handler: `src/ipc/handlers/schedule-task.ts` (same DB write pattern, different constraints)
- DB schema: `src/db.ts:41-53` (`scheduled_tasks` table definition), `src/db.ts:651-674` (`createTask` and `validateTaskSchedule` call)
- DB migration idiom: `src/db.ts:214-231` (`addColumn` pattern)
- Scheduler: `src/task-scheduler.ts:236-486` (`runTask`) — fires wakeup rows like any `once` task
- Session lifecycle: `src/config.ts:97-104` (`SESSION_IDLE_MS`, `SESSION_MAX_AGE_MS`), `src/index.ts:637-671` (expiry check)
- Container MCP: `container/agent-runner/src/ipc-mcp-stdio.ts:24-35` (`writeIpcFile`, TASKS_DIR), lines `204-382` (`schedule_task` tool as structural template)
- Trust gate: `src/ipc/trust-gate.ts:34-46` (`gateAndStage`), `src/trust-enforcement.ts:50` (`|| 'ask'` unknown-action default)
- Handler registry: `src/ipc/handlers/index.ts`
- Tool design rubric: `docs/context-engineering/tool-design.md`
- Memory notes: `[script-field-dual-contract-footgun]`, `[ipc-audit-row-coverage-gap]`, `[Non-main groups need allowedSecrets opt-in]`

---

## 1. Goal and Non-Goals

### Goal

An agent running inside a container can call `mcp__nanoclaw__schedule_wakeup` to schedule a one-shot future invocation of itself — same group, same agent identity — with a prompt and optional context blob. The host inserts a `scheduled_tasks` row; the existing scheduler fires it when due; the fired container receives the composed prompt as its initial task.

### Non-Goals

- **Not** a multi-agent message bus. Wakeups target only the calling agent's own group. Use `publish_to_bus` for agent-to-agent deferred handoff.
- **Not** cross-group scheduling. Wakeups cannot target another group's JID. Use `schedule_task` (main-only for cross-group) for that.
- **Not** a persistent recurring task. Wakeups are always `schedule_type='once'`. Use `schedule_task` with `cron` or `interval` for recurrence.
- **Not** a replacement for `schedule_task`. No `script` field, no `target_group_jid`, no `surface_outputs`. Wakeups are ephemeral and agent-scoped.
- **Not** visible to the user by default. Wakeup rows appear in `list_tasks` (they share `scheduled_tasks`) but produce no notification unless the woken agent calls `send_message`.
- **Not** a way to bypass the 7-day maximum. Even main-group agents cannot schedule wakeups farther than 7 days out. Use `schedule_task` for long-horizon jobs.
- **Not** a container escape. The `script` field is NEVER SET on wakeup rows (see §2.3, footgun). The rate limit prevents DoS.

---

## 2. Surface Area

### 2.1 IPC Action — `schedule_wakeup`

Wire type: `schedule_wakeup`

**Input payload (written to TASKS_DIR by the container):**

```typescript
interface ScheduleWakeupIpcPayload {
  type: 'schedule_wakeup';
  wakeupId: string;             // Generated client-side: `wu-${Date.now()}-${Math.random().toString(36).slice(2,8)}`
  prompt: string;               // What the woken agent should do. 1–4000 chars.
  delay_minutes?: number;       // Minutes from now. Mutually exclusive with fire_at.
  fire_at?: string;             // ISO-8601 local time without Z/offset suffix. Mutually exclusive with delay_minutes.
  context_blob?: string;        // Optional freeform context. Max 8000 chars. Appended under <wakeup-context> fence.
  context_mode?: 'group' | 'isolated';  // Default: 'isolated'.
  groupFolder: string;          // Injected by MCP server from NANOCLAW_GROUP_FOLDER.
  timestamp: string;            // ISO-8601 write time.
}
```

**Parsed handler input type:**

```typescript
interface ScheduleWakeupInput {
  wakeupId: string;             // Validated: /^wu-[A-Za-z0-9_-]{1,64}$/
  prompt: string;               // Non-empty, max 4000 chars (enforced in parse)
  contextBlob: string | null;   // max 8000 chars (enforced in parse), null if absent
  contextMode: 'group' | 'isolated';
  delayMinutes: number | null;  // null if fire_at was provided
  fireAt: string | null;        // null if delay_minutes was provided
  precomputedNextRun: string | null;  // ISO timestamp; resolved at authorize()-time
  chatJid: string | null;       // Resolved from registeredGroups[baseGroup]
}
```

**Round-1 amendment — `authorize()`-time input mutation pattern (Important):** `precomputedNextRun` and `chatJid` are NOT populated by `parse()` — they start as `null` and are filled in by `authorize()` after validation against the [5min, 7days] window and the registered-groups lookup. This is a novel pattern for the `IpcHandler<TInput>` contract; no existing handler mutates its input object inside `authorize()`. The rationale: `authorize()` needs the resolved `next_run` value to validate the delay window AND to write the audit row's summary; passing it forward to `execute()` requires either (a) mutating `input` (chosen here for minimal contract change), (b) extending the IpcAuthorization return type with a `resolvedInput` field (broader refactor), or (c) recomputing in `execute()` (duplicates the resolution logic and re-introduces the race). Option (a) was chosen. The implementer MUST treat `input` as writable inside `authorize()` and MUST ensure `precomputedNextRun !== null && chatJid !== null` before `execute()` runs — `execute()` may use non-null assertions (`input.precomputedNextRun!`) once `authorize()` returns a non-null IpcAuthorization. Test 12 pins that `authorize()` populates both fields on the happy path.

**Parse rules:**

- Exactly one of `delay_minutes` or `fire_at` must be present. Both absent or both present → `parse()` returns null.
- `wakeupId` must match `/^wu-[A-Za-z0-9_-]{1,64}$/` → `parse()` returns null if invalid (dispatcher writes `dropped_invalid_input` row).
- `prompt`: 1–4000 chars → `parse()` returns null if violated.
- `context_blob`: if present, max 8000 chars → `parse()` returns null if exceeded.
- `context_mode`: defaults to `'isolated'` if absent or unrecognized.

**Host handler return:** `void` (notify-kind, no result file, no container-side polling).

### 2.2 MCP Tool — `schedule_wakeup`

**Location:** `container/agent-runner/src/ipc-mcp-stdio.ts`, added after the existing `schedule_task` tool (current line 383).

**Tool name:** `schedule_wakeup`

**Description (following the what/when/inputs/returns rubric from `docs/context-engineering/tool-design.md`):**

```
Schedule a one-shot future invocation of yourself in the current group.

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
- fire_at: absolute local time without timezone suffix (e.g. "2026-05-20T09:00:00"). Must be
  5 min to 7 days from now. Provide this OR delay_minutes, not both.
- context_blob: optional freeform context injected under a <wakeup-context> fence in the
  woken agent's prompt. Max 8000 chars. Use to pass state the woken agent will need.
- context_mode: "isolated" (default, fresh session) or "group" (reuse current session if alive).

Returns: "Wakeup wu-<id> scheduled for <timestamp>." on success. Use the wu-<id> with
cancel_task to abort if needed. Error string on validation failure.

Rate limit: max 10 pending wakeups per agent per group. Cancel existing ones with cancel_task.
```

**MCP tool TypeScript sketch:**

```typescript
server.tool(
  'schedule_wakeup',
  `...description above...`,
  {
    prompt: z.string().max(4000).describe('What to do when woken. Required.'),
    delay_minutes: z.number().int().optional().describe('Minutes from now (5–10080). XOR with fire_at.'),
    fire_at: z.string().optional().describe('Local time "YYYY-MM-DDTHH:MM:SS" (no Z). XOR with delay_minutes.'),
    context_blob: z.string().max(8000).optional().describe('Optional context injected under <wakeup-context> fence.'),
    context_mode: z.enum(['group', 'isolated']).optional().default('isolated').describe('"isolated" (default) or "group".'),
  },
  async (args) => {
    const hasDelay = args.delay_minutes !== undefined;
    const hasFireAt = args.fire_at !== undefined;

    if (hasDelay === hasFireAt) {
      return { content: [{ type: 'text', text: 'Error: Provide exactly one of delay_minutes or fire_at, not both (or neither).' }], isError: true };
    }
    if (hasDelay && (args.delay_minutes! < 5 || args.delay_minutes! > 10080)) {
      return { content: [{ type: 'text', text: `Error: delay_minutes must be 5–10080. Got ${args.delay_minutes}.` }], isError: true };
    }
    if (hasFireAt && (/[Zz]$/.test(args.fire_at!) || /[+-]\d{2}:\d{2}$/.test(args.fire_at!))) {
      return { content: [{ type: 'text', text: 'Error: fire_at must be local time without timezone suffix. Example: "2026-05-20T09:00:00"' }], isError: true };
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
      content: [{ type: 'text', text: `Wakeup ${wakeupId} scheduled for ${fireAtPreview}. The woken agent starts fresh — make your prompt self-contained. Cancel with cancel_task if needed.` }],
    };
  },
);
```

### 2.3 Scheduled Tasks Row Shape

**New DB column (migration):**

```sql
ALTER TABLE scheduled_tasks ADD COLUMN kind TEXT DEFAULT NULL;
```

Added via the `addColumn` idiom at `src/db.ts:214-222`, alongside existing migrations at lines 224-231. Existing rows get `kind=NULL` (backward-compatible). No data migration needed.

**Wakeup row shape at insert:**

```typescript
{
  id: wakeupId,                    // "wu-{ts}-{rand}"
  group_folder: baseGroupFolder,   // ctx.baseGroup — never cross-group
  chat_jid: chatJid,               // resolved from registeredGroups at authorize()-time
  prompt: composedPrompt,          // instructions [+ <wakeup-context> envelope]
  script: null,                    // ALWAYS NULL — footgun avoidance (see below)
  agent_name: ctx.agentName,       // calling agent; used by scheduler for attribution
  schedule_type: 'once',           // always; once-tasks become 'completed' after firing
  schedule_value: fireAtIso,       // same as next_run — required by ScheduledTask type
  context_mode: input.contextMode, // 'isolated' or 'group'
  next_run: fireAtIso,             // absolute ISO timestamp, pre-validated [5min, 7days]
  status: 'active',
  kind: 'agent_wakeup',            // NEW discriminator column
  created_at: new Date().toISOString(),
}
```

**Prompt composition:**

```typescript
function composeWakeupPrompt(instructions: string, contextBlob: string | null): string {
  if (!contextBlob) return instructions;
  return `${instructions}\n\n<wakeup-context>\n${contextBlob}\n</wakeup-context>`;
}
```

The `<wakeup-context>` fence follows the NanoClaw convention established by Honcho's `<memory-context>`. The woken agent can read it to reconstruct state from the previous session.

**Script field avoidance — footgun explicitly dodged:**

The `script` column in `scheduled_tasks` has a dual contract per `[script-field-dual-contract-footgun]` memory note:

- **Host path** (`src/task-scheduler.ts:292-333`): `runGuardScript(task.script)` executes it as `/bin/bash -c`. If the prompt string is run as bash, the container crashes and the scheduler logs a task error.
- **Container path** (legacy JSON-wakeAgent convention): the container parses the last stdout line as `{wakeAgent: boolean, data?: any}`.

These are incompatible. Setting `script` on a wakeup row would run the prompt text as a bash script. `createWakeupTask()` EXPLICITLY OMITS `script` from its parameter type and hardcodes `NULL` in the INSERT. The MCP tool has no `script` parameter. Acceptance criterion pins this with a grep check.

**New DB exports:**

```typescript
/**
 * Insert a self-wakeup row, bypassing validateTaskSchedule's 30-minute minimum.
 * Only call from scheduleWakeupHandler.execute().
 * Caller (authorize) guarantees: next_run in [5min, 7days]; rate limit satisfied; script NOT set.
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
  db.prepare(`
    INSERT INTO scheduled_tasks
      (id, group_folder, chat_jid, prompt, script, agent_name, schedule_type,
       schedule_value, context_mode, next_run, status, kind, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, 'once', ?, ?, ?, 'active', 'agent_wakeup', ?)
  `).run(
    task.id, task.group_folder, task.chat_jid, task.prompt,
    task.agent_name, task.next_run, task.context_mode, task.next_run, task.created_at,
  );
}

/**
 * Count active+running wakeup rows for a (group_folder, agent_name) pair.
 * Used by scheduleWakeupHandler.authorize() for rate limiting.
 */
export function countActiveWakeups(groupFolder: string, agentName: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM scheduled_tasks
    WHERE kind = 'agent_wakeup'
      AND group_folder = ?
      AND agent_name = ?
      AND status IN ('active', 'running')
  `).get(groupFolder, agentName) as { cnt: number };
  return row.cnt;
}
```

---

## 3. Trust and Security

### 3.1 Which groups can call it

All registered groups — main and non-main — can call `schedule_wakeup`. No `isMain` gate. The action is self-directed (same-group only), so cross-group privilege is irrelevant.

Non-main groups do NOT need `allowedSecrets` opt-in (`[Non-main groups need allowedSecrets opt-in]` memory note). The wakeup row does not inject secrets — the scheduler's existing `container-runner.ts` secret injection path already respects each group's `allowedSecrets` config when firing any task.

### 3.2 Trust gate design — `skipGate: true`

`schedule_wakeup` uses `skipGate: true` with a `SKIP_GATE_ALLOWLIST` entry (`src/ipc/handler.ts:21-43`). Rationale:

The existing `checkTrust()` at `src/trust-enforcement.ts:50` defaults unknown action types to `'ask'` (staged, not executed): `const level = trust.actions[actionType] || 'ask'`. If `schedule_wakeup` goes through `gateAndStage`, agents without a `schedule_wakeup: autonomous` entry in their trust.yaml would have wakeups staged for human approval — defeating the feature's purpose. Requiring every agent's trust.yaml to be updated is a prohibitive adoption barrier.

The rate limit (§3.3) and delay window are the load-bearing protections against abuse. `skipGate: true` is the correct tool here, following the precedent set for `task_add`, `task_close`, `task_reopen` at lines 38-42 of `src/ipc/handler.ts`.

Since `skipGate: true` bypasses `gateAndStage` (which normally writes the `agent_actions` row via `checkTrustAndStage`), the handler MUST write its own audit row explicitly (see §4). This closes the `[ipc-audit-row-coverage-gap]` concern for this handler.

**SKIP_GATE_ALLOWLIST addition:**

```typescript
// src/ipc/handler.ts, in SKIP_GATE_ALLOWLIST (current lines 21-43):
'schedule_wakeup',
// Self-directed agent wakeup. Rate-limited in authorize(); handler writes its own
// audit row (skipGate bypasses gateAndStage's normal row).
```

### 3.3 Rate limits

- **Per-(group_folder, agent_name) cap:** max 10 active wakeup rows (status IN `'active'`, `'running'`). Checked in `authorize()` via `countActiveWakeups()`. Violation → `authorize()` writes a `denied_rate_limit` audit row and returns null.
- **Minimum delay:** 5 minutes. Enforced in `authorize()`. Below this threshold, wakeups are useless (containers close after `IDLE_TIMEOUT=30 min`; a fresh container is the expected receiver) and approach IPC-as-setInterval abuse.
- **Maximum delay:** 7 days (10080 minutes). Use `schedule_task` for longer horizons.
- **No global daily cap** in Phase 1.1. Worst-case rate with the cap: 10 active wakeups × 1/5-min firing rate × 1 immediate re-schedule = ~2 new wakeups/hour at steady state. Well within cost tolerance.

### 3.4 Non-agent callers

`authorize()` returns null immediately when `ctx.agentName === null`. No wakeup is created, no audit row is written. This matches the cluster norm — wakeups require an agent identity (who is being woken?). Non-agent IPC (operator scripts, etc.) should use `createTask` directly or via `schedule_task`.

---

## 4. Audit Row Contract

**Round-1 amendment — ordering requirement (CRITICAL):** The happy-path audit row MUST be written AFTER the `createWakeupTask()` INSERT succeeds, not before. Writing it first means a PK collision (§5.6) leaves a phantom `outcome='allowed'` row in `agent_actions` for a task that was never created — the exact bug pattern from the `[Task id=1 doesn't exist]` memory note (84 phantom audit entries against a non-existent task). `execute()` must structure as: try INSERT, then on success write the audit row; on PK collision catch the error and write a `denied_collision` row instead.

**Audit row written from `execute()` on success (happy path):**

```typescript
// Inside execute(), AFTER createWakeupTask() returns successfully:
try {
  createWakeupTask({
    id: input.wakeupId,
    group_folder: ctx.baseGroup,
    chat_jid: input.chatJid!,
    prompt: composedPrompt,
    agent_name: ctx.agentName!,
    context_mode: input.contextMode,
    next_run: input.precomputedNextRun!,
    created_at: new Date().toISOString(),
  });
} catch (err) {
  // PK collision or other INSERT failure — write denied row, do NOT proceed.
  insertAgentAction({
    agent_name: ctx.agentName!,
    group_folder: ctx.baseGroup,
    action_type: 'schedule_wakeup',
    trust_level: 'skipGate',
    summary: `wakeup ${input.wakeupId} INSERT failed: ${err instanceof Error ? err.message : String(err)}`,
    target: input.wakeupId,
    outcome: 'denied_collision',
  });
  return { executed: false };
}

// INSERT succeeded — NOW write the allowed audit row.
insertAgentAction({
  agent_name: ctx.agentName!,
  group_folder: ctx.baseGroup,
  action_type: 'schedule_wakeup',
  trust_level: 'skipGate',
  summary: `wakeup ${input.wakeupId} in ${Math.round(delayMinutes)}min: ${input.prompt.slice(0, 100)}`,
  target: input.wakeupId,
  outcome: 'allowed',
});
ctx.deps.onTasksChanged();
```

**Audit rows written from `authorize()` on failure:**

| Condition | `outcome` | `summary` |
|---|---|---|
| Rate limit exceeded | `'denied_rate_limit'` | `'rate limit: ${count}/10 active wakeups for ${agentName} in ${baseGroup}'` |
| delay_minutes < 5 | `'denied_invalid_delay'` | `'delay_minutes ${n} < 5 (minimum)'` |
| delay_minutes > 10080 | `'denied_invalid_delay'` | `'delay_minutes ${n} > 10080 (7-day max)'` |
| fire_at too soon | `'denied_invalid_delay'` | `'fire_at resolves to ${deltaMin}min from now (minimum 5)'` |
| fire_at too far | `'denied_invalid_delay'` | `'fire_at resolves to ${deltaDays}d from now (maximum 7)'` |
| chat_jid not resolvable | `'denied_no_chat_jid'` | `'no chat_jid for group_folder ${baseGroup}'` |

**Rows written by dispatcher (before handler is invoked):**

| Condition | `outcome` | Where written |
|---|---|---|
| parse() returns null | `'dropped_invalid_input'` | `src/ipc/handler.ts:278-312` (dispatcher synthetic row) |
| malformed requestId (N/A — notify-kind) | — | not applicable |

**Note on `trust_level: 'skipGate'`:** This is a literal string, not a value from `TrustDecision`. Using `'skipGate'` makes `agent_actions` queries filterable: `WHERE trust_level = 'skipGate'` shows all bypassed actions. Querying `WHERE action_type = 'schedule_wakeup' AND outcome = 'denied_rate_limit'` surfaces runaway agents.

---

## 5. Failure Modes

### 5.1 Container down at wake time

`runTask` in `src/task-scheduler.ts:398-464` catches container errors in the outer try/catch at line 460. `updateTaskAfterRun(task.id, null, 'Error: ...')` is called with `nextRun=null` → `status='completed'` (once-task completes even on error). The wakeup is lost without retry. This is the same failure mode as all `once` tasks today. The task-health monitor (`[project_task_health_monitor.md]`) will flag consecutive failures.

### 5.2 Group deleted before wake time

`runTask` at `src/task-scheduler.ts:271-289` checks `Object.values(groups).find(g => g.folder === baseGroupFolder)`. If not found, the task is auto-paused (`updateTask(task.id, {status: 'paused'})`) and an error is logged. Correct behavior — no group, nowhere to send. No alert needed.

### 5.3 Agent re-schedules in a tight loop

Cap: 10 active wakeups × 5-minute minimum = max 2 new wakeups/hour at steady state. Over 24 hours: max 48 new containers spawned by a single runaway agent. The `checkAlerts` path at `src/task-scheduler.ts:596-630` fires after 2 consecutive errors. `OPS_ALERT_FOLDER` receives a batched alert (6h dedupe). The operator can cancel all wakeups via `cancel_task` calls.

### 5.4 Wakeup fires mid-session

The GroupQueue serializes container spawns per group (`src/group-queue.ts`). The wakeup waits behind the active container. `next_run` is a fire-no-earlier-than timestamp, not a guarantee. Acceptable — same as all scheduled tasks.

### 5.5 context_blob prompt injection

The `<wakeup-context>` fence is a structural separator, not a security boundary. A malicious blob could inject instructions that override the woken agent's behavior. The 8000-char cap limits blast radius. No sanitization is applied in Phase 1.1. This is the same accepted limitation as Honcho's `<memory-context>` fence. Flag for Phase 1.2 if empirical abuse is observed.

### 5.6 wakeupId collision

Format `wu-{Date.now()}-{6 random chars}` → collision probability ~1/2.2B per ms within the same group. The `scheduled_tasks.id` PRIMARY KEY constraint causes an INSERT error. `execute()` catches it and writes a `denied_collision` audit row (see §4 for the canonical ordering: INSERT first, audit row after success, OR `denied_collision` row on catch). The phantom-row bug pattern from the `[Task id=1 doesn't exist]` memory note is structurally prevented by this ordering — no `outcome='allowed'` row can exist for a task that doesn't exist.

---

## 6. Interaction with Existing Session Lifecycle

### 6.1 Session parameters

- `SESSION_IDLE_MS = 2h` (`src/config.ts:97-98`): session expires after 2h with no activity.
- `SESSION_MAX_AGE_MS = 4h` (`src/config.ts:101-102`): absolute cap regardless of activity.
- Expiry check: `src/index.ts:637-671`, runs before any `runContainerAgent` call for user messages.

### 6.2 `context_mode='isolated'` (default)

Wakeup fires as a fresh container with no session. `runTask` at `src/task-scheduler.ts:365-368`: `sessionId = task.context_mode === 'group' ? sessions[task.group_folder] : undefined`. For `'isolated'`, `sessionId` is `undefined`. The wakeup does NOT touch `touchSession`. A concurrent user session is completely unaffected.

### 6.3 `context_mode='group'`

Wakeup fires reusing the group's current session if one exists in the in-memory `sessions` map. If the session has expired during the wakeup delay (highly likely for delays > 2h), `sessions[task.group_folder]` is absent → `sessionId` is `undefined` → wakeup runs as fresh (`isolated`). The MCP tool description explicitly warns agents of this. `context_mode='group'` is a best-effort hint, not a guarantee.

### 6.4 Does a wakeup count as session activity?

For `context_mode='group'`: after the wakeup container exits, `src/task-scheduler.ts:440-445` calls `touchSession(task.group_folder)` if a session exists. This extends the session's idle clock. For `context_mode='isolated'`: no session touched.

### 6.5 Wakeup fires after session expired — does a new session start?

Yes. `runContainerAgent` handles `sessionId=undefined` by starting a fresh session, identical to any new user message. The wakeup creates a new session for the group. This is the existing behavior for all `once` tasks.

---

## 7. Test Plan

Tests split across three files:

**A.** `src/ipc/handlers/schedule-wakeup.test.ts` — 18 tests (new file)
**B.** `src/db.test.ts` — 3 tests (new `describe('createWakeupTask + countActiveWakeups')` block appended)
**C.** `src/ipc/handler-batch4-drops.test.ts` — 2 tests (new `describe('schedule_wakeup skipGate contract')` block appended)

**Total: 23 tests.** (Batch 2F.1 had 26; Phase 1.1 is narrower — no result file contract, no postHocNotify, no legacy function deletion.)

**Fixture discipline:** Tests that write agent dirs use unique names `test-wu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` and clean up in `afterEach` via `fs.rmSync`. Tests that use the DB call `_initTestDatabase()` in `beforeEach`. Tests that write IPC files use `fs.mkdtempSync` for isolation.

### A. Handler tests (`schedule-wakeup.test.ts`) — 18 tests

**parse() — 5 tests:**

1. Returns null for non-object input (number, null, string).
2. Returns null when both `delay_minutes` and `fire_at` are absent.
3. Returns null when both `delay_minutes` and `fire_at` are present simultaneously.
4. Returns null when `prompt` is absent, empty, or exceeds 4000 chars.
5. Returns valid `ScheduleWakeupInput` with defaults (`context_mode='isolated'`, `contextBlob=null`) for minimal valid payload `{wakeupId: 'wu-123-abc', prompt: 'check x', delay_minutes: 30}`.

**authorize() — 7 tests:**

6. Returns null with no audit row when `ctx.agentName === null` (non-agent caller).
7. Returns null AND writes `denied_rate_limit` audit row when `countActiveWakeups` returns 10.
8. Returns null AND writes `denied_invalid_delay` audit row when `delay_minutes = 3` (< 5).
9. Returns null AND writes `denied_invalid_delay` audit row when `delay_minutes = 10081` (> 10080).
10. Returns null AND writes `denied_invalid_delay` audit row when `fire_at` resolves to 2 minutes from now (< 5 min).
11. Returns null AND writes `denied_no_chat_jid` audit row when `ctx.registeredGroups` has no entry for `ctx.baseGroup`.
12. Returns a non-null IpcAuthorization with `skipGate: true` for a valid agent caller with `delay_minutes=30` and a group with a resolved `chat_jid`. Pins `precomputedNextRun` is approximately `now + 30min`.

**execute() — 4 tests:**

13. Creates a `scheduled_tasks` row with `kind='agent_wakeup'`, `status='active'`, `schedule_type='once'`, and `script=NULL`. Verified via `getTaskById(wakeupId)`. This is the load-bearing script-field footgun test.
14. Composes prompt correctly: `"${instructions}\n\n<wakeup-context>\n${blob}\n</wakeup-context>"` when `contextBlob` is set; plain `instructions` string when `contextBlob` is null.
15. Writes `agent_actions` row with `outcome='allowed'`, `action_type='schedule_wakeup'`, `trust_level='skipGate'`, `target=wakeupId`. Pins that skipGate does not leave an audit gap.
16. Calls `ctx.deps.onTasksChanged()` after successful insert.

**Integration (via `dispatchIpcAction`) — 2 tests:**

17. Full dispatch with valid agent + `delay_minutes=30` → `scheduled_tasks` row created with `kind='agent_wakeup'`, `script=NULL`; audit row written with `outcome='allowed'`; `dispatchIpcAction` returns `{handled: true}`.
18. Full dispatch with valid agent + rate limit pre-populated (10 active wakeup rows inserted before dispatch) → no new task created; audit row written with `outcome='denied_rate_limit'`; `dispatchIpcAction` returns `{handled: true}`.

### B. DB helper tests (`db.test.ts` new block) — 3 tests

19. `createWakeupTask()` inserts a row with `kind='agent_wakeup'`, `script=NULL`, `schedule_type='once'`, `status='active'`, `next_run` matching the provided timestamp.
20. `createWakeupTask()` succeeds with `next_run = now + 5 minutes` (does NOT throw where `validateTaskSchedule` for an interval task with 5min would throw). Pins the 30-minute guard is bypassed.
21. `countActiveWakeups()` returns the correct count: counts `'active'` and `'running'` rows, excludes `'completed'` and `'paused'` rows, scoped to the correct `(group_folder, agent_name)` pair.

### C. Dispatcher contract tests (`handler-batch4-drops.test.ts` new block) — 2 tests

22. A stub handler with `type: 'wu_stub_on_allowlist'`, `skipGate: true`, registered on `SKIP_GATE_ALLOWLIST` → `dispatchIpcAction` calls `execute()`.
23. A stub handler with `type: 'wu_stub_off_allowlist'`, `skipGate: true`, NOT on `SKIP_GATE_ALLOWLIST` → `dispatchIpcAction` writes `denied_contract_violation` audit row and does NOT call `execute()`. Pins the off-allowlist deny path that would catch accidental removal of `schedule_wakeup` from the allowlist.

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Agent runaway loop** | 10-wakeup active cap; 5-min minimum delay; max ~2 new wakeups/hour at steady state. `checkAlerts` fires after 2 consecutive task errors. |
| **context_blob prompt injection** | 8000-char cap limits blast radius. Accepted limitation in Phase 1.1 (same as Honcho `<memory-context>`). Flag for Phase 1.2. |
| **`script` field set accidentally** in a future refactor. | `createWakeupTask()` type signature excludes `script`. INSERT hardcodes `NULL`. Acceptance criterion #5 greps for `kind='agent_wakeup'` rows with non-null script. |
| **`kind` column absent on old DB** (not yet migrated). | `addColumn` uses try/catch and returns false if column exists. Existing rows get `kind=NULL`. `countActiveWakeups` query with `WHERE kind='agent_wakeup'` correctly returns 0 for old rows. |
| **`context_mode='group'` session expiry** (session gone by wake time). | Scheduler's `sessions[group_folder]` lookup returns undefined → wakeup runs fresh. MCP description warns agents. Acceptable. |
| **GroupQueue serialization delays** wakeup when user is chatting. | Wakeup waits in queue. `next_run` is a fire-no-earlier-than target. Same behavior as all scheduled tasks. |
| **skipGate means no audit row** without handler explicitly writing one. | Handler writes its own audit row in `execute()` (happy path) and `authorize()` (failure paths). Tests 15, 7, 8, 9, 10, 11 pin coverage. |
| **Batch 4 dependency** — `insertAgentAction` requires `agent_actions` schema from Batch 4. | Verify Batch 4 is merged (`651b7803..342d8769`) before implementing Phase 1.1. |
| **Batch 2F.1 concurrency** — both specs ship concurrently. | Phase 1.1 touches different files. No overlap with Batch 2F.1's `slack.ts` / `handler-post-hoc-notify.test.ts` / `handler.ts:postHocNotify` additions. Clean parallel development. |

---

## 9. Scope Discipline

- **Not** migrating `schedule_task` or touching the if-ladder.
- **Not** adding user-facing Telegram notifications for wakeup creation. Wakeups are silent.
- **Not** adding `schedule_wakeup: autonomous` to any agent's trust.yaml.
- **Not** implementing wakeup chaining (agent A wakes agent B). Use `publish_to_bus`.
- **Not** adding a `list_wakeups` tool. `list_tasks` already shows wakeup rows.
- **Not** implementing wakeup cancellation UI. `cancel_task` with the wakeup ID works.
- **Not** adding a `context_blob` column to `scheduled_tasks`. Blob is composed into `prompt` by the handler before insert.
- **Not** closing the `list_tasks` visibility gap (wakeup rows appear in `list_tasks` output). See Open Question Q4.

---

## 10. Acceptance Criteria

1. `bun run test` passes: baseline ~2350 tests + 23 new = ~2373 total.
2. `bun run typecheck` passes.
3. `bun run lint` passes.
4. `SELECT kind, COUNT(*) FROM scheduled_tasks WHERE kind='agent_wakeup' GROUP BY kind` returns a row after a test wakeup is created (confirms `kind` column migrated and populated).
5. `SELECT script FROM scheduled_tasks WHERE kind='agent_wakeup' LIMIT 100` returns only NULL rows. Zero non-null values. Pins footgun avoidance.
6. `grep -n "'schedule_wakeup'" src/ipc/handler.ts` shows the `SKIP_GATE_ALLOWLIST` entry.
7. `grep -n "scheduleWakeupHandler" src/ipc/handlers/index.ts` shows the registration.
8. Tests 13 + 15 together prove: `createWakeupTask` sets `script=NULL` AND `execute()` writes the audit row.
9. Test 18 proves rate limit enforced end-to-end.
10. Manual smoke test: dispatch `schedule_wakeup` IPC from a test-agent caller, confirm `scheduled_tasks` row with `kind='agent_wakeup'`, `script=NULL`, `status='active'`; confirm `agent_actions` row with `outcome='allowed'`; confirm `onTasksChanged` called.

---

## 11. Commit Sequence

**Round-1 amendment (CRITICAL):** Original plan was two commits, but the handler's `createWakeupTask()` INSERT references the `kind` column added in Commit 1. If Commit 2 ships to production before Commit 1's migration runs on the live DB, every wakeup attempt throws `SQLITE_ERROR: table scheduled_tasks has no column named kind`. The two-commit boundary creates a deployment window where the feature is broken. **Collapse into a single commit** — the cost of larger atomic units is much smaller than the cost of a half-deployed feature crashing in production. Acceptance criterion #4 (table has `kind` column) and acceptance criterion #10 (smoke test) both verify the migration ran before the handler is exercised.

**Single Commit:** `feat(ipc): add schedule_wakeup IPC + MCP tool + kind column (Phase 1.1 self-wakeup)`

- `src/db.ts`: `addColumn('ALTER TABLE scheduled_tasks ADD COLUMN kind TEXT DEFAULT NULL')` + export `createWakeupTask` + export `countActiveWakeups`
- `src/db.test.ts`: tests 19-21 (new describe block)
- `src/ipc/handlers/schedule-wakeup.ts`: new handler
- `src/ipc/handlers/schedule-wakeup.test.ts`: tests 1-18
- `src/ipc/handler.ts`: add `'schedule_wakeup'` to `SKIP_GATE_ALLOWLIST`
- `src/ipc/handlers/index.ts`: register `scheduleWakeupHandler` after `scheduleTaskHandler`
- `src/ipc/handler-batch4-drops.test.ts`: tests 22-23 (new describe block)
- `container/agent-runner/src/ipc-mcp-stdio.ts`: `schedule_wakeup` MCP tool

**Atomicity note:** The original two-commit structure was attractive because Commit 1 (DB helpers) is reusable infrastructure and Commit 2 (handler) is feature code. Splitting was preferable for git-log hygiene. But the column-dependency rules that out: the handler INSERT cannot function until the migration runs. Better to ship as one atomic unit. If git-log granularity becomes a strong preference later, the alternative is to deploy Commit 1, verify `kind` column exists in production DB via the launchd healthcheck, THEN merge Commit 2 — this requires deployment gating that doesn't exist in the current launchd flow. Single commit is simpler.

---

## 12. Open Questions

**Q1 (Trust gate policy — skipGate vs. default-to-autonomous mechanism):** This spec uses `skipGate: true` so agents need no trust.yaml updates. A cleaner alternative: add a per-action "default trust level if missing" mechanism to `checkTrust()` at `src/trust-enforcement.ts:50`, so `schedule_wakeup` defaults to `'autonomous'` without requiring skipGate. This would let operators override to `'ask'` per-agent. Worth implementing in Phase 1.2 if skipGate feels like a band-aid. Decision needed: keep skipGate in Phase 1.1 as-is?

**Q2 (Rate limit cap):** Is 10 active wakeups per (group, agent) the right number? Alternative: 5 (tighter, reduces worst-case burst). Or add a separate "max wakeups created per hour" counter tracked in memory.

**Q3 (context_mode default):** The spec defaults to `'isolated'`. The existing `schedule_task` MCP tool defaults to `'group'` (line 246-249 of `container/agent-runner/src/ipc-mcp-stdio.ts`). Should wakeups also default to `'group'` for consistency? Argument for `'isolated'`: wakeups are typically async checkpoints where the session has likely expired. Argument for `'group'`: 5-10 minute wakeups benefit from session continuity.

**Q4 (Wakeup rows in `list_tasks`):** Wakeup rows appear in `list_tasks` output since they share `scheduled_tasks`. The non-goals section says wakeups are "not externally visible by default" but `list_tasks` contradicts this. Options: (a) filter `kind='agent_wakeup'` out of `list_tasks` by default with an opt-in flag; (b) label them in `list_tasks` output with a `[wakeup]` prefix; (c) accept the current behavior.

**Q5 (Batch 4 dependency confirmation):** Verify commits `651b7803..342d8769` (Batch 4 dispatcher observability) are merged to `main` before starting Phase 1.1 implementation. Phase 1.1 uses `insertAgentAction` directly and requires the `agent_actions` schema. If Batch 4 is not merged, the handler's audit-row writes will fail silently on old schema.

**Q6 (Wakeup attribution in scheduler logs):** When a wakeup fires, `runTask` logs `{taskId, group}` but not `kind`. Should `runTask` emit `{taskId, group, kind}` when `kind` is set? This would make wakeup fires distinguishable in `logs/nanoclaw.log` from operator-created `once` tasks. Low-effort and high-value for debugging.

---

*Spec complete — awaiting user review before plan-writing.*
