import json
from pathlib import Path
import pytest
from skill_evolve.escalate import check_history, EscalationStop


def write_history(path: Path, entries: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n")


def test_empty_history_does_not_escalate(tmp_path):
    h = tmp_path / "_history.jsonl"
    h.write_text("")
    check_history(h)  # no raise


def test_three_consecutive_no_pr_escalates(tmp_path):
    h = tmp_path / "_history.jsonl"
    write_history(h, [
        {"run_id": "a", "merged": False, "pr_url": None, "cost_usd": 20},
        {"run_id": "b", "merged": False, "pr_url": None, "cost_usd": 25},
        {"run_id": "c", "merged": False, "pr_url": None, "cost_usd": 22},
    ])
    with pytest.raises(EscalationStop, match="3 consecutive"):
        check_history(h)


def test_one_merge_resets_consecutive_count(tmp_path):
    h = tmp_path / "_history.jsonl"
    write_history(h, [
        {"run_id": "a", "merged": False, "pr_url": None, "cost_usd": 20},
        {"run_id": "b", "merged": True, "pr_url": "x", "cost_usd": 25},
        {"run_id": "c", "merged": False, "pr_url": None, "cost_usd": 22},
    ])
    check_history(h)  # only 1 consecutive no-PR after the merge


def test_cumulative_cost_with_zero_merges_escalates(tmp_path):
    h = tmp_path / "_history.jsonl"
    write_history(h, [
        {"run_id": f"r{i}", "merged": False, "pr_url": None, "cost_usd": 30}
        for i in range(4)
    ])
    with pytest.raises(EscalationStop, match=r"\$120"):
        check_history(h)
