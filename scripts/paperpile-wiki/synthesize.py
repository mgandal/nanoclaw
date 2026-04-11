#!/usr/bin/env python3
"""Synthesis CLI orchestrator for paperpile-wiki pipeline.

Orchestrates the synthesis pipeline: for each cluster needing generation,
call synthesize_cluster(), write markdown files, cross-link, generate INDEX.md.

Usage:
    python3 synthesize.py                  # Synthesize all draft/stale clusters
    python3 synthesize.py --stale-only     # Only stale clusters
    python3 synthesize.py --dry-run        # Show what would be generated
    python3 synthesize.py --cluster-id 12  # Synthesize one specific cluster
    python3 synthesize.py --concurrency N  # Max concurrent API calls (default 1)
    python3 synthesize.py --db PATH        # Custom DB path
"""

from __future__ import annotations

import argparse
import os
import sys
import time

# ---------------------------------------------------------------------------
# Path setup — add this script's directory to sys.path so sibling modules load
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
DB_PATH = os.path.join(PROJECT_ROOT, 'store', 'paperpile.db')
OUTPUT_DIR = '/Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile'

if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)


# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------

def _build_papers_by_id(db) -> dict:
    """Build {paper_id: paper_dict} lookup from all papers in the DB."""
    rows = db.execute("SELECT * FROM papers").fetchall()
    result = {}
    for row in rows:
        paper = dict(row)
        # Index by primary id
        result[paper['id']] = paper
        # Also index by bibtex_key / citation key if present
        bibtex_key = paper.get('bibtex_key')
        if bibtex_key and bibtex_key not in result:
            result[bibtex_key] = paper
    return result


def _build_cluster_papers_map(db) -> dict[str, list[str]]:
    """Build {cluster_slug: [paper_id, ...]} for cross-linking."""
    clusters = db.execute("SELECT id, slug FROM clusters").fetchall()
    result = {}
    for cluster_row in clusters:
        slug = cluster_row['slug']
        if not slug:
            continue
        paper_rows = db.execute(
            "SELECT id FROM papers WHERE cluster_id = ?", (cluster_row['id'],)
        ).fetchall()
        result[slug] = [r['id'] for r in paper_rows]
    return result


# ---------------------------------------------------------------------------
# Single cluster processing
# ---------------------------------------------------------------------------

def process_one_cluster(client, db, cluster, papers_by_id: dict, dry_run: bool) -> tuple[str, float]:
    """Process a single cluster: synthesize, write file, update DB.

    Steps:
      1. Get papers for cluster from DB
      2. If dry_run: print info, return (slug, 0.0)
      3. Save previous version to synthesis_history (if exists)
      4. Call synthesize_cluster()
      5. Write markdown to OUTPUT_DIR/{slug}.md
      6. Update synthesis_pages table (upsert_synthesis_page)
      7. Record citations in paper_synthesis table
      8. Mark papers as incorporated (is_new=0)
      9. Print summary
      10. Return (slug, cost)

    Returns:
        (slug, cost_usd)
    """
    from db import (
        get_papers_by_cluster,
        upsert_synthesis_page,
        save_synthesis_history,
        record_paper_synthesis,
        mark_papers_incorporated,
    )
    from synthesizer import synthesize_cluster, extract_citations

    cluster_id = cluster['id']
    slug = cluster['slug'] or f'cluster-{cluster_id}'
    cluster_name = cluster['name'] or f'Cluster {cluster_id}'

    # Step 1: Get papers for this cluster
    paper_rows = get_papers_by_cluster(db, cluster_id)
    papers = [dict(row) for row in paper_rows]

    if dry_run:
        # Step 2: dry run — just print info and return
        new_count = sum(1 for p in papers if p.get('is_new', 0))
        print(f"[dry-run] {slug}: {len(papers)} papers ({new_count} new)")
        return (slug, 0.0)

    # Step 3: Save previous synthesis version to history (if exists)
    existing_synthesis = db.execute(
        "SELECT * FROM synthesis_pages WHERE cluster_id = ?", (cluster_id,)
    ).fetchone()

    if existing_synthesis:
        existing_path = existing_synthesis['file_path']
        if existing_path and os.path.exists(existing_path):
            try:
                with open(existing_path, 'r', encoding='utf-8') as f:
                    old_content = f.read()
                save_synthesis_history(
                    db,
                    synthesis_id=existing_synthesis['id'],
                    content=old_content,
                    generated_at=existing_synthesis['last_generated'],
                )
                db.commit()
            except OSError:
                pass  # File read failure is non-fatal

    # Step 4: Call synthesize_cluster()
    t0 = time.time()
    cluster_dict = dict(cluster)
    markdown, cost = synthesize_cluster(client, cluster_dict, papers, papers_by_id)
    elapsed = time.time() - t0

    # Step 5: Write markdown to OUTPUT_DIR/{slug}.md
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, f'{slug}.md')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(markdown)

    # Step 6: Update synthesis_pages table
    synthesis_record = {
        'cluster_id': cluster_id,
        'file_path': out_path,
        'status': 'current',
        'last_generated': _now_utc(),
        'paper_count_at_generation': len(papers),
        'generation_cost_usd': cost,
    }
    if existing_synthesis:
        synthesis_record['id'] = existing_synthesis['id']

    synthesis_id = upsert_synthesis_page(db, synthesis_record)
    db.commit()

    # Step 7: Record citations in paper_synthesis table
    cited_keys = extract_citations(markdown)
    for key in cited_keys:
        # Look up paper_id from papers_by_id
        paper = papers_by_id.get(key)
        if paper:
            try:
                record_paper_synthesis(db, paper['id'], synthesis_id)
            except Exception:
                pass  # Non-fatal
    db.commit()

    # Step 8: Mark papers as incorporated (is_new=0)
    paper_ids = [p['id'] for p in papers]
    mark_papers_incorporated(db, paper_ids)
    db.commit()

    # Step 9: Print summary
    print(f"[synthesize] {slug}: {len(papers)} papers, ${cost:.4f}, {elapsed:.1f}s → {out_path}")

    # Step 10: Return
    return (slug, cost)


# ---------------------------------------------------------------------------
# Cross-linking pass
# ---------------------------------------------------------------------------

def run_cross_linking(db) -> None:
    """Build cluster_papers map, find cross_links, inject wikilinks into files."""
    from cross_linker import find_cross_links, inject_wikilinks

    print("[cross-link] Building cluster-papers map...")
    cluster_papers = _build_cluster_papers_map(db)

    # Build slug → name mapping
    clusters = db.execute("SELECT slug, name FROM clusters").fetchall()
    slug_to_name = {row['slug']: (row['name'] or row['slug']) for row in clusters if row['slug']}

    # Find pairs that should be cross-linked
    pairs = find_cross_links(cluster_papers)
    if not pairs:
        print("[cross-link] No cross-links found.")
        return

    print(f"[cross-link] Found {len(pairs)} cross-link pairs.")

    # Build per-slug related slugs
    related: dict[str, list[str]] = {}
    for slug_a, slug_b in pairs:
        related.setdefault(slug_a, []).append(slug_b)
        related.setdefault(slug_b, []).append(slug_a)

    injected = 0
    for slug, related_slugs in related.items():
        file_path = os.path.join(OUTPUT_DIR, f'{slug}.md')
        if not os.path.exists(file_path):
            continue
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                text = f.read()
            updated = inject_wikilinks(text, related_slugs, slug_to_name)
            if updated != text:
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(updated)
                injected += 1
        except OSError as e:
            print(f"[cross-link] WARNING: could not update {file_path}: {e}")

    print(f"[cross-link] Injected wikilinks into {injected} files.")


# ---------------------------------------------------------------------------
# INDEX.md generation
# ---------------------------------------------------------------------------

def run_index_generation(db) -> None:
    """Generate INDEX.md from cluster data and write to OUTPUT_DIR."""
    from cross_linker import generate_index_md
    from db import get_all_clusters, get_total_paper_count

    print("[index] Generating INDEX.md...")
    clusters = [dict(row) for row in get_all_clusters(db)]
    total_papers = get_total_paper_count(db)

    index_content = generate_index_md(clusters, total_papers=total_papers)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    index_path = os.path.join(OUTPUT_DIR, 'INDEX.md')
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(index_content)
    print(f"[index] Wrote {index_path}")


# ---------------------------------------------------------------------------
# Timestamp helper
# ---------------------------------------------------------------------------

def _now_utc() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Synthesize paperpile wiki pages from clustered papers.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 synthesize.py                  # Synthesize all draft/stale clusters
  python3 synthesize.py --stale-only     # Only stale clusters
  python3 synthesize.py --dry-run        # Show what would be generated
  python3 synthesize.py --cluster-id 12  # Synthesize one specific cluster
  python3 synthesize.py --concurrency 3  # Up to 3 concurrent API calls
  python3 synthesize.py --db /path/to/db # Custom DB path
""",
    )
    parser.add_argument('--stale-only', action='store_true',
                        help='Only re-synthesize clusters with stale synthesis pages')
    parser.add_argument('--dry-run', action='store_true',
                        help='Show what would be generated without making API calls')
    parser.add_argument('--cluster-id', type=int, metavar='ID',
                        help='Synthesize one specific cluster by ID')
    parser.add_argument('--concurrency', type=int, default=1, metavar='N',
                        help='Max concurrent API calls (default: 1)')
    parser.add_argument('--db', metavar='PATH', default=DB_PATH,
                        help=f'Path to SQLite database (default: {DB_PATH})')

    args = parser.parse_args()

    # Step 2: Check ANTHROPIC_BASE_URL env var
    if not args.dry_run and not os.environ.get('ANTHROPIC_BASE_URL'):
        print(
            "ERROR: ANTHROPIC_BASE_URL is not set.\n"
            "This script routes through the credential proxy. Set ANTHROPIC_BASE_URL\n"
            "to the proxy endpoint before running synthesis (not needed for --dry-run).",
            file=sys.stderr,
        )
        sys.exit(1)

    # Step 3: Init Claude client (or None for dry-run)
    client = None
    if not args.dry_run:
        try:
            import anthropic
            client = anthropic.Anthropic()
        except ImportError:
            print("ERROR: 'anthropic' package not installed. Run: pip install anthropic",
                  file=sys.stderr)
            sys.exit(1)

    # Import DB layer (deferred so --help works even without deps)
    from db import get_db, get_stale_syntheses, get_cluster, get_all_clusters

    db = get_db(args.db)

    # Step 4: Determine target clusters
    if args.cluster_id is not None:
        # Single specific cluster
        cluster_row = get_cluster(db, args.cluster_id)
        if cluster_row is None:
            print(f"ERROR: Cluster {args.cluster_id} not found in database.", file=sys.stderr)
            db.close()
            sys.exit(1)
        target_clusters = [cluster_row]
        print(f"[synthesize] Target: cluster {args.cluster_id} ({cluster_row['name']})")

    elif args.stale_only:
        # Only stale synthesis pages
        stale_rows = get_stale_syntheses(db)
        stale_cluster_ids = {row['cluster_id'] for row in stale_rows}
        all_clusters = get_all_clusters(db)
        target_clusters = [c for c in all_clusters if c['id'] in stale_cluster_ids]
        print(f"[synthesize] Target: {len(target_clusters)} stale clusters")

    else:
        # All clusters needing synthesis: draft/stale + clusters without synthesis pages
        all_clusters = get_all_clusters(db)

        # Get cluster IDs that already have a 'current' synthesis page
        current_ids_rows = db.execute(
            "SELECT cluster_id FROM synthesis_pages WHERE status = 'current'"
        ).fetchall()
        current_ids = {row['cluster_id'] for row in current_ids_rows}

        # Get cluster IDs with stale/draft status
        needs_regen_rows = db.execute(
            "SELECT cluster_id FROM synthesis_pages WHERE status IN ('draft', 'stale')"
        ).fetchall()
        needs_regen_ids = {row['cluster_id'] for row in needs_regen_rows}

        target_clusters = [
            c for c in all_clusters
            if c['id'] not in current_ids or c['id'] in needs_regen_ids
        ]
        print(f"[synthesize] Target: {len(target_clusters)} clusters "
              f"(out of {len(all_clusters)} total)")

    if not target_clusters:
        print("[synthesize] Nothing to do.")
        db.close()
        return

    if args.dry_run:
        print(f"[dry-run] Would synthesize {len(target_clusters)} clusters:")

    # Build papers_by_id lookup (shared across all clusters)
    papers_by_id = _build_papers_by_id(db)

    # Step 5: Process each cluster (sequentially — concurrency > 1 reserved for future)
    # NOTE: --concurrency > 1 is accepted but currently runs sequentially.
    # Parallel execution would require thread-safe DB connections and is deferred.
    if args.concurrency > 1 and not args.dry_run:
        print(f"[synthesize] NOTE: --concurrency {args.concurrency} accepted; "
              f"currently runs sequentially (parallel support planned).")

    t_start = time.time()
    total_cost = 0.0
    processed = []

    for cluster in target_clusters:
        slug, cost = process_one_cluster(
            client=client,
            db=db,
            cluster=cluster,
            papers_by_id=papers_by_id,
            dry_run=args.dry_run,
        )
        processed.append(slug)
        total_cost += cost

    # Step 6: Run cross-linking (if not dry-run)
    if not args.dry_run and processed:
        run_cross_linking(db)

    # Step 7: Generate INDEX.md
    run_index_generation(db)

    # Step 8: Report total cost and time
    elapsed = time.time() - t_start
    print(
        f"\n[done] Processed {len(processed)} clusters in {elapsed:.1f}s"
        + (f", total cost: ${total_cost:.4f}" if not args.dry_run else " (dry run)")
    )

    db.close()


if __name__ == '__main__':
    main()
