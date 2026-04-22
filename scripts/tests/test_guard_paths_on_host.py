"""Invariant test: every scheduled_tasks.script that points at a file must
point at a file path that EXISTS ON THE HOST, because runGuardScript (in
src/task-scheduler.ts) calls `/bin/bash -c <script>` on the host shell with
host $PATH and host filesystem. `/workspace/...` paths are container-only
and will always fail at guard time with ENOENT.

This test scans the live DB. It's an invariant guard: if someone ever
accidentally writes a container path into a guard script field again, the
next test run will catch it before it ships to launchd.
"""

import os
import re
import sqlite3
from pathlib import Path

import pytest

DB_CANDIDATES = [
    Path("/workspace/project/store/messages.db"),
    Path("/Users/mgandal/Agents/nanoclaw/store/messages.db"),
]
DB = next((p for p in DB_CANDIDATES if p.exists()), DB_CANDIDATES[-1])

# Match file paths referenced inside a shell script. We accept either
# absolute host paths (/Users/...) or explicit container paths (/workspace/...)
# but only the host paths will actually run when `/bin/bash -c` is invoked
# from the orchestrator process.
PATH_RE = re.compile(r"(/(?:Users|Volumes|opt|workspace|home)/[^\s'\"`;|&><]+\.py\b)")


def _scripts_from_db():
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, group_folder, script FROM scheduled_tasks "
        "WHERE status='active' AND script IS NOT NULL AND script != ''"
    ).fetchall()
    conn.close()
    return rows


@pytest.mark.parametrize("row", _scripts_from_db(), ids=lambda r: r["id"])
def test_guard_script_paths_exist_on_host(row):
    """Every .py path referenced by an active guard script must exist on
    the host filesystem. Container-only paths (/workspace/...) are never
    reachable from the host shell and represent a configuration bug."""
    script = row["script"]
    paths = PATH_RE.findall(script)
    if not paths:
        pytest.skip(f"{row['id']}: no .py path in script (not a file-based guard)")

    missing = []
    container_only = []
    for p in paths:
        if p.startswith("/workspace/"):
            container_only.append(p)
        elif not Path(p).exists():
            missing.append(p)

    msg_parts = []
    if container_only:
        msg_parts.append(
            f"container-only paths (unreachable from host shell): {container_only}"
        )
    if missing:
        msg_parts.append(f"missing host paths: {missing}")
    assert not msg_parts, (
        f"Task {row['id']} (group={row['group_folder']}) has unusable guard paths — "
        + "; ".join(msg_parts)
    )
