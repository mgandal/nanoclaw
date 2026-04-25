# Agent Architecture Redesign — Implementation Plan

> **Status: SHIPPED 2026-04-13 → 2026-04-19.** All 4 phases complete. 9 agent dirs at `data/agents/{claire,coo,einstein,freud,marvin,simon,steve,vincent,warren}/` each with `identity.md` + `memory.md` + `trust.yaml` + `skills/`. `lead: true` only on `claire/identity.md` (correct per spec); others `lead: false`. `write_agent_memory` IPC handler at `src/ipc.ts:1473` (64KB cap, section validation, agent-name guard) + MCP tool at `container/agent-runner/src/ipc-mcp-stdio.ts:1859`. Per-agent host dir mounts read-only to `/workspace/agent` in `src/container-runner.ts:438-448`. Phase 1 skill crystallization layer wires `data/agents/{name}/skills/crystallized/` between group and container skills (`src/container-runner.ts:117`, commits `168a3a21`, `c2683278`, `1ee76d36`). Tests: `bun --bun vitest run src/agent-registry.test.ts` → 24/24 pass. Phase 2/3 (invocation logging + implicit triggers) tracked in `2026-04-25-skill-crystallization-phase2-3.md` and shipped 2026-04-25 (commit `0027fb46` + ancestors). Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Claire's memory, make specialist agents portable with persistent identity/memory/skills, and reduce CLAUDE.md bloat from 48KB to ~14KB per session.

**Architecture:** Three-layer instruction model (global CLAUDE.md → group CLAUDE.md → agent identity.md). Agents are persistent entities at `data/agents/{name}/` with portable memory, skills, and trust. Groups are domain-scoped chat rooms. One new container mount (`/workspace/agents`, read-only) and one new IPC action (`write_agent_memory`).

**Tech Stack:** TypeScript/Bun, Apple Container (virtiofs mounts), SQLite (agent_registry), YAML frontmatter parsing (already in agent-registry.ts)

**Spec:** `docs/superpowers/specs/2026-04-13-agent-architecture-redesign.md` (v2)

---

## Phase 1: Agent Directories (Low Risk)

### Task 1: Create Agent Directories and Identity Files

**Files:**
- Create: `data/agents/simon/identity.md`
- Create: `data/agents/simon/memory.md`
- Create: `data/agents/simon/trust.yaml`
- Create: `data/agents/marvin/identity.md`
- Create: `data/agents/marvin/memory.md`
- Create: `data/agents/marvin/trust.yaml`
- Create: `data/agents/coo/identity.md`
- Create: `data/agents/coo/memory.md`
- Create: `data/agents/coo/trust.yaml`
- Modify: `data/agents/claire/identity.md`
- Modify: `data/agents/einstein/identity.md`

- [ ] **Step 1: Read existing TeamCreate prompts to extract agent definitions**

Read these files to extract the full agent prompts:
- `groups/telegram_science-claw/CLAUDE.md` — Einstein (lines 156-194) and Simon (lines 196-235) TeamCreate prompts
- `groups/telegram_lab-claw/CLAUDE.md` — Marvin (lines 115-166) and COO (lines 168-200) TeamCreate prompts
- `groups/telegram_home-claw/CLAUDE.md` — Marvin personal variant (lines 45-65)

- [ ] **Step 2: Create Simon's agent directory**

```bash
mkdir -p data/agents/simon/skills
```

Write `data/agents/simon/identity.md`:
```yaml
---
name: Simon
role: CTO / Data Scientist
lead: false
description: >
  Computational data scientist specializing in bioinformatics, spatial
  transcriptomics, single-cell RNA-seq, statistical genetics, machine
  learning, and data pipeline development.
groups: [telegram_code-claw, telegram_science-claw]
sender: Simon
---
```
Then the full persona body — consolidate from the SCIENCE-claw TeamCreate prompt. Include: responsibilities, tool preferences, session start protocol (read own memory.md), session end protocol (write_agent_memory IPC), communication rules (sender: "Simon", short messages, no markdown).

Write `data/agents/simon/memory.md`:
```markdown
# Simon — Memory

Last updated: 2026-04-13

## Current Session
[No active session]

## Standing Instructions
[Seeded from SCIENCE-claw memory.md during Phase 3]

## Active Threads
[Seeded from SCIENCE-claw memory.md during Phase 3]
```

Write `data/agents/simon/trust.yaml`:
```yaml
actions:
  send_message: notify
  publish_to_bus: autonomous
  write_vault: notify
  write_agent_memory: autonomous
  schedule_task: notify
  search_literature: autonomous
```

- [ ] **Step 3: Create Marvin's agent directory (merging Jennifer)**

```bash
mkdir -p data/agents/marvin/skills
```

Write `data/agents/marvin/identity.md` — consolidate from LAB-claw Marvin (work) + HOME-claw Marvin (personal) TeamCreate prompts. Include:
- Frontmatter with `lead: false`, `sender: Marvin`
- Full persona: executive + personal assistant
- `## Scope by Group` section defining behavior per group
- Email triage rules (from LAB-claw CLAUDE.md)
- Scheduling rules reference (from global CLAUDE.md)
- People tracking instructions (from global CLAUDE.md)
- Session start/end protocols with memory read/write

Write `data/agents/marvin/memory.md` (empty template, seeded in Phase 3).

Write `data/agents/marvin/trust.yaml`:
```yaml
actions:
  send_message: notify
  publish_to_bus: autonomous
  write_vault: notify
  write_agent_memory: autonomous
  schedule_task: notify
  draft_email: autonomous
  send_email: ask
```

- [ ] **Step 4: Create COO's agent directory**

```bash
mkdir -p data/agents/coo/skills
```

Write `data/agents/coo/identity.md` — from LAB-claw COO TeamCreate prompt. Include `lead: false`, `sender: COO`.

Write `data/agents/coo/memory.md` (empty template).

Write `data/agents/coo/trust.yaml`:
```yaml
actions:
  send_message: notify
  publish_to_bus: autonomous
  write_agent_memory: autonomous
  schedule_task: notify
```

- [ ] **Step 5: Update Claire's identity.md**

Modify `data/agents/claire/identity.md` — add `lead: true` to frontmatter, expand the body to include:
- Vault writing instructions (from global CLAUDE.md)
- Wiki knowledge base instructions (from global CLAUDE.md)
- Team reference: "Your team: Einstein (research), Simon (code/data), Marvin (admin/scheduling), COO (lab ops)"
- Session start/end protocols with memory read/write

- [ ] **Step 6: Update Einstein's identity.md**

Modify `data/agents/einstein/identity.md` — expand the thin body to include the full persona from the SCIENCE-claw TeamCreate prompt. Add `lead: false` to frontmatter. Update trust.yaml: rename `write_agent_state` → `write_agent_memory`.

- [ ] **Step 7: Remove Jennifer**

```bash
rm -rf data/agents/jennifer/
```

- [ ] **Step 8: Commit**

```bash
git add data/agents/
git commit -m "feat: create portable agent directories for simon, marvin, coo

Consolidate TeamCreate prompts into persistent identity.md files.
Merge Jennifer into Marvin. Add lead:true to Claire.
Each agent gets identity.md, memory.md, trust.yaml."
```

### Task 2: Update Agent Registry DB

**Files:**
- Modify: `store/messages.db` (via sqlite3 commands)

- [ ] **Step 1: Add new agent registry rows**

```bash
sqlite3 store/messages.db "
INSERT OR REPLACE INTO agent_registry (agent_name, group_folder, enabled, added_at) VALUES
  ('simon', 'telegram_code-claw', 1, datetime('now')),
  ('simon', 'telegram_science-claw', 1, datetime('now')),
  ('marvin', 'telegram_lab-claw', 1, datetime('now')),
  ('marvin', 'telegram_home-claw', 1, datetime('now')),
  ('marvin', 'telegram_claire', 1, datetime('now')),
  ('coo', 'telegram_lab-claw', 1, datetime('now'));
"
```

- [ ] **Step 2: Remove Jennifer rows**

```bash
sqlite3 store/messages.db "DELETE FROM agent_registry WHERE agent_name = 'jennifer';"
```

- [ ] **Step 3: Verify registry state**

```bash
sqlite3 store/messages.db "SELECT agent_name, group_folder, enabled FROM agent_registry ORDER BY agent_name, group_folder;"
```

Expected output:
```
claire|*|1
coo|telegram_lab-claw|1
einstein|telegram_lab-claw|1
einstein|telegram_science-claw|1
marvin|telegram_claire|1
marvin|telegram_home-claw|1
marvin|telegram_lab-claw|1
simon|telegram_code-claw|1
simon|telegram_science-claw|1
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: update agent_registry with simon, marvin, coo; remove jennifer"
```

---

## Phase 2: Container & IPC Changes (Medium Risk)

### Task 3: Replace `/workspace/agent` Mount with `/workspace/agents`

**Files:**
- Modify: `src/container-runner.ts:295-304`
- Modify: `src/ipc.ts:135-141`
- Modify: `src/container-runner.test.ts`
- Modify: `src/ipc.test.ts`

- [ ] **Step 1: Write failing test for new mount path**

In `src/container-runner.test.ts`, add a test that verifies the new mount:

```typescript
it('mounts data/agents/ at /workspace/agents as read-only for all containers', () => {
  const mounts = buildVolumeMounts(group, false, undefined);
  const agentsMount = mounts.find(m => m.containerPath === '/workspace/agents');
  expect(agentsMount).toBeDefined();
  expect(agentsMount!.readonly).toBe(true);
  expect(agentsMount!.hostPath).toContain('data/agents');
});

it('does not mount /workspace/agent (singular) for any container', () => {
  const mounts = buildVolumeMounts(group, false, 'einstein');
  const singularMount = mounts.find(m => m.containerPath === '/workspace/agent');
  expect(singularMount).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/container-runner.test.ts`
Expected: FAIL — `/workspace/agents` mount not found, `/workspace/agent` still exists

- [ ] **Step 3: Update container-runner.ts**

Replace lines 295-304 in `src/container-runner.ts`:

```typescript
// OLD: Agent identity mount (read-only) for compound group containers
// if (agentName) {
//   const agentDir = path.join(AGENTS_DIR, agentName);
//   if (fs.existsSync(agentDir)) {
//     mounts.push({
//       hostPath: agentDir,
//       containerPath: '/workspace/agent',
//       readonly: true,
//     });
//   }
// }

// NEW: Mount all agent directories (read-only) for all containers
const allAgentsDir = path.join(process.cwd(), 'data', 'agents');
if (fs.existsSync(allAgentsDir)) {
  mounts.push({
    hostPath: allAgentsDir,
    containerPath: '/workspace/agents',
    readonly: true,
  });
}
```

- [ ] **Step 4: Update IPC path resolution in ipc.ts**

Replace lines 135-141 in `src/ipc.ts`:

```typescript
// OLD:
// if (containerFilePath.startsWith('/workspace/agent/')) {
//   const rel = containerFilePath.slice('/workspace/agent/'.length);

// NEW: /workspace/agents/{agentName}/... → data/agents/{agentName}/...
if (containerFilePath.startsWith('/workspace/agents/')) {
  const rel = containerFilePath.slice('/workspace/agents/'.length);
```

- [ ] **Step 5: Update tests referencing old path**

Search for `/workspace/agent` (singular, not plural) in test files and update to `/workspace/agents/{agentName}`.

- [ ] **Step 6: Run all tests**

Run: `bun test src/container-runner.test.ts src/ipc.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts src/ipc.ts src/container-runner.test.ts src/ipc.test.ts
git commit -m "feat: replace /workspace/agent mount with /workspace/agents (read-only)

Remove singular agent mount for compound groups. Add plural mount
for all containers. Mount is read-only — writes go through IPC.
Fixes virtiofs prefix collision risk."
```

### Task 4: Implement `write_agent_memory` IPC Action

**Files:**
- Modify: `src/ipc.ts` (add new case after `write_agent_state`)
- Create: `src/ipc.test.ts` (new test block)

- [ ] **Step 1: Write failing test**

Add to `src/ipc.test.ts`:

```typescript
describe('write_agent_memory', () => {
  it('writes memory.md for a registered agent', async () => {
    // Setup: create agent dir and registry entry
    const agentDir = path.join(AGENTS_DIR, 'einstein');
    fs.mkdirSync(agentDir, { recursive: true });

    await processIpcTask({
      type: 'write_agent_memory',
      agent_name: 'einstein',
      content: '# Einstein — Memory\n\n## Current Session\nTest content',
    }, 'telegram_science-claw', deps);

    const memoryPath = path.join(agentDir, 'memory.md');
    expect(fs.existsSync(memoryPath)).toBe(true);
    expect(fs.readFileSync(memoryPath, 'utf-8')).toContain('Test content');
  });

  it('rejects agent_name with path traversal', async () => {
    await processIpcTask({
      type: 'write_agent_memory',
      agent_name: '../etc/passwd',
      content: 'malicious',
    }, 'telegram_science-claw', deps);

    // Should not create any file outside agents dir
    expect(fs.existsSync(path.join(AGENTS_DIR, '..', 'etc', 'passwd', 'memory.md'))).toBe(false);
  });

  it('rejects unregistered agent for non-main group', async () => {
    // einstein is not registered for telegram_home-claw
    const agentDir = path.join(AGENTS_DIR, 'einstein');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'memory.md'), 'original');

    await processIpcTask({
      type: 'write_agent_memory',
      agent_name: 'einstein',
      content: 'overwritten',
    }, 'telegram_home-claw', deps);

    // Memory should NOT be overwritten
    expect(fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf-8')).toBe('original');
  });

  it('allows main group to write to any agent', async () => {
    const agentDir = path.join(AGENTS_DIR, 'einstein');
    fs.mkdirSync(agentDir, { recursive: true });

    await processIpcTask({
      type: 'write_agent_memory',
      agent_name: 'einstein',
      content: 'main wrote this',
    }, 'telegram_claire', deps);  // main group

    expect(fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf-8')).toBe('main wrote this');
  });

  it('supports append mode', async () => {
    const agentDir = path.join(AGENTS_DIR, 'einstein');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'memory.md'), 'line1');

    await processIpcTask({
      type: 'write_agent_memory',
      agent_name: 'einstein',
      content: 'line2',
      append: true,
    }, 'telegram_science-claw', deps);

    expect(fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf-8')).toContain('line1');
    expect(fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf-8')).toContain('line2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/ipc.test.ts -t "write_agent_memory"`
Expected: FAIL — unknown IPC type

- [ ] **Step 3: Implement write_agent_memory handler**

Add to `src/ipc.ts` after the `write_agent_state` case (line ~809):

```typescript
case 'write_agent_memory': {
  const d = data as Record<string, unknown>;
  const agentName = d.agent_name as string;
  const content = d.content as string;
  if (!agentName || !content) {
    logger.warn('write_agent_memory: missing agent_name or content');
    break;
  }

  // Security: reject path traversal
  if (agentName.includes('..') || agentName.includes('/') || agentName.includes('\\')) {
    logger.warn({ agentName }, 'write_agent_memory: path traversal rejected');
    break;
  }

  // Authorization: agent must be registered for this group, or source must be main
  const baseGroup = parseCompoundKey(fsPathToCompoundKey(sourceGroup)).group || sourceGroup;
  const isMainGroup = deps.registeredGroups
    ? Object.values(deps.registeredGroups).some(
        (g) => g.folder === baseGroup && g.isMain,
      )
    : false;

  if (!isMainGroup) {
    const registry = deps.getAgentRegistry ? deps.getAgentRegistry() : [];
    const isRegistered = registry.some(
      (r: { agent_name: string; group_folder: string; enabled: number }) =>
        r.agent_name === agentName &&
        r.enabled === 1 &&
        (r.group_folder === baseGroup || r.group_folder === '*'),
    );
    if (!isRegistered) {
      logger.warn(
        { agentName, baseGroup },
        'write_agent_memory: agent not registered for this group',
      );
      break;
    }
  }

  // Verify agent directory exists
  const agentDir = path.join(AGENTS_DIR, agentName);
  if (!fs.existsSync(agentDir)) {
    logger.warn({ agentName }, 'write_agent_memory: agent directory does not exist');
    break;
  }

  const memoryPath = path.join(agentDir, 'memory.md');
  if (d.append) {
    const existing = fs.existsSync(memoryPath)
      ? fs.readFileSync(memoryPath, 'utf-8')
      : '';
    const tmpPath = `${memoryPath}.tmp`;
    fs.writeFileSync(tmpPath, existing + '\n' + content);
    fs.renameSync(tmpPath, memoryPath);
  } else {
    const tmpPath = `${memoryPath}.tmp`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, memoryPath);
  }
  logger.info({ agentName }, 'Agent memory updated via IPC');
  break;
}
```

- [ ] **Step 4: Add `getAgentRegistry` to IPC deps interface**

In `src/ipc.ts`, add to the `IpcDeps` interface:

```typescript
getAgentRegistry?: () => AgentRegistryRow[];
```

Wire it in `src/index.ts` where `processIpcTask` is called, passing the `getAgentRegistry` function from db.ts.

- [ ] **Step 5: Run tests**

Run: `bun test src/ipc.test.ts -t "write_agent_memory"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts src/index.ts
git commit -m "feat: add write_agent_memory IPC action

New IPC type for agents to persist memory.md. Accepts explicit
agent_name (no compound key required). Authorization: agent must
be registered for the source group, or source must be main.
Path traversal rejected. Supports overwrite and append modes."
```

### Task 5: Update Context Assembler

**Files:**
- Modify: `src/context-assembler.ts`
- Modify: `src/context-assembler.test.ts`
- Modify: `src/config.ts:140-143`

- [ ] **Step 1: Write failing test for lead agent memory injection**

Add to `src/context-assembler.test.ts`:

```typescript
it('injects lead agent memory into context packet', async () => {
  // Setup: create claire identity with lead:true and memory.md
  const claireDir = path.join(AGENTS_DIR, 'claire');
  fs.mkdirSync(claireDir, { recursive: true });
  fs.writeFileSync(path.join(claireDir, 'identity.md'), '---\nname: Claire\nlead: true\n---\nClaire identity');
  fs.writeFileSync(path.join(claireDir, 'memory.md'), '# Claire Memory\nTest memory content');

  const packet = await assembleContextPacket('telegram_lab-claw', false);
  expect(packet).toContain('--- Lead Agent Memory ---');
  expect(packet).toContain('Test memory content');
});

it('injects memory overlength warning for files >200 lines', async () => {
  const claireDir = path.join(AGENTS_DIR, 'claire');
  fs.mkdirSync(claireDir, { recursive: true });
  fs.writeFileSync(path.join(claireDir, 'identity.md'), '---\nname: Claire\nlead: true\n---\n');
  const longMemory = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`).join('\n');
  fs.writeFileSync(path.join(claireDir, 'memory.md'), longMemory);

  const packet = await assembleContextPacket('telegram_lab-claw', false);
  expect(packet).toContain('Memory file overlarge');
  expect(packet).toContain('250 lines');
});

it('injects specialist agent summary', async () => {
  // Setup: create einstein identity
  const einsteinDir = path.join(AGENTS_DIR, 'einstein');
  fs.mkdirSync(einsteinDir, { recursive: true });
  fs.writeFileSync(path.join(einsteinDir, 'identity.md'), '---\nname: Einstein\nrole: Research Scientist\nlead: false\n---\n');

  const packet = await assembleContextPacket('telegram_science-claw', false);
  expect(packet).toContain('--- Available Specialists ---');
  expect(packet).toContain('Einstein (Research Scientist)');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/context-assembler.test.ts`
Expected: FAIL

- [ ] **Step 3: Bump CONTEXT_PACKET_MAX_SIZE**

In `src/config.ts`, change line 141:

```typescript
export const CONTEXT_PACKET_MAX_SIZE = parseInt(
  process.env.CONTEXT_PACKET_MAX_SIZE || '24000',
  10,
);
```

- [ ] **Step 4: Add lead agent memory injection to context-assembler.ts**

In `assembleContextPacket()`, add before the group memory section (before line 170):

```typescript
// 1b. Lead agent memory (agents with lead:true in identity.md frontmatter)
const agentsDir = path.join(process.cwd(), 'data', 'agents');
if (fs.existsSync(agentsDir)) {
  for (const agentDir of fs.readdirSync(agentsDir)) {
    const identityPath = path.join(agentsDir, agentDir, 'identity.md');
    if (!fs.existsSync(identityPath)) continue;
    const identityContent = fs.readFileSync(identityPath, 'utf-8');
    const fmMatch = identityContent.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    if (!fmMatch[1].includes('lead: true') && !fmMatch[1].includes('lead:true')) continue;

    const agentMemoryPath = path.join(agentsDir, agentDir, 'memory.md');
    if (fs.existsSync(agentMemoryPath)) {
      const agentMemory = fs.readFileSync(agentMemoryPath, 'utf-8');
      if (agentMemory.trim()) {
        sections.push(`\n--- Lead Agent Memory ---\n${agentMemory.slice(0, 5000)}`);
      }

      // Memory overlength warning
      const lineCount = agentMemory.split('\n').length;
      if (lineCount > 200) {
        sections.push(`\n--- ⚠️ Memory file overlarge (${lineCount} lines) — prune now ---`);
      }
    }
  }
}
```

- [ ] **Step 5: Increase group memory budget**

Change line 175 from `memory.slice(0, 2000)` to `memory.slice(0, 3000)`.

- [ ] **Step 6: Add specialist agent summary**

Add at the end of `assembleContextPacket()`, before the truncation check:

```typescript
// Specialist agent summary for TeamCreate priming
if (fs.existsSync(agentsDir)) {
  const summaryLines: string[] = [];
  for (const agentDir of fs.readdirSync(agentsDir)) {
    const identityPath = path.join(agentsDir, agentDir, 'identity.md');
    if (!fs.existsSync(identityPath)) continue;
    const content = fs.readFileSync(identityPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const nameMatch = fmMatch[1].match(/name:\s*(.+)/);
    const roleMatch = fmMatch[1].match(/role:\s*(.+)/);
    const leadMatch = fmMatch[1].includes('lead: true') || fmMatch[1].includes('lead:true');
    if (nameMatch && roleMatch && !leadMatch) {
      summaryLines.push(`- ${nameMatch[1].trim()} (${roleMatch[1].trim()}): /workspace/agents/${agentDir}/identity.md`);
    }
  }
  if (summaryLines.length > 0) {
    sections.push(`\n--- Available Specialists ---\n${summaryLines.join('\n')}`);
  }
}
```

- [ ] **Step 7: Run tests**

Run: `bun test src/context-assembler.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/context-assembler.ts src/context-assembler.test.ts src/config.ts
git commit -m "feat: inject lead agent memory and specialist summary into context packets

Context assembler now reads lead:true agents' memory.md and injects
into every context packet. Adds memory overlength warnings (>200 lines).
Adds specialist summary with identity.md paths for TeamCreate priming.
Bumps CONTEXT_PACKET_MAX_SIZE from 16KB to 24KB.
Group memory budget increased from 2000 to 3000 chars."
```

### Task 6: Add Agent Skill Sync to Container Runner

**Files:**
- Modify: `src/container-runner.ts:185-205`
- Modify: `src/container-runner.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('syncs skills from all registered agents for the group', () => {
  // Setup: create agent skills directory
  const einsteinSkillDir = path.join(AGENTS_DIR, 'einstein', 'skills', 'research-tool');
  fs.mkdirSync(einsteinSkillDir, { recursive: true });
  fs.writeFileSync(path.join(einsteinSkillDir, 'SKILL.md'), '# Research Tool');

  // Mock registry: einstein registered for this group
  // After calling ensureSessionDir, check that skill was copied
  ensureSessionDir('telegram_science-claw', groupDir);
  const dstSkill = path.join(groupSessionsDir, 'skills', 'research-tool', 'SKILL.md');
  expect(fs.existsSync(dstSkill)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/container-runner.test.ts`
Expected: FAIL — agent skill not copied

- [ ] **Step 3: Add agent skill sync step**

In `src/container-runner.ts`, after container skill sync (line ~195) and before group skill sync (line ~197), add:

```typescript
// Sync agent-level skills for all agents registered to this group.
// Runs AFTER container skills, BEFORE group skills (so: container < agent < group priority).
const registeredAgents = getAgentRegistry().filter(
  (r) => r.enabled === 1 && (r.group_folder === groupFolder || r.group_folder === '*'),
);
for (const reg of registeredAgents) {
  const agentSkillsSrc = path.join(process.cwd(), 'data', 'agents', reg.agent_name, 'skills');
  if (fs.existsSync(agentSkillsSrc)) {
    for (const skillDir of fs.readdirSync(agentSkillsSrc)) {
      const srcDir = path.join(agentSkillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
}
```

Import `getAgentRegistry` from `./db.js` at the top of the file.

- [ ] **Step 4: Run tests**

Run: `bun test src/container-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: sync agent-level skills into containers

Skills from data/agents/{name}/skills/ are copied into the session's
.claude/skills/ for all agents registered to the group. Sync order:
container skills < agent skills < group skills (last wins)."
```

### Task 7: Security Hardening (Deferred — Can Follow Phase 2)

**Files:**
- Modify: `src/ipc.ts` (publish_to_bus handler, schedule_task handler)

These items are from the security review and can be implemented after the core architecture is working:

- [ ] **Step 1: Add trust.yaml enforcement for high-privilege IPC operations**

In the `schedule_task` and `publish_to_bus` IPC handlers, load the calling agent's trust.yaml and check the trust level before processing. If trust level is `ask` or `draft`, reject and log.

- [ ] **Step 2: Add publish_to_bus authorization**

Non-main groups can only publish to groups they're registered to interact with. Add a check against the agent_registry or a routing allowlist.

- [ ] **Step 3: Add agent-bus-message fencing**

Wrap bus message content in `<agent-bus-message source="{agent}">` tags so receiving agents know the content is agent-produced.

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts && git commit -m "feat: add trust enforcement and bus authorization for IPC security"
```

---

### Task 8: Integration Test — Verify Phase 2 End-to-End

- [ ] **Step 1: Build and run dev server**

```bash
bun run build
```

- [ ] **Step 2: Send a test message to SCIENCE-claw**

Send a message to SCIENCE-claw via Telegram and verify:
- Container starts without mount errors
- Context packet contains `--- Lead Agent Memory ---` section
- Context packet contains `--- Available Specialists ---` section
- No virtiofs EBUSY errors in logs

- [ ] **Step 3: Verify agent memory write via IPC**

Inside the container (or via a test script), have Claire write to her memory:

```bash
echo '{"type":"write_agent_memory","agent_name":"claire","content":"# Claire Memory\n\nTest from Phase 2 integration"}' > /workspace/ipc/tasks/test-$(date +%s).json
```

Verify `data/agents/claire/memory.md` was updated on the host.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix: phase 2 integration test fixes"
```

---

## Phase 3: CLAUDE.md Refactoring (High Risk)

### Task 9: Split Memory Files

**Files:**
- Modify: `data/agents/claire/memory.md`
- Modify: `data/agents/einstein/memory.md`
- Modify: `data/agents/marvin/memory.md`
- Modify: `groups/telegram_claire/memory.md`
- Modify: `groups/telegram_lab-claw/memory.md`
- Modify: `groups/telegram_science-claw/memory.md`

- [ ] **Step 1: Read all group memory files and categorize content**

Read each group's memory.md. For each entry, decide:
- Is this Claire's personal memory (decisions, preferences, instructions)? → `data/agents/claire/memory.md`
- Is this a specialist's domain knowledge (paper findings, email threads)? → `data/agents/{specialist}/memory.md`
- Is this domain working state (pending tasks for this group)? → stays in `groups/{folder}/memory.md`

- [ ] **Step 2: Write Claire's unified memory.md**

Populate `data/agents/claire/memory.md` with:
- User instructions and preferences extracted from all group memory files
- Recent decisions (last 20, with dates)
- Active context across all groups
- Cap at 150 lines

- [ ] **Step 3: Seed Einstein's memory.md**

Extract from `groups/telegram_science-claw/memory.md`:
- Active analyses
- Recent findings
- Tools & methods tracked

- [ ] **Step 4: Seed Marvin's memory.md**

Extract from `groups/telegram_lab-claw/memory.md`:
- Open email threads
- Collaboration threads
- Scheduling status

- [ ] **Step 5: Clean group memory files**

Remove Claire's personal memory and specialist content from each group memory.md. Leave only domain working state.

- [ ] **Step 6: Commit**

```bash
git add data/agents/ groups/
git commit -m "feat: split memory files — Claire unified, specialists seeded

Extract Claire's personal memory from all group memory.md into
data/agents/claire/memory.md. Seed Einstein and Marvin memory from
group-specific content. Group memory.md files now contain only
domain working state."
```

### Task 10: Refactor Group CLAUDE.md Files

**Note:** This is the highest-risk task. Back up every file before modifying. Test each group individually.

**Files:**
- Modify: `groups/global/CLAUDE.md`
- Modify: `groups/telegram_claire/CLAUDE.md`
- Modify: `groups/telegram_lab-claw/CLAUDE.md`
- Modify: `groups/telegram_science-claw/CLAUDE.md`
- Modify: `groups/telegram_code-claw/CLAUDE.md`
- Modify: `groups/telegram_home-claw/CLAUDE.md`
- Modify: `groups/telegram_clinic-claw/CLAUDE.md`
- Modify: `groups/telegram_vault-claw/CLAUDE.md`
- Modify: `groups/telegram_ops-claw/CLAUDE.md`

- [ ] **Step 1: Back up all CLAUDE.md files**

```bash
for f in groups/*/CLAUDE.md; do cp "$f" "${f}.bak"; done
```

- [ ] **Step 2: Refactor global CLAUDE.md**

Target: ~8KB (from 28KB). Keep: user profile, personality, memory architecture (updated to MD-first), danger zone, formatting, container workspace docs. Remove: people tracking (→ marvin), vault writing (→ claire identity), wiki KB (→ claire identity), morning briefing (→ telegram_claire group), TeamCreate prompts (→ agent identity files), group management (→ telegram_claire group).

Update memory architecture section: change "MANDATORY: recall from Hindsight" to "If Hindsight is available, recall for additional context. Your memory.md is the primary source of truth."

- [ ] **Step 3: Refactor telegram_claire/CLAUDE.md**

Target: ~4KB (from 20KB). Keep: scope (main channel + elevated privileges), morning briefing instructions, group management instructions, agent teams coordination rules. Remove: all TeamCreate prompts, duplicated global content. Add: `## Agents` section referencing identity.md files for Marvin.

- [ ] **Step 4: Refactor telegram_lab-claw/CLAUDE.md**

Target: ~3KB (from 16KB). Keep: scope, domain rules (email accounts, scheduling), cross-group routing, delegation guardrails. Remove: full Marvin/COO TeamCreate prompts (~600 lines), duplicated scheduling rules. Add: `## Agents` section referencing `/workspace/agents/marvin/identity.md` and `/workspace/agents/coo/identity.md`.

- [ ] **Step 5: Refactor telegram_science-claw/CLAUDE.md**

Target: ~3KB (from 16KB). Keep: scope, research context, grants, KB templates, cross-group routing. Remove: full Einstein/Simon TeamCreate prompts (~500 lines), duplicated global content. Add: `## Agents` section referencing Einstein and Simon identity.md files.

- [ ] **Step 6: Refactor remaining groups**

For each of telegram_code-claw, telegram_home-claw, telegram_clinic-claw, telegram_vault-claw, telegram_ops-claw:
- Keep: scope definition, domain-specific rules
- Remove: any duplicated global content
- Add: `## Agents` section if specialists are registered for that group
- Add: `## Cross-Group Routing` table

- [ ] **Step 7: Verify file sizes**

```bash
for f in groups/*/CLAUDE.md; do echo "$(wc -c < "$f") $f"; done | sort -rn
```

Expected: all group CLAUDE.md files under 5KB, global under 10KB.

- [ ] **Step 8: Behavioral smoke tests**

For each refactored group, send 3-5 test messages via Telegram:
- LAB-claw: "check my calendar for today", "any pending emails?", "what grants are due this month?"
- SCIENCE-claw: "search bioRxiv for recent ASD GWAS papers", "what tools did we evaluate recently?"
- CODE-claw: "what's the status of the co-expression framework?"
- MAIN: "morning briefing", "schedule a meeting with Bogdan next week"

Verify: agents respond appropriately, specialists are spawned, no critical instruction loss.

- [ ] **Step 9: Commit**

```bash
git add groups/
git commit -m "feat: refactor CLAUDE.md files — three-layer instruction model

Global CLAUDE.md: 28KB → ~8KB (shared rules, user profile, memory arch)
Group CLAUDE.md files: 16-20KB → ~3-4KB (scope, agents, routing)
Agent prompts moved to data/agents/{name}/identity.md.
Hindsight downgraded from MANDATORY to bonus layer.
All originals backed up as .bak files."
```

---

## Phase 4: Cleanup

### Task 11: Delete knowledge-graph.md and Merge Slack

**Files:**
- Delete: `groups/global/state/knowledge-graph.md`
- Modify: `store/messages.db`
- Archive: `groups/slack_lab/`

- [ ] **Step 1: Delete knowledge-graph.md**

```bash
rm groups/global/state/knowledge-graph.md
```

- [ ] **Step 2: Merge slack_lab memory into telegram_lab-claw**

```bash
cat groups/slack_lab/memory.md >> groups/telegram_lab-claw/memory.md
```

- [ ] **Step 3: Update DB to point slack to telegram_lab-claw folder**

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET folder = 'telegram_lab-claw' WHERE jid = 'slack:C0ABVNZLA0L';"
```

- [ ] **Step 4: Archive slack_lab folder**

```bash
mv groups/slack_lab groups/slack_lab.archived
```

- [ ] **Step 5: Remove .bak files after confirming everything works**

```bash
# Only after all smoke tests pass:
find groups/ -name "*.bak" -delete
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: cleanup — delete knowledge-graph.md, merge slack_lab, remove backups

Delete 338KB stale knowledge-graph.md (no runtime references).
Merge slack_lab into telegram_lab-claw folder. Archive slack_lab.
Point slack:C0ABVNZLA0L DB entry to telegram_lab-claw."
```

### Task 12: Update Project Memory

**Files:**
- Modify: `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md`

- [ ] **Step 1: Update MEMORY.md with new architecture notes**

Add a section documenting:
- Agent directories at `data/agents/{name}/` with identity.md, memory.md, trust.yaml
- `write_agent_memory` IPC action for persisting agent memory
- `/workspace/agents` mount (read-only) replaces `/workspace/agent`
- `lead: true` frontmatter drives context packet injection
- Three-layer instruction model: global < group < agent identity
- Memory hierarchy: agent memory.md (primary) > Hindsight (bonus)

- [ ] **Step 2: Commit**

```bash
git commit -am "docs: update project memory with new architecture"
```
