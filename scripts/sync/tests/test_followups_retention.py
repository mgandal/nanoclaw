"""Tests for retention: archiving old stale/closed follow-ups out of followups.md.

followups.md is read by Claire for the morning briefing. Without retention the
Stale section grows without bound (it reached 523KB / ~131k tokens before this
was added), so every read pays for years of dead entries. apply_retention moves
cold entries to a sidecar archive; nothing is ever deleted.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path

from email_ingest.followups import append_archive, parse_file, write_file
from email_ingest.aging import apply_retention
from email_ingest.types import FollowUp


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _make(
    created: datetime,
    status: str = "stale",
    closed_at: str | None = None,
    who: str = "X",
) -> FollowUp:
    return FollowUp(
        kind="i-owe", who=who, what="do thing", due="none",
        thread="gmail:z", source_msg="gmail:z",
        created=_iso(created), status=status, closed_at=closed_at,
    )


NOW = datetime(2026, 7, 30, tzinfo=timezone.utc)


# --- what gets archived -----------------------------------------------------

def test_stale_item_older_than_retention_is_archived():
    item = _make(NOW - timedelta(days=61), status="stale")
    kept, archived = apply_retention([item], NOW, retention_days=60)
    assert kept == []
    assert len(archived) == 1


def test_stale_item_inside_retention_is_kept():
    item = _make(NOW - timedelta(days=59), status="stale")
    kept, archived = apply_retention([item], NOW, retention_days=60)
    assert len(kept) == 1
    assert archived == []


def test_boundary_exactly_at_retention_is_kept():
    """Only strictly-older entries archive, matching apply_aging's `>` test."""
    item = _make(NOW - timedelta(days=60), status="stale")
    kept, archived = apply_retention([item], NOW, retention_days=60)
    assert len(kept) == 1
    assert archived == []


# --- what is never archived -------------------------------------------------

def test_open_item_is_never_archived_however_old():
    """apply_aging owns open->stale. An open item is by definition still live."""
    item = _make(NOW - timedelta(days=900), status="open")
    kept, archived = apply_retention([item], NOW, retention_days=60)
    assert len(kept) == 1
    assert archived == []


def test_snoozed_item_is_never_archived():
    item = _make(NOW - timedelta(days=900), status="snoozed")
    kept, archived = apply_retention([item], NOW, retention_days=60)
    assert len(kept) == 1
    assert archived == []


def test_unparseable_timestamp_is_kept():
    """Fail-safe: never archive an entry whose age cannot be established."""
    item = _make(NOW, status="stale")
    item.created = "not-a-date"
    kept, archived = apply_retention([item], NOW, retention_days=60)
    assert len(kept) == 1
    assert archived == []


# --- closed items date from closed_at --------------------------------------

def test_closed_item_uses_closed_at_not_created():
    """Created long ago but closed yesterday -> still inside retention."""
    item = _make(
        NOW - timedelta(days=400),
        status="closed",
        closed_at=_iso(NOW - timedelta(days=1)),
    )
    kept, archived = apply_retention([item], NOW, retention_days=60)
    assert len(kept) == 1
    assert archived == []


def test_closed_item_falls_back_to_created_when_closed_at_missing():
    item = _make(NOW - timedelta(days=400), status="closed", closed_at=None)
    kept, archived = apply_retention([item], NOW, retention_days=60)
    assert kept == []
    assert len(archived) == 1


def test_mixed_batch_partitions_correctly():
    items = [
        _make(NOW - timedelta(days=5), status="open", who="fresh-open"),
        _make(NOW - timedelta(days=20), status="stale", who="warm-stale"),
        _make(NOW - timedelta(days=200), status="stale", who="cold-stale"),
        _make(NOW - timedelta(days=200), status="closed", who="cold-closed"),
    ]
    kept, archived = apply_retention(items, NOW, retention_days=60)
    assert {i.who for i in kept} == {"fresh-open", "warm-stale"}
    assert {i.who for i in archived} == {"cold-stale", "cold-closed"}


# --- archive file -----------------------------------------------------------

def test_append_archive_creates_file_with_header(tmp_path: Path):
    archive = tmp_path / "followups.archive.md"
    append_archive(archive, [_make(NOW - timedelta(days=200))])
    text = archive.read_text(encoding="utf-8")
    assert text.startswith("# Follow-ups — archive")
    assert "do thing" in text


def test_append_archive_preserves_existing_entries(tmp_path: Path):
    archive = tmp_path / "followups.archive.md"
    append_archive(archive, [_make(NOW - timedelta(days=200), who="first")])
    append_archive(archive, [_make(NOW - timedelta(days=201), who="second")])
    text = archive.read_text(encoding="utf-8")
    assert "first" in text
    assert "second" in text
    assert text.count("# Follow-ups — archive") == 1


def test_append_archive_entries_round_trip_through_parser(tmp_path: Path):
    """Archived entries stay machine-readable so nothing is truly lost."""
    archive = tmp_path / "followups.archive.md"
    original = _make(NOW - timedelta(days=200), status="stale", who="Alice")
    append_archive(archive, [original])
    recovered = parse_file(archive)
    assert len(recovered) == 1
    assert recovered[0].who == "Alice"
    assert recovered[0].what == "do thing"


def test_append_archive_noop_on_empty_list(tmp_path: Path):
    archive = tmp_path / "followups.archive.md"
    append_archive(archive, [])
    assert not archive.exists()


def test_retention_then_write_shrinks_main_file(tmp_path: Path):
    """End-to-end: the cold entries leave followups.md and land in the archive."""
    main = tmp_path / "followups.md"
    archive = tmp_path / "followups.archive.md"
    items = [_make(NOW - timedelta(days=5), status="open", who="live")] + [
        _make(NOW - timedelta(days=300), status="stale", who=f"dead{i}")
        for i in range(50)
    ]
    write_file(main, items)
    before = main.stat().st_size

    kept, archived = apply_retention(items, NOW, retention_days=60)
    write_file(main, kept)
    append_archive(archive, archived)

    assert main.stat().st_size < before / 2
    assert len(parse_file(main)) == 1
    assert len(parse_file(archive)) == 50
