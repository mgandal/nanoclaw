# Multi-Agent Orchestration for NanoClaw

**Date:** 2026-04-09 (revised 2026-04-10 after peer review + code validation)
**Status:** Approved
**Branch:** feature/multi-agent-orchestration

## Overview

Port multi-agent orchestration concepts from OpenClaw into NanoClaw without importing OpenClaw's code or complexity. This adds three capabilities:

1. **Persistent agent identities** — Named agents (Claire, Jennifer, Einstein) with personas, trust levels, and working memory that persist across sessions
2. **Inter-agent coordination** — Sync handoffs (urgent, via Agent Teams) and async messaging (routine, via message bus)
3. **Reliable delivery** — At-least-once message delivery between agents with action logging

The core architectural decision is **"Agents as Lightweight Groups"**: each agent invocation within a group creates a compound key (`{groupFolder}:{agentName}`) that reuses most existing NanoClaw infrastructure — sessions, health monitoring, warm pool — with targeted modifications to IPC authorization, task scheduling, and container mounting.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent-to-group relationship | Agents live within groups, some float across groups | Groups are conversation context; agents are capabilities |
| Coordination model | Hybrid sync/async based on urgency | Sync for real-time needs (Agent Teams); async for routine (bus) |
| Persistence model | Warm pool (on-demand + idle window) | Balances responsiveness and resource cost |
| Autonomy visibility | Notify-on-action | Agents act freely; user sees the stream without gating it |
| Initial roster | Claire, Jennifer, Einstein | Core trio covers orchestration, operations, research |
| Identity storage | `data/agents/` directory (outside project root) | First-class concept; editable, mountable, versionable; not exposed to main group's project root mount |
| Architectural approach | Compound group keys reusing existing infrastructure | Maximum reuse; targeted modifications where compound keys aren't transparent |

## 1. Agent Identity & Registry

### Identity Files

Each agent lives in `data/agents/{name}/`:

```
data/agents/
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

**Why `data/agents/` and not top-level `agents/`:** The main group container mounts the project root read-only at `/workspace/project`. A top-level `agents/` directory would expose all agents' `trust.yaml` files (autonomous action maps) to the main group container, enabling a compromised container to read other agents' trust configurations. `data/` is selectively mounted, so agent identity files are only exposed via explicit per-agent mounts.

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
| `draft` | Prepare action, present to user for approval (future phase) |
| `ask` | Don't act, ask user for permission first (future phase) |

**Fail-safe default:** Unrecognized or unimplemented trust levels (`draft`, `ask` in initial implementation) are treated as `ask` — the action is blocked and the user is notified. This prevents trust bypass if an agent calls an action whose trust level isn't yet implemented.

### state.md

Free-form markdown maintained by the agent itself during runs. Contains active threads, recent findings, things being tracked. Persists across sessions via a new `write_agent_state` IPC tool (see Section 4).

**Read-only mount:** `data/agents/{name}/` is mounted **read-only** at `/workspace/agent/` in containers. This prevents concurrent write corruption when two instances of the same agent (e.g., Einstein in LAB-claw and SCIENCE-claw) run simultaneously. State updates are serialized through the host process via IPC.

### Startup Validation

On startup, the agent registry scanner validates each agent directory:

1. `identity.md` must exist and have valid YAML frontmatter with required fields (`name`, `role`, `description`)
2. `trust.yaml` must parse as valid YAML with an `actions` map
3. `state.md` is optional (created empty on first write)

**Fail-safe:** If any agent's files fail validation, that agent is skipped with a logged error. The system continues with valid agents. A corrupt `trust.yaml` never results in fail-open — the agent is simply not registered.

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

On startup, the system scans `data/agents/` for valid identity files and populates the registry. The registry tracks which agents are available to which groups. Claire is registered to all groups by default (orchestrator). The wildcard `'*'` row is only used for lookup filtering — it is never passed to path-resolution functions.

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

### Encoding Rules

Compound keys have two representations:

| Context | Format | Example |
|---------|--------|---------|
| In memory (GroupState map keys, log output) | `:` separator | `telegram_lab-claw:einstein` |
| In SQLite (sessions, agent_actions) | `:` separator | `telegram_lab-claw:einstein` |
| On filesystem (IPC dirs, bus queues) | `--` separator | `telegram_lab-claw--einstein` |

Helper functions in `src/compound-key.ts`:

```typescript
function compoundKey(groupFolder: string, agentName: string): string;
function parseCompoundKey(key: string): { group: string; agent: string | null };
function compoundKeyToFsPath(key: string): string;   // ':' → '--'
function fsPathToCompoundKey(path: string): string;   // '--' → ':'
```

**Ambiguity prevention:** Group folder names must not contain consecutive hyphens (`--`). Update `GROUP_FOLDER_PATTERN` in `src/group-folder.ts` with a post-check: `if (folder.includes('--')) return false`. Agent names use the same constraint. The `parseCompoundKey` function splits on the **last** `--` occurrence as a secondary safety measure, since agent names are known at parse time.

**Compound keys never pass through `resolveGroupFolderPath()` or `resolveGroupIpcPath()`.** These functions call `assertValidGroupFolder()` which enforces `GROUP_FOLDER_PATTERN` and will reject compound keys. Instead, the container-runner receives the base `groupFolder` and `agentName` as separate fields and constructs paths independently:

- Group path: `resolveGroupFolderPath(baseGroupFolder)` (existing, unchanged)
- Agent path: `path.join(AGENTS_DIR, agentName)` (new, validated separately)
- IPC path: `path.join(IPC_BASE_DIR, compoundKeyToFsPath(compoundKey))` (new, bypasses group-folder validation)

### Container Mounts

Compound group containers get an additional mount:

```
/workspace/group/       → groups/{groupFolder}/               (read-write)
/workspace/agent/       → data/agents/{agentName}/            (READ-ONLY)
/workspace/global/      → groups/global/                      (read-only for non-main)
/workspace/ipc/         → data/ipc/{groupFolder}--{agent}/    (isolated)
```

The agent's `identity.md` is loaded into the context packet alongside the group's `CLAUDE.md`.

### Container Input

The `ContainerInput` interface gains an optional `agentName` field:

```typescript
interface ContainerInput {
  // ... existing fields ...
  agentName?: string;          // which agent identity to load (undefined = legacy mode)
}
```

The container-runner passes `baseGroupFolder` (not the compound key) as `groupFolder` in ContainerInput. The `agentName` is a separate field. This ensures the agent-runner's existing code (Honcho peer derivation, session indexing, CWD) works against the base group folder unchanged.

### Warm Pool

Extends existing GroupState in `group-queue.ts`. The GroupState map is keyed by compound key (`:` format) for agent containers, or plain group folder for legacy containers:

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

`MAX_CONCURRENT_CONTAINERS` raised from 5 to 8 for multi-agent deployments. Additional requests queue in GroupQueue (existing behavior). The higher limit accommodates parallel agent work across groups while still preventing runaway spawns.

### Session Isolation

Each compound group gets its own session in SQLite (keyed by compound key with `:` separator). Einstein in LAB-claw and Einstein in SCIENCE-claw have separate sessions — same persona, different conversation histories.

Shared persistent state across Einstein instances is managed via the `write_agent_state` IPC tool (not direct filesystem writes).

Session cleanup (`startSessionCleanup`) applies the same idle/max-age rules to compound group sessions. This is correct — compound agent sessions should expire like any other.

### Health Monitoring

Health monitor treats compound keys as opaque strings (confirmed in peer review). A paused base group does NOT automatically pause its compound agent containers. This is intentional — agents are independent capabilities. To pause an agent, pause the compound key directly.

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
5. Pending bus messages addressed to this agent (read-only scan; not cleared — bus watcher is authoritative)

**Message history:** Context assembly for compound groups uses the **base group's JID** (not the compound key) to fetch recent messages via `getRecentMessages()`. Messages belong to the Telegram chat, not to individual agents. The `assembleContextPacket` function accepts both `compoundKey` and `baseGroupFolder` parameters — compound key for bus queue lookup, base folder for message history.

**Bus message snapshot:** The existing code in `assembleContextPacket()` (lines 358-372) reads bus queue items and clears them. For per-message files, this changes to: scan `.json` files in the agent's bus directory (read-only, do NOT claim or delete). The context packet includes these as context so the agent knows what's pending. The bus watcher claims and delivers authoritatively — the context assembler never modifies bus state.

**Context size:** `CONTEXT_PACKET_MAX_SIZE` raised from 8000 to 16000 for multi-agent deployments. Agent identity sections are given priority in the size budget over historical message data, since agent identity is essential for correct behavior.

## 4. Inter-Agent Coordination & Message Bus

### Coordination Paths

**Sync (urgent):** Agent uses Claude Code Agent Teams to spawn a subagent with the target agent's identity within the same container. Already supported via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. No new code; driven by identity.md instructions and `urgent_topics` configuration.

**Async (routine):** Agent publishes to the message bus via new IPC tool. Target agent picks it up on the next bus poll cycle.

### New IPC Tools

Added to `container/agent-runner/src/ipc-mcp-stdio.ts`:

**publish_to_bus:**
```typescript
{
  name: "publish_to_bus",
  inputSchema: {
    type: "object",
    properties: {
      to_agent:  { type: "string" },     // target agent name
      to_group:  { type: "string" },     // target group folder (defaults to current group)
      topic:     { type: "string" },     // message topic
      priority:  { type: "string", enum: ["low", "medium", "high"] },
      summary:   { type: "string" },     // human-readable description
      payload:   { type: "object" }      // structured data
    },
    required: ["to_agent", "topic", "summary"]
  }
}
```

When `to_group` is omitted, it defaults to the current group (not fan-out to all groups where the target agent is registered).

**write_agent_state:**
```typescript
{
  name: "write_agent_state",
  inputSchema: {
    type: "object",
    properties: {
      content:   { type: "string" },     // full markdown content for state.md
      append:    { type: "boolean" }      // if true, append instead of replace (default: false)
    },
    required: ["content"]
  }
}
```

This tool serializes state.md writes through the host process, preventing concurrent write corruption. The host writes to `data/agents/{agentName}/state.md` atomically (temp file + rename). The `agentName` is derived from the IPC directory path (filesystem-derived), not from the payload.

### Bus Message Storage

**Per-message files (not queue.json).** Agent-addressed bus messages are stored as individual JSON files in `data/bus/agents/{group}--{agent}/`:

```
data/bus/agents/telegram_lab-claw--einstein/
├── 1712700000000-abc123.json      # pending message
├── 1712700030000-def456.json      # pending message
└── 1712700060000-ghi789.processing  # claimed by bus watcher
```

This replaces the single `queue.json` array approach. Each message is a separate file, enabling atomic claim (rename to `.processing`), atomic delete, and no read-modify-write races. This is the same pattern used by `data/bus/inbox/`.

**Migration from existing code:** The existing `appendToAgentQueue()` (message-bus.ts line 153) and `readAgentQueue()` (line 90) use a single `queue.json` array with a non-atomic read-modify-write pattern. Both are replaced:
- `appendToAgentQueue()` → `writeAgentMessage()` writing individual `{timestamp}-{nanoid}.json` files
- `readAgentQueue()` → `listAgentMessages()` reading all `.json` files via `readdirSync`

The existing `bus_publish` IPC case (ipc.ts lines 731-747) that routes through `MessageBus.publish()` → `appendToAgentQueue()` is replaced by the new `publish_to_bus` handler which writes per-message files directly. The old `bus_publish` case is removed.

**Path traversal prevention:** The `to_agent` and `to_group` fields from IPC payloads are validated against the agent registry and registered groups before constructing filesystem paths. `action_needed` field values are sanitized to match the compound key filesystem pattern (alphanumeric, hyphens, underscores only).

### Bus Watcher Loop

New `src/bus-watcher.ts` polls every `BUS_POLL_INTERVAL` (30 seconds):

```
For each compound agent directory in data/bus/agents/:
  Count pending .json files
  If pending > 0:
    Parse compound key from directory name
    If target compound group has warm container → deliver via IPC input
    Else → spawn container with bus messages in context packet
    Respect MAX_CONCURRENT_CONTAINERS limit (queue if full)
  If any pending message has priority "high":
    Use BUS_HIGH_PRIORITY_INTERVAL (5 seconds) for next poll
```

**Bus message deduplication:** The context packet includes pending bus messages for **context only** (so the agent knows what's coming). The bus watcher is the authoritative delivery mechanism. Bus messages are claimed (renamed to `.processing`) only by the bus watcher at delivery time, not by the context assembler.

### Delivery Guarantees

At-least-once delivery:
- Messages persist as individual JSON files until claimed
- Claim is atomic (rename to `.processing`)
- Failed processing returns message to pending after timeout (rename `.processing` back to `.json`)
- Completed messages moved to `data/bus/done/` with 72-hour retention
- No message is silently dropped

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

Trust is enforced at the IPC layer (host process), not inside the container.

**Identity derivation:** Agent identity for trust enforcement is **always derived from the IPC directory name** by parsing the compound key. The host ignores any `from`, `agent_name`, or identity field present in the JSON payload. This prevents a compromised container from claiming a different agent's identity to inherit its trust level.

```
IPC file arrives from data/ipc/telegram_lab-claw--einstein/messages/
  → Parse directory name: fsPathToCompoundKey("telegram_lab-claw--einstein")
  → Extract: { group: "telegram_lab-claw", agent: "einstein" }
  → Load trust config: data/agents/einstein/trust.yaml
  → Look up (agent: "einstein", action: "send_message") → "notify"
  → Apply trust level
```

Trust level application:
1. `autonomous` → process immediately, no notification
2. `notify` → process immediately, post notification to group chat
3. `draft` → block action, notify user with draft content (future phase; treated as `ask` initially)
4. `ask` → block action, notify user with description (future phase; blocks and notifies initially)
5. **Unknown/unrecognized level** → treated as `ask` (fail-safe, never fail-open)

### IPC Authorization for Compound Groups

The existing IPC authorization check (`targetGroup.folder === sourceGroup` at ipc.ts line 199-203) must be updated for compound groups:

```
IPC message from compound group:
  → sourceGroup (from directory name): "telegram_lab-claw--einstein"
  → Parse to get base group: "telegram_lab-claw"
  → Authorization check: registeredGroups[chatJid].folder === baseGroup
  → chatJid: use NANOCLAW_CHAT_JID env var (set to the BASE group's JID, not compound)
```

The container's `NANOCLAW_CHAT_JID` is always the base group's Telegram JID (e.g., `tg:-1003892106437`). The compound key is not a JID — it's an internal routing key.

### Initial Trust Defaults

**Claire:** send_message=notify, publish_to_bus=autonomous, write_group_memory=autonomous, schedule_task=notify

**Einstein:** send_message=notify, publish_to_bus=autonomous, write_vault=notify, search_literature=autonomous

**Jennifer:** send_message=notify, send_email=draft, schedule_meeting=notify, publish_to_bus=autonomous

### File Path Resolution

`resolveContainerFilePathToHost` in `src/ipc.ts` (lines 91-134) gains a new case for `/workspace/agent/` after the existing `/workspace/extra/` case (line 130):

```
/workspace/agent/output.pdf → data/agents/{agentName}/output.pdf
```

The `agentName` is derived from the IPC directory path (compound key parsing), not from the payload.

## 6. Impact Analysis

### New Files

| File | Purpose |
|------|---------|
| `data/agents/claire/{identity.md,trust.yaml,state.md}` | Claire's identity |
| `data/agents/jennifer/{identity.md,trust.yaml,state.md}` | Jennifer's identity |
| `data/agents/einstein/{identity.md,trust.yaml,state.md}` | Einstein's identity |
| `src/agent-registry.ts` | Scan data/agents/, validate, load identities, manage SQLite registry |
| `src/bus-watcher.ts` | Poll bus for agent-addressed messages, dispatch to compound groups |
| `src/compound-key.ts` | Compound key helpers: create, parse, encode/decode filesystem paths |

### Modified Files

| File | Change | Scope |
|------|--------|-------|
| `src/index.ts` | Agent detection (`@AgentName`), start bus watcher, init registry | ~30 lines |
| `src/container-runner.ts` | Mount `data/agents/{name}/` read-only at `/workspace/agent/`, pass `agentName` in ContainerInput, agent identity in context. Insert agent mount before duplicate-path guardrail (~line 267). No conflict with GitHub token env vars (~line 438). | ~50 lines |
| `src/context-assembler.ts` | Agent identity/state/trust/peers sections, use base group JID for message history, read-only bus message scan (replace queue.json read+clear with per-file listing), size budget priority | ~80 lines |
| `src/group-queue.ts` | Compound key as map key, `agentName` field on GroupState | ~15 lines |
| `src/group-folder.ts` | Post-check rejecting `--` in group folder names (after existing `isValidGroupFolder` checks) | ~5 lines |
| `src/message-bus.ts` | Replace `appendToAgentQueue()` (line 153) with `writeAgentMessage()` (per-file writes). Replace `readAgentQueue()` (line 90) with `listAgentMessages()` (dir scan). Path sanitization. | ~40 lines |
| `src/ipc.ts` | Replace existing `bus_publish` case (lines 731-747) with `publish_to_bus` handler. Add `write_agent_state` processing. Compound key auth (extract base group at line 199-203). Trust enforcement + action logging. `/workspace/agent/` path resolution (after line 130). | ~80 lines |
| `src/db.ts` | `agent_registry` and `agent_actions` tables via `CREATE TABLE IF NOT EXISTS` (idempotent, matching existing migration pattern). `agent_name` column on `scheduled_tasks` via `addColumn()`. | ~35 lines |
| `src/config.ts` | `BUS_POLL_INTERVAL`, `BUS_HIGH_PRIORITY_INTERVAL`, `AGENTS_DIR` constants. `MAX_CONCURRENT_CONTAINERS` default 5→8. `CONTEXT_PACKET_MAX_SIZE` default 8000→16000. | ~10 lines |
| `src/task-scheduler.ts` | Extract base group from compound key BEFORE `resolveGroupFolderPath()` call (~line 117, which throws on compound keys via `assertValidGroupFolder`). Also fix registered-group lookup (~line 144). Use `agent_name` column for compound task dispatch. | ~25 lines |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `publish_to_bus` + `write_agent_state` tool definitions | ~50 lines |
| `container/agent-runner/src/index.ts` | Use `containerInput.agentName` for Honcho `aiPeer` derivation at lines 227 and 770 instead of parsing `groupFolder` with `.replace(/^telegram_/, '')`. Fallback to existing behavior when `agentName` is undefined (legacy mode). | ~10 lines |

### Unchanged Files (confirmed transparent in peer review + code validation)

| File | Why Unchanged |
|------|---------------|
| `src/container-runtime.ts` | Container names sanitized upstream in container-runner.ts (line 497: `group.folder.replace(/[^a-zA-Z0-9-]/g, '-')`); `stopContainer` receives already-safe names; `VALID_CONTAINER_NAME` regex passes sanitized compound keys |
| `src/health-monitor.ts` | All methods (`recordSpawn`, `recordError`, `getSpawnCount`, `pauseGroup`) treat group as opaque string; compound keys transparent |
| `src/mount-security.ts` | Group name only used for log output in `validateMount()`; compound keys transparent |
| `src/router.ts` | Routes by JID via `c.ownsJid(jid)`, never touches group folder; compound keys invisible |
| `src/channels/*` | Telegram dispatches by JID; `sendPoolMessage` key `${groupFolder}:${sender}` produces deeper nesting with compound keys but is functionally harmless (sender names won't contain `--`) |

### Migration Path

Existing groups work with zero changes. Agent layer activates when:
1. `data/agents/` directory exists with valid identity files
2. Agents registered to groups via `agent_registry` table
3. User sends `@AgentName` or Claire is set as default

## 7. Testing Strategy

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `src/__tests__/agent-registry.test.ts` | Dir scanning, identity validation (valid + malformed), registry CRUD, wildcard matching, fail-safe on bad YAML |
| `src/__tests__/bus-watcher.test.ts` | Agent-addressed routing, poll intervals, priority dispatch, concurrency, warm pool delivery vs. cold spawn |
| `src/__tests__/compound-key.test.ts` | Key create/parse/encode/decode, `--` rejection in folder names, round-trip encoding, last-`--`-split edge cases |
| `src/__tests__/trust-enforcement.test.ts` | Trust lookup from filesystem path (not payload), autonomous/notify enforcement, fail-safe for unknown levels, action logging |
| `src/__tests__/write-agent-state.test.ts` | Atomic write, concurrent serialization, append mode, agent name derived from path |

### Integration Tests (extend existing)

| Test File | Addition |
|-----------|----------|
| `src/__tests__/ipc.test.ts` | `publish_to_bus` processing (replaces old `bus_publish`), `write_agent_state`, compound key authorization, trust-gated `send_message`, `/workspace/agent/` path resolution |
| `src/__tests__/container-runner.test.ts` | Agent mount injection (read-only), compound key container naming, `agentName` in ContainerInput |
| `src/__tests__/group-queue.test.ts` | Compound key state tracking, per-agent warm pool, legacy (no agent) backward compat |
| `src/__tests__/context-assembler.test.ts` | Agent identity/state/peers in context packet, base group JID for messages, read-only bus scan (no clearing), size budget |
| `src/__tests__/message-bus.test.ts` | Per-message file writes via `writeAgentMessage()`, `listAgentMessages()` dir scan, atomic claim, path sanitization |
| `src/__tests__/task-scheduler.test.ts` | Compound key base-group extraction before `resolveGroupFolderPath`, `agent_name` column, task dispatch for compound groups |

### End-to-End Integration Test

The warm pool + bus watcher interaction (primary happy path):
1. Bus watcher fires → target compound group is warm → deliver via IPC input
2. Agent processes and calls `publish_to_bus` in response
3. Second bus watcher cycle picks up the response and delivers to next agent

### Success Criteria

1. `@Einstein` in LAB-claw spawns compound group, loads identity, responds, logs action
2. Einstein publishes to bus → Jennifer picks up within 30 seconds, acts, notifies
3. General message to Claire → Claire handles or delegates to specialist inline
4. Einstein in LAB-claw and SCIENCE-claw have separate sessions, share state.md via IPC writes
5. `agent_actions` table logs all agent actions with trust levels
6. Malformed agent identity files are skipped with logged error (fail-safe)
7. Trust enforcement derives agent identity from filesystem, not payload (spoofing test)
8. Concurrent `write_agent_state` calls from two containers serialize correctly

## 8. Out of Scope

| Feature | Rationale |
|---------|-----------|
| Dynamic trust calibration | Needs approval UI; action log is the foundation |
| `draft` and `ask` trust enforcement (full) | Requires user-response-wait pattern in IPC; fail-safe blocking is implemented |
| Per-agent model selection | SDK doesn't support per-invocation model switching |
| Franklin and Sep agents | Infrastructure supports them; add identity files when ready |
| Knowledge graph (Layer 5) | Independent project |
| Always-on perception | Independent project; benefits from multi-agent but doesn't require it |
| Agent-to-agent sync via Agent Teams | Already works; no new code, just identity.md instructions |

## Appendix A: Peer Review Findings & Resolutions

This spec was peer-reviewed on 2026-04-10 by three specialized reviewers (architecture, security, backward compatibility) and then validated against the actual codebase at specific line numbers. All critical, high-severity, and code-validation findings have been incorporated:

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| C1 | CRITICAL | `group-folder.ts` validation rejects compound keys | Compound keys never pass through group folder validator; paths constructed from separate base group + agent name |
| C2 | CRITICAL | Session encoding mismatch SQLite vs. memory | Single canonical encoding: `:` everywhere except filesystem (`--`) |
| C3 | CRITICAL | IPC authorization fails for compound groups | Auth extracts base group from compound key; `NANOCLAW_CHAT_JID` is always base group JID |
| C4 | CRITICAL | Bus queue race condition (read-modify-write on queue.json) | Switched to per-message files; no shared mutable array |
| H1 | HIGH | `state.md` concurrent write corruption | Mount `data/agents/` read-only; new `write_agent_state` IPC tool serializes through host |
| H2 | HIGH | Trust enforcement reads identity from payload | Identity always derived from IPC directory path; payload fields ignored |
| H3 | HIGH | `getRecentMessages()` empty for compound groups | Context assembly uses base group JID for message history |
| H4 | HIGH | `task-scheduler.ts` lookup fails for compound keys | Added to modified files; extracts base group; `agent_name` column on tasks |
| H5 | HIGH | Agent identity files exposed via project root mount | Moved agents to `data/agents/` (outside project root) |
| V1 | CODE | Existing `bus_publish` IPC handler (ipc.ts:731-747) conflicts with new `publish_to_bus` | Old handler replaced, not parallel; uses new per-message file writes |
| V2 | CODE | `task-scheduler.ts` has TWO breaking points (line 117 + line 144) | Base-group extraction added before `resolveGroupFolderPath()` at line 117, not just before `find()` at line 144 |
| V3 | CODE | `context-assembler.ts` clears bus queue on read (line 358-372) | Changed to read-only scan of per-message files; bus watcher is sole authority for claiming messages |
| M1 | MEDIUM | `/workspace/agent/` not in file path resolution | Added resolution case after line 130 in `resolveContainerFilePathToHost` |
| M2 | MEDIUM | `MAX_CONCURRENT_CONTAINERS=5` too low | Raised to 8 |
| M3 | MEDIUM | Bus watcher + context packet double-delivery | Context packet is context-only; bus watcher is authoritative delivery |
| M4 | MEDIUM | `CONTEXT_PACKET_MAX_SIZE=8000` exceeded | Raised to 16000 |
| M5 | MEDIUM | `to_group` omission ambiguous | Defaults to current group (explicit, not fan-out) |
| M6 | MEDIUM | `--` separator collides with group folder names | Group folder pattern rejects consecutive hyphens via post-check |
| M7 | MEDIUM | Honcho `aiPeer` derivation broken for compound keys | Agent-runner uses separate `agentName` field at lines 227 and 770 |
| M8 | MEDIUM | Agent-runner source cached per-compound-group | Deferred; 15 copies is acceptable for initial implementation |
| M9 | MEDIUM | Unimplemented trust levels fail-open | Default to `ask` (block + notify); never fail-open |
