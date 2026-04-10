"""BibTeX parser for paperpile-wiki pipeline — Stage 1 of ingest.

Converts .bib files (bibtexparser v2 beta) into structured dicts ready for
upsert into the papers table managed by db.py.
"""

from __future__ import annotations

import re
from typing import Optional

import bibtexparser


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

def _clean_text(text: Optional[str]) -> Optional[str]:
    """Strip surrounding braces and collapse internal whitespace.

    Returns None if *text* is None; returns the cleaned string otherwise.
    Only the outermost braces are stripped (e.g. ``{GTEx Consortium}`` →
    ``GTEx Consortium``).  Inner braces such as ``{ASD}`` are preserved.
    """
    if text is None:
        return None
    s = text.strip()
    # Strip one layer of surrounding braces
    if s.startswith("{") and s.endswith("}"):
        s = s[1:-1]
    # Collapse runs of whitespace (including newlines from multi-line values)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _semicolon_authors(author_str: Optional[str]) -> Optional[str]:
    """Convert BibTeX ``Last, First and Last2, First2 …`` to semicolon-separated."""
    if author_str is None:
        return None
    # Split on " and " (BibTeX standard separator)
    parts = re.split(r"\s+and\s+", author_str)
    return "; ".join(p.strip() for p in parts)


def _parse_year(year_str: Optional[str]) -> Optional[int]:
    """Parse a year string to an integer.

    Handles plain integers (``"2024"``) as well as strings where the year is
    embedded in free text (``"Published in 2023"``).  Returns ``None`` when no
    four-digit year can be found.
    """
    if not year_str:
        return None
    s = str(year_str).strip()
    # Fast path: pure integer
    if s.isdigit() and len(s) == 4:
        return int(s)
    # Try int() directly first (handles e.g. "1999")
    try:
        return int(s)
    except ValueError:
        pass
    # Regex fallback: look for a four-digit year anywhere in the string
    m = re.search(r"\b(1[89]\d{2}|20\d{2})\b", s)
    if m:
        return int(m.group(1))
    return None


# ---------------------------------------------------------------------------
# First-author extraction
# ---------------------------------------------------------------------------

def extract_first_author(author_str: Optional[str]) -> str:
    """Return the last name of the first author.

    Handles:
    - ``"Last, First and Last2, First2"`` → ``"Last"``
    - ``"Last, First"`` → ``"Last"``
    - ``"García-Marín, Isabel and …"`` → ``"García-Marín"``
    - ``"{GTEx Consortium}"`` (braced consortium) → ``"GTEx Consortium"``
    - ``None`` or empty → ``"Unknown"``
    """
    if not author_str or not author_str.strip():
        return "Unknown"

    s = author_str.strip()

    # Braced consortium: entire value is ``{…}`` → return stripped content
    if s.startswith("{") and s.endswith("}"):
        return s[1:-1].strip()

    # Split on " and " to get first author token
    first_token = re.split(r"\s+and\s+", s, maxsplit=1)[0].strip()

    # If the token itself is a consortium in braces, unwrap it
    if first_token.startswith("{") and first_token.endswith("}"):
        return first_token[1:-1].strip()

    # "Last, First …" — take everything before the first comma
    if "," in first_token:
        return first_token.split(",", 1)[0].strip()

    # Fallback: return the whole token (e.g. "Smith" with no comma)
    return first_token


# ---------------------------------------------------------------------------
# Entry parser
# ---------------------------------------------------------------------------

def parse_entry(entry_id: str, entry: dict) -> dict:
    """Convert a bibtexparser Entry (or entry-like dict) to a paper dict.

    Parameters
    ----------
    entry_id:
        The BibTeX key (``Entry.key``).
    entry:
        Either a real ``bibtexparser.model.Entry`` object or a dict with a
        ``"fields"`` key containing Field-like objects (for testing).

    Returns a dict with keys:
        id, title, authors, first_author, year, journal, abstract,
        doi, pmid, pmc, url, keywords
    """
    # Support both real Entry objects and test dicts
    if hasattr(entry, "fields"):
        fields_list = entry.fields
    else:
        fields_list = entry.get("fields", [])

    # Build a quick lookup: field key → value (str)
    raw: dict[str, str] = {}
    for f in fields_list:
        raw[f.key.lower()] = str(f.value) if f.value is not None else ""

    def get(key: str) -> Optional[str]:
        v = raw.get(key)
        if v is None:
            return None
        v = _clean_text(v)
        return v if v else None

    author_raw = get("author")
    authors = _semicolon_authors(author_raw) if author_raw else None
    first_author = extract_first_author(author_raw)

    return {
        "id": entry_id,
        "title": get("title"),
        "authors": authors,
        "first_author": first_author,
        "year": _parse_year(get("year")),
        "journal": get("journal"),
        "abstract": get("abstract"),
        "doi": get("doi"),
        "pmid": get("pmid"),
        "pmc": get("pmc"),
        "url": get("url"),
        "keywords": get("keywords"),
    }


# ---------------------------------------------------------------------------
# File parser
# ---------------------------------------------------------------------------

def parse_bib_file(path: str) -> list[dict]:
    """Parse a BibTeX file and return a list of paper dicts.

    Uses the bibtexparser v2 beta API (``bibtexparser.parse_file``).
    Entries without a ``title`` field are silently skipped.

    Parameters
    ----------
    path:
        Absolute or relative path to the ``.bib`` file.

    Returns
    -------
    list[dict]
        One dict per entry (see :func:`parse_entry` for schema).
    """
    bib_db = bibtexparser.parse_file(path)

    papers: list[dict] = []
    for entry in bib_db.entries:
        # Build raw field lookup to check for title
        raw: dict[str, str] = {f.key.lower(): str(f.value) for f in entry.fields}
        title_raw = raw.get("title", "").strip()
        if not title_raw:
            continue  # skip entries without title

        paper = parse_entry(entry.key, entry)
        papers.append(paper)

    return papers
