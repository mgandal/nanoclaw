"""End-to-end test: build a synthetic vault + state, run ingest, verify DB."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from kg.ingest_phase1 import collect_entities, write_to_db


CONTACT_A = """\
---
type: collaborator
name: Rachel Smith
email: rsmith@example.com
institution: UCLA
role: Postdoc
projects:
  - BrainGO
---

# Rachel Smith
"""

CONTACT_B = """\
---
type: collaborator
name: Aaron Alexander-Bloch
email: aab@penn.edu
institution: Penn
role: PI
---

# Aaron Alexander-Bloch
"""

TOOL = """\
---
type: "kb-tool"
name: "flash"
language: "R"
related_tools: ["ebnm"]
key_papers: ["Wang & Stephens 2021"]
---

# Flash
"""

DATASET = """\
---
type: "kb-dataset"
name: "Siletti Brain Atlas"
acronym: "SBA"
disorders: ["cross-disorder"]
---

# SBA
"""

PAPER = """\
---
type: kb-paper
doi: "10.1038/xyz"
first_author: "Rachel Smith"
year: 2026
journal: "Nature"
---

# paper
"""

GRANTS = """\
# Grant Portfolio

## Active Grants

### NIH R01-MH137578
Foo.

### NIH R01-MH121521
Bar.
"""

PROJECTS = """\
# Lab Projects

## Active Projects

### BrainGO
Lead: Rachel Smith

### APA (Alternative Polyadenylation)
Lead: Someone
"""

ROSTER = """\
# Lab Roster

## Current Members

| Name | Role | Projects |
|------|------|----------|
| Rachel Smith | Postdoc | BrainGO |
| Yundan Liao | Postdoc | - |
"""


@pytest.fixture
def mini_env(tmp_path: Path):
    vault = tmp_path / "vault"
    (vault / "20-contacts").mkdir(parents=True)
    (vault / "99-wiki" / "tools").mkdir(parents=True)
    (vault / "99-wiki" / "datasets").mkdir(parents=True)
    (vault / "99-wiki" / "papers").mkdir(parents=True)

    (vault / "20-contacts" / "rachel-smith.md").write_text(CONTACT_A)
    (vault / "20-contacts" / "aaron.md").write_text(CONTACT_B)
    (vault / "20-contacts" / "_template.md").write_text("should be skipped")
    (vault / "99-wiki" / "tools" / "flash.md").write_text(TOOL)
    (vault / "99-wiki" / "datasets" / "sba.md").write_text(DATASET)
    (vault / "99-wiki" / "papers" / "smith-2026.md").write_text(PAPER)

    repo = tmp_path / "repo"
    state = repo / "groups" / "global" / "state"
    state.mkdir(parents=True)
    (state / "grants.md").write_text(GRANTS)
    (state / "projects.md").write_text(PROJECTS)
    (state / "lab-roster.md").write_text(ROSTER)

    return {"vault": vault, "repo": repo, "db": tmp_path / "kg.db"}


def test_collect_produces_all_types(mini_env):
    entities, edges = collect_entities(mini_env["vault"], mini_env["repo"])
    types = {e["type"] for e in entities}
    assert {"person", "tool", "dataset", "paper", "grant", "project"} <= types


def test_collect_skips_underscore_files(mini_env):
    entities, _ = collect_entities(mini_env["vault"], mini_env["repo"])
    sources = {e["source_doc"] for e in entities}
    assert not any("_template" in s for s in sources)


def test_write_persists_entities(mini_env):
    entities, edges = collect_entities(mini_env["vault"], mini_env["repo"])
    summary = write_to_db(mini_env["db"], entities, edges)
    assert summary["entities_inserted"] > 0

    conn = sqlite3.connect(mini_env["db"])
    try:
        names = {
            row[0]
            for row in conn.execute("SELECT canonical_name FROM entities").fetchall()
        }
        assert "Rachel Smith" in names
        assert "flash" in names
        assert "R01-MH137578" in names
        assert "BrainGO" in names
    finally:
        conn.close()


def test_dedup_rachel_across_contact_and_roster(mini_env):
    entities, edges = collect_entities(mini_env["vault"], mini_env["repo"])
    summary = write_to_db(mini_env["db"], entities, edges)

    conn = sqlite3.connect(mini_env["db"])
    try:
        count = conn.execute(
            "SELECT COUNT(*) FROM entities WHERE type='person' AND canonical_name='Rachel Smith'"
        ).fetchone()[0]
        assert count == 1
        assert summary["entities_merged"] >= 1
    finally:
        conn.close()


def test_edges_resolve_and_insert(mini_env):
    entities, edges = collect_entities(mini_env["vault"], mini_env["repo"])
    summary = write_to_db(mini_env["db"], entities, edges)
    assert summary["edges_inserted"] > 0

    conn = sqlite3.connect(mini_env["db"])
    try:
        # Rachel → BrainGO (member_of, from contact projects[])
        row = conn.execute(
            """
            SELECT e.relation FROM edges e
            JOIN entities s ON s.id = e.source_id
            JOIN entities t ON t.id = e.target_id
            WHERE s.canonical_name = 'Rachel Smith'
              AND t.canonical_name = 'BrainGO'
            """
        ).fetchone()
        assert row is not None
        assert row[0] == "member_of"

        # Rachel → paper "Rachel Smith 2026 (Nature)" (authored, from paper first_author)
        row = conn.execute(
            """
            SELECT COUNT(*) FROM edges e
            JOIN entities s ON s.id = e.source_id
            WHERE s.canonical_name = 'Rachel Smith' AND e.relation = 'authored'
            """
        ).fetchone()
        assert row[0] >= 1
    finally:
        conn.close()


def test_rerun_is_idempotent(mini_env):
    entities, edges = collect_entities(mini_env["vault"], mini_env["repo"])
    s1 = write_to_db(mini_env["db"], entities, edges)
    s2 = write_to_db(mini_env["db"], entities, edges)
    assert s1["entities_inserted"] == s2["entities_inserted"]
    assert s1["edges_inserted"] == s2["edges_inserted"]


def test_aliases_are_queryable(mini_env):
    entities, edges = collect_entities(mini_env["vault"], mini_env["repo"])
    write_to_db(mini_env["db"], entities, edges)

    conn = sqlite3.connect(mini_env["db"])
    try:
        # "SBA" alias should resolve to the Siletti dataset
        row = conn.execute(
            """
            SELECT e.canonical_name FROM entities e
            JOIN aliases a ON a.entity_id = e.id
            WHERE a.alias = 'SBA' AND a.entity_type = 'dataset'
            """
        ).fetchone()
        assert row is not None
        assert row[0] == "Siletti Brain Atlas"
    finally:
        conn.close()
