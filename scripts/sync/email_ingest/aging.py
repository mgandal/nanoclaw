"""Age-based stale marking for followups."""

import logging
from datetime import datetime, timezone
from typing import Iterable

from email_ingest.types import FollowUp, AGE_THRESHOLD_DAYS

log = logging.getLogger("email-ingest.aging")


def _parse_iso(s: str) -> datetime | None:
    """Parse a subset of ISO 8601 (supports trailing Z). Returns None on failure."""
    if not s:
        return None
    try:
        normalized = s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def apply_aging(
    items: Iterable[FollowUp],
    now: datetime,
    threshold_days: int = AGE_THRESHOLD_DAYS,
) -> tuple[list[FollowUp], int]:
    """Mark open items older than threshold as 'stale'.
    Returns (updated_list, count_aged). Non-open items untouched.
    Items with unparseable 'created' are skipped (logged)."""
    updated: list[FollowUp] = []
    aged = 0
    for it in items:
        if it.status != "open":
            updated.append(it)
            continue
        created = _parse_iso(it.created)
        if created is None:
            log.warning("aging: unparseable created timestamp %r on %s", it.created, it.who)
            updated.append(it)
            continue
        age_days = (now - created).total_seconds() / 86400.0
        if age_days > threshold_days:
            updated.append(
                FollowUp(
                    **{**it.__dict__, "status": "stale"}
                )
            )
            aged += 1
        else:
            updated.append(it)
    return updated, aged
