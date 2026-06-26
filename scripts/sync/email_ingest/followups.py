"""Parse, serialize, and dedupe the followups.md file."""

from __future__ import annotations  # PEP 604 (X | Y) annotations under Python 3.9

import contextlib
import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from email_ingest.types import FollowUp, JACCARD_THRESHOLD

log = logging.getLogger("email-ingest.followups")

try:
    import fcntl  # POSIX only (macOS host + Linux container both have it)
    _HAVE_FCNTL = True
except ImportError:  # pragma: no cover - non-POSIX
    _HAVE_FCNTL = False


@contextlib.contextmanager
def followups_lock(path: Path | str):
    """Hold an exclusive advisory lock for the whole read-modify-write of
    followups.md. Two independent writers touch this file — the 4-hourly
    email-ingest pipeline (read -> classify for ~tens of seconds -> write) and
    the Follow-up Hub poller (mark_done_by_ids). Without a shared lock, whichever
    writes last clobbers the other (a hub check-off vanishes, or an ingest
    update is lost). Both wrap their RMW in this lock.

    The lock is a sidecar `<path>.lock` file (flock), so it never interferes
    with the atomic os.replace of the data file itself. No-op on non-POSIX.
    """
    if not _HAVE_FCNTL:
        yield
        return
    lock_path = str(path) + ".lock"
    os.makedirs(os.path.dirname(lock_path) or ".", exist_ok=True)
    f = open(lock_path, "w")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        finally:
            f.close()

EMPTY_FILE_TEMPLATE = """# Follow-ups

_Managed by email-ingest.py. Claire reads this for the morning briefing. Manual edits OK — aging/closure runs on next ingest._

## Open

## Stale

## Closed
"""

STOPWORDS = {
    "the", "a", "an", "to", "for", "on", "in", "of",
    "and", "or", "with", "by", "from", "at",
}

_HEADING_RE = re.compile(
    r"^###\s+(\d{4}-\d{2}-\d{2})\s+·\s+(i-owe|they-owe-me)\s+·\s+(.+)$"
)
_FIELD_RE = re.compile(r"^-\s+\*\*([\w-]+):\*\*\s+(.*)$")
_SECTION_RE = re.compile(r"^##\s+(Open|Stale|Closed)\s*$")

_KNOWN_FIELDS = {
    "what", "due", "thread", "source_msg", "created",
    "status", "closed_reason", "closed_at",
}


def normalize_what(s: str) -> set[str]:
    """Lowercase, strip punctuation, remove stopwords, take first 8 tokens."""
    if not s:
        return set()
    lowered = s.lower()
    cleaned = re.sub(r"[^\w\s]", " ", lowered)
    tokens = [t for t in cleaned.split() if t and t not in STOPWORDS]
    return set(tokens[:8])


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 0.0
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)


def is_duplicate(new: FollowUp, existing: FollowUp) -> bool:
    """Whether `new` should dedupe into `existing` (skip the write)."""
    if existing.status != "open":
        return False
    if new.kind != existing.kind:
        return False
    if new.thread != existing.thread:
        return False
    sim = jaccard(normalize_what(new.what), normalize_what(existing.what))
    return sim >= JACCARD_THRESHOLD


def parse_file(path: Path) -> list[FollowUp]:
    """Parse followups.md. Returns empty list if file missing.
    Malformed entries are logged and skipped; valid entries preserved."""
    if not path.exists():
        return []

    text = path.read_text(encoding="utf-8")
    items: list[FollowUp] = []
    current_section: str | None = None
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        sec_match = _SECTION_RE.match(line)
        if sec_match:
            current_section = sec_match.group(1).lower()
            i += 1
            continue

        head = _HEADING_RE.match(line)
        if head:
            created_date, kind, who = head.group(1), head.group(2), head.group(3).strip()
            fields: dict[str, str] = {}
            extra: dict[str, str] = {}
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if nxt.startswith("### ") or nxt.startswith("## "):
                    break
                fm = _FIELD_RE.match(nxt)
                if fm:
                    key, val = fm.group(1), fm.group(2).strip()
                    if key in _KNOWN_FIELDS:
                        fields[key] = val
                    else:
                        extra[key] = val
                j += 1

            try:
                status = fields.get("status", "open")
                if "status" not in fields and current_section:
                    status = {"open": "open", "stale": "stale", "closed": "closed"}.get(
                        current_section, "open"
                    )
                item = FollowUp(
                    kind=kind,
                    who=who,
                    what=fields.get("what", ""),
                    due=fields.get("due", "none"),
                    thread=fields["thread"],
                    source_msg=fields["source_msg"],
                    created=fields["created"],
                    status=status,
                    closed_reason=fields.get("closed_reason"),
                    closed_at=fields.get("closed_at"),
                    extra=extra,
                )
                items.append(item)
            except KeyError as e:
                log.warning("Skipping malformed followup entry near line %d: missing %s", i + 1, e)
            i = j
            continue

        i += 1

    return items


def hub_id(date: str, who: str, what: str, kind: str) -> str:
    """Stable id for a follow-up as the mini-app sees it.

    MUST match the page's formula exactly:
        "f-" + sha1(date + kind + who + what).hexdigest()[:10]
    where `date` is the heading date (created[:10]), `kind` is i-owe/they-owe-me,
    `who` is the raw heading remainder (incl. any "<email>"), and `what` is the
    what field. This is the single source of truth for that id — the page
    generator and the write-back matcher both go through it so they can never
    drift. `kind` is part of the hash because the same date+who+what can legally
    appear under both kinds (one i-owe, one they-owe-me on a single thread); a
    kind-blind id would collide and close the wrong obligation.
    """
    return "f-" + hashlib.sha1((date + kind + who + what).encode()).hexdigest()[:10]


def mark_done_by_ids(path: Path, ids: list[str], closed_at: str | None = None) -> list[str]:
    """Close open follow-ups whose hub_id is in `ids`.

    Sets status='closed' (the status the rest of the pipeline understands, so
    write_file buckets them into ## Closed and aging/closure skip them) with
    closed_reason + closed_at provenance. `closed_at` defaults to now (UTC ISO).

    Returns the ids actually closed (were open). Ids that match nothing, or an
    entry already non-open, are omitted so the caller reports only real changes.
    The file is rewritten only when at least one entry changed.
    """
    wanted = set(ids)
    if not wanted:
        return []
    if closed_at is None:
        closed_at = datetime.now(timezone.utc).isoformat()
    path = Path(path)
    # Hold the lock across parse->write so a concurrent email-ingest RMW can't
    # clobber these closes (and vice-versa).
    with followups_lock(path):
        items = parse_file(path)
        marked: list[str] = []
        changed = False
        for it in items:
            iid = hub_id(it.created[:10], it.who, it.what, it.kind)
            if iid in wanted and it.status == "open":
                it.status = "closed"
                it.closed_reason = "user-marked-done"
                it.closed_at = closed_at
                marked.append(iid)
                changed = True
        if changed:
            write_file(path, items)
    return marked


def _render_entry(f: FollowUp) -> list[str]:
    created_date = f.created[:10] if len(f.created) >= 10 else f.created
    lines = [
        f"### {created_date} · {f.kind} · {f.who}",
        f"- **what:** {f.what}",
        f"- **due:** {f.due}",
        f"- **thread:** {f.thread}",
        f"- **source_msg:** {f.source_msg}",
        f"- **created:** {f.created}",
        f"- **status:** {f.status}",
    ]
    if f.closed_reason:
        lines.append(f"- **closed_reason:** {f.closed_reason}")
    if f.closed_at:
        lines.append(f"- **closed_at:** {f.closed_at}")
    for k, v in f.extra.items():
        lines.append(f"- **{k}:** {v}")
    lines.append("")
    return lines


def write_file(path: Path, items: list[FollowUp]) -> None:
    """Atomically write followups.md from a list of items.
    Entries are grouped by status into Open/Stale/Closed sections."""
    by_section: dict[str, list[FollowUp]] = {"open": [], "stale": [], "closed": []}
    for it in items:
        bucket = it.status if it.status in by_section else "open"
        if it.status == "snoozed":
            bucket = "open"
        by_section[bucket].append(it)

    out = [
        "# Follow-ups",
        "",
        "_Managed by email-ingest.py. Claire reads this for the morning briefing. Manual edits OK — aging/closure runs on next ingest._",
        "",
        "## Open",
        "",
    ]
    for it in by_section["open"]:
        out.extend(_render_entry(it))

    out.append("## Stale")
    out.append("")
    out.append("_Items open > 14 days. Not surfaced in briefing. Review and close/snooze periodically._")
    out.append("")
    for it in by_section["stale"]:
        out.extend(_render_entry(it))

    out.append("## Closed")
    out.append("")
    for it in by_section["closed"]:
        out.extend(_render_entry(it))

    content = "\n".join(out).rstrip() + "\n"

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)
