# NanoClaw Domain Glossary

Vocabulary shared by code, tests, docs, and conversations about this codebase.
Terms here are **load-bearing** — they get used in commit messages, audit-row
strings, and reviewer feedback, so the names should be precise and stable.

When a new concept earns a name during architecture work, it belongs here.
When an existing term sharpens, update its entry rather than introducing a
synonym.

## Core terms

### Agent

A persona running inside an Apple Container. Identified by a `data/agents/{name}/`
directory containing `identity.md`, `memory.md`, `trust.yaml`, and a
`skills/` tree. One agent may run in multiple groups; one group has at most
one **lead** agent. Agents are addressed by their compound key
`{groupFolder}+{agentName}` for IPC isolation.

### Group

A registered chat with a folder under `groups/{name}/` and a row in
`registered_groups` keyed by `jid`. Carries a `containerConfig` and a
`permittedSenders` allowlist. Exactly one group is **main** — the admin
control group with elevated privileges (no trigger, full mount access, all
secrets). All others are **non-main** with progressive restrictions.

### Channel

A platform-specific transport (Telegram, Slack, Gmail, emacs). Implements
`interface Channel` in `src/types.ts`. Each channel owns a set of JIDs and
exposes `sendMessage`, `ownsJid`, `isConnected`. The channel set is dynamic;
factories register at startup via `src/channels/registry.ts`.

### IPC action

A typed message an in-container agent sends to the host. Wire format: JSON
file dropped in `data/ipc/{group}/tasks/{id}.json` (or the legacy
`messages/{id}.json` queue, which `message`/`send_file` still use — since
2026-07-14 both directories feed the same `dispatchIpcAction` registry; the
inline `processIpcMessage` ladder is gone). Identified by `data.type`. The
set is closed; new actions require a host-side **handler**.
See `docs/context-engineering/ipc-handler-contract.md`.

Two `responseKind`s:
- **notify** — fire-and-forget. Host optionally sends a post-hoc Telegram
  notification.
- **result** — request/response. Host writes
  `data/ipc/{group}/{type}_results/{requestId}.json`; agent polls.

### Trust gate

`gateAndStage` in `src/ipc/handlers/trust-gate.ts`. The single point where
an agent's `trust.yaml` is consulted before a side-effecting action runs.
Returns one of:
- **allow** — execute proceeds; an audit row is written.
- **stage** — request held for human approval; staged in
  `agent_actions.status = 'staged'`.
- **deny** — execute is skipped; audit row records the denial.

A handler may declare `skipGate: true` only if its type is on the read-only
allowlist (Rule 4 of the IPC handler contract).

### Audit row

A row in the `agent_actions` table written by the trust gate. Has `target`
(what was acted on — a folder, taskId, or external system name like `vercel`
or `knowledge-graph`) and `summary` (truncated human-readable description).
Used by `/agent-history`, the cockpit dashboard, and forensic queries after
a trust incident. Distinct from a **post-hoc notify**, which is the
user-facing Telegram message fired after `execute` returns.

### Post-hoc notify

A Telegram message sent to the main group *after* a non-main agent action
runs, summarizing what happened. Fired by `firePostHocNotify` /
`fireNotifyIfRequested` when the trust gate decision included `notify: true`.
The notify text comes from `IpcAuthorization.notifySummary`. Distinct from
the **audit row**, which is durable forensic state.

### Session

A Claude Code conversation thread for a group, identified by an opaque
sessionId. Persists across container spawns until idle-expired
(`SESSION_MAX_AGE_MS`, 2h). Stored in the `sessions` table. `/new` resets;
`/compact` forwards to the agent for context compaction.

### Compound key

`{groupFolder}--{agentName}` — the filesystem-safe identifier for an
agent-running-in-a-group. Used for per-agent IPC directories
(`data/ipc/{compoundKey}/`) so two agents in the same group don't collide.
The `--` is the on-disk form; `:` is the parsed form (`SEPARATOR`/
`FS_SEPARATOR` in `src/compound-key.ts`). Note the container still mounts
the **base** group folder at `/workspace/group` — compound callers' file
paths must resolve against the base group, not the compound directory
(see `resolveContainerFilePathToHost`).

### Skill

A unit of agent capability. Four flavors per `CONTRIBUTING.md`: **feature**
skills (branches that add channels/integrations), **utility** skills (code
files), **operational** skills (instructions only), **container** skills
(loaded inside agents at runtime from `container/skills/`). Skills can also
**crystallize** at runtime — an agent saves a SKILL.md under
`data/agents/{name}/skills/crystallized/` via the `crystallize_skill` IPC.

### Watcher

A long-running host-side loop that polls an external system (Gmail, calendar,
vault filesystem) and emits messages to the bus or the event router. Lives
under `src/watchers/`. No unified `Watcher` interface today — each watcher
is its own class wired up imperatively in `main()`. *(Marked as a future
deepening opportunity; see `/improve-codebase-architecture` candidate #2.)*

### Event router

`src/event-router.ts` — Ollama-driven classifier that turns a `RawEvent`
(email, calendar item, vault change) into a `ClassifiedEvent` with
`{importance, urgency, topic, routing}`. **Not** to be confused with
`src/event-routing.ts`, which picks *which agent* should act on a classified
event. The former is **classification**, the latter is **agent matching**.
