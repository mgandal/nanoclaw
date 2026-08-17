"""Shared test fixtures — expose the top-level email-ingest.py module for tests."""
import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_spec = importlib.util.spec_from_file_location(
    "email_ingest_module_under_test",
    Path(__file__).resolve().parents[1] / "email-ingest.py",
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["email_ingest_module_under_test"] = _mod
_spec.loader.exec_module(_mod)


@pytest.fixture
def tmp_state(tmp_path):
    """Redirect IngestState persistence to a temp directory.

    Lives in conftest so EVERY test file can reach it. It was previously
    defined only in test_email_ingest.py, so a test in another file that
    called run_ingest() silently persisted to the REAL
    ~/.cache/email-ingest/email-ingest-state.json and wiped the live
    pipeline's processed IDs + epochs (RCA 2026-08-17).

    See tests/test_state_isolation.py, which fails if any persisting test
    forgets this fixture.
    """
    state_file = tmp_path / "email-ingest-state.json"
    with patch("email_ingest.types.STATE_FILE", state_file), \
         patch("email_ingest.types.STATE_DIR", tmp_path), \
         patch("email_ingest.types.EXPORT_DIR", tmp_path / "exported"):
        yield tmp_path


@pytest.fixture(autouse=True)
def _guard_real_state_file():
    """Backstop: fail loudly if any test writes the production state file.

    Belt-and-braces against the static check in test_state_isolation.py —
    that one greps source, this one catches it at runtime regardless of how
    the write is reached.
    """
    real = Path.home() / ".cache" / "email-ingest" / "email-ingest-state.json"
    before = real.stat().st_mtime_ns if real.exists() else None
    yield
    after = real.stat().st_mtime_ns if real.exists() else None
    assert before == after, (
        f"a test modified the REAL state file {real} — wrap it in the "
        "`tmp_state` fixture so it cannot corrupt the live pipeline"
    )
