#!/usr/bin/env python3
"""Scan launchd for nanoclaw jobs whose last fire failed.

For each job under com.nanoclaw.* that is currently *loaded*, read
`launchctl print` and report any with `last exit code != 0`. Jobs that are
unloaded (intentionally dormant) are skipped — only "loaded but failing"
counts as a regression.

Outputs JSON {issues: [{label, last_exit, runs, state, plist_path}]} to stdout.
Exit 0 if no issues, 2 if any issues, 3 if launchctl itself isn't usable.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

LAUNCHAGENTS_DIR = Path.home() / "Library" / "LaunchAgents"
LABEL_PREFIX = "com.nanoclaw."

# Per-job allowlist: jobs that are *expected* to exit with specific nonzero
# codes. Skip ONLY those specific codes — any other nonzero exit still alerts,
# so a real crash (ImportError → 1, OOM → 137, segfault → 139, etc.) is not
# silently swallowed. Add reasoning per entry.
EXPECTED_NONZERO: dict[str, dict] = {
    # error-audit's plist explicitly documents: "The script itself exits 2
    # when actionable issues exist, 0 otherwise — downstream alert routing
    # should read the JSON output rather than trigger on exit code alone."
    # The script's own JSON-driven alert path runs separately, so a "issues
    # found" exit here is not a launchd regression — but a crash IS.
    "com.nanoclaw.error-audit": {
        "codes": [2],
        "reason": "exit 2 = audit found actionable issues (by design)",
    },
}


def list_loaded_jobs() -> dict[str, tuple[str, str]]:
    """Return {label: (pid, last_exit)} for jobs visible to `launchctl list`.

    `launchctl list` output is tab-separated: PID | LAST_EXIT | LABEL.
    PID is "-" when not currently running.
    """
    try:
        out = subprocess.run(
            ["launchctl", "list"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as err:
        print(f"launchctl list failed: {err}", file=sys.stderr)
        sys.exit(3)

    jobs: dict[str, tuple[str, str]] = {}
    for line in out.splitlines()[1:]:  # skip header
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        pid, last_exit, label = parts[0], parts[1], parts[2]
        if label.startswith(LABEL_PREFIX):
            jobs[label] = (pid, last_exit)
    return jobs


def get_state(label: str) -> str:
    """Best-effort `state = …` extraction from `launchctl print`. Returns "" if unavailable."""
    uid = os.getuid()
    try:
        out = subprocess.run(
            ["launchctl", "print", f"gui/{uid}/{label}"],
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""
    m = re.search(r"^\s*state\s*=\s*(.+?)\s*$", out, re.MULTILINE)
    return m.group(1) if m else ""


def find_plist_path(label: str) -> str:
    """Return the on-disk plist path for label, or empty string if not in user LaunchAgents."""
    candidate = LAUNCHAGENTS_DIR / f"{label}.plist"
    return str(candidate) if candidate.exists() else ""


def classify(jobs: dict[str, tuple[str, str]]) -> list[dict]:
    issues = []
    for label, (pid, last_exit) in sorted(jobs.items()):
        try:
            exit_code = int(last_exit)
        except ValueError:
            continue  # "-" or other non-numeric placeholder
        if exit_code == 0:
            continue
        # Only allowlist the *specific* exit codes documented as by-design.
        # Any other nonzero (crash, OOM, segfault, etc.) still alerts.
        allowed = EXPECTED_NONZERO.get(label)
        if allowed and exit_code in allowed["codes"]:
            continue
        issues.append(
            {
                "label": label,
                "last_exit": exit_code,
                "pid": pid,
                "state": get_state(label),
                "plist_path": find_plist_path(label),
            }
        )
    return issues


def main() -> int:
    jobs = list_loaded_jobs()
    issues = classify(jobs)
    payload = {
        "checked": len(jobs),
        "issue_count": len(issues),
        "issues": issues,
    }
    print(json.dumps(payload, indent=2))
    return 2 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
