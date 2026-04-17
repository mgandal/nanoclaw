"""Tests for follow-up-related type constants."""
from pathlib import Path

from email_ingest.types import (
    FOLLOWUPS_FILE,
    AGE_THRESHOLD_DAYS,
    JACCARD_THRESHOLD,
    FollowUp,
)


def test_followups_file_points_to_global_state():
    assert FOLLOWUPS_FILE.name == "followups.md"
    assert "groups/global/state" in str(FOLLOWUPS_FILE)


def test_age_threshold_is_14_days():
    assert AGE_THRESHOLD_DAYS == 14


def test_jaccard_threshold_is_point_six():
    assert JACCARD_THRESHOLD == 0.6


def test_followup_dataclass_defaults():
    f = FollowUp(
        kind="i-owe",
        who="Sarah Chen",
        what="Send revised methods",
        due="none",
        thread="gmail:abc123",
        source_msg="gmail:abc123",
        created="2026-04-15T14:22:00Z",
    )
    assert f.status == "open"
    assert f.closed_reason is None
    assert f.closed_at is None
