# Knowledge Graph — Layer 5 Design

**Date:** 2026-04-14
**Status:** Draft v1
**Scope:** Persistent entity-relationship graph for NanoClaw (VISION4.md Layer 5)
**Approach:** SQLite graph with entity resolution quality gate

## Problem Statement

NanoClaw agents search documents (via QMD) but can't traverse relationships. When an agent asks "what's connected to this grant?", it gets documents that mention the grant — not a structured map of the people, papers, datasets, methods, and projects linked to it. Non-obvious connections (a new preprint using a method relevant to your R01, authored by someone you met at ASHG) are invisible unless an agent happens to retrieve both documents in the same session.

The vault already contains typed relationships in YAML frontmatter (`key_papers`, `related_tools`, `relevant_projects`, `related_datasets`, `disorders`, `authors`). 416 contact files have structured person data. These edges exist but are locked inside individual files — no index materializes them into queryable form.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | SQLite (`store/knowledge-graph.db`) | Already in stack, zero new infra, sufficient at ~5K entity scale |
| Entity resolution | Quality-first: deterministic seed → Ollama bulk → Claude targeted → validation gate | Serendipity engine with wrong connections erodes trust; 416 contacts provide ground-truth test set |
| Agent access | Query + write (IPC-backed MCP tools) | Agents contribute discovered relationships in real-time |
| Primary use case | "Connect the dots" — surface non-obvious cross-type relationships | Eventually all traversal patterns, but serendipity first |
| Incremental ingestion | Ollama (zero cost) with confidence-gated Claude fallback | Matches VISION4.md two-tier intelligence pattern |

## Schema

### Database: `store/knowledge-graph.db`

```sql
-- Canonical entities
CREATE TABLE entities (
  id              TEXT PRIMARY KEY,           -- uuid
  canonical_name  TEXT NOT NULL,
  type            TEXT NOT NULL,              -- person|paper|dataset|tool|grant|project|method|institution|disorder
  metadata        TEXT,                       -- JSON blob (doi, pmid, url, institution, role, etc.)
  source_doc      TEXT,                       -- vault path that created this entity
  confidence      REAL NOT NULL DEFAULT 1.0,  -- 0-1
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Name variants, scoped by entity type to prevent cross-type collisions
CREATE TABLE aliases (
  alias           TEXT NOT NULL,
  entity_type     TEXT NOT NULL,              -- must match entities.type
  entity_id       TEXT NOT NULL REFERENCES entities(id),
  source          TEXT,                       -- vault|email|pubmed|agent:{group}
  PRIMARY KEY (alias, entity_type, entity_id)
);

-- Typed relationships
CREATE TABLE edges (
  id              TEXT PRIMARY KEY,           -- uuid
  source_id       TEXT NOT NULL REFERENCES entities(id),
  target_id       TEXT NOT NULL REFERENCES entities(id),
  relation        TEXT NOT NULL,
  evidence        TEXT,                       -- short text: why this edge exists
  source_doc      TEXT,                       -- vault path or agent session
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_by      TEXT NOT NULL,              -- bulk_ingest|ollama|claude|agent:{group}|user
  created_at      TEXT NOT NULL
);

-- Entity resolution review queue
CREATE TABLE review_queue (
  id              TEXT PRIMARY KEY,
  candidate_a     TEXT NOT NULL,              -- potential entity name
  candidate_b     TEXT,                       -- existing entity it might match
  entity_type     TEXT,
  context         TEXT,                       -- surrounding text
  resolution      TEXT,                       -- NULL=pending, merge|distinct|skip
  resolved_by     TEXT,                       -- claude|ollama|user
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);

-- Indexes
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_aliases_lookup ON aliases(alias, entity_type);
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
CREATE INDEX idx_edges_relation ON edges(relation);
CREATE INDEX idx_review_pending ON review_queue(resolution) WHERE resolution IS NULL;
```

### Relation Types

Person edges: `authored`, `collaborates_with`, `advises`, `member_of`, `affiliated_with`
Paper edges: `cites`, `uses_method`, `uses_dataset`, `relevant_to_grant`, `relevant_to_project`
Grant edges: `funds_project`, `funds_person`, `related_to_disorder`
Tool edges: `implements_method`, `tested_on_dataset`, `used_by_project`
General: `related_to`, `mentioned_in`

## Entity Resolution Pipeline

Quality-first approach. The graph does NOT go live until validation passes.

### Phase 1: Deterministic Seed (no LLM, ~480 entities)

Parse structured sources with zero ambiguity:

| Source | Entity Type | Count | Fields |
|--------|------------|-------|--------|
| `20-contacts/*.md` | person | 416 | YAML: name, email, institution, role, projects[] |
| `groups/global/state/grants.md` | grant | ~10 | Grant IDs (R01-MH137578, etc.) |
| `groups/global/state/lab-roster.md` | person | ~15 | Cross-ref with contacts |
| `groups/global/state/projects.md` | project | ~10 | Project names and descriptions |
| `99-wiki/tools/*.md` | tool | 21 | YAML: name, key_papers, related_tools |
| `99-wiki/datasets/*.md` | dataset | 4 | YAML: data_types, key_papers, related_datasets |
| `99-wiki/papers/*.md` | paper | 2 | YAML: first_author, year, doi |

**Alias auto-generation for person entities:**
Given "Michael J. Gandal" with email "mgandal@email.com":
- "Michael J. Gandal", "Gandal, Michael", "Gandal, M.", "Gandal MJ", "Michael Gandal", "mgandal"

**Edge extraction from frontmatter cross-refs:**
YAML fields like `key_papers: ["wiki/papers/kim-2023-..."]` and `related_tools: ["cell2fate"]` become edges directly. No LLM needed.

### Phase 2: Ollama Bulk Extraction (~1,900 docs, ~30-60 min)

Run phi4-mini over all vault documents with structured JSON output:

```json
{
  "entities": [
    {"name": "Rachel Smith", "type": "person", "aliases": ["R. Smith"], "context": "BrainGO collaborator"}
  ],
  "edges": [
    {"source": "Rachel Smith", "target": "BrainGO", "relation": "collaborates_with", "evidence": "co-PI on aim 2"}
  ],
  "resolution_candidates": [
    {"new_name": "R. Smith", "existing_match": "Rachel Smith", "confidence": 0.95, "reason": "same document, BrainGO context"}
  ]
}
```

Each document receives the current entity list (chunked) for resolution context.

- **High confidence** (alias exact match or Ollama confidence > 0.9): auto-add to graph
- **Low confidence**: tagged for Claude pass in Phase 3

### Phase 3: Claude Targeted Pass (~200-300 docs, ~$3-5)

Claude (Sonnet) processes only:
- Documents with 3+ unresolved entities from Phase 2
- Meeting notes and project docs (high relationship density)
- Any doc where Ollama flagged entity type ambiguity (e.g., "SFARI" as funder vs dataset)

Claude gets the document + nearby entity context + specific resolution questions. Output feeds directly into graph.

### Phase 4: Validation Gate

The graph stays offline until this report passes:

```
Validation Report:
- Entity counts by type
- Edge counts by relation type  
- Contact fragmentation: 416 contacts → X person entities (target: ±5%)
- Resolution queue: X items pending (target: <50)
- Sample audit: 50 random edges scored for correctness (target: >90% accurate)
```

**PASS threshold:** >90% edge accuracy on sample AND <5% contact fragmentation.
**FAIL action:** Work review queue (Claude batch or manual), re-run validation.

## Agent Interface

Two IPC-backed MCP tools, available to all agents:

### `kg_query` — Read from the graph

```typescript
kg_query({
  query: string,              // text search against entity names and aliases
  entity_type?: string,       // filter: "person", "grant", "paper", etc.
  relation_type?: string,     // filter: "authored", "funded_by", etc.
  hops?: number,              // traversal depth: 0=match only, 1=neighbors (default), 2, max 3
  from_entity_id?: string,    // start from known entity instead of text search
  limit?: number              // max results (default: 20)
})
```

Returns a readable subgraph: matched entities + neighbors out to `hops` distance, with edges and evidence strings. Formatted as indented text tree for agent consumption.

**Implementation:** Host-side IPC handler runs SQLite recursive CTE. Traversal is bidirectional — edges are walked in both directions so "who authored this paper" and "what did this person author" both work:

```sql
WITH RECURSIVE traverse(entity_id, depth, path) AS (
  SELECT id, 0, id FROM entities WHERE id = :start_id
  UNION ALL
  -- Forward: source → target
  SELECT e.target_id, t.depth + 1, t.path || ',' || e.target_id
  FROM edges e JOIN traverse t ON e.source_id = t.entity_id
  WHERE t.depth < :max_hops
    AND e.target_id NOT IN (SELECT value FROM json_each(t.path))
  UNION ALL
  -- Reverse: target → source
  SELECT e.source_id, t.depth + 1, t.path || ',' || e.source_id
  FROM edges e JOIN traverse t ON e.target_id = t.entity_id
  WHERE t.depth < :max_hops
    AND e.source_id NOT IN (SELECT value FROM json_each(t.path))
)
SELECT DISTINCT entity_id, depth FROM traverse;
```

### `kg_write` — Propose new entities/edges

```typescript
kg_write({
  entity?: {
    name: string,
    type: string,
    aliases?: string[],
    metadata?: object,
    source_doc?: string
  },
  edge?: {
    source_name: string,      // resolved against alias table
    target_name: string,
    relation: string,
    evidence: string           // required
  }
})
```

**Security:**
- `created_by` stamped with verified `sourceGroup` from IPC directory path (same pattern as `knowledge_publish`)
- Proposed names run through alias resolution
- High confidence match → links to existing entity
- Ambiguous match → adds to `review_queue`, returns "queued for review"
- New entities from agents get `confidence: 0.8`
- Agents CANNOT delete entities, modify existing edges, or change canonical names

### Agent Discovery

Agents learn about the knowledge graph via a short section in `groups/global/CLAUDE.md`:

```markdown
## Knowledge Graph
A persistent entity-relationship graph is available via two MCP tools:
- `kg_query({query, hops?})` — find entities and traverse connections
- `kg_write({entity?, edge?})` — propose new entities or relationships you discover

Use kg_query when you need relational context: who is connected to a project, 
what datasets a grant uses, which tools are relevant to a method. Use kg_write 
when you discover a new relationship (e.g., a paper cites a dataset we track).
```

No auto-injection into context packets. Agents call the tools when they need them.

## Ingestion Pipeline & Scheduling

### Bulk Ingestion (one-time)

Script: `scripts/kg/ingest.py`

Runs phases 1-3 sequentially, then generates the validation report. Intended to be run manually (or from Claude Code) and reviewed before the graph goes live.

### Incremental Ingestion (ongoing)

Script: `scripts/kg/incremental.py`

Added as a new step in `scripts/sync/sync-all.sh` (runs every 4 hours):

1. Detect new/modified files since last run (file mtime tracking in state file)
2. Run Ollama extraction on changed files
3. Alias-match against existing entities
4. High confidence (>0.9) → auto-add. Low confidence → review queue
5. Weekly: Claude batch pass on accumulated review queue items (~$0.50/week)

### Agent Contributions (real-time)

When an agent calls `kg_write`, the IPC handler processes synchronously:
- Alias resolution runs immediately
- Returns "added" or "queued for review" within the agent session
- No batch delay

## File Structure

```
scripts/kg/
├── ingest.py           # Bulk ingestion (phases 1-3)
├── incremental.py      # Ongoing sync step
├── validate.py         # Validation report generator
├── extract_ollama.py   # Ollama entity extraction
├── extract_claude.py   # Claude targeted extraction
├── frontmatter.py      # Deterministic YAML parser
├── resolve.py          # Alias resolution + review queue logic
└── schema.sql          # SQLite DDL

src/
├── kg.ts               # SQLite operations (CRUD, traverse)
└── kg-ipc.ts           # IPC handlers for kg_query and kg_write
```

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| SQLite (better-sqlite3) | Already in stack | Used by `src/db.ts` |
| Ollama phi4-mini | Already running | Used by email classifier |
| Claude API (Sonnet) | Via credential proxy | One-time bulk + weekly review batch |
| Python 3 + venv | Already used | Same pattern as pageindex, email-ingest |
| sync-all.sh | Running every 4h | Add one step |

No new infrastructure required.

## Relationship to Other Specs

- **Smarter Claw Roadmap (2026-04-13):** This spec implements the Knowledge Graph feature listed under "Future Vision." The roadmap deferred it pending shared intelligence layer validation. This spec can proceed independently — it uses IPC (existing) not the shared intelligence layer (1.2).
- **VISION4.md:** Implements Layer 5 of the five-tier memory architecture.
- **Shared Intelligence Layer (1.2):** Complementary. Agent-knowledge collection stores agent findings as documents. The knowledge graph indexes entities and relationships across ALL documents (vault, emails, agent-knowledge). They serve different access patterns: document search vs. relationship traversal.
- **Agent Architecture Redesign (2026-04-13):** No dependency. The KG IPC handlers follow the same sourceGroup stamping pattern already established.
- **Email Ingestion Pipeline (2026-04-12):** The email QMD collection is a candidate for incremental ingestion. New classified emails get entity extraction via Ollama.

## Open Questions

1. **Graph visualization:** Should we expose a web UI for browsing the graph? Obsidian has a graph view but it works on wikilinks, not SQLite. A simple D3 force-directed graph served locally could work but is scope creep for v1.
2. **Serendipity surfacing:** The "connect the dots" use case needs a mechanism to proactively surface interesting connections. Options: (a) agents query the graph on every session start, (b) a scheduled task runs "what's new and interesting" queries and publishes to Telegram, (c) both. Deferred to post-v1.
3. **QMD integration:** Should `kg_query` results boost QMD search? (e.g., a QMD search for "spatial transcriptomics" also returns entities and their neighbors from the KG). This is the "entity-aware retrieval" concept from VISION4.md. Deferred to post-v1.
