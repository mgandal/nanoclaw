#!/usr/bin/env python3
"""Scan scheduled_tasks for recent failures. Output JSON for the agent to format.

Run signals (one of):
- HARD: last_result starts with "Error:" or contains "exit code N" (where N != 137 from a known kill)
- SOFT: last_result contains "failed" / "WARNING" / "not configured" / "could not" outside <internal> tags
- STALE: status=active, schedule_type=cron, last_run more than 2x the expected interval ago
- NEVER: status=active, last_run NULL, created more than 24h ago

Outputs JSON {issues: [{id, group, severity, reason, snippet, last_run}]} to stdout.
Exit 0 if no issues, 2 if any issues.
"""

import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Path resolution — works on host AND inside container (where project is at /workspace/project)
DB_CANDIDATES = [
    Path("/workspace/project/store/messages.db"),  # in container
    Path("/Users/mgandal/Agents/nanoclaw/store/messages.db"),  # on host
]
DB = next((p for p in DB_CANDIDATES if p.exists()), DB_CANDIDATES[-1])
WINDOW_HOURS = 26  # 24 + slop so we never miss an overnight run

# Patterns
HARD_RE = re.compile(r"^Error:|exit code (?!137)\d+|Container exited with code (?!137)\d+", re.IGNORECASE)
SOFT_RE = re.compile(r"\b(failed|FAILED|not configured|could not|cannot find|no such|unable to)\b")
WARN_PREFIX_RE = re.compile(r"^WARNING:", re.IGNORECASE)

# False-positive guards: these patterns mean "intentional skip / managed condition", not a real failure
SKIP_RE = re.compile(r"^Skipped:\s+Guard exit code 1\b|silent failure — no message|silent exit as instructed|SimpleMem (decommissioned|unavailable|not available)|Quiet period", re.IGNORECASE)


def parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        # Some legacy rows in scheduled_tasks.created_at lack a TZ — assume UTC
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def max_expected_gap_hours(schedule_type: str, schedule_value: str) -> float | None:
    """Longest gap (hours) between consecutive fires for this schedule.

    For daily-at-hour-N every weekday (`0 7 * * 1-5`), the Fri→Mon gap is 72h.
    That is the worst-case "silence" we expect, and anything beyond is a stale
    signal — not 24h (the common-case interval). Returns None when we cannot
    reliably classify the schedule; the caller must treat that as "do not trip".
    """
    if schedule_type != "cron":
        return None
    parts = schedule_value.strip().split()
    if len(parts) < 5:
        return None
    minute, hour, dom, month, dow = parts[:5]

    # */N hour patterns — fires every N hours, so max gap = N
    if hour.startswith("*/"):
        try:
            return float(hour[2:])
        except ValueError:
            return None

    # Multi-time-per-day (e.g. "8,11,14,17,20") — max gap is the largest
    # inter-hour jump including the wrap-around to the next day.
    if "," in hour and all(p.isdigit() for p in hour.split(",")):
        hours = sorted(int(h) for h in hour.split(","))
        gaps = [hours[i + 1] - hours[i] for i in range(len(hours) - 1)]
        gaps.append(24 - hours[-1] + hours[0])  # wrap
        return float(max(gaps))

    # Single-hour schedules (daily or weekday-restricted)
    if hour.isdigit() and dom == "*" and month == "*":
        if dow == "*":
            return 24.0
        # Weekday-only (mon-fri): 72h Fri→Mon gap
        if dow in ("1-5", "mon-fri", "MON-FRI"):
            return 72.0
        # Single weekday (e.g. "0 8 * * 3" — every Wednesday): weekly
        if dow.isdigit():
            return 24.0 * 7
        # Comma list of weekdays — compute max gap between selected days
        if "," in dow:
            try:
                days = sorted(int(d) for d in dow.split(","))
                # Cron DOW: 0=Sun or 7=Sun, 1=Mon..6=Sat; normalize 7→0
                days = sorted({d % 7 for d in days})
                if len(days) == 1:
                    return 24.0 * 7
                day_gaps = [days[i + 1] - days[i] for i in range(len(days) - 1)]
                day_gaps.append(7 - days[-1] + days[0])
                return 24.0 * max(day_gaps)
            except ValueError:
                return None
        # Unknown dow form — be safe, don't trip
        return None

    return None


def classify(row: sqlite3.Row, now: datetime) -> tuple[str, str] | None:
    """Return (severity, reason) or None if healthy."""
    last_result = (row["last_result"] or "").strip()
    last_run = parse_iso(row["last_run"])
    created = parse_iso(row["created_at"])

    # Never-run check
    if not last_run:
        if created and (now - created) > timedelta(hours=24):
            age_h = int((now - created).total_seconds() / 3600)
            return ("NEVER", f"never executed ({age_h}h since created)")
        return None

    # Stale check — trip only when elapsed is >25% past the worst legitimate
    # gap for this schedule, so weekday-only crons don't false-alarm Monday.
    max_gap_h = max_expected_gap_hours(row["schedule_type"], row["schedule_value"])
    if max_gap_h:
        elapsed_h = (now - last_run).total_seconds() / 3600
        if elapsed_h > 1.25 * max_gap_h:
            return ("STALE", f"last ran {elapsed_h:.0f}h ago (max gap {max_gap_h:.0f}h)")

    # Only inspect last_result for runs in the last 26h
    if (now - last_run) > timedelta(hours=WINDOW_HOURS):
        return None

    if not last_result or last_result.lower() in ("completed", "ok", "done"):
        return None

    # False-positive guards win
    if SKIP_RE.search(last_result):
        return None

    # <internal> narratives are agent self-talk, not status — only check the part outside the tag
    visible = re.sub(r"<internal>.*?</internal>", "", last_result, flags=re.DOTALL).strip()
    if not visible:
        return None

    if HARD_RE.search(visible[:200]):
        return ("HARD", "error in last_result")
    if WARN_PREFIX_RE.search(visible[:50]):
        return ("SOFT", "warning prefix in last_result")
    if SOFT_RE.search(visible[:300]):
        return ("SOFT", "failure word in last_result")

    return None


STUCK_RUNNING_THRESHOLD = timedelta(hours=1)


def check_stuck_running(row: sqlite3.Row, now: datetime) -> tuple[str, str] | None:
    """Return ('STUCK', reason) if this task has been in 'running' for >1h.

    A healthy run completes in seconds to minutes. Rows stuck in 'running'
    indicate markTaskRunning fired but updateTaskAfterRun did not — usually
    because the process was SIGTERM'd mid-run (see recoverRunningTasks in
    src/db.ts which is supposed to flip these back at startup).
    """
    if row["status"] != "running":
        return None
    last_run = parse_iso(row["last_run"])
    if not last_run:
        return ("STUCK", "status=running with no last_run")
    elapsed = now - last_run
    if elapsed > STUCK_RUNNING_THRESHOLD:
        hours = int(elapsed.total_seconds() / 3600)
        return ("STUCK", f"status=running for {hours}h (expected <1h)")
    return None


def main():
    now = datetime.now(timezone.utc)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    # Also surface 'running' — a stuck task is invisible otherwise.
    rows = conn.execute(
        """
        SELECT id, group_folder, schedule_type, schedule_value, status,
               last_run, last_result, created_at
        FROM scheduled_tasks
        WHERE status IN ('active', 'running')
        """
    ).fetchall()

    issues = []
    for row in rows:
        verdict = check_stuck_running(row, now) if row["status"] == "running" else classify(row, now)
        if verdict:
            severity, reason = verdict
            snippet = (row["last_result"] or "")[:160].replace("\n", " ")
            issues.append({
                "id": row["id"],
                "group": row["group_folder"],
                "severity": severity,
                "reason": reason,
                "snippet": snippet,
                "last_run": row["last_run"],
                "schedule": row["schedule_value"],
            })

    def _severity_rank(s: str) -> int:
        return {"HARD": 0, "STUCK": 1, "STALE": 2, "NEVER": 3}.get(s, 4)

    out = {
        "checked_at": now.isoformat(),
        "active_tasks": len(rows),
        "issue_count": len(issues),
        "issues": sorted(issues, key=lambda i: (_severity_rank(i["severity"]), i["id"])),
    }
    print(json.dumps(out, indent=2))
    return 2 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
