"""Killswitch on persistent no-improvement.

Per spec I5: if last 3 consecutive runs produced no PR OR cumulative
cost > $100 with zero merges, hard-fail at startup.
"""
from __future__ import annotations
import json
from pathlib import Path


CONSECUTIVE_NO_PR_THRESHOLD = 3
CUMULATIVE_COST_USD = 100.0


class EscalationStop(RuntimeError):
    pass


def check_history(history_path: Path) -> None:
    if not history_path.exists():
        return
    entries = []
    for line in history_path.read_text().splitlines():
        if not line.strip():
            continue
        entries.append(json.loads(line))
    if not entries:
        return

    if not any(e.get("merged") for e in entries):
        total = sum(e.get("cost_usd", 0) for e in entries)
        if total > CUMULATIVE_COST_USD:
            raise EscalationStop(
                f"STOP: ${total:.0f} spent with zero merges. Review rubric or disable."
            )

    consecutive = 0
    for e in reversed(entries):
        if e.get("merged") or e.get("pr_url"):
            break
        consecutive += 1

    if consecutive >= CONSECUTIVE_NO_PR_THRESHOLD:
        raise EscalationStop(
            f"STOP: optimizer not delivering. {consecutive} consecutive runs produced no PR. "
            f"Review rubric or disable."
        )
