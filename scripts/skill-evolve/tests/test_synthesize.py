from pathlib import Path
from unittest.mock import MagicMock
from skill_evolve.synthesize import synthesize_cases, SyntheticCase


def test_synthesizer_reads_conventions_not_skill(tmp_path, monkeypatch):
    conv = tmp_path / "CONVENTIONS.md"
    conv.write_text("# Wiki Data Conventions\nPapers go to wiki/papers/.")
    skill = tmp_path / "SKILL.md"
    skill.write_text("DO NOT READ ME — I am the optimization target.")
    golden = tmp_path / "wiki-golden.yaml"
    golden.write_text("cases: []\n")

    fake_client = MagicMock()
    fake_client.messages.create.return_value = MagicMock(
        content=[MagicMock(text='[{"prompt": "add a paper", "expected_path_regex": "^wiki/papers/.*", "expected_tags_subset": ["wiki/papers"]}]')]
    )

    cases = synthesize_cases(
        conventions_path=conv,
        golden_path=golden,
        target_count=1,
        client=fake_client,
    )
    assert len(cases) == 1
    assert cases[0].prompt == "add a paper"

    # Verify SKILL.md was NEVER read in the prompt:
    call_args = fake_client.messages.create.call_args
    prompt_text = str(call_args)
    assert "DO NOT READ ME" not in prompt_text


def test_synthesizer_returns_target_count_cases(tmp_path):
    conv = tmp_path / "CONVENTIONS.md"
    conv.write_text("conventions text")
    golden = tmp_path / "wiki-golden.yaml"
    golden.write_text("cases: []\n")

    fake_client = MagicMock()
    fake_client.messages.create.return_value = MagicMock(
        content=[MagicMock(text='[' + ",".join(
            f'{{"prompt": "p{i}", "expected_path_regex": "^wiki/.*", "expected_tags_subset": []}}'
            for i in range(15)
        ) + ']')]
    )
    cases = synthesize_cases(conv, golden, target_count=15, client=fake_client)
    assert len(cases) == 15


def test_synthesize_records_to_budget_when_provided(tmp_path):
    from skill_evolve.budget import BudgetTracker
    conv = tmp_path / "CONVENTIONS.md"
    conv.write_text("conv")
    golden = tmp_path / "wiki-golden.yaml"
    golden.write_text("cases: []\n")
    fake = MagicMock()
    fake.messages.create.return_value = MagicMock(
        content=[MagicMock(text='[{"prompt": "p", "expected_path_regex": "^wiki/.*", "expected_tags_subset": []}]')],
        usage=MagicMock(input_tokens=500, output_tokens=100),
    )
    b = BudgetTracker(max_usd=10.0)
    synthesize_cases(conv, golden, target_count=1, client=fake, budget=b)
    assert b.total_cost > 0
    assert "synthesize" in b.per_stage_breakdown()
