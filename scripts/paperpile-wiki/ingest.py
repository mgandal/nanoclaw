#!/usr/bin/env python3
"""Ingest CLI orchestrator for paperpile-wiki pipeline.

Orchestrates the full ingest pipeline:
  1. Parse BibTeX → upsert papers into DB
  2. Match PDFs → update pdf_path in DB
  3. Embed with SPECTER2 → update embeddings in DB
  4. Cluster with BERTopic → write clusters + assignments to DB
  5. Relabel clusters with Claude → higher-quality topic names
  6. Summarize PDFs with local LLM → fulltext embeddings (optional)

Usage:
    python3 ingest.py                      # Full ingest (first run or re-embed all)
    python3 ingest.py --incremental        # Only new papers, assign to existing clusters
    python3 ingest.py --full-recluster     # Re-cluster entire corpus
    python3 ingest.py --skip-pdf           # Skip PDF matching
    python3 ingest.py --skip-relabel       # Keep Ollama labels (no Claude API call)
    python3 ingest.py --bib PATH           # Custom BibTeX path
    python3 ingest.py --db PATH            # Custom DB path
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
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
DB_PATH = os.path.join(PROJECT_ROOT, "store", "paperpile.db")
BIB_PATH = os.path.expanduser("~/.hermes/paperpile.bib")

if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

# ---------------------------------------------------------------------------
# Module imports — deferred so --help works even if heavy deps are missing
# ---------------------------------------------------------------------------

def _import_pipeline_modules():
    """Import pipeline modules. Called lazily at runtime (not at module load)."""
    global init_db, get_db, upsert_paper, get_papers_missing_embeddings
    global update_paper_embedding, update_paper_cluster, upsert_cluster
    global get_total_paper_count, get_all_clusters, mark_synthesis_stale
    global get_new_paper_count_for_cluster
    global parse_bib_file
    global match_papers_to_pdfs
    global embed_papers, bytes_to_embedding, embedding_to_bytes
    global cluster_papers, assign_noise_to_nearest, assign_new_papers_to_clusters
    global slugify, build_hierarchy, _compute_centroids, relabel_clusters_with_claude
    global batch_summarize, embed_summaries

    from db import (
        init_db,
        get_db,
        upsert_paper,
        get_papers_missing_embeddings,
        update_paper_embedding,
        update_paper_cluster,
        upsert_cluster,
        get_total_paper_count,
        get_all_clusters,
        mark_synthesis_stale,
        get_new_paper_count_for_cluster,
    )
    from bibtex_parser import parse_bib_file
    from pdf_matcher import match_papers_to_pdfs
    from summarizer import batch_summarize, embed_summaries
    from embedder import embed_papers, bytes_to_embedding, embedding_to_bytes
    from clusterer import (
        cluster_papers,
        assign_noise_to_nearest,
        assign_new_papers_to_clusters,
        slugify,
        build_hierarchy,
        _compute_centroids,
        relabel_clusters_with_claude,
    )


# ---------------------------------------------------------------------------
# Stage helpers
# ---------------------------------------------------------------------------

def run_parse(db, bib_path: str) -> int:
    """Parse BibTeX, upsert papers into DB.

    Checks file stability: if the file's mtime changes within 1 second of
    reading (i.e. it's still being written), waits up to 60 seconds for it
    to stabilise before parsing.

    Returns the number of newly inserted papers (is_new=1 after upsert).
    """
    print(f"[parse] Reading {bib_path} ...")

    # File stability check
    if not os.path.exists(bib_path):
        print(f"[parse] ERROR: BibTeX file not found: {bib_path}")
        return 0

    mtime_before = os.path.getmtime(bib_path)
    time.sleep(1)
    mtime_after = os.path.getmtime(bib_path)

    if mtime_before != mtime_after:
        print("[parse] File is still being written — waiting up to 60s for it to stabilise...")
        deadline = time.time() + 60
        while time.time() < deadline:
            time.sleep(2)
            mtime_now = os.path.getmtime(bib_path)
            if mtime_now == mtime_after:
                break
            mtime_after = mtime_now
        else:
            print("[parse] WARNING: File still unstable after 60s, proceeding anyway.")

    papers = parse_bib_file(bib_path)
    print(f"[parse] Parsed {len(papers)} papers from BibTeX.")

    # Count papers before upsert
    before_count = get_total_paper_count(db)

    for paper in papers:
        upsert_paper(db, paper)
    db.commit()

    after_count = get_total_paper_count(db)
    new_count = after_count - before_count
    print(f"[parse] Upserted {len(papers)} papers; {new_count} net new.")
    return new_count


def run_pdf_match(db, papers: list) -> int:
    """Match PDFs to papers and update pdf_path in DB.

    Returns the number of papers that got a PDF path assigned.
    """
    print(f"[pdf] Matching PDFs for {len(papers)} papers ...")
    matches = match_papers_to_pdfs(papers)

    updated = 0
    for paper_id, pdf_path in matches.items():
        db.execute(
            "UPDATE papers SET pdf_path = ?, updated_at = datetime('now') WHERE id = ?",
            (pdf_path, paper_id),
        )
        updated += 1

    db.commit()
    print(f"[pdf] Matched {updated} PDFs.")
    return updated


def run_embed(db) -> int:
    """Embed papers that are missing embeddings.

    Returns the number of papers embedded.
    """
    missing = get_papers_missing_embeddings(db)
    if not missing:
        print("[embed] No papers missing embeddings.")
        return 0

    print(f"[embed] Embedding {len(missing)} papers with SPECTER2...")
    paper_dicts = [dict(row) for row in missing]
    embeddings = embed_papers(paper_dicts)

    for paper_id, emb_bytes in embeddings.items():
        update_paper_embedding(db, paper_id, emb_bytes)

    db.commit()
    print(f"[embed] Embedded {len(embeddings)} papers.")
    return len(embeddings)


def run_cluster(db, full_recluster: bool = False) -> int:
    """Run clustering.

    Incremental mode (existing clusters + not full_recluster):
      - Get new papers (is_new=1) with embeddings
      - Load existing cluster centroids from DB
      - Assign new papers via assign_new_papers_to_clusters
      - Update paper cluster assignments in DB
      - Update cluster paper_count
      - Detect stale clusters (gained ≥3 new papers → mark_synthesis_stale)
      Returns the number of existing clusters.

    Full mode (no existing clusters OR full_recluster=True):
      - Load ALL embeddings from DB
      - Run cluster_papers()
      - Compute centroids, reassign noise, recompute centroids
      - Get topic labels from topic_model.get_topic_info() + LLM aspects
      - Build hierarchy, write clusters + assignments to DB
      Returns the number of clusters created.
    """
    import numpy as np

    existing_clusters = get_all_clusters(db)
    is_incremental = len(existing_clusters) > 0 and not full_recluster

    if is_incremental:
        return _run_incremental_cluster(db, existing_clusters)
    else:
        return _run_full_cluster(db)


def _run_incremental_cluster(db, existing_clusters) -> int:
    """Assign new papers to existing clusters."""
    import numpy as np

    print(f"[cluster] Incremental mode: {len(existing_clusters)} existing clusters.")

    # Load new papers with embeddings
    new_papers = db.execute(
        "SELECT id, embedding FROM papers WHERE is_new = 1 AND embedding IS NOT NULL"
    ).fetchall()

    if not new_papers:
        print("[cluster] No new papers with embeddings to assign.")
        return len(existing_clusters)

    print(f"[cluster] Assigning {len(new_papers)} new papers to existing clusters...")

    # Build centroid dict from DB (cluster.centroid is stored as bytes)
    centroids = {}
    for cluster in existing_clusters:
        if cluster["centroid"] is not None:
            centroids[cluster["id"]] = np.array(
                bytes_to_embedding(cluster["centroid"]), dtype=np.float32
            )

    if not centroids:
        print("[cluster] WARNING: No centroids found in existing clusters — skipping assignment.")
        return len(existing_clusters)

    # Build embedding matrix for new papers
    paper_ids = [row["id"] for row in new_papers]
    new_embeddings = np.array(
        [bytes_to_embedding(row["embedding"]) for row in new_papers],
        dtype=np.float32,
    )

    # Assign
    assignments = assign_new_papers_to_clusters(new_embeddings, centroids)

    # Track how many new papers landed in each cluster
    cluster_new_count: dict[int, int] = {}
    for paper_id, (cluster_id, confidence) in zip(paper_ids, assignments):
        update_paper_cluster(db, paper_id, cluster_id, confidence)
        cluster_new_count[cluster_id] = cluster_new_count.get(cluster_id, 0) + 1

    db.commit()

    # Update paper_count for affected clusters and detect stale syntheses
    stale_count = 0
    for cluster_id, n_new in cluster_new_count.items():
        # Recount from DB
        row = db.execute(
            "SELECT COUNT(*) FROM papers WHERE cluster_id = ?", (cluster_id,)
        ).fetchone()
        new_total = row[0]
        db.execute(
            "UPDATE clusters SET paper_count = ?, updated_at = datetime('now') WHERE id = ?",
            (new_total, cluster_id),
        )

        # Mark synthesis stale if cluster gained ≥3 new papers
        if n_new >= 3:
            synth = db.execute(
                "SELECT id FROM synthesis_pages WHERE cluster_id = ?", (cluster_id,)
            ).fetchone()
            if synth:
                mark_synthesis_stale(db, synth["id"])
                stale_count += 1

    db.commit()

    print(
        f"[cluster] Assigned {len(paper_ids)} papers; "
        f"{stale_count} synthesis pages marked stale."
    )
    return len(existing_clusters)


def _run_full_cluster(db) -> int:
    """Full re-cluster of entire corpus."""
    import numpy as np

    print("[cluster] Full clustering mode.")

    # Clean old cluster data before re-clustering
    old_count = db.execute("SELECT COUNT(*) FROM clusters").fetchone()[0]
    if old_count > 0:
        print(f"[cluster] Removing {old_count} old clusters...")
        db.execute("DELETE FROM paper_synthesis")
        db.execute("DELETE FROM synthesis_history")
        db.execute("DELETE FROM synthesis_pages")
        db.execute("UPDATE papers SET cluster_id = NULL, cluster_confidence = 1.0")
        db.execute("DELETE FROM clusters")
        db.commit()

    # Load all papers with embeddings
    rows = db.execute(
        "SELECT id, abstract, embedding FROM papers WHERE embedding IS NOT NULL"
    ).fetchall()

    if not rows:
        print("[cluster] No papers with embeddings found — skipping clustering.")
        return 0

    print(f"[cluster] Loaded {len(rows)} papers for clustering.")

    paper_ids = [row["id"] for row in rows]
    abstracts = [row["abstract"] or "" for row in rows]
    embeddings = np.array(
        [bytes_to_embedding(row["embedding"]) for row in rows],
        dtype=np.float32,
    )

    # Run BERTopic
    print("[cluster] Running BERTopic (UMAP + HDBSCAN + Ollama labeling)...")
    topic_model, topics, probs = cluster_papers(abstracts, embeddings)

    # Compute centroids
    centroids = _compute_centroids(embeddings, topics)

    # Reassign noise to nearest centroid
    topics, confidences = assign_noise_to_nearest(topics, embeddings, centroids)

    # Recompute centroids after noise reassignment
    centroids = _compute_centroids(embeddings, topics)

    # Get topic labels from BERTopic
    topic_info = topic_model.get_topic_info()
    # topic_info has columns: Topic, Count, Name, (optionally LLM)
    llm_aspects = {}
    if hasattr(topic_model, "topic_aspects_") and topic_model.topic_aspects_:
        llm_aspects = topic_model.topic_aspects_.get("LLM", {})

    # Build name lookup: topic_id → label
    topic_name_map: dict[int, str] = {}
    for _, info_row in topic_info.iterrows():
        t_id = int(info_row["Topic"])
        if t_id == -1:
            continue
        # Prefer LLM label if available
        if t_id in llm_aspects and llm_aspects[t_id]:
            label_raw = llm_aspects[t_id]
            # LLM aspects may be a list of (label, score) tuples or just a string
            if isinstance(label_raw, list) and label_raw:
                first = label_raw[0]
                label = first[0] if isinstance(first, (list, tuple)) else str(first)
            else:
                label = str(label_raw)
        else:
            label = str(info_row["Name"])
        # Strip BERTopic's "N_" prefix from labels (e.g. "0_RNA-seq..." → "RNA-seq...")
        import re
        label = re.sub(r'^\d+_', '', label).strip().strip('"').strip("'")
        topic_name_map[t_id] = label

    # Build hierarchy
    print("[cluster] Building topic hierarchy...")
    hierarchy = build_hierarchy(topic_model, abstracts)
    # hierarchy is list of {"parent_id": int, "child_id": int}
    # Build child → parent mapping (use lowest-level relationships)
    child_to_parent: dict[int, int] = {}
    for rel in hierarchy:
        child_to_parent[rel["child_id"]] = rel["parent_id"]

    # Count papers per topic
    from collections import Counter
    topic_counts = Counter(topics)

    # Write clusters to DB
    unique_topic_ids = sorted(set(t for t in topics if t != -1))
    print(f"[cluster] Writing {len(unique_topic_ids)} clusters to DB...")

    # First pass: insert clusters without parent_id (parent may not exist yet)
    db_cluster_id_map: dict[int, int] = {}  # BERTopic topic_id → DB cluster id
    for topic_id in unique_topic_ids:
        label = topic_name_map.get(topic_id, f"Topic {topic_id}")
        slug = slugify(label)
        centroid_bytes = embedding_to_bytes(centroids[topic_id]) if topic_id in centroids else None
        paper_count = topic_counts.get(topic_id, 0)

        cluster_db_id = upsert_cluster(db, {
            "name": label,
            "slug": slug,
            "centroid": centroid_bytes,
            "paper_count": paper_count,
            # parent_id set in second pass
        })
        db_cluster_id_map[topic_id] = cluster_db_id

    db.commit()

    # Second pass: set parent_id relationships
    for topic_id, db_id in db_cluster_id_map.items():
        parent_topic_id = child_to_parent.get(topic_id)
        if parent_topic_id is not None and parent_topic_id in db_cluster_id_map:
            parent_db_id = db_cluster_id_map[parent_topic_id]
            db.execute(
                "UPDATE clusters SET parent_id = ?, updated_at = datetime('now') WHERE id = ?",
                (parent_db_id, db_id),
            )

    db.commit()

    # Write paper → cluster assignments
    print(f"[cluster] Writing cluster assignments for {len(paper_ids)} papers...")
    for paper_id, topic_id, confidence in zip(paper_ids, topics, confidences):
        if topic_id == -1:
            continue
        db_cluster_id = db_cluster_id_map.get(topic_id)
        if db_cluster_id is None:
            continue
        update_paper_cluster(db, paper_id, db_cluster_id, float(confidence))

    db.commit()

    n_clusters = len(unique_topic_ids)
    print(f"[cluster] Done. {n_clusters} clusters written.")
    return n_clusters


# ---------------------------------------------------------------------------
# Main entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="ingest.py",
        description="Paperpile wiki ingest pipeline: BibTeX → embed → cluster",
    )
    parser.add_argument(
        "--incremental",
        action="store_true",
        default=False,
        help="Only process new papers and assign to existing clusters (skip full re-cluster).",
    )
    parser.add_argument(
        "--full-recluster",
        action="store_true",
        default=False,
        help="Force a full re-cluster of the entire corpus, even if clusters exist.",
    )
    parser.add_argument(
        "--skip-pdf",
        action="store_true",
        default=False,
        help="Skip the PDF-matching stage.",
    )
    parser.add_argument(
        "--skip-relabel",
        action="store_true",
        default=False,
        help="Skip Claude-based cluster relabeling (keep Ollama labels).",
    )
    parser.add_argument(
        "--summarize",
        type=int,
        metavar="N",
        default=0,
        help="Summarize up to N papers with local LLM (fulltext PDF → summary → SPECTER2 embedding). 0 = skip.",
    )
    parser.add_argument(
        "--bib",
        metavar="PATH",
        default=BIB_PATH,
        help=f"Path to BibTeX file (default: {BIB_PATH}).",
    )
    parser.add_argument(
        "--db",
        metavar="PATH",
        default=DB_PATH,
        help=f"Path to SQLite database (default: {DB_PATH}).",
    )
    args = parser.parse_args()

    if args.incremental and args.full_recluster:
        parser.error("--incremental and --full-recluster are mutually exclusive.")

    # Load pipeline modules now (after arg parsing, so --help is fast)
    _import_pipeline_modules()

    print("=" * 60)
    print("paperpile-wiki ingest pipeline")
    print("=" * 60)
    print(f"  BibTeX : {args.bib}")
    print(f"  DB     : {args.db}")
    print(f"  Mode   : {'incremental' if args.incremental else 'full-recluster' if args.full_recluster else 'default'}")
    print(f"  PDF    : {'skip' if args.skip_pdf else 'enabled'}")
    print(f"  Relabel: {'skip' if args.skip_relabel else 'enabled (Claude)'}")
    print()

    t_start = time.time()

    # Initialise DB
    init_db(args.db)
    db = get_db(args.db)

    summary = {}

    try:
        # --- Stage 1: Parse BibTeX ---
        print("--- Stage 1: Parse BibTeX ---")
        n_new = run_parse(db, args.bib)
        summary["parsed_new"] = n_new

        # Load all papers for PDF matching
        all_papers_rows = db.execute("SELECT * FROM papers").fetchall()
        all_papers = [dict(row) for row in all_papers_rows]

        # --- Stage 2: PDF matching ---
        if not args.skip_pdf:
            print("\n--- Stage 2: PDF matching ---")
            n_matched = run_pdf_match(db, all_papers)
            summary["pdf_matched"] = n_matched
        else:
            print("\n--- Stage 2: PDF matching [SKIPPED] ---")
            summary["pdf_matched"] = 0

        # --- Stage 3: Embed ---
        print("\n--- Stage 3: Embedding ---")
        n_embedded = run_embed(db)
        summary["embedded"] = n_embedded

        # --- Stage 4: Cluster ---
        print("\n--- Stage 4: Clustering ---")

        # Check if there are any existing clusters
        existing = get_all_clusters(db)
        is_first_run = len(existing) == 0

        if args.incremental and not is_first_run:
            # Incremental mode: assign new papers to existing clusters
            n_clusters = run_cluster(db, full_recluster=False)
        else:
            # Full cluster (first run, explicit --full-recluster, or default)
            if is_first_run and args.incremental:
                print("[cluster] First run detected — performing full clustering despite --incremental flag.")
            n_clusters = run_cluster(db, full_recluster=args.full_recluster)

        summary["clusters"] = n_clusters

        # --- Stage 5: Claude relabeling ---
        if args.skip_relabel:
            print("\n--- Stage 5: Cluster relabeling [SKIPPED] ---")
            summary["relabeled"] = 0
        else:
            print("\n--- Stage 5: Cluster relabeling (Claude) ---")
            # Load OAuth token from .env if not already set
            env_path = os.path.join(PROJECT_ROOT, '.env')
            if not (os.environ.get('CLAUDE_CODE_OAUTH_TOKEN')
                    or os.environ.get('ANTHROPIC_BASE_URL')
                    or os.environ.get('ANTHROPIC_API_KEY')):
                if os.path.exists(env_path):
                    with open(env_path) as f:
                        for line in f:
                            line = line.strip()
                            if line.startswith('CLAUDE_CODE_OAUTH_TOKEN='):
                                os.environ['CLAUDE_CODE_OAUTH_TOKEN'] = line.split('=', 1)[1]
                                break

            if (os.environ.get('CLAUDE_CODE_OAUTH_TOKEN')
                    or os.environ.get('ANTHROPIC_BASE_URL')
                    or os.environ.get('ANTHROPIC_API_KEY')):
                try:
                    results = relabel_clusters_with_claude(db)
                    summary["relabeled"] = len(results)
                    print(f"[relabel] Relabeled {len(results)} clusters with Claude.")
                except Exception as e:
                    print(f"[relabel] WARNING: Claude relabeling failed ({e}), keeping Ollama labels.")
                    summary["relabeled"] = 0
            else:
                print("[relabel] No auth credentials found — keeping Ollama labels.")
                print("[relabel] Set CLAUDE_CODE_OAUTH_TOKEN in .env or ANTHROPIC_BASE_URL to enable.")
                summary["relabeled"] = 0

        # --- Stage 6: Fulltext summarization (local LLM) ---
        if args.summarize > 0:
            print(f"\n--- Stage 6: Fulltext summarization (up to {args.summarize} papers) ---")
            try:
                summaries = batch_summarize(db, batch_size=args.summarize)
                summary["summarized"] = len(summaries)
                if summaries:
                    print(f"\n--- Stage 6b: Embedding summaries with SPECTER2 ---")
                    n_embedded = embed_summaries(db)
                    summary["ft_embedded"] = n_embedded
                else:
                    summary["ft_embedded"] = 0
            except Exception as e:
                print(f"[summarize] WARNING: Summarization failed ({e})")
                summary["summarized"] = 0
                summary["ft_embedded"] = 0
        else:
            print("\n--- Stage 6: Fulltext summarization [SKIPPED] (use --summarize N) ---")
            summary["summarized"] = 0
            summary["ft_embedded"] = 0

    finally:
        db.close()

    t_elapsed = time.time() - t_start

    # Summary
    print()
    print("=" * 60)
    print("Ingest complete")
    print("=" * 60)
    total_papers = get_total_paper_count(get_db(args.db))
    print(f"  Total papers in DB : {total_papers}")
    print(f"  New papers parsed  : {summary.get('parsed_new', 0)}")
    print(f"  PDFs matched       : {summary.get('pdf_matched', 0)}")
    print(f"  Papers embedded    : {summary.get('embedded', 0)}")
    print(f"  Clusters           : {summary.get('clusters', 0)}")
    print(f"  Relabeled (Claude) : {summary.get('relabeled', 0)}")
    print(f"  Summarized (LLM)   : {summary.get('summarized', 0)}")
    print(f"  FT embedded        : {summary.get('ft_embedded', 0)}")
    print(f"  Elapsed            : {t_elapsed:.1f}s")
    print()


if __name__ == "__main__":
    main()
