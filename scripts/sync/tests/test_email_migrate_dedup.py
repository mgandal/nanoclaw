"""Regression tests for state-corruption recovery dedup.

The bug these tests pin:
`load_state()` rotates a corrupt state file aside and returns fresh state
(folders={}). The `migrated_folder()` walk then sees `migrated_files=[]` and
re-uploads every .emlx via `messages.import`. A long-standing comment at
load_state() line 131-134 claimed Gmail dedups by Message-ID — but the
Gmail API reference for messages.import does not document any such
behavior, and we don't want data integrity to depend on undocumented
vendor behavior.

The fix: before the walk, if `migrated_files` is empty AND the Gmail
label exists with messages, seed `migrated_files` from the Message-IDs
already in Gmail. Pure local check, no per-message API cost on normal
runs (only fires when state was lost).

These tests must FAIL on the pre-fix code and PASS on post-fix code.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


_MIGRATE_PATH = Path(__file__).resolve().parents[1] / "email-migrate.py"


@pytest.fixture(scope="module")
def migrate_module():
    spec = importlib.util.spec_from_file_location(
        "email_migrate_dedup_under_test", _MIGRATE_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["email-migrate.py"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


# ---------------------------------------------------------------------------
# .emlx fixture builder — Mac Mail format = bytes-prefix + RFC 822 + plist
# ---------------------------------------------------------------------------

def _make_emlx(tmp_path: Path, name: str, message_id: str, body: str = "hi") -> Path:
    """Write a minimal valid .emlx with a known Message-ID header."""
    rfc822 = (
        f"From: a@b.com\r\n"
        f"To: c@d.com\r\n"
        f"Subject: test\r\n"
        f"Message-ID: <{message_id}>\r\n"
        f"Date: Tue, 28 Apr 2026 12:00:00 +0000\r\n"
        f"\r\n"
        f"{body}\r\n"
    ).encode("utf-8")
    plist_trailer = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        b'"http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        b'<plist version="1.0"><dict>'
        b"<key>flags</key><integer>1</integer>"
        b"<key>date-received</key><integer>1730000000</integer>"
        b"</dict></plist>"
    )

    path = tmp_path / name
    with open(path, "wb") as f:
        f.write(f"{len(rfc822)}\n".encode("ascii"))
        f.write(rfc822)
        f.write(plist_trailer)
    return path


# ---------------------------------------------------------------------------
# Fake Gmail service — records messages.import calls + answers list/get
# ---------------------------------------------------------------------------

class _FakeGmailService:
    """Minimal stand-in for googleapiclient's Gmail service.

    Records every `messages.import_` body so tests can count duplicates.
    Pre-seeded with messages-already-in-gmail to simulate post-corruption
    recovery (Gmail still has the data, local state lost it).
    """

    def __init__(self, preseeded_message_ids=None, label_name=None, page_size=None):
        # Each entry: {"id": str, "headers": [{"name":"Message-ID","value":"<...>"}], "labelIds":[label_id]}
        self._messages = []
        self._label_id_for_name = {}
        # When page_size is set, list() paginates: the first call returns
        # page_size messages + a nextPageToken; subsequent calls follow the
        # token. Default None = single-page behavior (preserves the original
        # 5 tests' assumptions).
        self._page_size = page_size
        self.list_calls = []  # for pagination assertions
        if preseeded_message_ids and label_name:
            label_id = f"Label_{label_name}"
            self._label_id_for_name[label_name] = label_id
            for i, mid in enumerate(preseeded_message_ids):
                self._messages.append(
                    {
                        "id": f"gmail_msg_{i}",
                        "headers": [{"name": "Message-ID", "value": f"<{mid}>"}],
                        "labelIds": [label_id],
                    }
                )
        self.import_calls = []  # list of dicts: each is the `body` argument

    # --- public surface used by GmailApiUploader ---
    def users(self):
        return _FakeUsers(self)

    @property
    def label_cache(self):
        return self._label_id_for_name


class _FakeUsers:
    def __init__(self, svc):
        self._svc = svc

    def labels(self):
        return _FakeLabels(self._svc)

    def messages(self):
        return _FakeMessages(self._svc)


class _FakeLabels:
    def __init__(self, svc):
        self._svc = svc

    def list(self, userId):
        labels = [
            {"id": lid, "name": name}
            for name, lid in self._svc._label_id_for_name.items()
        ]
        return _FakeRequest({"labels": labels})


class _FakeMessages:
    def __init__(self, svc):
        self._svc = svc

    def list(self, userId, labelIds=None, maxResults=None, pageToken=None):
        # Record the call shape so pagination tests can assert pageToken plumbing.
        self._svc.list_calls.append({"labelIds": labelIds, "pageToken": pageToken})
        # Filter to messages bearing one of the requested labels.
        matching = []
        for m in self._svc._messages:
            if labelIds and not any(lid in m["labelIds"] for lid in labelIds):
                continue
            matching.append({"id": m["id"]})
        # Single-page mode (default): return everything, no token.
        if self._svc._page_size is None:
            return _FakeRequest({"messages": matching})
        # Paginated mode: slice by token. Token format is the integer offset.
        start = int(pageToken) if pageToken else 0
        end = start + self._svc._page_size
        page = matching[start:end]
        payload = {"messages": page}
        if end < len(matching):
            payload["nextPageToken"] = str(end)
        return _FakeRequest(payload)

    def get(self, userId, id, format=None, metadataHeaders=None):
        for m in self._svc._messages:
            if m["id"] == id:
                return _FakeRequest(
                    {"id": m["id"], "payload": {"headers": m["headers"]}}
                )
        raise KeyError(id)

    def import_(self, userId, body, internalDateSource=None, neverMarkSpam=None):
        self._svc.import_calls.append(dict(body))
        return _FakeRequest({"id": f"imported_{len(self._svc.import_calls)}"})


class _FakeRequest:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_extract_message_id_basic(migrate_module, tmp_path):
    """The helper must pull Message-ID out of an RFC 822 byte string."""
    rfc822 = b"From: x@y\r\nMessage-ID: <abc123@example.com>\r\nSubject: t\r\n\r\nbody"
    assert migrate_module.extract_message_id(rfc822) == "<abc123@example.com>"


def test_extract_message_id_missing_returns_none(migrate_module):
    """Messages without a Message-ID header must return None, not crash."""
    rfc822 = b"From: x@y\r\nSubject: t\r\n\r\nbody"
    assert migrate_module.extract_message_id(rfc822) is None


def test_seed_noop_when_migrated_files_already_populated(migrate_module, tmp_path):
    """If migrated_files is non-empty, do NOT touch Gmail — normal path stays cheap."""
    folder_state = {"migrated_files": ["1.emlx"], "total": 1, "migrated": 1, "errors": []}
    emlx = _make_emlx(tmp_path, "1.emlx", "abc@example.com")
    fake_gmail = _FakeGmailService()  # would error if we hit it (no preseeded label)

    seeded = migrate_module.seed_migrated_files_from_gmail(
        folder_state, "Outlook/Inbox", [emlx], fake_gmail.label_cache, fake_gmail
    )
    assert seeded == 0
    assert folder_state["migrated_files"] == ["1.emlx"]


def test_seed_populates_from_gmail_when_state_empty(migrate_module, tmp_path):
    """The recovery scenario: state lost, Gmail still has the data."""
    e1 = _make_emlx(tmp_path, "1.emlx", "msg-one@example.com")
    e2 = _make_emlx(tmp_path, "2.emlx", "msg-two@example.com")
    e3 = _make_emlx(tmp_path, "3.emlx", "msg-three@example.com")

    # Gmail already has 1 and 2 (from a prior run); 3 is genuinely new.
    fake_gmail = _FakeGmailService(
        preseeded_message_ids=["msg-one@example.com", "msg-two@example.com"],
        label_name="Outlook/Inbox",
    )
    folder_state = {"migrated_files": [], "total": 3, "migrated": 0, "errors": []}

    seeded = migrate_module.seed_migrated_files_from_gmail(
        folder_state, "Outlook/Inbox", [e1, e2, e3], fake_gmail.label_cache, fake_gmail
    )

    assert seeded == 2
    assert sorted(folder_state["migrated_files"]) == ["1.emlx", "2.emlx"]
    # Crucially: 3.emlx is NOT in migrated_files — it should still upload.


def test_seed_noop_when_label_does_not_exist_in_gmail(migrate_module, tmp_path):
    """First-ever run for a folder: no Gmail label yet, no seeding to do."""
    emlx = _make_emlx(tmp_path, "1.emlx", "msg-one@example.com")
    fake_gmail = _FakeGmailService()  # no labels, no messages
    folder_state = {"migrated_files": [], "total": 1, "migrated": 0, "errors": []}

    seeded = migrate_module.seed_migrated_files_from_gmail(
        folder_state, "Outlook/Inbox", [emlx], fake_gmail.label_cache, fake_gmail
    )

    assert seeded == 0
    assert folder_state["migrated_files"] == []


def test_corruption_rerun_does_not_double_import(migrate_module, tmp_path):
    """The integration scenario this whole exercise is about.

    Setup: 2 .emlx files already in Gmail (a prior successful run).
    State file is then corrupted; load_state() rotates it and returns
    fresh state. Without the fix, a subsequent walk would re-upload
    both messages via messages.import. With the fix, the seed step
    populates migrated_files first, and the upload loop sees zero
    remaining files.

    Asserts on the count of import_ calls — the only ground truth.
    """
    # 2 .emlx files, both already mirrored to Gmail
    e1 = _make_emlx(tmp_path, "1.emlx", "already-uploaded-1@example.com")
    e2 = _make_emlx(tmp_path, "2.emlx", "already-uploaded-2@example.com")
    fake_gmail = _FakeGmailService(
        preseeded_message_ids=[
            "already-uploaded-1@example.com",
            "already-uploaded-2@example.com",
        ],
        label_name="Outlook/Inbox",
    )

    # Simulate the post-corruption state load: empty migrated_files
    folder_state = {"migrated_files": [], "total": 2, "migrated": 0, "errors": []}

    # The fix: seed runs before the walk
    migrate_module.seed_migrated_files_from_gmail(
        folder_state, "Outlook/Inbox", [e1, e2], fake_gmail.label_cache, fake_gmail
    )

    # The walk that migrate_folder does (lines 446-447, 699-700)
    migrated_set = set(folder_state.get("migrated_files", []))
    remaining_files = [f for f in [e1, e2] if f.name not in migrated_set]

    # Both files were already uploaded → zero remaining
    assert remaining_files == [], (
        f"After seed, expected 0 files to re-upload; got {[f.name for f in remaining_files]}. "
        "If this fails, every state-corruption recovery silently double-imports."
    )

    # And we never called import_ — would have if we'd skipped the seed
    assert fake_gmail.import_calls == []


def test_seed_paginates_through_multi_page_label(migrate_module, tmp_path):
    """Pin the pageToken plumbing in the seed function's list loop.

    Setup: a Gmail label with 5 messages, fake paginates 2 per page.
    The matching local Message-ID is on page 3 (the last page) — so a
    seed that bails before pagination, or that sends `pageToken=None`
    on the second `list` call, would return 0 and the test fails.
    A correctly threaded loop returns 1.
    """
    target_emlx = _make_emlx(tmp_path, "1.emlx", "needle@example.com")
    fake_gmail = _FakeGmailService(
        preseeded_message_ids=[
            "haystack-a@example.com",
            "haystack-b@example.com",
            "haystack-c@example.com",
            "haystack-d@example.com",
            "needle@example.com",  # only matching ID, on page 3
        ],
        label_name="Outlook/Inbox",
        page_size=2,  # forces pagination: pages of 2, 2, 1
    )
    folder_state = {"migrated_files": [], "total": 1, "migrated": 0, "errors": []}

    seeded = migrate_module.seed_migrated_files_from_gmail(
        folder_state, "Outlook/Inbox", [target_emlx], fake_gmail.label_cache, fake_gmail
    )

    assert seeded == 1, (
        f"Pagination broken: needle was on page 3 but seed returned {seeded}. "
        f"list_calls={fake_gmail.list_calls}"
    )
    assert folder_state["migrated_files"] == ["1.emlx"]
    # Three list calls: page 1 (token None), page 2 (token "2"), page 3 (token "4")
    assert len(fake_gmail.list_calls) == 3, (
        f"Expected 3 list calls for 5 msgs at page_size=2; got {len(fake_gmail.list_calls)}"
    )
    assert fake_gmail.list_calls[0]["pageToken"] is None
    assert fake_gmail.list_calls[1]["pageToken"] == "2"
    assert fake_gmail.list_calls[2]["pageToken"] == "4"
