#!/usr/bin/env python3
"""Daily error audit for NanoClaw.

Collects errors from the last rolling 24h across three sources:
  - task_run_logs (SQLite) — structured, reliable, DB timestamps
  - logs/nanoclaw.error.log — raw launchd stderr (every line = real bug)
  - logs/nanoclaw.log — pino pretty output (date-less, tail by byte offset)

Classifies each normalized record into: transient / config / bug / infra / unknown
via a regex rule table (LLM fallback for `unknown` is reserved for a later
iteration and intentionally omitted here to keep the cron path dependency-free).

Outputs a JSON summary to stdout and exits 2 if any record is actionable,
0 otherwise — same contract as scripts/check-task-health.py so the launchd
wrapper and downstream alerting follow the established pattern.

Design notes: see docs/plan-telegram-error-audit.md
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Paths — same bootstrap style as check-task-health.py so this runs both on
# the host (via launchd) and inside a container (via a manual invocation).
# ---------------------------------------------------------------------------
_HOST_ROOT = Path("/Users/mgandal/Agents/nanoclaw")
_CONTAINER_ROOT = Path("/workspace/project")
PROJECT_ROOT = _CONTAINER_ROOT if _CONTAINER_ROOT.exists() else _HOST_ROOT

DB_PATH = PROJECT_ROOT / "store" / "messages.db"
LOG_DIR = PROJECT_ROOT / "logs"
STATE_DIR = PROJECT_ROOT / "scripts" / "state"
STATE_PATH = STATE_DIR / "error-audit-state.json"

MAIN_LOG = LOG_DIR / "nanoclaw.log"
ERROR_LOG = LOG_DIR / "nanoclaw.error.log"

# ---------------------------------------------------------------------------
# Thresholds (plan-documented)
# ---------------------------------------------------------------------------
SUSTAINED_SPAN = timedelta(minutes=30)
SUSTAINED_COUNT = 5
WINDOW_HOURS = 24
BOOTSTRAP_BYTES = 5 * 1024 * 1024  # 5 MB first-run tail


# ---------------------------------------------------------------------------
# Classification rules
#
# First match wins. Each entry is (regex, bucket, extra_meta_dict).
# Meta can flag `causal_parent: True` so downstream rules can suppress children.
# Order matters — put specific rules before generic ones.
# ---------------------------------------------------------------------------
_RULES: list[tuple[re.Pattern[str], str, dict[str, Any]]] = [
    # --- transient ---
    (
        re.compile(r"Call to '(setMyName|setMyDescription)' failed.*429", re.I),
        "transient",
        {},
    ),
    # Covers both the pinned-bot warning ("Failed to pre-rename pinned pool bot ...")
    # and the regular pool-bot send fallback ("Failed to rename pool bot (sending anyway)").
    (re.compile(r"Failed to(?:\s+pre)?-rename.*pool bot", re.I), "transient", {}),
    (re.compile(r"Ollama classification failed.*fallback", re.I), "transient", {}),

    # --- infra (tag container timeout as a causal parent so follow-on
    # AbortErrors within the same window can be collapsed under it) ---
    (
        re.compile(r"Container timed out", re.I),
        "infra",
        {"causal_parent": True},
    ),
    (
        re.compile(r'401.*"type":"error".*authentication_error', re.I),
        "infra",
        {},
    ),
    (
        re.compile(r"Failed to authenticate.*API Error: 401", re.I),
        "infra",
        {},
    ),

    # --- config ---
    (
        re.compile(r"Guard exit code \d.*No such file or directory", re.I | re.S),
        "config",
        {},
    ),
    (
        re.compile(r"\[Errno 2\] No such file or directory.*guard", re.I),
        "config",
        {},
    ),
    (
        re.compile(r"Failed to start NanoClaw.*port.*already in use", re.I),
        "config",
        {},
    ),

    # --- PageIndex adapter ---
    # Rate-limit 429s are already handled by src/pageindex.ts (falls back to
    # flat text extraction, zero user impact). These are infra noise, not bugs.
    (
        re.compile(r"PageIndex adapter failed.*(429|rate_limit_error)", re.I | re.S),
        "infra",
        {},
    ),
    # Any OTHER PageIndex failure is a genuine adapter bug — missing venv,
    # Python traceback, JSON decode error, etc. Order matters: put this after
    # the 429 rule so the narrower match wins.
    (re.compile(r"PageIndex adapter failed", re.I), "bug", {}),

    # --- infra / transient boundary on Telegram send retries ---
    (
        re.compile(r"Failed to send Telegram message.*Call to 'sendMessage' failed.*4\d\d", re.I),
        "transient",
        {},
    ),
    # Container timeout variants (different wording than "Container timed out")
    (re.compile(r"Container timeout, stopping gracefully", re.I), "infra", {"causal_parent": True}),
    (re.compile(r"Container agent error", re.I), "infra", {}),
    (re.compile(r"Container exited with error", re.I), "infra", {}),

    # --- Security / policy events (surface as infra so a human sees them
    # but they're not code bugs) ---
    (re.compile(r"Unauthorized IPC message attempt blocked", re.I), "infra", {}),

    # --- bug (source='error_log' gets default-to-bug below; these are
    # body-level pattern matches that also apply when the same shape leaks
    # into the main log) ---
    (re.compile(r"SyntaxError", re.I), "bug", {}),
    (re.compile(r"\"await\" can only be used inside an \"async\" function"), "bug", {}),
    (re.compile(r"Export named '[^']+' not found"), "bug", {}),
]


def classify(
    *,
    source: str,
    message: str,
    error_type: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Return (bucket, meta) for a single normalized error record.

    source: "main_log" | "error_log" | "task_run_logs"
    message: human-readable error text (not the full stack — one line is enough)
    error_type: optional type/class name (e.g. "GrammyError", "AbortError"). Used
                only to narrow causal-chain decisions; message regex still wins.
    """
    for pattern, bucket, meta in _RULES:
        if pattern.search(message):
            return bucket, dict(meta)

    # Default-to-bug for anything in the launchd stderr log — nothing should
    # reach it under normal operation, so novel shapes there are crashes
    # until proven otherwise.
    if source == "error_log":
        return "bug", {}

    return "unknown", {}


def is_actionable(record: dict[str, Any]) -> bool:
    """Threshold logic for whether a normalized record should wake someone.

    Contract (docs/plan-telegram-error-audit.md, post-2026-04-24 retune Q2=c):
      sustained  = (last_seen - first_seen) >= 30 min AND count >= 5
      actionable = sustained OR source == 'error_log' OR bucket == 'bug'
    """
    if record.get("source") == "error_log":
        return True
    if record.get("bucket") == "bug":
        return True
    try:
        first = datetime.fromisoformat(record["first_seen"])
        last = datetime.fromisoformat(record["last_seen"])
    except (KeyError, ValueError):
        return False
    span = last - first
    count = int(record.get("count", 0))
    return span >= SUSTAINED_SPAN and count >= SUSTAINED_COUNT


# ---------------------------------------------------------------------------
# State file — stores byte offsets into the pino main log so we can tail
# "since last run" without relying on the date-less time-of-day stamps.
# ---------------------------------------------------------------------------
def load_state() -> dict[str, Any]:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_state(state: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2))


def tail_since(path: Path, last_offset: int) -> tuple[str, int]:
    """Return (text since offset, new end-of-file offset)."""
    if not path.exists():
        return "", last_offset
    size = path.stat().st_size
    # If file shrank, assume rotation and read the last N bytes.
    start = last_offset if 0 <= last_offset <= size else max(0, size - BOOTSTRAP_BYTES)
    with path.open("rb") as f:
        f.seek(start)
        blob = f.read()
    try:
        text = blob.decode("utf-8", errors="replace")
    except UnicodeDecodeError:
        text = blob.decode("latin-1", errors="replace")
    return text, size


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------
PINO_HEAD = re.compile(
    r"^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+.*?(ERROR|WARN)\s+\(\d+\):\s+(.+)$"
)
PINO_TIMESTAMP = re.compile(r"^\[\d{2}:\d{2}:\d{2}\.\d{3}\]")
# Dedup key: strip ANSI + truncate so "Call to 'setMyName' failed! (429: ... retry after 10506)"
# collapses with "... retry after 10507" into one record.
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _clean(msg: str) -> str:
    return ANSI.sub("", msg).strip()


def _dedup_key(error_type: str | None, message: str) -> str:
    # Normalize variable bits so identical errors aggregate. Replace:
    #   - absolute paths → <path>
    #   - quoted filenames → <file>
    #   - digits → #
    # Truncate to 200 chars so very long stacks still collapse.
    m = message
    m = re.sub(r"/[\w./\-]+", "<path>", m)
    m = re.sub(r"'[^']+\.\w{2,5}'", "<file>", m)
    m = re.sub(r"\d+", "#", m)
    return f"{error_type or ''}::{m[:200]}"


def collect_task_run_logs(now: datetime) -> list[dict[str, Any]]:
    """Pull failing task runs in the last WINDOW_HOURS."""
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    cutoff = (now - timedelta(hours=WINDOW_HOURS)).isoformat()
    rows = conn.execute(
        """
        SELECT task_id, run_at, status, error
        FROM task_run_logs
        WHERE run_at >= ? AND status = 'error' AND error IS NOT NULL AND error != ''
        """,
        (cutoff,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def collect_log_lines(text: str, source: str) -> list[dict[str, Any]]:
    """Stream-parse pino-pretty output line by line.

    Pino formats one "record" as a header line followed by indented continuation
    lines until the next header. A line-oriented pass is O(n) and avoids the
    catastrophic backtracking a DOTALL regex hits on multi-MB logs.
    """
    records: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    continuation: list[str] = []

    def _flush() -> None:
        nonlocal current, continuation
        if current is None:
            return
        body_lines = continuation
        body = "\n".join(body_lines)
        tmatch = re.search(r'"(?:type|name)":\s*"([^"]+)"', body)
        if tmatch:
            current["error_type"] = tmatch.group(1)
        # Pino bundles the API-side message inside a nested `"message": "..."`
        # field. When the header is a generic wrapper like "Failed to rename
        # pool bot (sending anyway)" and the body carries the real cause
        # ("Call to 'setMyName' failed! (429: ...)"), promote the body message
        # so classification can see the actual error shape.
        mmatch = re.search(r'"message":\s*"([^"]+)"', body)
        if mmatch:
            current["message"] = f"{current['message']} — {mmatch.group(1)}"
        current["raw"] = body[:600]
        records.append(current)
        current = None
        continuation = []

    for raw_line in text.splitlines():
        line = ANSI.sub("", raw_line)
        head = PINO_HEAD.match(line)
        if head:
            _flush()
            current = {
                "source": source,
                "level": head.group(1),
                "error_type": None,
                "message": head.group(2).strip(),
            }
            continuation = []
        elif current is not None and not PINO_TIMESTAMP.match(line):
            # Continuation line (indented) — part of the current record's body
            continuation.append(line)
        elif current is not None:
            # Timestamp-prefixed line that wasn't ERROR/WARN — flush current,
            # start no new record.
            _flush()
    _flush()
    return records


def collect_error_log_lines(text: str) -> list[dict[str, Any]]:
    """Group consecutive non-blank lines in nanoclaw.error.log into a single
    "crash" event. Bun prints a multi-line error+stack block before exiting,
    and treating each line as its own record fragments one crash into 6+
    records — noisy for the human report and wrong for the count heuristic.

    A blank line (or the end of file) closes the current block.
    These are launchd-captured stderr, which should be empty under healthy
    operation."""
    records: list[dict[str, Any]] = []
    current: list[str] = []

    def _flush() -> None:
        nonlocal current
        if not current:
            return
        # Use the most "signal-y" line as the event message — prefer the
        # first line that starts with a recognized error prefix, falling
        # back to the first line.
        signal_prefixes = ("SyntaxError", "TypeError", "RangeError",
                           "ReferenceError", "Error:", "error:", "AssertionError")
        headline = next(
            (ln for ln in current if ln.startswith(signal_prefixes)),
            current[0],
        )
        records.append(
            {
                "source": "error_log",
                "message": headline[:400],
                "raw": "\n".join(current)[:1200],
            }
        )
        current = []

    for line in text.splitlines():
        clean = line.strip()
        if not clean:
            _flush()
            continue
        # Whitelist known-benign stderr spam. These are lines written to
        # error_log because of stderr routing, not because they're errors.
        # Extend this list when a new benign pattern shows up — do NOT
        # weaken the default-to-bug rule.
        benign = (
            "[credential-proxy]" in clean and "proxy exposed on all interfaces" in clean,
            # Bun's version banner prints on each startup to stderr
            clean.startswith("Bun v") and "(" in clean and ")" in clean,
        )
        if any(benign):
            continue
        current.append(clean)
    _flush()
    return records


# ---------------------------------------------------------------------------
# Normalization — coalesce identical events into one record with count/span
# ---------------------------------------------------------------------------
def normalize(events: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    """Group raw events by dedup key; build canonical records."""
    buckets: dict[str, dict[str, Any]] = defaultdict(lambda: {"count": 0})
    for ev in events:
        src = ev["source"]
        etype = ev.get("error_type")
        msg = ev.get("message", "")
        key = f"{src}::{_dedup_key(etype, msg)}"
        rec = buckets[key]
        rec["count"] += 1
        rec.setdefault("source", src)
        rec.setdefault("type", etype)
        rec.setdefault("message", msg)
        # We don't have reliable per-event timestamps in pino output; use `now`
        # as a placeholder and widen only when we do have them (task_run_logs).
        ts = ev.get("timestamp") or now.isoformat()
        rec["first_seen"] = min(rec.get("first_seen", ts), ts)
        rec["last_seen"] = max(rec.get("last_seen", ts), ts)

    out = []
    for rec in buckets.values():
        bucket, meta = classify(
            source=rec["source"],
            message=rec["message"],
            error_type=rec.get("type"),
        )
        rec["bucket"] = bucket
        rec["meta"] = meta
        out.append(rec)
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    now = datetime.now(timezone.utc)
    state = load_state()
    offsets = state.get("log_offsets", {})

    main_text, main_offset = tail_since(MAIN_LOG, offsets.get(MAIN_LOG.name, -1))
    error_text, error_offset = tail_since(ERROR_LOG, offsets.get(ERROR_LOG.name, -1))

    events: list[dict[str, Any]] = []
    events.extend(collect_log_lines(main_text, source="main_log"))
    events.extend(collect_error_log_lines(error_text))

    # Task run logs come with real timestamps — inject them as individual
    # events using their `run_at` column so first_seen/last_seen reflect reality.
    for row in collect_task_run_logs(now):
        events.append(
            {
                "source": "task_run_logs",
                "error_type": None,
                "message": (row.get("error") or "")[:400],
                "timestamp": row.get("run_at"),
            }
        )

    records = normalize(events, now)
    actionable = [r for r in records if is_actionable(r)]

    # Only advance offsets on success — if the run crashed we'd want to retry
    # the same window rather than skip over it.
    state["log_offsets"] = {
        MAIN_LOG.name: main_offset,
        ERROR_LOG.name: error_offset,
    }
    state["last_run"] = now.isoformat()
    try:
        save_state(state)
    except OSError as e:
        print(f"warning: could not persist state: {e}", file=sys.stderr)

    summary = {
        "checked_at": now.isoformat(),
        "window_hours": WINDOW_HOURS,
        "total_records": len(records),
        "actionable_count": len(actionable),
        "by_bucket": {
            b: sum(1 for r in records if r["bucket"] == b)
            for b in ("bug", "config", "infra", "transient", "unknown")
        },
        "actionable": sorted(
            actionable,
            key=lambda r: (
                {"bug": 0, "config": 1, "infra": 2, "unknown": 3, "transient": 4}.get(
                    r["bucket"], 5
                ),
                -r.get("count", 0),
            ),
        ),
    }
    print(json.dumps(summary, indent=2, default=str))
    return 2 if actionable else 0


if __name__ == "__main__":
    sys.exit(main())
