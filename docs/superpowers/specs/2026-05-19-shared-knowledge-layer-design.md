# Phase 1.2: Shared Knowledge Layer — Design Spec

**Status:** Spec — round-1 peer-review amendments applied. Awaiting user review before plan-writing.
**Owner:** mgandal
**Date:** 2026-05-19 (spec); round-1 amendments same day
**Predecessor:** Phase 1.2 partial ship (commits range in `docs/superpowers/plans/2026-04-13-smarter-claw-phase1.md`; `src/ipc/handlers/knowledge-publish.ts` + `src/knowledge.ts` + both MCP stubs already live in `ipc-mcp-stdio.ts:1815-1878`).
**Successor:** Phase 1.3 Pattern Engine.

**Round-1 amendments (peer review on 2026-05-19):**
- **Critical**: §4.2 `execute()` now has explicit `response.ok` check. `fetch` doesn't throw on non-2xx, and the `skill_search` reference pattern (which lacks the check) would have produced silent false-success on QMD 503 responses with valid JSON bodies.
- **Important**: §4.1 + Commit 1 now explicitly call out that `confidence` must be added to BOTH `KnowledgeEntry` in `src/knowledge.ts` AND the handler's local `Input` interface at `src/ipc/handlers/knowledge-publish.ts:7-12`. These are structurally distinct types.
- **Important**: All `skill_search` line citations corrected from stale `1593-1614` to actual `1444-1533` (function range) and `1456-1478` (JSON-RPC body subrange).
- **Nit**: §3.5 `execFile` env override adds `HOME` (launchd strips it, and `qmd` may read `~/.config/qmd/`).

---

## TL;DR

Phase 1.2 is partially shipped. The publish path exists end-to-end: `knowledgePublishHandler` at `src/ipc/handlers/knowledge-publish.ts`, `publishKnowledge()` file writer at `src/knowledge.ts`, and the `knowledge_publish` MCP tool at `ipc-mcp-stdio.ts:1817`. The search path is a stub: `knowledge_search` at `ipc-mcp-stdio.ts:1853` returns a plain-text instruction redirecting the agent to call QMD directly — it never writes an IPC file, never polls for results, and provides zero actual search capability.

This spec completes Phase 1.2 in three targeted changes:

1. **Schema extension** — add `confidence: number` (integer 1-10) to `KnowledgeEntry` and the YAML frontmatter written by `publishKnowledge()`. One new field flows from the MCP tool input → IPC payload → handler `parse()` → `KnowledgeEntry` → frontmatter.
2. **Real `knowledge_search` IPC handler** — a new `result`-kind handler at `src/ipc/handlers/knowledge-search.ts` that calls QMD's HTTP MCP endpoint at `localhost:8181/mcp` (using the JSON-RPC body pattern from `skill_search` at `src/ipc.ts:1456-1478`, but WITH a `response.ok` guard that `skill_search` lacks — see §4.2 critical-fix note) and writes structured results to `knowledge_results/{requestId}.json`. The container-side tool is rewritten from a redirect stub to a proper `waitForIpcResult` round-trip.
3. **QMD ingest trigger on publish** — after `publishKnowledge()` writes the markdown file, fire a fire-and-forget `qmd update agent-knowledge` subprocess call (using absolute binary path per `qmd-update-cmd-needs-absolute-interpreter` feedback) so the finding is BM25-searchable within ~30 seconds rather than waiting for the 4-hourly sync.

---

## 1. Goal and Non-Goals

### Goal

Enable any agent in any group to publish a structured finding and have it immediately queryable by any other agent. SCIENCE-claw discovers something about a protein at 9am and publishes it. CLAIRE can call `knowledge_search` at 9:01am and find it. No sync cycle, no manual indexing, no cross-group message passing required.

### Non-Goals

**NOT a replacement for `vault` or `nanoclaw-docs` QMD collections.** Those index externally curated documents (vault markdown files, architecture docs). `agent-knowledge` indexes agent-published findings — programmatic outputs of agent reasoning. The distinction is authorship: vault = human-curated, agent-knowledge = agent-curated. Agents should NOT publish findings to `vault`; they should call `knowledge_publish`.

**NOT a multi-agent message bus.** The bus (`bus_publish`, `publish_to_bus`) is for time-sensitive, directed coordination: "Einstein, look at this now." `agent-knowledge` is for durable retrieval: "What do we know about X?" Different latency semantics, different durability guarantees, different use cases. The two layers complement each other — `knowledgePublishHandler.execute()` already fires a bus message after writing the file (`src/ipc/handlers/knowledge-publish.ts:58-66`).

**NOT a memory layer.** Hindsight handles conversational memory (session-continuity, user preferences, action history). Honcho handles user modeling. `agent-knowledge` is a structured-findings pool — higher signal, explicit evidence, cross-agent. See Section 9 for the full comparison and the decision tree for which layer to use.

**NOT implementing TTL or automatic expiry.** Findings do not expire in Phase 1.2. Staleness handling is deferred. See Open Questions.

**NOT implementing `knowledge_supersede`.** Contradictions are handled by keeping all findings and returning all matches ranked by QMD relevance. See Section 6.

**NOT implementing per-group privacy.** All findings are visible to all agents. Agents should not publish sensitive findings here. See Section 5.

---

## 2. Schema Design

### 2.1 `KnowledgeEntry` interface (src/knowledge.ts)

Current (`src/knowledge.ts:6-13`):

```typescript
export interface KnowledgeEntry {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
  agent?: string; // ignored — overwritten by sourceGroup
}
```

After this spec:

```typescript
export interface KnowledgeEntry {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
  confidence?: number; // 1-10 integer. Defaults to 5 if missing or out-of-range.
  agent?: string;      // ignored — overwritten by sourceGroup (poisoning prevention)
}
```

### 2.2 Field contract

| Field | Type | Constraints | Rationale |
|---|---|---|---|
| `topic` | `string` | max 120 chars in MCP schema; free text | Category label. Free text intentional — no controlled vocabulary until agents converge naturally through retrieval. |
| `finding` | `string` | markdown prose | The substantive content. Embedded in document body — this is the primary semantic search target. |
| `evidence` | `string` | non-empty | Source attestation. Embedded as `**Evidence:** <evidence>` in the document body. URL/DOI preferred; conversation reference acceptable. |
| `confidence` | `integer 1-10` | defaults to 5 if missing | Agent's self-assessed confidence. Stored in frontmatter. Returned in search results so callers can weight findings. Not used for QMD ranking. |
| `agent` (provenance) | `string` | overwritten from `ctx.sourceGroup` | Poison-prevention. The handler always overwrites this with the verified IPC path identity. See `src/knowledge.ts:39-44`. |
| `date` | ISO date | set by `publishKnowledge()` | In frontmatter. Enables date-range lex queries. |
| `tags` | `string[]` | array | QMD lex index scans frontmatter tags field. |

### 2.3 Confidence scale semantics

| Score | Meaning |
|---|---|
| 1-3 | Weak — hypothesis, preliminary observation, unverified |
| 4-6 | Moderate — observed pattern, reasonable inference, partial evidence |
| 7-9 | High — primary source, direct evidence, well-supported |
| 10 | Definitive — peer-reviewed, user-confirmed, or formal result |

Agents self-assess. No platform-level validation beyond the integer range. The scale is included in the MCP tool description.

### 2.4 Evidence field conventions

Preferred forms in decreasing reliability order:
1. DOI or arXiv URL: `https://doi.org/10.1234/...`
2. Web URL with access date: `https://example.com/page (accessed 2026-05-19)`
3. File path reference: `file:/workspace/group/papers/chrombert.pdf`
4. Message reference: `conversation telegram_science-claw 2026-05-19`
5. Internal inference: `inferred from QMD search on topic X`

Not validated beyond non-empty. Agents should aim for option 1.

### 2.5 Frontmatter shape after this spec

```yaml
---
agent: telegram_science-claw
topic: APA regulation
date: 2026-05-19
tags:
  - GWAS
  - APA
confidence: 8
---

ChromBERT (Tongji Zhang Lab) predicts TF binding at APA sites with 0.87 AUC on SFARI snATAC-seq data. Strengthens Aim 2 of R01-MH137578 targeting non-neuronal cell types.

**Evidence:** https://doi.org/10.1234/chrombert
```

The `agent` field in frontmatter is the verified `sourceGroup` path (e.g., `telegram_science-claw`), not the agent persona name. Multiple personas (Einstein, Simon) can operate in the same group; the group path is the stable provenance identifier.

---

## 3. QMD Collection Design

### 3.1 Collection name and host path

Collection name: `agent-knowledge`. Do NOT rename. This name is referenced in 12+ files including `.gitignore:13`, `src/ipc/handlers/knowledge-publish.ts:14`, both MCP tools at `ipc-mcp-stdio.ts:1872`, and the original Phase 1.2 roadmap spec at `docs/superpowers/specs/2026-04-13-smarter-claw-roadmap-design.md:128`.

Host directory: `data/agent-knowledge/` relative to project root. Absolute: `path.join(DATA_DIR, 'agent-knowledge')`. The `KNOWLEDGE_DIR` constant at `src/ipc/handlers/knowledge-publish.ts:14` already points here.

### 3.2 File layout

One markdown file per finding. Filename: `{ISO-date}-{topic-slug}-{8-char-uuid}.md` (from `src/knowledge.ts:29-33`). All files flat in `data/agent-knowledge/` — no subdirectories. QMD indexes all `.md` files.

### 3.3 Embedding strategy

- Primary embedding target: full document body (topic + finding + evidence prose). QMD embeds entire files by default; no custom extraction needed.
- `knowledge_search` sends both `vec` (semantic) and `lex` (BM25) sub-queries in parallel. The `skill_search` handler at `src/ipc.ts:1470` sends lex-only (`searches: [{ type: 'lex', query }]`); `knowledge_search` needs both because findings may use specialized vocabulary (BM25 handles exact terms) while paraphrased queries need semantic matching.

### 3.4 QMD collection registration (operational, not in code)

One-time setup — already documented in the Phase 1.2 plan (Task B4 at `docs/superpowers/plans/2026-04-13-smarter-claw-phase1.md:987-1008`). If not already done:

```bash
qmd collection add /Users/mgandal/Agents/nanoclaw/data/agent-knowledge \
  --name agent-knowledge --ext md
qmd embed agent-knowledge
```

Use the absolute path. `qmd collection add` with a relative path silently uses CWD, which differs under launchd. Per `qmd-update-cmd-needs-absolute-interpreter` feedback.

If the collection is already registered (Task B4 was completed), run only `qmd embed agent-knowledge` to vectorize any findings written since then.

### 3.5 Background QMD update on publish

Current `knowledgePublishHandler.execute()` writes the file and fires a bus message but does NOT trigger a QMD ingest (`src/ipc/handlers/knowledge-publish.ts:50-67`). New findings are therefore searchable only after the next 4-hourly sync run. This is the primary operability gap.

Fix: add a fire-and-forget `qmd update agent-knowledge` subprocess call after `publishKnowledge()` returns. Best-effort — failure is logged and swallowed (same pattern as the bus publish at lines 58-66).

```typescript
import { execFile } from 'child_process';

const QMD_BIN = '/opt/homebrew/bin/qmd'; // verify with `which qmd` at plan time
execFile(
  QMD_BIN,
  ['update', 'agent-knowledge'],
  {
    timeout: 30_000,
    // Round-1 amendment: launchd strips both PATH and HOME. qmd may read its
    // config from ~/.config/qmd/ at runtime; HOME=undefined causes silent config
    // miss. Provide both explicitly. Note that process.env.HOME may itself be
    // empty under launchd — the fallback is an explicit user-home string,
    // matching the pattern used elsewhere in the codebase for subprocess env.
    env: {
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '/Users/mgandal',
    },
  },
  (err) => {
    if (err) {
      logger.warn({ err, sourceGroup: ctx.sourceGroup, topic: input.topic },
        'qmd update agent-knowledge failed (non-fatal)');
    }
  },
);
```

**Dependency flag**: `QMD_BIN` path must be verified at plan time via `which qmd` in an interactive shell. On this system it is likely `/opt/homebrew/bin/qmd`. The `qmd-update-cmd-needs-absolute-interpreter` feedback was raised because launchd strips Homebrew from PATH — the handler runs under launchd, so the absolute path is mandatory.

**BM25 vs semantic gap**: `qmd update` rebuilds the BM25 index (available within ~30 seconds). It does NOT run embedding — that requires `qmd embed` (heavier, runs on the 4-hourly sync). After a publish + background update: BM25 (`lex`) search finds the finding within ~30s; semantic (`vec`) search may miss it until the next embed cycle. The `knowledge_search` handler sends both sub-query types — if `vec` misses the very latest finding, `lex` bridges the gap.

---

## 4. Surface Area

### 4.1 IPC action: `knowledge_publish` (extended)

Wire type: `knowledge_publish` — unchanged.
Response kind: `notify` — unchanged (fire-and-forget is correct for a write action).
Handler: `src/ipc/handlers/knowledge-publish.ts` — `knowledgePublishHandler`.
Trust: through `gateAndStage` for agent callers — unchanged. Default autonomous for agents with `knowledge_publish: autonomous` in trust.yaml.

Changes from current:

```typescript
// parse() — add confidence extraction
confidence: (
  typeof r.confidence === 'number' &&
  Number.isInteger(r.confidence) &&
  r.confidence >= 1 &&
  r.confidence <= 10
)
  ? r.confidence
  : 5,
```

**Round-1 amendment — `confidence` must be added in TWO type sites, not one.** The handler at `src/ipc/handlers/knowledge-publish.ts:7-12` declares its own local `Input` interface (literally named `Input`, not exported, not `KnowledgePublishInput` as earlier spec text implied). This is structurally distinct from `KnowledgeEntry` at `src/knowledge.ts:6-13`. Commit 1 must update BOTH:

1. `src/knowledge.ts` `KnowledgeEntry` interface — add `confidence?: number` (used by `publishKnowledge()` and any future programmatic callers).
2. `src/ipc/handlers/knowledge-publish.ts` local `Input` interface (lines 7-12) — add `confidence: number` (the value flows from `parse()` to `publishKnowledge()` via the input passed to `execute()`).

Without (2), TypeScript will error at the `publishKnowledge(input, ...)` call site once `KnowledgeEntry` requires `confidence` to propagate through. The local `Input` interface gains `confidence: number` (non-optional — `parse()` always sets a default of 5, so the field is always present at handler runtime).

No change to wire type, response kind, trust behavior, `auditSummary` (`= input.topic`), `target` (`= AUDIT_TARGET = 'agent-knowledge'`), or bus publish.

### 4.2 IPC action: `knowledge_search` (new)

Wire type: `knowledge_search`
Response kind: `result`
Handler: `src/ipc/handlers/knowledge-search.ts` — new file
Results dir name: `knowledge_results` (set via `resultsDirName: 'knowledge_results'` — the dispatcher default would produce `knowledge_search_results` which is wordier and inconsistent with the `kg_results`, `task_results` pattern)
Trust: `skipGate: true` for non-agent callers. Agent callers go through the gate. Add `'knowledge_search'` to `SKIP_GATE_ALLOWLIST` at `src/ipc/handler.ts:21-43`.

TypeScript interface:

```typescript
interface SearchInput {
  query: string;           // non-empty, trimmed; parse returns null if empty
  max_results: number;     // [1, 20], clamped; default 5
}
```

`authorize()` shape:

```typescript
authorize(input, ctx): IpcAuthorization {
  return {
    target: 'agent-knowledge',
    auditSummary: input.query.slice(0, 100),
    notifySummary: `searched knowledge: ${input.query.slice(0, 80)}`,
    payloadForStaging: {
      type: 'knowledge_search',
      query: input.query,
    },
    ...(ctx.agentName === null ? { skipGate: true as const } : {}),
  };
}
```

`execute()` — QMD HTTP call pattern (JSON-RPC body mirrors `src/ipc.ts:1456-1478`):

**Critical fix (round-1 amendment):** `fetch` does NOT throw on non-2xx. The `skill_search` reference at `src/ipc.ts:1457-1480` skips `response.ok` and only survives because empty 503 bodies fail JSON parse and hit its catch. QMD can return 503 with a valid JSON error body — without the `response.ok` guard below, `knowledge_search` would parse it successfully, find no `content[0].text`, and return `{ success: true, results: '' }` — a silent false-success the caller would interpret as "no results found." The `if (!response.ok) throw new Error(...)` line below is the load-bearing fix that distinguishes this handler from `skill_search`'s pattern.

```typescript
async execute(input, ctx): Promise<ExecuteResult> {
  try {
    const response = await fetch('http://localhost:8181/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getBridgeToken()}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query',
          arguments: {
            searches: [
              { type: 'vec', query: input.query },
              { type: 'lex', query: input.query },
            ],
            collections: ['agent-knowledge'],
            intent: input.query,
            limit: input.max_results,
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Bridge returned ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const rawText = json.result?.content?.[0]?.text ?? '';
    logger.info(
      { sourceGroup: ctx.sourceGroup, query: input.query, requestId: ctx.requestId },
      'knowledge_search QMD call complete',
    );
    return { executed: true, result: { success: true, results: rawText, query: input.query } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, sourceGroup: ctx.sourceGroup, query: input.query },
      'knowledge_search QMD fetch failed');
    return { executed: true, result: { success: false, message } };
  }
}
```

**Design decisions:**

- `parse` returns `null` on empty query. The dispatcher writes a `dropped_invalid_input` audit row (Batch 4 contract at `src/ipc/handler.ts:298-312`). An agent calling `knowledge_search` with no query has a construction bug; failing fast with forensic trail is correct.
- `max_results` clamped to [1, 20]. Upper bound of 20 prevents context-window flooding.
- Both `vec` and `lex` sub-queries sent. Rationale in Section 3.3.
- 15-second timeout. QMD can be slow on cold start or under reranking load; 15s is more generous than `skill_search` (10s) and justified by the value of cross-group findings.
- Result payload: `{ success: true, results: rawText, query }` where `rawText` is the QMD JSON blob verbatim. Same pattern as `kg_query`; agents already handle QMD result JSON from `mcp__qmd__query` calls.
- No `qmdReachable` guard in the handler. The reachability flag at `src/container-runner.ts:49-55` gates QMD URL injection into containers; it does not affect host-side direct HTTP calls. The handler attempts the fetch regardless. If QMD is down, the fetch throws and the handler returns `{ success: false, message }` gracefully.

### 4.3 Audit row contract

`knowledge_publish` (unchanged): `agent_actions` row with `action_type='knowledge_publish'`, `target='agent-knowledge'`, `summary=topic`. Written by `gateAndStage` for agent callers.

`knowledge_search` (new): `agent_actions` row with `action_type='knowledge_search'`, `target='agent-knowledge'`, `summary=query.slice(0, 100)`. Written by `gateAndStage` for agent callers. Non-agent callers with `skipGate` produce no audit row (existing dispatcher convention at `src/ipc/handler.ts:563-565`).

Batch 4 dispatcher-observability contract: malformed or missing `requestId` for `knowledge_search` produces a synthetic `agent_actions` row with `outcome='dropped_invalid_requestId'` (enforced by the dispatcher at `src/ipc/handler.ts:278-289`). Empty `query` triggers `dropped_invalid_input` row (dispatcher at lines 298-312).

### 4.4 MCP tool: `knowledge_publish` (extended)

File: `container/agent-runner/src/ipc-mcp-stdio.ts:1815-1848`

Changes: add `confidence` Zod parameter, update IPC payload to include `confidence`, update description to reflect the 30-second BM25 availability.

New Zod schema addition:

```typescript
confidence: z.number().int().min(1).max(10).optional()
  .describe('Self-assessed confidence 1-10. 1-3=weak/preliminary; 4-6=moderate; 7-9=high/evidenced; 10=definitive. Default 5.'),
```

New description (following tool-design.md what/when/inputs/returns rubric):

```
Publish a structured finding to the shared cross-group knowledge base so any agent in any group can retrieve it via knowledge_search.

Use when: you discover a durable, reusable fact — a regulation change, an experimental result, a workflow decision, a scientific finding — that future agent sessions (yours or another agent's) should retrieve by semantic search.

Do not use for:
- Time-sensitive coordination that needs immediate action (use bus_publish or publish_to_bus instead).
- Personal notes or standing instructions for yourself alone (use write_agent_memory instead).
- Volatile state (timestamps, session IDs, in-progress results) — use write_agent_state instead.
- Sensitive topics that should not be visible to all agents (health, personnel, confidential research) — use write_agent_state (group-scoped) or write_agent_memory (agent-scoped) instead.

Inputs:
- topic: short label (max 120 chars). Example: "APA regulation", "lab scheduling", "chromatin accessibility".
- finding: the fact itself. Write as a specific, actionable statement. Include implications. Example: "ChromBERT predicts TF binding at APA sites with 0.87 AUC on SFARI snATAC-seq; strengthens Aim 2 of R01-MH137578."
- evidence: source. Preferred: DOI or URL. Acceptable: file path or conversation reference. Do not leave blank.
- tags: array for retrieval. Include gene names, project IDs, method names. Example: ["GWAS", "APA", "R01-MH137578"].
- confidence: integer 1-10. Your self-assessed confidence. 1-3=weak; 4-6=moderate; 7-9=high; 10=definitive. Default 5.

Returns: "Published knowledge: <topic>". BM25 search available within ~30 seconds. Semantic search may lag up to 4 hours (next embed cycle). Retrieve via knowledge_search.
```

Updated IPC payload:

```typescript
writeIpcFile(TASKS_DIR, {
  type: 'knowledge_publish',
  topic: args.topic,
  finding: args.finding,
  evidence: args.evidence,
  tags: args.tags,
  confidence: args.confidence ?? 5,
  from: groupFolder,
  timestamp: new Date().toISOString(),
});
```

### 4.5 MCP tool: `knowledge_search` (rewritten)

File: `container/agent-runner/src/ipc-mcp-stdio.ts:1851-1878` — replace stub entirely.

Add to the results dir constants block at lines 732-736:

```typescript
const KNOWLEDGE_RESULTS_DIR = path.join(IPC_DIR, 'knowledge_results');
```

New tool description:

```
Search the shared cross-group knowledge base for findings published by any agent in any group.

Use when: you need to know what any agent has previously discovered about a topic. Returns structured findings with their source, confidence rating, publishing agent, and date.

Do not use for:
- Searching the general document vault (use mcp__qmd__query with collection "vault").
- Searching your own agent memory (read /workspace/agents/{you}/memory.md directly).
- Real-time coordination with another agent (use bus_publish or publish_to_bus).
- Searching emails, calendar, or notes (use Gmail MCP, calendar tools, or Apple Notes MCP).

Inputs:
- query: natural language description of what you want to know. Example: "chromatin accessibility APA TF binding", "lab scheduling conflicts summer 2026", "R01-MH137578 Aim 2 progress".
- max_results: results to return (default 5, max 20). Increase for exploratory searches.

Returns: JSON from QMD with matching findings including topic, body, evidence, confidence, agent provenance, and date. Returns { success: false, message } if QMD is unreachable. 15-second timeout.
```

New tool implementation (replaces the stub at lines 1851-1878):

```typescript
server.tool(
  'knowledge_search',
  `<description above>`,
  {
    query: z.string().describe('Natural language query — what do you want to know?'),
    max_results: z.number().int().min(1).max(20).optional()
      .describe('Results to return (default 5, max 20)'),
  },
  async (args) => {
    const requestId = `ks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'knowledge_search',
      query: args.query,
      max_results: args.max_results ?? 5,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForIpcResult(KNOWLEDGE_RESULTS_DIR, requestId, 15_000);
    if (!(result as { success?: boolean }).success) {
      const msg = (result as { message?: string }).message ?? 'QMD unavailable or no results.';
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
    const resultsText = (result as { results?: string }).results ?? '[]';
    return { content: [{ type: 'text' as const, text: resultsText }] };
  },
);
```

**`requestId` prefix**: `ks-` (for "knowledge search"). Keeps it distinct from `skill-` (`skill_search`), `kg-` (`kg_query` if it used a prefix), etc.

---

## 5. Trust and Security

### 5.1 Can any agent publish?

Yes by default, subject to trust.yaml. Agents with `knowledge_publish: autonomous` publish immediately. Agents without an explicit entry fall through to the gate default (`ask`), which stages the publish for user approval. The trust enforcement tests at `src/ipc.test.ts:1982-2070` (the C13 block) pin this behavior and are not changed.

**Poison prevention is already implemented.** `publishKnowledge()` at `src/knowledge.ts:39` always writes `agent: sourceGroup` to frontmatter, derived from `ctx.sourceGroup` (the IPC filesystem path, not the payload). An agent cannot fake its identity. Tests at `src/knowledge.test.ts:38-52` and `src/knowledge.test.ts:74-110` cover YAML injection and agent-field spoofing.

### 5.2 Can any agent search?

Yes. `knowledge_search` is on `SKIP_GATE_ALLOWLIST` (read-only, same as `kg_query`, `dashboard_query`, `slack_dm_read`). All agents can search freely without a trust.yaml entry. Non-agent callers also bypass the gate.

### 5.3 Group privacy

None. All published findings are visible to all agents that have QMD access. `QMD_URL` is injected into all containers when QMD is reachable (`src/container-runner.ts:510-513`). This is by design — cross-group visibility is the entire value proposition.

Agents should NOT publish sensitive findings (health data, personnel discussions, confidential research). The `knowledge_publish` MCP description explicitly calls this out in its "Do not use for" section. No allowlist mechanism is needed because the action is symmetric: publish = visible to all, and the authorship provenance (`agent` frontmatter field) is verified and tamper-proof.

### 5.4 No `allowedSecrets` opt-in needed

`knowledge_search` reads from QMD over localhost HTTP. `knowledge_publish` writes to a shared directory. Neither action accesses `.env` secrets, OAuth tokens, or sensitive infrastructure. The `allowedSecrets` mechanism (from `feature_non_main_allowed_secrets.md`) covers `.env` token injection into containers — not applicable here.

### 5.5 YAML injection (existing hardening, no change)

`publishKnowledge()` uses `YAML.stringify()` from the `yaml` library for all frontmatter fields. Injection tests at `src/knowledge.test.ts:74-110` verify that topic values containing `---`, newlines, and agent-name patterns cannot break out of the frontmatter block. The `confidence` field (an integer) cannot contain YAML metacharacters by type.

---

## 6. Conflict and Contradiction Handling

**Decision: both are kept; `knowledge_search` returns all matches ranked by QMD relevance; the consuming agent applies judgment.**

If SCIENCE-claw publishes "ChromBERT works on APA data" (confidence 8) and CODE-claw later publishes "ChromBERT failed on SFARI dataset" (confidence 6), both findings exist as separate files. `knowledge_search` returns both, each with its `agent`, `date`, `confidence`, and `evidence` fields. The agent reading the results sees the contradiction and can reason about which finding is more applicable to the current context.

Rationale: contradiction resolution requires domain knowledge the platform does not have. The agent reading the results is better positioned to weigh competing evidence. QMD's hybrid scoring will surface both findings for a relevant query. The consumer has enough signal (`confidence`, `date`, `agent`) to apply appropriate skepticism.

**Not implemented in Phase 1.2:**
- `knowledge_supersede(id, replacement)` action — would require unique-ID scheme in frontmatter and QMD lookup. Deferred.
- Confidence-weighted QMD ranking — not pluggable in current QMD without custom reranking. Not pursued.
- Automatic contradiction detection at publish time — computationally expensive, prone to false positives. Not pursued.

**Guidance for agents publishing a correction:** Include in the `finding` body: "Corrects prior finding: [topic] published by [agent] on [date]." This creates a human-readable supersession trail without platform-level conflict resolution. The prior finding remains in the index; QMD's LLM reranking (when active) may surface the correction higher for queries about the corrected topic.

---

## 7. Interaction with Hindsight and Honcho

The three memory layers serve distinct purposes:

| Layer | Scope | Author | Durability | Access pattern | Signal level |
|---|---|---|---|---|---|
| `agent-knowledge` | Cross-group, all agents | Agent-programmatic | Permanent (until deleted) | `knowledge_search` — any agent | High: curated findings with evidence |
| Hindsight | Cross-session, per agent-user pair | Conversation-derived | Permanent, bank-based | `mcp__hindsight__recall` — same agent | Medium: conversational context |
| Honcho | Per user-agent pair | Conversation-derived | Permanent | Auto-injected `<memory-context>` | Medium: user modeling |

**Decision tree: when to use which layer**

Use `knowledge_publish` when ALL of:
- The fact is useful to **other agents**, not just to you
- The fact has **explicit evidence** (URL, DOI, measured result)
- The fact is **durable** — relevant in weeks or months
- The fact is **not sensitive** — safe to be visible to all agents

Use `hindsight.retain` when:
- The fact is **personal to your agent** — a decision you made, a preference you learned, an action you took
- The fact is **conversational context** — what happened in this session, what the user said
- You are capturing **session continuity** for your own future sessions in any group

Use `write_agent_memory` when:
- The fact is **agent-scoped but not conversational** — standing instructions, agent-level decisions, cross-group state that should travel with your identity

Use `write_agent_state` when:
- The fact is **group-scoped working state** — in-progress tasks, open questions specific to this group only

The `docs/memory-writeback-sop.md` (referenced in global `CLAUDE.md`) is the authoritative decision tree. This spec adds `agent-knowledge` as a leaf: if the fact is "useful to other agents + has evidence + is durable + not sensitive" → call `knowledge_publish`.

**Redundancy analysis:** Honcho is a user-modeling layer. It ingests conversation messages and derives user preferences — it does not store structured findings. There is no redundancy between Honcho and `agent-knowledge`. An agent might know from Honcho that "the user prefers concise summaries" (Honcho) while also knowing from `agent-knowledge` that "ChromBERT achieves 0.87 AUC on SFARI data" (knowledge-level). These are different information types at different abstraction levels.

**The bus sibling:** `knowledgePublishHandler.execute()` already fires a bus message after writing the file (`src/ipc/handlers/knowledge-publish.ts:58-66`). The bus message provides real-time notification to currently-running agents. `agent-knowledge` provides durable retrieval for future sessions. No change to this behavior.

---

## 8. Test Plan

Tests split into four locations.

### A. `knowledge_publish` handler extension tests

**File:** `src/ipc/handlers/knowledge-publish.test.ts` (new file)

1. `parse` extracts `confidence: 7` from raw payload.
2. `parse` defaults `confidence` to `5` when field is missing.
3. `parse` normalizes `confidence: 0` → `5` (out-of-range → default).
4. `parse` normalizes `confidence: 11` → `5` (out-of-range → default).
5. `parse` normalizes `confidence: 7.5` → `5` (non-integer → default). Confirms `Number.isInteger()` check.
6. `execute` fires `execFile` with `[QMD_BIN, ['update', 'agent-knowledge']]` after `publishKnowledge` completes. Spy on `execFile`; assert it was called; assert `publishKnowledge` was called before.
7. `execute` QMD update failure is non-fatal. Stub `execFile` to invoke callback with `new Error('ENOENT')`. Assert: `publishKnowledge` was called, no exception propagated, `logger.warn` called once with the error.

Fixture discipline: mock `publishKnowledge` via `vi.mock('../../knowledge.js')` (same pattern as `src/ipc.test.ts:1930-1932`). Mock `execFile` via `vi.mock('child_process')`. Each test uses `_initTestDatabase()` + unique agent dir + try/finally cleanup.

### B. `knowledge_search` handler tests

**File:** `src/ipc/handlers/knowledge-search.test.ts` (new file)

Unit-level (5):

1. `parse` returns null for non-object input.
2. `parse` returns null for missing `query` field.
3. `parse` returns null for empty-string `query` (after trim).
4. `parse` clamps `max_results`: `{ query: 'x', max_results: 0 }` → `max_results: 1`; `{ max_results: 50 }` → `max_results: 20`; `{ max_results: 5 }` → `max_results: 5`.
5. `authorize` returns `{ target: 'agent-knowledge', ..., skipGate: true }` for non-agent caller, and omits `skipGate` for agent caller. Mirrors `kgQueryHandler` pattern at `src/ipc/handlers/kg-query.ts:54-70`.

Execute-level (4):

6. Happy path: mock `fetch` returns `{ result: { content: [{ text: '["finding1"]' }] } }` with status 200. Assert `execute` returns `{ executed: true, result: { success: true, results: '["finding1"]', query: 'test' } }`.
7. QMD 503: mock `fetch` returns `{ ok: false, status: 503, json: async () => ({}) }`. Assert `{ success: false, message: ... }` (exact message depends on how the 503 is surfaced — `fetch` does not throw on non-2xx; the handler must check `response.ok` OR rely on json parse failing for the empty body. Plan-time decision: check `response.ok` explicitly and surface `Bridge returned 503` message).
8. Fetch throws ECONNREFUSED: mock `fetch` with `mockRejectedValueOnce(new Error('ECONNREFUSED'))`. Assert `{ success: false, message: 'ECONNREFUSED' }`, no exception propagated.
9. QMD response missing `content` field: mock `fetch` returns `{ ok: true, result: {} }`. Assert `{ success: true, results: '', query: 'test' }`.

Integration (6):

10. End-to-end success writes result file to `knowledge_results/{requestId}.json`. Assert the dir name is exactly `knowledge_results`, not `knowledge_search_results`. Pin the `resultsDirName` constant.
11. Dispatcher drops malformed requestId for agent caller, writes `dropped_invalid_requestId` audit row. Mirrors Batch 4 contract (tests 16b/17b pattern from Batch 2F.1).
12. Dispatcher drops missing requestId for agent caller, writes audit row.
13. Dispatcher drops empty query (parse returns null) for agent caller, writes `dropped_invalid_input` audit row.
14. Agent with `knowledge_search: notify` trust level: audit row written, search executes. Assert `agent_actions` row with `action_type='knowledge_search'`, `outcome='allowed'`. Per SKIP_GATE_ALLOWLIST: skipGate is only requested for non-agent callers (`ctx.agentName === null`), so agent callers with a `notify`-level trust.yaml entry still go through the gate and get the audit row.
15. `qmdReachable = false` on the host does not prevent the handler from attempting the QMD fetch. Set `setQmdReachable(false)`, dispatch `knowledge_search`, verify fetch was attempted (stub fetch to return a 200 with empty results). Confirms the handler bypasses the reachability flag (the flag only gates container-env injection, not host-side HTTP calls).

### C. `src/knowledge.ts` unit tests (extend existing file)

**File:** `src/knowledge.test.ts` — add to existing `describe('publishKnowledge')` block.

16. `publishKnowledge` writes `confidence: 8` to YAML frontmatter when `entry.confidence === 8`. Parse the written file's frontmatter; assert `confidence` key present with value `8`.
17. `publishKnowledge` writes `confidence: 5` to YAML frontmatter when `entry.confidence` is undefined.

Design decision for the default: `KnowledgeEntry.confidence` is optional, and `publishKnowledge` writes `confidence: entry.confidence ?? 5` to frontmatter unconditionally. This way both the handler and any future callers of `publishKnowledge` get a consistent frontmatter.

### D. QMD round-trip integration test

**File:** `src/knowledge-search.integration.test.ts` (new, skipped in CI unless QMD is up)

```typescript
it.skipIf(!await isQmdReachableCheck())('round-trip: publish → update → search finds finding', async () => {
  const testTopic = `integration-test-${Date.now()}`;
  const filePath = publishKnowledge(
    { topic: testTopic, finding: 'X = 42 (integration test)', evidence: 'manual', confidence: 9, tags: ['integration-test'] },
    'test-group',
    path.join(DATA_DIR, 'agent-knowledge'),
  );
  await new Promise((resolve, reject) => execFile(QMD_BIN, ['update', 'agent-knowledge'], {}, (err) => err ? reject(err) : resolve(null)));
  const ctx = buildContext('test-group', false, mockDeps);
  const result = await knowledgeSearchHandler.execute({ query: testTopic, max_results: 5 }, ctx);
  const payload = (result as any).result;
  expect(payload.success).toBe(true);
  expect(payload.results).toContain(testTopic);
  fs.unlinkSync(filePath);
});
```

This is the acceptance gate for the "BM25 finds the finding within 30s" claim. Must be run manually before marking Phase 1.2 complete.

### E. Multi-agent cross-publish test (manual)

No automated coverage — requires two live containers (SCIENCE-claw and CLAIRE). Acceptance criterion:

1. SCIENCE-claw session calls `knowledge_publish({ topic: 'test-cross-agent', finding: 'X = 42', evidence: 'manual test', confidence: 9, tags: ['test'] })`
2. Verify finding appears in `data/agent-knowledge/`
3. Wait 30 seconds for QMD background update
4. CLAIRE session calls `knowledge_search({ query: 'test-cross-agent X = 42' })`
5. Assert: CLAIRE's search result contains the finding published by SCIENCE-claw

---

## 9. Open Questions

**Q1: Do findings expire automatically?**

Currently permanent. A finding about "which model is fastest" published in April 2026 could mislead agents in April 2027. Options: add `ttl_days` field (cleanup cron deletes expired files); add `staleness_after_days` (warning signal, not deletion); do nothing.

Recommendation: do nothing in Phase 1.2. Revisit when Phase 1.3's Pattern Engine can observe stale-finding usage patterns.

**Q2: Should `knowledge_publish` default to `notify` trust level instead of `autonomous`?**

Autonomous means agents publish freely with no user notification. Notify would fire a Telegram message on every publish. The tradeoff: autonomous = low friction but risk of low-quality flooding; notify = user awareness but potentially very noisy (a SCIENCE-claw session analyzing 50 papers could fire 50 notifications).

Recommendation: keep autonomous default. Quality signal can be added via Phase 1.3's outcome tracking if needed.

**Q3: What is the `qmd` binary path?**

The spec uses `/opt/homebrew/bin/qmd` as example. Must be verified at plan time with `which qmd` in an interactive shell. If the path differs, update the constant in `knowledge-publish.ts` and the integration test. This is a hard dependency — the absolute path cannot be assumed.

**Q4: Should the `knowledge_search` result payload be structured (parsed) or raw (QMD JSON string)?**

Currently designed to return `rawText` verbatim (the QMD JSON blob), same as `kg_query`. The agent must parse the QMD format. An alternative: parse each finding in the handler and return `SearchResult[]` with typed fields (`topic`, `finding`, `confidence`, `agent`, `date`). This would give agents cleaner data at the cost of handler-QMD coupling.

Recommendation: return raw text in Phase 1.2. Agents already handle QMD result JSON from direct `mcp__qmd__query` calls. Structured extraction can be a Phase 1.2 polish commit if agent behavior shows they struggle with the raw format.

**Q5: Should `knowledge_search` support `min_confidence` or `from_agent` filters?**

The current stub at `ipc-mcp-stdio.ts:1860-1865` exposed `from_agent` and `topic` filter parameters (redirect-only, never used). The new design does not carry these over because:
- QMD lex search can include frontmatter filters like `agent:telegram_science-claw` natively in the query string.
- Adding explicit filter params complicates the tool interface without evidence agents need them.
- The tool description can guide agents to include filter terms in the `query` string.

Recommendation: drop the filter params. If agents demonstrate they want structured filtering, add in a follow-up.

---

## 10. Commit Sequence

**Commit 1:** `feat(knowledge): add confidence field to KnowledgeEntry and QMD update on publish`

- `src/knowledge.ts` — add `confidence?: number` to `KnowledgeEntry`; add `confidence: entry.confidence ?? 5` to `YAML.stringify` call
- `src/ipc/handlers/knowledge-publish.ts` — (a) add `confidence: number` to the local `Input` interface at lines 7-12 (this is structurally distinct from `KnowledgeEntry` and must be updated separately — see §4.1 round-1 amendment); (b) add `confidence` extraction in `parse()`; (c) add `execFile` QMD update call in `execute()` after `publishKnowledge()` and before bus publish
- `container/agent-runner/src/ipc-mcp-stdio.ts:1815-1848` — add `confidence` Zod param; add `confidence: args.confidence ?? 5` to IPC payload write; update tool description
- `src/knowledge.test.ts` — add tests 16-17 (Section C)
- `src/ipc/handlers/knowledge-publish.test.ts` — new file, tests 1-7 (Section A)

**Commit 2:** `feat(knowledge): real knowledge_search IPC handler (replaces redirect stub)`

- `src/ipc/handler.ts:21-43` — add `'knowledge_search'` to `SKIP_GATE_ALLOWLIST`
- `src/ipc/handlers/knowledge-search.ts` — new file with `knowledgeSearchHandler`
- `src/ipc/handlers/index.ts` — `registerIpcHandler(knowledgeSearchHandler)` after `knowledgePublishHandler` (current line ~43)
- `src/ipc/handlers/knowledge-search.test.ts` — new file, tests 1-15 (Section B)
- `container/agent-runner/src/ipc-mcp-stdio.ts:732-736` — add `KNOWLEDGE_RESULTS_DIR` constant
- `container/agent-runner/src/ipc-mcp-stdio.ts:1851-1878` — replace stub with real `waitForIpcResult` round-trip; update tool description and Zod schema

**Commit 3:** `docs(knowledge): update memory-writeback SOP with agent-knowledge decision leaf` *(only if `docs/memory-writeback-sop.md` exists and needs updating)*

---

## 11. Acceptance Criteria

1. `bun run test` passes. Baseline ~2330 tests + Section A (7) + Section B (15) + Section C (2) = ~2354. Exact count subject to fixture cleanup tests.
2. `bun run typecheck` passes.
3. `grep -n "confidence" src/knowledge.ts` returns hits in both the `KnowledgeEntry` interface and the `YAML.stringify` call.
4. `grep -n "knowledge_search" src/ipc/handler.ts` returns a hit inside the `SKIP_GATE_ALLOWLIST` Set literal.
5. `grep -n "KNOWLEDGE_RESULTS_DIR" container/agent-runner/src/ipc-mcp-stdio.ts` returns a hit in the constants block.
6. `grep -n "waitForIpcResult" container/agent-runner/src/ipc-mcp-stdio.ts | grep -i knowledge` returns a hit. Confirms stub is replaced.
7. `grep -n "To search shared knowledge" container/agent-runner/src/ipc-mcp-stdio.ts` returns zero matches. Confirms redirect text is removed.
8. `grep -n "knowledge_search" src/ipc/handlers/index.ts` returns a `registerIpcHandler` hit.
9. Manual integration test (Section D) passes with live QMD: publish → wait 30s → search → finding returned.
10. Multi-agent acceptance test (Section E, manual): SCIENCE-claw publishes, CLAIRE finds it within 60 seconds.
11. `qmd` binary absolute path verified: `which qmd` output matches the hardcoded `QMD_BIN` constant in `knowledge-publish.ts`.

---

## Source References

| File | Lines | Purpose |
|---|---|---|
| `src/ipc/handlers/knowledge-publish.ts` | 7-12 | Local `Input` interface (NOT same as `KnowledgeEntry`) — Commit 1 must add `confidence: number` here too |
| `src/ipc/handlers/knowledge-publish.ts` | 1-68 | Existing handler — all changes in Commit 1 |
| `src/knowledge.ts` | 6-13 | `KnowledgeEntry` interface — add `confidence` |
| `src/knowledge.ts` | 39-44 | `publishKnowledge()` YAML.stringify — add `confidence` |
| `src/ipc/handler.ts` | 21-43 | `SKIP_GATE_ALLOWLIST` — add `knowledge_search` |
| `src/ipc.ts` | 1444-1533 (function); 1456-1478 (JSON-RPC body) | `handleSkillSearchIpc` — JSON-RPC template for `execute()`; note it lacks `response.ok` check (see §4.2 critical fix) |
| `src/ipc/handlers/index.ts` | 43 (approx) | Handler registration — add `knowledgeSearchHandler` |
| `src/ipc/handlers/kg-query.ts` | 54-70 | `authorize()` skipGate pattern for read-only handlers |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | 732-736 | Results dir constants block — add `KNOWLEDGE_RESULTS_DIR` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | 738-760 | `waitForIpcResult` helper |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | 1815-1848 | `knowledge_publish` MCP tool — extend |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | 1851-1878 | `knowledge_search` stub — replace |
| `src/knowledge.test.ts` | 1-111 | Existing tests — extend with tests 16-17 |
| `src/ipc.test.ts` | 1982-2070 | C13 trust tests — unchanged, must still pass |
| `src/bridge-auth.ts` | — | `getBridgeToken()` import for host-side HTTP calls |
| `src/container-runner.ts` | 49-55, 510-513 | `qmdReachable` flag — note it does not gate host-side calls |
| `docs/superpowers/specs/2026-04-13-smarter-claw-roadmap-design.md` | 119-152 | Original Phase 1.2 design decisions |
| Memory feedback: `qmd-update-cmd-needs-absolute-interpreter` | MEMORY.md | Absolute path requirement for `qmd` binary in launchd context |
| Memory feedback: `ipc-audit-row-coverage-gap` | MEMORY.md | Batch 4 audit row contract for dropped result-kind calls |
