"""Claude as mutator. Produces N variants of SKILL.md in a single call.

The mutator sees baseline scores + per-axis feedback (reflection-quality
prose from rubric.py) so it can target specific failure modes — this is
the substitute for GEPA's reflective signal in v1.
"""
from __future__ import annotations
import re
from dataclasses import dataclass
from anthropic import Anthropic
from . import config


@dataclass
class AxisFeedback:
    axis: str
    score: float
    feedback: str


MUTATOR_SYSTEM_PROMPT = """You are rewriting a skill's procedural instructions to improve it.

You will be given:
1. The current SKILL.md (the baseline)
2. Per-axis scores + feedback from running the baseline against an eval set

Your job: produce N distinct variant rewrites of SKILL.md. Each variant should target a different aspect of the feedback — don't make all variants do the same thing. Variants should preserve the skill's intent and all CONVENTIONS.md references, but may rewrite the procedural steps freely.

Output format:

VARIANT_1:
```
<full SKILL.md text for variant 1>
```

VARIANT_2:
```
<full SKILL.md text for variant 2>
```

(... up to VARIANT_N)

Rules:
- Each variant ≤15KB (the gate will reject larger).
- Each variant must keep the `@CONVENTIONS.md` reference.
- Each variant must keep instructions to stamp `skill_version:` frontmatter.
- Do not add MCP tool references (the eval harness has no MCPs).
"""


_VARIANT_RE = re.compile(r"VARIANT_(\d+):\s*\n```(?:\w+)?\n(.*?)\n```", re.DOTALL)


def generate_variants(
    baseline_skill: str,
    baseline_axis_feedback: list[AxisFeedback],
    n: int,
    client: Anthropic | None = None,
) -> list[str]:
    if client is None:
        client = Anthropic(base_url=config.load_anthropic_base_url(), api_key="placeholder")

    feedback_text = "\n".join(
        f"- {fb.axis} (score {fb.score:.2f}): {fb.feedback}"
        for fb in baseline_axis_feedback
    ) or "(no per-axis feedback; produce diverse rewrites of your own initiative)"

    user_msg = (
        f"# Current SKILL.md\n\n```\n{baseline_skill}\n```\n\n"
        f"# Baseline axis scores + feedback\n\n{feedback_text}\n\n"
        f"Produce {n} variants per the system instructions."
    )

    resp = client.messages.create(
        model=config.DEFAULT_MODEL,
        max_tokens=8192,
        temperature=config.DEFAULT_TEMPERATURE,
        system=MUTATOR_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    text = resp.content[0].text
    matches = _VARIANT_RE.findall(text)
    variants = [body.strip() for _, body in matches]
    if len(variants) != n:
        raise RuntimeError(f"expected {n} variants, got {len(variants)}: {text[:200]!r}")
    return variants
