# Agent Architecture Redesign — "One Claire, Portable Specialists"

**Date:** 2026-04-13
**Status:** Draft — awaiting user review
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
├── skills/              # Agent-specific skills
│   └── {skill}/SKILL.md
└── state.md             # Ephemeral session state (current threads, etc.)
```

### 1.3 identity.md Format

```yaml
---
name: Einstein
role: Research Scientist
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

The `groups` field is informational (the DB `agent_registry` table remains authoritative for runtime dispatch). The `sender` field is used for Telegram bot identity via `mcp__nanoclaw__send_message`.

### 1.4 memory.md Format

Each agent maintains their own persistent memory file:

```markdown
# Einstein — Memory

Last updated: 2026-04-13

## Standing Instructions
- Track papers from Geschwind, Grove, Sestan, Talkowski groups
- Flag anything relevant to APA regulation (R01-MH137578)

## Active Threads
- SSC WGS CNV analysis — de novo ASD CNVs, STR calling extension
- Co-expression module framework — BUILD-OUT COMPLETE Apr 12

## Key Findings (last 30 days)
- 2026-04-12: markitdown installed for doc→md conversion
- 2026-04-08: Liu/Jessa Nature paper — Human Dev Multiomic Atlas
- ...

## Tools & Methods Tracked
- ChromBERT (Tongji Zhang Lab) — TF network foundation model
- GSFM (Ma'ayan Lab) — gene set foundation model
- PantheonOS — evolvable multi-agent genomics framework
```

**Cap: 200 lines.** Agents are instructed to prune old entries when approaching the limit. The host does not enforce this — it's agent-maintained.

### 1.5 trust.yaml Format (unchanged)

```yaml
actions:
  send_message: notify
  publish_to_bus: autonomous
  write_vault: notify
  search_literature: autonomous
  write_agent_state: autonomous
  schedule_task: notify
```

## 2. Claire's Unified Memory

Claire is special — she's the only agent who appears in every group. Her memory must be unified.

### 2.1 Claire's memory.md

Lives at `data/agents/claire/memory.md`. Contains:

- **User instructions** — things Mike has said ("from now on...", "always...", "never...")
- **Recent decisions** — last 20 decisions with dates
- **Active context** — what's currently in flight across all groups
- **Standing preferences** — communication style, scheduling rules learned from behavior

This file is:
- **Read** by the context assembler and injected into every context packet as `--- Claire Memory ---`
- **Written** by Claire inside the container via `write_agent_state` IPC (already exists)
- **Concurrency-safe** because containers write via IPC to the host, and the host processes IPC files sequentially in a single event loop

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
2. Claire's memory.md (2000 chars)          ← NEW: unified Claire memory
3. Group memory.md (2000 chars)             ← unchanged
4. current.md priorities (1500 chars)       ← unchanged
5. Staleness warnings                       ← unchanged
6. Recent messages (last 30)                ← unchanged
7. QMD knowledge search (2000 chars)        ← unchanged
8. Scheduled tasks                          ← unchanged
9. Bus queue items                          ← unchanged
10. Classified events                       ← unchanged
11. Specialist agent identities summary     ← NEW: names + roles of available agents
```

**Max size increase:** 16KB → 24KB (`CONTEXT_PACKET_MAX_SIZE`). This provides headroom for the additional Claire memory section and agent summary.

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

## 4. Container Mount Changes

### 4.1 Current Mounts

| Container Path | Host Path | Access |
|---|---|---|
| `/workspace/group` | `groups/{folder}/` | read-write |
| `/workspace/global` | `groups/global/` | ro (non-main) / rw (main) |
| `/workspace/ipc` | `data/ipc/{folder}/` | read-write |
| `.claude/` | `data/sessions/{folder}/.claude/` | read-write |

### 4.2 New Mount

Add one new mount for all containers:

| Container Path | Host Path | Access |
|---|---|---|
| `/workspace/agents` | `data/agents/` | **read-write** |

All agent directories are mounted together. Any agent running in the container can:
- Read all agent identities and memories (for coordination)
- Write to their own `memory.md` and `state.md` (via the existing `write_agent_state` IPC mechanism)

**Why read-write for the whole directory?** The IPC `write_agent_state` handler already validates the agent name and writes atomically. Agents inside the container don't write directly to the filesystem — they go through IPC. The mount being rw allows the IPC handler on the host to write back. (If this is a concern, the mount can be ro and all writes go through IPC exclusively.)

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

**Implementation:** In `container-runner.ts`, after copying container skills and before copying group skills, iterate over the agents registered for this group and copy their skill directories.

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
   - Update own memory.md via `write_agent_state` IPC
   - Update group memory.md (domain state) via direct file write
   - Retain to Hindsight (if available — bonus)

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

The `slack_lab/` folder can be archived after migration.

## 10. Migration Plan (High-Level)

### Phase 1: Agent Directories (Low Risk)
1. Create `data/agents/simon/`, `data/agents/marvin/`, `data/agents/coo/` directories
2. Write identity.md for each by consolidating TeamCreate prompts
3. Create empty memory.md and trust.yaml for each
4. Merge Jennifer into Marvin; remove `data/agents/jennifer/`
5. Update `agent_registry` DB table with new rows
6. Move group-level skills to appropriate agent skill directories

### Phase 2: Container Mounts (Medium Risk)
7. Add `/workspace/agents` mount in `container-runner.ts`
8. Add agent skill sync step in container-runner.ts
9. Update context-assembler.ts: inject Claire's memory.md, bump max size to 24KB
10. Test with one group (e.g., SCIENCE-claw) before rolling out

### Phase 3: CLAUDE.md Refactoring (High Risk — Most Impactful)
11. Split existing group memory.md files: extract Claire's personal memory (decisions, preferences, instructions) into `data/agents/claire/memory.md`; leave domain state (pending tasks, active analyses) in group memory.md
12. Seed specialist agent memory.md files from relevant sections of group memory.md (e.g., Einstein gets paper findings from SCIENCE-claw's memory, Marvin gets email thread status from LAB-claw's memory)
13. Refactor `groups/global/CLAUDE.md`: extract agent-specific instructions
14. Refactor each group CLAUDE.md: replace inline TeamCreate prompts with identity.md references
15. Update session start protocol: MD-first, Hindsight as bonus
16. Add cross-group routing tables to remaining groups

### Phase 4: Cleanup
17. Delete `groups/global/state/knowledge-graph.md`
18. Merge `slack_lab` into `telegram_lab-claw` (DB update + archive folder)
19. Update this project's MEMORY.md with new architecture notes

## 11. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| CLAUDE.md refactoring drops critical instructions | High | Diff every change against original. Test each group independently. Keep originals as `.bak` until verified. |
| Agent memory.md grows unbounded | Medium | 200-line cap in instructions. Host-side warning if file exceeds 300 lines. |
| Concurrent writes to agent memory via IPC | Low | IPC is processed sequentially by the host event loop. Atomic temp+rename prevents corruption. |
| Identity.md not found at spawn time | Low | Graceful fallback: if `/workspace/agents/{name}/identity.md` doesn't exist, agent logs warning and operates with group CLAUDE.md only. |
| Increased container mount count | Low | Apple Container handles directory mounts well. One new mount (`/workspace/agents/`) adds minimal overhead. |
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
