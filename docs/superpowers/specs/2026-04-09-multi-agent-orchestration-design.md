# Multi-Agent Orchestration for NanoClaw

**Date:** 2026-04-09
**Status:** Approved
**Branch:** feature/multi-agent-orchestration

## Overview

Port multi-agent orchestration concepts from OpenClaw into NanoClaw without importing OpenClaw's code or complexity. This adds three capabilities:

1. **Persistent agent identities** — Named agents (Claire, Jennifer, Einstein) with personas, trust levels, and working memory that persist across sessions
2. **Inter-agent coordination** — Sync handoffs (urgent, via Agent Teams) and async messaging (routine, via message bus)
3. **Reliable delivery** — At-least-once message delivery between agents with action logging

The core architectural decision is **"Agents as Lightweight Groups"**: each agent invocation within a group creates a compound key (`{groupFolder}:{agentName}`) that reuses all existing NanoClaw infrastructure — sessions, IPC, health monitoring, task scheduling, warm pool — with zero changes to downstream systems.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent-to-group relationship | Agents live within groups, some float across groups | Groups are conversation context; agents are capabilities |
| Coordination model | Hybrid sync/async based on urgency | Sync for real-time needs (Agent Teams); async for routine (bus) |
| Persistence model | Warm pool (on-demand + idle window) | Balances responsiveness and resource cost |
| Autonomy visibility | Notify-on-action | Agents act freely; user sees the stream without gating it |
| Initial roster | Claire, Jennifer, Einstein | Core trio covers orchestration, operations, research |
| Identity storage | Top-level `agents/` directory | First-class concept; editable, mountable, versionable, discoverable |
| Architectural approach | Compound group keys reusing existing infrastructure | Maximum reuse; zero changes to 6+ core modules |

## 1. Agent Identity & Registry

### Identity Files

Each agent lives in `agents/{name}/`:

```
agents/
├── claire/
│   ├── identity.md        # Persona, instructions, communication style
│   ├── trust.yaml         # Per-action autonomy levels
│   └── state.md           # Working memory (persists across sessions)
├── jennifer/
│   ├── identity.md
│   ├── trust.yaml
│   └── state.md
└── einstein/
    ├── identity.md
    ├── trust.yaml
    └── state.md
```

### identity.md Format

YAML frontmatter + markdown body (same pattern as group CLAUDE.md files):

```yaml
---
name: Einstein
role: Research Scientist
description: Monitors scientific landscape, synthesizes literature, writes grant sections
model: default
urgent_topics:
  - grant_deadline
  - competing_publication
routine_topics:
  - new_paper
  - dataset_update
  - tool_release
---

You are Einstein, the research scientist on Mike's executive AI team...
[persona instructions, capabilities, constraints]
```

### trust.yaml Format

Per-action autonomy levels:

```yaml
actions:
  write_vault:        autonomous
  send_message:       notify
  send_email:         draft
  schedule_meeting:   ask
```

Four trust levels:

| Level | Meaning |
|-------|---------|
| `autonomous` | Act freely, no notification |
| `notify` | Act freely, post notification to chat |
| `draft` | Prepare action, present to user for approval |
| `ask` | Don't act, ask user for permission first |

### state.md

Free-form markdown maintained by the agent itself during runs. Contains active threads, recent findings, things being tracked. Persists across sessions via the mounted `agents/{name}/` directory. Shared across all groups that invoke this agent.

### Agent Registry (SQLite)

```sql
CREATE TABLE agent_registry (
  agent_name TEXT NOT NULL,
  group_folder TEXT NOT NULL,     -- '*' means available to all groups
  enabled INTEGER DEFAULT 1,
  added_at TEXT NOT NULL,
  PRIMARY KEY (agent_name, group_folder)
);
```

On startup, the system scans `agents/` for identity files and populates the registry. The registry tracks which agents are available to which groups. Claire is registered to all groups by default (orchestrator).

## 2. Compound Groups & Container Lifecycle

### Compound Group Keys

When an agent is invoked within a group, the system creates a compound key:

```
{groupFolder}:{agentName}
```

Examples:
- `telegram_lab-claw:einstein` — Einstein summoned in LAB-claw
- `telegram_science-claw:einstein` — Same identity, different context
- `telegram_lab-claw:jennifer` — Jennifer summoned in LAB-claw

Groups without agent invocation use plain keys (no change to existing behavior).

**Filesystem encoding:** Colons are unsafe in some filesystems. Compound keys use `:` in memory (SQLite, GroupState map keys, log output) but `--` on the filesystem (IPC directories, bus queue directories). Helper functions `compoundKey(group, agent)` and `compoundKeyToFsPath(key)` handle the conversion.

### Container Mounts

Compound group containers get an additional mount:

```
/workspace/group/       → groups/{groupFolder}/            (read-write)
/workspace/agent/       → agents/{agentName}/              (read-write)
/workspace/global/      → groups/global/                   (read-only for non-main)
/workspace/ipc/         → data/ipc/{groupFolder}--{agent}/ (isolated)
```

The agent's `identity.md` is loaded into the context packet alongside the group's `CLAUDE.md`.

### Warm Pool

Extends existing GroupState in `group-queue.ts`:

```typescript
interface GroupState {
  // ... existing fields ...
  agentName?: string;          // which agent this state belongs to
}
```

Lifecycle:
1. Agent invoked → spawn container for compound key
2. Work completes → enter idle state (existing IDLE_TIMEOUT)
3. New work within timeout → reuse warm container via IPC input
4. Timeout expires → container shuts down, GroupState cleared
5. Next invocation → cold start with session resume

### Concurrency

MAX_CONCURRENT_CONTAINERS (5) applies globally across all compound groups. Additional requests queue in GroupQueue (existing behavior).

### Session Isolation

Each compound group gets its own session in SQLite. Einstein in LAB-claw and Einstein in SCIENCE-claw have separate sessions — same persona, different conversation histories. Shared state across instances lives in `agents/einstein/state.md`.

## 3. Agent Routing & Invocation

### Three Invocation Modes

**1. Explicit invocation** — User mentions `@AgentName` in message. Message handler scans for agent name patterns against the group's registered agents. If matched, routes to compound group.

**2. Claire-mediated routing** — General messages go to Claire (default agent for groups where she's registered). Claire decides whether to handle it herself or delegate to a specialist via sync Agent Teams (urgent) or bus message (routine).

**3. Bus-triggered invocation** — An agent publishes a bus message with `to_agent` field. Bus watcher spawns or wakes the target compound group container and delivers the message.

### Message Handler Flow

```
Message arrives
  → Is there an @AgentName mention?
    → Yes: route to {group}:{agent}
    → No: is Claire registered for this group?
      → Yes: route to {group}:claire
      → No: route to {group} (legacy, no agent)
```

Backward compatible — groups without registered agents behave as today.

### Context Packet Extensions

When building context for a compound group, the context assembler adds:

1. Agent identity (from `identity.md`)
2. Agent state (from `state.md`)
3. Agent trust matrix (from `trust.yaml`)
4. Available peers (other agents registered in this group, with descriptions)
5. Pending bus messages addressed to this agent

## 4. Inter-Agent Coordination & Message Bus

### Coordination Paths

**Sync (urgent):** Agent uses Claude Code Agent Teams to spawn a subagent with the target agent's identity within the same container. Already supported via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. No new code; driven by identity.md instructions and `urgent_topics` configuration.

**Async (routine):** Agent publishes to the message bus via new IPC tool. Target agent picks it up on the next bus poll cycle.

### New IPC Tool: publish_to_bus

Added to `container/agent-runner/src/ipc-mcp-stdio.ts`:

```typescript
{
  name: "publish_to_bus",
  inputSchema: {
    type: "object",
    properties: {
      to_agent:  { type: "string" },     // target agent name
      to_group:  { type: "string" },     // target group (optional, defaults to current)
      topic:     { type: "string" },     // message topic
      priority:  { type: "string", enum: ["low", "medium", "high"] },
      summary:   { type: "string" },     // human-readable description
      payload:   { type: "object" }      // structured data
    },
    required: ["to_agent", "topic", "summary"]
  }
}
```

### Bus Message Processing

The existing message bus (`src/message-bus.ts`) gains agent-addressed routing:

- Messages with `to_agent` go into `data/bus/agents/{group}--{agent}/queue.json`
- New bus watcher loop (`src/bus-watcher.ts`) polls every BUS_POLL_INTERVAL (30 seconds)
- For each compound group with pending items: deliver to warm container or spawn new one
- High-priority messages get immediate dispatch (5-second poll)
- Respects MAX_CONCURRENT_CONTAINERS limit

### Delivery Guarantees

At-least-once delivery:
- Messages persist as JSON files in `data/bus/inbox/` until claimed
- Claim is atomic (rename to `.processing`)
- Failed processing returns message to inbox after timeout
- Done messages retained 72 hours for audit

### Coordination Patterns

**Einstein → Jennifer (routine):** Einstein publishes `{to_agent: "jennifer", topic: "citation_update", summary: "New paper for SFARI grant"}`. Jennifer picks it up on next bus cycle.

**Claire → Einstein (urgent):** Claire spawns Einstein as sync subagent via Agent Teams. Einstein searches, returns findings. Claire synthesizes and responds. All within one container.

**Jennifer → Claire (notification):** Jennifer publishes `{to_agent: "claire", topic: "schedule_update", priority: "low", summary: "Scheduled meeting Wed 2pm"}`. Claire absorbs on next invocation.

## 5. Trust Calibration & Action Logging

### Action Log (SQLite)

```sql
CREATE TABLE agent_actions (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  action_type TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  summary TEXT NOT NULL,
  target TEXT,
  outcome TEXT DEFAULT 'completed',
  created_at TEXT NOT NULL
);
```

Every agent action through IPC is logged regardless of trust level.

### Trust Enforcement

Trust is enforced at the IPC layer (host process), not inside the container:

1. Agent calls `send_message` via IPC
2. IPC handler looks up `(agent_name, action_type)` in loaded trust config
3. `autonomous` → process immediately, no notification
4. `notify` → process immediately, post notification to group chat
5. `draft` → store draft, notify user (future phase)
6. `ask` → notify user, wait for approval (future phase)

Initial implementation covers `autonomous` and `notify` only. The action log table is the foundation for future dynamic trust calibration.

### Initial Trust Defaults

**Claire:** send_message=notify, publish_to_bus=autonomous, write_group_memory=autonomous, schedule_task=notify

**Einstein:** send_message=notify, publish_to_bus=autonomous, write_vault=notify, search_literature=autonomous

**Jennifer:** send_message=notify, send_email=draft, schedule_meeting=notify, publish_to_bus=autonomous

## 6. Impact Analysis

### New Files

| File | Purpose |
|------|---------|
| `agents/claire/{identity.md,trust.yaml,state.md}` | Claire's identity |
| `agents/jennifer/{identity.md,trust.yaml,state.md}` | Jennifer's identity |
| `agents/einstein/{identity.md,trust.yaml,state.md}` | Einstein's identity |
| `src/agent-registry.ts` | Scan agents/, load identities, manage SQLite registry |
| `src/bus-watcher.ts` | Poll bus for agent-addressed messages, dispatch to compound groups |

### Modified Files

| File | Change | Scope |
|------|--------|-------|
| `src/index.ts` | Agent detection (`@AgentName`), start bus watcher, init registry | ~30 lines |
| `src/container-runner.ts` | Mount `agents/{name}/`, inject identity into context | ~40 lines |
| `src/context-assembler.ts` | Agent identity, state, trust, peers, bus messages sections | ~60 lines |
| `src/group-queue.ts` | Compound key support, `agentName` field | ~15 lines |
| `src/message-bus.ts` | Agent-addressed routing, per-compound-group queues | ~30 lines |
| `src/ipc.ts` | `publish_to_bus` processing, trust enforcement, action logging | ~50 lines |
| `src/db.ts` | `agent_registry` and `agent_actions` tables, migration | ~30 lines |
| `src/config.ts` | `BUS_POLL_INTERVAL`, `AGENTS_DIR` constants | ~5 lines |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `publish_to_bus` tool definition | ~25 lines |

### Unchanged Files (compound keys transparent)

`src/container-runtime.ts`, `src/task-scheduler.ts`, `src/health-monitor.ts`, `src/mount-security.ts`, `src/router.ts`, `src/channels/*`, `container/agent-runner/src/index.ts`

### Migration Path

Existing groups work with zero changes. Agent layer activates when:
1. `agents/` directory exists with identity files
2. Agents registered to groups via `agent_registry` table
3. User sends `@AgentName` or Claire is set as default

## 7. Testing Strategy

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `src/__tests__/agent-registry.test.ts` | Dir scanning, identity loading, registry CRUD, wildcard matching |
| `src/__tests__/bus-watcher.test.ts` | Agent-addressed routing, poll intervals, priority dispatch, concurrency |
| `src/__tests__/compound-keys.test.ts` | Key parsing/construction, backward compatibility, session isolation |
| `src/__tests__/trust-enforcement.test.ts` | Trust lookup, IPC enforcement, action logging |

### Integration Tests (extend existing)

| Test File | Addition |
|-----------|----------|
| `src/__tests__/ipc.test.ts` | `publish_to_bus` processing, trust-gated `send_message` |
| `src/__tests__/container-runner.test.ts` | Agent mount injection, compound key naming |
| `src/__tests__/group-queue.test.ts` | Compound key state tracking, per-agent warm pool |
| `src/__tests__/context-assembler.test.ts` | Agent identity/state/peers in context packet |
| `src/__tests__/message-bus.test.ts` | Agent-addressed queue routing |

### Success Criteria

1. `@Einstein` in LAB-claw spawns compound group, loads identity, responds, logs action
2. Einstein publishes to bus → Jennifer picks up within 30 seconds, acts, notifies
3. General message to Claire → Claire handles or delegates to specialist inline
4. Einstein in LAB-claw and SCIENCE-claw have separate sessions, share state.md
5. `agent_actions` table logs all agent actions with trust levels

## 8. Out of Scope

| Feature | Rationale |
|---------|-----------|
| Dynamic trust calibration | Needs approval UI; action log is the foundation |
| `draft` and `ask` trust enforcement | Requires user-response-wait pattern in IPC |
| Per-agent model selection | SDK doesn't support per-invocation model switching |
| Franklin and Sep agents | Infrastructure supports them; add identity files when ready |
| Knowledge graph (Layer 5) | Independent project |
| Always-on perception | Independent project; benefits from multi-agent but doesn't require it |
| Agent-to-agent sync via Agent Teams | Already works; no new code, just identity.md instructions |
