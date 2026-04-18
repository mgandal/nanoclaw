#!/usr/bin/env python3
"""Knowledge Graph Layer 5 — Phase 1 deterministic seed.

Parses structured sources (vault frontmatter, state files) into
store/knowledge-graph.db. No LLM, no network, fully deterministic.

Usage:
    python3 scripts/kg/ingest_phase1.py
    python3 scripts/kg/ingest_phase1.py --vault /path/to/vault --db /path/to.db
    python3 scripts/kg/ingest_phase1.py --dry-run

Exit 0 on success with a summary written to stdout. See the spec at
docs/superpowers/specs/2026-04-14-knowledge-graph-layer5-design.md
for context and the Phase 2/3/4 pipeline that follows.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Make `kg.parsers` importable whether we're run from the repo root or
# invoked as a module.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kg.parsers import (  # noqa: E402
    extract_paper_stubs,
    normalize_reference,
    parse_contact,
    parse_dataset,
    parse_grants_file,
    parse_lab_roster,
    parse_paper,
    parse_projects_file,
    parse_tool,
)


DEFAULT_VAULT = Path("/Volumes/sandisk4TB/marvin-vault")
DEFAULT_REPO = Path(__file__).resolve().parents[2]
DEFAULT_DB = DEFAULT_REPO / "store" / "knowledge-graph.db"
SCHEMA_FILE = Path(__file__).with_name("schema.sql")
STATE_DIR_REL = Path("groups/global/state")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def collect_entities(vault: Path, repo_root: Path) -> tuple[list[dict], list[dict]]:
    """Walk the vault + state files, return (entities, edges).

    Entities may be returned multiple times for the same canonical name from
    different sources — the insert step deduplicates by (type, canonical_name).
    """
    # Two-pass: first collect per-parser results, then derive paper stubs
    # from any citations that target papers we don't already have.
    all_results: list[dict] = []

    # Contacts → persons
    contacts_dir = vault / "20-contacts"
    if contacts_dir.is_dir():
        for f in sorted(contacts_dir.glob("*.md")):
            if f.name.startswith("_"):  # skip _README.md, _template.md
                continue
            text = _read(f)
            if text is None:
                continue
            result = parse_contact(text, f"20-contacts/{f.name}")
            if result:
                all_results.append(result)

    # Tools
    tools_dir = vault / "99-wiki" / "tools"
    if tools_dir.is_dir():
        for f in sorted(tools_dir.glob("*.md")):
            if f.name.startswith("_"):
                continue
            text = _read(f)
            if text is None:
                continue
            result = parse_tool(text, f"99-wiki/tools/{f.name}")
            if result:
                all_results.append(result)

    # Datasets
    datasets_dir = vault / "99-wiki" / "datasets"
    if datasets_dir.is_dir():
        for f in sorted(datasets_dir.glob("*.md")):
            if f.name.startswith("_"):
                continue
            text = _read(f)
            if text is None:
                continue
            result = parse_dataset(text, f"99-wiki/datasets/{f.name}")
            if result:
                all_results.append(result)

    # Papers
    papers_dir = vault / "99-wiki" / "papers"
    if papers_dir.is_dir():
        for f in sorted(papers_dir.glob("*.md")):
            if f.name.startswith("_"):
                continue
            text = _read(f)
            if text is None:
                continue
            result = parse_paper(text, f"99-wiki/papers/{f.name}")
            if result:
                all_results.append(result)

    # State: grants
    grants_file = repo_root / STATE_DIR_REL / "grants.md"
    text = _read(grants_file)
    if text:
        all_results.extend(parse_grants_file(text, "state/grants.md"))

    # State: projects
    projects_file = repo_root / STATE_DIR_REL / "projects.md"
    text = _read(projects_file)
    if text:
        all_results.extend(parse_projects_file(text, "state/projects.md"))

    # State: lab-roster (cross-ref; contacts may already have these)
    roster_file = repo_root / STATE_DIR_REL / "lab-roster.md"
    text = _read(roster_file)
    if text:
        all_results.extend(parse_lab_roster(text, "state/lab-roster.md"))

    # --- Phase 1.5: derive paper stubs from citation references ---
    # Collect already-known paper aliases so extract_paper_stubs skips
    # references that would collide with a real YAML-backed paper.
    known_paper_aliases: set[tuple[str, str]] = set()
    for r in all_results:
        ent = r.get("entity") or {}
        if ent.get("type") == "paper":
            known_paper_aliases.add(("paper", ent["canonical_name"]))
            for a in ent.get("aliases") or []:
                known_paper_aliases.add(("paper", a))

    stubs = extract_paper_stubs(all_results, known_paper_aliases=known_paper_aliases)
    all_results.extend(stubs)

    # Flatten.
    entities: list[dict] = []
    edges: list[dict] = []
    for r in all_results:
        if r.get("entity"):
            entities.append(r["entity"])
        if r.get("edges"):
            edges.extend(r["edges"])

    return entities, edges


def write_to_db(db_path: Path, entities: list[dict], edges: list[dict]) -> dict:
    """Idempotent-ish write: clears tables and re-seeds. Since this is Phase 1
    and the DB is derived purely from source files, a full rewrite matches the
    source-of-truth semantics. Non-Phase-1 rows (agent_contributions, ollama
    extractions) will live in different tables or have a different created_by,
    so this does NOT touch them in future phases.

    Returns a summary dict.
    """
    if not SCHEMA_FILE.is_file():
        raise FileNotFoundError(f"schema.sql not found at {SCHEMA_FILE}")

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA_FILE.read_text(encoding="utf-8"))
        # Clear only Phase 1-owned rows
        conn.execute("DELETE FROM aliases WHERE source IN ('vault','state','generated')")
        conn.execute(
            "DELETE FROM edges WHERE created_by = 'bulk_ingest'"
        )
        # Phase 1 rewrites the full review queue for its own bulk_ingest pass.
        # Resolved items (resolution IS NOT NULL) are preserved.
        conn.execute("DELETE FROM review_queue WHERE resolution IS NULL")
        conn.execute(
            "DELETE FROM entities WHERE id IN (SELECT entity_id FROM aliases WHERE source IN ('vault','state','generated'))"
        )
        # If a fresh run, the entities table may still have rows without aliases;
        # delete anything that has no alias left (orphaned from prior runs).
        conn.execute(
            "DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM aliases)"
        )
        conn.commit()

        summary: dict = {
            "entities_seen": len(entities),
            "edges_seen": len(edges),
            "entities_inserted": 0,
            "entities_merged": 0,
            "edges_inserted": 0,
            "edges_skipped_unresolved": 0,
            "by_type": {},
        }

        # Deduplicate by (type, canonical_name). First-seen wins for metadata.
        # Aliases from later occurrences are still added.
        key_to_id: dict[tuple[str, str], str] = {}

        now = _now()
        for ent in entities:
            canonical = ent["canonical_name"].strip()
            etype = ent["type"]
            key = (etype, canonical)
            if key in key_to_id:
                summary["entities_merged"] += 1
                entity_id = key_to_id[key]
            else:
                entity_id = str(uuid.uuid4())
                key_to_id[key] = entity_id
                conn.execute(
                    """
                    INSERT INTO entities
                        (id, canonical_name, type, metadata, source_doc,
                         confidence, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entity_id,
                        canonical,
                        etype,
                        json.dumps(ent.get("metadata") or {}),
                        ent.get("source_doc"),
                        float(ent.get("confidence", 1.0)),
                        now,
                        now,
                    ),
                )
                summary["entities_inserted"] += 1
                summary["by_type"][etype] = summary["by_type"].get(etype, 0) + 1

            # Insert aliases — unique by (alias, type, entity_id)
            for alias in ent.get("aliases") or []:
                alias = alias.strip()
                if not alias:
                    continue
                try:
                    conn.execute(
                        "INSERT OR IGNORE INTO aliases (alias, entity_type, entity_id, source) VALUES (?, ?, ?, ?)",
                        (alias, etype, entity_id, "vault"),
                    )
                except sqlite3.Error:
                    pass

        # Resolve edges. Require both endpoints exist by (type, name) OR alias.
        # Unresolvable edges are parked in review_queue so they are not lost —
        # Phase 2 / 3 fills in the missing target entities.
        for edge in edges:
            src_id = _resolve(conn, edge["source_type"], edge["source"])
            tgt_id = _resolve(conn, edge["target_type"], edge["target"])
            if not src_id or not tgt_id:
                summary["edges_skipped_unresolved"] += 1
                conn.execute(
                    """
                    INSERT INTO review_queue
                        (id, candidate_a, candidate_b, entity_type, context,
                         resolution, resolved_by, created_at, resolved_at)
                    VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)
                    """,
                    (
                        str(uuid.uuid4()),
                        f"{edge['source']} ({edge['source_type']})",
                        f"{edge['target']} ({edge['target_type']})",
                        edge["target_type"] if not tgt_id else edge["source_type"],
                        f"Unresolved {edge['relation']} edge from {edge.get('source_doc','')}: missing {'target' if not tgt_id else 'source'}",
                        now,
                    ),
                )
                continue
            conn.execute(
                """
                INSERT INTO edges
                    (id, source_id, target_id, relation, evidence, source_doc,
                     confidence, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    src_id,
                    tgt_id,
                    edge["relation"],
                    edge.get("evidence"),
                    edge.get("source_doc"),
                    1.0,
                    "bulk_ingest",
                    now,
                ),
            )
            summary["edges_inserted"] += 1

        conn.commit()
        return summary
    finally:
        conn.close()


def _resolve(conn: sqlite3.Connection, entity_type: str, name: str) -> str | None:
    """Resolve an entity reference to an ID.

    Three tiers, fail-closed per tier:
      1. Exact canonical_name match within the given type.
      2. Exact alias match within the given type.
      3. Normalized-reference fallback: strip common path prefixes, lowercase,
         and match against any alias whose normalized form is equal.
    """
    row = conn.execute(
        "SELECT id FROM entities WHERE type = ? AND canonical_name = ?",
        (entity_type, name),
    ).fetchone()
    if row:
        return row[0]
    row = conn.execute(
        "SELECT entity_id FROM aliases WHERE entity_type = ? AND alias = ? LIMIT 1",
        (entity_type, name),
    ).fetchone()
    if row:
        return row[0]

    normalized = normalize_reference(name)
    if not normalized:
        return None
    # Try lowercase alias match on canonical_name and aliases within type.
    # We compute the normalized form in Python and compare against LOWER(alias).
    # This is O(N per type) but N is small here; indexes on (entity_type) help.
    for table, col_id, col_text in (
        ("entities", "id", "canonical_name"),
        ("aliases", "entity_id", "alias"),
    ):
        scope_col = "type" if table == "entities" else "entity_type"
        candidates = conn.execute(
            f"SELECT {col_id}, {col_text} FROM {table} WHERE {scope_col} = ?",
            (entity_type,),
        ).fetchall()
        for cand_id, cand_text in candidates:
            if normalize_reference(cand_text) == normalized:
                return cand_id
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_REPO)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse everything but do not write the DB. Prints the summary only.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit summary as JSON instead of human-readable text.",
    )
    args = parser.parse_args(argv)

    if not args.vault.is_dir():
        print(f"ERROR: vault not found at {args.vault}", file=sys.stderr)
        return 2

    entities, edges = collect_entities(args.vault, args.repo_root)

    if args.dry_run:
        summary = {
            "entities_seen": len(entities),
            "edges_seen": len(edges),
            "by_type": {},
            "dry_run": True,
        }
        for e in entities:
            t = e["type"]
            summary["by_type"][t] = summary["by_type"].get(t, 0) + 1
        _report(summary, args.json)
        return 0

    summary = write_to_db(args.db, entities, edges)
    summary["db_path"] = str(args.db)
    _report(summary, args.json)
    return 0


def _report(summary: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(summary, indent=2, sort_keys=True))
        return
    print("KG Phase 1 ingest summary")
    print(f"  entities seen:     {summary['entities_seen']}")
    if "entities_inserted" in summary:
        print(f"  entities inserted: {summary['entities_inserted']}")
        print(f"  entities merged:   {summary['entities_merged']}")
    print(f"  edges seen:        {summary['edges_seen']}")
    if "edges_inserted" in summary:
        print(f"  edges inserted:    {summary['edges_inserted']}")
        print(f"  edges unresolved:  {summary['edges_skipped_unresolved']}")
    print("  by type:")
    for t, n in sorted(summary.get("by_type", {}).items()):
        print(f"    {t:12s} {n}")
    if "db_path" in summary:
        print(f"  wrote: {summary['db_path']}")


if __name__ == "__main__":
    raise SystemExit(main())
