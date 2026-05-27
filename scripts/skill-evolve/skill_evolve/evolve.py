"""Main optimization loop. Best-of-N with noise-floor calibration.

Per spec I2: runs baseline twice to measure noise_floor; merge threshold
is max(0.3, 3 × noise_floor). If noise_floor > 0.15, hard-fails.
"""
from __future__ import annotations
import statistics
from dataclasses import dataclass, field
from typing import Optional

from .rubric import RubricResult


NOISE_FLOOR_CEILING = 0.15
MIN_MERGE_DELTA = 0.3


class NoiseFloorTooHigh(RuntimeError):
    pass


@dataclass
class EvolveResult:
    baseline_score: float
    noise_floor: float
    merge_threshold: float
    variant_scores: list[tuple[str, list[RubricResult]]] = field(default_factory=list)
    winner_id: Optional[str] = None
    winner_score: float = 0.0
    winner_text: str = ""
    intentional_drops: list[str] = field(default_factory=list)
    run_id: str = ""


def compute_noise_floor(scores_run_a: list[float], scores_run_b: list[float]) -> float:
    """Noise floor = |mean(a) - mean(b)|."""
    if not scores_run_a or not scores_run_b:
        return 0.0
    return abs(statistics.mean(scores_run_a) - statistics.mean(scores_run_b))


def merge_threshold(noise_floor: float) -> float:
    return max(MIN_MERGE_DELTA, 3 * noise_floor)


def pick_winner(
    variant_scores: list[tuple[str, list[RubricResult]]]
) -> Optional[tuple[str, float]]:
    best_id, best_mean = None, -1.0
    for variant_id, results in variant_scores:
        eligible = [r for r in results if r.eligible]
        if not eligible:
            continue
        mean = statistics.mean(r.mean_score for r in eligible)
        if mean > best_mean:
            best_id, best_mean = variant_id, mean
    if best_id is None:
        return None
    return best_id, best_mean


def assert_noise_floor_acceptable(noise_floor: float) -> None:
    if noise_floor > NOISE_FLOOR_CEILING:
        raise NoiseFloorTooHigh(
            f"noise_floor = {noise_floor:.3f} > ceiling {NOISE_FLOOR_CEILING}. "
            "Rubric is too noisy to discriminate variants. Review temperature pinning "
            "or rubric design."
        )


import asyncio
import hashlib
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config
from .budget import BudgetTracker
from .harvest import harvest_real_prompts
from .liveness import count_wiki_writes
from .mutate import generate_variants, semantic_preservation_check, AxisFeedback
from .rubric import EvalCase, score_axes, RubricResult
from .sandbox import run_sandbox
from .synthesize import synthesize_cases


def _make_run_id(baseline_text: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    sha8 = hashlib.sha256(baseline_text.encode()).hexdigest()[:8]
    return f"{ts}-{sha8}"


async def _score_variant_async(
    variant_id: str, variant_text: str, cases: list[EvalCase],
    run_root: Path, claude_bin: Path, concurrency: int, conventions: Path,
    index_md: Path | None, budget: BudgetTracker,
) -> tuple[str, list[RubricResult]]:
    sem = asyncio.Semaphore(concurrency)

    async def one_case(idx: int, case: EvalCase) -> RubricResult:
        async with sem:
            scratch = run_root / "scratch-vaults" / f"{variant_id}_{idx}"
            loop = asyncio.get_event_loop()
            res = await loop.run_in_executor(
                None,
                lambda: run_sandbox(
                    variant_skill=variant_text,
                    prompt=case.prompt,
                    scratch_vault=scratch,
                    run_root=run_root,
                    claude_bin=claude_bin,
                    timeout_s=90,
                    conventions_source=conventions,
                    index_md_source=index_md,
                ),
            )
            return score_axes(case, scratch, config.rubrics_dir() / "wiki.yaml")

    results = await asyncio.gather(*[one_case(i, c) for i, c in enumerate(cases)])
    return variant_id, results


def run_evolve(
    skill: str,
    num_variants: int,
    max_budget: float,
    sandbox_concurrency: int,
    run_root: Path,
    claude_bin: Path = Path("claude"),
) -> EvolveResult:
    if skill != "wiki":
        raise NotImplementedError(f"v1 only supports wiki; got {skill}")

    baseline_text = config.wiki_skill_path().read_text()
    conventions_path = config.wiki_conventions_path()
    run_id = _make_run_id(baseline_text)
    run_root.mkdir(parents=True, exist_ok=True)

    budget = BudgetTracker(max_usd=max_budget)
    rubric_path = config.rubrics_dir() / "wiki.yaml"
    golden_path = config.rubrics_dir() / "wiki-golden.yaml"
    adversarial_path = config.rubrics_dir() / "wiki-adversarial.yaml"

    import yaml as _yaml
    golden_cases = [EvalCase(**c) for c in (_yaml.safe_load(golden_path.read_text()) or {"cases": []})["cases"]]
    adv_cases = [EvalCase(**c) for c in (_yaml.safe_load(adversarial_path.read_text()) or {"cases": []})["cases"]]

    synth_cases_raw = synthesize_cases(conventions_path, golden_path, target_count=15)
    synth_cases = [EvalCase(prompt=c.prompt, expected_path_regex=c.expected_path_regex,
                            expected_tags_subset=c.expected_tags_subset) for c in synth_cases_raw]
    all_cases = golden_cases + adv_cases + synth_cases

    # Noise-floor calibration: baseline run #1
    _, baseline_results_a = asyncio.run(_score_variant_async(
        "baseline_a", baseline_text, all_cases, run_root, claude_bin,
        sandbox_concurrency, conventions_path, None, budget,
    ))
    _, baseline_results_b = asyncio.run(_score_variant_async(
        "baseline_b", baseline_text, all_cases, run_root, claude_bin,
        sandbox_concurrency, conventions_path, None, budget,
    ))
    scores_a = [r.mean_score for r in baseline_results_a if r.eligible]
    scores_b = [r.mean_score for r in baseline_results_b if r.eligible]
    nf = compute_noise_floor(scores_a, scores_b)
    assert_noise_floor_acceptable(nf)
    baseline_mean = (statistics.mean(scores_a) + statistics.mean(scores_b)) / 2
    threshold = merge_threshold(nf)

    # Per-axis baseline feedback to seed the mutator
    axis_means: dict[str, list[float]] = {}
    for r in baseline_results_a + baseline_results_b:
        if not r.eligible:
            continue
        for axis, (score, _) in r.axis_scores.items():
            axis_means.setdefault(axis, []).append(score)
    feedback_for_mutator = [
        AxisFeedback(axis=ax, score=statistics.mean(vs),
                     feedback=f"baseline averaged {statistics.mean(vs):.2f} on this axis across "
                              f"{len(vs)} eligible eval cases")
        for ax, vs in axis_means.items()
    ]

    variants = generate_variants(baseline_text, feedback_for_mutator, n=num_variants)
    variant_scores: list[tuple[str, list[RubricResult]]] = []
    for i, vtext in enumerate(variants):
        if len(vtext.encode()) > 15000:
            continue
        variant_scores.append(asyncio.run(_score_variant_async(
            f"v{i}", vtext, all_cases, run_root, claude_bin,
            sandbox_concurrency, conventions_path, None, budget,
        )))

    winner = pick_winner(variant_scores)
    if winner is None:
        return EvolveResult(
            baseline_score=baseline_mean, noise_floor=nf, merge_threshold=threshold,
            variant_scores=variant_scores, winner_id=None, winner_score=0.0,
            run_id=run_id,
        )
    winner_id, winner_score = winner
    if winner_score - baseline_mean < threshold:
        return EvolveResult(
            baseline_score=baseline_mean, noise_floor=nf, merge_threshold=threshold,
            variant_scores=variant_scores, winner_id=None, winner_score=winner_score,
            run_id=run_id,
        )
    winner_text = next(v for i, v in enumerate(variants) if f"v{i}" == winner_id)

    pres = semantic_preservation_check(baseline_text, winner_text, intentional_drops=[])
    if not pres.passes():
        return EvolveResult(
            baseline_score=baseline_mean, noise_floor=nf, merge_threshold=threshold,
            variant_scores=variant_scores, winner_id=None, winner_score=winner_score,
            run_id=run_id,
        )

    return EvolveResult(
        baseline_score=baseline_mean, noise_floor=nf, merge_threshold=threshold,
        variant_scores=variant_scores, winner_id=winner_id, winner_score=winner_score,
        winner_text=winner_text,
        run_id=run_id,
    )
