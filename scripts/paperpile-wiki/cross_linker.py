#!/usr/bin/env python3
"""Deterministic cross-linking and INDEX.md generation for paperpile wiki.

Typical usage (called from synthesize.py after all wiki pages are written):

    from cross_linker import find_cross_links, inject_wikilinks, generate_index_md

    # 1. Find clusters that share papers
    pairs = find_cross_links(cluster_papers, share_threshold=0.1)

    # 2. Inject wikilinks into each synthesis page
    updated_text = inject_wikilinks(text, related_slugs, slug_to_name)

    # 3. Generate the INDEX.md table of contents
    index_content = generate_index_md(clusters, total_papers=5721)
"""

import re
from datetime import date
from itertools import combinations
from typing import Optional


# ---------------------------------------------------------------------------
# Cross-link detection
# ---------------------------------------------------------------------------

def find_cross_links(
    cluster_papers: dict[str, list[str]],
    share_threshold: float = 0.1,
) -> list[tuple[str, str]]:
    """Find cluster pairs that share more than share_threshold of their papers.

    The threshold is applied to the *smaller* cluster:
        shared / min(len(a), len(b)) > share_threshold

    Empty clusters (size 0) produce 0 shared papers and are never linked.

    Args:
        cluster_papers:  Mapping of cluster slug → list of paper IDs.
        share_threshold: Minimum share fraction (exclusive) to qualify for a link.

    Returns:
        Sorted list of (slug_a, slug_b) tuples where slug_a < slug_b,
        sorted lexicographically.
    """
    slugs = sorted(cluster_papers.keys())
    result: list[tuple[str, str]] = []

    for slug_a, slug_b in combinations(slugs, 2):
        papers_a = set(cluster_papers[slug_a])
        papers_b = set(cluster_papers[slug_b])

        min_size = min(len(papers_a), len(papers_b))
        if min_size == 0:
            continue

        shared = len(papers_a & papers_b)
        if shared / min_size > share_threshold:
            # Ensure alphabetical ordering within pair
            pair = tuple(sorted([slug_a, slug_b]))
            result.append(pair)  # type: ignore[arg-type]

    return sorted(result)


# ---------------------------------------------------------------------------
# Wikilink injection
# ---------------------------------------------------------------------------

def inject_wikilinks(
    text: str,
    target_slugs: list[str],
    slug_to_name: dict[str, str],
) -> str:
    """Add "See also: [[slug]]" references into synthesis text.

    - Inserts before the first "## References" or "## Key Papers" section.
    - If neither marker is found, appends to the end.
    - Each slug is injected at most once (skipped if [[slug]] already present).

    Args:
        text:         Synthesis markdown text.
        target_slugs: List of cluster slugs to link to.
        slug_to_name: Mapping of slug → human-readable name (unused in link
                      text, available for future display).

    Returns:
        Updated text with "See also:" block injected, or unchanged if no
        target_slugs (or all already present).
    """
    if not target_slugs:
        return text

    # Filter to slugs whose wikilink is not already present
    slugs_to_add = [
        slug for slug in target_slugs
        if f"[[{slug}]]" not in text
    ]

    if not slugs_to_add:
        return text

    # Build the "See also:" line
    links_str = " ".join(f"[[{slug}]]" for slug in slugs_to_add)
    see_also_block = f"\nSee also: {links_str}\n"

    # Determine insertion point — prefer ## References, then ## Key Papers
    ref_match = re.search(r"^## References\b", text, re.MULTILINE)
    key_papers_match = re.search(r"^## Key Papers\b", text, re.MULTILINE)

    insert_match = ref_match or key_papers_match

    if insert_match:
        pos = insert_match.start()
        return text[:pos] + see_also_block + "\n" + text[pos:]
    else:
        # Append to end
        return text.rstrip("\n") + "\n" + see_also_block


# ---------------------------------------------------------------------------
# INDEX.md generation
# ---------------------------------------------------------------------------

def generate_index_md(clusters: list[dict], total_papers: int) -> str:
    """Generate the INDEX.md table of contents for the paperpile wiki.

    Format:
        # Paperpile Wiki

        Generated: YYYY-MM-DD | N,NNN papers | NNN topics | [Hierarchy visualization](.meta/hierarchy.html)

        - [[slug]] — N papers — Description
          - [[child-slug]] — N papers — Description

    Top-level clusters (parent_id is None) are listed first, children indented
    under their parent with two extra spaces. Within each level, clusters are
    sorted by paper_count descending.

    Orphan children (parent_id set but parent not found) are appended at the
    end of the top-level list.

    Args:
        clusters:     List of cluster dicts, each with keys:
                        id, name, slug, description, paper_count, parent_id.
        total_papers: Total number of papers in the library.

    Returns:
        Full INDEX.md string.
    """
    today = date.today().strftime("%Y-%m-%d")
    paper_count_fmt = f"{total_papers:,}"
    cluster_count = len(clusters)

    header = (
        f"# Paperpile Wiki\n\n"
        f"Generated: {today} | {paper_count_fmt} papers | {cluster_count} topics | "
        f"[Hierarchy visualization](.meta/hierarchy.html)\n"
    )

    # Build lookup by id
    cluster_by_id: dict = {c["id"]: c for c in clusters}

    # Separate top-level (parent_id is None) from children
    top_level = [c for c in clusters if c.get("parent_id") is None]
    children_map: dict[int, list[dict]] = {}
    orphans: list[dict] = []

    for c in clusters:
        pid = c.get("parent_id")
        if pid is not None:
            if pid in cluster_by_id:
                children_map.setdefault(pid, []).append(c)
            else:
                # Parent not found — treat as orphan top-level
                orphans.append(c)

    # Sort top-level by paper_count descending
    top_level.sort(key=lambda c: c.get("paper_count", 0), reverse=True)
    # Sort orphans by paper_count descending
    orphans.sort(key=lambda c: c.get("paper_count", 0), reverse=True)
    # Sort children within each parent by paper_count descending
    for pid in children_map:
        children_map[pid].sort(key=lambda c: c.get("paper_count", 0), reverse=True)

    lines: list[str] = []

    def _entry_line(cluster: dict, indent: str = "") -> str:
        slug = cluster.get("slug", "")
        paper_count = cluster.get("paper_count", 0)
        description = cluster.get("description", "")
        return f"{indent}- [[{slug}]] — {paper_count} papers — {description}"

    for cluster in top_level:
        lines.append(_entry_line(cluster))
        cid = cluster["id"]
        for child in children_map.get(cid, []):
            lines.append(_entry_line(child, indent="  "))

    for cluster in orphans:
        lines.append(_entry_line(cluster))

    body = "\n".join(lines)
    return header + "\n" + body + "\n"
