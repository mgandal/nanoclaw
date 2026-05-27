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
