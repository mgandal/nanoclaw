#!/usr/bin/env python3
"""Database layer for paperpile-wiki pipeline.

Manages SQLite storage for papers, clusters, synthesis pages, and history.
All timestamps are UTC ISO-8601 strings. WAL mode and foreign keys are enabled.
"""

import os
import sqlite3
from datetime import datetime, timezone
from typing import Optional

# Default DB path (can be overridden in tests)
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(_REPO_ROOT, "store", "paperpile.db")

SCHEMA_VERSION = 1

_CREATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL,
    applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS clusters (
    id          INTEGER PRIMARY KEY,
    name        TEXT,
    slug        TEXT UNIQUE,
    description TEXT,
    centroid    BLOB,
    parent_id   INTEGER REFERENCES clusters(id),
    paper_count INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS papers (
    id                 TEXT    PRIMARY KEY,
    title              TEXT    NOT NULL,
    authors            TEXT,
    first_author       TEXT,
    year               INTEGER,
    journal            TEXT,
    abstract           TEXT,
    doi                TEXT,
    pmid               TEXT,
    pmc                TEXT,
    url                TEXT,
    keywords           TEXT,
    pdf_path           TEXT,
    embedding          BLOB,
    cluster_id         INTEGER REFERENCES clusters(id),
    cluster_confidence REAL    NOT NULL DEFAULT 1.0,
    is_new             INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_papers_cluster_id ON papers(cluster_id);
CREATE INDEX IF NOT EXISTS idx_papers_doi        ON papers(doi);
CREATE INDEX IF NOT EXISTS idx_papers_is_new     ON papers(is_new);

CREATE TABLE IF NOT EXISTS synthesis_pages (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id               INTEGER NOT NULL REFERENCES clusters(id),
    file_path                TEXT,
    status                   TEXT    NOT NULL DEFAULT 'draft',
    last_generated           TEXT,
    paper_count_at_generation INTEGER,
    generation_cost_usd      REAL,
    updated_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_synthesis_cluster_id ON synthesis_pages(cluster_id);
CREATE INDEX IF NOT EXISTS idx_synthesis_status     ON synthesis_pages(status);

CREATE TABLE IF NOT EXISTS paper_synthesis (
    paper_id    TEXT    NOT NULL REFERENCES papers(id),
    synthesis_id INTEGER NOT NULL REFERENCES synthesis_pages(id),
    role        TEXT    NOT NULL DEFAULT 'primary',
    PRIMARY KEY (paper_id, synthesis_id)
);

CREATE TABLE IF NOT EXISTS synthesis_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    synthesis_id INTEGER NOT NULL REFERENCES synthesis_pages(id),
    content      TEXT    NOT NULL,
    generated_at TEXT,
    replaced_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_db(db_path: str = DB_PATH) -> None:
    """Create all tables and insert schema_version row if missing."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    con = sqlite3.connect(db_path)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA foreign_keys=ON")
        con.executescript(_CREATE_SCHEMA)
        row = con.execute("SELECT COUNT(*) FROM schema_version").fetchone()
        if row[0] == 0:
            con.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                (SCHEMA_VERSION, _now_utc()),
            )
        con.commit()
    finally:
        con.close()


def get_db(db_path: str = DB_PATH) -> sqlite3.Connection:
    """Return a configured connection. Caller is responsible for closing."""
    con = sqlite3.connect(db_path)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.row_factory = sqlite3.Row
    return con


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------

def get_schema_version(con: sqlite3.Connection) -> int:
    """Return the stored schema version, or 0 if table is empty."""
    row = con.execute("SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1").fetchone()
    return row[0] if row else 0


# ---------------------------------------------------------------------------
# Papers
# ---------------------------------------------------------------------------

def upsert_paper(con: sqlite3.Connection, paper: dict) -> None:
    """Insert or update a paper row. Preserves pdf_path if not provided."""
    now = _now_utc()
    con.execute(
        """
        INSERT INTO papers (
            id, title, authors, first_author, year, journal, abstract,
            doi, pmid, pmc, url, keywords, pdf_path,
            embedding, cluster_id, cluster_confidence, is_new,
            created_at, updated_at
        ) VALUES (
            :id, :title, :authors, :first_author, :year, :journal, :abstract,
            :doi, :pmid, :pmc, :url, :keywords, :pdf_path,
            :embedding, :cluster_id, :cluster_confidence, :is_new,
            :created_at, :updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
            title              = excluded.title,
            authors            = excluded.authors,
            first_author       = excluded.first_author,
            year               = excluded.year,
            journal            = excluded.journal,
            abstract           = excluded.abstract,
            doi                = excluded.doi,
            pmid               = excluded.pmid,
            pmc                = excluded.pmc,
            url                = excluded.url,
            keywords           = excluded.keywords,
            pdf_path           = COALESCE(excluded.pdf_path, papers.pdf_path),
            embedding          = COALESCE(excluded.embedding, papers.embedding),
            cluster_id         = COALESCE(excluded.cluster_id, papers.cluster_id),
            cluster_confidence = COALESCE(excluded.cluster_confidence, papers.cluster_confidence),
            updated_at         = excluded.updated_at
        """,
        {
            "id": paper["id"],
            "title": paper["title"],
            "authors": paper.get("authors"),
            "first_author": paper.get("first_author"),
            "year": paper.get("year"),
            "journal": paper.get("journal"),
            "abstract": paper.get("abstract"),
            "doi": paper.get("doi"),
            "pmid": paper.get("pmid"),
            "pmc": paper.get("pmc"),
            "url": paper.get("url"),
            "keywords": paper.get("keywords"),
            "pdf_path": paper.get("pdf_path"),
            "embedding": paper.get("embedding"),
            "cluster_id": paper.get("cluster_id"),
            "cluster_confidence": paper.get("cluster_confidence", 1.0),
            "is_new": paper.get("is_new", 1),
            "created_at": paper.get("created_at", now),
            "updated_at": now,
        },
    )


def get_paper(con: sqlite3.Connection, paper_id: str) -> Optional[sqlite3.Row]:
    return con.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()


def get_papers_by_cluster(con: sqlite3.Connection, cluster_id: int) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM papers WHERE cluster_id = ? ORDER BY year DESC, title", (cluster_id,)
    ).fetchall()


def get_papers_missing_embeddings(con: sqlite3.Connection) -> list[sqlite3.Row]:
    return con.execute("SELECT * FROM papers WHERE embedding IS NULL").fetchall()


def get_new_papers(con: sqlite3.Connection) -> list[sqlite3.Row]:
    return con.execute("SELECT * FROM papers WHERE is_new = 1").fetchall()


def update_paper_embedding(con: sqlite3.Connection, paper_id: str, embedding: bytes) -> None:
    con.execute(
        "UPDATE papers SET embedding = ?, updated_at = ? WHERE id = ?",
        (embedding, _now_utc(), paper_id),
    )


def update_paper_cluster(
    con: sqlite3.Connection,
    paper_id: str,
    cluster_id: int,
    confidence: float = 1.0,
) -> None:
    con.execute(
        "UPDATE papers SET cluster_id = ?, cluster_confidence = ?, updated_at = ? WHERE id = ?",
        (cluster_id, confidence, _now_utc(), paper_id),
    )


def mark_papers_incorporated(con: sqlite3.Connection, paper_ids: list[str]) -> None:
    """Clear the is_new flag for the given paper IDs."""
    if not paper_ids:
        return
    placeholders = ",".join("?" * len(paper_ids))
    con.execute(
        f"UPDATE papers SET is_new = 0, updated_at = ? WHERE id IN ({placeholders})",
        [_now_utc()] + list(paper_ids),
    )


def get_total_paper_count(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT COUNT(*) FROM papers").fetchone()
    return row[0]


def get_new_paper_count_for_cluster(con: sqlite3.Connection, cluster_id: int) -> int:
    row = con.execute(
        "SELECT COUNT(*) FROM papers WHERE cluster_id = ? AND is_new = 1", (cluster_id,)
    ).fetchone()
    return row[0]


# ---------------------------------------------------------------------------
# Clusters
# ---------------------------------------------------------------------------

def upsert_cluster(con: sqlite3.Connection, cluster: dict) -> int:
    """Insert or update a cluster. Returns the cluster id."""
    now = _now_utc()
    if "id" in cluster and cluster["id"] is not None:
        con.execute(
            """
            INSERT INTO clusters (id, name, slug, description, centroid, parent_id, paper_count, created_at, updated_at)
            VALUES (:id, :name, :slug, :description, :centroid, :parent_id, :paper_count, :created_at, :updated_at)
            ON CONFLICT(id) DO UPDATE SET
                name        = excluded.name,
                slug        = excluded.slug,
                description = excluded.description,
                centroid    = COALESCE(excluded.centroid, clusters.centroid),
                parent_id   = excluded.parent_id,
                paper_count = excluded.paper_count,
                updated_at  = excluded.updated_at
            """,
            {
                "id": cluster["id"],
                "name": cluster.get("name"),
                "slug": cluster.get("slug"),
                "description": cluster.get("description"),
                "centroid": cluster.get("centroid"),
                "parent_id": cluster.get("parent_id"),
                "paper_count": cluster.get("paper_count", 0),
                "created_at": cluster.get("created_at", now),
                "updated_at": now,
            },
        )
        return cluster["id"]
    else:
        cur = con.execute(
            """
            INSERT INTO clusters (name, slug, description, centroid, parent_id, paper_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
                name        = excluded.name,
                description = excluded.description,
                centroid    = COALESCE(excluded.centroid, clusters.centroid),
                parent_id   = excluded.parent_id,
                paper_count = excluded.paper_count,
                updated_at  = excluded.updated_at
            RETURNING id
            """,
            (
                cluster.get("name"),
                cluster.get("slug"),
                cluster.get("description"),
                cluster.get("centroid"),
                cluster.get("parent_id"),
                cluster.get("paper_count", 0),
                cluster.get("created_at", now),
                now,
            ),
        )
        row = cur.fetchone()
        if row:
            return row[0]
        # Slug conflict path — fetch existing id
        existing = con.execute(
            "SELECT id FROM clusters WHERE slug = ?", (cluster.get("slug"),)
        ).fetchone()
        return existing[0]


def get_cluster(con: sqlite3.Connection, cluster_id: int) -> Optional[sqlite3.Row]:
    return con.execute("SELECT * FROM clusters WHERE id = ?", (cluster_id,)).fetchone()


def get_all_clusters(con: sqlite3.Connection) -> list[sqlite3.Row]:
    return con.execute("SELECT * FROM clusters ORDER BY name").fetchall()


# ---------------------------------------------------------------------------
# Synthesis pages
# ---------------------------------------------------------------------------

def upsert_synthesis_page(con: sqlite3.Connection, synthesis: dict) -> int:
    """Insert or update a synthesis page. Returns the synthesis id."""
    now = _now_utc()
    if "id" in synthesis and synthesis["id"] is not None:
        con.execute(
            """
            INSERT INTO synthesis_pages (
                id, cluster_id, file_path, status, last_generated,
                paper_count_at_generation, generation_cost_usd, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                cluster_id                = excluded.cluster_id,
                file_path                 = excluded.file_path,
                status                    = excluded.status,
                last_generated            = excluded.last_generated,
                paper_count_at_generation = excluded.paper_count_at_generation,
                generation_cost_usd       = excluded.generation_cost_usd,
                updated_at                = excluded.updated_at
            """,
            (
                synthesis["id"],
                synthesis["cluster_id"],
                synthesis.get("file_path"),
                synthesis.get("status", "draft"),
                synthesis.get("last_generated"),
                synthesis.get("paper_count_at_generation"),
                synthesis.get("generation_cost_usd"),
                now,
            ),
        )
        return synthesis["id"]
    else:
        cur = con.execute(
            """
            INSERT INTO synthesis_pages (
                cluster_id, file_path, status, last_generated,
                paper_count_at_generation, generation_cost_usd, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                synthesis["cluster_id"],
                synthesis.get("file_path"),
                synthesis.get("status", "draft"),
                synthesis.get("last_generated"),
                synthesis.get("paper_count_at_generation"),
                synthesis.get("generation_cost_usd"),
                now,
            ),
        )
        return cur.lastrowid


def mark_synthesis_stale(con: sqlite3.Connection, synthesis_id: int) -> None:
    con.execute(
        "UPDATE synthesis_pages SET status = 'stale', updated_at = ? WHERE id = ?",
        (_now_utc(), synthesis_id),
    )


def get_stale_syntheses(con: sqlite3.Connection) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM synthesis_pages WHERE status = 'stale'"
    ).fetchall()


# ---------------------------------------------------------------------------
# Synthesis history
# ---------------------------------------------------------------------------

def save_synthesis_history(
    con: sqlite3.Connection,
    synthesis_id: int,
    content: str,
    generated_at: Optional[str] = None,
) -> int:
    """Archive a synthesis version. Returns the history row id."""
    cur = con.execute(
        """
        INSERT INTO synthesis_history (synthesis_id, content, generated_at)
        VALUES (?, ?, ?)
        """,
        (synthesis_id, content, generated_at or _now_utc()),
    )
    return cur.lastrowid


def record_paper_synthesis(
    con: sqlite3.Connection,
    paper_id: str,
    synthesis_id: int,
    role: str = "primary",
) -> None:
    """Link a paper to a synthesis page (idempotent)."""
    con.execute(
        """
        INSERT INTO paper_synthesis (paper_id, synthesis_id, role)
        VALUES (?, ?, ?)
        ON CONFLICT(paper_id, synthesis_id) DO UPDATE SET role = excluded.role
        """,
        (paper_id, synthesis_id, role),
    )
