# SimpleMem Phase-Out: Honcho + Hindsight + QMD

**Date:** 2026-04-06
**Status:** Draft
**Scope:** Remove SimpleMem dependency, add Honcho user-modeling layer, redistribute memory responsibilities

## Problem

SimpleMem serves as a general-purpose memory store but overlaps heavily with QMD (which already indexes the same content) and Hindsight (which already stores agent-level facts). Five ingest scripts feed content into SimpleMem that QMD already has. Meanwhile, no system models the *user* across sessions — preferences, communication patterns, context continuity.

## Decision

Replace SimpleMem with a three-layer memory stack:

| Layer | System | Role | Agent Access |
|-------|--------|------|-------------|
| Document search | QMD | BM25 + vector search over vault, notes, sessions, docs | `mcp__qmd__*` (existing, unchanged) |
| Fact memory | Hindsight | Store/recall discrete facts across sessions | `mcp__hindsight__*` (existing, unchanged) |
| User modeling | Honcho | Peer profiles, session continuity, reasoning about user | Auto-inject context + `mcp__honcho__*` tools (new) |

No data migration from SimpleMem — QMD already indexes the same content, Hindsight already stores facts.

## Honcho Infrastructure

Honcho is already running for Hermes Agent:

- **API:** `http://localhost:8010` (Docker, no auth)
- **Database:** PostgreSQL + pgvector on port 5442
- **LLM:** Ollama (qwen3-coder-next for reasoning, nomic-embed-text for embeddings)
- **Background:** Deriver worker for async reasoning ("dreaming")
- **Existing workspaces:** hermes, franklin, test-embed

NanoClaw will create a new `nanoclaw` workspace, keeping data isolated from Hermes.

## Honcho Data Model

```
Workspace: "nanoclaw"
  Peer (user):  "mgandal"
  Peer (AI):    per-group (e.g. "claire", "lab-claw", "code-claw", "home-claw", "science-claw")
  Session:      1:1 mapping with NanoClaw session IDs
  Messages:     user + assistant messages forwarded from agent conversations
```

Each group's AI peer is separate so Honcho builds different models for how the user interacts with each group's agent.

## Honcho Integration — Reusing Hermes Patterns

The integration mirrors Hermes Agent's Honcho plugin architecture (`~/.hermes/hermes-agent/plugins/memory/honcho/`). Three-phase turn cycle:

### Phase 1: Prefetch (background, before next turn)

After each query completes, fire a background HTTP call to `peer.context()` or `peer.chat()`. Cache the result. On the next turn, the cached context is ready immediately — zero latency on the hot path.

In NanoClaw, this fires during the IPC wait loop (between queries in the agent-runner's while loop).

### Phase 2: Inject (at query time, not persisted)

Prepend the cached context to the user's message text as a fenced block before pushing into the MessageStream:

```
<memory-context>
[System note: The following is recalled memory context,
NOT new user input. Treat as informational background data.]

{cached context from Honcho}
</memory-context>

{actual user message}
```

This matches Hermes exactly. The context is part of the prompt text sent to `query()`, but since it's in the user message (not system prompt), it gets compacted naturally and doesn't recursively appear in future context fetches.

### Phase 3: Sync (async, after each turn)

After each query result, queue user + assistant messages to Honcho via `session.add_messages()` in a background async call. Messages are buffered and flushed:
- After each turn (async, non-blocking)
- On session close (`_close` sentinel)

This matches Hermes's `write_frequency: "async"` mode.

### Cost-Awareness

Start with conservative defaults matching Hermes:
- `recall_mode: "hybrid"` — auto-inject context + expose tools
- `context_cadence: 1` — fetch context every turn (can increase later)
- `reasoning_level: "minimal"` — cheapest dialectic level (local Ollama, so cost = time not money)
- `injection_frequency: "every-turn"` — inject on every turn

## Honcho MCP Tools (4 tools, matching Hermes)

Exposed via a thin MCP stdio server inside the container:

| Tool | Honcho API | Purpose |
|------|-----------|---------|
| `honcho_profile` | `GET /peers/{id}/card` | Retrieve peer card — fast, no LLM call |
| `honcho_search` | `POST /peers/{id}/search` | Semantic search over message history |
| `honcho_context` | `POST /peers/{id}/chat` | LLM-synthesized answer using dialectic reasoning |
| `honcho_conclude` | `POST /workspaces/{id}/conclusions` | Save a fact/conclusion back to Honcho |

## New Files

| File | Purpose | Mirrors |
|------|---------|---------|
| `container/agent-runner/src/honcho-client.ts` | HTTP client for Honcho REST API (workspace/peer/session CRUD, context, chat, search, conclude) | Hermes `client.py` |
| `container/agent-runner/src/honcho-session.ts` | Session manager: async write queue, background prefetch, context caching, message buffering | Hermes `session.py` |
| `container/agent-runner/src/honcho-mcp-stdio.ts` | MCP stdio server exposing 4 tools | Hermes `__init__.py` tool dispatch |

## Modified Files

| File | Change |
|------|--------|
| `src/container-runner.ts` | Add HONCHO_URL env var injection (same pattern as QMD/Hindsight). Remove SIMPLEMEM_URL injection + redaction. |
| `container/agent-runner/src/index.ts` | Remove simplemem MCP server config. Add honcho MCP server. Remove `mcp__simplemem__*` from allowedTools, add `mcp__honcho__*`. Integrate HonchoSession into query loop (prefetch, inject, sync). |
| `scripts/sync/sync-all.sh` | Remove steps 4, 5, 6, 9, 11 (all SimpleMem ingest steps). Renumber remaining steps. |
| `.env` | Remove SIMPLEMEM_URL. Add HONCHO_URL=http://localhost:8010 |
| `src/health-monitor.test.ts` | Remove SimpleMem health check references |

## Deleted Files

| File | Reason |
|------|--------|
| `scripts/sync/simplemem-ingest.py` | Email→SimpleMem ingest (QMD already indexes emails) |
| `scripts/sync/vault-ingest.py` | Vault→SimpleMem ingest (QMD vault collection already covers this) |
| `scripts/sync/claude-history-ingest.py` | Claude history→SimpleMem (QMD sessions collection covers this) |
| `scripts/sync/telegram-history-ingest.py` | Telegram→SimpleMem (QMD indexes conversation transcripts) |
| `scripts/sync/apple-notes-ingest.py` | Apple Notes→SimpleMem (QMD apple-notes collection covers this) |
| `scripts/fixes/restart-simplemem.sh` | SimpleMem restart script |
| `scripts/sync/*-ingest-state.json` | Ingest state tracking files |

## Sync Script After Phase-Out

`sync-all.sh` simplified from 11 steps to 5:

| Step | What |
|------|------|
| 1 | Gmail sync (mgandal → mikejg1838) |
| 2 | Apple Notes re-export to markdown |
| 3 | QMD update (re-scan collections) |
| 4 | QMD embed (vectorize pending docs) |
| 5 | (Exchange + Calendar remain SKIPPED) |

## Documentation Updates

- `CLAUDE.md`: Remove SimpleMem from MCP servers list, add Honcho
- `MEMORY.md`: Update SimpleMem section → Honcho section
- `groups/global/CLAUDE.md`: Update memory layer references if present
- Memory-status skill: Remove SimpleMem checks, add Honcho checks
- Health monitor: Remove SimpleMem health probe, add Honcho health probe

## SimpleMem Docker Container

The SimpleMem Docker container (`simplemem`) is shared with Marvin. NanoClaw stops using it but does NOT shut it down — that's Marvin's decision. Remove SIMPLEMEM_URL from NanoClaw's `.env` only.

## Testing

1. **Unit tests:** honcho-client HTTP calls (mock fetch)
2. **Integration:** Verify container-runner no longer injects SIMPLEMEM_URL
3. **Integration:** Verify agent-runner builds and starts without simplemem references
4. **Manual:** Send a message → confirm it appears in Honcho session (`POST /v3/workspaces/nanoclaw/sessions/list`)
5. **Manual:** Second message → confirm `<memory-context>` fence appears in prompt
6. **Manual:** Verify `honcho_profile` / `honcho_search` / `honcho_context` / `honcho_conclude` tools work from agent

## Rollback

If Honcho integration causes issues:
1. Remove HONCHO_URL from `.env` — agent-runner skips Honcho if env var is absent
2. All Honcho code is conditional on `process.env.HONCHO_URL` (same pattern as QMD, Hindsight)
3. SimpleMem Docker container is still running (shared with Marvin) — can re-add SIMPLEMEM_URL if needed

## Non-Goals

- Migrating SimpleMem data to Honcho (QMD already has the content)
- Modifying the Hermes Honcho setup or shared config
- Changing QMD or Hindsight configuration
- Shutting down SimpleMem Docker container (shared with Marvin)
