"""Gap fix: memory-integrity task must not reference decommissioned SimpleMem.

task-1776026695765-w23mk8 (weekly Mon 9am, OPS-claw) previously queried
mcp__simplemem__memory_query for 6 group canaries. SimpleMem was decommissioned
2026-04-06 (replaced by Honcho + Hindsight). The query silently failed, so
the task never alerted — zero working memory-canary coverage.

After the fix, the prompt:
  - must NOT reference simplemem (tool or concept)
  - must still run the file-based integrity checker (Step 1, working)
  - must include a live memory-stack probe via Hindsight (retain + query roundtrip)
"""

import sqlite3
from pathlib import Path

import pytest


DB_PATH = Path.home() / "Agents" / "nanoclaw" / "store" / "messages.db"
TASK_ID = "task-1776026695765-w23mk8"


@pytest.fixture(scope="module")
def prompt():
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT prompt FROM scheduled_tasks WHERE id=?", (TASK_ID,)
    ).fetchone()
    conn.close()
    if not row:
        pytest.skip(f"Task {TASK_ID} not found")
    return row[0]


def test_no_simplemem_references(prompt):
    lowered = prompt.lower()
    assert "simplemem" not in lowered, (
        "Memory canary prompt still references decommissioned SimpleMem. "
        "Rewrite Step 2 to use Honcho or Hindsight for live probe."
    )
    assert "mcp__simplemem" not in prompt, (
        "Prompt still references SimpleMem MCP tool (decommissioned 2026-04-06)."
    )


def test_file_integrity_step_retained(prompt):
    # Step 1 (file-based integrity) is the working check — must remain.
    assert "integrity_checker.py" in prompt, (
        "Step 1 file-based integrity check must remain — it's the only "
        "part of the prior prompt that actually worked."
    )


def test_live_memory_probe_present(prompt):
    # Replacement probe must actively touch the memory stack, not just read files.
    lowered = prompt.lower()
    has_hindsight_probe = "hindsight" in lowered
    has_honcho_probe = "honcho" in lowered
    assert has_hindsight_probe or has_honcho_probe, (
        "Prompt must include a live memory-stack probe (Hindsight retain+query "
        "or Honcho profile check). Otherwise we lose canary coverage entirely."
    )
