#!/usr/bin/env python3
"""Claude API synthesis: evidence cards → markdown wiki pages.

Routes through credential proxy via ANTHROPIC_BASE_URL env var.
The anthropic.Anthropic() client auto-reads ANTHROPIC_BASE_URL and
ANTHROPIC_API_KEY from the environment — no explicit config needed.

Typical usage:
    from synthesizer import synthesize_cluster
    import anthropic
    client = anthropic.Anthropic()
    markdown, cost = synthesize_cluster(client, cluster, papers, papers_by_id)
"""

import os
import re
import subprocess
import time
from datetime import datetime, timezone
from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MODEL = "claude-sonnet-4-6"
MAX_RETRIES = 5
MAX_EVIDENCE_PAPERS = 40


def _api_call_with_retry(client, **kwargs):
    """Call client.messages.create with exponential backoff on rate limits."""
    for attempt in range(MAX_RETRIES):
        try:
            return client.messages.create(**kwargs)
        except Exception as e:
            if '429' in str(e) and attempt < MAX_RETRIES - 1:
                wait = 2 ** attempt * 5  # 5s, 10s, 20s, 40s
                print(f"    [rate-limit] Waiting {wait}s before retry ({attempt + 1}/{MAX_RETRIES})...")
                time.sleep(wait)
                continue
            raise
GANDAL_ENRICHMENT_WORDS = 1000
PDFTOTEXT = '/opt/homebrew/bin/pdftotext'
PAPERPILE_PDF_DIR = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-mgandal@gmail.com/My Drive/Paperpile/All_Papers"
)


# ---------------------------------------------------------------------------
# Evidence card formatting
# ---------------------------------------------------------------------------

def _format_authors(authors_str: str | None) -> str | None:
    """Shorten author list to 'First et al.' when more than 3 authors.

    Args:
        authors_str: Semicolon-separated author string, e.g. "Smith, J.; Doe, A."

    Returns:
        Formatted author string or None if input is None/empty.
    """
    if not authors_str:
        return None
    parts = [a.strip() for a in authors_str.split(";") if a.strip()]
    if len(parts) > 3:
        # Extract the last name from "Last, First" format
        first_part = parts[0]
        last_name = first_part.split(",")[0].strip() if "," in first_part else first_part
        return f"{last_name} et al."
    return "; ".join(parts)


def format_evidence_card(paper: dict, enrichment_text: str | None = None) -> str:
    """Format a paper dict as a structured evidence card string.

    Format:
        [Key2024-ab] "Title here"
        Authors: Smith, J. et al. | Journal: Nature | Year: 2024
        Abstract: We investigated...

    Optional (when enrichment_text is provided):
        Full-text excerpts:
        <text>

    Missing fields are omitted rather than shown as "None".

    Args:
        paper:           Paper dict with fields: bibtex_key (or id), title,
                         authors, journal, year, abstract.
        enrichment_text: Optional full-text excerpt for Gandal papers.

    Returns:
        Formatted evidence card string.
    """
    key = paper.get("bibtex_key") or paper.get("id") or "Unknown"
    title = paper.get("title") or ""
    authors_raw = paper.get("authors")
    journal = paper.get("journal")
    year = paper.get("year")
    abstract = paper.get("abstract")

    # Build header line
    lines = [f'[{key}] "{title}"']

    # Build metadata line — only include non-None fields
    meta_parts = []
    formatted_authors = _format_authors(authors_raw)
    if formatted_authors:
        meta_parts.append(f"Authors: {formatted_authors}")
    if journal:
        meta_parts.append(f"Journal: {journal}")
    if year:
        meta_parts.append(f"Year: {year}")

    if meta_parts:
        lines.append(" | ".join(meta_parts))

    # Abstract
    if abstract:
        lines.append(f"Abstract: {abstract}")

    # Enrichment
    if enrichment_text:
        lines.append("Full-text excerpts:")
        lines.append(enrichment_text)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Gandal paper enrichment
# ---------------------------------------------------------------------------

def _enrich_own_paper(paper: dict) -> str | None:
    """Extract intro + discussion text from a Gandal-authored PDF.

    Only runs when:
      - "Gandal" appears in paper["authors"]
      - paper["pdf_path"] is set
      - The PDF file exists under PAPERPILE_PDF_DIR

    Extracts first 500 words (intro) and last 500 words (discussion).
    Returns None on any failure (file missing, pdftotext error, timeout).

    Args:
        paper: Paper dict.

    Returns:
        Extracted text string, or None.
    """
    authors = paper.get("authors") or ""
    if "Gandal" not in authors:
        return None

    pdf_path = paper.get("pdf_path")
    if not pdf_path:
        return None

    # Resolve path under PAPERPILE_PDF_DIR
    # pdf_path may be relative or a basename — try as-is first, then join
    if os.path.isabs(pdf_path):
        full_path = pdf_path
    else:
        full_path = os.path.join(PAPERPILE_PDF_DIR, pdf_path)

    if not os.path.exists(full_path):
        return None

    try:
        result = subprocess.run(
            [PDFTOTEXT, full_path, "-"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None

        text = result.stdout
        words = text.split()
        if not words:
            return None

        intro_words = words[:500]
        discussion_words = words[-500:] if len(words) > 500 else []

        parts = [" ".join(intro_words)]
        if discussion_words and len(words) > 500:
            parts.append("...\n[Discussion/Conclusion]\n" + " ".join(discussion_words))

        return "\n".join(parts)

    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


# ---------------------------------------------------------------------------
# Paper selection for large clusters
# ---------------------------------------------------------------------------

def select_papers_for_cluster(
    papers: list[dict],
    cluster_centroid: bytes | None,
    max_papers: int = MAX_EVIDENCE_PAPERS,
) -> list[dict]:
    """Select the papers closest to the cluster centroid.

    If there are ≤ max_papers, all papers are returned unchanged.
    Otherwise, cosine similarity to the centroid is used to pick the closest ones.

    Args:
        papers:           List of paper dicts (must have "embedding" bytes field
                          when centroid is provided and len > max_papers).
        cluster_centroid: Raw float32 bytes from the DB, or None.
        max_papers:       Maximum papers to return.

    Returns:
        Subset (or all) of input papers, sorted by similarity (best first).
    """
    if len(papers) <= max_papers:
        return papers

    if cluster_centroid is None:
        # No centroid available — just take the first max_papers
        return papers[:max_papers]

    from embedder import bytes_to_embedding
    import numpy as np

    centroid_vec = np.array(bytes_to_embedding(cluster_centroid), dtype=np.float32)
    centroid_norm = np.linalg.norm(centroid_vec)

    scored = []
    for p in papers:
        emb_bytes = p.get("embedding")
        if emb_bytes:
            emb = np.array(bytes_to_embedding(emb_bytes), dtype=np.float32)
            norm = np.linalg.norm(emb)
            if norm > 0 and centroid_norm > 0:
                sim = float(np.dot(emb, centroid_vec) / (norm * centroid_norm))
            else:
                sim = 0.0
        else:
            sim = 0.0
        scored.append((sim, p))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [p for _, p in scored[:max_papers]]


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

def build_prompt_small(
    cluster_name: str,
    cluster_description: str,
    evidence_cards: list[str],
) -> str:
    """Build a single-call synthesis prompt for ≤25 papers.

    Args:
        cluster_name:        Human-readable topic name.
        cluster_description: Short description of the cluster theme.
        evidence_cards:      List of formatted evidence card strings.

    Returns:
        Full prompt string.
    """
    cards_text = "\n\n---\n\n".join(evidence_cards)
    return f"""You are a scientific synthesis writer. Your task is to write a comprehensive wiki-style synthesis page for the research topic: **{cluster_name}**.

Topic description: {cluster_description}

Below are evidence cards for {len(evidence_cards)} papers on this topic. Each card includes the citation key in [AuthorYear-xx] format, metadata, and abstract.

{cards_text}

---

Write a synthesis wiki page in Markdown. Requirements:
1. Start with a 2-3 sentence **overview** of the topic area.
2. Organize findings into thematic ## sections (e.g., ## Key Findings, ## Methods, ## Biological Mechanisms).
3. Use inline citations in [AuthorYear-xx] format throughout the text.
4. Include a **## Key Findings** section summarizing the most important results.
5. End with a **## Key Papers** section listing the most influential works.
6. Be factual and grounded in the evidence cards provided.
7. Do NOT include a References section (that will be appended separately).
8. Do NOT include YAML frontmatter.

Write the synthesis now:"""


def build_prompt_outline(
    cluster_name: str,
    cluster_description: str,
    evidence_cards: list[str],
) -> str:
    """Build an outline-generation prompt for >25 papers.

    Args:
        cluster_name:        Human-readable topic name.
        cluster_description: Short description of the cluster theme.
        evidence_cards:      List of formatted evidence card strings.

    Returns:
        Outline prompt string.
    """
    cards_text = "\n\n---\n\n".join(evidence_cards)
    return f"""You are a scientific synthesis writer. Your task is to create an outline for a comprehensive wiki-style synthesis page on: **{cluster_name}**.

Topic description: {cluster_description}

Below are evidence cards for {len(evidence_cards)} papers. Review them and produce a structured outline.

{cards_text}

---

Produce a structured outline with:
1. A brief overview (2-3 sentences)
2. 4-8 thematic ## section headings with 2-4 bullet points each describing what that section will cover
3. A Key Findings section
4. A Key Papers section

Format as plain Markdown outline. Be concise. This outline will be used to write the full synthesis next."""


def build_prompt_sections(
    cluster_name: str,
    outline: str,
    evidence_cards: list[str],
) -> str:
    """Build the section-writing prompt for large clusters using a pre-generated outline.

    Args:
        cluster_name:  Human-readable topic name.
        outline:       Outline text from build_prompt_outline call.
        evidence_cards: List of formatted evidence card strings.

    Returns:
        Section-writing prompt string.
    """
    cards_text = "\n\n---\n\n".join(evidence_cards)
    return f"""You are a scientific synthesis writer. Write the full wiki-style synthesis page for: **{cluster_name}**.

Use the following outline as your structure:

{outline}

Below are {len(evidence_cards)} evidence cards. Use inline [AuthorYear-xx] citations throughout.

{cards_text}

---

Write the complete synthesis now following the outline exactly. Requirements:
1. Fill in each section with substantive content grounded in the evidence cards.
2. Use inline citations in [AuthorYear-xx] format.
3. Do NOT include a References section (appended separately).
4. Do NOT include YAML frontmatter.
5. Be factual and comprehensive."""


# ---------------------------------------------------------------------------
# Citation extraction
# ---------------------------------------------------------------------------

def extract_citations(text: str) -> list[str]:
    """Extract unique [AuthorYear-xx] citation keys from text in order of appearance.

    Pattern: [AuthorYear-xx] where Author starts with a capital letter,
    may contain letters/digits/underscores/hyphens, followed by a 4-digit
    year and a 2-lowercase-letter suffix.

    Args:
        text: Markdown or plain text with inline citations.

    Returns:
        Deduplicated list of citation keys preserving first-occurrence order.
    """
    pattern = r'\[([A-Za-z][A-Za-z0-9_-]+\d{4}-[a-z]{2})\]'
    matches = re.findall(pattern, text)
    seen = set()
    result = []
    for m in matches:
        if m not in seen:
            seen.add(m)
            result.append(m)
    return result


# ---------------------------------------------------------------------------
# Frontmatter builder
# ---------------------------------------------------------------------------

def build_frontmatter(
    title: str,
    cluster_id: int,
    paper_count: int,
    tags: list[str] | None = None,
) -> str:
    """Build a YAML frontmatter block for the synthesis page.

    Args:
        title:       Page title.
        cluster_id:  Integer cluster ID from the DB.
        paper_count: Number of papers synthesized.
        tags:        Optional list of tag strings.

    Returns:
        YAML frontmatter string starting and ending with '---'.
    """
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        "---",
        f"title: {title}",
        "type: synthesis",
        f"cluster_id: {cluster_id}",
        f"paper_count: {paper_count}",
        f"generated: {generated}",
        "status: current",
    ]
    if tags:
        lines.append("tags:")
        for tag in tags:
            lines.append(f"  - {tag}")
    lines.append("---")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# References section builder
# ---------------------------------------------------------------------------

def build_references_section(
    cited_ids: list[str],
    papers_by_id: dict,
) -> str:
    """Build a ## References section from a list of cited keys.

    Format per entry:
        - [Key] Author et al. "Title" Journal (Year). doi:xxx

    Unknown keys (not in papers_by_id) are silently skipped.

    Args:
        cited_ids:   List of citation key strings (e.g. ["Gandal2018-ab"]).
        papers_by_id: Dict mapping key → paper dict.

    Returns:
        Markdown string with ## References header.
    """
    lines = ["## References", ""]
    for key in cited_ids:
        paper = papers_by_id.get(key)
        if paper is None:
            continue

        title = paper.get("title") or ""
        authors_raw = paper.get("authors")
        formatted_authors = _format_authors(authors_raw) or ""
        journal = paper.get("journal") or ""
        year = paper.get("year") or ""
        doi = paper.get("doi")

        # Build citation string
        entry = f"- [{key}] {formatted_authors} \"{title}\""
        if journal or year:
            entry += f" {journal} ({year})"
        if doi:
            entry += f". doi:{doi}"
        lines.append(entry)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Full synthesis pipeline
# ---------------------------------------------------------------------------

def synthesize_cluster(
    client,
    cluster: dict,
    papers: list[dict],
    papers_by_id: dict,
    dry_run: bool = False,
) -> tuple[str, float]:
    """Run the full synthesis pipeline for a single cluster.

    Steps:
      1. Select papers (max MAX_EVIDENCE_PAPERS by centroid proximity)
      2. Build evidence cards (with Gandal PDF enrichment)
      3. If dry_run: return placeholder
      4. Small clusters (≤25): single API call
      5. Large clusters (>25): outline call then sections call
      6. Extract citations, build references section
      7. Assemble full page with frontmatter
      8. Calculate cost

    Args:
        client:       anthropic.Anthropic() instance (reads ANTHROPIC_BASE_URL from env).
        cluster:      Cluster dict with keys: id, name, description, centroid.
        papers:       List of paper dicts for this cluster.
        papers_by_id: Dict mapping bibtex_key/id → paper dict for reference building.
        dry_run:      If True, skip API calls and return placeholder.

    Returns:
        (markdown_text, estimated_cost_usd)
    """
    cluster_id = cluster.get("id")
    cluster_name = cluster.get("name") or f"Cluster {cluster_id}"
    cluster_description = cluster.get("description") or ""
    centroid = cluster.get("centroid")

    # Step 1: select papers
    selected = select_papers_for_cluster(papers, centroid, max_papers=MAX_EVIDENCE_PAPERS)

    # Step 2: build evidence cards
    evidence_cards = []
    for paper in selected:
        enrichment = _enrich_own_paper(paper)
        card = format_evidence_card(paper, enrichment_text=enrichment)
        evidence_cards.append(card)

    # Step 3: dry run
    if dry_run:
        frontmatter = build_frontmatter(
            title=cluster_name,
            cluster_id=cluster_id,
            paper_count=len(selected),
        )
        placeholder = (
            f"{frontmatter}\n\n"
            f"# {cluster_name}\n\n"
            f"*[DRY RUN — {len(selected)} papers selected, no API call made]*\n\n"
            f"## References\n"
        )
        return placeholder, 0.0

    total_input_tokens = 0
    total_output_tokens = 0

    # Step 4/5: API calls
    if len(evidence_cards) <= 25:
        # Small cluster: single call
        prompt = build_prompt_small(cluster_name, cluster_description, evidence_cards)
        response = _api_call_with_retry(
            client, model=MODEL, max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        body_text = response.content[0].text
        total_input_tokens += response.usage.input_tokens
        total_output_tokens += response.usage.output_tokens
    else:
        # Large cluster: outline then sections
        outline_prompt = build_prompt_outline(cluster_name, cluster_description, evidence_cards)
        outline_response = _api_call_with_retry(
            client, model=MODEL, max_tokens=2048,
            messages=[{"role": "user", "content": outline_prompt}],
        )
        outline = outline_response.content[0].text
        total_input_tokens += outline_response.usage.input_tokens
        total_output_tokens += outline_response.usage.output_tokens

        sections_prompt = build_prompt_sections(cluster_name, outline, evidence_cards)
        sections_response = _api_call_with_retry(
            client, model=MODEL, max_tokens=6144,
            messages=[{"role": "user", "content": sections_prompt}],
        )
        body_text = sections_response.content[0].text
        total_input_tokens += sections_response.usage.input_tokens
        total_output_tokens += sections_response.usage.output_tokens

    # Step 6: extract citations and build references
    cited_ids = extract_citations(body_text)
    references = build_references_section(cited_ids, papers_by_id)

    # Step 7: build frontmatter and assemble
    frontmatter = build_frontmatter(
        title=cluster_name,
        cluster_id=cluster_id,
        paper_count=len(selected),
    )
    markdown = f"{frontmatter}\n\n# {cluster_name}\n\n{body_text}\n\n{references}\n"

    # Step 8: calculate cost (claude-sonnet-4-6 pricing)
    cost = (total_input_tokens * 3.0 / 1_000_000) + (total_output_tokens * 15.0 / 1_000_000)

    return markdown, cost
