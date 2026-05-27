import json
from pathlib import Path
import pytest
from skill_evolve.__main__ import preflight_gh_auth, preflight_lock, append_history_entry


def test_preflight_lock_acquires_when_free(tmp_path):
    lock = tmp_path / ".lock"
    with preflight_lock(lock):
        assert lock.exists()


def test_preflight_lock_rejects_when_held(tmp_path):
    lock = tmp_path / ".lock"
    with preflight_lock(lock):
        with pytest.raises(RuntimeError, match="another run in progress"):
            with preflight_lock(lock):
                pass


def test_append_history_entry_creates_file(tmp_path):
    h = tmp_path / "_history.jsonl"
    append_history_entry(h, {"run_id": "a", "merged": False, "cost_usd": 20})
    lines = h.read_text().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["run_id"] == "a"


def test_append_history_entry_appends(tmp_path):
    h = tmp_path / "_history.jsonl"
    append_history_entry(h, {"run_id": "a"})
    append_history_entry(h, {"run_id": "b"})
    assert len(h.read_text().splitlines()) == 2
