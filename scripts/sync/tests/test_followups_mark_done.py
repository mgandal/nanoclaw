"""Tests for hub_id() + mark_done_by_ids() — the Follow-up Hub write-back path.

The mini-app renders each open follow-up with a stable id and POSTs the checked
ids back. The host poller must flip exactly those entries to closed in
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
    followups_lock,
)
from email_ingest.types import FollowUp


def _fu(created: str, kind: str, who: str, what: str, status: str = "open") -> FollowUp:
    return FollowUp(
        kind=kind,
        who=who,
        what=what,
        due="none",
        thread=f"thread:{created}:{kind}:{who}",
        source_msg=f"msg:{created}:{kind}:{who}",
        created=created,
        status=status,
    )


def _write(tmp_path: Path, items: list[FollowUp]) -> Path:
    p = tmp_path / "followups.md"
    write_file(p, items)
    return p


def _id(it: FollowUp) -> str:
    return hub_id(it.created[:10], it.who, it.what, it.kind)


def _section_of(text: str, heading_who: str) -> str:
    """Return which ## section ('Open'|'Stale'|'Closed') the entry for
    heading_who falls under, by scanning the rendered file."""
    section = None
    for line in text.splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
        elif line.startswith("### ") and heading_who in line:
            return section
    return None


# ---- hub_id: the page/matcher shared identity ----

def test_hub_id_matches_page_formula():
    # The page computes: "f-" + sha1(date + kind + who + what).hexdigest()[:10]
    import hashlib
    date, kind, who, what = "2026-06-18", "i-owe", "Martina Arenella", "Discuss CV."
    expected = "f-" + hashlib.sha1((date + kind + who + what).encode()).hexdigest()[:10]
    assert hub_id(date, who, what, kind) == expected


def test_hub_id_stable_across_calls():
    a = hub_id("2026-06-01", "Alice <a@x.com>", "Send the draft.", "i-owe")
    b = hub_id("2026-06-01", "Alice <a@x.com>", "Send the draft.", "i-owe")
    assert a == b


def test_hub_id_distinguishes_kind():
    # i-owe vs they-owe-me with identical date/who/what must NOT collide,
    # else checking one closes the other.
    a = hub_id("2026-06-18", "Jane", "Discuss the CV.", "i-owe")
    b = hub_id("2026-06-18", "Jane", "Discuss the CV.", "they-owe-me")
    assert a != b


# ---- mark_done_by_ids: the actual write-back ----

def test_marks_single_matching_id_closed(tmp_path):
    target = _fu("2026-06-18T07:00", "i-owe", "Martina Arenella", "Discuss CV.")
    other = _fu("2026-06-19T08:00", "i-owe", "Someone Else", "Different thing.")
    p = _write(tmp_path, [target, other])

    tid = _id(target)
    marked = mark_done_by_ids(p, [tid])

    assert marked == [tid]
    items = {_id(i): i for i in parse_file(p)}
    assert items[tid].status == "closed"
    assert items[_id(other)].status == "open"


def test_marked_entry_lands_in_closed_section(tmp_path):
    # Regression guard: a marked item must physically move to ## Closed, not
    # linger in ## Open with a status the pipeline can't bucket. (aging.py and
    # closure.py only act on status=='open', so a non-closed "done" would be
    # orphaned in Open forever.)
    target = _fu("2026-06-18T07:00", "i-owe", "Martina Arenella", "Discuss CV.")
    p = _write(tmp_path, [target])
    mark_done_by_ids(p, [_id(target)])

    text = p.read_text(encoding="utf-8")
    assert _section_of(text, "Martina Arenella") == "Closed"
    # and it carries the closure provenance fields
    assert "closed_at:" in text
    assert "closed_reason:" in text


def test_unmatched_ids_reported_not_raised(tmp_path):
    p = _write(tmp_path, [_fu("2026-06-18T07:00", "i-owe", "A", "x.")])
    marked = mark_done_by_ids(p, ["f-deadbeef00"])
    assert marked == []
    assert parse_file(p)[0].status == "open"


def test_idempotent_already_closed(tmp_path):
    p = _write(tmp_path, [_fu("2026-06-18T07:00", "i-owe", "A", "x.", status="closed")])
    tid = _id(_fu("2026-06-18T07:00", "i-owe", "A", "x."))
    marked = mark_done_by_ids(p, [tid])
    # Already closed -> not re-marked (so caller won't double-report)
    assert marked == []
    assert parse_file(p)[0].status == "closed"


def test_multiple_ids_mixed_match(tmp_path):
    a = _fu("2026-06-18T07:00", "i-owe", "A", "alpha.")
    b = _fu("2026-06-18T07:00", "they-owe-me", "B", "bravo.")
    p = _write(tmp_path, [a, b])
    aid, bid = _id(a), _id(b)
    marked = mark_done_by_ids(p, [aid, "f-nope", bid])
    assert set(marked) == {aid, bid}
    statuses = {_id(i): i.status for i in parse_file(p)}
    assert statuses[aid] == "closed"
    assert statuses[bid] == "closed"


def test_cross_kind_same_text_only_closes_the_checked_one(tmp_path):
    # The collision bug: same date+who+what, different kind. Checking the i-owe
    # must leave the they-owe-me open.
    iowe = _fu("2026-06-18T07:00", "i-owe", "Jane", "Discuss the CV.")
    theyowe = _fu("2026-06-18T09:00", "they-owe-me", "Jane", "Discuss the CV.")
    p = _write(tmp_path, [iowe, theyowe])
    marked = mark_done_by_ids(p, [_id(iowe)])
    assert marked == [_id(iowe)]
    statuses = {_id(i): i.status for i in parse_file(p)}
    assert statuses[_id(iowe)] == "closed"
    assert statuses[_id(theyowe)] == "open"


def test_accepts_str_path(tmp_path):
    # Callers (the publisher script) pass a plain string path — must not blow up.
    item = _fu("2026-06-18T07:00", "i-owe", "A", "x.")
    p = _write(tmp_path, [item])
    marked = mark_done_by_ids(str(p), [_id(item)])
    assert marked == [_id(item)]
    assert parse_file(p)[0].status == "closed"


def test_lock_is_sequentially_reacquirable_and_marks_under_lock(tmp_path):
    # The lock must release cleanly so the same process can re-acquire it and so
    # mark_done_by_ids (which takes the lock internally) works while we are NOT
    # holding it. A second acquire after the first releases must not block.
    item = _fu("2026-06-18T07:00", "i-owe", "A", "x.")
    p = _write(tmp_path, [item])
    with followups_lock(p):
        pass
    with followups_lock(p):  # would hang if the first didn't release
        pass
    marked = mark_done_by_ids(p, [_id(item)])  # acquires the lock itself
    assert marked == [_id(item)]
    assert parse_file(p)[0].status == "closed"


def test_concurrent_writer_does_not_clobber_mark(tmp_path):
    # Simulate the email-ingest RMW race: a writer reads the file (snapshot with
    # the entry still open), THEN a hub check-off closes it, THEN the writer
    # writes its stale snapshot back. With both wrapping followups_lock the late
    # write must be serialized AFTER the close and must re-read — here we assert
    # the lock at least serializes: while we hold it, mark_done_by_ids in a
    # thread blocks until we release, so the close is not lost to interleaving.
    import threading
    a = _fu("2026-06-18T07:00", "i-owe", "A", "alpha.")
    p = _write(tmp_path, [a])
    started = threading.Event()
    done = threading.Event()

    def worker():
        started.set()
        mark_done_by_ids(p, [_id(a)])  # blocks on the lock we hold below
        done.set()

    with followups_lock(p):
        t = threading.Thread(target=worker)
        t.start()
        started.wait(2)
        # Worker is blocked on the lock; the close has NOT happened yet.
        assert not done.wait(0.3)
    t.join(3)
    assert done.is_set()
    assert parse_file(p)[0].status == "closed"


def test_roundtrip_id_from_real_heading(tmp_path):
    # Guards the date-source subtlety: the page hashes the HEADING date, and the
    # renderer writes the heading date as created[:10]. They must agree even when
    # `created` carries a time component.
    item = _fu("2026-06-22T11:00", "i-owe", "Jingjing Li", "Send slides.")
    p = _write(tmp_path, [item])
    parsed = parse_file(p)[0]
    rid = hub_id(parsed.created[:10], parsed.who, parsed.what, parsed.kind)
    marked = mark_done_by_ids(p, [rid])
    assert marked == [rid]
