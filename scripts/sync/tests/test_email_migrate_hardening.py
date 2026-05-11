"""Regression tests for email-migrate.py — hardening pass.

Targets the adjacent gaps identified around five fix commits:

  e9beb23  state-file race / flock (adjacent: fd lifecycle, first-run lock file)
  c198376  Gmail dedup recovery (adjacent: pagination failure, no Message-ID, wrapped headers)
  2cf536f  JSON corruption recovery (adjacent: rotate fails, empty file, non-dict JSON)
  b42ff08  health-surface bugs (adjacent: prior marker survives crashed replace)
  d0b3ffc  self-host + health surface (adjacent: OAuth revoked / no token path)

Protocol:
  RED commit first, then minimal production-code fixes, then GREEN.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from unittest import mock

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_MIGRATE_PATH = Path(__file__).resolve().parents[1] / "email-migrate.py"


def _load_module(name: str = "email_migrate_hardening_under_test"):
    spec = importlib.util.spec_from_file_location(name, _MIGRATE_PATH)
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["email-migrate.py"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


@pytest.fixture(scope="module")
def em():
    return _load_module()


@pytest.fixture
def tmp_state_dir(tmp_path, em, monkeypatch):
    """Redirect STATE_DIR and STATE_FILE to tmp_path so tests are isolated."""
    monkeypatch.setattr(em, "STATE_DIR", tmp_path)
    monkeypatch.setattr(em, "STATE_FILE", tmp_path / "email-migration.json")
    return tmp_path


# ---------------------------------------------------------------------------
# .emlx builder (re-usable across tests)
# ---------------------------------------------------------------------------

def _make_emlx(tmp_path: Path, name: str, message_id: str | None = "test@example.com",
               body: str = "hello") -> Path:
    if message_id:
        mid_header = f"Message-ID: <{message_id}>\r\n"
    else:
        mid_header = ""
    rfc822 = (
        f"From: a@b.com\r\nTo: c@d.com\r\nSubject: test\r\n"
        f"{mid_header}"
        f"Date: Tue, 28 Apr 2026 12:00:00 +0000\r\n\r\n{body}\r\n"
    ).encode("utf-8")
    plist = (
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
        f.write(plist)
    return path


# ===========================================================================
# Bug class 1 — state-lock fd lifecycle
# ===========================================================================


class TestStateLockFdLifecycle:
    """Adjacent gaps around e9beb23 flock fix."""

    def test_lock_file_created_on_fresh_state_dir(self, em, tmp_state_dir):
        """save_state must work even when STATE_DIR is empty (first run).

        The lock sidecar `.lock` must be created automatically; an
        OSError/FileNotFoundError must NOT propagate.
        """
        state = {"folders": {}, "bytes_uploaded_today": 0,
                 "last_run_date": None, "errors": []}
        # tmp_state_dir is a fresh dir — no .lock, no .json yet
        em.save_state(state)  # must not raise

        assert (tmp_state_dir / "email-migration.json").exists()
        # Lock sidecar should also exist (created by open())
        assert (tmp_state_dir / "email-migration.lock").exists()

    def test_lock_released_when_save_raises_inside_body(self, em, tmp_state_dir, monkeypatch):
        """If json.dump raises, the flock must be released (fd closed via context manager).

        We verify by attempting a second save_state immediately after the
        first one raised. If the lock was NOT released, the second call would
        deadlock (flock LOCK_EX on an already-locked fd in the same process
        is re-entrant on Linux but NOT on macOS). Simpler: we just confirm
        the second save succeeds, proving the lock path was cleaned up.
        """
        call_count = 0
        original_dump = json.dump

        def boom_then_real(obj, fp, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise OSError("simulated disk full")
            return original_dump(obj, fp, **kwargs)

        monkeypatch.setattr(em.json, "dump", boom_then_real)

        state = {"folders": {}, "bytes_uploaded_today": 0,
                 "last_run_date": None, "errors": []}

        with pytest.raises(OSError):
            em.save_state(state)

        # Second save must succeed (no lock deadlock / dangling fd)
        em.save_state(state)
        assert (tmp_state_dir / "email-migration.json").exists()

    def test_lock_file_never_deleted_between_saves(self, em, tmp_state_dir):
        """The lock sidecar must persist across multiple save_state calls.

        If the implementation ever deletes/recreates the lock file between
        saves, two concurrent processes could both create it and both get
        LOCK_EX — defeating the guard.
        """
        state = {"folders": {}, "bytes_uploaded_today": 0,
                 "last_run_date": None, "errors": []}
        em.save_state(state)
        lock_path = tmp_state_dir / "email-migration.lock"
        assert lock_path.exists()
        inode_before = lock_path.stat().st_ino

        em.save_state(state)
        inode_after = lock_path.stat().st_ino
        assert inode_before == inode_after, (
            "lock file was deleted and re-created between saves — "
            "concurrent process could race into the window"
        )


# ===========================================================================
# Bug class 2 — load_state JSON corruption recovery
# ===========================================================================


class TestLoadStateCorruptionRecovery:
    """Adjacent gaps around 2cf536f json-corruption fix."""

    def test_empty_file_returns_fresh_state(self, em, tmp_state_dir):
        """A 0-byte state file must be treated as corrupt: return fresh state.

        A SIGKILL between truncating for write and flushing content leaves a
        0-byte file. json.load on that raises json.JSONDecodeError, so the
        existing try/except SHOULD catch it — but we pin this behaviour.
        """
        state_file = tmp_state_dir / "email-migration.json"
        state_file.write_bytes(b"")  # 0 bytes

        result = em.load_state()

        assert isinstance(result, dict), "must return a dict on empty file"
        assert "folders" in result
        assert result["folders"] == {}
        # The corrupt file must have been rotated away
        assert not state_file.exists() or state_file.read_bytes() != b"", (
            "0-byte file must be rotated aside"
        )

    def test_valid_json_null_returns_fresh_state(self, em, tmp_state_dir):
        """A state file containing `null` (valid JSON, wrong type) must
        trigger recovery, not crash AttributeError later.

        Without a type-guard, migrate_state_format() would call
        `state.get('folders', {})` on None and raise AttributeError.
        """
        state_file = tmp_state_dir / "email-migration.json"
        state_file.write_text("null")

        result = em.load_state()

        assert isinstance(result, dict), (
            "JSON null must be treated as corrupt and return fresh state dict"
        )

    def test_valid_json_list_returns_fresh_state(self, em, tmp_state_dir):
        """A state file containing `[]` (valid JSON list, wrong type) must
        trigger recovery.
        """
        state_file = tmp_state_dir / "email-migration.json"
        state_file.write_text("[]")

        result = em.load_state()

        assert isinstance(result, dict), (
            "JSON array must be treated as corrupt and return fresh state dict"
        )

    def test_rotate_failure_still_returns_fresh_state(self, em, tmp_state_dir, monkeypatch):
        """If rotating the corrupt file fails (e.g. permissions error), load_state
        must still return fresh state — the rotate failure must not propagate.

        Without this, a permissions problem on the state dir wedges the pipeline
        with an unhandled OSError on every run.
        """
        state_file = tmp_state_dir / "email-migration.json"
        state_file.write_text("{{invalid json{{")

        # Make Path.rename raise to simulate a permissions error / disk full
        original_rename = Path.rename

        def boom_rename(self, target):
            if str(self) == str(state_file):
                raise OSError("simulated rename failure")
            return original_rename(self, target)

        monkeypatch.setattr(Path, "rename", boom_rename)

        result = em.load_state()

        assert isinstance(result, dict), (
            "rotate failure must be swallowed; load_state must still return fresh state"
        )
        assert result["folders"] == {}


# ===========================================================================
# Bug class 3 — dedup seed: pagination failure + missing Message-ID
# ===========================================================================


_SENTINEL_NO_FAIL = object()  # distinct sentinel so fail_on_token=None is valid (first page)


class _PaginatedFakeGmailService:
    """Fake Gmail service that raises on a specific page token (simulates
    a mid-pagination network error or quota error).

    fail_on_token: a string page token (e.g. "2") to fail on, or
                   _SENTINEL_NO_FAIL (default) to never fail.
                   Pass None explicitly only if you want to fail on the
                   very first page (where pageToken=None).
    """

    def __init__(self, message_ids, label_name, fail_on_token=_SENTINEL_NO_FAIL):
        self._label_id_for_name = {label_name: f"Label_{label_name}"}
        self._msgs = [
            {
                "id": f"msg_{i}",
                "headers": [{"name": "Message-ID", "value": f"<{mid}>"}],
                "labelIds": [f"Label_{label_name}"],
            }
            for i, mid in enumerate(message_ids)
        ]
        self._fail_on_token = fail_on_token
        self.list_calls = []

    @property
    def label_cache(self):
        return self._label_id_for_name

    def users(self):
        return _PFGUsers(self)


class _PFGUsers:
    def __init__(self, svc):
        self._svc = svc

    def labels(self):
        return None  # not needed

    def messages(self):
        return _PFGMessages(self._svc)


class _PFGMessages:
    def __init__(self, svc):
        self._svc = svc

    def list(self, userId, labelIds=None, maxResults=None, pageToken=None):
        self._svc.list_calls.append(pageToken)
        if (self._svc._fail_on_token is not _SENTINEL_NO_FAIL
                and pageToken == self._svc._fail_on_token):
            raise Exception(f"Simulated API failure at pageToken={pageToken}")
        # Return 2 per page
        start = int(pageToken) if pageToken else 0
        page_size = 2
        end = start + page_size
        page_msgs = [{"id": m["id"]} for m in self._svc._msgs[start:end]]
        payload = {"messages": page_msgs}
        if end < len(self._svc._msgs):
            payload["nextPageToken"] = str(end)
        return _FakeReq(payload)

    def get(self, userId, id, format=None, metadataHeaders=None):
        for m in self._svc._msgs:
            if m["id"] == id:
                return _FakeReq({"id": m["id"], "payload": {"headers": m["headers"]}})
        raise KeyError(id)

    def import_(self, userId, body, **kw):
        raise RuntimeError("import_ should not be called in seed tests")


class _FakeReq:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


class TestSeedMigratedFilesAdjacentGaps:
    """Adjacent gaps around c198376 dedup recovery."""

    def test_seed_returns_partial_count_when_pagination_fails_mid_stream(
        self, em, tmp_path
    ):
        """seed_migrated_files_from_gmail should NOT raise if pagination fails
        mid-stream. It should log a warning and return however many files it
        already seeded before the error.

        Without this guard, a transient API blip during recovery causes an
        unhandled exception that aborts the whole migrate_folder call.
        """
        # 5 messages (pages of 2). Match on page 1 (msg 0). Fail on token "2" (page 2).
        e1 = _make_emlx(tmp_path, "1.emlx", "page1-match@example.com")
        fake = _PaginatedFakeGmailService(
            message_ids=[
                "page1-match@example.com",  # page 1 — will be seeded
                "page1-other@example.com",
                "page2-a@example.com",       # page 2 — fetch will fail
                "page2-b@example.com",
            ],
            label_name="Outlook/Inbox",
            fail_on_token="2",  # fail when fetching page 2
        )
        folder_state = {"migrated_files": [], "total": 1, "migrated": 0, "errors": []}

        # Must NOT raise
        seeded = em.seed_migrated_files_from_gmail(
            folder_state, "Outlook/Inbox", [e1], fake.label_cache, fake
        )

        # The match on page 1 must still be counted even though page 2 failed
        assert seeded == 1, (
            f"Expected 1 (matched before failure), got {seeded}. "
            "Pagination failure must not discard already-seeded entries."
        )
        assert "1.emlx" in folder_state["migrated_files"]

    def test_seed_skips_emlx_without_message_id(self, em, tmp_path):
        """An .emlx file with no Message-ID header must be skipped in the
        local index, not crash extract_message_id.

        An email with no Message-ID is valid (RFC 5322 only RECOMMENDS it).
        The seed function must handle it gracefully.
        """
        no_mid = _make_emlx(tmp_path, "no-mid.emlx", message_id=None)
        has_mid = _make_emlx(tmp_path, "has-mid.emlx", message_id="present@example.com")

        fake = _PaginatedFakeGmailService(
            message_ids=["present@example.com"],
            label_name="Outlook/Inbox",
        )
        folder_state = {"migrated_files": [], "total": 2, "migrated": 0, "errors": []}

        seeded = em.seed_migrated_files_from_gmail(
            folder_state, "Outlook/Inbox", [no_mid, has_mid],
            fake.label_cache, fake
        )

        # Only the one with Message-ID should be seeded
        assert seeded == 1
        assert "has-mid.emlx" in folder_state["migrated_files"]
        assert "no-mid.emlx" not in folder_state["migrated_files"]

    def test_extract_message_id_folded_header(self, em):
        """RFC 5322 allows long headers to be folded with CRLF + whitespace.

        email.message_from_bytes handles unfolding, but we pin that the
        strip() call in extract_message_id doesn't accidentally include
        the whitespace prefix from folded continuation lines.
        """
        # Folded Message-ID: value split across two lines
        rfc822 = (
            b"From: a@b.com\r\n"
            b"Message-ID: \r\n"
            b" <folded-id@example.com>\r\n"
            b"Subject: t\r\n\r\nbody"
        )
        result = em.extract_message_id(rfc822)
        # After unfolding and strip(), result should be the clean ID
        assert result is not None, "folded Message-ID must not return None"
        assert "folded-id@example.com" in result, (
            f"folded Message-ID not extracted correctly: {result!r}"
        )

    def test_extract_message_id_case_insensitive_header_name(self, em):
        """Header lookup must be case-insensitive (already has .get variants,
        but pin the behaviour for 'message-id' lowercase).
        """
        rfc822 = b"From: x\r\nmessage-id: <lower@example.com>\r\n\r\nbody"
        result = em.extract_message_id(rfc822)
        assert result is not None
        assert "lower@example.com" in result


# ===========================================================================
# Bug class 4 — health-surface: prior marker survives crashed replace
# ===========================================================================


class TestMarkerPriorValueSurvivesCrashedReplace:
    """Adjacent gap around b42ff08 atomic-write fix.

    The existing test (test_partial_write_recoverable) checks that a crash
    leaves no canonical file. But if a canonical file ALREADY EXISTS from a
    prior successful run, a crash mid-replace must leave that prior file
    INTACT (not truncated/corrupted).
    """

    def test_prior_marker_intact_when_replace_crashes(
        self, em, tmp_state_dir, monkeypatch
    ):
        """If os.replace raises during write_success_marker, the EXISTING
        last-success.json must not be modified.

        Without atomic write the code would:
          open(marker, 'w') → truncate to 0
          write payload → SIGKILL  (prior content gone, 0-byte file remains)

        With atomic write (write to .tmp, os.replace), the prior file is
        untouched.
        """
        # Write a "prior" marker
        success_file = tmp_state_dir / "last-success.json"
        prior_payload = {
            "timestamp": 1000000.0,
            "iso": "2026-01-01T00:00:00",
            "bytes_uploaded_today": 999,
            "bytes_session": 100,
            "errors_session": 0,
        }
        success_file.write_text(json.dumps(prior_payload))

        # Now simulate a crash during os.replace
        def boom(src, dst):
            raise OSError("simulated crash during replace")

        monkeypatch.setattr(em.os, "replace", boom)

        state = {"bytes_uploaded_today": 500, "folders": {}}
        with pytest.raises(OSError):
            em.write_success_marker(state, bytes_at_start=0, errors_at_start=0)

        # Prior marker must still be intact
        assert success_file.exists(), "prior marker must survive a crashed replace"
        surviving = json.loads(success_file.read_text())
        assert surviving["bytes_uploaded_today"] == 999, (
            f"Prior marker was modified by crashed replace. Got: {surviving}"
        )


# ===========================================================================
# Bug class 5 — OAuth revoked / no token path
# ===========================================================================


class TestOAuthRevoked:
    """Adjacent gap around d0b3ffc: what happens when no token file exists?

    load_gmail_api_credentials() calls sys.exit(1) when no token is found.
    We pin this — it must exit with a non-zero code, not raise an unhandled
    exception, and must NOT silently succeed (which would allow an empty
    credentials object to be returned).
    """

    def test_load_credentials_exits_when_no_token_file(self, em, monkeypatch):
        """If none of the token file paths exist, must call sys.exit(1)."""
        # Redirect GMAIL_USER to a non-existent user so token files won't exist
        monkeypatch.setattr(em, "GMAIL_USER", "nonexistent-user@example.com")

        with pytest.raises(SystemExit) as exc_info:
            em.load_gmail_api_credentials()

        assert exc_info.value.code != 0, (
            "load_gmail_api_credentials must exit non-zero when no token found, "
            f"got code {exc_info.value.code}"
        )

    def test_load_credentials_exit_code_is_1(self, em, monkeypatch, tmp_path):
        """Specifically exit code 1 (not 2 or any other)."""
        monkeypatch.setattr(em, "GMAIL_USER", "nobody@nowhere.example")

        with pytest.raises(SystemExit) as exc_info:
            em.load_gmail_api_credentials()

        assert exc_info.value.code == 1
