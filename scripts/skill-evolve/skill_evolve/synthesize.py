"""Synthesize eval cases.

Per spec C3: reads CONVENTIONS.md (data schema) and wiki-golden.yaml
(prompt topic distribution) only. Does NOT read SKILL.md (the
optimization target — reading it would re-create the tautology).
"""
from __future__ import annotations
import json
import yaml
from dataclasses import dataclass
from pathlib import Path
from anthropic import Anthropic
from . import config


@dataclass
class SyntheticCase:
    prompt: str
    expected_path_regex: str
    expected_tags_subset: list[str]


SYNTH_SYSTEM_PROMPT = """You are generating evaluation cases for a wiki-maintenance skill.

You will be given:
1. CONVENTIONS.md — the data schema (folder layout, page types, tag conventions)
2. Operator-pinned golden cases — examples of prompt-topics the operator considers important

Your job: generate {target_count} NEW evaluation cases that:
- Are realistic user prompts an agent might receive
- Cover the topic distribution suggested by the golden cases (papers, meetings, syntheses, tools)
- Have an `expected_path_regex` derived from the CONVENTIONS.md routing table (NOT from any procedural skill)
- Have an `expected_tags_subset` that any compliant page must include (per CONVENTIONS.md tag conventions)

Output a JSON array of objects with keys: prompt, expected_path_regex, expected_tags_subset.

Do NOT copy the golden prompts. Do NOT generate duplicates of each other.
"""


def synthesize_cases(
    conventions_path: Path,
    golden_path: Path,
    target_count: int,
    client: Anthropic | None = None,
) -> list[SyntheticCase]:
    if client is None:
        client = Anthropic(base_url=config.load_anthropic_base_url(), api_key="placeholder")
    conventions = conventions_path.read_text()
    golden_raw = yaml.safe_load(golden_path.read_text()) or {"cases": []}
    golden = golden_raw.get("cases", [])

    user_msg = (
        f"# CONVENTIONS.md\n\n{conventions}\n\n"
        f"# Operator-pinned golden cases (topic-distribution reference; do NOT copy)\n\n"
        f"```yaml\n{yaml.safe_dump(golden)}\n```\n\n"
        f"Generate {target_count} new synthetic cases as a JSON array."
    )

    resp = client.messages.create(
        model=config.DEFAULT_MODEL,
        max_tokens=4096,
        temperature=config.DEFAULT_TEMPERATURE,
        system=SYNTH_SYSTEM_PROMPT.format(target_count=target_count),
        messages=[{"role": "user", "content": user_msg}],
    )

    text = resp.content[0].text
    start = text.find("[")
    end = text.rfind("]") + 1
    if start == -1 or end == 0:
        raise RuntimeError(f"Synthesizer returned no JSON array: {text[:200]!r}")
    data = json.loads(text[start:end])
    return [SyntheticCase(**c) for c in data][:target_count]
