"""PDF matcher for paperpile-wiki pipeline — Stage 2 of ingest.

Matches BibTeX-derived paper dicts to PDF files in the Paperpile Google Drive
folder, using DOI confirmation from a Paperpile JSON export and fuzzy filename
matching as a fallback.

Paperpile PDF filename format: FirstAuthorLastAuthor-Journal_Abbr-Year.pdf
  e.g. GandalGeschwind-Nature-2022.pdf
       Garcia-MarinBhattacharya-Nat_Neurosci_-2023.pdf
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from typing import Optional

import Levenshtein

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PAPERPILE_DIR = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-mgandal@gmail.com/My Drive/Paperpile/All_Papers"
)
PAPERPILE_JSON = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-mgandal@gmail.com/My Drive/Paperpile/"
    "Paperpile - Jul 07 JSON Export.txt"
)


# ---------------------------------------------------------------------------
# Unicode normalization
# ---------------------------------------------------------------------------

def normalize_author(name: str) -> str:
    """NFKD unicode decomposition, strip combining characters, lowercase.

    Examples:
        "García-Marín" → "garcia-marin"
        "Fröhlich"     → "frohlich"
        "Müller"       → "muller"
        "Smith"        → "smith"
    """
    # Decompose into base characters + combining marks
    decomposed = unicodedata.normalize("NFKD", name)
    # Strip combining characters (category Mn = Mark, Nonspacing)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return stripped.lower()


# ---------------------------------------------------------------------------
# Directory scanner
# ---------------------------------------------------------------------------

def scan_pdf_directory(directory: str) -> list[str]:
    """Recursively collect all .pdf files under *directory*.

    Returns a list of absolute paths.  Returns an empty list if the directory
    does not exist rather than raising.
    """
    if not os.path.isdir(directory):
        return []
    paths: list[str] = []
    for root, _dirs, files in os.walk(directory):
        for fname in files:
            if fname.lower().endswith(".pdf"):
                paths.append(os.path.abspath(os.path.join(root, fname)))
    return paths


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _extract_last_author(authors_str: Optional[str]) -> str:
    """Extract the last author's last name from a semicolon-separated string.

    Input format: "Last, First; Last2, First2; …"
    Returns the last name portion of the final author, or "" if missing.
    """
    if not authors_str or not authors_str.strip():
        return ""
    parts = [p.strip() for p in authors_str.split(";") if p.strip()]
    if not parts:
        return ""
    last_entry = parts[-1]
    # "Last, First …" — take everything before the first comma
    if "," in last_entry:
        return last_entry.split(",", 1)[0].strip()
    # No comma — treat entire token as last name
    return last_entry.strip()


# ---------------------------------------------------------------------------
# DOI-based matching via Paperpile JSON export
# ---------------------------------------------------------------------------

def match_by_doi_from_json(json_path: str, papers: list[dict]) -> dict[str, str]:
    """Match papers to PDFs confirmed by DOI from the Paperpile JSON export.

    Parses the Paperpile JSON export (a list of entries, each with a ``doi``
    field) and builds a DOI → entry mapping.  Papers that have a DOI present
    in the JSON are confirmed; their paper_id is mapped to the confirmed DOI
    so the caller knows the DOI was verified.

    Parameters
    ----------
    json_path:
        Path to the Paperpile JSON export file.
    papers:
        List of paper dicts (must have ``id`` and optionally ``doi`` keys).

    Returns
    -------
    dict[str, str]
        ``{paper_id: confirmed_doi}`` for papers whose DOI was found in the
        Paperpile JSON export.
    """
    if not papers:
        return {}
    if not json_path or not os.path.isfile(json_path):
        return {}

    try:
        with open(json_path, encoding="utf-8") as fh:
            json_entries: list[dict] = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}

    # Build set of DOIs present in the JSON export (normalised to lowercase)
    doi_set: set[str] = set()
    for entry in json_entries:
        raw_doi = entry.get("doi")
        if raw_doi and isinstance(raw_doi, str):
            doi_set.add(raw_doi.strip().lower())

    result: dict[str, str] = {}
    for paper in papers:
        paper_doi = paper.get("doi")
        if not paper_doi:
            continue
        if paper_doi.strip().lower() in doi_set:
            result[paper["id"]] = paper_doi.strip()

    return result


# ---------------------------------------------------------------------------
# Fuzzy filename matching
# ---------------------------------------------------------------------------

def _extract_author_prefix_from_basename(basename: str, year: int) -> str:
    """Extract the author-prefix segment from a Paperpile PDF basename.

    Paperpile filenames follow: ``AuthorPrefix-Journal_Abbr-Year[...].pdf``
    where *AuthorPrefix* is a CamelCase concatenation of the first and last
    author last names (e.g. ``GandalGeschwind``, ``Garcia-MarinBhattacharya``).

    Strategy:
    1. Strip from the last ``-{year}`` onward to get ``AuthorPrefix-Journal``.
    2. Split on the last ``-`` to separate journal from author prefix.
       If the potential journal segment starts with an uppercase letter (title-
       cased abbreviation) or contains underscores (like ``Nat_Neurosci_``),
       it is treated as a journal name and removed.

    Returns the author-prefix portion as a string.
    """
    year_str = str(year)
    # Find last occurrence of '-{year}' to strip year + suffix
    idx = basename.rfind("-" + year_str)
    if idx == -1:
        idx = basename.find(year_str)
        if idx == -1:
            return basename
        idx = max(0, idx - 1)
    prefix_and_journal = basename[:idx]  # e.g. 'GandalGeschwind-Nature'

    # Split off the journal segment (last '-'-delimited component)
    parts = prefix_and_journal.rsplit("-", 1)
    if len(parts) == 2:
        potential_journal = parts[1]
        # Journal: contains underscore OR starts with uppercase letter
        # (Uppercase-starting segments are journal abbreviations, not author
        # continuations, since multi-word author hyphens produce things like
        # 'Garcia-Marin' which starts with uppercase but is preceded by another
        # uppercase run without a '-'.)
        if "_" in potential_journal or (
            potential_journal and potential_journal[0].isupper()
        ):
            return parts[0]
    return prefix_and_journal


def fuzzy_match_filename(
    first_author: str,
    last_author: str,
    year: int,
    filename: str,
) -> float:
    """Score how well a PDF filename matches a paper's metadata.

    Paperpile filenames follow the pattern:
        FirstAuthorLastAuthor-Journal_Abbr-Year.pdf

    Algorithm:
    1. Quick filter: if str(year) is not in *filename* → return 0.0.
    2. Extract the "author prefix" from the filename using
       :func:`_extract_author_prefix_from_basename`, which strips the journal
       segment robustly (handling hyphenated surnames like ``Garcia-Marin``).
    3. Build an expected author prefix from first_author + last_author.
    4. Normalise both strings (strip accents, lowercase).
    5. Return the Levenshtein ratio between the two normalised strings.

    Returns a float in [0.0, 1.0].
    """
    if str(year) not in filename:
        return 0.0

    basename = os.path.splitext(os.path.basename(filename))[0]
    filename_prefix = _extract_author_prefix_from_basename(basename, year)

    # Build expected prefix
    expected_prefix = first_author + last_author

    # Normalise both sides
    norm_filename = normalize_author(filename_prefix)
    norm_expected = normalize_author(expected_prefix)

    if not norm_expected:
        return 0.0

    return float(Levenshtein.ratio(norm_expected, norm_filename))


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def match_papers_to_pdfs(
    papers: list[dict],
    pdf_dir: Optional[str] = None,
    json_path: Optional[str] = None,
    threshold: float = 0.85,
) -> dict[str, str]:
    """Match papers to PDF files using DOI confirmation and fuzzy filename matching.

    Strategy:
    1. Scan *pdf_dir* for all PDF files.
    2. Attempt DOI matching from *json_path* if provided — DOI-confirmed papers
       are not re-fuzzy-matched (they are confirmed, just not path-resolved here
       since the JSON doesn't contain GDrive paths reliably).
    3. For papers not resolved by DOI, fuzzy-match filenames using
       :func:`fuzzy_match_filename`.  The best-scoring match above *threshold*
       is chosen.

    Parameters
    ----------
    papers:
        List of paper dicts with keys: ``id``, ``doi``, ``first_author``,
        ``authors`` (semicolon-separated), ``year``.
    pdf_dir:
        Directory to scan for PDFs.  Defaults to :data:`PAPERPILE_DIR`.
    json_path:
        Path to the Paperpile JSON export.  Defaults to :data:`PAPERPILE_JSON`.
        Pass ``None`` to skip DOI matching.
    threshold:
        Minimum fuzzy score (0–1) to accept a match.

    Returns
    -------
    dict[str, str]
        ``{paper_id: relative_pdf_path}`` — paths are relative to *pdf_dir*.
        DOI-confirmed papers are mapped to ``"doi_confirmed"`` as a sentinel.
    """
    if pdf_dir is None:
        pdf_dir = PAPERPILE_DIR
    if json_path is None:
        json_path = PAPERPILE_JSON

    result: dict[str, str] = {}

    # Step 1: scan PDFs
    pdf_paths = scan_pdf_directory(pdf_dir)

    # Step 2: DOI matching
    doi_matches: dict[str, str] = {}
    if json_path:
        doi_matches = match_by_doi_from_json(json_path, papers)
    for paper_id, confirmed_doi in doi_matches.items():
        result[paper_id] = "doi_confirmed"

    # Step 3: fuzzy filename matching for unresolved papers
    unresolved = [p for p in papers if p["id"] not in result]

    if not pdf_paths or not unresolved:
        return result

    # Pre-extract basenames for speed
    pdf_basenames = [os.path.basename(p) for p in pdf_paths]

    for paper in unresolved:
        first_author = paper.get("first_author") or ""
        last_author = _extract_last_author(paper.get("authors"))
        year = paper.get("year")

        if not first_author or not year:
            continue

        best_score = 0.0
        best_path: Optional[str] = None

        for pdf_path, pdf_basename in zip(pdf_paths, pdf_basenames):
            score = fuzzy_match_filename(first_author, last_author, year, pdf_basename)
            if score > best_score:
                best_score = score
                best_path = pdf_path

        if best_score >= threshold and best_path is not None:
            # Store as relative path from pdf_dir
            try:
                rel = os.path.relpath(best_path, pdf_dir)
            except ValueError:
                rel = best_path
            result[paper["id"]] = rel

    return result
