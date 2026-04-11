#!/usr/bin/env python3
"""Re-label paperpile wiki clusters using Claude.

Reads paper titles from each cluster, sends them to Claude for a concise
topic label, and updates the DB + INDEX.md. Much higher quality than the
Ollama phi4-mini labels generated during initial clustering.

Auth: reads CLAUDE_CODE_OAUTH_TOKEN from NanoClaw .env (no API key needed).

Usage:
    # Dry run — show proposed labels without updating
    python3 relabel.py --dry-run

    # Apply new labels and regenerate INDEX.md
    python3 relabel.py

    # Relabel specific clusters only
    python3 relabel.py --cluster-ids 8,21,26
"""

from __future__ import annotations

import argparse
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
DB_PATH = os.path.join(PROJECT_ROOT, 'store', 'paperpile.db')
OUTPUT_DIR = '/Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile'
ENV_PATH = os.path.join(PROJECT_ROOT, '.env')

if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)


def _load_oauth_from_env():
    """Read CLAUDE_CODE_OAUTH_TOKEN from NanoClaw .env into os.environ."""
    if os.environ.get('CLAUDE_CODE_OAUTH_TOKEN') or os.environ.get('ANTHROPIC_BASE_URL'):
        return  # Already set
    if not os.path.exists(ENV_PATH):
        return
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line.startswith('CLAUDE_CODE_OAUTH_TOKEN='):
                os.environ['CLAUDE_CODE_OAUTH_TOKEN'] = line.split('=', 1)[1]
                return


def main() -> None:
    parser = argparse.ArgumentParser(description="Re-label clusters with Claude.")
    parser.add_argument('--dry-run', action='store_true', help="Show labels without updating DB")
    parser.add_argument('--cluster-ids', type=str, help="Comma-separated cluster IDs to relabel (default: all)")
    parser.add_argument('--db', type=str, default=DB_PATH, help="Database path")
    args = parser.parse_args()

    if not args.dry_run:
        _load_oauth_from_env()
        if not (os.environ.get('CLAUDE_CODE_OAUTH_TOKEN')
                or os.environ.get('ANTHROPIC_BASE_URL')
                or os.environ.get('ANTHROPIC_API_KEY')):
            print("ERROR: No auth credentials found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_BASE_URL.",
                  file=sys.stderr)
            sys.exit(1)

    from db import get_db
    from clusterer import relabel_clusters_with_claude

    db = get_db(args.db)

    if args.cluster_ids:
        ids = [int(x.strip()) for x in args.cluster_ids.split(',')]
        print(f"Relabeling clusters: {ids}")

    print(f"{'[DRY RUN] ' if args.dry_run else ''}Relabeling clusters with Claude...\n")
    results = relabel_clusters_with_claude(db, dry_run=args.dry_run)

    print(f"\n{'Would relabel' if args.dry_run else 'Relabeled'} {len(results)} clusters.")

    if not args.dry_run:
        # Regenerate INDEX.md
        from cross_linker import generate_index_md
        from db import get_all_clusters, get_total_paper_count

        clusters = [dict(row) for row in get_all_clusters(db)]
        total_papers = get_total_paper_count(db)
        index_content = generate_index_md(clusters, total_papers=total_papers)

        os.makedirs(OUTPUT_DIR, exist_ok=True)
        index_path = os.path.join(OUTPUT_DIR, 'INDEX.md')
        with open(index_path, 'w', encoding='utf-8') as f:
            f.write(index_content)
        print(f"Regenerated {index_path}")

    db.close()


if __name__ == '__main__':
    main()
