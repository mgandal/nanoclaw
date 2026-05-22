# Penn Email Attachment Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-shot script that repairs ~192 already-migrated Penn `.partial.emlx` messages whose attachments were dropped from `mikejg1838@gmail.com` before the reinflate fix shipped.

**Architecture:** A standalone `scripts/sync/backfill-attachments.py` that imports reusable functions from `email-migrate.py`, classifies each candidate message into one of 8 buckets, and (under `--execute`) repairs `WOULD_REPAIR` messages via an import → verify → trash sequence. Default mode is a dry-run report. No own state file — Gmail message state is the source of truth, queried fresh each run.

**Tech Stack:** Python 3.11, `google-api-python-client` (Gmail API), pytest. Reuses `parse_emlx`, `extract_message_id`, `folder_to_label`, `discover_folders`, `GmailApiUploader`, `load_gmail_api_credentials`, `GmailLimitReached`, `SIZE_CAP_ERROR_MARKER` from `scripts/sync/email-migrate.py`.

**Reference spec:** `docs/superpowers/specs/2026-05-22-penn-email-attachment-backfill-design.md`

---

## File Structure

- **Create:** `scripts/sync/backfill-attachments.py` — the backfill script. Single responsibility: classify + repair pre-fix body-only Penn messages.
- **Create:** `scripts/sync/tests/test_backfill_attachments.py` — pytest test file.
- **Modify:** `scripts/sync/sync-health-check.sh` — add one regression-canary check (Task 9).

The backfill script is structured as small pure-ish functions so each is independently testable:
- `_load_migrate_module()` — sets `GMAIL_MIGRATE_USER` env, imports `email-migrate.py` via importlib, guards `SystemExit`.
- `build_emlx_index(em)` — `{folder: {basename: full_Path}}` from `discover_folders()`.
- `strip_message_id(mid)` — strips `<>` from a Message-ID header value.
- `message_has_attachments(gmail_msg)` — True if a Gmail message resource has ≥1 attachment part.
- `find_gmail_copies(service, label_id, mid)` — returns the list of Gmail message resources matching `rfc822msgid:`.
- `classify(...)` — returns a bucket name for one candidate message.
- `repair_one(...)` — executes import → verify → trash for one `WOULD_REPAIR` message.
- `main()` — arg parsing, iteration, report.

---

## Task 1: Module loader + Message-ID stripping

**Files:**
- Create: `scripts/sync/backfill-attachments.py`
- Test: `scripts/sync/tests/test_backfill_attachments.py`

- [ ] **Step 1: Write the failing test**

```python
"""Tests for backfill-attachments.py — repair pre-fix body-only Penn messages."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_BACKFILL_PATH = Path(__file__).resolve().parents[1] / "backfill-attachments.py"


def _load_backfill():
    spec = importlib.util.spec_from_file_location("backfill_under_test", _BACKFILL_PATH)
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["backfill-attachments.py"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


@pytest.fixture
def bf():
    return _load_backfill()


class TestStripMessageId:
    def test_strips_angle_brackets(self, bf):
        assert bf.strip_message_id("<abc@penn.edu>") == "abc@penn.edu"

    def test_leaves_bare_id_untouched(self, bf):
        assert bf.strip_message_id("abc@penn.edu") == "abc@penn.edu"

    def test_strips_whitespace_and_brackets(self, bf):
        assert bf.strip_message_id("  <abc@penn.edu>  ") == "abc@penn.edu"

    def test_none_returns_none(self, bf):
        assert bf.strip_message_id(None) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py -v`
Expected: FAIL — `backfill-attachments.py` does not exist (import error).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/sync/backfill-attachments.py`:

```python
#!/usr/bin/env python3
"""Penn email attachment backfill.

One-shot repair: ~192 Penn .partial.emlx messages were migrated to the
backup Gmail account body-only (attachments dropped) before the reinflate
fix shipped. This script re-uploads the attachment-bearing version and
trashes the body-only copy.

Usage:
    python3 scripts/sync/backfill-attachments.py            # dry-run report
    python3 scripts/sync/backfill-attachments.py --execute  # perform repair
    python3 scripts/sync/backfill-attachments.py --folder Inbox  # one folder

See docs/superpowers/specs/2026-05-22-penn-email-attachment-backfill-design.md
"""
from __future__ import annotations

import argparse
import importlib.util
import logging
import os
import sys
import time
from pathlib import Path

log = logging.getLogger("backfill-attachments")

MIGRATE_USER = "mikejg1838@gmail.com"
_MIGRATE_PATH = Path(__file__).resolve().parent / "email-migrate.py"


def strip_message_id(mid):
    """Strip surrounding angle brackets and whitespace from a Message-ID.

    The Gmail `rfc822msgid:` search operator matches the bare id; passing
    the `<...>`-wrapped header value verbatim can return zero matches.
    """
    if mid is None:
        return None
    return mid.strip().lstrip("<").rstrip(">").strip()


def _load_migrate_module():
    """Import email-migrate.py as a module.

    GMAIL_MIGRATE_USER is frozen into email-migrate.py's GMAIL_USER constant
    at import time, so it MUST be set before exec_module. load_gmail_api_
    credentials() calls sys.exit(1) on a missing token — callers that import
    the module purely for its pure functions are unaffected (that only runs
    when credentials are actually loaded).
    """
    os.environ.setdefault("GMAIL_MIGRATE_USER", MIGRATE_USER)
    spec = importlib.util.spec_from_file_location("email_migrate_for_backfill", _MIGRATE_PATH)
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["email-migrate.py"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestStripMessageId -v`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/sync/backfill-attachments.py scripts/sync/tests/test_backfill_attachments.py
rtk git commit -m "feat(backfill): module loader + Message-ID stripping"
```

---

## Task 2: Gmail message attachment detection

**Files:**
- Modify: `scripts/sync/backfill-attachments.py`
- Test: `scripts/sync/tests/test_backfill_attachments.py`

`message_has_attachments` inspects a Gmail `messages.get` resource (format=`full`)
and returns True if any MIME part has a filename and a non-empty body. Used both
for the idempotency check (is the matched message already repaired?) and the
post-import verify step.

- [ ] **Step 1: Write the failing test**

Append to `test_backfill_attachments.py`:

```python
class TestMessageHasAttachments:
    def test_body_only_message_has_no_attachments(self, bf):
        # Gmail messages.get format=full payload with only text parts
        msg = {
            "payload": {
                "mimeType": "multipart/alternative",
                "parts": [
                    {"mimeType": "text/plain", "filename": "", "body": {"size": 100}},
                    {"mimeType": "text/html", "filename": "", "body": {"size": 200}},
                ],
            }
        }
        assert bf.message_has_attachments(msg) is False

    def test_message_with_pdf_attachment(self, bf):
        msg = {
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    {"mimeType": "text/plain", "filename": "", "body": {"size": 100}},
                    {"mimeType": "application/pdf", "filename": "report.pdf",
                     "body": {"size": 50000, "attachmentId": "abc"}},
                ],
            }
        }
        assert bf.message_has_attachments(msg) is True

    def test_nested_multipart_with_inline_image(self, bf):
        msg = {
            "payload": {
                "mimeType": "multipart/related",
                "parts": [
                    {"mimeType": "multipart/alternative", "parts": [
                        {"mimeType": "text/plain", "filename": "", "body": {"size": 10}},
                    ]},
                    {"mimeType": "image/png", "filename": "image001.png",
                     "body": {"size": 49000, "attachmentId": "xyz"}},
                ],
            }
        }
        assert bf.message_has_attachments(msg) is True

    def test_empty_payload_has_no_attachments(self, bf):
        assert bf.message_has_attachments({"payload": {}}) is False

    def test_filename_present_but_zero_size_not_counted(self, bf):
        # A stub part with a filename but empty body is NOT a real attachment
        msg = {
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    {"mimeType": "image/png", "filename": "image001.png",
                     "body": {"size": 0}},
                ],
            }
        }
        assert bf.message_has_attachments(msg) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestMessageHasAttachments -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'message_has_attachments'`.

- [ ] **Step 3: Write minimal implementation**

Add to `backfill-attachments.py`:

```python
def message_has_attachments(gmail_msg):
    """Return True if a Gmail messages.get(format=full) resource has a real
    attachment part: a part with a non-empty filename and a body size > 0.

    Walks nested multiparts. A filename with size 0 is a stub, not a real
    attachment (this is exactly the body-only state we are repairing).
    """
    def _walk(part):
        filename = part.get("filename") or ""
        body = part.get("body") or {}
        size = body.get("size", 0) or 0
        if filename and size > 0:
            return True
        for child in part.get("parts", []) or []:
            if _walk(child):
                return True
        return False

    payload = gmail_msg.get("payload") or {}
    return _walk(payload)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestMessageHasAttachments -v`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/sync/backfill-attachments.py scripts/sync/tests/test_backfill_attachments.py
rtk git commit -m "feat(backfill): Gmail message attachment detection"
```

---

## Task 3: Build the .emlx full-path index

**Files:**
- Modify: `scripts/sync/backfill-attachments.py`
- Test: `scripts/sync/tests/test_backfill_attachments.py`

`build_emlx_index` calls `discover_folders()` (returns
`[(folder_path_str, mbox_entry, [emlx_full_paths])]`) and produces
`{folder_path: {basename: full_Path}}` so the backfill can resolve a
ledger basename (e.g. `106967.partial.emlx`) to its real disk path —
required because `parse_emlx` needs the full path to locate the Apple
sidecar attachment dir.

- [ ] **Step 1: Write the failing test**

Append to `test_backfill_attachments.py`:

```python
class TestBuildEmlxIndex:
    def test_index_maps_basename_to_full_path(self, bf):
        # Fake discover_folders() return shape
        class FakeEm:
            @staticmethod
            def discover_folders():
                return [
                    ("Inbox", object(), [
                        Path("/mail/Inbox.mbox/UUID/Data/1/Messages/100.emlx"),
                        Path("/mail/Inbox.mbox/UUID/Data/1/Messages/101.partial.emlx"),
                    ]),
                    ("Sent Items", object(), [
                        Path("/mail/Sent.mbox/UUID/Data/2/Messages/200.emlx"),
                    ]),
                ]

        index = bf.build_emlx_index(FakeEm())
        assert index["Inbox"]["100.emlx"] == Path("/mail/Inbox.mbox/UUID/Data/1/Messages/100.emlx")
        assert index["Inbox"]["101.partial.emlx"] == Path("/mail/Inbox.mbox/UUID/Data/1/Messages/101.partial.emlx")
        assert index["Sent Items"]["200.emlx"] == Path("/mail/Sent.mbox/UUID/Data/2/Messages/200.emlx")

    def test_index_empty_when_no_folders(self, bf):
        class FakeEm:
            @staticmethod
            def discover_folders():
                return []
        assert bf.build_emlx_index(FakeEm()) == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestBuildEmlxIndex -v`
Expected: FAIL — `message ... has no attribute 'build_emlx_index'`.

- [ ] **Step 3: Write minimal implementation**

Add to `backfill-attachments.py`:

```python
def build_emlx_index(em):
    """Build {folder_path: {basename: full_Path}} from discover_folders().

    discover_folders() returns [(folder_path_str, mbox_entry, [Path,...])].
    The backfill resolves ledger basenames to full paths because parse_emlx
    needs the full path to find the sibling Attachments/ sidecar dir.
    """
    index = {}
    for folder_path, _mbox_entry, emlx_files in em.discover_folders():
        index[folder_path] = {p.name: p for p in emlx_files}
    return index
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestBuildEmlxIndex -v`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/sync/backfill-attachments.py scripts/sync/tests/test_backfill_attachments.py
rtk git commit -m "feat(backfill): .emlx full-path index from discover_folders"
```

---

## Task 4: Find Gmail copies by Message-ID

**Files:**
- Modify: `scripts/sync/backfill-attachments.py`
- Test: `scripts/sync/tests/test_backfill_attachments.py`

`find_gmail_copies` queries `messages.list` with `q="rfc822msgid:<bare-id>"`
and `labelIds=[label_id]` (AND-combined, Trash excluded by default), then
`messages.get(format=full)` each hit. Returns the list of full message
resources.

- [ ] **Step 1: Write the failing test**

Append to `test_backfill_attachments.py`:

```python
class _FakeGmailService:
    """Minimal fake Gmail service for find_gmail_copies / repair tests.

    list_returns: dict mapping the rfc822msgid query string -> list of
      {"id": ...} stubs.
    get_returns: dict mapping message id -> full message resource.
    """
    def __init__(self, list_returns=None, get_returns=None):
        self.list_returns = list_returns or {}
        self.get_returns = get_returns or {}
        self.import_calls = []
        self.trash_calls = []

    def users(self):
        return _FakeUsers(self)


class _FakeUsers:
    def __init__(self, svc):
        self._svc = svc

    def messages(self):
        return _FakeMessages(self._svc)


class _FakeMessages:
    def __init__(self, svc):
        self._svc = svc

    def list(self, userId, q=None, labelIds=None, maxResults=None,
             includeSpamTrash=None, pageToken=None):
        stubs = self._svc.list_returns.get(q, [])
        return _FakeReq({"messages": stubs})

    def get(self, userId, id, format=None, metadataHeaders=None):
        return _FakeReq(self._svc.get_returns.get(id, {"id": id, "payload": {}}))

    def import_(self, userId, body, **kwargs):
        self._svc.import_calls.append({"body": body, "kwargs": kwargs})
        return _FakeReq({"id": "imported-" + str(len(self._svc.import_calls))})

    def trash(self, userId, id):
        self._svc.trash_calls.append(id)
        return _FakeReq({"id": id, "labelIds": ["TRASH"]})


class _FakeReq:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


class TestFindGmailCopies:
    def test_returns_full_resources_for_each_match(self, bf):
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}, {"id": "m2"}]},
            get_returns={
                "m1": {"id": "m1", "payload": {"mimeType": "text/plain"}},
                "m2": {"id": "m2", "payload": {"mimeType": "text/plain"}},
            },
        )
        copies = bf.find_gmail_copies(svc, "Label_5", "abc@penn.edu")
        assert {c["id"] for c in copies} == {"m1", "m2"}

    def test_returns_empty_when_no_match(self, bf):
        svc = _FakeGmailService(list_returns={})
        assert bf.find_gmail_copies(svc, "Label_5", "missing@penn.edu") == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestFindGmailCopies -v`
Expected: FAIL — `message ... has no attribute 'find_gmail_copies'`.

- [ ] **Step 3: Write minimal implementation**

Add to `backfill-attachments.py`:

```python
def find_gmail_copies(service, label_id, bare_message_id):
    """Return the list of full Gmail message resources whose RFC822
    Message-ID matches `bare_message_id`, scoped to `label_id`.

    Uses q="rfc822msgid:..." (AND-combined with labelIds). Trash is
    excluded (includeSpamTrash defaults to false) — intentional: a
    body-only copy we want to repair lives on the label, not in Trash.
    """
    query = f"rfc822msgid:{bare_message_id}"
    resp = (
        service.users().messages()
        .list(userId="me", q=query, labelIds=[label_id], maxResults=100)
        .execute()
    )
    stubs = resp.get("messages", []) or []
    copies = []
    for stub in stubs:
        msg = (
            service.users().messages()
            .get(userId="me", id=stub["id"], format="full")
            .execute()
        )
        copies.append(msg)
    return copies
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestFindGmailCopies -v`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/sync/backfill-attachments.py scripts/sync/tests/test_backfill_attachments.py
rtk git commit -m "feat(backfill): find Gmail copies by rfc822msgid"
```

---

## Task 5: Classify one candidate into a bucket

**Files:**
- Modify: `scripts/sync/backfill-attachments.py`
- Test: `scripts/sync/tests/test_backfill_attachments.py`

`classify` takes the reinflated rfc822 and the list of Gmail copies for one
message, and returns one of: `WOULD_REPAIR`, `WOULD_REPAIR_TRASH_ONLY`,
`ALREADY_DONE`, `MISSING`, `AMBIGUOUS`. (`SKIP_NO_ATTACHMENTS` and
`SKIP_TOO_LARGE` are decided by the caller before `classify` — see Task 7 —
because they depend on the .emlx parse, not the Gmail copies.)

`classify` is given the Gmail copies already fetched (full resources) plus a
bool `reinflated_has_attachments` indicating whether the local reinflated
message actually has attachments to contribute.

- [ ] **Step 1: Write the failing test**

Append to `test_backfill_attachments.py`:

```python
class TestClassify:
    def _bodyonly(self, mid):
        return {"id": mid, "payload": {"mimeType": "multipart/alternative",
                "parts": [{"mimeType": "text/plain", "filename": "", "body": {"size": 50}}]}}

    def _withattach(self, mid):
        return {"id": mid, "payload": {"mimeType": "multipart/mixed", "parts": [
            {"mimeType": "text/plain", "filename": "", "body": {"size": 50}},
            {"mimeType": "application/pdf", "filename": "x.pdf", "body": {"size": 9000}},
        ]}}

    def test_zero_copies_is_missing(self, bf):
        assert bf.classify([], reinflated_has_attachments=True) == "MISSING"

    def test_single_bodyonly_copy_is_would_repair(self, bf):
        copies = [self._bodyonly("m1")]
        assert bf.classify(copies, reinflated_has_attachments=True) == "WOULD_REPAIR"

    def test_single_copy_with_attachments_is_already_done(self, bf):
        copies = [self._withattach("m1")]
        assert bf.classify(copies, reinflated_has_attachments=True) == "ALREADY_DONE"

    def test_two_copies_one_bodyonly_one_attach_is_trash_only(self, bf):
        # Re-run after import-succeeded-trash-failed: clean up the duplicate
        copies = [self._bodyonly("m1"), self._withattach("m2")]
        assert bf.classify(copies, reinflated_has_attachments=True) == "WOULD_REPAIR_TRASH_ONLY"

    def test_two_bodyonly_copies_is_ambiguous(self, bf):
        copies = [self._bodyonly("m1"), self._bodyonly("m2")]
        assert bf.classify(copies, reinflated_has_attachments=True) == "AMBIGUOUS"

    def test_two_copies_both_with_attachments_is_already_done(self, bf):
        copies = [self._withattach("m1"), self._withattach("m2")]
        assert bf.classify(copies, reinflated_has_attachments=True) == "ALREADY_DONE"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestClassify -v`
Expected: FAIL — `message ... has no attribute 'classify'`.

- [ ] **Step 3: Write minimal implementation**

Add to `backfill-attachments.py`:

```python
def classify(gmail_copies, reinflated_has_attachments):
    """Classify one candidate message into a repair bucket.

    gmail_copies: list of full Gmail message resources matching the
      message's rfc822msgid on the folder label.
    reinflated_has_attachments: whether the local reinflated .emlx actually
      has attachments (caller decides SKIP_NO_ATTACHMENTS before this).

    Returns one of: MISSING, WOULD_REPAIR, WOULD_REPAIR_TRASH_ONLY,
    ALREADY_DONE, AMBIGUOUS.
    """
    if not gmail_copies:
        return "MISSING"

    body_only = [m for m in gmail_copies if not message_has_attachments(m)]
    with_attach = [m for m in gmail_copies if message_has_attachments(m)]

    if not body_only:
        # Every copy already has attachments
        return "ALREADY_DONE"

    if len(body_only) == 1 and with_attach:
        # One body-only copy + at least one attachment-bearing copy:
        # a prior --execute imported but did not finish trashing.
        return "WOULD_REPAIR_TRASH_ONLY"

    if len(body_only) == 1 and not with_attach:
        return "WOULD_REPAIR"

    # 2+ body-only copies — unclear which (if any) to trash; manual review.
    return "AMBIGUOUS"
```

Note: `reinflated_has_attachments` is part of the signature for caller
clarity and future use; the bucket logic above keys off the Gmail-side
state. The caller (Task 7) gates on `reinflated_has_attachments` to assign
`SKIP_NO_ATTACHMENTS` before ever calling `classify`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestClassify -v`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/sync/backfill-attachments.py scripts/sync/tests/test_backfill_attachments.py
rtk git commit -m "feat(backfill): bucket classification logic"
```

---

## Task 6: repair_one — import → verify → trash

**Files:**
- Modify: `scripts/sync/backfill-attachments.py`
- Test: `scripts/sync/tests/test_backfill_attachments.py`

`repair_one` performs the import-first repair for a single `WOULD_REPAIR`
message: import the reinflated rfc822 (with labels copied from the old
copy), verify the new message has attachments, and only then trash the old
body-only copy. On any failure before the trash, it returns an
`IMPORT_FAILED` outcome and never trashes.

- [ ] **Step 1: Write the failing test**

Append to `test_backfill_attachments.py`:

```python
class TestRepairOne:
    def _withattach(self, mid):
        return {"id": mid, "payload": {"mimeType": "multipart/mixed", "parts": [
            {"mimeType": "application/pdf", "filename": "x.pdf", "body": {"size": 9000}},
        ]}}

    def _bodyonly(self, mid, labels=None):
        return {"id": mid, "labelIds": labels or ["Label_5", "UNREAD"],
                "payload": {"mimeType": "text/plain"}}

    def test_import_then_verify_then_trash_on_happy_path(self, bf):
        # import_ returns id imported-1; verify get returns attachment-bearing
        svc = _FakeGmailService(
            get_returns={"imported-1": self._withattach("imported-1")},
        )
        old = self._bodyonly("old-id", labels=["Label_5", "STARRED", "UNREAD"])
        outcome = bf.repair_one(
            svc, label_id="Label_5", reinflated_bytes=b"RFC822-BYTES",
            old_message=old,
        )
        assert outcome == "REPAIRED"
        # import_ was called exactly once
        assert len(svc.import_calls) == 1
        # labelIds on the import include the folder label + copied user labels
        sent_labels = svc.import_calls[0]["body"]["labelIds"]
        assert "Label_5" in sent_labels
        assert "STARRED" in sent_labels
        # old copy was trashed AFTER import + verify
        assert svc.trash_calls == ["old-id"]

    def test_import_failure_does_not_trash(self, bf):
        # import_ raises -> old copy must NOT be trashed
        svc = _FakeGmailService()

        def boom(*a, **kw):
            raise RuntimeError("import 413")
        # monkeypatch the messages().import_ to raise
        import types
        orig_messages = svc.users().messages
        svc._force_import_error = True
        outcome = bf.repair_one(
            svc, label_id="Label_5", reinflated_bytes=b"X",
            old_message=self._bodyonly("old-id"),
            _import_raises=RuntimeError("import 413"),
        )
        assert outcome == "IMPORT_FAILED"
        assert svc.trash_calls == []  # CRITICAL: old copy untouched

    def test_verify_failure_does_not_trash(self, bf):
        # import succeeds, but the verify get returns a body-only message
        svc = _FakeGmailService(
            get_returns={"imported-1": {"id": "imported-1",
                         "payload": {"mimeType": "text/plain"}}},
        )
        outcome = bf.repair_one(
            svc, label_id="Label_5", reinflated_bytes=b"X",
            old_message=self._bodyonly("old-id"),
        )
        assert outcome == "IMPORT_FAILED"
        assert svc.trash_calls == []  # CRITICAL: old copy untouched
```

Note: the `_import_raises` test parameter is a test-only injection hook —
the implementation accepts an optional `_import_raises` exception to
simulate an import failure without a real Gmail error. This keeps the test
deterministic. Remove the `boom`/`types`/`orig_messages` dead lines — they
are not needed; the final test body is:

```python
    def test_import_failure_does_not_trash(self, bf):
        svc = _FakeGmailService()
        outcome = bf.repair_one(
            svc, label_id="Label_5", reinflated_bytes=b"X",
            old_message=self._bodyonly("old-id"),
            _import_raises=RuntimeError("import 413"),
        )
        assert outcome == "IMPORT_FAILED"
        assert svc.trash_calls == []  # CRITICAL: old copy untouched
```

(Use this corrected version — replace the earlier draft of
`test_import_failure_does_not_trash` with this one before running.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestRepairOne -v`
Expected: FAIL — `message ... has no attribute 'repair_one'`.

- [ ] **Step 3: Write minimal implementation**

Add to `backfill-attachments.py`:

```python
import base64


def repair_one(service, label_id, reinflated_bytes, old_message,
               _import_raises=None):
    """Import-first repair of one WOULD_REPAIR message.

    1. messages.import the reinflated rfc822, labelIds = folder label +
       user labels copied from the old body-only message.
    2. messages.get the new id, verify it has attachment parts.
    3. Only if verify passes: messages.trash the old body-only copy.

    On any failure before step 3, the old copy is left untouched — worst
    case is a harmless duplicate, never data loss.

    `_import_raises` is a test-only hook to simulate an import exception.

    Returns "REPAIRED" or "IMPORT_FAILED".
    """
    # Compose labelIds: folder label + user labels from the old copy.
    # Drop Gmail system labels that import sets itself or that don't
    # transfer meaningfully.
    skip_labels = {"UNREAD", "TRASH", "SPAM", "INBOX", "SENT", "DRAFT"}
    old_labels = [l for l in (old_message.get("labelIds") or [])
                  if l not in skip_labels]
    label_ids = list(dict.fromkeys([label_id] + old_labels))

    raw = base64.urlsafe_b64encode(reinflated_bytes).decode("ascii")
    body = {"raw": raw, "labelIds": label_ids}

    try:
        if _import_raises is not None:
            raise _import_raises
        result = (
            service.users().messages()
            .import_(userId="me", body=body,
                     internalDateSource="dateHeader", neverMarkSpam=True)
            .execute()
        )
    except Exception as e:
        log.warning("  import failed for old id %s: %s",
                    old_message.get("id"), e)
        return "IMPORT_FAILED"

    new_id = result.get("id")
    # Verify the new message actually has attachments.
    try:
        new_msg = (
            service.users().messages()
            .get(userId="me", id=new_id, format="full")
            .execute()
        )
    except Exception as e:
        log.warning("  verify get failed for new id %s: %s", new_id, e)
        return "IMPORT_FAILED"

    if not message_has_attachments(new_msg):
        log.warning("  verify failed: imported msg %s has no attachments; "
                    "leaving old copy %s intact", new_id, old_message.get("id"))
        return "IMPORT_FAILED"

    # Verified — safe to trash the old body-only copy.
    service.users().messages().trash(
        userId="me", id=old_message["id"]
    ).execute()
    return "REPAIRED"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestRepairOne -v`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/sync/backfill-attachments.py scripts/sync/tests/test_backfill_attachments.py
rtk git commit -m "feat(backfill): repair_one import-verify-trash sequence"
```

---

## Task 7: trash-only repair + main() orchestration

**Files:**
- Modify: `scripts/sync/backfill-attachments.py`
- Test: `scripts/sync/tests/test_backfill_attachments.py`

Adds `trash_only(service, body_only_message)` for the
`WOULD_REPAIR_TRASH_ONLY` bucket, and `main()` that wires arg parsing,
folder iteration, classification, dry-run reporting, and (under `--execute`)
the repair calls. `main()` catches `GmailLimitReached` and stops cleanly.

- [ ] **Step 1: Write the failing test**

Append to `test_backfill_attachments.py`:

```python
class TestTrashOnly:
    def test_trash_only_trashes_the_body_only_copy(self, bf):
        svc = _FakeGmailService()
        body_only = {"id": "dup-id", "payload": {"mimeType": "text/plain"}}
        outcome = bf.trash_only(svc, body_only)
        assert outcome == "REPAIRED"
        assert svc.trash_calls == ["dup-id"]

    def test_trash_only_reports_failure_without_raising(self, bf):
        class _RaisingSvc(_FakeGmailService):
            def users(self):
                return _RaisingUsers(self)

        class _RaisingUsers:
            def __init__(self, svc): self._svc = svc
            def messages(self): return _RaisingMessages()

        class _RaisingMessages:
            def trash(self, userId, id):
                class _R:
                    def execute(self_inner):
                        raise RuntimeError("trash 500")
                return _R()

        outcome = bf.trash_only(_RaisingSvc(), {"id": "x"})
        assert outcome == "IMPORT_FAILED"


class TestMainDryRunWritesNothing:
    def test_dry_run_makes_no_import_or_trash_calls(self, bf, monkeypatch, tmp_path, capsys):
        """In dry-run mode (no --execute), main must classify and report
        but never call import_ or trash."""
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={"m1": {"id": "m1", "payload": {"mimeType": "text/plain"}}},
        )
        # run_backfill is the testable core: given an em module, a service,
        # a candidate list, and execute flag, it returns a bucket-count dict.
        candidates = [
            bf.Candidate(folder="Inbox", basename="101.partial.emlx",
                         label_id="Label_5", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(svc, candidates, execute=False)
        assert counts["WOULD_REPAIR"] == 1
        assert svc.import_calls == []
        assert svc.trash_calls == []

    def test_execute_repairs_would_repair_candidate(self, bf):
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={
                "m1": {"id": "m1", "labelIds": ["Label_5"],
                       "payload": {"mimeType": "text/plain"}},
                "imported-1": {"id": "imported-1", "payload": {
                    "mimeType": "multipart/mixed", "parts": [
                        {"mimeType": "application/pdf", "filename": "x.pdf",
                         "body": {"size": 9000}}]}},
            },
        )
        candidates = [
            bf.Candidate(folder="Inbox", basename="101.partial.emlx",
                         label_id="Label_5", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(svc, candidates, execute=True)
        assert counts["WOULD_REPAIR"] == 1
        assert len(svc.import_calls) == 1
        assert svc.trash_calls == ["m1"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestTrashOnly tests/test_backfill_attachments.py::TestMainDryRunWritesNothing -v`
Expected: FAIL — `message ... has no attribute 'trash_only'` / `'Candidate'` / `'run_backfill'`.

- [ ] **Step 3: Write minimal implementation**

Add to `backfill-attachments.py`:

```python
from dataclasses import dataclass


@dataclass
class Candidate:
    """One backfill candidate: a pre-fix .partial.emlx and its lookup keys."""
    folder: str
    basename: str
    label_id: str
    bare_mid: str
    reinflated_bytes: bytes
    reinflated_has_attachments: bool


def trash_only(service, body_only_message):
    """Trash a leftover body-only copy (WOULD_REPAIR_TRASH_ONLY bucket).

    Used when a prior --execute imported the attachment copy but failed to
    trash the body-only original. Returns "REPAIRED" or "IMPORT_FAILED".
    """
    try:
        service.users().messages().trash(
            userId="me", id=body_only_message["id"]
        ).execute()
        return "REPAIRED"
    except Exception as e:
        log.warning("  trash-only failed for id %s: %s",
                    body_only_message.get("id"), e)
        return "IMPORT_FAILED"


# All buckets the report tracks.
BUCKETS = [
    "WOULD_REPAIR", "WOULD_REPAIR_TRASH_ONLY", "ALREADY_DONE", "MISSING",
    "AMBIGUOUS", "SKIP_NO_ATTACHMENTS", "SKIP_TOO_LARGE", "IMPORT_FAILED",
]


def run_backfill(service, candidates, execute, rate_limit_s=0.3,
                 em=None):
    """Classify and (if execute) repair each candidate.

    Returns a dict of bucket -> count. In dry-run (execute=False) it
    classifies and counts but performs no import/trash.

    Raising GmailLimitReached propagates to the caller (main), which stops
    cleanly — partial progress is fine because re-runs are idempotent.
    """
    counts = {b: 0 for b in BUCKETS}

    for cand in candidates:
        if not cand.reinflated_has_attachments:
            counts["SKIP_NO_ATTACHMENTS"] += 1
            continue

        copies = find_gmail_copies(service, cand.label_id, cand.bare_mid)
        bucket = classify(copies, cand.reinflated_has_attachments)

        if not execute or bucket in ("ALREADY_DONE", "MISSING", "AMBIGUOUS"):
            counts[bucket] += 1
            if bucket == "MISSING":
                log.info("  MISSING (no Gmail copy): %s/%s",
                         cand.folder, cand.basename)
            continue

        # execute mode, actionable bucket
        if bucket == "WOULD_REPAIR":
            body_only = [m for m in copies if not message_has_attachments(m)][0]
            outcome = repair_one(service, cand.label_id,
                                 cand.reinflated_bytes, body_only)
        elif bucket == "WOULD_REPAIR_TRASH_ONLY":
            body_only = [m for m in copies if not message_has_attachments(m)][0]
            outcome = trash_only(service, body_only)
        else:
            outcome = None

        if outcome == "REPAIRED":
            counts[bucket] += 1
        elif outcome == "IMPORT_FAILED":
            counts["IMPORT_FAILED"] += 1

        if rate_limit_s:
            time.sleep(rate_limit_s)

    return counts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestTrashOnly tests/test_backfill_attachments.py::TestMainDryRunWritesNothing -v`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/sync/backfill-attachments.py scripts/sync/tests/test_backfill_attachments.py
rtk git commit -m "feat(backfill): trash-only path + run_backfill orchestration"
```

---

## Task 8: main() entry point — candidate building + CLI

**Files:**
- Modify: `scripts/sync/backfill-attachments.py`
- Test: `scripts/sync/tests/test_backfill_attachments.py`

`build_candidates(em, emlx_index, state, uploader, folder_filter)` turns the
migration ledger into a list of `Candidate` objects: for each `.partial.emlx`
basename, resolve its full path, run `parse_emlx`, decide
`reinflated_has_attachments`, resolve the folder label via
`folder_to_label` + `uploader._ensure_label`. `main()` wires everything:
load module, load creds, build uploader, read ledger, build candidates,
call `run_backfill`, print the report.

- [ ] **Step 1: Write the failing test**

Append to `test_backfill_attachments.py`:

```python
class TestBuildCandidates:
    def test_skips_non_partial_emlx(self, bf, tmp_path):
        """Only .partial.emlx files become candidates; full .emlx skipped."""
        # Minimal fake em module
        class FakeEm:
            @staticmethod
            def folder_to_label(folder):
                return "Outlook/" + folder
            @staticmethod
            def parse_emlx(path):
                # return rfc822 with one attachment + a message-id
                rfc = (b"Message-ID: <m@penn.edu>\r\n\r\n"
                       b"--b\r\nContent-Disposition: attachment; filename=x.pdf\r\n\r\n"
                       b"data\r\n--b--\r\n")
                return (rfc, True, 0)

        emlx_index = {
            "Inbox": {
                "100.emlx": tmp_path / "100.emlx",
                "101.partial.emlx": tmp_path / "101.partial.emlx",
            }
        }
        state = {"folders": {"Inbox": {"migrated_files": [
            "100.emlx", "101.partial.emlx"]}}}

        class FakeUploader:
            def _ensure_label(self, name):
                return "Label_for_" + name

        cands = bf.build_candidates(FakeEm(), emlx_index, state,
                                    FakeUploader(), folder_filter=None)
        # Only the .partial.emlx becomes a candidate
        assert len(cands) == 1
        assert cands[0].basename == "101.partial.emlx"
        assert cands[0].folder == "Inbox"
        assert cands[0].bare_mid == "m@penn.edu"

    def test_folder_filter_restricts_candidates(self, bf, tmp_path):
        class FakeEm:
            @staticmethod
            def folder_to_label(folder):
                return "Outlook/" + folder
            @staticmethod
            def parse_emlx(path):
                return (b"Message-ID: <m@penn.edu>\r\n\r\nbody\r\n", True, 0)

        emlx_index = {
            "Inbox": {"1.partial.emlx": tmp_path / "1.partial.emlx"},
            "Sent Items": {"2.partial.emlx": tmp_path / "2.partial.emlx"},
        }
        state = {"folders": {
            "Inbox": {"migrated_files": ["1.partial.emlx"]},
            "Sent Items": {"migrated_files": ["2.partial.emlx"]},
        }}

        class FakeUploader:
            def _ensure_label(self, name): return "L"

        cands = bf.build_candidates(FakeEm(), emlx_index, state,
                                    FakeUploader(), folder_filter="Inbox")
        assert {c.folder for c in cands} == {"Inbox"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py::TestBuildCandidates -v`
Expected: FAIL — `message ... has no attribute 'build_candidates'`.

- [ ] **Step 3: Write minimal implementation**

Add to `backfill-attachments.py`:

```python
import email as _email


def _rfc822_has_attachment(rfc822_bytes):
    """True if the rfc822 message has a MIME part with a non-empty
    attachment payload (filename + decoded bytes)."""
    try:
        msg = _email.message_from_bytes(rfc822_bytes)
    except Exception:
        return False
    for part in msg.walk():
        if part.get_filename() and (part.get_payload(decode=True) or b""):
            return True
    return False


def build_candidates(em, emlx_index, state, uploader, folder_filter):
    """Build the list of Candidate objects from the migration ledger.

    Only `.partial.emlx` files are candidates (full .emlx never had stubs).
    Resolves each basename to a full disk path via emlx_index, runs
    parse_emlx (attachment-aware), and resolves the folder's Gmail label.
    """
    candidates = []
    for folder, fstate in state.get("folders", {}).items():
        if folder_filter and folder != folder_filter:
            continue
        label_name = em.folder_to_label(folder)
        label_id = uploader._ensure_label(label_name)
        folder_index = emlx_index.get(folder, {})
        for basename in fstate.get("migrated_files", []):
            if ".partial." not in basename:
                continue
            full_path = folder_index.get(basename)
            if full_path is None:
                log.warning("  %s/%s in ledger but not on disk — skipping",
                            folder, basename)
                continue
            parsed = em.parse_emlx(full_path)
            if parsed is None:
                log.warning("  parse_emlx failed for %s/%s", folder, basename)
                continue
            rfc822, _is_read, _ts = parsed
            mid = strip_message_id(em.extract_message_id(rfc822))
            if not mid:
                log.warning("  no Message-ID for %s/%s — skipping",
                            folder, basename)
                continue
            candidates.append(Candidate(
                folder=folder,
                basename=basename,
                label_id=label_id,
                bare_mid=mid,
                reinflated_bytes=rfc822,
                reinflated_has_attachments=_rfc822_has_attachment(rfc822),
            ))
    return candidates


def _print_report(counts, execute):
    """Print the bucket-count report."""
    mode = "EXECUTE" if execute else "DRY RUN"
    log.info("")
    log.info("=== Backfill report (%s) ===", mode)
    for bucket in BUCKETS:
        log.info("  %-26s %d", bucket, counts.get(bucket, 0))
    log.info("")
    if not execute and counts.get("WOULD_REPAIR", 0):
        log.info("Re-run with --execute to repair %d message(s).",
                 counts["WOULD_REPAIR"])
    if counts.get("MISSING", 0):
        log.info("NOTE: %d message(s) have no Gmail copy at all — these are "
                 "migration gaps, not backfill candidates.", counts["MISSING"])


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description="Penn email attachment backfill")
    parser.add_argument("--execute", action="store_true",
                        help="Perform the repair (default: dry-run report)")
    parser.add_argument("--folder", default=None,
                        help="Restrict to one folder (e.g. Inbox)")
    args = parser.parse_args()

    try:
        em = _load_migrate_module()
    except SystemExit:
        log.error("Could not load email-migrate.py (missing Gmail token?)")
        return 1

    creds = em.load_gmail_api_credentials()
    uploader = em.GmailApiUploader(creds)
    service = uploader._admin_service

    state = em.load_state()
    emlx_index = build_emlx_index(em)
    candidates = build_candidates(em, emlx_index, state, uploader, args.folder)
    log.info("Found %d .partial.emlx candidate(s) across the ledger.",
             len(candidates))

    try:
        counts = run_backfill(service, candidates, execute=args.execute)
    except em.GmailLimitReached as e:
        log.warning("Gmail quota reached — stopping. Re-run to resume. %s", e)
        return 0

    _print_report(counts, args.execute)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py -v`
Expected: PASS — all tests (Tasks 1-8).

- [ ] **Step 5: Dry-run smoke test against real data**

Run: `cd /Users/mgandal/Agents/nanoclaw && GMAIL_MIGRATE_USER=mikejg1838@gmail.com python3 scripts/sync/backfill-attachments.py`
Expected: prints a bucket report. `WOULD_REPAIR` should be roughly ~190, `ALREADY_DONE` small or zero, `SKIP_NO_ATTACHMENTS` ~55. NO import/trash calls made (dry-run). If the report looks sane, proceed.

- [ ] **Step 6: Commit**

```bash
rtk git add scripts/sync/backfill-attachments.py scripts/sync/tests/test_backfill_attachments.py
rtk git commit -m "feat(backfill): main() entry point + candidate building"
```

---

## Task 9: Regression canary in sync-health-check.sh

**Files:**
- Modify: `scripts/sync/sync-health-check.sh`
- Test: manual (shell script; the existing `.bats` tests cover the harness)

Adds one check: after a sync, if the most-recent `.partial.emlx` uploaded
appears in Gmail body-only, flag it. This is a lightweight canary that the
shipped reinflate fix has not regressed. It does NOT call the Gmail API
heavily — it samples one message.

- [ ] **Step 1: Read the current health-check structure**

Run: `rtk proxy grep -n "^check \|^# 7[a-z]\.\|notes export freshness" scripts/sync/sync-health-check.sh | head -20`
Expected: shows the numbered check sections (7a, 7b, ...). Identify the last `7x` section to append after it.

- [ ] **Step 2: Add the canary check**

Append a new check section after the last `7x` section in `sync-health-check.sh` (adjust the section letter to follow the existing sequence — if the last is `7e`, this is `7f`):

```bash
# 7f. Attachment-reinflate regression canary. The email-migrate.py fix
# (commits 0844e5b4..85072d20) makes .partial.emlx files upload WITH
# attachments. This canary samples the single most-recently-modified
# Penn .partial.emlx and confirms parse_emlx still reinflates it. If a
# future change breaks reinflate, fresh mail silently uploads body-only.
CANARY=$(GMAIL_MIGRATE_USER=mikejg1838@gmail.com /usr/bin/python3 - <<'PYEOF' 2>/dev/null
import glob, os, sys, importlib.util, email
from pathlib import Path
root = '/Users/mgandal/Library/Mail/V10/EF7AC40E-29D7-47BD-AE80-2A6694A1045E'
parts = glob.glob(root + '/INBOX.mbox/**/Messages/*.partial.emlx', recursive=True)
if not parts:
    print("SKIP"); sys.exit(0)
newest = max(parts, key=os.path.getmtime)
spec = importlib.util.spec_from_file_location(
    "em", os.path.expanduser("~/Agents/nanoclaw/scripts/sync/email-migrate.py"))
em = importlib.util.module_from_spec(spec)
sys.argv = ["email-migrate.py"]
spec.loader.exec_module(em)
r = em.parse_emlx(Path(newest))
if r is None:
    print("FAIL"); sys.exit(0)
msg = email.message_from_bytes(r[0])
has_stub = any(p.get("X-Apple-Content-Length") for p in msg.walk())
has_attach = any(p.get_filename() and (p.get_payload(decode=True) or b"")
                 for p in msg.walk())
# A healthy reinflate leaves no stub headers. If the newest file has stubs
# AND no inlined attachment, reinflate regressed.
print("FAIL" if (has_stub and not has_attach) else "OK")
PYEOF
)
if [ "$CANARY" = "OK" ] || [ "$CANARY" = "SKIP" ]; then
    check "Attachment reinflate canary" "" 0
else
    check "Attachment reinflate canary" "newest .partial.emlx did not reinflate — reinflate fix may have regressed" 1
fi
```

- [ ] **Step 3: Run the health check to verify the new check passes**

Run: `cd /Users/mgandal/Agents/nanoclaw && bash scripts/sync/sync-health-check.sh 2>&1 | grep -A1 -i "reinflate canary"`
Expected: shows the canary check passing (`OK`).

- [ ] **Step 4: Run the existing bats tests to confirm no regression**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy bats tests/test_health_check_no_self_reference.bats tests/test_health_check_propagation.bats`
Expected: all existing bats tests still pass.

- [ ] **Step 5: Commit**

```bash
rtk git add scripts/sync/sync-health-check.sh
rtk git commit -m "feat(backfill): attachment-reinflate regression canary in health check"
```

---

## Task 10: Full suite verification + final commit

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full backfill test file**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/test_backfill_attachments.py -v`
Expected: all tests PASS.

- [ ] **Step 2: Run the full sync Python suite — no regressions**

Run: `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && rtk proxy python3 -m pytest tests/ --ignore-glob='*.bats' --ignore-glob='*.sh' -q`
Expected: all tests PASS (294 + new backfill tests).

- [ ] **Step 3: Final dry-run against real data**

Run: `cd /Users/mgandal/Agents/nanoclaw && GMAIL_MIGRATE_USER=mikejg1838@gmail.com python3 scripts/sync/backfill-attachments.py`
Expected: bucket report. Confirm `WOULD_REPAIR` count is in the expected ~190 range and `MISSING` is small. This is the report the user reviews before deciding to run `--execute`.

- [ ] **Step 4: Verify the real state file was not touched**

Run: `stat -f "%Sm %z" ~/.cache/email-migrate/email-migration.json`
Expected: size ~989 KB, mtime unchanged from before this plan's work (the backfill only READS the ledger, never writes it).

- [ ] **Step 5: Report to user**

Summarize: tests passing, dry-run report buckets, and that `--execute` is the user's call to make. Do NOT run `--execute` without explicit user approval — it mutates the Gmail account.

---

## Self-Review

**Spec coverage:** Every spec section maps to a task — module loader/import requirements (T1, T8), attachment detection (T2), full-path resolution via discover_folders (T3), rfc822msgid lookup (T4), 8-bucket classification (T5), import-verify-trash ordering (T6), trash-only re-run path (T6/T7), dry-run/execute run model (T7/T8), report buckets (T7/T8), regression canary (T9). Risks table in the spec is addressed: import-first (T6), exactly-1-match gate (T5), MISSING bucket (T5/T7), GmailLimitReached clean stop (T7/T8), WOULD_REPAIR_TRASH_ONLY duplicate cleanup (T5/T7), labelIds copy (T6), test isolation — all backfill tests use fakes, none touch real Gmail or the real state file (T1-T8, verified T10 step 4).

**Placeholder scan:** No TBD/TODO. Every code step has complete code. The one test-draft correction (T6 `test_import_failure_does_not_trash`) is called out explicitly with the corrected final version inline.

**Type consistency:** `Candidate` dataclass fields (`folder`, `basename`, `label_id`, `bare_mid`, `reinflated_bytes`, `reinflated_has_attachments`) are consistent across T7 (definition) and T8 (construction). `classify` signature `(gmail_copies, reinflated_has_attachments)` consistent T5↔T7. `repair_one(service, label_id, reinflated_bytes, old_message, _import_raises=None)` consistent T6↔T7. `run_backfill(service, candidates, execute, ...)` consistent T7↔T8. Bucket names in `BUCKETS` match those returned by `classify` and used in `run_backfill`/`_print_report`.
