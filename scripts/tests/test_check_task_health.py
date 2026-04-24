"""Tests for scripts/check-task-health.py — focused on the stale-detection
heuristic, which historically false-alarmed weekday-only crons on Mondays.
"""

import importlib.util
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "check-task-health.py"


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("check_task_health", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestMaxExpectedGap:
    def test_every_four_hours(self, mod):
        assert mod.max_expected_gap_hours("cron", "0 */4 * * *") == 4.0

    def test_daily_fixed_hour(self, mod):
        assert mod.max_expected_gap_hours("cron", "0 8 * * *") == 24.0

    def test_weekday_only_has_72h_gap_over_weekend(self, mod):
        # "0 7 * * 1-5" — Fri→Mon is 72h, NOT 24h
        assert mod.max_expected_gap_hours("cron", "0 7 * * 1-5") == 72.0

    def test_weekday_only_mon_fri_word_form(self, mod):
        assert mod.max_expected_gap_hours("cron", "0 7 * * mon-fri") == 72.0

    def test_single_weekday_is_weekly(self, mod):
        assert mod.max_expected_gap_hours("cron", "0 8 * * 3") == 168.0

    def test_multi_time_per_day(self, mod):
        # Fires at 8, 11, 14, 17, 20 — largest gap is 20→8 next day = 12h
        assert mod.max_expected_gap_hours("cron", "0 8,11,14,17,20 * * *") == 12.0

    def test_comma_weekdays_mwf(self, mod):
        # Mon/Wed/Fri = days 1,3,5 → max gap Fri→Mon = 3 days
        assert mod.max_expected_gap_hours("cron", "0 8 * * 1,3,5") == 72.0

    def test_non_cron_returns_none(self, mod):
        assert mod.max_expected_gap_hours("interval", "3600") is None

    def test_malformed_returns_none(self, mod):
        assert mod.max_expected_gap_hours("cron", "not a cron") is None

    def test_unknown_dow_form_returns_none(self, mod):
        # Don't guess — better to skip than false-alarm
        assert mod.max_expected_gap_hours("cron", "0 8 * * 1-5,7") is None


class TestClassifyStale:
    """Integration-ish: build a fake sqlite3.Row and feed classify()."""

    def _make_row(self, last_run, schedule_value, *, last_result="Completed"):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE t (id, group_folder, schedule_type, schedule_value, status, last_run, last_result, created_at)"
        )
        conn.execute(
            "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "task-1",
                "g",
                "cron",
                schedule_value,
                "active",
                last_run.isoformat() if last_run else None,
                last_result,
                "2026-01-01T00:00:00+00:00",
            ),
        )
        return conn.execute("SELECT * FROM t").fetchone()

    def test_weekday_cron_monday_morning_is_not_stale(self, mod):
        """Regression: a weekday-only cron that last ran Friday must not
        be flagged STALE when checked Monday morning — 72h elapsed is
        exactly the expected weekend gap."""
        now = datetime(2026, 4, 20, 11, 30, tzinfo=timezone.utc)  # Monday 7:30 ET
        last_friday = datetime(2026, 4, 17, 11, 30, tzinfo=timezone.utc)
        row = self._make_row(last_friday, "30 7 * * 1-5")
        assert mod.classify(row, now) is None

    def test_daily_cron_48h_elapsed_is_stale(self, mod):
        now = datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc)
        two_days_ago = now - timedelta(hours=48)
        row = self._make_row(two_days_ago, "0 8 * * *")
        verdict = mod.classify(row, now)
        assert verdict is not None
        assert verdict[0] == "STALE"

    def test_never_run_fresh_task_not_flagged(self, mod):
        """A task created <24h ago that hasn't run yet is fine."""
        now = datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc)
        row = self._make_row(None, "0 8 * * *")
        # Override created_at to be recent via a fresh row
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE t (id, group_folder, schedule_type, schedule_value, status, last_run, last_result, created_at)"
        )
        conn.execute(
            "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("t1", "g", "cron", "0 8 * * *", "active", None, None, (now - timedelta(hours=6)).isoformat()),
        )
        row = conn.execute("SELECT * FROM t").fetchone()
        assert mod.classify(row, now) is None

    def test_never_run_old_task_is_flagged(self, mod):
        now = datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc)
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE t (id, group_folder, schedule_type, schedule_value, status, last_run, last_result, created_at)"
        )
        conn.execute(
            "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("t1", "g", "cron", "0 8 * * 3", "active", None, None, (now - timedelta(days=10)).isoformat()),
        )
        row = conn.execute("SELECT * FROM t").fetchone()
        verdict = mod.classify(row, now)
        assert verdict is not None
        assert verdict[0] == "NEVER"


class TestGuardSkipClassification:
    """Regression: exit-1 guard-skip (normal "no work") must stay silent,
    but exit-2+ / crash guard results must classify as HARD. Before the
    2026-04-20 fix, SKIP_RE swallowed *all* "Skipped: Guard" results,
    so a broken guard looked identical to a normal skip for 5 days."""

    def _row(self, last_result, schedule_value="0,30 9-17 * * 1-5"):
        now = datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc)
        last_run = now - timedelta(minutes=5)
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE t (id, group_folder, schedule_type, schedule_value, status, last_run, last_result, created_at)"
        )
        conn.execute(
            "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("t1", "g", "cron", schedule_value, "active",
             last_run.isoformat(), last_result, "2026-01-01T00:00:00+00:00"),
        )
        return conn.execute("SELECT * FROM t").fetchone(), now

    def test_exit_1_skip_is_silent(self, mod):
        row, now = self._row("Skipped: Guard exit code 1: No unread messages")
        assert mod.classify(row, now) is None

    def test_exit_2_skip_is_hard(self, mod):
        row, now = self._row(
            "Skipped: Guard exit code 2: python3: can't open file '/workspace/...'"
        )
        verdict = mod.classify(row, now)
        assert verdict is not None
        assert verdict[0] == "HARD"

    def test_exit_42_skip_is_hard(self, mod):
        # Synthetic crash — confirms we flag any non-1 exit code
        row, now = self._row("Skipped: Guard exit code 42: something else")
        verdict = mod.classify(row, now)
        assert verdict is not None
        assert verdict[0] == "HARD"

    def test_exit_137_kill_is_not_flagged(self, mod):
        # 137 = SIGKILL. HARD_RE explicitly excludes it (orphan-cleanup kills)
        row, now = self._row("Skipped: Guard exit code 137: killed")
        assert mod.classify(row, now) is None


class TestStuckRunning:
    """Regression: tasks stuck in status='running' after a SIGTERM were
    invisible to the old health check (which filtered status='active').
    Now they surface as STUCK."""

    def _row(self, status, last_run):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE t (id, group_folder, schedule_type, schedule_value, status, last_run, last_result, created_at)"
        )
        conn.execute(
            "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("t1", "g", "cron", "0 * * * *", status,
             last_run.isoformat() if last_run else None,
             "", "2026-01-01T00:00:00+00:00"),
        )
        return conn.execute("SELECT * FROM t").fetchone()

    def test_running_for_5min_is_ok(self, mod):
        now = datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc)
        row = self._row("running", now - timedelta(minutes=5))
        assert mod.check_stuck_running(row, now) is None

    def test_running_for_2h_is_stuck(self, mod):
        now = datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc)
        row = self._row("running", now - timedelta(hours=2))
        verdict = mod.check_stuck_running(row, now)
        assert verdict is not None
        assert verdict[0] == "STUCK"
        assert "2h" in verdict[1]

    def test_running_no_last_run_is_stuck(self, mod):
        now = datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc)
        row = self._row("running", None)
        verdict = mod.check_stuck_running(row, now)
        assert verdict is not None
        assert verdict[0] == "STUCK"

    def test_active_row_returns_none(self, mod):
        # check_stuck_running only fires on status='running'
        now = datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc)
        row = self._row("active", now - timedelta(hours=10))
        assert mod.check_stuck_running(row, now) is None
