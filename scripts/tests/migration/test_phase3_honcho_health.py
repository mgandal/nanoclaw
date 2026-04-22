"""Phase 3 TDD: retire Hermes honcho-health-check.

The NanoClaw infrastructure-health task in OPS-claw already probes Honcho
and Ollama models, so the Hermes port is effectively done — this test
asserts coverage equivalence before retirement.

RED/GREEN structure:
  1. A NanoClaw scheduled task must exist that probes Honcho API
  2. That task must also verify phi4-mini AND nomic-embed-text are loaded
  3. The task must be active and have run successfully recently

Disposable: delete once Phase 4 Hermes decommission is verified.
"""

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


DB_PATH = Path.home() / "Agents" / "nanoclaw" / "store" / "messages.db"
STALE_THRESHOLD = timedelta(days=7)


@pytest.fixture(scope="module")
def conn():
    if not DB_PATH.exists():
        pytest.skip(f"DB not found at {DB_PATH}")
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    yield c
    c.close()


@pytest.fixture(scope="module")
def infra_task(conn):
    """The active OPS-claw scheduled task whose prompt probes shared infra."""
    rows = conn.execute(
        "SELECT id, group_folder, schedule_value, status, last_run, last_result, prompt "
        "FROM scheduled_tasks "
        "WHERE status='active' "
        "  AND group_folder='telegram_ops-claw' "
        "  AND prompt LIKE '%Honcho%' "
        "  AND prompt LIKE '%Ollama%'"
    ).fetchall()
    if not rows:
        pytest.fail(
            "No active OPS-claw scheduled task probes both Honcho and Ollama. "
            "Hermes honcho-health-check cannot be retired without an equivalent."
        )
    # If multiple, prefer the one that explicitly checks phi4-mini.
    for r in rows:
        if "phi4-mini" in r["prompt"]:
            return r
    return rows[0]


def test_infra_task_probes_honcho_api(infra_task):
    prompt = infra_task["prompt"]
    assert "8010" in prompt, (
        "Infra health task must probe Honcho API on port 8010."
    )
    assert "Honcho" in prompt


def test_infra_task_verifies_required_ollama_models(infra_task):
    prompt = infra_task["prompt"]
    # These are the two models Honcho depends on per the memory notes.
    assert "phi4-mini" in prompt, (
        "Infra health task must verify phi4-mini is loaded in Ollama "
        "(Honcho's reasoning model since Apr 11 2026)."
    )
    assert "nomic-embed-text" in prompt, (
        "Infra health task must verify nomic-embed-text is loaded "
        "(Honcho's embedding model, 768-dim)."
    )


def test_infra_task_probes_dialectic_latency(infra_task):
    prompt = infra_task["prompt"]
    # Deep-health check — Hermes did this; NanoClaw must too since `/docs`
    # returning 200 does not prove dialectic works.
    assert "dialectic" in prompt.lower(), (
        "Infra health task must POST to the Honcho dialectic endpoint — "
        "Hermes's honcho-health-check did this and it catches hangs that "
        "the /docs probe misses."
    )
    assert "/v3/workspaces" in prompt, (
        "Dialectic probe must hit /v3/workspaces/.../chat."
    )


def test_infra_task_ran_recently(infra_task):
    last_run = infra_task["last_run"]
    assert last_run, (
        f"Infra health task {infra_task['id']!r} has never run — "
        "cannot prove it's a viable Hermes replacement."
    )
    dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
    age = datetime.now(timezone.utc) - dt
    assert age < STALE_THRESHOLD, (
        f"Infra health task last ran {age.days}d ago. "
        "Re-verify before retiring Hermes honcho-health-check."
    )
