"""Tests for scripts/check-launchd-health.py — focuses on classification
logic given a mocked `launchctl list` parse, since exercising real launchctl
in CI would be flaky and host-specific.
"""

import importlib.util
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "check-launchd-health.py"


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("check_launchd_health", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def stub_state(monkeypatch, mod):
    """Stub get_state so tests don't shell out to `launchctl print`."""
    monkeypatch.setattr(mod, "get_state", lambda label: "running")
    monkeypatch.setattr(mod, "find_plist_path", lambda label: f"/fake/{label}.plist")


class TestClassify:
    def test_clean_run_no_issues(self, mod, stub_state):
        jobs = {
            "com.nanoclaw.statusbar": ("1310", "0"),
            "com.nanoclaw.watchdog": ("-", "0"),
        }
        assert mod.classify(jobs) == []

    def test_single_failing_job_surfaces(self, mod, stub_state):
        jobs = {
            "com.nanoclaw.sync": ("-", "3"),
            "com.nanoclaw.statusbar": ("1310", "0"),
        }
        issues = mod.classify(jobs)
        assert len(issues) == 1
        assert issues[0]["label"] == "com.nanoclaw.sync"
        assert issues[0]["last_exit"] == 3

    def test_multiple_failing_jobs_sorted_by_label(self, mod, monkeypatch, stub_state):
        # Clear the live allowlist so this test is independent of which
        # production jobs are currently allowlisted.
        monkeypatch.setattr(mod, "EXPECTED_NONZERO", {})
        jobs = {
            "com.nanoclaw.sync": ("-", "3"),
            "com.nanoclaw.error-audit": ("-", "2"),
            "com.nanoclaw.paperpile-sync": ("-", "1"),
        }
        issues = mod.classify(jobs)
        assert [i["label"] for i in issues] == [
            "com.nanoclaw.error-audit",
            "com.nanoclaw.paperpile-sync",
            "com.nanoclaw.sync",
        ]

    def test_non_numeric_last_exit_is_ignored(self, mod, stub_state):
        # launchctl sometimes shows "-" for last exit on jobs that haven't run
        jobs = {
            "com.nanoclaw.fresh": ("-", "-"),
        }
        assert mod.classify(jobs) == []

    def test_allowlisted_failing_job_is_skipped(self, mod, monkeypatch, stub_state):
        monkeypatch.setattr(
            mod,
            "EXPECTED_NONZERO",
            {"com.nanoclaw.flaky": "reason — exits 1 when no work to do"},
        )
        jobs = {
            "com.nanoclaw.flaky": ("-", "1"),
            "com.nanoclaw.sync": ("-", "3"),
        }
        issues = mod.classify(jobs)
        assert [i["label"] for i in issues] == ["com.nanoclaw.sync"]

    def test_unloaded_jobs_never_appear(self, mod, stub_state):
        # The script's contract is that classify() only sees loaded jobs.
        # An empty dict (nothing loaded) should yield no issues.
        assert mod.classify({}) == []


class TestLiveAllowlist:
    """Pin the production allowlist so regressions are surfaced when entries
    are added or removed. See plist comments / project_launchd_health_monitor.md
    for the rationale behind each entry."""

    def test_error_audit_is_allowlisted(self, mod):
        # Plist explicitly documents that exit 2 = "audit found actionable
        # issues" (working as designed, not a regression).
        assert "com.nanoclaw.error-audit" in mod.EXPECTED_NONZERO


class TestListLoadedJobs:
    def test_filter_to_nanoclaw_prefix(self, mod, monkeypatch):
        # Simulate `launchctl list` output: header line + 4 rows, only 2 match.
        fake_stdout = (
            "PID\tStatus\tLabel\n"
            "1310\t0\tcom.nanoclaw.statusbar\n"
            "1363\t0\tcom.qmd-server\n"
            "-\t3\tcom.nanoclaw.sync\n"
            "1589\t0\tcom.docker.docker\n"
        )

        class FakeResult:
            stdout = fake_stdout

        monkeypatch.setattr(
            mod.subprocess, "run", lambda *a, **kw: FakeResult()
        )
        jobs = mod.list_loaded_jobs()
        assert set(jobs.keys()) == {"com.nanoclaw.statusbar", "com.nanoclaw.sync"}
        assert jobs["com.nanoclaw.sync"] == ("-", "3")
