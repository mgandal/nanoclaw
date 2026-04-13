# Agent Architecture Redesign — "One Claire, Portable Specialists"

**Date:** 2026-04-13
**Status:** Draft v2 — incorporates peer review, security review, and architecture review
**Reviews:** Code reviewer, security reviewer, architecture reviewer (3 independent agents)
**Scope:** Memory architecture, agent definitions, group CLAUDE.md structure, cross-group coordination

## Problem Statement

NanoClaw has three overlapping agent definition systems (Agent Registry DB, TeamCreate prompts in CLAUDE.md, group CLAUDE.md personas) that define the same agents inconsistently. Claire feels like 8 separate amnesiacs across groups. Specialists (Einstein, Marvin, Simon, COO) are ephemeral sub-agents with no persistent memory or portable skills. The result: role confusion (who does what?), context loss (Claire forgets across groups), and wasted potential (specialists can't accumulate expertise).

## Design Principles

1. **MD-first memory** — markdown files are the authoritative memory layer. Hindsight/Honcho are bonuses, not dependencies. If they go down, nothing breaks.
2. **Groups = domains** — groups define where conversations happen and what topics belong there. Groups are not agents.
3. **Agents = people** — agents are persistent entities with their own memory, skills, and personality. They are portable across groups.
4. **Claire is one person** — she remembers everything regardless of which group she's in.
5. **Specialists are summoned, not spawned** — Claire delegates to specialists who carry their own accumulated context.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    NanoClaw Host                     │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐                  │
│  │ data/agents/  │  │   groups/    │                  │
│  │              │  │              │                  │
│  │  claire/     │  │  global/     │  ← shared state  │
│  │    identity  │  │    CLAUDE.md │  ← shared rules  │
│  │    memory    │  │    state/    │                  │
│  │    skills/   │  │              │                  │
│  │              │  │  telegram_   │                  │
│  │  einstein/   │  │  lab-claw/   │  ← domain scope  │
│  │    identity  │  │    CLAUDE.md │  ← thin: scope + │
│  │    memory    │  │    memory.md │    agents to use  │
│  │    skills/   │  │              │                  │
│  │              │  │  telegram_   │                  │
│  │  marvin/     │  │  science-   │                  │
│  │    ...       │  │  claw/       │                  │
│  │              │  │    ...       │                  │
│  │  simon/      │  │              │                  │
│  │    ...       │  │  ...         │                  │
│  └──────────────┘  └──────────────┘                  │
│          │                  │                         │
│          ▼                  ▼                         │
│  ┌──────────────────────────────────────┐            │
│  │         Context Assembler            │            │
│  │  claire-digest + group memory +      │            │
│  │  agent identities + bus queue        │            │
│  └──────────────┬───────────────────────┘            │
│                 ▼                                     │
│  ┌──────────────────────────────────────┐            │
│  │         Apple Container              │            │
│  │                                      │            │
│  │  /workspace/group/      (group rw)   │            │
│  │  /workspace/global/     (shared ro)  │            │
│  │  /workspace/agents/     (agent dirs) │            │
│  │  .claude/skills/        (merged)     │            │
│  │                                      │            │
│  │  MCP: qmd, gmail, hindsight, etc.    │            │
│  └──────────────────────────────────────┘            │
└─────────────────────────────────────────────────────┘
```

## 1. Agent Directory Structure

Each named agent gets a directory at `data/agents/{name}/` containing all of their persistent state.

### 1.1 Agent Roster

| Agent | Role | Primary Groups | Purpose |
|-------|------|----------------|---------|
| **claire** | Chief of Staff | all (wildcard) | Orchestrator, generalist, user-facing lead |
| **einstein** | Research Scientist | science-claw, lab-claw | Literature, papers, grants, research synthesis |
| **simon** | CTO / Data Scientist | code-claw, science-claw | Code, pipelines, bioinformatics, tools |
| **marvin** | Executive Assistant | lab-claw, home-claw, claire (main) | Email, scheduling, travel, admin |
| **coo** | Lab Manager | lab-claw | Purchasing, onboarding, space, vendors |

### 1.2 Directory Layout

```
data/agents/{name}/
├── identity.md          # Persona, role, responsibilities, personality
├── memory.md            # Persistent working memory (cap: 200 lines)
├── trust.yaml           # Action permission levels
└── skills/              # Agent-specific skills
    └── {skill}/SKILL.md
```

**Design decision (from architecture review):** `state.md` is merged into `memory.md` as a `## Current Session` section that agents overwrite each session. This eliminates the ambiguous state/memory boundary and reduces the write paths from two to one. The existing `write_agent_state` IPC handler is extended to write `memory.md` (see Section 4.4).

### 1.3 identity.md Format

```yaml
---
name: Einstein
role: Research Scientist
lead: false
description: >
  Monitors the scientific landscape, synthesizes literature,
  tracks competing groups, writes grant sections, and maintains
  the lab's research knowledge base.
groups: [telegram_science-claw, telegram_lab-claw]
sender: Einstein
---

[Full persona prompt — personality, responsibilities, tool preferences,
 domain expertise, communication style. This replaces the TeamCreate
 prompt that currently lives inline in group CLAUDE.md files.]
```

Fields:
- `lead` — if `true`, this agent's memory.md is injected into every context packet (currently only Claire). This avoids hardcoding "claire" in the context assembler. The assembler reads all agent identities and injects memory for any agent with `lead: true`.
- `groups` — informational (the DB `agent_registry` table remains authoritative for runtime dispatch).
- `sender` — used for Telegram bot identity via `mcp__nanoclaw__send_message`.

### 1.4 memory.md Format

Each agent maintains their own persistent memory file:

```markdown
# Einstein — Memory

Last updated: 2026-04-13

## Current Session
[Overwritten each session with ephemeral state: active threads, in-progress work.
Agents clear and rewrite this section at session start.]
- Answering Mike's question about ChromBERT applicability to SFARI snATAC-seq

## Standing Instructions
- Track papers from Geschwind, Grove, Sestan, Talkowski groups
- Flag anything relevant to APA regulation (R01-MH137578)

## Active Threads
- SSC WGS CNV analysis — de novo ASD CNVs, STR calling extension
- Co-expression module framework — BUILD-OUT COMPLETE Apr 12

## Key Findings (last 30 days)
- 2026-04-12: markitdown installed for doc→md conversion
- 2026-04-08: Liu/Jessa Nature paper — Human Dev Multiomic Atlas

## Tools & Methods Tracked
- ChromBERT (Tongji Zhang Lab) — TF network foundation model
- GSFM (Ma'ayan Lab) — gene set foundation model
- PantheonOS — evolvable multi-agent genomics framework
```

**Cap: 150 lines.** Agents are instructed to prune old entries when approaching the limit. The host enforces a soft warning: if `memory.md` exceeds 200 lines at container spawn time, the context assembler injects `--- ⚠️ Memory file overlarge ({N} lines) — prune now ---` into the context packet. This provides a backstop for LLM discipline failures.

### 1.5 trust.yaml Format

```yaml
actions:
  send_message: notify
  publish_to_bus: autonomous
  write_vault: notify
  search_literature: autonomous
  write_agent_memory: autonomous
  schedule_task: notify
```

**Runtime enforcement (from security review):** trust.yaml is currently advisory only — the LLM sees it but the host doesn't check it before processing IPC requests. Phase 2 adds host-side enforcement for high-privilege IPC operations: `schedule_task`, `register_group`, and `publish_to_bus`. The IPC handler loads the calling agent's trust.yaml and gates the operation. Lower-privilege actions (`send_message`, `write_agent_memory`) remain advisory.

## 2. Claire's Unified Memory

Claire is special — she's the only agent who appears in every group. Her memory must be unified.

### 2.1 Claire's memory.md

Lives at `data/agents/claire/memory.md`. Contains:

- **User instructions** — things Mike has said ("from now on...", "always...", "never...")
- **Recent decisions** — last 20 decisions with dates
- **Active context** — what's currently in flight across all groups
- **Standing preferences** — communication style, scheduling rules learned from behavior

This file is:
- **Read** by the context assembler and injected into every context packet as `--- Lead Agent Memory ---` (for any agent with `lead: true` in identity.md frontmatter)
- **Written** by Claire inside the container via the new `write_agent_memory` IPC action (see Section 4.4)
- **Concurrency-safe** because containers write via IPC to the host, and the host processes IPC files sequentially in a single event loop

**Critical implementation note (from code review):** The existing `write_agent_state` IPC handler at `ipc.ts:782` hardcodes writes to `state.md` only, and requires compound keys (which Claire doesn't use in plain groups). A new `write_agent_memory` IPC action is required — see Section 4.4.

### 2.2 How It Replaces Per-Group "Claire Memory"

Currently, each group's `memory.md` mixes two things:
1. **Domain working state** — LAB-claw's pending emails, SCIENCE-claw's active analyses
2. **Claire's personal memory** — decisions, preferences, instructions

After the redesign:
- Domain working state stays in `groups/{folder}/memory.md` (unchanged)
- Claire's personal memory moves to `data/agents/claire/memory.md`
- Context packet injects both: Claire's memory + group memory

### 2.3 Context Packet Changes

Current sections (16KB max):
```
1. Date/time/timezone
2. Group memory.md (2000 chars)
3. current.md priorities (1500 chars)
4. Staleness warnings
5. Recent messages (last 30)
6. QMD knowledge search (2000 chars)
7. Scheduled tasks
8. Bus queue items
9. Classified events
10-13. Agent identity/state/trust/bus (compound groups only)
```

New sections:
```
1. Date/time/timezone
2. Lead agent memory.md (5000 chars)        ← NEW: unified lead agent memory
3. Group memory.md (3000 chars)             ← increased from 2000
4. current.md priorities (1500 chars)       ← unchanged
5. Staleness warnings                       ← unchanged
6. Memory overlength warnings               ← NEW: flags files >200 lines
7. Recent messages (last 30)                ← unchanged
8. QMD knowledge search (2000 chars)        ← unchanged
9. Scheduled tasks                          ← unchanged
10. Bus queue items                         ← unchanged
11. Classified events                       ← unchanged
12. Specialist agent identities summary     ← NEW: names + roles of available agents
```

**Max size increase:** 16KB → 24KB (`CONTEXT_PACKET_MAX_SIZE`). This provides headroom for the additional lead agent memory section and agent summary.

**Priority on conflict (from code review):** Lead agent memory appears before group memory. If they contain conflicting information, the later-appearing group memory will have higher recency weight in the LLM's attention. This is intentional — group-specific context should override general agent memory when they conflict (e.g., group formatting rules override agent defaults).

## 3. Group CLAUDE.md Refactoring

### 3.1 Three-Layer Instruction Model

Instructions are loaded from three sources, each with a clear purpose:

| Layer | File | Purpose | Size Target |
|-------|------|---------|-------------|
| **Global** | `groups/global/CLAUDE.md` | User profile, shared rules, memory architecture, formatting, danger zone | ~8KB |
| **Group** | `groups/{folder}/CLAUDE.md` | Domain scope, which agents to spawn, domain-specific rules, cross-group routing | ~2-4KB |
| **Agent** | `data/agents/{name}/identity.md` | Persona, responsibilities, tool preferences, communication style | ~1-2KB |

### 3.2 What Moves Where

**Currently in global CLAUDE.md (28KB) — keep or move:**

| Content | Stays in Global | Moves To |
|---------|:-:|---|
| User profile (name, contacts, scheduling rules) | ✅ | — |
| Personality & approach ("not a yes-man") | ✅ | — |
| Memory architecture (Hindsight, QMD, file-based) | ✅ | — |
| Danger zone rules | ✅ | — |
| Message formatting rules | ✅ | — |
| Container workspace docs | ✅ | — |
| People tracking instructions | ❌ | `data/agents/marvin/identity.md` |
| Vault writing instructions | ❌ | `data/agents/claire/identity.md` |
| Wiki knowledge base instructions | ❌ | `data/agents/claire/identity.md` |
| Morning briefing instructions | ❌ | group `telegram_claire/CLAUDE.md` |
| Agent Teams instructions (TeamCreate prompts) | ❌ | `data/agents/{name}/identity.md` |
| Managing groups instructions | ❌ | group `telegram_claire/CLAUDE.md` |

**Currently in group CLAUDE.md files — keep or move:**

| Content | Stays in Group | Moves To |
|---------|:-:|---|
| Scope definition ("this group is for...") | ✅ | — |
| Domain-specific danger zone rules | ✅ | — |
| Cross-group routing table | ✅ | — |
| Which agents to spawn | ✅ | — |
| Session start protocol | ✅ | — |
| Full TeamCreate prompts (500+ lines each) | ❌ | `data/agents/{name}/identity.md` |
| Email triage rules | ❌ | `data/agents/marvin/identity.md` |
| Scheduling rules (duplicated from global) | ❌ | Remove (already in global) |

### 3.3 New Group CLAUDE.md Template

```markdown
# Claire — {GROUP_NAME}

## Scope
{One paragraph defining what this group handles and what belongs elsewhere.}

## Agents
On the first message of each session, spawn these specialists:

- **Einstein** — `/workspace/agents/einstein/identity.md`
- **Simon** — `/workspace/agents/simon/identity.md`

As Claire, you coordinate them: assign work by expertise,
synthesize updates, don't duplicate their work.

## Domain Rules
{2-5 domain-specific rules that don't belong in global or agent files.}

## Cross-Group Routing
At the start of each session, check for incoming messages with `bus_read`.

| Topic | Route to | Examples |
|-------|----------|---------|
| ... | ... | ... |

Use `bus_publish(topic, finding, action_needed, priority)` to send.
```

This reduces group CLAUDE.md from 16-20KB to ~2-4KB.

### 3.4 How Agent Spawning Changes

**Current (TeamCreate inline):**
```
# In telegram_science-claw/CLAUDE.md (500 lines for two agents):
### Einstein — Research Scientist
Create via TeamCreate with these instructions:
"""
You are Einstein, a research scientist on Mike Gandal's team...
[200 lines of inline prompt]
"""
```

**New (reference to identity file):**
```
# In telegram_science-claw/CLAUDE.md (5 lines):
## Agents
On the first message of each session, spawn these specialists:
- **Einstein** — read `/workspace/agents/einstein/identity.md` for full instructions
- **Simon** — read `/workspace/agents/simon/identity.md` for full instructions
```

The agent reads the identity.md file from the mounted agent directory and uses it as the TeamCreate prompt. This means:
- One source of truth per agent (not duplicated across groups)
- Agent updates propagate to all groups automatically
- Agent memory and skills travel with the identity

**Reliability enhancement (from code review):** Relying on the LLM to faithfully read a file and use its full content as a TeamCreate prompt is a prompt-engineering dependency. To make this more robust, the context assembler injects a summary of each registered specialist into the context packet (Section 2.3, item 12): `--- Available Specialists ---\nEinstein (Research Scientist): /workspace/agents/einstein/identity.md\nSimon (CTO): /workspace/agents/simon/identity.md`. This primes the agent with agent names and paths. The full identity.md content is still read from the file at TeamCreate time, but the context packet ensures the agent knows which files to read and what each specialist does.

## 4. Container Mount Changes

### 4.1 Current Mounts

| Container Path | Host Path | Access |
|---|---|---|
| `/workspace/group` | `groups/{folder}/` | read-write |
| `/workspace/global` | `groups/global/` | ro (non-main) / rw (main) |
| `/workspace/ipc` | `data/ipc/{folder}/` | read-write |
| `.claude/` | `data/sessions/{folder}/.claude/` | read-write |

### 4.2 New Mount

**Replace** the existing `/workspace/agent` (singular) mount for compound groups with a new `/workspace/agents` (plural) mount for all containers:

| Container Path | Host Path | Access |
|---|---|---|
| `/workspace/agents` | `data/agents/` | **read-only** |

**Critical fix (from code review):** The existing code at `container-runner.ts:301` mounts a single agent directory at `/workspace/agent` (singular). The new `/workspace/agents` (plural) would create a virtiofs prefix collision — Apple Container rejects mounts where one path is a prefix of another. The fix is to **remove** the old singular mount and **replace** it with the new plural mount. All references to `/workspace/agent` in `ipc.ts` file-path resolution must be updated to `/workspace/agents/{agentName}`.

**Read-only mount (from security review):** The mount MUST be read-only. If rw, any container process could directly write to `claire/identity.md` or any agent's memory, bypassing IPC validation entirely. All agent memory writes go through the new `write_agent_memory` IPC action (Section 4.4), which the host processes on its side of the mount boundary.

### 4.4 New IPC Action: `write_agent_memory`

**Critical addition (from code/security review):** The existing `write_agent_state` IPC handler has two blockers:
1. It hardcodes writes to `state.md` only — no path to write `memory.md`
2. It requires compound keys (`telegram_lab-claw--einstein`) — Claire can't use it from plain groups

New IPC action:

```typescript
case 'write_agent_memory': {
  const agentName = d.agent_name;  // explicit, not derived from compound key
  // Validate: agentName must exist in data/agents/ and be registered for this group
  // Validate: agentName contains no path separators or '..'
  const memoryPath = path.join(AGENTS_DIR, agentName, 'memory.md');
  // Atomic write: temp file + rename
  const content = typeof d.content === 'string' ? d.content : '';
  if (d.append) {
    // Append mode: add to end of file
    fs.appendFileSync(memoryPath, '\n' + content);
  } else {
    // Overwrite mode: replace entire file
    const tmp = `${memoryPath}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, memoryPath);
  }
}
```

Authorization rules:
- The `agent_name` parameter must match an agent registered for the source group's folder (checked via `agent_registry` DB)
- OR the source group must be the main group (which can write to any agent)
- Path traversal is rejected (`..`, `/` in agent_name)

**Trust enforcement (from security review):** Before processing, load the agent's `trust.yaml` and check that `write_agent_memory` is `autonomous` or `notify`. If the trust level is `ask` or `draft`, reject the write and log a warning.

### 4.3 Skill Sync Order

Skills are synced to `.claude/skills/` at container spawn time:

```
1. Container skills (container/skills/)          ← base layer
2. Agent skills (data/agents/{name}/skills/)     ← agent-specific
3. Group skills (groups/{folder}/skills/)         ← group-specific (highest priority)
```

When Einstein is spawned in SCIENCE-claw:
- He gets container skills (browser, status, etc.)
- He gets his own skills (from `data/agents/einstein/skills/`)
- He gets SCIENCE-claw's group skills (research skills)

When Einstein is spawned in LAB-claw:
- He gets container skills
- He gets his own skills (same as above — portable)
- He gets LAB-claw's group skills (if any)

Einstein's agent-level skills follow him everywhere. Group skills add domain context.

**Implementation:** In `container-runner.ts`, after copying container skills and before copying group skills, query the `agent_registry` DB for ALL agents with `enabled=1` for this group's folder (or wildcard `*`). Copy each agent's `skills/` directory into the session's `.claude/skills/`. This must copy ALL registered agents' skills, not just the directly-addressed agent, because specialist dispatch (which agents Claire will TeamCreate) happens inside the container at runtime — the host doesn't know which specialists will be spawned.

**Explicit decision (from architecture review):** Einstein and Simon are spawned as sub-agents via TeamCreate inside Claire's container, not as separate containers. This is correct for the current scale (5 agents, 1 user). Separate containers per agent would add ~30s startup latency per specialist and double resource consumption. This decision should not be revisited unless the agent count exceeds ~10 or multi-user support is added.

## 5. Agent Registry Consolidation

### 5.1 Single Source of Truth

The `agent_registry` DB table becomes the authoritative mapping of agents to groups:

```sql
-- Current state (keep, extend):
agent_registry (
  agent_name TEXT,      -- 'einstein'
  group_folder TEXT,    -- 'telegram_science-claw' or '*'
  enabled INTEGER,      -- 1 or 0
  added_at TEXT
)
```

Current rows:
```
claire      | *                       | 1
einstein    | telegram_lab-claw       | 1
einstein    | telegram_science-claw   | 1
jennifer    | telegram_claire         | 1
jennifer    | telegram_lab-claw       | 1
jennifer    | telegram_home-claw      | 1
```

New rows to add:
```
simon       | telegram_code-claw      | 1
simon       | telegram_science-claw   | 1
marvin      | telegram_lab-claw       | 1
marvin      | telegram_home-claw      | 1
marvin      | telegram_claire         | 1
coo         | telegram_lab-claw       | 1
```

Rows to remove:
```
jennifer    | *                       | (jennifer is being merged into marvin)
```

### 5.2 Jennifer → Marvin Merge

Jennifer and Marvin have overlapping responsibilities (email, scheduling, travel). In practice, Marvin is the one defined in TeamCreate prompts and actively used. Jennifer exists only in `data/agents/` identity files and is barely referenced.

**Decision:** Merge Jennifer's capabilities into Marvin. Marvin becomes the unified executive/personal assistant:

- **In LAB-claw**: Focus on work email (pennmedicine), scheduling, grants admin, letters of recommendation
- **In HOME-claw**: Focus on personal email (gmail), personal errands, family logistics
- **In CLAIRE (main)**: Available for any email/scheduling task

The scope adaptation is handled in Marvin's identity.md with a section:

```markdown
## Scope by Group
- **LAB-claw**: Work email (pennmedicine), professional scheduling, grants, HR
- **HOME-claw**: Personal email (gmail), personal errands, family logistics
- **CLAIRE (main)**: Any email or scheduling task Mike requests
```

## 6. Memory Architecture

### 6.1 Memory Layers (Priority Order)

| Layer | Location | Scope | Written By | Read By |
|-------|----------|-------|-----------|---------|
| **Agent memory** | `data/agents/{name}/memory.md` | Per-agent, cross-group | Agent via IPC | Context assembler + agent |
| **Group memory** | `groups/{folder}/memory.md` | Per-group domain state | Agent in container | Context assembler + agent |
| **Global state** | `groups/global/state/*.md` | All groups | Main agent only | Context assembler (current.md) + agent |
| **Hindsight** | MCP server (port 8889) | All groups (shared bank) | Agent via MCP | Agent via MCP |
| **Honcho** | MCP server (port 8010) | All groups (shared workspace) | Auto-fed from conversations | Agent via MCP |
| **QMD** | MCP server (port 8181) | All groups (shared index) | Sync pipeline | Context assembler + agent |

### 6.2 What Goes Where

| Information Type | Stored In | Why |
|---|---|---|
| User preferences ("always do X") | `agents/claire/memory.md` | Claire is the one who receives these; shared across groups |
| Decisions made in conversation | `agents/{who}/memory.md` | The agent who made/learned the decision owns it |
| Pending tasks for a domain | `groups/{folder}/memory.md` | Domain-specific, not agent-specific |
| Paper findings | `agents/einstein/memory.md` | Einstein's expertise accumulates |
| Email thread status | `agents/marvin/memory.md` | Marvin tracks email state |
| Lab ops status | `agents/coo/memory.md` | COO tracks purchasing, onboarding |
| Top priorities and deadlines | `groups/global/state/current.md` | Shared across all groups |
| Research context (grants, lab roster) | `groups/global/state/*.md` | Shared reference data |

### 6.3 Session Start Protocol (Revised)

Every session, the agent container starts with:

1. **Context packet** (auto-injected, no agent action needed):
   - Claire's memory.md (from `data/agents/claire/memory.md`)
   - Group memory.md (from `groups/{folder}/memory.md`)
   - current.md priorities
   - Recent messages, bus queue, QMD search results

2. **Agent reads** (instructed in CLAUDE.md, agent-initiated):
   - Own memory.md: `/workspace/agents/{self}/memory.md`
   - Hindsight recall (if available — bonus, not required)
   - Global state files as needed

3. **Agent writes** (at session end):
   - Update own memory.md via `write_agent_memory` IPC (Section 4.4)
   - Update group memory.md (domain state) via direct file write to `/workspace/group/memory.md`
   - Retain to Hindsight (if available — bonus, not required)

### 6.4 Hindsight/Honcho as Bonus Layers

These remain configured and available but are explicitly **not required**:

- If Hindsight is up: agents retain and recall as a supplement to file-based memory
- If Hindsight is down: agents rely on memory.md files (no degradation in core function)
- If Honcho is up: conversation context is auto-enriched
- If Honcho is down: agents rely on recent messages in context packet

The CLAUDE.md instructions change from "MANDATORY: recall from Hindsight" to "If Hindsight is available, recall for additional context. Your memory.md is the primary source of truth."

## 7. Cross-Group Coordination

### 7.1 Message Bus (Already Built, Now Formalized)

The message bus at `data/bus/` is the primary async coordination mechanism. Cross-group routing tables (already being added to group CLAUDE.md files) formalize what was previously ad-hoc.

Each group's CLAUDE.md includes a routing table:

```markdown
## Cross-Group Routing
| Topic | Route to | Examples |
|-------|----------|---------|
| Papers, preprints | telegram_science-claw | New GWAS paper |
| Pipeline tools, code | telegram_code-claw | New bioinformatics tool |
| Infrastructure | telegram_ops-claw | QMD index update |
| Knowledge curation | telegram_vault-claw | Item for wiki |
| Urgent / cross-cutting | telegram_claire | Needs Mike's judgment |
```

### 7.2 Context Assembler Cross-Group Injection

The context assembler already injects bus queue items into the context packet. No changes needed — this mechanism works.

### 7.4 Bus Authorization (from security review)

The current `publish_to_bus` IPC handler accepts messages to any target group without authorization checks. This is an escalation risk: a compromised agent in a low-privilege group could publish messages that trigger actions in the main group.

**Fix:** Add authorization to `publish_to_bus`:
- Non-main groups can only publish to groups listed in their cross-group routing table (defined in CLAUDE.md, enforced by checking an allowlist in the DB or a config file)
- Main group can publish to any group
- All bus messages are tagged with `<agent-bus-message source="{agent}">` fencing so the receiving agent knows the content is agent-produced, not user-authoritative

### 7.3 Shared Agent Memory as Coordination

Because all agent memory directories are mounted at `/workspace/agents/`, any agent in any group can read other agents' memory files:

- Claire in LAB-claw can read `/workspace/agents/einstein/memory.md` to see what Einstein found recently
- Einstein in SCIENCE-claw can read `/workspace/agents/marvin/memory.md` to check if Marvin is tracking a grant deadline

This is **read-only coordination** — agents don't write to each other's memory files.

## 8. knowledge-graph.md Disposition

The current `groups/global/state/knowledge-graph.md` (338KB, 3,870 lines) is:
- Not referenced by any runtime code
- Full of noisy, duplicate, low-confidence entity extractions
- 11 days stale

**Action:** Delete this file. Its function is better served by:
- Agent memory files (Einstein tracks papers/datasets, Marvin tracks contacts)
- QMD (semantic search over 3,600+ documents)
- The Obsidian vault wiki (curated knowledge)

If a structured knowledge graph is desired in the future, it should be:
- Per-agent (Einstein's research graph, Marvin's contacts graph)
- Curated (agents prune and deduplicate, not raw extraction)
- Capped (200 lines per file, like memory.md)

## 9. Slack Coordination

### 9.1 Current State

- `slack:D0AQ09RSF1B` (Claire DM) → maps to `telegram_claire` folder (shared)
- `slack:C0ABVNZLA0L` (LAB-slack) → maps to `slack_lab` folder (separate)

### 9.2 Change

Point `slack:C0ABVNZLA0L` to use folder `telegram_lab-claw` instead of `slack_lab`:

```sql
UPDATE registered_groups
SET folder = 'telegram_lab-claw'
WHERE jid = 'slack:C0ABVNZLA0L';
```

This means Slack LAB and Telegram LAB-claw share:
- The same group memory.md
- The same conversation context
- The same agent registry (same specialists available)

Slack-specific formatting is handled by the channel adapter (already implemented in `slack.ts`) — the agent checks the group folder prefix or channel type to determine formatting.

Before archiving `slack_lab/`, merge any content from `slack_lab/memory.md` (204 bytes) into `telegram_lab-claw/memory.md`. Then archive `slack_lab/` to `slack_lab.archived/`.

**Context interleaving (from architecture review):** After this merge, the context assembler's last-30-messages section will interleave Slack and Telegram messages in the same context packet. This is acceptable — the messages are tagged with sender metadata that indicates channel origin. If this causes confusion in practice, the assembler can add a channel prefix (`[slack]` / `[telegram]`) to each message in the context packet.

## 10. Migration Plan (High-Level)

### Phase 1: Agent Directories (Low Risk)
1. Create `data/agents/simon/`, `data/agents/marvin/`, `data/agents/coo/` directories
2. Write identity.md for each by consolidating TeamCreate prompts
3. Create empty memory.md and trust.yaml for each
4. Merge Jennifer into Marvin; remove `data/agents/jennifer/`
5. Update `agent_registry` DB table with new rows
6. Move group-level skills to appropriate agent skill directories

### Phase 2: Container & IPC Changes (Medium Risk)
7. Remove existing `/workspace/agent` (singular) mount; add `/workspace/agents` (plural, read-only) in `container-runner.ts`
8. Update ipc.ts path resolution: `/workspace/agent/` → `/workspace/agents/{agentName}/`
9. Implement `write_agent_memory` IPC action in ipc.ts (Section 4.4)
10. Add trust.yaml enforcement for `schedule_task`, `register_group`, `publish_to_bus` in IPC handler
11. Add `publish_to_bus` authorization checks (Section 7.4)
12. Add agent skill sync step in container-runner.ts (copy ALL registered agents' skills)
13. Update context-assembler.ts: inject lead agent memory.md (by `lead: true` frontmatter), add memory overlength warnings, add specialist summary, bump max size to 24KB
14. Test with one group (e.g., SCIENCE-claw) before rolling out

### Phase 3: CLAUDE.md Refactoring (High Risk — Most Impactful)
15. Split existing group memory.md files: extract Claire's personal memory (decisions, preferences, instructions) into `data/agents/claire/memory.md`; leave domain state (pending tasks, active analyses) in group memory.md
16. Seed specialist agent memory.md files from relevant sections of group memory.md (e.g., Einstein gets paper findings from SCIENCE-claw's memory, Marvin gets email thread status from LAB-claw's memory)
17. Refactor `groups/global/CLAUDE.md`: extract agent-specific instructions
18. Refactor each group CLAUDE.md: replace inline TeamCreate prompts with identity.md references
19. Update session start protocol: MD-first, Hindsight as bonus
20. Add cross-group routing tables to remaining groups
21. **Behavioral smoke tests**: for each refactored group, send 3-5 test messages covering key behaviors and verify expected response types before proceeding to the next group

### Phase 4: Cleanup
22. Delete `groups/global/state/knowledge-graph.md`
23. Merge `slack_lab/memory.md` content into `telegram_lab-claw/memory.md`, then archive `slack_lab/` folder
24. Update registered_groups DB: point `slack:C0ABVNZLA0L` to folder `telegram_lab-claw`
25. Update this project's MEMORY.md with new architecture notes

## 11. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| CLAUDE.md refactoring drops critical instructions | High | Diff every change against original. Keep originals as `.bak`. **Behavioral smoke tests**: after refactoring each group, send 3-5 test messages covering key behaviors (email triage, paper search, scheduling) and verify expected response type before proceeding to the next group. |
| Agent memory.md grows unbounded | Medium | 150-line cap in instructions. Host injects warning into context packet if file exceeds 200 lines. |
| Mount path collision (`/workspace/agent` vs `/workspace/agents`) | High | Remove the existing singular mount entirely. Replace with plural. Update all ipc.ts path references. Test compound-group containers specifically. |
| `write_agent_memory` IPC doesn't exist yet | High | Must be implemented in Phase 2 before any CLAUDE.md changes in Phase 3. Without it, agents cannot persist memory. |
| Cross-agent memory read exposes sensitive data | Medium | Mount is read-only (agents can't modify each other). Agent memory should not contain PHI or credentials. CLINIC-claw agents should not write patient-adjacent info to agent memory — only to group memory (which is group-isolated). |
| Bus message injection from low-privilege groups | Medium | Add `publish_to_bus` authorization (Section 7.4). Fence bus content with `<agent-bus-message>` tags. |
| Jennifer references in codebase | Low | Update these files during Phase 1: `message-bus.test.ts`, `ipc.test.ts`, `agent-registry.test.ts`, `compound-key.test.ts`, `data/agents/claire/identity.md` (references "Your team: Einstein, Jennifer"). |
| Concurrent writes to agent memory via IPC | Low | IPC is processed sequentially by the host event loop. Atomic temp+rename prevents corruption. |
| Identity.md not found at spawn time | Low | Graceful fallback: if `/workspace/agents/{name}/identity.md` doesn't exist, agent logs warning and operates with group CLAUDE.md only. |
| Skill sync order conflicts | Low | Document priority clearly: container < agent < group. Last writer wins within `.claude/skills/`. |

## 12. Success Criteria

1. **Claire remembers across groups** — tell her something in MAIN, she knows it in LAB-claw next session
2. **Einstein is Einstein everywhere** — spawned in SCIENCE-claw or LAB-claw, he has his research memory and skills
3. **Role clarity** — each group CLAUDE.md is <4KB and clearly states scope + agents
4. **No Hindsight dependency** — system works identically with Hindsight up or down
5. **No duplicate agent definitions** — each agent defined in exactly one identity.md file

## Appendix: File Size Budget

| File | Current Size | Target Size |
|------|-------------|-------------|
| `groups/global/CLAUDE.md` | 28 KB | ~8 KB |
| `groups/telegram_claire/CLAUDE.md` | 20 KB | ~4 KB |
| `groups/telegram_lab-claw/CLAUDE.md` | 16 KB | ~3 KB |
| `groups/telegram_science-claw/CLAUDE.md` | 16 KB | ~3 KB |
| `data/agents/claire/identity.md` | 0.3 KB | ~3 KB |
| `data/agents/einstein/identity.md` | 0.3 KB | ~2 KB |
| `data/agents/marvin/identity.md` | (new) | ~2 KB |
| `data/agents/simon/identity.md` | (new) | ~2 KB |
| `data/agents/coo/identity.md` | (new) | ~1.5 KB |
| Context packet max | 16 KB | 24 KB |

**Total CLAUDE.md loaded per session (before):** ~48 KB (global + group)
**Total loaded per session (after):** ~14 KB (global + group + agent identities)

Savings: ~34 KB per session = fewer tokens = lower cost = more room for actual conversation.
