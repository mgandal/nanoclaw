"""Tests for the --dry-run flag in audit-telegram-errors.py.

Contract:
  --dry-run must run the audit end-to-end (classify, threshold, summary)
  but MUST NOT mutate scripts/state/error-audit-state.json. The state
  file's mtime and contents must be byte-identical before/after the run.
  The summary JSON should also tag dry_run=true so callers can detect.
"""

import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "audit-telegram-errors.py"


@pytest.fixture(scope="module")
def audit_module():
    spec = importlib.util.spec_from_file_location("audit_telegram_errors", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def state_file(tmp_path, audit_module, monkeypatch):
    """Redirect STATE_PATH to a tmp file with known contents."""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    state_path = state_dir / "error-audit-state.json"
    seed = {
        "log_offsets": {"nanoclaw.log": 100, "nanoclaw.error.log": 50},
        "last_run": "2026-05-01T00:00:00+00:00",
    }
    state_path.write_text(json.dumps(seed, indent=2))
    monkeypatch.setattr(audit_module, "STATE_PATH", state_path)
    monkeypatch.setattr(audit_module, "STATE_DIR", state_dir)
    return state_path


def test_dry_run_flag_is_accepted(audit_module, state_file, monkeypatch, capsys):
    """--dry-run must be a recognized flag, not an error."""
    monkeypatch.setattr(audit_module, "MAIN_LOG", Path("/nonexistent/main.log"))
    monkeypatch.setattr(audit_module, "ERROR_LOG", Path("/nonexistent/error.log"))
    monkeypatch.setattr(audit_module, "collect_task_run_logs", lambda now: [])
    monkeypatch.setattr(sys, "argv", ["audit-telegram-errors.py", "--dry-run"])
    rc = audit_module.main()
    assert rc in (0, 2), f"unexpected rc {rc}"


def test_dry_run_does_not_advance_byte_offsets(
    audit_module, state_file, monkeypatch
):
    """The state JSON must be byte-identical before/after a --dry-run."""
    before_bytes = state_file.read_bytes()
    before_mtime = state_file.stat().st_mtime_ns

    monkeypatch.setattr(audit_module, "MAIN_LOG", Path("/nonexistent/main.log"))
    monkeypatch.setattr(audit_module, "ERROR_LOG", Path("/nonexistent/error.log"))
    monkeypatch.setattr(audit_module, "collect_task_run_logs", lambda now: [])
    monkeypatch.setattr(sys, "argv", ["audit-telegram-errors.py", "--dry-run"])
    audit_module.main()

    after_bytes = state_file.read_bytes()
    after_mtime = state_file.stat().st_mtime_ns
    assert before_bytes == after_bytes, "dry-run mutated state file contents"
    assert before_mtime == after_mtime, "dry-run touched state file mtime"


def test_dry_run_summary_tags_dry_run_true(
    audit_module, state_file, monkeypatch, capsys
):
    """Summary JSON must include dry_run=true so callers can detect."""
    monkeypatch.setattr(audit_module, "MAIN_LOG", Path("/nonexistent/main.log"))
    monkeypatch.setattr(audit_module, "ERROR_LOG", Path("/nonexistent/error.log"))
    monkeypatch.setattr(audit_module, "collect_task_run_logs", lambda now: [])
    monkeypatch.setattr(sys, "argv", ["audit-telegram-errors.py", "--dry-run"])
    audit_module.main()
    out = capsys.readouterr().out
    summary = json.loads(out)
    assert summary.get("dry_run") is True


def test_normal_run_advances_byte_offsets(audit_module, state_file, monkeypatch):
    """Sanity check: without --dry-run, last_run timestamp advances."""
    before = json.loads(state_file.read_text())

    monkeypatch.setattr(audit_module, "MAIN_LOG", Path("/nonexistent/main.log"))
    monkeypatch.setattr(audit_module, "ERROR_LOG", Path("/nonexistent/error.log"))
    monkeypatch.setattr(audit_module, "collect_task_run_logs", lambda now: [])
    monkeypatch.setattr(sys, "argv", ["audit-telegram-errors.py"])
    audit_module.main()

    after = json.loads(state_file.read_text())
    assert after["last_run"] != before["last_run"], (
        "normal run did not update last_run (regression in non-dry-run path)"
    )
