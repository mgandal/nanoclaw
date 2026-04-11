#!/usr/bin/env python3
"""Local LLM summarization of full-text PDFs for enriched embeddings.

Extracts text from PDFs, sends to a local Ollama model for structured
research summaries, and stores the summaries for SPECTER2 embedding.

Typical usage:
    from summarizer import summarize_paper_pdf, batch_summarize
    summary = summarize_paper_pdf(pdf_path)
    results = batch_summarize(db, batch_size=20)
"""

import os
import subprocess
import time
from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PDFTOTEXT = '/opt/homebrew/bin/pdftotext'
OLLAMA_MODEL = 'gemma4:31b-cloud'
OLLAMA_URL = 'http://localhost:11434'
MAX_PDF_WORDS = 15000  # truncate to avoid overwhelming the LLM
SUMMARY_TARGET_WORDS = 200

PAPERPILE_DIR = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-mgandal@gmail.com/My Drive/Paperpile/All_Papers"
)

SUMMARY_PROMPT = """\
You are a scientific research analyst. Read the following academic paper and produce a structured research summary.

The summary must capture:
1. **Research question**: What specific question or hypothesis does this paper address?
2. **Methods**: What experimental or computational approaches were used? (e.g., RNA-seq, GWAS, CRISPR screen, organoids, mouse model, clinical trial)
3. **Key findings**: What are the 2-3 most important results?
4. **Biological significance**: What do the findings mean for understanding the disease/biology?
5. **Technical details**: Any specific genes, brain regions, cell types, cohort sizes, or statistical methods that are central to the paper.

Write a single paragraph of approximately 200 words. Be specific and technical — this summary will be used for semantic search and clustering alongside thousands of other papers. Do NOT include the paper title or author names in your summary.

---

{text}

---

Summary:"""


# ---------------------------------------------------------------------------
# PDF text extraction
# ---------------------------------------------------------------------------

def extract_pdf_text(pdf_path: str, max_words: int = MAX_PDF_WORDS) -> Optional[str]:
    """Extract text from a PDF file, truncated to max_words.

    Strips common boilerplate sections (references, acknowledgments) and
    limits output to avoid overwhelming the LLM context window.

    Returns None if extraction fails.
    """
    if not os.path.exists(pdf_path):
        return None

    try:
        result = subprocess.run(
            [PDFTOTEXT, '-layout', pdf_path, '-'],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None
        text = result.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None

    if not text or len(text.strip()) < 100:
        return None

    # Strip references section and everything after
    # Common headers: "References", "REFERENCES", "Bibliography", "Literature Cited"
    import re
    ref_pattern = re.compile(
        r'\n\s*(References|REFERENCES|Bibliography|Literature Cited|Works Cited)\s*\n',
        re.IGNORECASE,
    )
    match = ref_pattern.search(text)
    if match:
        text = text[:match.start()]

    # Also strip acknowledgments
    ack_pattern = re.compile(
        r'\n\s*(Acknowledgments|ACKNOWLEDGMENTS|Acknowledgements|Funding)\s*\n',
        re.IGNORECASE,
    )
    match = ack_pattern.search(text)
    if match:
        text = text[:match.start()]

    # Truncate to max_words
    words = text.split()
    if len(words) > max_words:
        words = words[:max_words]
    text = ' '.join(words)

    return text


# ---------------------------------------------------------------------------
# LLM summarization
# ---------------------------------------------------------------------------

def summarize_text(text: str, model: str = OLLAMA_MODEL) -> Optional[str]:
    """Send text to local Ollama model for summarization.

    Returns the summary string, or None on failure.
    """
    import requests

    prompt = SUMMARY_PROMPT.format(text=text)

    try:
        resp = requests.post(
            f'{OLLAMA_URL}/api/generate',
            json={
                'model': model,
                'prompt': prompt,
                'stream': False,
                'options': {
                    'temperature': 0.3,
                    'num_predict': 512,
                },
            },
            timeout=180,  # 3 minutes max per paper
        )
        resp.raise_for_status()
        data = resp.json()
        summary = data.get('response', '').strip()

        if len(summary) < 50:
            return None

        return summary

    except Exception:
        return None


def summarize_paper_pdf(pdf_path: str, model: str = OLLAMA_MODEL) -> Optional[str]:
    """Extract text from PDF and summarize with LLM. Returns summary or None."""
    text = extract_pdf_text(pdf_path)
    if not text:
        return None
    return summarize_text(text, model)


# ---------------------------------------------------------------------------
# Batch processing
# ---------------------------------------------------------------------------

def batch_summarize(
    db,
    batch_size: int = 50,
    model: str = OLLAMA_MODEL,
) -> dict:
    """Summarize papers that have PDFs but no fulltext_summary.

    Processes up to batch_size papers per call. Designed to be called
    incrementally (e.g., weekly via maintenance cron).

    Returns dict mapping paper_id -> summary string.
    """
    # Find papers with pdf_path but no fulltext_summary
    rows = db.execute(
        """SELECT id, title, pdf_path FROM papers
           WHERE pdf_path IS NOT NULL
             AND fulltext_summary IS NULL
           ORDER BY year DESC
           LIMIT ?""",
        (batch_size,),
    ).fetchall()

    if not rows:
        print("[summarize] No papers need summarization.")
        return {}

    print(f"[summarize] Processing {len(rows)} papers with {model}...")

    results = {}
    for i, row in enumerate(rows):
        paper_id = row['id']
        pdf_path = row['pdf_path']
        title = row['title']

        # Resolve relative paths
        if not os.path.isabs(pdf_path):
            pdf_path = os.path.join(PAPERPILE_DIR, pdf_path)

        summary = summarize_paper_pdf(pdf_path, model)

        if summary:
            # Store in DB
            db.execute(
                """UPDATE papers SET fulltext_summary = ?, updated_at = datetime('now')
                   WHERE id = ?""",
                (summary, paper_id),
            )
            results[paper_id] = summary

            if (i + 1) % 5 == 0:
                db.commit()
                print(f"  [{i+1}/{len(rows)}] {title[:60]}...")
        else:
            # Mark as attempted but failed (store empty string so we don't retry)
            db.execute(
                """UPDATE papers SET fulltext_summary = '', updated_at = datetime('now')
                   WHERE id = ?""",
                (paper_id,),
            )

    db.commit()
    succeeded = len(results)
    print(f"[summarize] Done: {succeeded}/{len(rows)} papers summarized.")
    return results


def embed_summaries(db, batch_size: int = 32) -> int:
    """Embed fulltext_summaries with SPECTER2, store in fulltext_embedding.

    Only processes papers that have a summary but no fulltext_embedding.
    Returns count of newly embedded papers.
    """
    from embedder import embed_papers, embedding_to_bytes

    rows = db.execute(
        """SELECT id, title, fulltext_summary FROM papers
           WHERE fulltext_summary IS NOT NULL
             AND fulltext_summary != ''
             AND fulltext_embedding IS NULL
           LIMIT 5000""",
    ).fetchall()

    if not rows:
        print("[embed-ft] No summaries need embedding.")
        return 0

    print(f"[embed-ft] Embedding {len(rows)} summaries with SPECTER2...")

    # Format as paper dicts with summary as "abstract" for SPECTER2
    paper_dicts = [
        {'id': row['id'], 'title': row['title'], 'abstract': row['fulltext_summary']}
        for row in rows
    ]

    embeddings = embed_papers(paper_dicts, batch_size=batch_size)

    for paper_id, emb_bytes in embeddings.items():
        db.execute(
            "UPDATE papers SET fulltext_embedding = ?, updated_at = datetime('now') WHERE id = ?",
            (emb_bytes, paper_id),
        )

    db.commit()
    print(f"[embed-ft] Embedded {len(embeddings)} summaries.")
    return len(embeddings)
