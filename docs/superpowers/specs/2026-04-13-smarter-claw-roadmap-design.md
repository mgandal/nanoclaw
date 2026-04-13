# Smarter Claw — Proactive Intelligence Roadmap

**Date:** 2026-04-13
**Status:** Draft v2 — incorporates 4 independent peer reviews (architecture, security, practicality, priority)
**Scope:** Phased roadmap to evolve NanoClaw from request-response to self-improving agent system
**Reviews:** Architecture reviewer, security reviewer, practicality reviewer, priority/scope reviewer

## Problem Statement

NanoClaw is fundamentally request-response: you message it → it wakes up → it answers → it sleeps. OpenClaw and similar systems are event-driven: agents are always perceiving, coordinating, and acting without being asked. The result: NanoClaw feels like a chatbot that happens to have tools, not an ambient assistant that's always working for you.

Specific gaps:
1. **Agents can't coordinate fluidly** — the filesystem bus has 5-30s latency, no direct session access, no "hey Einstein, look at this"
2. **No learning loop** — agents don't notice patterns, don't adjust behavior from outcomes, can't discover new capabilities
3. **No system-wide awareness** — agents don't know what other agents are doing, what events just fired, or what the system state is
4. **No self-evolution** — structural changes require human-driven Claude Code sessions; agents can't propose or implement platform improvements

## Design Principles

1. **Keep what works** — filesystem bus, Apple Container isolation, IPC, credential proxy all stay
2. **Intelligence over infrastructure** — prioritize features that make agents smarter, not just faster
3. **If the new layer goes down, everything falls back** — no single points of failure
4. **Ship incrementally** — each feature delivers user-visible value, not just plumbing
5. **Self-evolution through PR review** — agents can propose changes but never modify the running system directly
6. **Execution bandwidth is the bottleneck** — this is a solo-maintained project with ~11 unimplemented specs already queued; only features that earn their place survive

## Comparison: NanoClaw vs OpenClaw

### What OpenClaw has that NanoClaw doesn't

| Capability | OpenClaw | NanoClaw Today |
|---|---|---|
| Real-time control plane | WebSocket Gateway for all components | Filesystem polling (2-60s) |
| Cross-agent session tools | `sessions_send/list/history` | Bus messages via filesystem |
| HTTP webhooks | Any service can trigger an agent | No inbound HTTP endpoint |
| Gmail push | Pub/Sub (instant) | Polling every 60s |
| Live Canvas (A2UI) | Agent-controlled visual workspace | None |
| Voice Wake / Talk Mode | Always-listening wake word | None |
| Skill registry (ClawHub) | Agents discover/pull skills at runtime | Static skill loading |
| 25+ channels | WhatsApp, Telegram, Slack, Signal, iMessage, Teams, Matrix... | Telegram + optional channels |

### What NanoClaw has that OpenClaw doesn't

| Capability | Details |
|---|---|
| Apple Container VM isolation | True VM per agent, not process separation |
| Honcho user modeling | Persistent user profile that builds over time |
| QMD hybrid search | BM25 + vector + HyDE across 14 collections, 3600+ docs |
| Event Router with trust matrix | Ollama-classified events, configurable trust per agent |
| Health monitor with auto-fix | Self-healing MCP restarts, container recovery |
| PageIndex | Hierarchical PDF indexing with page-range fetch |
| Credential Proxy | Zero-secrets-in-containers architecture |
| Portable agents with MD-first memory | Agent identity/memory/skills travel across groups (redesign spec) |

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Future: Self-Evolving Architect (separate spec)    │
│  (codebase-aware agent, git worktree, PR workflow)  │
├─────────────────────────────────────────────────────┤
│  Phase 2: Capability Discovery                      │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────────┐ │
│  │ Skill        │ │ Lossless     │ │ Proactive   │ │
│  │ Discovery    │ │ Memory       │ │ Bus Publish │ │
│  └──────────────┘ └──────────────┘ └─────────────┘ │
├─────────────────────────────────────────────────────┤
│  Phase 1: Intelligence Core                         │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────────┐ │
│  │ Gmail Push   │ │ Shared       │ │ Pattern     │ │
│  │ Monitoring   │ │ Intelligence │ │ Engine +    │ │
│  │              │ │              │ │ Outcomes    │ │
│  └──────────────┘ └──────────────┘ └─────────────┘ │
├─────────────────────────────────────────────────────┤
│  Existing Foundation                                 │
│  filesystem bus · IPC · task scheduler · container   │
│  runner · credential proxy · QMD · Honcho · watchers │
└─────────────────────────────────────────────────────┘
```

---

## Phase 1: Intelligence Core

**Goal:** Make agents smarter and more aware — they share knowledge, detect patterns, and perceive the world faster.
**Timeline:** 1-3 weeks
**Dependency:** Gmail Push (1.1) is fully independent. Shared Intelligence (1.2) is independent. Pattern Engine (1.3) is independent but benefits from architecture redesign for identity.md integration.

### 1.1 Gmail Push Monitoring

**Problem:** GmailWatcher polls every 60s. Emails can sit for up to a minute before being noticed.

**Solution:** Replace polling with Gmail API push notifications (Pub/Sub).

**How it works:**
1. Create a Google Cloud Pub/Sub topic and subscription
2. Call `gmail.users.watch()` to register the topic for the Gmail account
3. Replace the `setTimeout` polling loop in `GmailWatcher` with a Pub/Sub notification handler
4. When a notification arrives, call `gmail.users.history.list()` with the `historyId` from the notification
5. Feed messages through the existing `EventRouter.route()` pipeline (no changes downstream)
6. Re-register the watch every 6 days (Gmail watches expire after 7 days)

**Pull vs Push mode (resolved):** Push mode is preferred. It delivers instant notifications to an HTTPS endpoint — true event-driven, no polling loop. Requires a publicly reachable HTTPS endpoint, achievable via Tailscale Funnel or Cloudflare Tunnel (both already plausible given the lab's infra). Pull mode is a fallback that still requires a polling loop (just against Pub/Sub instead of Gmail), which narrows the latency benefit.

**OAuth scope — hard blocker (from architecture review):** The existing `~/.gmail-mcp/credentials.json` token was issued with Gmail API scopes only. Adding `https://www.googleapis.com/auth/pubsub` requires re-authorization (revoke token, add scope to GCP consent screen, re-run OAuth flow). This is NOT a config change — the user must re-authenticate. **Alternatively**, use a dedicated service account for Pub/Sub only (recommended by security review — keeps the blast radius smaller and avoids broadening the container-accessible credential).

**Pub/Sub notification validation (from security review):** Validate `historyId` values against a monotonically-increasing watermark in state. Reject any notification whose `historyId` is behind the watermark (indicating replay). Use a dedicated service account with minimal Pub/Sub Subscriber permissions.

**Files changed:**
- `src/watchers/gmail-watcher.ts` — add Pub/Sub handler, replace polling, add watch registration + renewal, update `GmailWatcherStatus.mode` to support `'push' | 'polling'`
- `src/index.ts` — pass Pub/Sub config to GmailWatcher constructor
- `.env` — add `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUBSUB_SUBSCRIPTION`, `GMAIL_PUBSUB_SERVICE_ACCOUNT_PATH` (optional; falls back to polling if not set)
- `package.json` — add `@google-cloud/pubsub` dependency

**Fallback:** If Pub/Sub config is absent or subscription fails, fall back to existing 60s polling. The downstream interface (`EventRouter.route()`) is unchanged either way.

**GCP setup required:** GCP project with billing enabled, Pub/Sub API enabled, service account with `roles/pubsub.subscriber`, HTTPS endpoint for push mode (Tailscale Funnel or Cloudflare Tunnel).

### 1.2 Shared Intelligence Layer

**Problem:** When SCIENCE-claw learns something, CLAIRE can't access it. Each agent's knowledge is siloed in their Honcho session.

**What it does:** Agents actively publish structured findings to a shared knowledge layer. Any agent can query the collective intelligence.

**Dependency: None (from priority review).** Despite being listed in Phase 2 originally, this feature does NOT depend on the architecture redesign. It only needs a new QMD collection and two IPC-backed MCP tools. Moved to Phase 1 to match user's stated priority (cross-agent knowledge = #3).

**How it works:**
1. **Shared QMD collection:** New `agent-knowledge` collection in QMD. Agents write findings as markdown files to `data/agent-knowledge/`
2. **Write tool:** `knowledge_publish({topic, finding, evidence, tags})` — writes a structured markdown file with YAML frontmatter
   ```markdown
   ---
   agent: einstein
   topic: APA regulation
   date: 2026-04-13
   tags: [GWAS, APA, R01-MH137578]
   ---
   Found that ChromBERT (Tongji Zhang Lab) can predict TF binding at APA sites.
   Evidence: Paper DOI 10.1234/..., tested on SFARI snATAC-seq data.
   Implication: Could strengthen Aim 2 of R01-MH137578.
   ```
3. **Query tool:** `knowledge_search({query, from_agent?, topic?, since?})` — semantic search across all agents' published findings via QMD
4. **Notification via existing bus:** On publish, write a bus message so other agents see new findings at next session start

**Publisher validation (from security review):** The `knowledge_publish` IPC handler MUST overwrite the `agent` YAML field with the verified `sourceGroup` identity from the IPC directory path. The payload's claimed `agent` field is discarded. This prevents cross-agent knowledge poisoning (e.g., einstein publishing as claire to inject high-trust findings).

**Files changed:**
- `container/agent-runner/src/index.ts` — add `knowledge_publish` and `knowledge_search` MCP tools
- New IPC handler: `knowledge_publish` in `src/ipc.ts` — validates sourceGroup, writes markdown, triggers QMD update
- QMD config: add `agent-knowledge` collection pointing to `data/agent-knowledge/`
- `groups/global/CLAUDE.md` — add knowledge publishing guidelines (what's worth sharing vs. noise)

**Relationship to existing systems:** Complements Honcho (conversational context) and vault (manually curated). Agent-knowledge is for structured findings that agents actively share — higher signal than Honcho, lower ceremony than vault.

### 1.3 Pattern Engine + Outcome Tracking

**Problem:** Agents don't notice repetition. If you ask for the same type of work 3 times, they don't propose automating it. And when automations are created, there's no feedback on whether they worked.

**What it does:** Watches agent actions over time, detects automatable patterns, proposes scheduled tasks, and tracks whether approved proposals produce good outcomes.

**Tool call logging — redesigned (from practicality review):** The host process never sees MCP tool calls — they happen entirely inside the container between the Claude Code SDK and MCP servers. The spec originally said "hook in container-runner.ts" which is impossible. Instead, tool call emission must happen inside the container:

1. **Container-side instrumentation:** Modify `container/agent-runner/src/index.ts` to write a tool-call summary file to `/workspace/ipc/output/tool-calls.json` after each session. Contains: `[{tool, params_hash, timestamp}]` — NO message bodies, NO API responses, only structural data.
2. **Host-side collection:** After container completes, `src/container-runner.ts` reads `tool-calls.json` from the IPC output directory and inserts rows into the `action_log` table.

**PII protection (from security review):** The `action_log` table stores ONLY: `(id, agent, group, tool_name, params_structural_hash, context_category, timestamp)`. NO `params_summary` with free text. Email content, search queries, and API responses are never logged. Pattern detection operates on structural patterns (tool name + hash + timing), not content.

**How pattern detection works:**
1. **Action log table:** `action_log(id, agent, group, tool_name, params_hash, context_category, timestamp)` in SQLite
2. **Daily scheduled task:** Queries action_log for:
   - Repeated tool+params_hash combos (3+ occurrences threshold)
   - Time-correlated actions (same day of week, same time of day)
   - Sequential patterns (tool A always followed by tool B)
3. **Classification:** Feeds candidate patterns to Ollama phi4-mini: "Is this worth automating?"
4. **Proposal:** Sends proposals to CLAIRE via Telegram with concrete actions
5. **Feedback loop:** Approved → create scheduled task. Rejected → mark as "not-automatable" to prevent re-proposing

**Outcome tracking (missing from original spec, added per priority review):**
- When a scheduled task fires that was created from a pattern proposal, the result (success/failure + brief summary) is logged back to `action_log` with an `outcome` field
- Weekly digest to CLAIRE: "3 tasks you approved last month — 2 ran successfully, 1 has been failing for 2 weeks"
- Tasks with 3+ consecutive failures auto-flag for review
- Proposal counter persisted in SQLite (not in-memory) to survive restarts. Cap: 2 proposals per calendar day.

**Files changed:**
- `src/db.ts` — add `action_log` table and `pattern_proposals` table
- New file: `src/pattern-engine.ts` — detection queries, Ollama classification, proposal formatting, outcome tracking
- `container/agent-runner/src/index.ts` — emit tool-call summary to IPC output after session
- `src/container-runner.ts` — collect tool-call summary from IPC output after container exits
- `src/task-scheduler.ts` — add "pattern-detection" daily task, add outcome logging for pattern-originated tasks

### 1.X Telegram Slash Commands (ship ad hoc, not a roadmap item)

Call `bot.api.setMyCommands()` on bot startup. ~10 lines in `src/channels/telegram.ts`. Just do it.

---

## Phase 2: Capability & Memory

**Goal:** Agents discover new capabilities and maintain coherent memory across long sessions.
**Timeline:** 1-2 weeks per feature
**Dependency:** Skill Discovery benefits from architecture redesign (identity.md). Lossless Memory is standalone. Proactive Bus requires IPC protocol change.

### 2.1 Skill Discovery

**Problem:** When an agent can't do something, it has no way to discover or request capabilities.

**What it does:** Searchable catalog of available-but-not-installed skills, plus a request protocol.

**Implementation simplification (from practicality review):** Use QMD as the search backend instead of raw Ollama embeddings. Create `data/skill-catalog/` as a directory of markdown files (one per skill). Add as a QMD collection. `skill_search` becomes a QMD query — no custom embedding infrastructure needed.

**How it works:**
1. **Skill catalog as QMD collection:** `data/skill-catalog/` with one markdown file per skill, YAML frontmatter with name, description, capabilities, installed status, install command
2. **MCP tool:** `skill_search({need: "check arxiv for new papers"})` — QMD semantic search against catalog
3. **Request protocol:** If no match, agent writes a `skill_request` IPC task → routed to Telegram notification for user approval
4. **Auto-install for existing catalog skills:** User approval triggers host-side `apply-skill.ts` + `bun run build`. **Note (from practicality review):** auto-install requires a NanoClaw restart (`bun run build` recompiles but the running process doesn't reload). The approval flow must notify the user that a restart is needed.

**Catalog refresh (from practicality review):** Must run on the host, not in a container — containers mount the repo read-only and can't `git fetch`. Scheduled host-side task: weekly `git fetch upstream` + scan `skill/*` branches + update catalog markdown files.

**Files changed:**
- New directory: `data/skill-catalog/` with markdown files per skill
- QMD config: add `skill-catalog` collection
- `container/agent-runner/src/index.ts` — add `skill_search` and `skill_request` MCP tools
- New IPC handler: `skill_request` in `src/ipc.ts`
- Scheduled task: weekly catalog refresh (host-side)

### 2.2 Lossless Conversation Memory

**Problem:** Long sessions lose coherence as context gets truncated.

**What it does:** Automatically extracts and persists key decisions, commitments, and context before truncation occurs.

**Token counting — redesigned (from practicality review):** The Claude Code SDK does NOT expose token count or context utilization. The spec originally said "detected by token count in the agent runner" which is infeasible. Instead:

1. **Approximate tracking:** Track accumulated message character count in the agent runner. Use conservative estimate (chars/4 ≈ tokens). When estimated usage exceeds 70% of model context window, trigger extraction.
2. **Pre-compaction hook:** Before the SDK's forced truncation fires, extract structured items: decisions made, tasks committed to, questions unanswered, context needed for continuity.
3. **Persistence:** Write to agent's `memory.md` under `## Session Continuity` via IPC
4. **Post-compaction injection:** Context assembler injects continuity items into next context packet

**Context assembler conflict (from architecture review):** Both this spec and the agent architecture redesign modify `src/context-assembler.ts`. Integration order: architecture redesign first (adds lead-agent memory section, increases size cap to 24KB), then lossless memory (adds `## Session Continuity` injection within the expanded budget). This must be sequenced, not parallelized.

**Files changed:**
- `container/agent-runner/src/index.ts` — character-count tracking, auto-trigger extraction
- Agent CLAUDE.md / identity.md: instructions for what to extract
- `src/context-assembler.ts` — inject `## Session Continuity` section (AFTER architecture redesign ships)

### 2.3 Proactive Bus Publishing

**Problem:** After most sessions, valuable context dies with the session. Agents have the bus but only use it when explicitly instructed.

**Redesigned (from practicality review):** The original spec said "inject a system message before session end." This is impossible — `container.stdin.end()` is called immediately after the initial prompt (container-runner.ts lines 637-638). There is no mechanism to write back to stdin after that point.

**Correct implementation path:**
1. Write a pre-teardown IPC prompt file to `/workspace/ipc/input/pre-teardown.json` BEFORE writing the `_close` sentinel
2. The agent-runner's `drainIpcInput()` loop (polling every 500ms) picks up the file and injects it into the SDK session
3. Wait for the agent to respond and publish findings
4. Then write `_close` to terminate the session
5. Timeout: if agent doesn't respond within 30s, write `_close` anyway

**Security requirement (from security review):** Bus trust enforcement (`publish_to_bus` in trust.yaml) must be enforced at the host before this feature ships. The architecture redesign spec's Phase 2 adds host-side enforcement for high-privilege IPC operations. Proactive bus publishing MUST NOT ship before this enforcement exists, or agents can forge `from` fields and publish to groups they shouldn't access.

**Bus message stamping (from security review):** The IPC handler for `bus_publish` must overwrite the `from` field with the verified `sourceGroup` identity, same pattern as `knowledge_publish`.

**Overlap with Ops Routing spec (from priority review):** The Ops Routing & Slack Resilience spec (2026-04-13) already adds cross-group routing tables. Proactive bus publishing is the same goal approached from a different angle. These should be one workstream — fold the pre-teardown prompt mechanism into the Ops Routing implementation plan.

**Files changed:**
- `src/container-runner.ts` — write pre-teardown IPC file before `_close`, add timeout logic
- `src/ipc.ts` — enforce `sourceGroup` stamping on `bus_publish` IPC handler
- `groups/global/CLAUDE.md` — bus publishing guidelines

---

## Future Vision (Separate Specs When Prerequisites Exist)

These features are the long-term direction but are explicitly deferred from the active roadmap. Each requires its own spec when prerequisites are met.

### Architect Agent

**Concept:** A specialized agent (CODE-claw / Simon) with deep, indexed knowledge of the NanoClaw source code, working in a safe git worktree, producing reviewed PRs.

**Why deferred:** Multiple infeasibility findings from reviews:
- **Mount architecture (from practicality review):** Git worktrees use a `.git` file pointing to the main repo's `.git/worktrees/` directory. The main repo is mounted read-only. Worktree git operations (commit, push) need writable access to `.git/objects`, `.git/refs`, `.git/worktrees/`. Requires mounting `.git` separately as read-write — complex path isolation to prevent HEAD corruption.
- **Credential exposure (from architecture + security reviews):** Worktree mount must exclude `.env` and all credential files. The spec said "excluded or made read-only" — this must be a concrete, enforced mechanism, not a hedge.
- **Agent-runner writable (from security review):** The architect must NOT have write access to its own agent-runner source (`data/sessions/{group}/agent-runner-src/`). Read-only mount required.
- **Branch protection (from security review):** Must enforce feature-branch-only pushes via local git config or GitHub branch protection rules, not just LLM instruction-following.

**Prerequisites:** Architecture redesign complete, `nanoclaw-src` QMD collection indexed, worktree mount architecture designed, security guardrails implemented.

**When to revisit:** After Phase 1 and Phase 2 are shipped and stable.

### Knowledge Graph

**Concept:** Entity-relationship graph connecting people, projects, grants, papers across all knowledge stores.

**Why deferred:** Highest complexity in the roadmap. Entity extraction quality depends on Ollama phi4-mini's ability to do cross-document coreference resolution (e.g., "Geschwind lab" vs "Dan Geschwind" vs "Geschwind group") — a known weakness at this model size. Requires entity normalization/canonicalization layer.

**Security concern (from security review):** Email-sourced entity extraction is vulnerable to prompt injection. Emails are attacker-controlled data; crafted email bodies could manipulate entity extraction. Requires prompt hardening and provenance tracking.

**When to revisit:** After shared intelligence layer proves the cross-agent knowledge model works at smaller scale.

### Coordination Hub (WebSocket)

**Concept:** Lightweight WS server for real-time agent presence, direct messaging, system awareness.

**Why deferred (from priority review):** Over-engineered for current usage. A single-user system with ephemeral containers gets ~30% of the hub's value (event broadcasts). The other 70% (presence tracking, real-time agent-to-agent) only matters with persistent agents, which are also deferred. The filesystem bus handles durable delivery. Sub-100ms latency between agents is not a material improvement over 5-30s for a solo user.

**Security requirements for eventual implementation (from security review):**
- Per-spawn HMAC auth token (same pattern as credential proxy)
- Per-connection rate limits (max 10 msg/sec)
- Max concurrent connections limit
- Single-connection-per-agent enforcement
- Heartbeat/ping for presence detection with reconnect backoff

**When to revisit:** If/when persistent agents are implemented.

### Persistent Agents

**Concept:** Keep key agents running continuously with crash recovery and context management.

**Why deferred:** Depends on lossless memory (2.2) and coordination hub (deferred). Major refactor of ephemeral container lifecycle in container-runner.ts. `SESSION_IDLE_MS` (2h) and `SESSION_MAX_AGE_MS` (4h) in config.ts would need to change or be bypassed entirely.

---

## Implementation Priority (Revised After Reviews)

| Order | Feature | Phase | Impact | Effort | Dependencies |
|---|---|---|---|---|---|
| **1** | Gmail Push Monitoring | 1.1 | High | Low-Med | None (GCP setup + re-auth required) |
| **2** | Shared Intelligence Layer | 1.2 | High | Medium | None (new QMD collection + IPC handler) |
| **3** | Pattern Engine + Outcomes | 1.3 | High | Medium | Container-side tool call emission |
| **4** | Skill Discovery | 2.1 | Medium | Medium | Architecture redesign (for identity.md) |
| **5** | Lossless Memory | 2.2 | Medium | Medium | Architecture redesign (context assembler) |
| **6** | Proactive Bus Publishing | 2.3 | Medium | Medium | Bus trust enforcement from arch redesign |

**Slash commands:** Ship ad hoc (~10 lines), not a roadmap item.

**Deferred to future specs:** Coordination Hub, Architect Agent, Knowledge Graph, Persistent Agents.

**Recommended first sprint:** Items 1-3 (Gmail push, shared intelligence, pattern engine). Delivers ambient perception + cross-agent knowledge + agents getting smarter.

## Resolved Questions (From Reviews)

| Question | Resolution | Source |
|---|---|---|
| Gmail Pub/Sub scope | Hard blocker — requires re-auth or dedicated service account. Use service account (smaller blast radius) | Architecture + Security |
| Pull vs Push Pub/Sub | Push mode preferred (truly event-driven). Pull mode is still polling. Use Tailscale Funnel or CF Tunnel for endpoint | Architecture |
| Coordination hub port | Moot — hub deferred. If built later, separate port (can't share with credential proxy, different protocols) | Architecture |
| Pattern engine false positives | 3+ occurrences threshold. Outcome tracking prunes bad proposals. Cap: 2 proposals/day, persisted in SQLite | Priority |
| Tool call logging path | Container-side emission via IPC files, NOT host-side hook. Structural data only, no PII | Practicality + Security |
| Pre-teardown prompt | IPC file injection before `_close` sentinel, NOT stdin (stdin is EOF'd). 30s timeout | Practicality |
| Knowledge publisher auth | Overwrite `agent` field from verified sourceGroup. Discard payload's claimed identity | Security |
| Bus publishing ordering | Must ship AFTER trust enforcement. Stamp `from` field from sourceGroup | Security |
| Architect worktree mounts | Requires separate `.git` mount (read-write) + worktree mount — deferred pending design | Practicality |
| Lossless memory token count | SDK doesn't expose this. Use character-count approximation (chars/4 ≈ tokens) | Practicality |

## Relationship to Other Specs

- **Agent Architecture Redesign (2026-04-13):** Phase 2 features depend on this. Phase 1 is independent. The context assembler changes in lossless memory (2.2) must sequence AFTER the redesign's context assembler changes.
- **Ops Routing & Slack Resilience (2026-04-13):** Proactive bus publishing (2.3) overlaps with this spec's cross-group routing work. Should be one workstream — fold pre-teardown mechanism into the Ops Routing plan.
- **Email Ingestion Pipeline (2026-04-11):** Gmail push monitoring (1.1) replaces the GmailWatcher polling component. The ingestion pipeline's batch classification and QMD storage are a different path (4-hour cadence, QMD collection) and remain unchanged.
- **Multi-Agent Orchestration (2026-04-10):** The filesystem bus stays as the durable delivery layer. Shared intelligence (1.2) extends it with a structured knowledge layer.

## Peer Review Summary

Four independent reviewers examined this spec. Key findings incorporated:

**Architecture:** Gmail OAuth re-auth is a hard blocker. Pre-teardown stdin injection is impossible. Context assembler conflict with architecture redesign. Pub/Sub pull mode still polls.

**Security:** 3 critical (hub auth, worktree credential exposure, writable agent-runner), 4 high (knowledge poisoning, PII in action log, Pub/Sub replay, bus trust ordering). All remediated in v2.

**Practicality:** Tool call logging has no host-side path (redesigned to container-side emission). Worktree mounts infeasible without separate `.git` mount. SDK doesn't expose token count. Pre-teardown requires IPC protocol change.

**Priority:** Spec order was backwards vs stated goals. ~11 unimplemented specs already queued. Cut coordination hub, persistent agents, knowledge graph from active roadmap. Added missing outcome tracking. Moved shared intelligence to Phase 1 (no architecture redesign dependency).
