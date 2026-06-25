"""Tests for hub_id() + mark_done_by_ids() — the Follow-up Hub write-back path.

The mini-app renders each open follow-up with a stable id and POSTs the checked
ids back. The host poller must flip exactly those entries open -> done in
followups.md, matching by the SAME id the page computed. These tests pin that
contract so the page and the matcher can never silently drift apart.
"""
from pathlib import Path

import pytest

from email_ingest.followups import (
    parse_file,
    write_file,
    hub_id,
    mark_done_by_ids,
)
from email_ingest.types import FollowUp


def _fu(created: str, kind: str, who: str, what: str, status: str = "open") -> FollowUp:
    return FollowUp(
        kind=kind,
        who=who,
        what=what,
        due="none",
        thread=f"thread:{created}:{who}",
        source_msg=f"msg:{created}:{who}",
        created=created,
        status=status,
    )


def _write(tmp_path: Path, items: list[FollowUp]) -> Path:
    p = tmp_path / "followups.md"
    write_file(p, items)
    return p


# ---- hub_id: the page/matcher shared identity ----

def test_hub_id_matches_page_formula():
    # The page computes: "f-" + sha1(date + who + what).hexdigest()[:10]
    # where date = heading date, who = raw heading remainder, what = what field.
    import hashlib
    date, who, what = "2026-06-18", "Martina Arenella", "Discuss CV."
    expected = "f-" + hashlib.sha1((date + who + what).encode()).hexdigest()[:10]
    assert hub_id(date, who, what) == expected


def test_hub_id_stable_across_calls():
    a = hub_id("2026-06-01", "Alice <a@x.com>", "Send the draft.")
    b = hub_id("2026-06-01", "Alice <a@x.com>", "Send the draft.")
    assert a == b


# ---- mark_done_by_ids: the actual write-back ----

def test_marks_single_matching_id_done(tmp_path):
    target = _fu("2026-06-18T07:00", "i-owe", "Martina Arenella", "Discuss CV.")
    other = _fu("2026-06-19T08:00", "i-owe", "Someone Else", "Different thing.")
    p = _write(tmp_path, [target, other])

    tid = hub_id("2026-06-18", "Martina Arenella", "Discuss CV.")
    marked = mark_done_by_ids(p, [tid])

    assert marked == [tid]
    items = {hub_id(i.created[:10], i.who, i.what): i for i in parse_file(p)}
    assert items[tid].status == "done"
    other_id = hub_id("2026-06-19", "Someone Else", "Different thing.")
    assert items[other_id].status == "open"


def test_unmatched_ids_reported_not_raised(tmp_path):
    p = _write(tmp_path, [_fu("2026-06-18T07:00", "i-owe", "A", "x.")])
    marked = mark_done_by_ids(p, ["f-deadbeef00"])
    assert marked == []
    # file untouched: the one real entry is still open
    assert parse_file(p)[0].status == "open"


def test_idempotent_already_done(tmp_path):
    p = _write(tmp_path, [_fu("2026-06-18T07:00", "i-owe", "A", "x.", status="done")])
    tid = hub_id("2026-06-18", "A", "x.")
    marked = mark_done_by_ids(p, [tid])
    # Already done -> not re-marked (so caller won't double-report)
    assert marked == []
    assert parse_file(p)[0].status == "done"


def test_multiple_ids_mixed_match(tmp_path):
    a = _fu("2026-06-18T07:00", "i-owe", "A", "alpha.")
    b = _fu("2026-06-18T07:00", "they-owe-me", "B", "bravo.")
    p = _write(tmp_path, [a, b])
    aid = hub_id("2026-06-18", "A", "alpha.")
    bid = hub_id("2026-06-18", "B", "bravo.")
    marked = mark_done_by_ids(p, [aid, "f-nope", bid])
    assert set(marked) == {aid, bid}
    statuses = {hub_id(i.created[:10], i.who, i.what): i.status for i in parse_file(p)}
    assert statuses[aid] == "done"
    assert statuses[bid] == "done"


def test_accepts_str_path(tmp_path):
    # Callers (the publisher script) pass a plain string path — must not blow up.
    p = _write(tmp_path, [_fu("2026-06-18T07:00", "i-owe", "A", "x.")])
    tid = hub_id("2026-06-18", "A", "x.")
    marked = mark_done_by_ids(str(p), [tid])
    assert marked == [tid]
    assert parse_file(p)[0].status == "done"


def test_roundtrip_id_from_real_heading(tmp_path):
    # Guards the date-source subtlety: the page hashes the HEADING date, and the
    # renderer writes the heading date as created[:10]. They must agree even when
    # `created` carries a time component.
    item = _fu("2026-06-22T11:00", "i-owe", "Jingjing Li", "Send slides.")
    p = _write(tmp_path, [item])
    parsed = parse_file(p)[0]
    rid = hub_id(parsed.created[:10], parsed.who, parsed.what)
    marked = mark_done_by_ids(p, [rid])
    assert marked == [rid]
