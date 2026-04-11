"""Tests for state management."""

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from email_ingest.types import IngestState, STATE_FILE, MAX_PROCESSED_IDS


@pytest.fixture
def tmp_state(tmp_path):
    state_file = tmp_path / "email-ingest-state.json"
    with patch("email_ingest.types.STATE_FILE", state_file), \
         patch("email_ingest.types.STATE_DIR", tmp_path):
        yield state_file


def test_load_missing_file_returns_defaults(tmp_state):
    state = IngestState.load()
    assert state.last_gmail_epoch == 0
    assert state.last_exchange_epoch == 0
    assert state.processed_gmail_ids == []


def test_save_and_load_roundtrip(tmp_state):
    state = IngestState()
    state.last_gmail_epoch = 1712800000
    state.processed_gmail_ids = ["id1", "id2"]
    state.save()

    loaded = IngestState.load()
    assert loaded.last_gmail_epoch == 1712800000
    assert loaded.processed_gmail_ids == ["id1", "id2"]


def test_save_enforces_id_cap(tmp_state):
    state = IngestState()
    state.processed_gmail_ids = [f"id-{i}" for i in range(MAX_PROCESSED_IDS + 500)]
    state.save()

    loaded = IngestState.load()
    assert len(loaded.processed_gmail_ids) == MAX_PROCESSED_IDS
    # Should keep the most recent (last) IDs
    assert loaded.processed_gmail_ids[-1] == f"id-{MAX_PROCESSED_IDS + 499}"
    assert loaded.processed_gmail_ids[0] == f"id-500"


def test_default_epoch_is_14_days_back(tmp_state):
    import time
    state = IngestState()
    epoch = state.default_epoch(14)
    expected = int(time.time()) - (14 * 86400)
    assert abs(epoch - expected) < 5  # within 5 seconds


def test_save_sets_last_run(tmp_state):
    state = IngestState()
    state.save()
    assert state.last_run != ""
    assert "T" in state.last_run  # ISO format
