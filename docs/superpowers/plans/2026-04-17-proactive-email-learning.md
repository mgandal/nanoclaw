# Proactive Email Learning Implementation Plan

> **Status: SHIPPED 2026-04-17 → 2026-04-25.** All code-layer tasks (1–7) shipped across 6 commits: `79b4cb90` (followups parser/writer/dedupe), `960d87d8` (hyphenated-key fix), `3f0e9db8` (phi4-mini extractor), `9dd4b6c4` (markdown fence stripping fix), `94215596` (aging pass), `28ed2e61` (thread-activity auto-closure). Task 8 seed file lives at `groups/global/state/followups.md` (302 entries populated since 2026-04-17, ~133 KB / 2427 lines, proving 8 days of daily ingest activity). Task 9 launchd flag confirmed in `~/Library/LaunchAgents/com.nanoclaw.sync.plist` (`EMAIL_FOLLOWUPS_ENABLED=1`). Task 10 Claire morning-briefing prompt in `store/messages.db` includes the Follow-ups step (6 matches for "follow-up/followups" in stored prompt). Task 11 verification: 60/60 tests pass (`tests/test_followups_types.py`, `test_followups_file.py`, `test_extractor.py`, `test_closure.py`, `test_aging.py`, `test_thread_fetch.py`). `email-ingest.py:167-169` wires `run_followups_passes()`. Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract commitments (i-owe), asks (they-owe-me), and significant decisions from Mike's sent + critical received email, store follow-ups in `groups/global/state/followups.md` with auto-closure + aging, retain decisions to Hindsight, and surface follow-ups in Claire's morning briefing.

**Architecture:** Extend existing `scripts/sync/email-ingest.py` with four new passes (closure, aging, extraction, write-out) running locally via Ollama `phi4-mini`. New Python submodules in `scripts/sync/email_ingest/`: `followups.py`, `extractor.py`, `closure.py`, `aging.py`. Morning-briefing prompt (stored in SQLite) gets a bounded step that reads `followups.md` and renders a terse two-bucket section. Spec: `docs/superpowers/specs/2026-04-17-proactive-email-learning-design.md`.

**Tech Stack:** Python 3.11+, Ollama `phi4-mini` (local), `requests`, existing `email_ingest` package, existing test runner (pytest via `python3 -m pytest`).

---

## File Structure

**Create:**
- `scripts/sync/email_ingest/followups.py` — parse/serialize `followups.md`, dedupe, normalize
- `scripts/sync/email_ingest/extractor.py` — `phi4-mini` extraction + JSON parsing
- `scripts/sync/email_ingest/closure.py` — close open entries based on thread activity
- `scripts/sync/email_ingest/aging.py` — mark open > 14d as stale
- `scripts/sync/tests/test_followups_file.py`
- `scripts/sync/tests/test_extractor.py`
- `scripts/sync/tests/test_closure.py`
- `scripts/sync/tests/test_aging.py`
- `groups/global/state/followups.md` — initial empty template

**Modify:**
- `scripts/sync/email_ingest/types.py` — add constants (`FOLLOWUPS_FILE`, `AGE_THRESHOLD_DAYS`, `JACCARD_THRESHOLD`)
- `scripts/sync/email_ingest/gmail_adapter.py` — add `fetch_thread_messages(thread_id, since_epoch)`
- `scripts/sync/email_ingest/exchange_adapter.py` — add `fetch_thread_messages(conversation_id, since_epoch)`
- `scripts/sync/email-ingest.py` — wire new passes, add stats keys, env-flag gate
- Claire morning briefing prompt (SQLite update, final task)

---

## Ground Rules for Every Task

- Work in `/Users/mgandal/Agents/nanoclaw`.
- Run tests via: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_<name>.py -v`.
- After each task's final step: `git add <exact files> && git commit -m "<msg>"`.
- Do not enable the feature in `email-ingest.py` main loop until Task 9 (everything gated behind `EMAIL_FOLLOWUPS_ENABLED=1`).
- Never hit live Ollama, Gmail, or Hindsight in tests — mock at boundaries.

---

## Task 1: Add Shared Constants and Types

**Files:**
- Modify: `scripts/sync/email_ingest/types.py`
- Test: `scripts/sync/tests/test_followups_types.py` (new)

- [ ] **Step 1: Write the failing test**

Create `scripts/sync/tests/test_followups_types.py`:

```python
"""Tests for follow-up-related type constants."""
from pathlib import Path

from email_ingest.types import (
    FOLLOWUPS_FILE,
    AGE_THRESHOLD_DAYS,
    JACCARD_THRESHOLD,
    FollowUp,
)


def test_followups_file_points_to_global_state():
    assert FOLLOWUPS_FILE.name == "followups.md"
    assert "groups/global/state" in str(FOLLOWUPS_FILE)


def test_age_threshold_is_14_days():
    assert AGE_THRESHOLD_DAYS == 14


def test_jaccard_threshold_is_point_six():
    assert JACCARD_THRESHOLD == 0.6


def test_followup_dataclass_defaults():
    f = FollowUp(
        kind="i-owe",
        who="Sarah Chen",
        what="Send revised methods",
        due="none",
        thread="gmail:abc123",
        source_msg="gmail:abc123",
        created="2026-04-15T14:22:00Z",
    )
    assert f.status == "open"
    assert f.closed_reason is None
    assert f.closed_at is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_followups_types.py -v`
Expected: FAIL with `ImportError: cannot import name 'FOLLOWUPS_FILE'`

- [ ] **Step 3: Add constants and dataclass to types.py**

Append to `scripts/sync/email_ingest/types.py` (after existing code, before any closing line):

```python
# --- Follow-ups ---

FOLLOWUPS_FILE = (
    Path(__file__).resolve().parents[3]
    / "groups"
    / "global"
    / "state"
    / "followups.md"
)
AGE_THRESHOLD_DAYS = 14
JACCARD_THRESHOLD = 0.6


@dataclass
class FollowUp:
    kind: str  # "i-owe" | "they-owe-me"
    who: str
    what: str
    due: str  # ISO date or "none"
    thread: str  # "gmail:<id>" | "exchange:<id>"
    source_msg: str  # "gmail:<id>" | "exchange:<id>"
    created: str  # ISO timestamp
    status: str = "open"  # "open" | "stale" | "closed" | "snoozed"
    closed_reason: Optional[str] = None  # "replied-in-thread" | "counterparty-replied" | "manual" | "aged-out-manual"
    closed_at: Optional[str] = None  # ISO timestamp
    extra: dict = field(default_factory=dict)  # preserve unknown fields from manual edits
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_followups_types.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add scripts/sync/email_ingest/types.py scripts/sync/tests/test_followups_types.py
git commit -m "feat(email-ingest): add FollowUp dataclass + constants"
```

---

## Task 2: Implement `followups.py` — Parse, Write, Dedupe

**Files:**
- Create: `scripts/sync/email_ingest/followups.py`
- Test: `scripts/sync/tests/test_followups_file.py`

- [ ] **Step 1: Write the failing tests**

Create `scripts/sync/tests/test_followups_file.py`:

```python
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
    # closed entries do not dedupe — a fresh commitment in the same thread
    # after closure is a new item.
    assert is_duplicate(new, existing) is False


def test_atomic_write(tmp_path, monkeypatch):
    """Write goes through .tmp + rename, never truncates target on failure."""
    p = tmp_path / "followups.md"
    p.write_text("# Follow-ups\n\n## Open\n\n(original)\n")

    f = FollowUp(
        kind="i-owe", who="X", what="Y", due="none",
        thread="gmail:z", source_msg="gmail:z",
        created="2026-04-17T00:00:00Z",
    )
    write_file(p, [f])
    # Target updated
    assert "i-owe · X" in p.read_text()
    # No stray .tmp
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
    """A malformed entry between valid ones does not drop the valid ones."""
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
    # Valid entries preserved; malformed skipped with log warning
    assert len(items) == 2
    assert items[0].who == "A"
    assert items[1].who == "B"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_followups_file.py -v`
Expected: FAIL with `ImportError: cannot import name 'parse_file'`

- [ ] **Step 3: Implement `followups.py`**

Create `scripts/sync/email_ingest/followups.py`:

```python
"""Parse, serialize, and dedupe the followups.md file."""

import logging
import os
import re
from pathlib import Path

from email_ingest.types import FollowUp, JACCARD_THRESHOLD

log = logging.getLogger("email-ingest.followups")

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
_FIELD_RE = re.compile(r"^-\s+\*\*(\w+):\*\*\s+(.*)$")
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
    # Replace punctuation with spaces
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
    # Split on H3 headings while tracking section
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
            # Collect fields until next H3 or H2
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
                # If status missing, infer from section
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
    by_section = {"open": [], "stale": [], "closed": []}
    for it in items:
        bucket = it.status if it.status in by_section else "open"
        if it.status == "snoozed":
            bucket = "open"  # snoozed still shown under Open (filtered by briefing)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_followups_file.py -v`
Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add scripts/sync/email_ingest/followups.py scripts/sync/tests/test_followups_file.py
git commit -m "feat(email-ingest): followups.md parser, writer, dedupe"
```

---

## Task 3: Implement `extractor.py` — `phi4-mini` Extraction

**Files:**
- Create: `scripts/sync/email_ingest/extractor.py`
- Test: `scripts/sync/tests/test_extractor.py`

- [ ] **Step 1: Write the failing tests**

Create `scripts/sync/tests/test_extractor.py`:

```python
"""Tests for phi4-mini extraction."""
import json
from unittest.mock import patch, MagicMock

import pytest

from email_ingest.extractor import (
    extract,
    ExtractionResult,
    _parse_response,
    build_prompt,
)
from email_ingest.types import NormalizedEmail


def _email(source="gmail", from_addr="mike@upenn.edu", subject="Re: methods",
           body="Thanks. I'll send the revised methods by Friday."):
    return NormalizedEmail(
        id="msg1", source=source, from_addr=from_addr,
        to=["sarah@gmail.com"], cc=[], subject=subject,
        date="2026-04-15T14:22:00Z", body=body,
        labels=[], metadata={"threadId": "abc"},
    )


def test_parse_valid_i_owe():
    raw = json.dumps({
        "kind": "i-owe", "who": "Sarah Chen",
        "what": "Send revised methods section",
        "due": "2026-04-22", "significant": False,
        "decision_summary": "",
    })
    r = _parse_response(raw)
    assert r is not None
    assert r.kind == "i-owe"
    assert r.who == "Sarah Chen"
    assert r.due == "2026-04-22"
    assert r.significant is False


def test_parse_they_owe_me():
    raw = json.dumps({
        "kind": "they-owe-me", "who": "po@nih.gov",
        "what": "Confirm budget line", "due": "none",
        "significant": False, "decision_summary": "",
    })
    r = _parse_response(raw)
    assert r.kind == "they-owe-me"
    assert r.due == "none"


def test_parse_none_kind_returns_result_not_none():
    raw = json.dumps({
        "kind": "none", "who": "", "what": "", "due": "none",
        "significant": False, "decision_summary": "",
    })
    r = _parse_response(raw)
    # Still returns a result — caller filters on kind.
    assert r is not None
    assert r.kind == "none"


def test_parse_markdown_fenced_response():
    raw = "```json\n" + json.dumps({
        "kind": "i-owe", "who": "X", "what": "Y", "due": "none",
        "significant": False, "decision_summary": "",
    }) + "\n```"
    r = _parse_response(raw)
    assert r is not None
    assert r.kind == "i-owe"


def test_parse_malformed_returns_none():
    assert _parse_response("not json") is None
    assert _parse_response("{incomplete") is None
    assert _parse_response("") is None


def test_parse_missing_required_field_returns_none():
    # No 'kind' — invalid schema
    raw = json.dumps({"who": "X"})
    assert _parse_response(raw) is None


def test_parse_significant_decision():
    raw = json.dumps({
        "kind": "none", "who": "Program Officer", "what": "",
        "due": "none", "significant": True,
        "decision_summary": "Decided to decline the renewal",
    })
    r = _parse_response(raw)
    assert r.significant is True
    assert r.decision_summary == "Decided to decline the renewal"


def test_build_prompt_includes_direction():
    email = _email()
    prompt = build_prompt(email, direction="sent")
    assert "Direction: sent" in prompt
    assert "Subject: Re: methods" in prompt
    assert email.body in prompt


def test_build_prompt_truncates_long_body():
    email = _email(body="x" * 5000)
    prompt = build_prompt(email, direction="received")
    assert len(prompt) < 3500  # headers + 2000-char body cap + preamble


@patch("email_ingest.extractor.requests.post")
def test_extract_makes_ollama_request(mock_post):
    mock_post.return_value = MagicMock(
        status_code=200,
        raise_for_status=MagicMock(),
        json=lambda: {"response": json.dumps({
            "kind": "i-owe", "who": "Sarah",
            "what": "Send methods", "due": "none",
            "significant": False, "decision_summary": "",
        })},
    )
    email = _email()
    result = extract(email, direction="sent")
    assert result is not None
    assert result.kind == "i-owe"
    mock_post.assert_called_once()
    args, kwargs = mock_post.call_args
    assert kwargs["json"]["model"] == "phi4-mini"


@patch("email_ingest.extractor.requests.post")
def test_extract_network_error_returns_none(mock_post):
    import requests
    mock_post.side_effect = requests.RequestException("down")
    email = _email()
    assert extract(email, direction="sent") is None


@patch("email_ingest.extractor.requests.post")
def test_extract_empty_body_returns_none_without_ollama(mock_post):
    email = _email(body="")
    assert extract(email, direction="sent") is None
    mock_post.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_extractor.py -v`
Expected: FAIL with `ImportError`

- [ ] **Step 3: Implement `extractor.py`**

Create `scripts/sync/email_ingest/extractor.py`:

```python
"""phi4-mini extraction of commitments, asks, and significant decisions."""

import json
import logging
from dataclasses import dataclass
from typing import Optional

import requests

from email_ingest.types import NormalizedEmail

log = logging.getLogger("email-ingest.extractor")

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "phi4-mini"
OLLAMA_TIMEOUT = 30

BODY_CAP = 2000  # chars of body included in prompt

_SYSTEM_PROMPT = """You are analyzing a single email for commitment, ask, and decision signals.
Output valid JSON only — no prose, no markdown.

Schema:
{
  "kind": "i-owe" | "they-owe-me" | "none",
  "who": "<counterparty name or email>",
  "what": "<one-line action, <= 120 chars, imperative mood>",
  "due": "YYYY-MM-DD" | "none",
  "significant": true | false,
  "decision_summary": "<one-line summary of a decision the user made, or empty>"
}

Rules:
- kind = "i-owe" only if the user (sender, if direction=sent) made a clear commitment to send/do/deliver something.
- kind = "they-owe-me" only if the email contains a clear ask directed at the user that awaits their reply.
- kind = "none" if routine (FYI, thanks, scheduling chitchat, newsletter, confirmation).
- significant = true only if the email reflects a meaningful decision by the user about: funding, scope, hiring/firing, methodology, collaboration, or a public position. Routine scheduling, acknowledgments, FYI replies → false.
- decision_summary empty unless significant = true.
- due must be explicit in the email; otherwise "none".
"""


@dataclass
class ExtractionResult:
    kind: str  # "i-owe" | "they-owe-me" | "none"
    who: str
    what: str
    due: str  # ISO date or "none"
    significant: bool
    decision_summary: str


def build_prompt(email: NormalizedEmail, direction: str) -> str:
    body = email.body[:BODY_CAP] if email.body else ""
    return "\n".join([
        f"Direction: {direction}",
        f"From: {email.from_addr}",
        f"To: {', '.join(email.to)}",
        f"Date: {email.date}",
        f"Subject: {email.subject}",
        "Body:",
        body,
    ])


def _parse_response(raw: str) -> Optional[ExtractionResult]:
    cleaned = (raw or "").strip()
    if not cleaned:
        return None
    if cleaned.startswith("```"):
        cleaned = "\n".join(cleaned.split("\n")[1:])
    if cleaned.endswith("```"):
        cleaned = "\n".join(cleaned.split("\n")[:-1])
    cleaned = cleaned.strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        log.warning("extractor: malformed JSON: %s", raw[:200])
        return None
    try:
        return ExtractionResult(
            kind=str(data["kind"]),
            who=str(data.get("who", "")),
            what=str(data.get("what", "")),
            due=str(data.get("due", "none")),
            significant=bool(data.get("significant", False)),
            decision_summary=str(data.get("decision_summary", "")),
        )
    except (KeyError, TypeError, ValueError) as e:
        log.warning("extractor: schema mismatch: %s (raw: %s)", e, raw[:200])
        return None


def extract(email: NormalizedEmail, direction: str) -> Optional[ExtractionResult]:
    """Run phi4-mini extraction. Returns None on any failure."""
    if not email.body:
        return None
    prompt = build_prompt(email, direction)
    try:
        resp = requests.post(
            OLLAMA_URL,
            json={
                "model": OLLAMA_MODEL,
                "system": _SYSTEM_PROMPT,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.1, "num_predict": 256},
            },
            timeout=OLLAMA_TIMEOUT,
        )
        resp.raise_for_status()
        raw = resp.json().get("response", "")
    except requests.RequestException as e:
        log.warning("extractor: Ollama request failed: %s", e)
        return None
    return _parse_response(raw)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_extractor.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add scripts/sync/email_ingest/extractor.py scripts/sync/tests/test_extractor.py
git commit -m "feat(email-ingest): phi4-mini extraction of commitments/asks/decisions"
```

---

## Task 4: Implement `aging.py`

**Files:**
- Create: `scripts/sync/email_ingest/aging.py`
- Test: `scripts/sync/tests/test_aging.py`

- [ ] **Step 1: Write the failing tests**

Create `scripts/sync/tests/test_aging.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_aging.py -v`
Expected: FAIL with `ImportError`

- [ ] **Step 3: Implement `aging.py`**

Create `scripts/sync/email_ingest/aging.py`:

```python
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
        # Python's fromisoformat handles "+00:00" but not "Z" before 3.11.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_aging.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add scripts/sync/email_ingest/aging.py scripts/sync/tests/test_aging.py
git commit -m "feat(email-ingest): aging pass marks 14d+ open items as stale"
```

---

## Task 5: Extend Adapters with `fetch_thread_messages`

**Files:**
- Modify: `scripts/sync/email_ingest/gmail_adapter.py`
- Modify: `scripts/sync/email_ingest/exchange_adapter.py`
- Test: `scripts/sync/tests/test_thread_fetch.py` (new)

- [ ] **Step 1: Read current adapter shapes**

Skim `exchange_adapter.py` to mirror the conversation-id model used there. Both adapters already return `NormalizedEmail` with `metadata["threadId"]` (Gmail) and an equivalent for Exchange — confirm the exact key before writing the new method.

- [ ] **Step 2: Write the failing tests**

Create `scripts/sync/tests/test_thread_fetch.py`:

```python
"""Tests for fetch_thread_messages on both adapters."""
from unittest.mock import MagicMock, patch

from email_ingest.gmail_adapter import GmailAdapter
from email_ingest.exchange_adapter import ExchangeAdapter


def test_gmail_fetch_thread_filters_by_epoch():
    adapter = GmailAdapter()
    fake_service = MagicMock()
    adapter._service = fake_service

    fake_service.users.return_value.threads.return_value.get.return_value.execute.return_value = {
        "messages": [
            {
                "id": "m1", "threadId": "t1",
                "internalDate": "1700000000000",  # older than epoch
                "payload": {"headers": [
                    {"name": "From", "value": "a@x.com"},
                    {"name": "To", "value": "me@me.com"},
                    {"name": "Subject", "value": "s"},
                    {"name": "Date", "value": "2023-11-14"},
                ]},
                "labelIds": [],
            },
            {
                "id": "m2", "threadId": "t1",
                "internalDate": "1900000000000",  # newer than epoch
                "payload": {"headers": [
                    {"name": "From", "value": "b@x.com"},
                    {"name": "To", "value": "me@me.com"},
                    {"name": "Subject", "value": "s"},
                    {"name": "Date", "value": "2030-03-14"},
                ]},
                "labelIds": ["SENT"],
            },
        ]
    }

    results = adapter.fetch_thread_messages("t1", since_epoch=1_800_000_000)
    assert len(results) == 1
    assert results[0].id == "m2"
    assert "SENT" in results[0].labels


def test_gmail_fetch_thread_empty_when_not_connected():
    adapter = GmailAdapter()
    adapter._service = None
    assert adapter.fetch_thread_messages("t1", since_epoch=0) == []


def test_gmail_fetch_thread_api_error_returns_empty():
    adapter = GmailAdapter()
    fake_service = MagicMock()
    fake_service.users.return_value.threads.return_value.get.return_value.execute.side_effect = Exception("boom")
    adapter._service = fake_service
    assert adapter.fetch_thread_messages("t1", since_epoch=0) == []


@patch("email_ingest.exchange_adapter.subprocess.run")
def test_exchange_fetch_thread_returns_empty_on_failure(mock_run):
    mock_run.side_effect = Exception("bridge down")
    adapter = ExchangeAdapter()
    assert adapter.fetch_thread_messages("conv-123", since_epoch=0) == []
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_thread_fetch.py -v`
Expected: FAIL with `AttributeError: 'GmailAdapter' object has no attribute 'fetch_thread_messages'`

- [ ] **Step 4: Add `fetch_thread_messages` to `GmailAdapter`**

Append to `scripts/sync/email_ingest/gmail_adapter.py` inside the `GmailAdapter` class (after `fetch_since`):

```python
    def fetch_thread_messages(
        self, thread_id: str, since_epoch: int
    ) -> list[NormalizedEmail]:
        """Fetch messages in a Gmail thread with internalDate > since_epoch (ms-resolution).
        Read-only. Returns [] on any failure."""
        if not self._service:
            return []
        try:
            resp = (
                self._service.users()
                .threads()
                .get(userId="me", id=thread_id, format="full")
                .execute()
            )
        except Exception as e:
            log.warning("Gmail thread fetch failed for %s: %s", thread_id, e)
            return []

        since_ms = since_epoch * 1000
        out: list[NormalizedEmail] = []
        for raw in resp.get("messages", []):
            try:
                internal = int(raw.get("internalDate", "0"))
            except (TypeError, ValueError):
                internal = 0
            if internal <= since_ms:
                continue
            try:
                out.append(normalize_gmail_message(raw))
            except Exception as e:
                log.warning("Gmail thread normalize failed: %s", e)
        return out
```

- [ ] **Step 5: Add `fetch_thread_messages` to `ExchangeAdapter`**

Open `scripts/sync/email_ingest/exchange_adapter.py` and append inside the `ExchangeAdapter` class:

```python
    def fetch_thread_messages(
        self, conversation_id: str, since_epoch: int
    ) -> list[NormalizedEmail]:
        """Fetch Exchange messages in a conversation after since_epoch.
        Best-effort: returns [] if the bridge is unavailable or fails."""
        if not self.is_available():
            return []
        try:
            return self._fetch_conversation(conversation_id, since_epoch)
        except Exception as e:  # broad — bridge failures shouldn't crash ingest
            log.warning(
                "Exchange thread fetch failed for %s: %s", conversation_id, e
            )
            return []

    def _fetch_conversation(
        self, conversation_id: str, since_epoch: int
    ) -> list[NormalizedEmail]:
        """Bridge-backed conversation fetch. Best-effort — if the mail-bridge
        endpoint is not present, logs a single debug line and returns []."""
        # The mail bridge currently exposes /mail/recent; a conversation-scoped
        # endpoint is not yet available in v1. Return empty so closure simply
        # leaves entries open until the bridge supports it.
        log.debug(
            "Exchange conversation fetch not yet implemented in bridge; returning []"
        )
        return []
```

(The Exchange bridge does not expose a per-conversation endpoint today; returning `[]` makes closure a no-op for Exchange until that lands. This matches the spec's "best-effort" closure policy and the risk table.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_thread_fetch.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add scripts/sync/email_ingest/gmail_adapter.py scripts/sync/email_ingest/exchange_adapter.py scripts/sync/tests/test_thread_fetch.py
git commit -m "feat(email-ingest): fetch_thread_messages on gmail + exchange adapters"
```

---

## Task 6: Implement `closure.py`

**Files:**
- Create: `scripts/sync/email_ingest/closure.py`
- Test: `scripts/sync/tests/test_closure.py`

- [ ] **Step 1: Write the failing tests**

Create `scripts/sync/tests/test_closure.py`:

```python
"""Tests for auto-closure based on thread activity."""
from datetime import datetime, timezone
from unittest.mock import MagicMock

from email_ingest.closure import apply_closure
from email_ingest.types import FollowUp, NormalizedEmail


def _email(id_, from_addr, labels=None):
    return NormalizedEmail(
        id=id_, source="gmail", from_addr=from_addr,
        to=["sarah@gmail.com"], cc=[], subject="re",
        date="2026-04-18T12:00:00Z", body="", labels=labels or [],
        metadata={"threadId": "abc"},
    )


def test_i_owe_closed_when_user_sends_later():
    item = FollowUp(
        kind="i-owe", who="Sarah", what="send methods", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    gmail = MagicMock()
    gmail.fetch_thread_messages.return_value = [
        _email("m2", "mike@upenn.edu", labels=["SENT"])
    ]
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 1
    assert updated[0].status == "closed"
    assert updated[0].closed_reason == "replied-in-thread"
    assert updated[0].closed_at is not None


def test_they_owe_me_closed_when_counterparty_replies():
    item = FollowUp(
        kind="they-owe-me", who="po@nih.gov",
        what="confirm budget", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    # source msg From = po@nih.gov (counterparty)
    source_email = _email("orig", "po@nih.gov")
    gmail = MagicMock()
    # First call: get source_msg headers to identify counterparty.
    # Second call: fetch thread messages.
    gmail.fetch_thread_messages.return_value = [source_email, _email("m2", "po@nih.gov")]
    gmail.fetch_message.return_value = source_email
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 1
    assert updated[0].status == "closed"
    assert updated[0].closed_reason == "counterparty-replied"


def test_they_owe_me_third_party_does_not_close():
    item = FollowUp(
        kind="they-owe-me", who="po@nih.gov",
        what="confirm budget", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    source_email = _email("orig", "po@nih.gov")
    gmail = MagicMock()
    # Only a third-party reply, not from po@nih.gov
    gmail.fetch_thread_messages.return_value = [source_email, _email("m2", "other@nih.gov")]
    gmail.fetch_message.return_value = source_email
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 0
    assert updated[0].status == "open"


def test_non_open_entries_untouched():
    item = FollowUp(
        kind="i-owe", who="X", what="y", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="closed",
    )
    gmail = MagicMock()
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 0
    assert updated[0].status == "closed"
    gmail.fetch_thread_messages.assert_not_called()


def test_thread_without_activity_stays_open():
    item = FollowUp(
        kind="i-owe", who="X", what="y", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    gmail = MagicMock()
    gmail.fetch_thread_messages.return_value = []
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 0
    assert updated[0].status == "open"


def test_exchange_thread_routed_to_exchange_adapter():
    item = FollowUp(
        kind="i-owe", who="X", what="y", due="none",
        thread="exchange:conv-1", source_msg="exchange:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    gmail = MagicMock()
    exchange = MagicMock()
    exchange.fetch_thread_messages.return_value = []

    apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))
    gmail.fetch_thread_messages.assert_not_called()
    exchange.fetch_thread_messages.assert_called_once()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_closure.py -v`
Expected: FAIL with `ImportError`

- [ ] **Step 3: Add `fetch_message` to `GmailAdapter` (used for counterparty lookup)**

Open `scripts/sync/email_ingest/gmail_adapter.py`. Append inside `GmailAdapter` after `fetch_thread_messages`:

```python
    def fetch_message(self, msg_id: str) -> NormalizedEmail | None:
        """Fetch a single message by id. Returns None on failure."""
        if not self._service:
            return None
        try:
            raw = (
                self._service.users()
                .messages()
                .get(userId="me", id=msg_id, format="full")
                .execute()
            )
            return normalize_gmail_message(raw)
        except Exception as e:
            log.warning("Gmail message fetch failed for %s: %s", msg_id, e)
            return None
```

- [ ] **Step 4: Implement `closure.py`**

Create `scripts/sync/email_ingest/closure.py`:

```python
"""Auto-closure of open follow-ups based on thread activity."""

import logging
import re
from datetime import datetime, timezone
from typing import Iterable, Optional

from email_ingest.types import FollowUp, NormalizedEmail

log = logging.getLogger("email-ingest.closure")


_USER_SENT_LABELS = {"SENT"}  # Gmail label id for sent mail


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
    # Exchange: mailbox metadata indicates sent; conservatively use metadata flag if present.
    return bool(msg.metadata.get("is_sent", False))


def _source_and_id(thread: str) -> tuple[str, str]:
    if ":" in thread:
        src, tid = thread.split(":", 1)
        return src, tid
    return "", thread


def _counterparty(item: FollowUp, gmail_adapter, exchange_adapter) -> str:
    """Return lowercased email address of the original asker for they-owe-me items."""
    src, msg_id = _source_and_id(item.source_msg)
    if src == "gmail":
        msg = gmail_adapter.fetch_message(msg_id) if hasattr(gmail_adapter, "fetch_message") else None
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
            # Any later message by user (SENT label on gmail) closes
            for m in thread_msgs:
                if _is_user_sent(m):
                    should_close = True
                    reason = "replied-in-thread"
                    break
        elif it.kind == "they-owe-me":
            cp = _counterparty(it, gmail_adapter, exchange_adapter)
            if cp:
                for m in thread_msgs:
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_closure.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add scripts/sync/email_ingest/closure.py scripts/sync/email_ingest/gmail_adapter.py scripts/sync/tests/test_closure.py
git commit -m "feat(email-ingest): auto-closure of open followups via thread activity"
```

---

## Task 7: Wire Extraction into `email-ingest.py` (Behind Env Flag)

**Files:**
- Modify: `scripts/sync/email-ingest.py`
- Test: `scripts/sync/tests/test_ingest_integration.py` (new)

- [ ] **Step 1: Write the failing integration test**

Create `scripts/sync/tests/test_ingest_integration.py`:

```python
"""Integration tests for the wired extraction/closure/aging passes."""
import os
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

from email_ingest.types import FollowUp


@patch.dict(os.environ, {"EMAIL_FOLLOWUPS_ENABLED": "1"})
@patch("email_ingest.followups.write_file")
@patch("email_ingest.followups.parse_file")
@patch("email_ingest.extractor.extract")
def test_flag_on_runs_followups_pipeline(
    mock_extract, mock_parse, mock_write
):
    """With the flag on, the wired pipeline parses, extracts, and writes."""
    from importlib import reload
    import email_ingest_module_under_test as m  # aliased in conftest below

    mock_parse.return_value = []
    # Extraction for each email returns None (kind=none or network error) — simplest case
    mock_extract.return_value = None

    # Drive the pipeline via the exposed helper (added in the implementation step).
    m.run_followups_passes(
        gmail_adapter=MagicMock(),
        exchange_adapter=MagicMock(),
        new_emails=[],
        now=datetime(2026, 4, 17, tzinfo=timezone.utc),
    )
    mock_parse.assert_called_once()
    mock_write.assert_called_once()


@patch.dict(os.environ, {}, clear=True)
@patch("email_ingest.followups.parse_file")
def test_flag_off_skips_pipeline(mock_parse):
    import email_ingest_module_under_test as m
    m.run_followups_passes(
        gmail_adapter=MagicMock(),
        exchange_adapter=MagicMock(),
        new_emails=[],
        now=datetime(2026, 4, 17, tzinfo=timezone.utc),
    )
    mock_parse.assert_not_called()
```

Add `scripts/sync/tests/conftest.py` (or extend if it exists):

```python
"""Shared test fixtures."""
import sys
from pathlib import Path

# Ensure the script dir is on sys.path so tests can import the top-level ingest module.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Alias the top-level email-ingest.py (hyphenated filename) under a python-legal name
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "email_ingest_module_under_test",
    Path(__file__).resolve().parents[1] / "email-ingest.py",
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["email_ingest_module_under_test"] = _mod
_spec.loader.exec_module(_mod)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_ingest_integration.py -v`
Expected: FAIL with `AttributeError: module ... has no attribute 'run_followups_passes'`

- [ ] **Step 3: Add `run_followups_passes` to `email-ingest.py`**

Open `scripts/sync/email-ingest.py`. Add new imports near the top (keep existing imports intact):

```python
import os
from datetime import datetime, timezone

from email_ingest.types import (
    FollowUp, FOLLOWUPS_FILE, NormalizedEmail,
)
from email_ingest.followups import parse_file, write_file, is_duplicate
from email_ingest.extractor import extract, ExtractionResult
from email_ingest.closure import apply_closure
from email_ingest.aging import apply_aging
```

Append this function (before `def main()`):

```python
FOLLOWUP_GMAIL_SENDER = "mgandal@gmail.com"


def _direction_for(email: NormalizedEmail) -> str | None:
    """Return 'sent' | 'received' | None (skip)."""
    if email.source == "gmail":
        from_addr = email.from_addr.lower()
        if FOLLOWUP_GMAIL_SENDER in from_addr:
            return "sent"
        return "received"
    if email.source == "exchange":
        if email.metadata.get("is_sent") or email.metadata.get("mailbox") == "Sent Items":
            return "sent"
        return "received"
    return None


def _email_qualifies_for_extraction(
    email: NormalizedEmail, relevance: float
) -> str | None:
    """Return direction to extract with, or None to skip."""
    direction = _direction_for(email)
    if direction is None:
        return None
    # Skip mikejg1838 per spec
    if email.source == "gmail" and "mikejg1838" in email.from_addr.lower():
        return None
    if direction == "sent":
        return "sent"
    # received: require relevance >= 0.7
    if relevance >= 0.7:
        return "received"
    return None


def _ext_to_followup(
    email: NormalizedEmail, r: ExtractionResult
) -> FollowUp | None:
    if r.kind not in ("i-owe", "they-owe-me"):
        return None
    thread_src = email.source
    thread_id = email.metadata.get("threadId") or email.metadata.get("conversationId") or email.id
    return FollowUp(
        kind=r.kind,
        who=r.who or email.from_addr,
        what=r.what,
        due=r.due or "none",
        thread=f"{thread_src}:{thread_id}",
        source_msg=f"{thread_src}:{email.id}",
        created=email.date,
        status="open",
    )


def run_followups_passes(
    gmail_adapter,
    exchange_adapter,
    new_emails: list[tuple[NormalizedEmail, float]] | None = None,
    now: datetime | None = None,
) -> dict:
    """Run closure → aging → extraction → write in sequence.
    No-op unless EMAIL_FOLLOWUPS_ENABLED=1.
    new_emails is a list of (email, relevance) produced by the main ingest loop."""
    if os.environ.get("EMAIL_FOLLOWUPS_ENABLED") != "1":
        return {"skipped": True}

    if now is None:
        now = datetime.now(timezone.utc)
    new_emails = new_emails or []

    items = parse_file(FOLLOWUPS_FILE)

    items, closed_count = apply_closure(items, gmail_adapter, exchange_adapter, now=now)
    items, aged_count = apply_aging(items, now=now)

    commitments_added = 0
    asks_added = 0
    decisions_retained = 0

    for email, relevance in new_emails:
        direction = _email_qualifies_for_extraction(email, relevance)
        if direction is None:
            continue
        result = extract(email, direction)
        if result is None:
            continue
        # Significant decision → Hindsight (non-blocking)
        if result.significant and direction == "sent":
            decisions_retained += _retain_decision(email, result)
        fu = _ext_to_followup(email, result)
        if fu is None:
            continue
        if any(is_duplicate(fu, existing) for existing in items):
            continue
        items.append(fu)
        if fu.kind == "i-owe":
            commitments_added += 1
        else:
            asks_added += 1

    write_file(FOLLOWUPS_FILE, items)

    return {
        "followups_closed": closed_count,
        "followups_aged": aged_count,
        "commitments_added": commitments_added,
        "asks_added": asks_added,
        "decisions_retained": decisions_retained,
    }


def _retain_decision(email: NormalizedEmail, r: ExtractionResult) -> int:
    """Retain a decision to Hindsight. Fire-and-forget; returns 1 on send attempted."""
    import requests
    hindsight_url = os.environ.get("HINDSIGHT_URL", "http://localhost:8889")
    date_slug = email.date[:10] if email.date else "unknown-date"
    who_slug = (r.who or "unknown").replace(" ", "-").lower()[:40]
    doc_id = f"decision-{date_slug}-{who_slug}"
    content = (
        f"Decision: {r.decision_summary}\n\n"
        f"Subject: {email.subject}\n"
        f"Thread: {email.source}:{email.metadata.get('threadId', email.id)}\n"
        f"Excerpt: {email.body[:500]}"
    )
    try:
        requests.post(
            f"{hindsight_url}/retain",
            json={
                "bank": "hermes",
                "content": content,
                "metadata": {
                    "source": "email-ingest-decision",
                    "document_id": doc_id,
                    "message_id": email.id,
                    "kind": "decision",
                },
            },
            timeout=10,
        )
        return 1
    except Exception as e:
        log.debug("Decision retain failed (non-blocking): %s", e)
        return 0
```

Finally, wire `run_followups_passes` into `run_ingest`. Inside `run_ingest`, collect `(email, result.relevance)` pairs as each email is classified, then after the Exchange loop, call:

```python
    # --- Follow-ups pipeline (gated by EMAIL_FOLLOWUPS_ENABLED=1) ---
    try:
        fu_stats = run_followups_passes(gmail, exchange, new_emails=all_classified)
        if not fu_stats.get("skipped"):
            for k, v in fu_stats.items():
                stats[k] = v
            log.info(
                "followups: closed=%d aged=%d commitments=%d asks=%d decisions=%d",
                fu_stats.get("followups_closed", 0),
                fu_stats.get("followups_aged", 0),
                fu_stats.get("commitments_added", 0),
                fu_stats.get("asks_added", 0),
                fu_stats.get("decisions_retained", 0),
            )
    except Exception as e:
        log.warning("Follow-ups pipeline failed (non-fatal): %s", e)
```

Collect `all_classified`: declare `all_classified: list[tuple[NormalizedEmail, float]] = []` at the top of `run_ingest`, and inside each per-email loop (both Gmail and Exchange), after `result = classify_email(email)` and the `skip_reason` guard, append `all_classified.append((email, result.relevance))`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/test_ingest_integration.py -v`
Expected: PASS

Also re-run the full suite to ensure nothing regressed:

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -m pytest tests/ -v`
Expected: all green

- [ ] **Step 5: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add scripts/sync/email-ingest.py scripts/sync/tests/test_ingest_integration.py scripts/sync/tests/conftest.py
git commit -m "feat(email-ingest): wire followups pipeline behind EMAIL_FOLLOWUPS_ENABLED"
```

---

## Task 8: Create Initial `followups.md` Template

**Files:**
- Create: `groups/global/state/followups.md`

- [ ] **Step 1: Create the empty template**

Create `groups/global/state/followups.md`:

```markdown
# Follow-ups

_Managed by email-ingest.py. Claire reads this for the morning briefing. Manual edits OK — aging/closure runs on next ingest._

## Open

## Stale

_Items open > 14 days. Not surfaced in briefing. Review and close/snooze periodically._

## Closed
```

- [ ] **Step 2: Verify parser accepts it**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && python3 -c "from email_ingest.followups import parse_file; from email_ingest.types import FOLLOWUPS_FILE; print(parse_file(FOLLOWUPS_FILE))"`
Expected: `[]`

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add groups/global/state/followups.md
git commit -m "feat(state): seed empty followups.md template"
```

---

## Task 9: Enable Flag in Launchd + First Observe-Mode Run

**Files:**
- Modify: `~/Library/LaunchAgents/com.nanoclaw.sync.plist` (user instructs the change; do not edit directly without checking)

- [ ] **Step 1: Inspect current launchd plist**

Run: `cat ~/Library/LaunchAgents/com.nanoclaw.sync.plist`
Expected: existing sync plist with `EnvironmentVariables` dict (or similar).

- [ ] **Step 2: Add the env flag to the plist**

Edit the plist's `EnvironmentVariables` dict to include:

```xml
<key>EMAIL_FOLLOWUPS_ENABLED</key>
<string>1</string>
```

If no `EnvironmentVariables` key exists, add one adjacent to `ProgramArguments`. Preserve all existing env vars.

- [ ] **Step 3: Reload the launchd service**

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.sync.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.sync.plist
```

- [ ] **Step 4: Run one manual cycle in observe mode**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
EMAIL_FOLLOWUPS_ENABLED=1 python3 email-ingest.py 2>&1 | tail -30
```

Expected: log lines including `followups: closed=... aged=... commitments=... asks=... decisions=...`. No exceptions.

- [ ] **Step 5: Inspect `followups.md`**

Run: `cat /Users/mgandal/Agents/nanoclaw/groups/global/state/followups.md | head -60`
Expected: populated `## Open` section with any commitments/asks extracted from recent mail. Review for prompt tuning.

- [ ] **Step 6: Commit the plist change (plist lives outside repo; no commit here)**

Skip — the launchd plist is not tracked.

---

## Task 10: Update Claire Morning Briefing Prompt

**Files:**
- Modify: `scheduled_tasks` row `claire-morning-briefing` in `store/messages.db`

- [ ] **Step 1: Capture current prompt**

Run:
```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT prompt FROM scheduled_tasks WHERE id='claire-morning-briefing';" > /tmp/claire-briefing-before.txt
wc -l /tmp/claire-briefing-before.txt
```
Expected: nonzero line count. Back this up before editing.

- [ ] **Step 2: Prepare the new prompt**

Write the updated prompt to `/tmp/claire-briefing-new.txt`. The addition is a new STEP that reads `followups.md`; keep every other step verbatim.

Open `/tmp/claire-briefing-before.txt` and find the existing step list. Insert the following as a new step directly after the data-gathering step (before the rendering step):

```
STEP N — Follow-ups:
Read /workspace/project/groups/global/state/followups.md.
Parse the "## Open" section only. Filter entries where:
  - status == open
  - created is within the last 14 days
Sort by created descending.

Render this section in the briefing IFF at least one open item exists:

📋 *Follow-ups*

*You owe*:
• <what> — <who>, <created_date>[, due <due>][ [new]]
  (show up to 5; if more: append "(+N more in followups.md)")

*Awaiting you*:
• <what> — <who>, <created_date>[, due <due>][ [new]]
  (show up to 5; if more: append "(+N more in followups.md)")

[new] tag = created within the last 24h.

If both buckets are empty, omit the entire section.
```

Renumber subsequent steps. Save the full updated prompt to `/tmp/claire-briefing-new.txt`.

- [ ] **Step 3: Apply via SQLite**

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db <<SQL
UPDATE scheduled_tasks
SET prompt = readfile('/tmp/claire-briefing-new.txt')
WHERE id = 'claire-morning-briefing';
SQL
```

Note: `readfile()` stores BLOB — verify with a read-back. If the stored prompt shows `[object Object]` or binary garbage at read time, re-apply via parameter binding:

```bash
python3 - <<'PY'
import sqlite3
prompt = open("/tmp/claire-briefing-new.txt").read()
conn = sqlite3.connect("/Users/mgandal/Agents/nanoclaw/store/messages.db")
conn.execute("UPDATE scheduled_tasks SET prompt = ? WHERE id = 'claire-morning-briefing'", (prompt,))
conn.commit()
conn.close()
PY
```

- [ ] **Step 4: Verify the stored prompt**

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT substr(prompt, 1, 200) FROM scheduled_tasks WHERE id='claire-morning-briefing';"
```
Expected: text starting with "You are Claire..." — not `[object Object]`.

- [ ] **Step 5: Verify the new step is present**

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT prompt FROM scheduled_tasks WHERE id='claire-morning-briefing';" | grep -c "Follow-ups"
```
Expected: `>= 2` (mentions in the step plus the section header).

- [ ] **Step 6: Test-fire the briefing manually**

Trigger Claire's morning briefing out-of-band (next-day run will be the real test). Example:

```bash
cd /Users/mgandal/Agents/nanoclaw
bun run scripts/run-task.ts claire-morning-briefing 2>&1 | tail -20
```

If no such script exists, simply wait for the next 7:30 ET weekday run and review the posted briefing.

- [ ] **Step 7: Commit nothing — prompt is in the DB**

The DB is not in git. Record the update in a short note by appending to `docs/superpowers/specs/2026-04-17-proactive-email-learning-design.md` under a new `## Rollout Log` section:

```markdown
## Rollout Log

- 2026-04-17: Added Follow-ups step to `claire-morning-briefing` prompt via SQLite update. Backup at `/tmp/claire-briefing-before.txt`.
```

Then:

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/specs/2026-04-17-proactive-email-learning-design.md
git commit -m "chore: log morning-briefing prompt update for followups rollout"
```

---

## Task 11: Verification — Run Full Test Suite, Review Output

**Files:**
- None (verification only)

- [ ] **Step 1: Run all email-ingest tests**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
python3 -m pytest tests/ -v
```
Expected: all tests pass (no regressions in existing tests either).

- [ ] **Step 2: Run a clean ingest cycle and observe output**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
EMAIL_FOLLOWUPS_ENABLED=1 python3 email-ingest.py 2>&1 | tee /tmp/ingest-run.log | tail -50
```

Check `/tmp/ingest-run.log` for:
- No Python exceptions
- `followups:` line present in the summary
- `followups.md` updated (check mtime: `ls -l /Users/mgandal/Agents/nanoclaw/groups/global/state/followups.md`)

- [ ] **Step 3: Manually review `followups.md`**

```bash
cat /Users/mgandal/Agents/nanoclaw/groups/global/state/followups.md | head -80
```

Confirm extracted items make sense. If extraction is too noisy or too sparse, tune the prompt in `extractor.py` (`_SYSTEM_PROMPT`) and re-run. Any tuning changes get their own TDD cycle (add a test case for the new prompt behavior).

- [ ] **Step 4: Wait for the next morning briefing**

Next weekday 7:30 ET, verify the briefing includes (or correctly omits) the Follow-ups section. Screenshot or copy the briefing text; if the section renders incorrectly, the fix is in the prompt text stored in the DB (Task 10, Step 3) — not in code.

- [ ] **Step 5: Done — close the plan**

No commit. The plan is complete when:
- All tests pass
- `followups.md` is being written on each ingest cycle
- The morning briefing renders the Follow-ups section when there are open items
- Decisions are appearing in Hindsight (`mcp__hindsight__recall` query for `document_id` prefix `decision-`)

---

## Self-Review Notes

- **Spec coverage:** all 10 Decisions in the spec map to tasks:
  - Three outputs → extraction + followups + decisions (Tasks 3, 7)
  - Sent scope Gmail main + Exchange → `_email_qualifies_for_extraction` in Task 7 (excludes `mikejg1838`)
  - Relevance ≥ 0.7 received bar → same function
  - `followups.md` + Hindsight decisions → Task 8 (template) + Task 7 (`_retain_decision`)
  - Hybrid pipeline → Task 7 wires everything into `email-ingest.py`
  - Auto-closure conservative → Task 6
  - Aging 14d → Task 4
  - Significance bar → Task 3 (prompt) + Task 7 (branch)
  - Decisions on-demand only → no briefing step for decisions (Task 10)
  - Terse two-bucket briefing → Task 10
- **Placeholder scan:** each code step shows concrete code. No "TBD", no "add error handling" without the handler body.
- **Type consistency:** `FollowUp` dataclass fields match across Tasks 1, 2, 4, 6, 7. `ExtractionResult` fields match across Tasks 3, 7.
- **Exchange closure caveat:** noted that the bridge currently has no conversation endpoint; closure is a Gmail-only operation in v1 by design. This is in the spec's risk table.
- **Hindsight retain is fire-and-forget**, mirroring the existing `retain_in_hindsight` pattern (no breaking change).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-17-proactive-email-learning.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
