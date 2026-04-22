"""Phase 3 retirement gates for Memory Stack Health Check and daily-ops-pipeline.

Both Hermes jobs are being retired without direct ports:

  - Memory Stack Health Check: broken in Hermes (last_status=error). NanoClaw
    has a parallel memory-integrity task in OPS-claw that also appears to
    reference the decommissioned SimpleMem — see TODO in that task. Retiring
    Hermes's version does not reduce working coverage.

  - daily-ops-pipeline: Hermes-specific orchestrator whose 5 stages are each
    already covered by separate NanoClaw cron tasks (infra health, morning
    briefing, inbox monitor, context capture, slack digest). Documented
    decomposition below.

This test asserts the decomposition coverage so we can retire daily-ops
with evidence.

Disposable: delete once Phase 4 decommission is verified.
"""

import sqlite3
from pathlib import Path

import pytest


DB_PATH = Path.home() / "Agents" / "nanoclaw" / "store" / "messages.db"


@pytest.fixture(scope="module")
def conn():
    if not DB_PATH.exists():
        pytest.skip(f"DB not found at {DB_PATH}")
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    yield c
    c.close()


def _active(conn, where_clause, params=()):
    return conn.execute(
        "SELECT id FROM scheduled_tasks WHERE status='active' AND " + where_clause,
        params,
    ).fetchall()


# daily-ops-pipeline stage mapping — each stage → one or more NanoClaw tasks
# that cover it.

def test_stage1_health_and_recovery_covered(conn):
    """Stage 1: Infrastructure health probe. Covered by OPS-claw 11am task."""
    rows = _active(
        conn,
        "group_folder='telegram_ops-claw' AND prompt LIKE '%Honcho%' "
        "AND prompt LIKE '%Ollama%'",
    )
    assert rows, "Missing OPS-claw infra health task (daily-ops Stage 1 coverage)"


def test_stage2_data_ingestion_covered(conn):
    """Stage 2: Slack + email + external data ingestion.

    Covered by three separate tasks: slack-morning-digest, mgandal-cc-inbox,
    and the sync launchd cron (gmail-sync + apple-notes export).
    """
    slack = _active(conn, "id='slack-morning-digest-1776622600'")
    assert slack, "Missing slack-morning-digest task (daily-ops Stage 2a)"
    inbox = _active(conn, "id='mgandal-cc-inbox'")
    assert inbox, (
        "Missing mgandal-cc-inbox task (daily-ops Stage 2b — email ingestion). "
        "Phase 2 port must land before retiring daily-ops-pipeline."
    )


def test_stage3_memory_sync_covered_or_acknowledged_broken(conn):
    """Stage 3: Memory system sync.

    NanoClaw has a memory integrity task (task-1776026695765-w23mk8) but it
    references decommissioned SimpleMem. We acknowledge the gap rather than
    block retirement on it — the Hermes equivalent was also broken.
    """
    rows = _active(conn, "id='task-1776026695765-w23mk8'")
    assert rows, (
        "NanoClaw memory-integrity task missing. Even though it's partially "
        "stale (SimpleMem references), removing it silently loses the canary "
        "check. Keep it until replaced."
    )


def test_stage4_task_management_covered(conn):
    """Stage 4: Task management — daily task-health check runs at noon."""
    rows = _active(
        conn,
        "group_folder='telegram_ops-claw' AND prompt LIKE '%task-health%'",
    )
    assert rows, "Missing daily task-health scheduled check (daily-ops Stage 4)"


def test_stage5_briefing_covered(conn):
    """Stage 5: Morning briefing — claire-morning-briefing at 7:30 weekdays."""
    rows = _active(conn, "id='claire-morning-briefing'")
    assert rows, "Missing claire-morning-briefing task (daily-ops Stage 5)"


def test_memory_stack_retirement_has_replacement_or_is_documented_broken(conn):
    """Hermes Memory Stack Health Check was broken (last_status=error).

    Retirement is safe as long as *some* NanoClaw memory-health task exists.
    That's the w23mk8 task above. This test exists to make the retirement
    decision explicit and discoverable.
    """
    rows = _active(conn, "id='task-1776026695765-w23mk8'")
    assert rows, (
        "No active NanoClaw memory-health task — retiring Hermes version "
        "would leave zero coverage. Restore or replace before retirement."
    )
