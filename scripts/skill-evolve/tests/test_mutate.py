from unittest.mock import MagicMock
from skill_evolve.mutate import generate_variants, AxisFeedback


def test_generates_n_variants_in_one_call():
    fake_client = MagicMock()
    fake_resp_text = (
        "VARIANT_1:\n```\n# Variant 1\nContent A\n```\n\n"
        "VARIANT_2:\n```\n# Variant 2\nContent B\n```\n\n"
        "VARIANT_3:\n```\n# Variant 3\nContent C\n```\n"
    )
    fake_client.messages.create.return_value = MagicMock(content=[MagicMock(text=fake_resp_text)])

    variants = generate_variants(
        baseline_skill="# Baseline",
        baseline_axis_feedback=[AxisFeedback("folder_routing", 0.3, "WRONG FOLDER on 5/15")],
        n=3,
        client=fake_client,
    )
    assert len(variants) == 3
    assert "Content A" in variants[0]
    assert "Content B" in variants[1]
    assert fake_client.messages.create.call_count == 1


def test_raises_if_fewer_variants_returned():
    fake_client = MagicMock()
    fake_client.messages.create.return_value = MagicMock(content=[MagicMock(text="VARIANT_1:\n```\nonly one\n```")])
    import pytest
    with pytest.raises(RuntimeError, match="expected 3 variants, got 1"):
        generate_variants("# B", [], n=3, client=fake_client)


import json
from unittest.mock import MagicMock
from skill_evolve.mutate import semantic_preservation_check, PreservationResult


def test_preservation_passes_at_score_5():
    fake = MagicMock()
    fake.messages.create.return_value = MagicMock(content=[MagicMock(text=json.dumps({
        "score": 5, "dropped_rules": [], "contradicted_rules": [], "summary": "ok"
    }))])
    r = semantic_preservation_check("# base", "# variant", intentional_drops=[], client=fake)
    assert r.score == 5
    assert r.passes() is True


def test_preservation_fails_below_4():
    fake = MagicMock()
    fake.messages.create.return_value = MagicMock(content=[MagicMock(text=json.dumps({
        "score": 3, "dropped_rules": ["rule A"], "contradicted_rules": [], "summary": "..."
    }))])
    r = semantic_preservation_check("# base", "# variant", intentional_drops=[], client=fake)
    assert r.passes() is False


def test_preservation_fails_if_unallowlisted_drops_present():
    fake = MagicMock()
    fake.messages.create.return_value = MagicMock(content=[MagicMock(text=json.dumps({
        "score": 4, "dropped_rules": ["rule X"], "contradicted_rules": [], "summary": "..."
    }))])
    r = semantic_preservation_check("# base", "# variant", intentional_drops=[], client=fake)
    assert r.passes() is False


def test_preservation_passes_if_drops_match_allowlist():
    fake = MagicMock()
    fake.messages.create.return_value = MagicMock(content=[MagicMock(text=json.dumps({
        "score": 4, "dropped_rules": ["rule X"], "contradicted_rules": [], "summary": "..."
    }))])
    r = semantic_preservation_check("# base", "# variant",
                                     intentional_drops=["rule X"], client=fake)
    assert r.passes() is True


def test_generate_variants_records_to_budget_when_provided():
    from skill_evolve.budget import BudgetTracker
    fake_client = MagicMock()
    fake_client.messages.create.return_value = MagicMock(
        content=[MagicMock(text="VARIANT_1:\n```\nA\n```")],
        usage=MagicMock(input_tokens=1000, output_tokens=500),
    )
    b = BudgetTracker(max_usd=10.0)
    generate_variants("# B", [], n=1, client=fake_client, budget=b)
    assert b.total_cost > 0
    assert "mutate" in b.per_stage_breakdown()
