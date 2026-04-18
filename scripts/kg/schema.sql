-- Knowledge Graph Layer 5 schema.
-- See docs/superpowers/specs/2026-04-14-knowledge-graph-layer5-design.md
--
-- Applied to store/knowledge-graph.db by scripts/kg/ingest_phase1.py.

CREATE TABLE IF NOT EXISTS entities (
  id              TEXT PRIMARY KEY,
  canonical_name  TEXT NOT NULL,
  type            TEXT NOT NULL,            -- person|paper|dataset|tool|grant|project|method|institution|disorder
  metadata        TEXT,                     -- JSON blob
  source_doc      TEXT,                     -- vault path (or state file) that created this entity
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aliases (
  alias           TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL REFERENCES entities(id),
  source          TEXT,                     -- vault|state|generated
  PRIMARY KEY (alias, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS edges (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES entities(id),
  target_id       TEXT NOT NULL REFERENCES entities(id),
  relation        TEXT NOT NULL,
  evidence        TEXT,
  source_doc      TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_by      TEXT NOT NULL,            -- bulk_ingest|ollama|claude|agent:{group}|user
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_queue (
  id              TEXT PRIMARY KEY,
  candidate_a     TEXT NOT NULL,
  candidate_b     TEXT,
  entity_type     TEXT,
  context         TEXT,
  resolution      TEXT,                     -- NULL = pending, or merge|distinct|skip
  resolved_by     TEXT,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_aliases_lookup ON aliases(alias, entity_type);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
CREATE INDEX IF NOT EXISTS idx_review_pending ON review_queue(resolution) WHERE resolution IS NULL;
