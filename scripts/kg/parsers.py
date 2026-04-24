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
_DOI = re.compile(r"\bdoi:\s*(10\.[\w./()-]+)", re.IGNORECASE)
_WIKI_PREFIX = re.compile(
    r"^(?:content/|wiki/|projects?/|active/|daily/|inbox/|areas?/|resources?/|"
    r"tools?/|papers?/|datasets?/)",
    re.IGNORECASE,
)
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


def _prose_project_edges(
    body: str,
    *,
    person_name: str,
    source_doc: str,
    known_projects: set[str] | frozenset[str] | None,
    skip_names: set[str],
) -> list[dict]:
    """Scan a contact body for mentions of known project names.

    For every project in `known_projects` that appears in the body as a
    whole word (case-insensitive), emit one `member_of` edge. Projects
    already in `skip_names` (lowercased frontmatter array entries) are
    skipped so we do not double-count. Returned edges are tagged with
    `evidence="prose mention in {source_doc}"` to distinguish them from
    frontmatter-sourced edges at query time.

    Word-boundary match via `\\b<name>\\b` prevents false positives like
    `APA` matching `APAthetic`. The body is assumed to have the YAML
    frontmatter already stripped — that is what `parse_contact` passes.
    """
    if not known_projects:
        return []
    seen: set[str] = set()
    edges: list[dict] = []
    # Sort for deterministic edge emission order — otherwise set iteration
    # is hash-randomized and run-to-run churn surfaces as changing edge
    # order in the DB (no functional impact but noisy diffs/logs).
    for proj in sorted(known_projects):
        proj_stripped = proj.strip()
        if not proj_stripped:
            continue
        if proj_stripped.lower() in skip_names:
            continue
        if proj_stripped.lower() in seen:
            continue
        pattern = re.compile(
            r"\b" + re.escape(proj_stripped) + r"\b",
            re.IGNORECASE,
        )
        if pattern.search(body):
            edges.append(
                {
                    "source": person_name,
                    "source_type": "person",
                    "target": proj_stripped,
                    "target_type": "project",
                    "relation": "member_of",
                    "evidence": f"prose mention in {source_doc}",
                    "source_doc": source_doc,
                }
            )
            seen.add(proj_stripped.lower())
    return edges


def parse_contact(
    text: str,
    source_doc: str,
    *,
    known_projects: set[str] | frozenset[str] | None = None,
) -> dict | None:
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
            frontmatter_project_names: set[str] = set()
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
                        frontmatter_project_names.add(proj.strip().lower())

            # KG contact-edges gap (2026-04-24): scan the BODY (not the
            # frontmatter region) for mentions of known project names. 384
            # of 420 contact files use prose ("Notes:", "Current Projects"
            # bullets) instead of the frontmatter `projects:` array, so
            # the array-only parser produced isolated person nodes. The
            # known_projects set is supplied by the ingest driver after
            # parsing state/projects.md, so false-positive risk is bounded
            # by the canonical project-name list.
            body = _FRONTMATTER.sub("", text, count=1)
            project_edges.extend(
                _prose_project_edges(
                    body,
                    person_name=name.strip(),
                    source_doc=source_doc,
                    known_projects=known_projects,
                    skip_names=frontmatter_project_names,
                )
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

    # Wiki-slug aliases: if source_doc is a path like "wiki/papers/huang-2026-longcallr.md"
    # or "99-wiki/papers/huang-2026.md", expose both the full path (sans extension)
    # and the basename as aliases. This lets other entities reference this paper
    # via frontmatter fields like key_papers: ["wiki/papers/huang-2026-longcallr"].
    if source_doc:
        # Strip known numeric prefix (e.g. "99-wiki/" → "wiki/") for canonical alias form
        normalized_path = re.sub(r"^\d+[-_]", "", source_doc)
        without_ext = re.sub(r"\.md$", "", normalized_path)
        aliases.append(without_ext)
        basename = without_ext.split("/")[-1]
        if basename and basename != without_ext:
            aliases.append(basename)

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


# ---------------------------------------------------------------------------
# Reference normalization — used by edge resolution to match path-style
# references (e.g. "wiki/tools/susier") against existing entity aliases.
# ---------------------------------------------------------------------------


def normalize_reference(ref: str) -> str:
    """Normalize an entity reference for fallback alias lookup.

    Strips:
      - [[wikilink]] brackets
      - leading/trailing whitespace and slashes
      - common vault path prefixes (content/, wiki/, tools/, papers/, datasets/)
      - numeric-prefix dirs like "99-wiki/" -> "wiki/" (handled by the above)
      - trailing .md extension

    Lowercases for case-insensitive match.
    """
    if not ref:
        return ""
    s = ref.strip()
    if not s:
        return ""
    # Strip wikilink brackets
    s = s.strip("[]")
    # Strip numeric prefix directories (e.g. "99-wiki/" → "wiki/")
    s = re.sub(r"^\d+[-_]", "", s)
    # Strip leading slash
    s = s.lstrip("/")
    # Strip trailing .md
    if s.endswith(".md"):
        s = s[:-3]
    # Strip known wiki path prefixes iteratively — so "content/wiki/tools/x"
    # collapses to "x" after two passes.
    for _ in range(3):
        stripped = _WIKI_PREFIX.sub("", s)
        if stripped == s:
            break
        s = stripped
    return s.lower().strip()


# ---------------------------------------------------------------------------
# Paper stub extraction — create paper entities from citation references
# found in other entities' edges, so those edges can resolve.
# ---------------------------------------------------------------------------


def extract_paper_stubs(
    entity_results: list[dict],
    known_paper_aliases: set[tuple[str, str]] | None = None,
) -> list[dict]:
    """Scan edges targeting papers and create stub paper entities.

    For each unique (target string) in edges where target_type == 'paper' and
    the target is not already a known alias, create a paper entity with:
      - canonical_name = the target string as-is
      - aliases = [canonical, extracted DOI if present, wiki-slug variants]
      - confidence = 0.6 (citation-derived, lower than YAML-backed papers)

    Args:
      entity_results: the list of {entity, edges} dicts from other parsers.
      known_paper_aliases: set of (entity_type, alias) tuples that already
        exist in the graph — stubs are skipped if their canonical or any
        extracted alias is already in this set.

    Returns a new list of {entity, edges} dicts for the stubs.
    """
    known = known_paper_aliases or set()
    by_canonical: dict[str, dict] = {}

    for result in entity_results:
        for edge in result.get("edges", []) or []:
            if edge.get("target_type") != "paper":
                continue
            target = (edge.get("target") or "").strip()
            if not target:
                continue

            aliases: list[str] = [target]

            # Extract DOI if present in the citation string
            doi_match = _DOI.search(target)
            if doi_match:
                doi_alias = f"doi:{doi_match.group(1).rstrip('.,;:')}"
                aliases.append(doi_alias)

            # If the target looks like a wiki path, expose the basename too
            if "/" in target or target.startswith("[["):
                # Strip brackets + leading known prefixes; surface both
                # the bracket-free form and the basename.
                clean = target.strip().strip("[]")
                if clean.endswith(".md"):
                    clean = clean[:-3]
                aliases.append(clean)
                basename = clean.split("/")[-1]
                if basename and basename not in aliases:
                    aliases.append(basename)

            # Skip if any of our would-be aliases already exists as a paper alias
            if any(("paper", a) in known for a in aliases):
                continue

            # Dedupe stubs by canonical
            if target in by_canonical:
                continue

            by_canonical[target] = {
                "entity": {
                    "canonical_name": target,
                    "type": "paper",
                    "metadata": {"source": "citation_stub"},
                    "aliases": _dedupe_preserve_order(aliases),
                    "source_doc": edge.get("source_doc", ""),
                    "confidence": 0.6,
                },
                "edges": [],
            }

    return list(by_canonical.values())


def _dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out
