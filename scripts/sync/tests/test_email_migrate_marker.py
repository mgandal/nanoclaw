"""Regression tests for email-migrate.py last-success.json marker behavior.

Post-hoc tests for commit 38134aba (Outlook→Gmail health surface). Per the
TDD skill: these are NOT true TDD because the production code shipped first.
They exist as regression protection — any future change that breaks
atomicity, payload shape, or session-delta accounting will fail these.

Tests call write_success_marker() directly. That function was extracted
from main() specifically for testability (Refactor step after Green).
"""

import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Module loader — email-migrate.py has a hyphen so we can't normal-import it.
# Same pattern as the existing conftest.py for email-ingest.py.
# ---------------------------------------------------------------------------

_MIGRATE_PATH = Path(__file__).resolve().parents[1] / "email-migrate.py"


@pytest.fixture(scope="module")
def migrate_module():
    """Load email-migrate.py as a module under a non-hyphenated name."""
    spec = importlib.util.spec_from_file_location("email_migrate_under_test", _MIGRATE_PATH)
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["email-migrate.py"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


@pytest.fixture
def patched_state_dir(tmp_path, migrate_module, monkeypatch):
    """Redirect STATE_DIR to a tmp_path so tests don't touch ~/.cache."""
    monkeypatch.setattr(migrate_module, "STATE_DIR", tmp_path)
    return tmp_path


# ---------------------------------------------------------------------------
# Test 1: Atomic write — write_success_marker uses os.replace.
# ---------------------------------------------------------------------------

def test_marker_write_uses_atomic_replace(migrate_module, patched_state_dir, monkeypatch):
    """write_success_marker must route through os.replace, not direct write.

    Without atomicity, a SIGKILL between open(w) and the first byte leaves
    a 0-byte file that fails JSON parse downstream. Spy on os.replace and
    confirm exactly one call from .tmp → canonical.
    """
    replace_calls = []
    real_replace = os.replace

    def spy_replace(src, dst):
        replace_calls.append((str(src), str(dst)))
        return real_replace(src, dst)

    monkeypatch.setattr(migrate_module.os, "replace", spy_replace)

    state = {"bytes_uploaded_today": 100, "folders": {}}
    migrate_module.write_success_marker(state, bytes_at_start=0, errors_at_start=0)

    assert len(replace_calls) == 1, f"expected 1 os.replace call, got {len(replace_calls)}"
    src, dst = replace_calls[0]
    assert src.endswith(".json.tmp"), f"src must be .tmp file, got {src}"
    assert dst.endswith("last-success.json"), f"dst must be canonical, got {dst}"

    marker = patched_state_dir / "last-success.json"
    tmp = patched_state_dir / "last-success.json.tmp"
    assert marker.exists()
    assert not tmp.exists(), "temp file must not survive after replace"


def test_marker_payload_has_required_fields(migrate_module, patched_state_dir):
    """Marker JSON contract: 5 fields. Health check 7c/7d depends on this shape."""
    state = {"bytes_uploaded_today": 1000, "folders": {}}
    migrate_module.write_success_marker(state, bytes_at_start=500, errors_at_start=0)

    marker = patched_state_dir / "last-success.json"
    payload = json.loads(marker.read_text())

    # Each field is load-bearing for some downstream consumer
    assert "timestamp" in payload, "needed by 7c freshness check (epoch math)"
    assert "iso" in payload, "human-readable, surfaced in failure diagnostics"
    assert "bytes_uploaded_today" in payload, "daily quota visibility"
    assert "bytes_session" in payload, "needed by 7d silent-degrade detection"
    assert "errors_session" in payload, "needed by 7d silent-degrade detection"


def test_session_delta_computed_correctly(migrate_module, patched_state_dir):
    """bytes_session and errors_session must be (current - snapshot) deltas.

    Pre-loop snapshot is taken in main() before the upload loop. After the
    loop, the delta tells us how much THIS session did, regardless of
    cumulative daily totals.
    """
    state = {
        "bytes_uploaded_today": 2000,  # current
        "folders": {
            "Inbox": {"errors": [{"file": "a.emlx", "error": "x"}, {"file": "b.emlx", "error": "y"}]},
            "Sent": {"errors": []},
        },
    }
    # Pretend pre-loop snapshot was: bytes=500, errors=0
    migrate_module.write_success_marker(state, bytes_at_start=500, errors_at_start=0)

    payload = json.loads((patched_state_dir / "last-success.json").read_text())
    assert payload["bytes_session"] == 1500, "delta = 2000 - 500"
    assert payload["errors_session"] == 2, "two new Inbox errors since snapshot"


def test_idempotent_rerun_produces_zero_deltas(migrate_module, patched_state_dir):
    """A no-op rerun (no new uploads, no new errors) must produce zero deltas.

    This is the green-path signal: marker fresh AND bytes_session=0 AND
    errors_session=0 means "nothing to do, nothing failed." Health check
    7d treats this as healthy (vs. silent-degrade where errors > 0).
    """
    # State after a run that did 1000 bytes earlier in the day
    state = {
        "bytes_uploaded_today": 1000,
        "folders": {"Inbox": {"errors": []}},
    }
    # Snapshot = current = 1000 (no work this run)
    migrate_module.write_success_marker(state, bytes_at_start=1000, errors_at_start=0)

    payload = json.loads((patched_state_dir / "last-success.json").read_text())
    assert payload["bytes_session"] == 0
    assert payload["errors_session"] == 0


def test_silent_degrade_marker_is_distinguishable_from_idempotent(migrate_module, patched_state_dir):
    """The crucial distinction: 0 bytes WITH errors > 0 means silent degrade.

    Both idempotent rerun and silent degrade have bytes_session == 0. The
    errors_session counter is what 7d uses to discriminate. This test
    locks in the contract: a write where the loop logged errors but
    uploaded nothing produces errors_session > 0.
    """
    state = {
        "bytes_uploaded_today": 1000,  # no change vs snapshot
        "folders": {
            "Inbox": {"errors": [{"file": f"msg{i}.emlx", "error": "401"} for i in range(50)]},
        },
    }
    migrate_module.write_success_marker(state, bytes_at_start=1000, errors_at_start=0)

    payload = json.loads((patched_state_dir / "last-success.json").read_text())
    assert payload["bytes_session"] == 0, "no new uploads"
    assert payload["errors_session"] == 50, "50 errors logged this session"

    # The 7d check predicate
    is_silent_degrade = payload["errors_session"] > 0 and payload["bytes_session"] == 0
    assert is_silent_degrade, "this payload must trip the silent-degrade alert"


def test_partial_write_recoverable(migrate_module, patched_state_dir, monkeypatch):
    """If os.replace is mid-flight crashed, we must NOT leave a corrupted
    canonical file. The .tmp file may exist but the canonical never does
    (or only ever holds the prior intact value).

    Simulates by having os.replace raise — verifying the canonical file
    is never created.
    """
    state = {"bytes_uploaded_today": 100, "folders": {}}

    def boom(src, dst):
        # Simulate a crash precisely between tmp-write and replace
        raise OSError("simulated crash")

    monkeypatch.setattr(migrate_module.os, "replace", boom)

    with pytest.raises(OSError):
        migrate_module.write_success_marker(state, bytes_at_start=0, errors_at_start=0)

    marker = patched_state_dir / "last-success.json"
    assert not marker.exists(), "canonical marker must not exist after crashed replace"
    # The .tmp file may exist; that's fine. Health check parses canonical only.
