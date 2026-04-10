#!/usr/bin/env python3
"""Tests for db.py — SQLite schema and CRUD layer."""

import os
import sys
import tempfile
import pytest

# Allow importing db from parent package without installing
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db as dbmod
from db import (
    init_db,
    get_db,
    get_schema_version,
    upsert_paper,
    get_paper,
    get_papers_by_cluster,
    get_papers_missing_embeddings,
    get_new_papers,
    update_paper_embedding,
    update_paper_cluster,
    mark_papers_incorporated,
    upsert_cluster,
    get_cluster,
    get_all_clusters,
    upsert_synthesis_page,
    mark_synthesis_stale,
    get_stale_syntheses,
    save_synthesis_history,
    record_paper_synthesis,
    get_total_paper_count,
    get_new_paper_count_for_cluster,
)


@pytest.fixture
def tmp_db(tmp_path):
    """Return a fresh DB path in a temp dir, with schema initialised."""
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    return db_path


@pytest.fixture
def con(tmp_db):
    """Open a connection to a fresh DB, close after test."""
    c = get_db(tmp_db)
    yield c
    c.close()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

class TestSchemaVersion:
    def test_version_is_1(self, con):
        assert get_schema_version(con) == dbmod.SCHEMA_VERSION

    def test_init_idempotent(self, tmp_db):
        """Calling init_db twice should not raise or double-insert version."""
        init_db(tmp_db)
        con = get_db(tmp_db)
        row = con.execute("SELECT COUNT(*) FROM schema_version").fetchone()
        con.close()
        assert row[0] == 1

    def test_wal_mode(self, con):
        row = con.execute("PRAGMA journal_mode").fetchone()
        assert row[0] == "wal"

    def test_foreign_keys_on(self, con):
        row = con.execute("PRAGMA foreign_keys").fetchone()
        assert row[0] == 1


# ---------------------------------------------------------------------------
# Papers
# ---------------------------------------------------------------------------

PAPER_A = {
    "id": "paper-001",
    "title": "Neural correlates of working memory",
    "authors": "Smith, J.; Doe, A.",
    "first_author": "Smith",
    "year": 2020,
    "journal": "Nature Neuroscience",
    "abstract": "We investigated working memory using fMRI.",
    "doi": "10.1000/xyz001",
}

PAPER_B = {
    "id": "paper-002",
    "title": "Cortical oscillations during sleep",
    "authors": "Jones, B.",
    "first_author": "Jones",
    "year": 2021,
    "journal": "Science",
}


class TestUpsertGetPaper:
    def test_insert_paper(self, con):
        upsert_paper(con, PAPER_A)
        con.commit()
        row = get_paper(con, "paper-001")
        assert row is not None
        assert row["title"] == PAPER_A["title"]
        assert row["year"] == 2020

    def test_get_nonexistent_paper(self, con):
        assert get_paper(con, "no-such-id") is None

    def test_upsert_updates_title(self, con):
        upsert_paper(con, PAPER_A)
        con.commit()
        updated = {**PAPER_A, "title": "Updated Title"}
        upsert_paper(con, updated)
        con.commit()
        row = get_paper(con, "paper-001")
        assert row["title"] == "Updated Title"

    def test_upsert_idempotent(self, con):
        upsert_paper(con, PAPER_A)
        upsert_paper(con, PAPER_A)
        con.commit()
        count = con.execute("SELECT COUNT(*) FROM papers WHERE id = ?", ("paper-001",)).fetchone()[0]
        assert count == 1

    def test_upsert_preserves_pdf_path(self, con):
        """pdf_path set on first insert is preserved when update omits it."""
        paper_with_pdf = {**PAPER_A, "pdf_path": "/vault/paper.pdf"}
        upsert_paper(con, paper_with_pdf)
        con.commit()

        paper_no_pdf = {**PAPER_A, "title": "New Title"}
        # Ensure pdf_path is not present in the update dict
        paper_no_pdf.pop("pdf_path", None)
        upsert_paper(con, paper_no_pdf)
        con.commit()

        row = get_paper(con, "paper-001")
        assert row["pdf_path"] == "/vault/paper.pdf"

    def test_is_new_defaults_to_1(self, con):
        upsert_paper(con, PAPER_A)
        con.commit()
        row = get_paper(con, "paper-001")
        assert row["is_new"] == 1

    def test_get_new_papers(self, con):
        upsert_paper(con, PAPER_A)
        upsert_paper(con, PAPER_B)
        con.commit()
        new = get_new_papers(con)
        ids = [r["id"] for r in new]
        assert "paper-001" in ids
        assert "paper-002" in ids

    def test_mark_papers_incorporated(self, con):
        upsert_paper(con, PAPER_A)
        upsert_paper(con, PAPER_B)
        con.commit()
        mark_papers_incorporated(con, ["paper-001"])
        con.commit()
        row = get_paper(con, "paper-001")
        assert row["is_new"] == 0
        row2 = get_paper(con, "paper-002")
        assert row2["is_new"] == 1

    def test_mark_papers_incorporated_empty_list(self, con):
        """Should not raise on empty input."""
        mark_papers_incorporated(con, [])

    def test_get_papers_missing_embeddings(self, con):
        upsert_paper(con, PAPER_A)
        upsert_paper(con, PAPER_B)
        con.commit()
        missing = get_papers_missing_embeddings(con)
        assert len(missing) == 2

    def test_update_paper_embedding(self, con):
        upsert_paper(con, PAPER_A)
        con.commit()
        fake_emb = bytes(768 * 4)  # 768 float32s = 3072 bytes
        update_paper_embedding(con, "paper-001", fake_emb)
        con.commit()
        row = get_paper(con, "paper-001")
        assert row["embedding"] == fake_emb

    def test_total_paper_count(self, con):
        assert get_total_paper_count(con) == 0
        upsert_paper(con, PAPER_A)
        upsert_paper(con, PAPER_B)
        con.commit()
        assert get_total_paper_count(con) == 2


# ---------------------------------------------------------------------------
# Clusters
# ---------------------------------------------------------------------------

CLUSTER_A = {
    "name": "Neuroscience",
    "slug": "neuroscience",
    "description": "Brain and behavior papers",
}


class TestClusterCRUD:
    def test_insert_cluster(self, con):
        cid = upsert_cluster(con, CLUSTER_A)
        con.commit()
        assert cid is not None
        row = get_cluster(con, cid)
        assert row["slug"] == "neuroscience"
        assert row["name"] == "Neuroscience"

    def test_upsert_cluster_idempotent(self, con):
        cid1 = upsert_cluster(con, CLUSTER_A)
        con.commit()
        cid2 = upsert_cluster(con, {**CLUSTER_A, "description": "Updated"})
        con.commit()
        assert cid1 == cid2
        row = get_cluster(con, cid1)
        assert row["description"] == "Updated"

    def test_get_all_clusters(self, con):
        upsert_cluster(con, CLUSTER_A)
        upsert_cluster(con, {"name": "Genetics", "slug": "genetics"})
        con.commit()
        clusters = get_all_clusters(con)
        slugs = [r["slug"] for r in clusters]
        assert "neuroscience" in slugs
        assert "genetics" in slugs

    def test_get_nonexistent_cluster(self, con):
        assert get_cluster(con, 99999) is None

    def test_upsert_cluster_with_explicit_id(self, con):
        upsert_cluster(con, {**CLUSTER_A, "id": 42})
        con.commit()
        row = get_cluster(con, 42)
        assert row is not None
        assert row["slug"] == "neuroscience"


# ---------------------------------------------------------------------------
# Papers by cluster
# ---------------------------------------------------------------------------

class TestPapersByCluster:
    def test_papers_by_cluster(self, con):
        cid = upsert_cluster(con, CLUSTER_A)
        con.commit()
        upsert_paper(con, {**PAPER_A, "cluster_id": cid})
        upsert_paper(con, {**PAPER_B, "cluster_id": cid})
        upsert_paper(con, {"id": "paper-003", "title": "Other", "cluster_id": None})
        con.commit()
        rows = get_papers_by_cluster(con, cid)
        ids = [r["id"] for r in rows]
        assert "paper-001" in ids
        assert "paper-002" in ids
        assert "paper-003" not in ids

    def test_new_paper_count_for_cluster(self, con):
        cid = upsert_cluster(con, CLUSTER_A)
        con.commit()
        upsert_paper(con, {**PAPER_A, "cluster_id": cid})
        upsert_paper(con, {**PAPER_B, "cluster_id": cid, "is_new": 0})
        con.commit()
        assert get_new_paper_count_for_cluster(con, cid) == 1

    def test_update_paper_cluster(self, con):
        cid = upsert_cluster(con, CLUSTER_A)
        con.commit()
        upsert_paper(con, PAPER_A)
        con.commit()
        update_paper_cluster(con, "paper-001", cid, confidence=0.85)
        con.commit()
        row = get_paper(con, "paper-001")
        assert row["cluster_id"] == cid
        assert abs(row["cluster_confidence"] - 0.85) < 1e-6


# ---------------------------------------------------------------------------
# Synthesis pages
# ---------------------------------------------------------------------------

class TestSynthesisPages:
    def _make_cluster(self, con):
        cid = upsert_cluster(con, CLUSTER_A)
        con.commit()
        return cid

    def test_insert_synthesis_page(self, con):
        cid = self._make_cluster(con)
        sid = upsert_synthesis_page(con, {"cluster_id": cid, "file_path": "/vault/neuro.md"})
        con.commit()
        assert sid is not None

    def test_synthesis_default_status_is_draft(self, con):
        cid = self._make_cluster(con)
        sid = upsert_synthesis_page(con, {"cluster_id": cid})
        con.commit()
        row = con.execute("SELECT status FROM synthesis_pages WHERE id = ?", (sid,)).fetchone()
        assert row["status"] == "draft"

    def test_mark_synthesis_stale(self, con):
        cid = self._make_cluster(con)
        sid = upsert_synthesis_page(con, {"cluster_id": cid, "status": "current"})
        con.commit()
        mark_synthesis_stale(con, sid)
        con.commit()
        stale = get_stale_syntheses(con)
        ids = [r["id"] for r in stale]
        assert sid in ids

    def test_get_stale_syntheses(self, con):
        cid = self._make_cluster(con)
        sid_current = upsert_synthesis_page(con, {"cluster_id": cid, "status": "current"})
        sid_stale = upsert_synthesis_page(con, {"cluster_id": cid, "status": "stale"})
        con.commit()
        stale = get_stale_syntheses(con)
        stale_ids = [r["id"] for r in stale]
        assert sid_stale in stale_ids
        assert sid_current not in stale_ids

    def test_upsert_synthesis_page_update(self, con):
        cid = self._make_cluster(con)
        sid = upsert_synthesis_page(con, {"cluster_id": cid, "status": "draft"})
        con.commit()
        upsert_synthesis_page(con, {"id": sid, "cluster_id": cid, "status": "current", "file_path": "/vault/out.md"})
        con.commit()
        row = con.execute("SELECT status FROM synthesis_pages WHERE id = ?", (sid,)).fetchone()
        assert row["status"] == "current"


# ---------------------------------------------------------------------------
# Synthesis history
# ---------------------------------------------------------------------------

class TestSynthesisHistory:
    def _setup(self, con):
        cid = upsert_cluster(con, CLUSTER_A)
        con.commit()
        sid = upsert_synthesis_page(con, {"cluster_id": cid})
        con.commit()
        return sid

    def test_save_synthesis_history(self, con):
        sid = self._setup(con)
        hid = save_synthesis_history(con, sid, "# Neuroscience\nContent here.")
        con.commit()
        assert hid is not None
        row = con.execute("SELECT * FROM synthesis_history WHERE id = ?", (hid,)).fetchone()
        assert row["synthesis_id"] == sid
        assert "Neuroscience" in row["content"]

    def test_multiple_history_rows(self, con):
        sid = self._setup(con)
        save_synthesis_history(con, sid, "Version 1")
        save_synthesis_history(con, sid, "Version 2")
        con.commit()
        rows = con.execute("SELECT * FROM synthesis_history WHERE synthesis_id = ?", (sid,)).fetchall()
        assert len(rows) == 2

    def test_record_paper_synthesis(self, con):
        upsert_paper(con, PAPER_A)
        sid = self._setup(con)
        con.commit()
        record_paper_synthesis(con, "paper-001", sid)
        con.commit()
        row = con.execute(
            "SELECT * FROM paper_synthesis WHERE paper_id = ? AND synthesis_id = ?",
            ("paper-001", sid),
        ).fetchone()
        assert row is not None
        assert row["role"] == "primary"

    def test_record_paper_synthesis_idempotent(self, con):
        upsert_paper(con, PAPER_A)
        sid = self._setup(con)
        con.commit()
        record_paper_synthesis(con, "paper-001", sid)
        record_paper_synthesis(con, "paper-001", sid)
        con.commit()
        count = con.execute(
            "SELECT COUNT(*) FROM paper_synthesis WHERE paper_id = ? AND synthesis_id = ?",
            ("paper-001", sid),
        ).fetchone()[0]
        assert count == 1

    def test_record_paper_synthesis_custom_role(self, con):
        upsert_paper(con, PAPER_A)
        sid = self._setup(con)
        con.commit()
        record_paper_synthesis(con, "paper-001", sid, role="supporting")
        con.commit()
        row = con.execute(
            "SELECT role FROM paper_synthesis WHERE paper_id = ? AND synthesis_id = ?",
            ("paper-001", sid),
        ).fetchone()
        assert row["role"] == "supporting"
