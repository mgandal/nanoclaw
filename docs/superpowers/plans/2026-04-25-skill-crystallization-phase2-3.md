# Skill Crystallization — Phase 2 & 3 Implementation Plan

> **Status: SHIPPED 2026-04-25.** All six tasks across both phases landed. Phase 2 (telemetry): `skill_invoked` IPC handler at `src/ipc.ts:2492` (`bd174eee`); container-side `PreToolUse` hook in `container/agent-runner/src/index.ts:382` (`7c71f13b`); weekly retro script at `scripts/skills/crystallized-retro.ts` (`62dd7f1f`). Phase 3 (implicit offer): per-group `ContainerConfig.implicitCrystallizeOffer` flag in `src/types.ts:51`, env-injection at `src/container-runner.ts:709`, pure-function heuristic `shouldOfferCrystallize` + `appendCrystallizeOffer` in agent-runner, runQuery-local `turnToolCalls` tracking + result-time append (`6a710245`). Test deltas: 1968 → 1979 (+11 host) and 42 → 51 (+9 agent-runner). Mid-plan revisions captured inline: switched A2 from tool_use content-block tap to PreToolUse SDK hook (cleaner typed surface), corrected mount path to `/workspace/agent` (singular). Open `- [ ]` boxes were not retroactively ticked. **A3 (live E2E smoke test) intentionally deferred** — unit tests cover the contract end-to-end at the unit boundary; live container E2E can be added later if Phase 2 telemetry surfaces an issue the unit tests miss.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add invocation tracking (Phase 2) and an opt-in implicit-trigger offer (Phase 3) on top of the shipped Phase 1 crystallization MVP.

**Spec:** `docs/superpowers/specs/2026-04-18-skill-crystallization-design.md` §Rollout Phase 2 + Phase 3.

**Phase 1 baseline (already shipped):**
- `crystallize_skill` IPC handler at `src/ipc.ts:2386` writes `data/agents/{agent}/skills/crystallized/{name}/SKILL.md` + appends to `crystallized/log.jsonl`.
- `/crystallize` skill at `container/skills/crystallize/SKILL.md` walks the LLM through naming, body composition, confidence self-report, and IPC firing.
- `syncSkillsForGroup(groupDir, sessionsDir, {agentName})` at `src/container-runner.ts:129` layers `data/agents/{name}/skills/crystallized/` between group and container skills (precedence: container > agent > group). Bash-frontmatter filter applies to crystallized skills the same as group skills.

**What's missing:**
- *No telemetry on invocation*. We log when a skill is *written* but not when it's *used*. Phase 2 closes that loop.
- *No implicit offer*. The `/crystallize` skill body says the agent "may also offer", but there's no structured detection or stored prompt cache to make that offer reliably. Phase 3 adds the trigger.

**Tech Stack:** TypeScript (Bun), vitest, agent-runner SDK message stream, existing IPC layer.

---

## Feature 2.1: Invocation Logging (Phase 2 Core)

The agent-runner already captures every `tool_use` block at `container/agent-runner/src/index.ts:706-720` for the Pattern Engine. We tap that same site to detect when a crystallized skill is invoked, then send an IPC event back to the host to bump `invocation_count` in the skill's frontmatter and append to a `usage.jsonl` log.

### Task A1: Add `skill_invoked` IPC handler on the host

**Files:**
- Modify: `src/ipc.ts`
- Test: `src/ipc.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/ipc.test.ts` (use the existing `processTaskIpc` test pattern with a tmp `agentsRoot`):

```typescript
describe('skill_invoked invocation logging', () => {
  it('increments invocation_count in crystallized SKILL.md frontmatter', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-invoked-'));
    const skillDir = path.join(tmpDir, 'claire', 'skills', 'crystallized', 'deadline-aggregation');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: deadline-aggregation\ndescription: "demo"\ncrystallized_at: 2026-04-20T00:00:00Z\nsource_task: "demo"\nconfidence: 7\ninvocation_count: 2\n---\n\nbody\n`,
    );

    await processTaskIpc(
      {
        type: 'skill_invoked',
        agent: 'claire',
        name: 'deadline-aggregation',
        agentsRoot: tmpDir,
      } as any,
      'telegram_claire',
      true,
      deps,
    );

    const updated = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(updated).toMatch(/invocation_count: 3\b/);
    expect(updated).toMatch(/last_invoked_at: \d{4}-\d{2}-\d{2}T/);

    const usageLog = fs.readFileSync(
      path.join(tmpDir, 'claire', 'skills', 'crystallized', 'usage.jsonl'),
      'utf-8',
    );
    expect(usageLog).toMatch(/"name":"deadline-aggregation"/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects skill_invoked with invalid agent or name (path-traversal guard)', async () => {
    await expect(
      processTaskIpc(
        { type: 'skill_invoked', agent: '../etc', name: 'foo' } as any,
        'telegram_claire',
        true,
        deps,
      ),
    ).resolves.not.toThrow();
    // No file created, no log line written. Validate by absence.
  });

  it('no-ops when crystallized SKILL.md does not exist (idempotent)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-invoked-'));
    await processTaskIpc(
      {
        type: 'skill_invoked',
        agent: 'claire',
        name: 'nonexistent',
        agentsRoot: tmpDir,
      } as any,
      'telegram_claire',
      true,
      deps,
    );
    // No throw. usage.jsonl should NOT have been created.
    expect(fs.existsSync(path.join(tmpDir, 'claire', 'skills', 'crystallized', 'usage.jsonl'))).toBe(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun --bun vitest run src/ipc.test.ts -t "skill_invoked invocation logging"
```

Expected: FAIL — no `skill_invoked` case in the IPC switch.

- [ ] **Step 3: Add the handler**

In `src/ipc.ts`, follow the same shape as `handleCrystallizeSkillIpc` (search for `function handleCrystallizeSkillIpc`). Add a new function `handleSkillInvokedIpc` and a switch case for `'skill_invoked'`.

Validation rules (mirror the Phase 1 handler at line 2409-2422):
- `agent` must match `/^[a-z0-9][a-z0-9_-]{0,63}$/`.
- `name` must match `/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/`.
- `agentsRoot` is a test seam (default to `AGENTS_DIR`).
- Reject silently with `logger.warn` on validation failure — no IPC reply needed (this is fire-and-forget telemetry, the container doesn't wait).

Read-modify-write the SKILL.md frontmatter:
1. Read existing file. If missing, log `debug` and return (no-op — skill may have been deleted).
2. Parse YAML frontmatter region (between the first two `---` lines).
3. Replace `invocation_count: N` with `invocation_count: N+1`.
4. Upsert `last_invoked_at: <ISO>` (replace existing line OR append before closing `---`).
5. Atomic write via `tmp + rename`.

Append to `data/agents/{agent}/skills/crystallized/usage.jsonl`:
```json
{"ts":"2026-04-25T...","agent":"claire","name":"deadline-aggregation","sourceGroup":"telegram_claire"}
```

- [ ] **Step 4: Run tests**

```bash
bun --bun vitest run src/ipc.test.ts -t "skill_invoked invocation logging"
```

Expected: 3/3 PASS.

- [ ] **Step 5: Run full suite**

```bash
bun run test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(skills): skill_invoked IPC handler — bump invocation_count + log usage.jsonl"
```

### Task A2: Detect Skill-tool invocations of crystallized skills via PreToolUse hook

**Files:**
- Modify: `container/agent-runner/src/index.ts`

**Background (revised after discovery):** Initial plan was to tap the existing `tool_use` content-block capture at line 706-720. Discovery in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1538` revealed a typed `PreToolUseHookInput` with `tool_name: string` + `tool_input: unknown` — a first-class SDK hook. Use the hook instead — same pattern as the existing `PreCompact` registration, cleaner than the content-block tap, and integrates the toolUseID for correlation.

- [ ] **Step 1: Build the crystallized-skill name set on session start**

Near the existing `compactionJustHappened` flag (line 96 module scope), add a session-scoped helper. Inside `runQuery` (around line 580 where `containerInput.agentName` is available), build:

```typescript
const crystallizedSkillNames: Set<string> = (() => {
  if (!containerInput.agentName) return new Set();
  // Read-only agent mount: container-runner.ts:444 binds the *single*
  // agent dir (data/agents/{name}) to /workspace/agent (singular).
  const dir = `/workspace/agent/skills/crystallized`;
  try {
    return new Set(
      fs.readdirSync(dir).filter((entry) => {
        try {
          return fs.statSync(path.join(dir, entry)).isDirectory()
            && fs.existsSync(path.join(dir, entry, 'SKILL.md'));
        } catch { return false; }
      }),
    );
  } catch {
    return new Set();
  }
})();
log(`Crystallized skills tracked: ${[...crystallizedSkillNames].join(', ') || '(none)'}`);
```

Verify the mount path by grepping `src/container-runner.ts` for `'/workspace/agents'`. (If the path differs, adjust.)

- [ ] **Step 2: Define a PreToolUse hook callback**

Add near `createPreCompactHook` (around line 331):

```typescript
function createPreToolUseHook(
  agentName: string | undefined,
  crystallizedSet: Set<string>,
  groupFolder: string,
): HookCallback {
  return async (input) => {
    // Type guard — input is the union of all hook inputs.
    if (!('tool_name' in input)) return {};
    const toolName = (input as { tool_name?: string }).tool_name;
    if (toolName !== 'Skill') return {};

    // Defensive: the Skill tool input shape is `unknown` in the SDK type
    // defs. Log the raw shape on first sight so the actual contract is
    // visible at runtime; never crash if the shape drifts.
    const rawInput = (input as { tool_input?: unknown }).tool_input;
    log(`PreToolUse Skill input: ${JSON.stringify(rawInput).slice(0, 200)}`);

    if (!agentName || !rawInput || typeof rawInput !== 'object') return {};
    const skillName =
      (rawInput as { skill?: string }).skill ??
      (rawInput as { name?: string }).name;
    if (!skillName || !crystallizedSet.has(skillName)) return {};

    // Fire-and-forget IPC. Use the standard tasks dir.
    try {
      const taskFile = `/workspace/ipc/tasks/skill-invoked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      fs.writeFileSync(
        taskFile,
        JSON.stringify({
          type: 'skill_invoked',
          agent: agentName,
          name: skillName,
          groupFolder,
        }),
      );
    } catch (err) {
      log(`skill_invoked IPC write failed: ${err}`);
    }
    return {};
  };
}
```

- [ ] **Step 3: Register the hook alongside PreCompact**

The two `query()` calls at line 687 and 920 each register `hooks: { PreCompact: [...] }`. Extend both:

```typescript
hooks: {
  PreCompact: [
    { hooks: [createPreCompactHook(containerInput.assistantName)] },
  ],
  PreToolUse: [
    {
      hooks: [
        createPreToolUseHook(
          containerInput.agentName,
          crystallizedSkillNames,
          containerInput.groupFolder,
        ),
      ],
    },
  ],
},
```

Both query call sites must match — the first is for the main query loop, the second is for the resumed-session loop.

- [ ] **Step 4: Build the container**

```bash
cd container && bun run build && cd ..
./container/build.sh
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(skills): detect Skill-tool invocations of crystallized skills, fire skill_invoked IPC"
```

### Task A3: End-to-end smoke test

**Files:**
- New: `scripts/tests/skill-crystallization-e2e.sh` (or piggyback on an existing E2E if one exists)

- [ ] **Step 1: Write a smoke-test script**

The script should:
1. Pre-stage a fake crystallized skill at `data/agents/claire/skills/crystallized/test-smoke/SKILL.md` with `invocation_count: 0`.
2. Send a Telegram message to CLAIRE asking for the skill explicitly (e.g. `/test-smoke`).
3. Wait for the container response.
4. Read the SKILL.md back and assert `invocation_count: 1`, `last_invoked_at` populated, `usage.jsonl` has one line.
5. Clean up.

If standing up a Telegram E2E is too heavy, fall back to a lower-level integration test that calls `runContainerAgent` directly with a prompt that triggers the Skill tool.

- [ ] **Step 2: Document in MEMORY.md**

Add a brief pointer:
```
- [Skill crystallization Phase 2](project_skill_crystallization_phase2.md) — invocation logging via tool_use tap; bumps `invocation_count` per call, appends to `usage.jsonl`. Phase 3 (implicit offer) gated on this data.
```

- [ ] **Step 3: Commit** (E2E script only — memory note is a separate, optional step)

```bash
git add scripts/tests/skill-crystallization-e2e.sh
git commit -m "test(skills): E2E smoke test for crystallized-skill invocation logging"
```

---

## Feature 2.2: Weekly Retro Query (Phase 2 Insight Layer)

A small reporting tool that reads `data/agents/*/skills/crystallized/{log,usage}.jsonl` and summarizes "written but never invoked" + "invoked ≥3 times — promotion candidates."

### Task B1: Build the retro script

**Files:**
- Create: `scripts/skills/crystallized-retro.ts`

- [ ] **Step 1: Write the script**

`scripts/skills/crystallized-retro.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Weekly retro for crystallized skills. Reads:
 *   data/agents/*/skills/crystallized/log.jsonl   (write events)
 *   data/agents/*/skills/crystallized/usage.jsonl (invocation events)
 * Reports: never-invoked, ≥3-invocation promotion candidates, stale skills.
 */
// 1. Find all agent dirs.
// 2. For each, load both jsonl files (tolerate missing).
// 3. Build a map: name -> { ts, source_task, confidence, invocations }.
// 4. Print three lists.
// Output is plain-text, suitable for piping to Telegram or pasting into a digest.
```

Implementation notes:
- Use `Bun.glob` to find `data/agents/*/skills/crystallized/`.
- Each line is a JSON object — parse defensively (skip malformed).
- "Stale" = `crystallized_at` > 14 days AND zero invocations.
- "Promotion candidate" = invocations >= 3.

- [ ] **Step 2: Wire into a scheduled task (optional, defer if scope creep)**

Add a once-per-week entry to the task scheduler. This is *optional* — the script can be run by hand or via an existing weekly digest.

- [ ] **Step 3: Run it once and eyeball output**

```bash
bun scripts/skills/crystallized-retro.ts
```

Expected: at minimum reports "0 crystallized skills found" cleanly if the user hasn't crystallized any yet.

- [ ] **Step 4: Commit**

```bash
git add scripts/skills/crystallized-retro.ts
git commit -m "feat(skills): weekly retro script for crystallized-skill usage analysis"
```

---

## Feature 3.1: Implicit Crystallization Offer (Phase 3, behind config flag)

The MVP heuristic: at end-of-turn, if (a) the session had ≥3 distinct MCP tool calls, (b) the result had no error, (c) the user's prompt didn't contain a "redo/wrong/no/stop" signal, and (d) no existing crystallized skill matches the trace's tool-name fingerprint, **emit a passive suggestion** rather than auto-saving.

The user's `/crystallize` flow already handles the actual write. Phase 3 only generates the *prompt* asking the user "want to save that?" — implicit auto-save is explicitly out of scope per the spec's risk section.

### Task C1: Add a per-group `implicit_crystallize_offer` config flag

**Files:**
- Modify: `src/config.ts` (or wherever per-group config lives)

- [ ] **Step 1: Find the right config layer**

Search:
```bash
grep -rE "isMain|requires_trigger|trustedSenders" src/config.ts src/db.ts | head -10
```

The flag should default `false` (no implicit offer) and be settable per-group. Lowest-friction option: a column in `registered_groups` or a check against a static config.

- [ ] **Step 2: Add the flag and a default-false getter**

```typescript
// src/config.ts (or db.ts, depending on existing pattern)
export function getImplicitCrystallizeOffer(groupFolder: string): boolean {
  // Default off. Enable per-group via DB / config.
  // ...
}
```

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(skills): per-group implicit_crystallize_offer flag (default off)"
```

### Task C2: Detect crystallizable moments in agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Track distinct MCP tool calls per turn**

The `sessionToolCalls` array already exists from the Pattern Engine. Within a single turn (between query start and result), filter to MCP tool calls (`name.startsWith('mcp__')`) and dedupe by `(name, paramsHash)`.

- [ ] **Step 2: At result time, evaluate the heuristic**

Around the `if (message.type === 'result')` block (line 741), add:

```typescript
if (message.type === 'result' && message.subtype === 'success') {
  const distinctMcp = new Set(
    sessionToolCalls
      .filter((c) => c.tool.startsWith('mcp__'))
      .map((c) => `${c.tool}|${c.paramsHash}`),
  );
  const offerEnabled = process.env.IMPLICIT_CRYSTALLIZE_OFFER === '1';
  if (offerEnabled && distinctMcp.size >= 3) {
    // Append a passive suggestion to the result text — DON'T fire IPC,
    // DON'T modify state, just nudge the user.
    const suggestion = `\n\n_(I made ${distinctMcp.size} tool calls solving that. Want me to /crystallize this as a reusable skill?)_`;
    // Mutate the textResult before writeOutput.
  }
}
```

The cleanest implementation is a string append to `textResult` — but only if the result is otherwise short (<2000 chars), to avoid bloating heavy responses.

- [ ] **Step 3: Threading the env var**

`IMPLICIT_CRYSTALLIZE_OFFER=1` should be set per-spawn in `src/container-runner.ts` based on `getImplicitCrystallizeOffer(group.folder)`. Wire it into `extraEnv`.

- [ ] **Step 4: Build the container**

```bash
./container/build.sh
```

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts src/container-runner.ts
git commit -m "feat(skills): implicit crystallize offer — nudge user after ≥3 MCP tool calls"
```

### Task C3: Tests for the heuristic

**Files:**
- Test: `container/agent-runner/src/index.test.ts` (or a new fixture)

- [ ] **Step 1: Write unit tests for the heuristic logic**

Extract the heuristic into a pure function `shouldOfferCrystallize(toolCalls, resultSize): boolean` so it's unit-testable without spinning a container. Test cases:

| Tool calls | Result size | Env flag | Expect |
|---|---|---|---|
| 5 distinct MCP calls | 500 chars | on | true |
| 2 distinct MCP calls | 500 chars | on | false |
| 5 distinct MCP calls | 5000 chars | on | false (too big) |
| 5 distinct MCP calls | 500 chars | off | false |
| 5 same MCP calls (repeated paramsHash) | 500 chars | on | false (only 1 distinct) |

- [ ] **Step 2: Run tests**

```bash
cd container/agent-runner && bun test src/index.test.ts -t "shouldOfferCrystallize"
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/index.ts container/agent-runner/src/index.test.ts
git commit -m "test(skills): unit tests for shouldOfferCrystallize heuristic"
```

---

## Post-Implementation Checklist

- [ ] All tests pass: `bun run test`
- [ ] Build succeeds: `bun run build`
- [ ] Container builds: `./container/build.sh`
- [ ] **Phase 2:** `data/agents/{agent}/skills/crystallized/usage.jsonl` accumulates one line per Skill-tool invocation of a crystallized skill
- [ ] **Phase 2:** SKILL.md `invocation_count` increments live (verify via `grep invocation_count data/agents/*/skills/crystallized/*/SKILL.md`)
- [ ] **Phase 2:** `bun scripts/skills/crystallized-retro.ts` produces sensible output even on an empty corpus
- [ ] **Phase 3:** With `IMPLICIT_CRYSTALLIZE_OFFER=1`, a 3+ MCP-call response carries the suggestion suffix
- [ ] **Phase 3:** Default behavior (flag off) is unchanged for all existing groups
- [ ] Memory note added: `project_skill_crystallization_phase2.md` linking the IPC, retro script, and heuristic

## Risks revisited

- **Skill-tool input shape drift.** If a future SDK version changes `Skill(skill: name)` to `Skill(name: ...)`, A2's matcher silently no-ops. Guard: log every `tool_use` whose `name` is `Skill` so a regression is visible at debug level.
- **Suggestion fatigue.** The Phase 3 nudge appears after every multi-call success. Tunables: minimum tool-call threshold (default 3), max-suggestions-per-day per group (defer until data justifies). Start strict, loosen only if users report missing offers.
- **`usage.jsonl` unbounded growth.** A heavily-used skill could write thousands of lines/day. Mitigation: rotate when file >10MB (deferred — measure first).
- **Path-traversal in `skill_invoked`.** Validation regexes are identical to Phase 1 — the same audit boundary applies.
