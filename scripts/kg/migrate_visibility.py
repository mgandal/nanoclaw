#!/usr/bin/env python3
"""One-shot migration: add `visibility` column to entities and edges.

Adds `visibility TEXT NOT NULL DEFAULT 'main'` to both tables in
store/knowledge-graph.db (or the DB passed via --db), plus supporting
indexes. Idempotent — re-running is a no-op that prints `already exists`
for each table.

Part of C3/C20 resolution. See docs/superpowers/plans/2026-04-23-c3-c20-kg-provenance.md.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path


DEFAULT_DB = Path("store/knowledge-graph.db")
TABLES = ("entities", "edges")


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row[1] == column for row in rows)


def migrate(db_path: Path) -> int:
    if not db_path.exists():
        print(f"ERROR: DB not found at {db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(str(db_path))
    try:
        for table in TABLES:
            if column_exists(conn, table, "visibility"):
                print(f"{table}.visibility already exists")
                continue
            conn.execute(
                f"ALTER TABLE {table} ADD COLUMN visibility TEXT NOT NULL DEFAULT 'main'"
            )
            print(f"added {table}.visibility")

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_entities_visibility ON entities(visibility)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_edges_visibility ON edges(visibility)"
        )
        conn.commit()

        # Sanity: entity counts by visibility.
        print("entity counts by visibility:")
        for visibility, count in conn.execute(
            "SELECT visibility, COUNT(*) FROM entities GROUP BY visibility ORDER BY visibility"
        ).fetchall():
            print(f"  {visibility}: {count}")

        print("edge counts by visibility:")
        for visibility, count in conn.execute(
            "SELECT visibility, COUNT(*) FROM edges GROUP BY visibility ORDER BY visibility"
        ).fetchall():
            print(f"  {visibility}: {count}")
    finally:
        conn.close()

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        help=f"Path to the knowledge-graph SQLite DB (default: {DEFAULT_DB})",
    )
    args = parser.parse_args()
    return migrate(args.db)


if __name__ == "__main__":
    sys.exit(main())
