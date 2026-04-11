# SimpleMem Phase-Out: Honcho + Hindsight + QMD (v2)

**Date:** 2026-04-06
**Status:** Draft (v2 — peer-reviewed)
**Reviewer:** Hermes (Chief of Staff agent)
**Scope:** Remove SimpleMem dependency, add Honcho user-modeling layer, redistribute memory responsibilities

## Changelog from v1

| # | Category | Change |
|---|----------|--------|
| 1 | CRITICAL | Added container networking section — Honcho URL must use gateway IP, not localhost |
| 2 | CRITICAL | Added graceful degradation spec — timeouts, health gating, empty-context guard |
| 3 | CRITICAL | Added cron/scheduled-task guard — don't pollute Honcho with bot messages |
| 4 | CRITICAL | Added workspace bootstrap step — "nanoclaw" workspace must be created before use |
| 5 | HIGH | Expanded honcho-client.ts scope — spec now lists all 10+ API calls needed |
| 6 | HIGH | Added message chunking requirement (25k char limit per Honcho message) |
| 7 | HIGH | Added explicit HTTP timeout table for all Honcho call types |
| 8 | HIGH | Added missing test file cleanup (audit-fixes.test.ts, container-runner.test.ts) |
| 9 | MEDIUM | Added AI peer naming convention (maps to group folder name) |
| 10 | MEDIUM | Added async write mechanism for Node.js (fire-and-forget Promise) |
| 11 | MEDIUM | Added race condition mitigations for prefetch timing and concurrent sync |
| 12 | MEDIUM | Added message deduplication requirement for container crash recovery |
| 13 | LOW | Added _close sentinel flush handler location |
| 14 | LOW | Noted SimpleMem JWT expires Apr 28 — rollback window is 3 weeks |
| 15 | LOW | Confirmed no new npm dependencies needed (raw fetch is sufficient) |

---

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

- **API:** `http://localhost:8010` (Docker, no auth — "local" placeholder key)
- **Database:** PostgreSQL + pgvector on port 5442
- **LLM:** Ollama (qwen3-coder-next for reasoning, nomic-embed-text for embeddings)
- **Background:** Deriver worker for async reasoning ("dreaming")
- **Existing workspaces:** hermes, franklin, test-embed
- **API version:** v3 (Honcho API v3.0.3)

NanoClaw will create a new `nanoclaw` workspace, keeping data isolated from Hermes.

### Container Networking (CRITICAL)

NanoClaw agents run inside Apple Container (Linux VMs). Containers cannot reach `localhost` on the host. All host service URLs must be rewritten to the container gateway IP.

The existing pattern in `container-runner.ts` (lines 307-332) already handles this for QMD, Hindsight, and SimpleMem:

```
Host:      http://localhost:8010
Container: http://${CONTAINER_HOST_GATEWAY}:8010
```

Where `CONTAINER_HOST_GATEWAY` is auto-detected from the bridge100/bridge0 network interface (typically `192.168.64.x`).

**HONCHO_URL must follow this exact rewrite pattern.** The container-runner already has the infrastructure — just add Honcho to it.

### Workspace Bootstrap

The `nanoclaw` workspace must be created before any container can use Honcho. Add a startup check to `src/index.ts` (alongside existing service health checks):

```typescript
// At NanoClaw startup, ensure workspace exists
async function bootstrapHoncho() {
  if (!process.env.HONCHO_URL) return;
  try {
    await fetch(`${process.env.HONCHO_URL}/v3/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'nanoclaw' })
    });
  } catch {
    // Workspace may already exist (409) — that's fine
  }
}
```

## Honcho Data Model

```
Workspace: "nanoclaw"
  Peer (user):  "mgandal"
  Peer (AI):    per-group, using group folder name (e.g. "claire", "lab", "code", "home", "science")
  Session:      1:1 mapping with NanoClaw session IDs
  Messages:     user + assistant messages forwarded from agent conversations
```

### AI Peer Naming Convention

The AI peer name maps to the group folder name from `groups/` directory:
- `groups/claire/` → AI peer `"claire"`
- `groups/lab/` → AI peer `"lab"`
- `groups/code/` → AI peer `"code"`

This uses `containerInput.groupFolder` (not `ASSISTANT_NAME` from .env). Each group's AI peer is separate so Honcho builds different models for how the user interacts with each group's agent.

### Session ID Mapping

NanoClaw session IDs are SDK-generated UUIDs that change on compaction. The Honcho session should:
- Map 1:1 to NanoClaw session IDs
- When a new SDK session is created (compaction), create a new Honcho session
- The old Honcho session retains its messages — Honcho's cross-session reasoning handles continuity
- Resolution: simple lookup by `sessionId` — no per-directory/per-repo complexity needed

## Honcho Integration — Reusing Hermes Patterns

The integration mirrors Hermes Agent's Honcho plugin architecture (`~/.hermes/hermes-agent/plugins/memory/honcho/`). Three-phase turn cycle:

### Phase 1: Prefetch (background, before next turn)

After each query completes, fire a background HTTP call to get context. Cache the result. On the next turn, the cached context is ready immediately — zero latency on the hot path.

In NanoClaw, this fires during the IPC wait loop (between queries in the agent-runner's `while` loop, after `writeOutput()` returns and before the next `waitForIpcMessage()` completes).

**Race condition mitigation:** The prefetch Promise must be awaited with a timeout before injecting context into the next turn. If the prefetch hasn't completed when the next message arrives, wait up to 3 seconds, then proceed without context rather than blocking.

```typescript
// After runQuery() returns:
prefetchPromise = honcho.prefetchContext(); // fire-and-forget

// Before next runQuery():
const context = await Promise.race([
  prefetchPromise,
  new Promise(resolve => setTimeout(() => resolve(null), 3000))
]);
```

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

**Empty-context guard:** Only inject if the context is non-empty after trimming. An empty `<memory-context>` fence wastes tokens.

```typescript
if (context && context.trim().length > 0) {
  prompt = `<memory-context>\n[System note: ...]\n\n${context}\n</memory-context>\n\n${prompt}`;
}
```

This matches Hermes exactly. The context is part of the prompt text sent to `query()`, but since it's in the user message (not system prompt), it gets compacted naturally and doesn't recursively appear in future context fetches.

### Phase 3: Sync (async, after each turn)

After each query result, send user + assistant messages to Honcho via `session.add_messages()`.

**Node.js async mechanism:** Use fire-and-forget Promises with error swallowing:

```typescript
// After runQuery() returns and output is written:
honcho.syncMessages(userMsg, assistantMsg).catch(err => {
  console.error('[honcho] sync failed:', err.message);
});
```

Messages are synced:
- After each turn (async, non-blocking fire-and-forget)
- On session close (`_close` sentinel at line 461/503 in agent-runner) — flush pending before exit

**Message chunking:** Honcho has a 25k character limit per message. Long assistant responses must be chunked with `[continued N/M]` prefixes, matching the Hermes implementation.

**Deduplication:** Track which messages have been synced (e.g., a `Set<string>` of message IDs or turn indices). If the container crashes and restarts, avoid re-syncing already-sent messages.

### Scheduled Task Guard

**Do NOT run Honcho prefetch, inject, or sync during scheduled/cron tasks.** Automated messages should not pollute user modeling.

```typescript
if (containerInput.isScheduledTask) {
  // Skip all Honcho phases
}
```

This matches Hermes's cron guard in `__init__.py`.

### Cost-Awareness

Start with conservative defaults matching Hermes:
- `recall_mode: "hybrid"` — auto-inject context + expose tools
- `context_cadence: 1` — fetch context every turn (can increase later)
- `reasoning_level: "minimal"` — cheapest dialectic level (local Ollama, so cost = time not money)
- `injection_frequency: "every-turn"` — inject on every turn

## Honcho HTTP Client (honcho-client.ts)

Raw HTTP client for the Honcho v3 REST API. **No npm SDK exists** — must implement from scratch using `fetch()`.

### Required API Calls

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/v3/workspaces` | Create workspace (bootstrap) |
| POST | `/v3/workspaces/{ws}/peers` | Create user/AI peer |
| POST | `/v3/workspaces/{ws}/peers/list` | List peers (check existence) |
| GET | `/v3/workspaces/{ws}/peers/{pid}/card` | Get peer card (profile tool) |
| POST | `/v3/workspaces/{ws}/peers/{pid}/search` | Semantic search (search tool) |
| POST | `/v3/workspaces/{ws}/peers/{pid}/chat` | Dialectic reasoning (context tool) |
| POST | `/v3/workspaces/{ws}/sessions` | Create session |
| POST | `/v3/workspaces/{ws}/sessions/list` | List sessions |
| POST | `/v3/workspaces/{ws}/sessions/{sid}/peers` | Attach peers to session |
| POST | `/v3/workspaces/{ws}/sessions/{sid}/messages` | Add messages |
| POST | `/v3/workspaces/{ws}/sessions/{sid}/context` | Get session context |
| POST | `/v3/workspaces/{ws}/conclusions` | Save conclusion (conclude tool) |

### HTTP Timeout Table

| Call Type | Timeout | Rationale |
|-----------|---------|-----------|
| Workspace/peer/session CRUD | 5s | Simple DB operations |
| Peer card (profile) | 10s | Read-only, no LLM |
| Peer search | 10s | Vector search, no LLM |
| Peer chat (dialectic) | 60s | Ollama inference (can be slow) |
| Session context | 30s | May involve reasoning |
| Message sync | 10s | Write operation |
| Conclusions | 10s | Write operation |
| Connection timeout | 5s | All calls |

### Graceful Degradation

All Honcho calls must be wrapped in try/catch with timeouts:

```typescript
async function honchoFetch(path: string, options: RequestInit, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${HONCHO_URL}${path}`, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    console.error(`[honcho] ${path} failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

If Honcho is unreachable:
- **Prefetch:** Return empty string, continue without context
- **Inject:** Skip injection (empty-context guard handles this)
- **Sync:** Log error, discard messages (they're not critical for functionality)
- **Tools:** Return error message to agent ("Honcho is currently unavailable")

## Honcho MCP Tools (4 tools, matching Hermes)

Exposed via a thin MCP stdio server inside the container (`honcho-mcp-stdio.ts`). The stdio server internally makes HTTP calls to Honcho at `HONCHO_URL`.

| Tool | Honcho v3 Endpoint | Purpose |
|------|-------------------|---------|
| `honcho_profile` | `GET /v3/workspaces/{ws}/peers/{pid}/card` | Retrieve peer card — fast, no LLM call |
| `honcho_search` | `POST /v3/workspaces/{ws}/peers/{pid}/search` | Semantic search over message history |
| `honcho_context` | `POST /v3/workspaces/{ws}/peers/{pid}/chat` | LLM-synthesized answer using dialectic reasoning |
| `honcho_conclude` | `POST /v3/workspaces/{ws}/conclusions` | Save a fact/conclusion back to Honcho |

Note: `{ws}` = "nanoclaw", `{pid}` = resolved peer ID for the user or AI.

## New Files

| File | Purpose | Complexity | Mirrors |
|------|---------|-----------|---------|
| `container/agent-runner/src/honcho-client.ts` | HTTP client wrapping 12 Honcho v3 REST endpoints with timeouts, error handling, and retry | HIGH (~300 lines) | Hermes `client.py` (556 lines) |
| `container/agent-runner/src/honcho-session.ts` | Session manager: prefetch cache, message buffer, sync queue, chunking, dedup, scheduled-task guard | HIGH (~400 lines) | Hermes `session.py` (1083 lines) |
| `container/agent-runner/src/honcho-mcp-stdio.ts` | MCP stdio server exposing 4 tools, delegating to honcho-client | LOW (~150 lines) | Hermes `__init__.py` tool dispatch |

**Estimated total:** ~850 lines of new TypeScript. This is significant — the Hermes reference is ~2,400 lines of Python, but NanoClaw's implementation can be leaner because:
- No threading (Node.js async handles it)
- Simpler session resolution (no per-directory/per-repo strategies)
- No config file parsing (env vars only)

## Modified Files

| File | Change |
|------|--------|
| `src/index.ts` | Add Honcho workspace bootstrap at startup. Add Honcho health check to MCP endpoints array (line ~919). Remove SimpleMem health fix handler (lines 836-847). |
| `src/container-runner.ts` | Add HONCHO_URL env var injection with gateway IP rewrite (same pattern as QMD/Hindsight, lines 307-332). Remove SIMPLEMEM_URL injection + redaction (line 55). |
| `container/agent-runner/src/index.ts` | Remove simplemem MCP server config (lines 216-230). Add honcho MCP server. Remove `mcp__simplemem__*` from allowedTools (line 594), add `mcp__honcho__*`. Integrate HonchoSession into query loop (prefetch after runQuery, inject before stream.push, sync after writeOutput). Add _close sentinel hook for Honcho flush. |
| `scripts/sync/sync-all.sh` | Remove steps 4, 5, 6, 9, 11 (all SimpleMem ingest steps). Renumber remaining steps. |
| `.env` | Remove SIMPLEMEM_URL. Add HONCHO_URL=http://localhost:8010 |
| `src/health-monitor.test.ts` | Remove SimpleMem health check references |
| `src/audit-fixes.test.ts` | Remove SimpleMem test references (lines ~637, 642, 646, 658, 797) |
| `src/container-runner.test.ts` | Remove SimpleMem URL rewriting tests (lines ~497, 553, 555, 566, 581, 583, 594, 595). Add equivalent HONCHO_URL rewriting tests. |

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

**Note:** The SimpleMem JWT token in `.env` expires Apr 28, 2026. If rollback is needed after that date, a new token must be generated. This gives a ~3 week rollback window from spec date.

## Dependencies

No new npm dependencies required. The honcho-client.ts uses native `fetch()` (available in Node.js 18+). The MCP stdio server uses the existing `@modelcontextprotocol/sdk` (v1.12.1, already in package.json).

## Testing

1. **Unit tests:** honcho-client HTTP calls (mock fetch) — cover all 12 endpoints, timeout behavior, error handling
2. **Unit tests:** honcho-session prefetch/inject/sync lifecycle — cover empty context, chunking, dedup
3. **Integration:** Verify container-runner injects HONCHO_URL with gateway IP rewrite
4. **Integration:** Verify container-runner no longer injects SIMPLEMEM_URL
5. **Integration:** Verify agent-runner builds and starts without simplemem references
6. **Integration:** Verify scheduled tasks skip Honcho phases entirely
7. **Manual:** Send a message → confirm it appears in Honcho session (`POST /v3/workspaces/nanoclaw/sessions/list`)
8. **Manual:** Second message → confirm `<memory-context>` fence appears in prompt (only if non-empty)
9. **Manual:** Verify all 4 tools work: `honcho_profile`, `honcho_search`, `honcho_context`, `honcho_conclude`
10. **Manual:** Kill container mid-conversation → restart → verify no duplicate messages synced
11. **Manual:** Stop Honcho Docker → send message → verify agent works without memory (graceful degradation)

## Rollback

If Honcho integration causes issues:
1. Remove HONCHO_URL from `.env` — agent-runner skips Honcho if env var is absent
2. All Honcho code is conditional on `process.env.HONCHO_URL` (same pattern as QMD, Hindsight)
3. SimpleMem Docker container is still running (shared with Marvin) — can re-add SIMPLEMEM_URL if needed (within JWT expiry window — before Apr 28)

## Non-Goals

- Migrating SimpleMem data to Honcho (QMD already has the content)
- Modifying the Hermes Honcho setup or shared config
- Changing QMD or Hindsight configuration
- Shutting down SimpleMem Docker container (shared with Marvin)
- Implementing the full Hermes session strategy system (per-directory, per-repo, etc.)

## Implementation Order

Recommended phasing to minimize risk:

| Phase | What | Risk |
|-------|------|------|
| 1 | Build honcho-client.ts + honcho-session.ts (no integration yet) | None — new files only |
| 2 | Build honcho-mcp-stdio.ts, add to agent-runner MCP config | Low — additive |
| 3 | Integrate prefetch/inject/sync into query loop | Medium — modifies hot path |
| 4 | Remove SimpleMem from container-runner + agent-runner | Medium — removes functionality |
| 5 | Delete ingest scripts, clean up sync-all.sh | Low — removing dead code |
| 6 | Update docs + tests | Low — bookkeeping |

Phases 1-3 can be done with SimpleMem still active (belt-and-suspenders). Phase 4 is the point of no return (within rollback window).
