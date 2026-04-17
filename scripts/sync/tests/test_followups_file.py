"""Tests for followups.md parse/write/dedupe."""
from pathlib import Path

import pytest

from email_ingest.followups import (
    parse_file,
    write_file,
    normalize_what,
    jaccard,
    is_duplicate,
    EMPTY_FILE_TEMPLATE,
)
from email_ingest.types import FollowUp


def _sample(tmp_path: Path, content: str) -> Path:
    p = tmp_path / "followups.md"
    p.write_text(content)
    return p


def test_parse_empty_file(tmp_path):
    p = _sample(tmp_path, EMPTY_FILE_TEMPLATE)
    items = parse_file(p)
    assert items == []


def test_parse_missing_file_returns_empty(tmp_path):
    items = parse_file(tmp_path / "does-not-exist.md")
    assert items == []


def test_parse_single_open_item(tmp_path):
    p = _sample(tmp_path, """# Follow-ups

## Open

### 2026-04-15 · i-owe · Sarah Chen
- **what:** Send revised methods section
- **due:** 2026-04-22
- **thread:** gmail:17f3b2a88c1d4e55
- **source_msg:** gmail:17f3b2a88c1d4e55
- **created:** 2026-04-15T14:22:00Z
- **status:** open
""")
    items = parse_file(p)
    assert len(items) == 1
    f = items[0]
    assert f.kind == "i-owe"
    assert f.who == "Sarah Chen"
    assert f.what == "Send revised methods section"
    assert f.due == "2026-04-22"
    assert f.thread == "gmail:17f3b2a88c1d4e55"
    assert f.status == "open"


def test_parse_closed_section(tmp_path):
    p = _sample(tmp_path, """# Follow-ups

## Open

## Closed

### 2026-04-10 · i-owe · Marco Rossi
- **what:** Share preprocessing script
- **due:** none
- **thread:** gmail:17edcb
- **source_msg:** gmail:17edcb
- **created:** 2026-04-10T09:00:00Z
- **status:** closed
- **closed_reason:** replied-in-thread
- **closed_at:** 2026-04-14T10:15:00Z
""")
    items = parse_file(p)
    assert len(items) == 1
    assert items[0].status == "closed"
    assert items[0].closed_reason == "replied-in-thread"


def test_roundtrip_preserves_fields(tmp_path):
    original = FollowUp(
        kind="they-owe-me",
        who="po@nih.gov",
        what="Confirm supplement includes equipment",
        due="none",
        thread="exchange:AAMkAD",
        source_msg="exchange:AAMkAD",
        created="2026-04-16T09:40:00Z",
        status="open",
    )
    p = tmp_path / "followups.md"
    write_file(p, [original])
    parsed = parse_file(p)
    assert len(parsed) == 1
    assert parsed[0] == original


def test_normalize_what_strips_stopwords():
    assert normalize_what("Send the revised methods section for the paper") == {
        "send", "revised", "methods", "section", "paper",
    }


def test_normalize_what_empty():
    assert normalize_what("") == set()


def test_jaccard_identical():
    assert jaccard({"a", "b", "c"}, {"a", "b", "c"}) == 1.0


def test_jaccard_disjoint():
    assert jaccard({"a"}, {"b"}) == 0.0


def test_jaccard_empty_sets():
    assert jaccard(set(), set()) == 0.0


def test_jaccard_partial_overlap():
    result = jaccard({"a", "b", "c", "d"}, {"a", "b", "e", "f"})
    assert abs(result - (2 / 6)) < 1e-9


def test_is_duplicate_same_thread_similar_what():
    existing = FollowUp(
        kind="i-owe", who="Sarah", what="Send revised methods section",
        due="none", thread="gmail:x",
        source_msg="gmail:msg1", created="2026-04-15T00:00:00Z",
    )
    new = FollowUp(
        kind="i-owe", who="Sarah", what="Send the methods section revised",
        due="none", thread="gmail:x",
        source_msg="gmail:msg2", created="2026-04-15T10:00:00Z",
    )
    assert is_duplicate(new, existing) is True


def test_is_duplicate_different_thread_rejected():
    existing = FollowUp(
        kind="i-owe", who="Sarah", what="Send methods",
        due="none", thread="gmail:x",
        source_msg="gmail:msg1", created="2026-04-15T00:00:00Z",
    )
    new = FollowUp(
        kind="i-owe", who="Sarah", what="Send methods",
        due="none", thread="gmail:y",
        source_msg="gmail:msg2", created="2026-04-15T10:00:00Z",
    )
    assert is_duplicate(new, existing) is False


def test_is_duplicate_different_kind_rejected():
    existing = FollowUp(
        kind="i-owe", who="Sarah", what="Send methods",
        due="none", thread="gmail:x",
        source_msg="gmail:msg1", created="2026-04-15T00:00:00Z",
    )
    new = FollowUp(
        kind="they-owe-me", who="Sarah", what="Send methods",
        due="none", thread="gmail:x",
        source_msg="gmail:msg2", created="2026-04-15T10:00:00Z",
    )
    assert is_duplicate(new, existing) is False


def test_is_duplicate_closed_existing_does_not_match():
    existing = FollowUp(
        kind="i-owe", who="Sarah", what="Send methods",
        due="none", thread="gmail:x",
        source_msg="gmail:msg1", created="2026-04-15T00:00:00Z",
        status="closed",
    )
    new = FollowUp(
        kind="i-owe", who="Sarah", what="Send methods",
        due="none", thread="gmail:x",
        source_msg="gmail:msg2", created="2026-04-16T00:00:00Z",
    )
    assert is_duplicate(new, existing) is False


def test_atomic_write(tmp_path):
    p = tmp_path / "followups.md"
    p.write_text("# Follow-ups\n\n## Open\n\n(original)\n")

    f = FollowUp(
        kind="i-owe", who="X", what="Y", due="none",
        thread="gmail:z", source_msg="gmail:z",
        created="2026-04-17T00:00:00Z",
    )
    write_file(p, [f])
    assert "i-owe · X" in p.read_text()
    assert not (tmp_path / "followups.md.tmp").exists()


def test_parse_preserves_stale_section(tmp_path):
    p = _sample(tmp_path, """# Follow-ups

## Open

## Stale

### 2026-03-20 · they-owe-me · c@stanford.edu
- **what:** Send figure 3
- **due:** none
- **thread:** gmail:aaa
- **source_msg:** gmail:aaa
- **created:** 2026-03-20T00:00:00Z
- **status:** stale
""")
    items = parse_file(p)
    assert len(items) == 1
    assert items[0].status == "stale"


def test_parse_corrupt_entry_preserves_others(tmp_path):
    p = _sample(tmp_path, """# Follow-ups

## Open

### 2026-04-15 · i-owe · A
- **what:** first
- **due:** none
- **thread:** gmail:1
- **source_msg:** gmail:1
- **created:** 2026-04-15T00:00:00Z
- **status:** open

### MALFORMED HEADER NO DELIMITERS
- this is broken

### 2026-04-16 · i-owe · B
- **what:** third
- **due:** none
- **thread:** gmail:3
- **source_msg:** gmail:3
- **created:** 2026-04-16T00:00:00Z
- **status:** open
""")
    items = parse_file(p)
    assert len(items) == 2
    assert items[0].who == "A"
    assert items[1].who == "B"
