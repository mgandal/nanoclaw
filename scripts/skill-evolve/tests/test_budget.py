import pytest
from skill_evolve.budget import BudgetTracker, BudgetExceeded


def test_tracker_accumulates_costs():
    t = BudgetTracker(max_usd=10.0)
    t.add(input_tokens=1000, output_tokens=500, model="claude-sonnet-4-6")
    assert t.total_cost > 0
    assert t.total_cost < 1.0


def test_tracker_aborts_when_max_exceeded():
    t = BudgetTracker(max_usd=0.01)
    with pytest.raises(BudgetExceeded):
        t.add(input_tokens=100_000, output_tokens=100_000, model="claude-sonnet-4-6")


def test_tracker_pricing_table_has_sonnet():
    from skill_evolve.budget import PRICING_USD_PER_MTOK
    assert "claude-sonnet-4-6" in PRICING_USD_PER_MTOK


def test_tracker_reports_per_stage():
    t = BudgetTracker(max_usd=100.0)
    t.add(input_tokens=1000, output_tokens=500, model="claude-sonnet-4-6", stage="synthesize")
    t.add(input_tokens=2000, output_tokens=1000, model="claude-sonnet-4-6", stage="sandbox")
    report = t.per_stage_breakdown()
    assert "synthesize" in report
    assert "sandbox" in report
    assert report["sandbox"] > report["synthesize"]
