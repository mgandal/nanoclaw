"""Auto-closure of open follow-ups based on thread activity."""

import logging
import re
from datetime import datetime, timezone
from typing import Iterable, Optional

from email_ingest.types import FollowUp, NormalizedEmail

log = logging.getLogger("email-ingest.closure")

_USER_SENT_LABELS = {"SENT"}


def _parse_iso(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _addr(raw: str) -> str:
    """Extract lowercased email address from a 'Name <addr@x>' or 'addr@x' string."""
    if not raw:
        return ""
    m = re.search(r"<([^>]+)>", raw)
    addr = m.group(1) if m else raw
    return addr.strip().lower()


def _is_user_sent(msg: NormalizedEmail) -> bool:
    if msg.source == "gmail":
        return any(lbl in _USER_SENT_LABELS for lbl in msg.labels)
    return bool(msg.metadata.get("is_sent", False))


def _source_and_id(thread: str) -> tuple[str, str]:
    if ":" in thread:
        src, tid = thread.split(":", 1)
        return src, tid
    return "", thread


def _counterparty(item: FollowUp, gmail_adapter, exchange_adapter) -> str:
    """Return lowercased email address of the original asker for they-owe-me items."""
    src, msg_id = _source_and_id(item.source_msg)
    if src == "gmail" and hasattr(gmail_adapter, "fetch_message"):
        msg = gmail_adapter.fetch_message(msg_id)
    elif src == "exchange" and hasattr(exchange_adapter, "fetch_message"):
        msg = exchange_adapter.fetch_message(msg_id)
    else:
        msg = None
    if msg is None:
        return ""
    return _addr(msg.from_addr)


def apply_closure(
    items: Iterable[FollowUp],
    gmail_adapter,
    exchange_adapter,
    now: Optional[datetime] = None,
) -> tuple[list[FollowUp], int]:
    """Close open items whose threads show closure-worthy activity since 'created'.
    Returns (updated_list, closed_count)."""
    if now is None:
        now = datetime.now(timezone.utc)
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    updated: list[FollowUp] = []
    closed = 0
    for it in items:
        if it.status != "open":
            updated.append(it)
            continue

        created_dt = _parse_iso(it.created)
        if created_dt is None:
            log.warning("closure: unparseable created timestamp %r", it.created)
            updated.append(it)
            continue
        since_epoch = int(created_dt.timestamp())

        src, thread_id = _source_and_id(it.thread)
        if src == "gmail":
            thread_msgs = gmail_adapter.fetch_thread_messages(thread_id, since_epoch)
        elif src == "exchange":
            thread_msgs = exchange_adapter.fetch_thread_messages(thread_id, since_epoch)
        else:
            thread_msgs = []

        should_close = False
        reason = ""

        if it.kind == "i-owe":
            for m in thread_msgs:
                if _is_user_sent(m):
                    should_close = True
                    reason = "replied-in-thread"
                    break
        elif it.kind == "they-owe-me":
            cp = _counterparty(it, gmail_adapter, exchange_adapter)
            _, source_msg_id = _source_and_id(it.source_msg)
            if cp:
                for m in thread_msgs:
                    if m.id == source_msg_id:
                        continue  # skip the original message itself
                    if _addr(m.from_addr) == cp:
                        should_close = True
                        reason = "counterparty-replied"
                        break

        if should_close:
            closed += 1
            updated.append(
                FollowUp(
                    **{
                        **it.__dict__,
                        "status": "closed",
                        "closed_reason": reason,
                        "closed_at": now_iso,
                    }
                )
            )
        else:
            updated.append(it)

    return updated, closed
