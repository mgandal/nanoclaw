"""Deterministic 4-axis scorer + body-structure pre-flight gate.

Each axis returns (score: float, feedback: str). Feedback is
reflection-quality prose (GEPA-ready: matches GEPAFeedbackMetric).
"""
from __future__ import annotations
import re
import yaml
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class EvalCase:
    prompt: str
    expected_path_regex: str
    expected_tags_subset: list[str]
    expected_type: str = ""  # optional: paper, synthesis, etc.


@dataclass
class RubricResult:
    eligible: bool
    axis_scores: dict[str, tuple[float, str]] = field(default_factory=dict)
    mean_score: float = 0.0
    written_files: list[Path] = field(default_factory=list)
    preflight_feedback: str = ""


def _parse_frontmatter(text: str) -> tuple[dict | None, str]:
    if not text.startswith("---\n"):
        return None, text
    try:
        end = text.index("\n---\n", 4)
    except ValueError:
        return None, text
    fm_text = text[4:end]
    body = text[end + 5:]
    try:
        fm = yaml.safe_load(fm_text)
    except yaml.YAMLError:
        return None, body
    return fm if isinstance(fm, dict) else None, body


def _list_written_files(scratch_vault: Path) -> list[Path]:
    return sorted(p for p in scratch_vault.rglob("*.md")
                  if str(p.relative_to(scratch_vault)).startswith("wiki/") or
                  str(p.relative_to(scratch_vault)).startswith("10-daily/"))


def _score_folder_routing(written: list[Path], scratch_vault: Path, case: EvalCase) -> tuple[float, str]:
    if not written:
        return 0.0, "No wiki page written. Variant may have failed to invoke Write tool."
    rels = [str(p.relative_to(scratch_vault)) for p in written]
    pattern = re.compile(case.expected_path_regex)
    if any(pattern.match(r) for r in rels):
        return 1.0, f"OK: wrote {rels[0]} matching {case.expected_path_regex}"
    expected_parent = case.expected_path_regex.split("/")[0:2]
    expected_parent_str = "/".join(expected_parent).replace("^", "")
    if any(r.startswith(expected_parent_str.split(".")[0]) for r in rels):
        return 0.5, f"PARTIAL: wrote {rels[0]}, expected parent {expected_parent_str} but full path mismatch"
    return 0.0, (
        f"WRONG FOLDER: wrote {rels[0]}. "
        f"Expected match for {case.expected_path_regex}. "
        f"Prompt: {case.prompt[:80]!r}"
    )


def _score_frontmatter_parse(written: list[Path], rubric: dict) -> tuple[float, str]:
    if not written:
        return 0.0, "No file written; cannot parse frontmatter."
    page = written[0]
    fm, _ = _parse_frontmatter(page.read_text())
    if fm is None:
        return 0.0, "Frontmatter did not parse as YAML or no --- delimiters."
    axis_spec = next(a for a in rubric["scored_axes"] if a["name"] == "frontmatter_parse")
    required = axis_spec["required_keys"]
    missing = [k for k in required if k not in fm]
    if missing:
        return 0.0, f"Frontmatter missing required keys: {missing}"
    tags = fm.get("tags", [])
    if not isinstance(tags, list) or not any(str(t).startswith("wiki/") for t in tags):
        return 0.0, f"No wiki/<type> tag in tags: {tags}"
    return 1.0, f"OK: frontmatter has all {len(required)} required keys + wiki/<type> tag"


def _score_tag_set(written: list[Path], case: EvalCase) -> tuple[float, str]:
    if not written:
        return 0.0, "No file written."
    fm, _ = _parse_frontmatter(written[0].read_text())
    if fm is None:
        return 0.0, "Frontmatter did not parse."
    tags = set(str(t) for t in fm.get("tags", []))
    missing = [t for t in case.expected_tags_subset if t not in tags]
    if missing:
        return 0.0, f"Missing tags: {missing}. Got: {sorted(tags)}"
    return 1.0, f"OK: all expected tags present"


def _preflight_body_structure(written: list[Path], rubric: dict) -> tuple[bool, str]:
    if not written:
        return False, "No files written."
    fm, body = _parse_frontmatter(written[0].read_text())
    if fm is None:
        return False, "Frontmatter unparseable; cannot determine page type."
    page_type = fm.get("type", "")
    required_sections = rubric["preflight_gate"]["required_sections_by_type"].get(page_type, [])
    missing = [s for s in required_sections if s not in body]
    if missing:
        return False, f"page type {page_type!r} requires sections {missing}"
    return True, "OK"


def score_axes(case: EvalCase, scratch_vault: Path, rubric_path: Path) -> RubricResult:
    rubric = yaml.safe_load(rubric_path.read_text())
    written = _list_written_files(scratch_vault)
    eligible, preflight_fb = _preflight_body_structure(written, rubric)
    if not eligible:
        return RubricResult(eligible=False, written_files=written, preflight_feedback=preflight_fb)
    axis_scores = {
        "folder_routing": _score_folder_routing(written, scratch_vault, case),
        "frontmatter_parse": _score_frontmatter_parse(written, rubric),
        "tag_set": _score_tag_set(written, case),
    }
    mean = sum(s for s, _ in axis_scores.values()) / len(axis_scores)
    return RubricResult(eligible=True, axis_scores=axis_scores, mean_score=mean,
                        written_files=written, preflight_feedback=preflight_fb)
