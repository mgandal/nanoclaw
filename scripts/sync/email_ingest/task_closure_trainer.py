"""Weekly trainer: derive per-counterparty trust + per-rule precision.

Reads ~/.cache/email-ingest/task-closures.jsonl, recomputes weights,
writes ~/.cache/email-ingest/task-closure-profile.json. Pure offline:
never touches the live tasks table.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from email_ingest.task_closure import ClosureProfile, save_profile

log = logging.getLogger("email-ingest.task-closure-trainer")

DEFAULT_JSONL = Path.home() / ".cache" / "email-ingest" / "task-closures.jsonl"
DEFAULT_PROFILE = Path.home() / ".cache" / "email-ingest" / "task-closure-profile.json"


def _parse_ts(s: str) -> datetime | None:
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _load_events(path: Path, lookback_days: int, now: datetime) -> list[dict]:
    if not path.exists():
        return []
    cutoff = now - timedelta(days=lookback_days)
    out: list[dict] = []
    for raw in path.read_text().splitlines():
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("trainer: corrupt JSONL line: %r", raw[:120])
            continue
        ts = _parse_ts(obj.get("ts", ""))
        if ts is None or ts < cutoff:
            continue
        out.append(obj)
    return out


def compute_counterparty_trust(events: list[dict]) -> dict[str, float]:
    closed_by_task: dict[int, list[str]] = {}
    reopened_tasks: set[int] = set()
    for ev in events:
        action = ev.get("action", "")
        if action.startswith("dry-"):
            continue
        tid = ev.get("task_id")
        if not isinstance(tid, int):
            continue
        if action == "closed":
            addrs = ev.get("thread_addrs") or []
            if addrs:
                closed_by_task[tid] = [a.lower() for a in addrs]
        elif action == "reopened":
            reopened_tasks.add(tid)

    counts: dict[str, dict[str, int]] = {}
    for tid, addrs in closed_by_task.items():
        for addr in addrs:
            d = counts.setdefault(addr, {"stuck": 0, "total": 0})
            d["total"] += 1
            if tid not in reopened_tasks:
                d["stuck"] += 1
    return {a: round(d["stuck"] / d["total"], 3) for a, d in counts.items() if d["total"] >= 1}


def compute_rule_precision(events: list[dict]) -> dict[str, float]:
    fired: dict[str, int] = {}
    rule_by_task: dict[int, str] = {}
    reopened: set[int] = set()
    for ev in events:
        action = ev.get("action", "")
        if action.startswith("dry-"):
            continue
        tid = ev.get("task_id")
        if not isinstance(tid, int):
            continue
        if action == "closed":
            rule = ev.get("rule", "unknown")
            fired[rule] = fired.get(rule, 0) + 1
            rule_by_task[tid] = rule
        elif action == "reopened":
            reopened.add(tid)
    stuck: dict[str, int] = {}
    for tid, rule in rule_by_task.items():
        if tid not in reopened:
            stuck[rule] = stuck.get(rule, 0) + 1
    return {r: round(stuck.get(r, 0) / n, 3) for r, n in fired.items() if n > 0}


def train(
    jsonl_path: Path,
    out_path: Path,
    lookback_days: int = 30,
    now: datetime | None = None,
) -> None:
    if now is None:
        now = datetime.now(timezone.utc)
    events = _load_events(jsonl_path, lookback_days, now)
    cp_trust = compute_counterparty_trust(events)
    rule_precision = compute_rule_precision(events)
    profile = ClosureProfile.default()
    profile.counterparty_trust = cp_trust
    profile.rule_precision = rule_precision
    save_profile(profile, out_path)
    log.info("trainer: wrote profile (cp=%d, rules=%d, lookback=%d)",
             len(cp_trust), len(rule_precision), lookback_days)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser()
    p.add_argument("--jsonl", default=str(DEFAULT_JSONL))
    p.add_argument("--out", default=str(DEFAULT_PROFILE))
    p.add_argument("--lookback-days", type=int, default=30)
    p.add_argument("--recompute", action="store_true",
                   help="ignored for v1 — recompute is the default mode")
    args = p.parse_args(argv)
    train(Path(args.jsonl), Path(args.out), args.lookback_days)
    return 0


if __name__ == "__main__":
    sys.exit(main())
