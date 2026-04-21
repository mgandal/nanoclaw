"""Tests for the threshold / actionability logic in audit-telegram-errors.py.

Contract (from docs/plan-telegram-error-audit.md):
  sustained = (last_seen - first_seen) >= 10 min AND count >= 3
  actionable = sustained OR source == "error_log" OR bucket == "bug"
"""

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "audit-telegram-errors.py"


@pytest.fixture(scope="module")
def is_actionable():
    spec = importlib.util.spec_from_file_location("audit_telegram_errors", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.is_actionable


def record(
    *,
    bucket="transient",
    source="main_log",
    first_seen=None,
    last_seen=None,
    count=1,
):
    now = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
    return {
        "bucket": bucket,
        "source": source,
        "first_seen": (first_seen or now).isoformat(),
        "last_seen": (last_seen or now).isoformat(),
        "count": count,
        "type": "TestError",
        "message": "test",
    }


class TestSustainedTransient:
    def test_short_burst_not_actionable(self, is_actionable):
        now = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
        r = record(
            bucket="transient",
            first_seen=now,
            last_seen=now + timedelta(minutes=2),
            count=10,
        )
        # 2-minute span fails the 10-min rule, so not actionable despite count=10
        assert is_actionable(r) is False

    def test_long_span_but_few_occurrences_not_actionable(self, is_actionable):
        now = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
        r = record(
            bucket="transient",
            first_seen=now,
            last_seen=now + timedelta(hours=2),
            count=2,
        )
        # 2 occurrences fails the count>=3 rule
        assert is_actionable(r) is False

    def test_sustained_transient_is_actionable(self, is_actionable):
        now = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
        r = record(
            bucket="transient",
            first_seen=now,
            last_seen=now + timedelta(minutes=15),
            count=5,
        )
        # 15-min span AND 5 occurrences — sustained
        assert is_actionable(r) is True

    def test_exact_threshold_ten_minutes_three_occurrences(self, is_actionable):
        """Threshold boundaries should be inclusive (>=), not exclusive (>)."""
        now = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
        r = record(
            bucket="transient",
            first_seen=now,
            last_seen=now + timedelta(minutes=10),
            count=3,
        )
        assert is_actionable(r) is True


class TestErrorLogAlwaysActionable:
    def test_error_log_single_occurrence_still_actionable(self, is_actionable):
        r = record(bucket="bug", source="error_log", count=1)
        assert is_actionable(r) is True

    def test_error_log_even_if_transient_bucket_still_actionable(self, is_actionable):
        """Anything launchd captures as stderr is worth surfacing, regardless
        of bucket. The bucket is for triage; error_log is a 'source of truth'
        signal that the main process emitted an uncaught failure."""
        r = record(bucket="transient", source="error_log", count=1)
        assert is_actionable(r) is True


class TestBugBucketAlwaysActionable:
    def test_single_bug_occurrence_actionable(self, is_actionable):
        r = record(bucket="bug", source="main_log", count=1)
        assert is_actionable(r) is True


class TestInfraBucket:
    def test_short_infra_burst_not_actionable(self, is_actionable):
        now = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
        r = record(
            bucket="infra",
            source="main_log",
            first_seen=now,
            last_seen=now + timedelta(minutes=1),
            count=2,
        )
        # A one-off container timeout is upstream noise, not actionable
        assert is_actionable(r) is False

    def test_sustained_infra_is_actionable(self, is_actionable):
        now = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
        r = record(
            bucket="infra",
            source="main_log",
            first_seen=now,
            last_seen=now + timedelta(minutes=30),
            count=10,
        )
        # Sustained infra failures DO warrant alerting — something upstream
        # is persistently broken
        assert is_actionable(r) is True
