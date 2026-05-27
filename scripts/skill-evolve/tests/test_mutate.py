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
