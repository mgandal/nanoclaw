"""Cross-process locking regression for email-migrate.py:save_state.

Bug: save_state() writes to a fixed `.tmp` sidecar then atomically
replaces STATE_FILE. With launchd kicking sync-all.sh every 4h and the
30-min timeout-wrapper killing mid-run, two invocations can overlap.
Both processes write to the same `email-migration.json.tmp` and race
on `tmp.replace(STATE_FILE)`. The losing writer's payload may be
torn / interleaved / partially overwritten on disk, and even when
.replace() wins atomically per-file, the *content* of the .tmp can
be a corrupt mash of two json.dump() streams.

Failing test reproduces by:
1. Pre-seeding STATE_FILE with a known-bad payload (ensures the test
   isn't "passing" because the file happened to never be written).
2. Spawning N concurrent multiprocessing.Process workers, each calling
   save_state with a distinct uniquely-tagged payload.
3. Monkeypatching save_state inside each child to insert a small
   time.sleep between writing the .tmp body and tmp.replace(),
   widening the race window so the bug fires reliably.
4. Asserting the final on-disk JSON is valid AND equals exactly one
   of the N candidate payloads (no interleaving, no torn writes).

Without flock this test fails (corrupt JSON or wrong payload).
With fcntl.flock around save_state's body it passes deterministically.
"""

import importlib.util
import json
import multiprocessing
import os
import sys
import time
from pathlib import Path

import pytest


_MIGRATE_PATH = Path(__file__).resolve().parents[1] / "email-migrate.py"


def _load_migrate_module():
    """Load email-migrate.py inside a (sub)process under a clean name."""
    spec = importlib.util.spec_from_file_location(
        "email_migrate_under_test_lock", _MIGRATE_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["email-migrate.py"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


@pytest.fixture
def migrate_module():
    return _load_migrate_module()


# ---------------------------------------------------------------------------
# Worker — runs in each child process. Must be top-level for pickling on
# platforms where the start method isn't fork (we force fork below for macOS).
# ---------------------------------------------------------------------------


def _race_worker(state_file_path: str, payload: dict, race_delay: float):
    """Reload the module in the child, point STATE_FILE at the test file,
    monkeypatch save_state to sleep between write and replace, then save.
    """
    mod = _load_migrate_module()
    mod.STATE_FILE = Path(state_file_path)

    # Reach into save_state's body and inject a sleep between
    # tmp.write and tmp.replace by patching Path.replace.
    real_replace = Path.replace

    def slow_replace(self, target):
        time.sleep(race_delay)
        return real_replace(self, target)

    Path.replace = slow_replace
    try:
        mod.save_state(payload)
    finally:
        Path.replace = real_replace


# ---------------------------------------------------------------------------
# The failing test.
# ---------------------------------------------------------------------------


def test_concurrent_save_state_does_not_corrupt(tmp_path, migrate_module):
    """Two+ concurrent save_state calls must yield a final file that is
    valid JSON AND equals exactly one of the candidate payloads.
    """
    state_file = tmp_path / "email-migration.json"
    # Pre-seed with a known-distinct sentinel so we can detect "wrote nothing".
    state_file.write_text(json.dumps({"sentinel": "pre-test"}))

    n_workers = 8
    race_delay = 0.10  # 100ms — wide enough to fire reliably

    # Distinct tagged payloads. Each one is unmistakable on inspection.
    payloads = [
        {
            "folders": {f"folder_{i}": {"migrated_files": [f"file_{i}_{j}" for j in range(20)]}},
            "bytes_uploaded_today": 1000 * (i + 1),
            "last_run_date": "2026-04-29",
            "errors": [],
            "_worker_tag": f"worker_{i}",
        }
        for i in range(n_workers)
    ]

    ctx = multiprocessing.get_context("fork")
    procs = [
        ctx.Process(target=_race_worker, args=(str(state_file), p, race_delay))
        for p in payloads
    ]
    for p in procs:
        p.start()
    for p in procs:
        p.join(timeout=30)
        assert p.exitcode == 0, f"worker exited non-zero: {p.exitcode}"

    # 1. STATE_FILE must exist
    assert state_file.exists(), "STATE_FILE missing after concurrent saves"

    # 2. Contents must parse as JSON
    raw = state_file.read_text()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        pytest.fail(
            f"STATE_FILE is corrupt JSON after concurrent saves: {exc}\n"
            f"--- raw contents ({len(raw)} bytes) ---\n{raw[:500]}"
        )

    # 3. Parsed result must equal exactly one of the candidate payloads.
    #    Not a mix, not the pre-seed sentinel, not a partial.
    assert parsed != {"sentinel": "pre-test"}, "no worker actually wrote"
    matching = [p for p in payloads if parsed == p]
    assert len(matching) == 1, (
        f"final state matches {len(matching)} of {n_workers} payloads — "
        f"expected exactly 1. parsed._worker_tag={parsed.get('_worker_tag')!r}, "
        f"keys={sorted(parsed.keys())}"
    )
