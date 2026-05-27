from unittest.mock import MagicMock
from skill_evolve.evolve import compute_noise_floor, pick_winner, EvolveResult
from skill_evolve.rubric import RubricResult


def test_noise_floor_is_zero_for_identical_scores():
    assert compute_noise_floor([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]) == 0.0


def test_noise_floor_is_abs_difference_of_means():
    nf = compute_noise_floor([0.5, 0.6, 0.7], [0.5, 0.5, 0.5])
    assert abs(nf - 0.1) < 1e-6


def test_pick_winner_returns_best_eligible_variant():
    rr = lambda mean, eligible=True: RubricResult(eligible=eligible, mean_score=mean)
    variant_scores = [
        ("v0", [rr(0.5), rr(0.6)]),  # mean 0.55
        ("v1", [rr(0.9), rr(0.8)]),  # mean 0.85
        ("v2", [rr(0.7), rr(0.7)]),  # mean 0.70
    ]
    winner_id, winner_mean = pick_winner(variant_scores)
    assert winner_id == "v1"
    assert abs(winner_mean - 0.85) < 1e-6


def test_pick_winner_skips_ineligible():
    rr = lambda mean, eligible=True: RubricResult(eligible=eligible, mean_score=mean)
    variant_scores = [
        ("v0", [rr(0.9, eligible=False), rr(0.9, eligible=False)]),
        ("v1", [rr(0.5), rr(0.5)]),
    ]
    winner_id, _ = pick_winner(variant_scores)
    assert winner_id == "v1"


def test_pick_winner_none_eligible_returns_none():
    rr = lambda mean: RubricResult(eligible=False, mean_score=mean)
    variant_scores = [("v0", [rr(0.9), rr(0.9)])]
    assert pick_winner(variant_scores) is None


def test_evolve_result_has_run_id_field():
    from skill_evolve.evolve import EvolveResult
    r = EvolveResult(baseline_score=0.5, noise_floor=0.0, merge_threshold=0.3, run_id="20260527-1234-deadbeef")
    assert r.run_id == "20260527-1234-deadbeef"
