"""Tests for backfill-attachments.py — repair pre-fix body-only Penn messages."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_BACKFILL_PATH = Path(__file__).resolve().parents[1] / "backfill-attachments.py"


def _load_backfill():
    spec = importlib.util.spec_from_file_location("backfill_under_test", _BACKFILL_PATH)
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["backfill-attachments.py"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


@pytest.fixture
def bf():
    return _load_backfill()


class TestStripMessageId:
    def test_strips_angle_brackets(self, bf):
        assert bf.strip_message_id("<abc@penn.edu>") == "abc@penn.edu"

    def test_leaves_bare_id_untouched(self, bf):
        assert bf.strip_message_id("abc@penn.edu") == "abc@penn.edu"

    def test_strips_whitespace_and_brackets(self, bf):
        assert bf.strip_message_id("  <abc@penn.edu>  ") == "abc@penn.edu"

    def test_none_returns_none(self, bf):
        assert bf.strip_message_id(None) is None
