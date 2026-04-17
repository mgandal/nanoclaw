"""Tests for age-based stale marking."""
from datetime import datetime, timedelta, timezone

from email_ingest.aging import apply_aging
from email_ingest.types import FollowUp


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _make(created: datetime, status: str = "open") -> FollowUp:
    return FollowUp(
        kind="i-owe", who="X", what="do thing", due="none",
        thread="gmail:z", source_msg="gmail:z",
        created=_iso(created), status=status,
    )


def test_item_13_days_old_stays_open():
    now = datetime(2026, 4, 17, tzinfo=timezone.utc)
    item = _make(now - timedelta(days=13))
    items, aged = apply_aging([item], now, threshold_days=14)
    assert aged == 0
    assert items[0].status == "open"


def test_item_15_days_old_becomes_stale():
    now = datetime(2026, 4, 17, tzinfo=timezone.utc)
    item = _make(now - timedelta(days=15))
    items, aged = apply_aging([item], now, threshold_days=14)
    assert aged == 1
    assert items[0].status == "stale"


def test_already_stale_untouched():
    now = datetime(2026, 4, 17, tzinfo=timezone.utc)
    item = _make(now - timedelta(days=30), status="stale")
    items, aged = apply_aging([item], now, threshold_days=14)
    assert aged == 0
    assert items[0].status == "stale"


def test_closed_untouched():
    now = datetime(2026, 4, 17, tzinfo=timezone.utc)
    item = _make(now - timedelta(days=30), status="closed")
    items, aged = apply_aging([item], now, threshold_days=14)
    assert aged == 0
    assert items[0].status == "closed"


def test_snoozed_untouched():
    now = datetime(2026, 4, 17, tzinfo=timezone.utc)
    item = _make(now - timedelta(days=30), status="snoozed")
    items, aged = apply_aging([item], now, threshold_days=14)
    assert aged == 0
    assert items[0].status == "snoozed"


def test_malformed_created_is_skipped():
    now = datetime(2026, 4, 17, tzinfo=timezone.utc)
    item = FollowUp(
        kind="i-owe", who="X", what="y", due="none",
        thread="gmail:z", source_msg="gmail:z",
        created="not-a-date", status="open",
    )
    items, aged = apply_aging([item], now, threshold_days=14)
    assert aged == 0
    assert items[0].status == "open"


def test_mixed_list():
    now = datetime(2026, 4, 17, tzinfo=timezone.utc)
    items_in = [
        _make(now - timedelta(days=1)),
        _make(now - timedelta(days=20)),
        _make(now - timedelta(days=100), status="closed"),
    ]
    items, aged = apply_aging(items_in, now, threshold_days=14)
    assert aged == 1
    assert [i.status for i in items] == ["open", "stale", "closed"]
