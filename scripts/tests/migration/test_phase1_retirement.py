"""Phase 1 retirement regression test.

Asserts that the NanoClaw equivalents of the 5 Hermes jobs being retired
have run successfully within the last 14 days. This test must stay GREEN
both before and after disabling the Hermes side — if a NanoClaw equivalent
stops running, we should NOT retire the Hermes fallback.

Disposable: delete this file once Phase 4 (Hermes decommission) is verified
and stable.
"""

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


DB_PATH = Path.home() / "Agents" / "nanoclaw" / "store" / "messages.db"

# Hermes job name -> NanoClaw scheduled_tasks.id that replaces it.
# Only jobs that are currently Hermes-enabled need a live NanoClaw equivalent;
# already-disabled Hermes jobs are listed here for audit only.
RETIREMENT_MAP = {
    # Hermes enabled=True jobs → NanoClaw must currently cover them
    "AI Morning Brief + Builders Digest": "hermes-ai-brief",
    "slack-context-scanner": "hermes-slack-scanner",
    # Hermes enabled=False jobs → NanoClaw equivalent optional but expected
    "weekly-week-ahead": "hermes-week-ahead",
    "blogwatcher-scan": "hermes-blogwatcher",
    # paperpile-sync has no NanoClaw port; Mike OK'd dropping it entirely
}

STALE_THRESHOLD = timedelta(days=14)


@pytest.fixture(scope="module")
def conn():
    if not DB_PATH.exists():
        pytest.skip(f"DB not found at {DB_PATH}")
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    yield c
    c.close()


def _parse_iso(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


@pytest.mark.parametrize("hermes_name,nanoclaw_id", list(RETIREMENT_MAP.items()))
def test_nanoclaw_equivalent_ran_recently(conn, hermes_name, nanoclaw_id):
    row = conn.execute(
        "SELECT id, status, last_run, last_result FROM scheduled_tasks WHERE id = ?",
        (nanoclaw_id,),
    ).fetchone()

    assert row is not None, (
        f"NanoClaw equivalent '{nanoclaw_id}' for Hermes job "
        f"'{hermes_name}' is missing from scheduled_tasks. Do NOT retire the "
        f"Hermes job until the NanoClaw port exists."
    )

    assert row["status"] == "active", (
        f"NanoClaw '{nanoclaw_id}' exists but status={row['status']!r}. "
        f"Reactivate before retiring Hermes side."
    )

    last_run = _parse_iso(row["last_run"])
    assert last_run is not None, (
        f"NanoClaw '{nanoclaw_id}' has never run — no evidence it works."
    )

    now = datetime.now(timezone.utc)
    age = now - last_run
    assert age < STALE_THRESHOLD, (
        f"NanoClaw '{nanoclaw_id}' last ran {age.days}d ago "
        f"(>{STALE_THRESHOLD.days}d) — do NOT retire Hermes until this is "
        f"healthy again."
    )

    last_result = (row["last_result"] or "").lower()
    # Accept any non-empty result that doesn't start with an error keyword.
    # `last_result` is free-form prose, so this is heuristic — a failing run
    # will typically say 'error', 'failed', or 'exception'.
    error_markers = ("error:", "failed", "exception", "traceback")
    assert not any(m in last_result for m in error_markers), (
        f"NanoClaw '{nanoclaw_id}' last_result looks like a failure: "
        f"{row['last_result']!r}"
    )
