"""Render evolution-report.md.

Sections per spec:
1. Eval-delta table (per-axis baseline vs winner)
2. Sample diffs
3. Realism check (VAULT-claw deltas)
4. Size delta + 15KB hard-fail flag
5. Semantic preservation
6. Cost & wall-clock
7. Rollback runbook (with vault-blame ripgrep one-liner)
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SampleDiff:
    prompt: str
    baseline_output: str
    variant_output: str
    delta: float


@dataclass
class RealismCheckEntry:
    prompt: str
    baseline_axis_scores: dict[str, float]
    variant_axis_scores: dict[str, float]
    source_session: str


@dataclass
class ReportInputs:
    run_id: str
    skill: str
    baseline_score: float
    winner_score: float
    noise_floor: float
    merge_threshold: float
    per_axis_baseline: dict[str, float]
    per_axis_winner: dict[str, float]
    sample_diffs: list[SampleDiff]
    realism_check: list[RealismCheckEntry]
    size_baseline_bytes: int
    size_winner_bytes: int
    cost_usd: float
    intentional_drops: list[str]
    rollback_runbook_run_id: str


def render_report(inp: ReportInputs) -> str:
    lines: list[str] = []
    lines.append(f"# skill-evolve report: {inp.skill} run {inp.run_id}")
    lines.append("")
    lines.append(f"- baseline score: **{inp.baseline_score:.3f}**")
    lines.append(f"- winner score: **{inp.winner_score:.3f}**")
    lines.append(f"- delta: **+{inp.winner_score - inp.baseline_score:.3f}** "
                 f"(threshold >= {inp.merge_threshold:.3f}, noise_floor {inp.noise_floor:.3f})")
    lines.append(f"- total cost: **${inp.cost_usd:.2f}**")
    lines.append("")

    lines.append("## Per-axis scores")
    lines.append("")
    lines.append("| axis | baseline | winner | delta |")
    lines.append("|---|---|---|---|")
    axes = sorted(set(inp.per_axis_baseline) | set(inp.per_axis_winner))
    for ax in axes:
        b = inp.per_axis_baseline.get(ax, 0.0)
        w = inp.per_axis_winner.get(ax, 0.0)
        lines.append(f"| {ax} | {b:.2f} | {w:.2f} | {w - b:+.2f} |")
    lines.append("")

    lines.append("## Size delta")
    lines.append(f"- baseline: {inp.size_baseline_bytes} bytes")
    lines.append(f"- winner: {inp.size_winner_bytes} bytes")
    if inp.size_winner_bytes > 15000:
        lines.append(f"- **HARD FAIL**: winner exceeds 15KB cap")
    lines.append("")

    if inp.sample_diffs:
        lines.append("## Sample diffs (variant beat baseline by >= threshold)")
        for i, d in enumerate(inp.sample_diffs, 1):
            lines.append(f"### Diff {i} (delta {d.delta:+.2f})")
            lines.append(f"**Prompt:** {d.prompt}")
            lines.append("")
            lines.append("**Baseline output:**")
            lines.append(f"```\n{d.baseline_output}\n```")
            lines.append("**Variant output:**")
            lines.append(f"```\n{d.variant_output}\n```")
            lines.append("")

    if inp.realism_check:
        lines.append("## Realism check (real VAULT-claw prompts)")
        lines.append("| prompt | baseline mean | winner mean | source session |")
        lines.append("|---|---|---|---|")
        for r in inp.realism_check:
            bmean = sum(r.baseline_axis_scores.values()) / len(r.baseline_axis_scores) if r.baseline_axis_scores else 0
            wmean = sum(r.variant_axis_scores.values()) / len(r.variant_axis_scores) if r.variant_axis_scores else 0
            short = (r.prompt[:60] + "...") if len(r.prompt) > 60 else r.prompt
            lines.append(f"| {short} | {bmean:.2f} | {wmean:.2f} | {r.source_session} |")
        lines.append("")

    if inp.intentional_drops:
        lines.append("## Intentional drops")
        for d in inp.intentional_drops:
            lines.append(f"- {d}")
        lines.append("")

    lines.append("## Rollback runbook")
    lines.append("If this variant is merged and causes problems:")
    lines.append("")
    lines.append("```bash")
    lines.append(f"# 1. Revert the SKILL.md change")
    lines.append(f"git revert <merge-sha>")
    lines.append("")
    lines.append(f"# 2. Enumerate every wiki page written by this variant")
    lines.append(f'rg "skill_version: skill-evolve/wiki-{inp.rollback_runbook_run_id}" \\')
    lines.append(f'   /Volumes/sandisk4TB/marvin-vault/98-nanoKB/')
    lines.append("")
    lines.append(f"# 3. Smoke test post-revert (3 golden prompts)")
    lines.append(f"cd scripts/skill-evolve && venv/bin/python -m skill_evolve --skill wiki --num-variants 0 --golden-only")
    lines.append("```")
    return "\n".join(lines) + "\n"
