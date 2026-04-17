"""Shared test fixtures — expose the top-level email-ingest.py module for tests."""
import importlib.util
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_spec = importlib.util.spec_from_file_location(
    "email_ingest_module_under_test",
    Path(__file__).resolve().parents[1] / "email-ingest.py",
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["email_ingest_module_under_test"] = _mod
_spec.loader.exec_module(_mod)
