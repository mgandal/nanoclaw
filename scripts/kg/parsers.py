"""Deterministic parsers for the knowledge graph Phase 1 seed.

Pure functions: take raw file content in, return structured dicts. No I/O,
no database writes. This keeps them unit-testable and side-effect-free.

Entity shape:
    {
        "canonical_name": str,
        "type": str,
        "metadata": dict,   # JSON-serializable
        "aliases": list[str],
        "source_doc": str,
    }

Edge shape:
    {
        "source": str,       # entity canonical_name (resolved via alias at insert time)
        "source_type": str,
        "target": str,
        "target_type": str,
        "relation": str,
        "evidence": str,
        "source_doc": str,
    }
"""

from __future__ import annotations

import re
from typing import Any

import yaml


_FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_GRANT_HEADING = re.compile(
    r"^###\s+(?:NIH\s+)?([A-Z]+\d*-[A-Z]{2}\d+|[A-Z]+\s+[A-Za-z]+\s+#?\d+)",
    re.MULTILINE,
)
_PROJECT_HEADING = re.compile(r"^###\s+(.+?)$", re.MULTILINE)
_ROSTER_TABLE_ROW = re.compile(
    r"^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|", re.MULTILINE
)


def _parse_frontmatter(text: str) -> dict[str, Any] | None:
    match = _FRONTMATTER.match(text)
    if not match:
        return None
    try:
        return yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        return None


# ---------------------------------------------------------------------------
# Person alias generation
# ---------------------------------------------------------------------------


def generate_person_aliases(full_name: str, email: str | None = None) -> list[str]:
    """Generate common name variants for a person.

    Conservative: handles Western-order first/middle/last with optional middle
    initial, hyphenated last names ("Alexander-Bloch"), and email local-part
    as a handle. Explicitly does NOT try to guess name order for non-Western
    names — those get only the original form.

    Returns a deduplicated list including the canonical form.
    """
    aliases: set[str] = set()
    name = (full_name or "").strip()
    if not name:
        return []
    aliases.add(name)

    parts = [p for p in name.split() if p]
    if len(parts) >= 2:
        first = parts[0]
        last = parts[-1]
        middles = parts[1:-1]

        # "Michael Gandal" (first last, no middle)
        aliases.add(f"{first} {last}")
        # "Gandal, Michael"
        aliases.add(f"{last}, {first}")
        # "Gandal M" / "Gandal MJ" (initials after last)
        if middles:
            initials = "".join(m[0] for m in middles if m)
            aliases.add(f"{last} {first[0]}{initials}")
            aliases.add(f"{last}, {first[0]}.{''.join(f' {m[0]}.' for m in middles)}")
        else:
            aliases.add(f"{last} {first[0]}")
        # "Gandal, M."
        aliases.add(f"{last}, {first[0]}.")

    # Email local part ("mgandal@...") → "mgandal"
    if email and "@" in email:
        handle = email.split("@", 1)[0]
        if handle:
            aliases.add(handle)

    return sorted(aliases)


# ---------------------------------------------------------------------------
# Contact files (20-contacts/*.md)
# ---------------------------------------------------------------------------


_H1_LINE = re.compile(r"^#[ \t]+([^\n]+?)[ \t]*$", re.MULTILINE)


def parse_contact(text: str, source_doc: str) -> dict | None:
    """Parse a contact markdown file into a person entity.

    Two tiers:
      - YAML frontmatter present → confidence 1.0 entity with metadata + edges.
      - No frontmatter but an H1 heading at the top → confidence 0.7 entity
        (name-only, no metadata, no edges). These are typically calendar-
        derived contact stubs.

    Returns None only if neither a YAML `name` nor a top-level H1 is found.
    """
    fm = _parse_frontmatter(text)

    if fm:
        name = fm.get("name")
        if name and isinstance(name, str) and name.strip():
            email = fm.get("email") if isinstance(fm.get("email"), str) else None
            metadata = {
                k: v
                for k, v in fm.items()
                if k in {"email", "institution", "role", "stage", "status"}
                and isinstance(v, (str, int, float, bool))
                and v != ""
            }

            projects = fm.get("projects") or []
            project_edges: list[dict] = []
            if isinstance(projects, list):
                for proj in projects:
                    if isinstance(proj, str) and proj.strip():
                        project_edges.append(
                            {
                                "source": name.strip(),
                                "source_type": "person",
                                "target": proj.strip(),
                                "target_type": "project",
                                "relation": "member_of",
                                "evidence": f"projects[] in {source_doc}",
                                "source_doc": source_doc,
                            }
                        )

            return {
                "entity": {
                    "canonical_name": name.strip(),
                    "type": "person",
                    "metadata": metadata,
                    "aliases": generate_person_aliases(name.strip(), email),
                    "source_doc": source_doc,
                    "confidence": 1.0,
                },
                "edges": project_edges,
            }

    # Fallback: look for the first H1 heading in the document body.
    # If frontmatter existed, _FRONTMATTER strips only the "---\n...\n---\n"
    # prefix; the H1 appears right after.
    body = _FRONTMATTER.sub("", text, count=1)
    h1 = _H1_LINE.search(body)
    if not h1:
        return None
    h1_name = h1.group(1).strip()
    # Defensive: a leading "# " for "# Claire" or templates — reject too-short
    # or placeholder-looking names.
    if len(h1_name) < 2 or h1_name.startswith("{{"):
        return None
    return {
        "entity": {
            "canonical_name": h1_name,
            "type": "person",
            "metadata": {"source": "h1_fallback"},
            "aliases": generate_person_aliases(h1_name),
            "source_doc": source_doc,
            "confidence": 0.7,
        },
        "edges": [],
    }


# ---------------------------------------------------------------------------
# Wiki tool files (99-wiki/tools/*.md)
# ---------------------------------------------------------------------------


def parse_tool(text: str, source_doc: str) -> dict | None:
    fm = _parse_frontmatter(text)
    if not fm:
        return None
    name = fm.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    name = name.strip()
    metadata = {
        k: v
        for k, v in fm.items()
        if k
        in {
            "url",
            "language",
            "license",
            "category",
            "version",
            "we_use",
            "hpc_available",
        }
        and isinstance(v, (str, int, float, bool))
        and v != ""
    }

    edges: list[dict] = []

    # related_tools — sibling wiki links
    for other in _as_list(fm.get("related_tools")):
        if isinstance(other, str) and other.strip():
            edges.append(_make_edge(name, "tool", other.strip(), "tool", "related_to", source_doc))

    # key_papers — paper references
    for paper in _as_list(fm.get("key_papers")):
        if isinstance(paper, str) and paper.strip():
            edges.append(_make_edge(name, "tool", paper.strip(), "paper", "cites", source_doc))

    # relevant_projects
    for proj in _as_list(fm.get("relevant_projects")):
        if isinstance(proj, str) and proj.strip():
            edges.append(
                _make_edge(name, "tool", proj.strip(), "project", "used_by_project", source_doc)
            )

    # datasets_tested
    for ds in _as_list(fm.get("datasets_tested")):
        if isinstance(ds, str) and ds.strip():
            edges.append(
                _make_edge(name, "tool", ds.strip(), "dataset", "tested_on_dataset", source_doc)
            )

    return {
        "entity": {
            "canonical_name": name,
            "type": "tool",
            "metadata": metadata,
            "aliases": [name],
            "source_doc": source_doc,
        },
        "edges": edges,
    }


# ---------------------------------------------------------------------------
# Wiki dataset files (99-wiki/datasets/*.md)
# ---------------------------------------------------------------------------


def parse_dataset(text: str, source_doc: str) -> dict | None:
    fm = _parse_frontmatter(text)
    if not fm:
        return None
    name = fm.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    name = name.strip()
    acronym = fm.get("acronym") if isinstance(fm.get("acronym"), str) else None
    metadata = {
        k: v
        for k, v in fm.items()
        if k
        in {
            "url",
            "maintainer",
            "sample_size",
            "access_model",
            "we_have_access",
        }
        and isinstance(v, (str, int, float, bool))
        and v != ""
    }

    aliases = [name]
    if acronym and acronym.strip():
        aliases.append(acronym.strip())

    edges: list[dict] = []
    for paper in _as_list(fm.get("key_papers")):
        if isinstance(paper, str) and paper.strip():
            edges.append(
                _make_edge(name, "dataset", paper.strip(), "paper", "cites", source_doc)
            )
    for other in _as_list(fm.get("related_datasets")):
        if isinstance(other, str) and other.strip():
            edges.append(
                _make_edge(name, "dataset", other.strip(), "dataset", "related_to", source_doc)
            )

    for dis in _as_list(fm.get("disorders")):
        if isinstance(dis, str) and dis.strip():
            edges.append(
                _make_edge(
                    name, "dataset", dis.strip(), "disorder", "related_to_disorder", source_doc
                )
            )

    return {
        "entity": {
            "canonical_name": name,
            "type": "dataset",
            "metadata": metadata,
            "aliases": aliases,
            "source_doc": source_doc,
        },
        "edges": edges,
    }


# ---------------------------------------------------------------------------
# Wiki paper files (99-wiki/papers/*.md)
# ---------------------------------------------------------------------------


def parse_paper(text: str, source_doc: str) -> dict | None:
    fm = _parse_frontmatter(text)
    if not fm:
        return None

    # Papers may use different naming fields — prefer title, fall back to doi-based id
    doi = fm.get("doi") if isinstance(fm.get("doi"), str) else None
    first_author = fm.get("first_author") if isinstance(fm.get("first_author"), str) else None
    year = fm.get("year")
    journal = fm.get("journal") if isinstance(fm.get("journal"), str) else None

    # Canonical name = "first-author year journal" or DOI
    if first_author and year:
        canonical = f"{first_author} {year}"
        if journal:
            canonical += f" ({journal})"
    elif doi:
        canonical = f"doi:{doi}"
    else:
        return None

    metadata = {}
    for k in ("doi", "pmid", "first_author", "year", "journal", "lab_relevance"):
        v = fm.get(k)
        if isinstance(v, (str, int, float, bool)) and v != "":
            metadata[k] = v

    aliases = [canonical]
    if doi:
        aliases.append(f"doi:{doi}")

    edges: list[dict] = []
    if isinstance(first_author, str) and first_author.strip():
        edges.append(
            _make_edge(first_author.strip(), "person", canonical, "paper", "authored", source_doc)
        )

    return {
        "entity": {
            "canonical_name": canonical,
            "type": "paper",
            "metadata": metadata,
            "aliases": aliases,
            "source_doc": source_doc,
        },
        "edges": edges,
    }


# ---------------------------------------------------------------------------
# State files
# ---------------------------------------------------------------------------


def parse_grants_file(text: str, source_doc: str) -> list[dict]:
    """Extract grant entities from groups/global/state/grants.md.

    Grants are identified by `### ...` headings containing a grant ID
    (e.g. "NIH R01-MH137578", "SFARI Targeted #957585").
    """
    entities: list[dict] = []
    seen: set[str] = set()
    for match in _GRANT_HEADING.finditer(text):
        grant_id = match.group(1).strip()
        if grant_id in seen:
            continue
        seen.add(grant_id)
        entities.append(
            {
                "entity": {
                    "canonical_name": grant_id,
                    "type": "grant",
                    "metadata": {},
                    "aliases": [grant_id],
                    "source_doc": source_doc,
                },
                "edges": [],
            }
        )
    return entities


def parse_projects_file(text: str, source_doc: str) -> list[dict]:
    """Extract project entities from groups/global/state/projects.md."""
    entities: list[dict] = []
    seen: set[str] = set()

    # Split by headings, process each section
    sections = re.split(r"^##\s+.+$", text, flags=re.MULTILINE)
    for section in sections:
        for heading in _PROJECT_HEADING.finditer(section):
            raw = heading.group(1).strip()
            # Project name is the first part before any parenthetical
            name = raw.split("(")[0].strip()
            if not name or name in seen:
                continue
            seen.add(name)
            entities.append(
                {
                    "entity": {
                        "canonical_name": name,
                        "type": "project",
                        "metadata": {"full_heading": raw},
                        "aliases": [name, raw] if raw != name else [name],
                        "source_doc": source_doc,
                    },
                    "edges": [],
                }
            )
    return entities


def parse_lab_roster(text: str, source_doc: str) -> list[dict]:
    """Extract person entities from the Current Members table in lab-roster.md.

    Only rows under the "## Current Members" section are parsed; collaborators
    and alumni tables are ignored (they belong to the contact files or a
    separate archive).
    """
    # Find the Current Members section
    current_match = re.search(
        r"##\s+Current Members\s*\n(.*?)(?=\n##\s+|\Z)", text, re.DOTALL
    )
    if not current_match:
        return []

    entities: list[dict] = []
    seen: set[str] = set()
    for row in _ROSTER_TABLE_ROW.finditer(current_match.group(1)):
        name = row.group(1).strip()
        role = row.group(2).strip()
        # Skip header / divider rows
        if name in ("Name", "", "----") or name.startswith("-") or name.startswith(":"):
            continue
        if name in seen:
            continue
        seen.add(name)
        entities.append(
            {
                "entity": {
                    "canonical_name": name,
                    "type": "person",
                    "metadata": {"role": role, "source": "lab-roster"},
                    "aliases": generate_person_aliases(name),
                    "source_doc": source_doc,
                },
                "edges": [],
            }
        )
    return entities


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _as_list(val: Any) -> list:
    if val is None:
        return []
    if isinstance(val, list):
        return val
    return [val]


def _make_edge(
    source: str,
    source_type: str,
    target: str,
    target_type: str,
    relation: str,
    source_doc: str,
) -> dict:
    return {
        "source": source,
        "source_type": source_type,
        "target": target,
        "target_type": target_type,
        "relation": relation,
        "evidence": f"frontmatter {relation} in {source_doc}",
        "source_doc": source_doc,
    }
