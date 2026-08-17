"""Test-suite isolation guard for IngestState persistence.

RCA 2026-08-17: running `pytest tests/` CLOBBERED the production state file
`~/.cache/email-ingest/email-ingest-state.json`. A test called run_ingest()
(which calls state.save() internally) WITHOUT the `tmp_state` fixture, so
IngestState.save() wrote to the real STATE_FILE. The live file was left with
processed_gmail_ids == ["g1"] — a test fixture email id — and
last_exchange_epoch == 0.

Consequences of that clobber in production:
  - processed_*_ids emptied  -> dedup lost, mail re-fetched and re-classified
  - last_exchange_epoch = 0  -> falls back to default_epoch() (14d) on next run

This is silent: nothing in the suite fails, and the damage is only visible by
inspecting the live file afterwards. These tests make the leak fail loudly.
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

SYNC_DIR = Path(__file__).resolve().parents[1]
TESTS_DIR = SYNC_DIR / "tests"


def _iter_test_functions(path: Path):
    """Yield (func_name, arglist, body) for every top-level test function."""
    src = path.read_text()
    pattern = re.compile(r"^def (test_\w+)\(([^)]*)\):(.*?)(?=^def |\Z)", re.S | re.M)
    for m in pattern.finditer(src):
        yield m.group(1), m.group(2), m.group(3)


def _strip_comments(body: str) -> str:
    """Drop full-line comments before scanning for persistence calls.

    _iter_test_functions captures everything up to the next `def`, which
    includes any trailing comment block between functions. Those blocks
    discuss state.save() in prose (see the 2026-05-20 RCA note in
    test_email_ingest.py) and must not be mistaken for real calls.
    """
    return "\n".join(
        line for line in body.splitlines() if not line.lstrip().startswith("#")
    )


def test_every_persisting_test_uses_the_tmp_state_fixture():
    """Any test that triggers IngestState.save() must isolate STATE_FILE.

    run_ingest() checkpoints state internally, so calling it is equivalent to
    calling save() directly. Both require the `tmp_state` fixture (which patches
    email_ingest.types.STATE_FILE/STATE_DIR/EXPORT_DIR at the module level).
    """
    offenders = []
    for path in sorted(TESTS_DIR.glob("test_*.py")):
        if path.name == Path(__file__).name:
            continue
        for name, args, body in _iter_test_functions(path):
            code = _strip_comments(body)
            # Match real persistence. run_ingest is normally called as an
            # attribute (`mod.run_ingest(...)`, `m.run_ingest(...)`), so the
            # pattern must allow a leading dot — an earlier version excluded it
            # and silently matched nothing. Only reject the longer identifier
            # `_load_email_ingest(`, which merely loads the module.
            persists = (
                ".save()" in code
                or re.search(r"(?<![\w])(?:\w+\.)?run_ingest\s*\(", code) is not None
            )
            if persists and "tmp_state" not in args:
                offenders.append(f"{path.name}::{name}")

    assert not offenders, (
        "these tests persist IngestState without the `tmp_state` fixture and "
        "will overwrite the REAL ~/.cache/email-ingest/email-ingest-state.json "
        "(wiping processed IDs and epochs on the live pipeline): "
        + ", ".join(offenders)
    )


def test_state_file_default_points_outside_the_repo():
    """Guard the assumption the fixture relies on: STATE_FILE is a real user
    path, not a repo-local file. If this ever moves, the isolation fixture and
    this whole test file need revisiting."""
    from email_ingest.types import STATE_FILE

    assert STATE_FILE == Path.home() / ".cache" / "email-ingest" / "email-ingest-state.json"


def test_save_writes_to_patched_location_only(tmp_path, monkeypatch):
    """Positive control: with STATE_FILE patched, save() must not touch the
    real path. Proves the fixture mechanism itself works."""
    import email_ingest.types as types

    target = tmp_path / "email-ingest-state.json"
    monkeypatch.setattr(types, "STATE_FILE", target)
    monkeypatch.setattr(types, "STATE_DIR", tmp_path)

    state = types.IngestState(last_exchange_epoch=4242)
    state.processed_exchange_ids.append("isolated-1")
    state.save()

    assert target.exists(), "save() did not write to the patched STATE_FILE"
    written = json.loads(target.read_text())
    assert written["last_exchange_epoch"] == 4242
    assert written["processed_exchange_ids"] == ["isolated-1"]
