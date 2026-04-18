"""Ollama-based entity/edge extraction for the knowledge graph.

Pure logic + a local HTTP call; no filesystem walking, no DB writes. The
bulk runner (session 2) wraps this with batching, resumable state, and
resolver/merge logic.

Design:
  - Prompt is kept small and explicit — enumerated entity types + a
    worked example so phi4-mini outputs the right shape on the first
    token. JSON format=json constrains decoding.
  - We ask the model only for entities + edges in the doc, not for
    resolution against an existing graph. Resolution is the resolver's
    job (session 2), so this module stays pure and easy to test.
  - Parsing is defensive: malformed JSON, missing keys, unknown types,
    and phantom edges are all tolerated — the doc's extraction becomes
    whatever survived filtering. Over 2k docs we expect a few bad
    responses and should not crash the whole run.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


_FRONTMATTER_BLOCK = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)


def strip_frontmatter(text: str) -> str:
    """Remove leading YAML frontmatter so the model never sees `tags:` lists
    or similar metadata as extractable content. Non-destructive if no
    frontmatter is present."""
    if not text:
        return text
    return _FRONTMATTER_BLOCK.sub("", text, count=1)


DEFAULT_OLLAMA_URL = "http://localhost:11434/api/generate"
DEFAULT_MODEL = "phi4-mini"
DEFAULT_TIMEOUT_S = 60.0

# Phi4-mini context window is ~128k tokens; cap doc body at ~16k chars to
# keep prompts fast (a page of markdown is ~2-3k chars). Meeting-note-sized
# docs fit comfortably; a huge wiki page is truncated with a marker.
MAX_DOC_CHARS = 12_000

ALLOWED_ENTITY_TYPES: tuple[str, ...] = (
    "person",
    "project",
    "grant",
    "tool",
    "dataset",
    "paper",
    "method",
    "institution",
    "disorder",
)

ALLOWED_RELATIONS: tuple[str, ...] = (
    "authored",
    "collaborates_with",
    "advises",
    "member_of",
    "affiliated_with",
    "cites",
    "uses_method",
    "uses_dataset",
    "relevant_to_grant",
    "relevant_to_project",
    "funds_project",
    "funds_person",
    "related_to_disorder",
    "implements_method",
    "tested_on_dataset",
    "used_by_project",
    "related_to",
    "mentioned_in",
)


class ExtractionError(RuntimeError):
    """Raised when extraction cannot produce a usable result."""


@dataclass
class ExtractionResult:
    entities: list[dict] = field(default_factory=list)
    edges: list[dict] = field(default_factory=list)
    source_doc: str = ""


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------


_PROMPT_TEMPLATE = """\
You extract entities and typed relationships from research lab documents.

Return ONLY valid JSON — no prose, no markdown fences, no commentary.

Schema:
{{
  "entities": [
    {{"name": "<canonical name>", "type": "<one of: {types}>"}}
  ],
  "edges": [
    {{
      "source": "<name from entities[]>",
      "source_type": "<type>",
      "target": "<name from entities[]>",
      "target_type": "<type>",
      "relation": "<one of: {relations}>",
      "evidence": "<short phrase from the text>"
    }}
  ]
}}

TYPE GUIDANCE — pick the right type, not a generic one:
  - person: a named individual ("Rachel Smith", "Gandal, MJ"). Normalize "Gandal, MJ" -> "MJ Gandal".
  - grant: an award with an identifier (R01-MH137578, K99MH137253, SFARI #957585). NIH, NIMH, SFARI on their own are INSTITUTIONS, not grants.
  - institution: an organization that employs people or funds research (NIH, NIMH, UCLA, MGH, Penn).
  - project: a named scientific endeavor ("BrainGO", "iso-TWAS", "APA atlas"). Not a generic task.
  - tool: a software package or pipeline ("susieR", "flash", "FUMA").
  - dataset: a named resource of biological data ("Siletti brain atlas", "PsychENCODE").
  - paper: a publication reference — only include when clearly referencing a paper, not just a topic.
  - method: an analytical technique (only extract if named, not generic).
  - disorder: named disease or condition ("autism", "schizophrenia", "ASD").

RULES:
  1. Extract only entities NAMED in the prose or in tables. Do NOT extract items that only appear in YAML frontmatter `tags:` lists or `category:` lists — those are keywords, not entities.
  2. When a markdown table has rows like "Mentor | Gandal, MJ" or "PI (Trainee) | Kuo, Szu-Yu Susan", extract both the role and the person — the person is a `person` entity.
  3. Use `advises` for mentor/advisor relationships. Use `funds_person` when a grant funds a trainee. Use `affiliated_with` for person -> institution.
  4. Use `authored` ONLY for paper authorship. Someone "presenting on" a tool or "discussing" a method is NOT authorship — skip the edge.
  5. Every edge's source and target MUST appear in your entities[] list. Never invent endpoints.
  6. When unsure about an entity, a type, or a relation: OMIT it. A smaller, correct extraction is better than a wrong one.
  7. Empty arrays are fine.

Example input:
---
type: grant
tags: [grant, current, ASD]
---
# R01-MH137578

| Role | Name |
|------|------|
| PI | Gandal, MJ |
| Trainee | Kuo, Szu-Yu Susan (MGH) |

Gandal mentors Kuo. Grant funded by NIMH.

Example output:
{{
  "entities": [
    {{"name": "R01-MH137578", "type": "grant"}},
    {{"name": "MJ Gandal", "type": "person"}},
    {{"name": "Szu-Yu Susan Kuo", "type": "person"}},
    {{"name": "MGH", "type": "institution"}},
    {{"name": "NIMH", "type": "institution"}}
  ],
  "edges": [
    {{"source": "MJ Gandal", "source_type": "person", "target": "Szu-Yu Susan Kuo", "target_type": "person", "relation": "advises", "evidence": "Gandal mentors Kuo"}},
    {{"source": "Szu-Yu Susan Kuo", "source_type": "person", "target": "MGH", "target_type": "institution", "relation": "affiliated_with", "evidence": "Kuo (MGH)"}},
    {{"source": "R01-MH137578", "source_type": "grant", "target": "Szu-Yu Susan Kuo", "target_type": "person", "relation": "funds_person", "evidence": "Trainee | Kuo"}}
  ]
}}

Note how `ASD` (a disorder in frontmatter tags) is NOT extracted — it only appeared in `tags:`, not in the body.

Source document: {source_doc}

TEXT:
{body}

JSON:
"""


def build_extraction_prompt(doc_text: str, source_doc: str) -> str:
    """Build the phi4-mini prompt for a single document.

    Strips YAML frontmatter up front so model can't extract keyword tags
    as entities, then truncates to MAX_DOC_CHARS.
    """
    body = strip_frontmatter(doc_text or "")
    if len(body) > MAX_DOC_CHARS:
        body = body[:MAX_DOC_CHARS] + "\n\n[...truncated]"
    return _PROMPT_TEMPLATE.format(
        types=", ".join(ALLOWED_ENTITY_TYPES),
        relations=", ".join(ALLOWED_RELATIONS),
        source_doc=source_doc or "<unknown>",
        body=body,
    )


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------


def parse_ollama_response(raw: str) -> ExtractionResult:
    """Parse the model's JSON response into a filtered, validated result.

    Lenient on missing optional fields and unknown types; strict on malformed
    JSON (that's the caller's signal to retry).
    """
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ExtractionError(f"malformed JSON from model: {e}") from e

    if not isinstance(obj, dict):
        raise ExtractionError("model response is not a JSON object")

    raw_entities = obj.get("entities") or []
    raw_edges = obj.get("edges") or []
    if not isinstance(raw_entities, list) or not isinstance(raw_edges, list):
        raise ExtractionError("entities/edges are not arrays")

    # Entities: filter + dedupe by (type, name)
    seen: set[tuple[str, str]] = set()
    entities: list[dict] = []
    allowed_types = set(ALLOWED_ENTITY_TYPES)
    for ent in raw_entities:
        if not isinstance(ent, dict):
            continue
        name = ent.get("name")
        etype = ent.get("type")
        if not isinstance(name, str) or not isinstance(etype, str):
            continue
        name = name.strip()
        etype = etype.strip().lower()
        if not name or etype not in allowed_types:
            continue
        key = (etype, name)
        if key in seen:
            continue
        seen.add(key)
        entities.append({"name": name, "type": etype})

    # Edges: both endpoints must reference an entity we kept
    known_names = {e["name"] for e in entities}
    allowed_relations = set(ALLOWED_RELATIONS)
    edges: list[dict] = []
    for edge in raw_edges:
        if not isinstance(edge, dict):
            continue
        source = edge.get("source")
        target = edge.get("target")
        relation = edge.get("relation")
        if not all(isinstance(x, str) for x in (source, target, relation)):
            continue
        source = source.strip()
        target = target.strip()
        relation = relation.strip().lower()
        if not source or not target or not relation:
            continue
        if relation not in allowed_relations:
            continue
        if source not in known_names or target not in known_names:
            continue
        edges.append(
            {
                "source": source,
                "source_type": edge.get("source_type", "").strip().lower() or None,
                "target": target,
                "target_type": edge.get("target_type", "").strip().lower() or None,
                "relation": relation,
                "evidence": (edge.get("evidence") or "").strip(),
            }
        )

    return ExtractionResult(entities=entities, edges=edges)


# ---------------------------------------------------------------------------
# Ollama HTTP call
# ---------------------------------------------------------------------------


def _call_ollama(
    prompt: str,
    model: str,
    ollama_url: str,
    timeout_s: float,
) -> str:
    """POST to /api/generate, return the `response` field (the model output)."""
    payload = json.dumps(
        {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        ollama_url,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read()
    except urllib.error.URLError as e:
        raise ExtractionError(f"Ollama connection failed: {e}") from e
    except TimeoutError as e:
        raise ExtractionError(f"Ollama timed out after {timeout_s}s") from e

    try:
        envelope = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise ExtractionError(f"Ollama envelope not JSON: {e}") from e

    response = envelope.get("response")
    if not isinstance(response, str):
        raise ExtractionError("Ollama response missing 'response' string")
    return response


# ---------------------------------------------------------------------------
# Top-level entrypoint
# ---------------------------------------------------------------------------


def extract_from_doc(
    doc_text: str,
    source_doc: str,
    *,
    model: str = DEFAULT_MODEL,
    ollama_url: str = DEFAULT_OLLAMA_URL,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    max_retries: int = 2,
) -> ExtractionResult:
    """Extract entities and edges from a single document.

    Retries up to `max_retries` total attempts on malformed-JSON. HTTP errors
    raise ExtractionError immediately (caller decides retry policy).
    """
    if not doc_text or not doc_text.strip():
        return ExtractionResult(source_doc=source_doc)

    prompt = build_extraction_prompt(doc_text, source_doc)
    last_err: Exception | None = None
    for attempt in range(max(1, max_retries)):
        try:
            raw = _call_ollama(prompt, model, ollama_url, timeout_s)
            result = parse_ollama_response(raw)
            result.source_doc = source_doc
            return result
        except ExtractionError as e:
            last_err = e
            # Backoff only on non-HTTP errors; connection failures already
            # raised from _call_ollama above via ExtractionError as well,
            # but those reflect a down service — retrying immediately is fine.
            if attempt < max_retries - 1:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise

    # Unreachable — the loop either returns or raises.
    raise ExtractionError(f"extraction exhausted retries: {last_err}")  # pragma: no cover
