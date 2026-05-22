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
    # Register before exec_module: @dataclass under `from __future__ import
    # annotations` resolves string field annotations via
    # sys.modules[cls.__module__]; without registration that lookup crashes.
    sys.modules["backfill_under_test"] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


@pytest.fixture
def bf():
    mod = _load_backfill()
    # repair_one reaches em.SIZE_CAP_ERROR_MARKER and em.GmailLimitReached;
    # in unit tests email-migrate.py is never loaded, so seed the module
    # handle with a stub carrying the same marker value the real module
    # defines and the GmailLimitReached type the fake uploader raises.
    import types as _types
    if getattr(mod, "em", None) is None:
        mod.em = _types.SimpleNamespace(
            SIZE_CAP_ERROR_MARKER="too large for Gmail import",
            GmailLimitReached=_FakeUploader._GmailLimitReached)
    return mod


class TestStripMessageId:
    def test_strips_angle_brackets(self, bf):
        assert bf.strip_message_id("<abc@penn.edu>") == "abc@penn.edu"

    def test_leaves_bare_id_untouched(self, bf):
        assert bf.strip_message_id("abc@penn.edu") == "abc@penn.edu"

    def test_strips_whitespace_and_brackets(self, bf):
        assert bf.strip_message_id("  <abc@penn.edu>  ") == "abc@penn.edu"

    def test_none_returns_none(self, bf):
        assert bf.strip_message_id(None) is None

    def test_empty_string_returns_empty(self, bf):
        assert bf.strip_message_id("") == ""

    def test_double_brackets_strips_only_one_pair(self, bf):
        # Malformed input: only ONE surrounding pair is stripped
        assert bf.strip_message_id("<<abc@penn.edu>>") == "<abc@penn.edu>"


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

    def test_zero_byte_attachment_with_attachmentid_counts(self, bf):
        # A genuine zero-byte attachment (empty file) has attachmentId but size 0.
        # It IS a real attachment — must not be mis-classified as body-only.
        msg = {
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    {"mimeType": "text/plain", "filename": "empty.txt",
                     "body": {"size": 0, "attachmentId": "z"}},
                ],
            }
        }
        assert bf.message_has_attachments(msg) is True

    def test_parts_explicitly_none_is_handled(self, bf):
        msg = {"payload": {"mimeType": "multipart/mixed", "parts": None}}
        assert bf.message_has_attachments(msg) is False

    def test_non_multipart_leaf_payload_with_attachment(self, bf):
        # A message whose payload IS the attachment part (no nested parts)
        msg = {
            "payload": {
                "mimeType": "application/pdf", "filename": "scan.pdf",
                "body": {"size": 9000, "attachmentId": "a"},
            }
        }
        assert bf.message_has_attachments(msg) is True


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

    def test_basename_collision_raises(self, bf):
        # Two distinct full paths sharing a basename within one folder must
        # raise — silently dropping one would corrupt path resolution.
        class FakeEm:
            @staticmethod
            def discover_folders():
                return [
                    ("Inbox", object(), [
                        Path("/mail/Inbox.mbox/UUID/Data/0/Messages/1.emlx"),
                        Path("/mail/Inbox.mbox/UUID/Data/1/Messages/1.emlx"),
                    ]),
                ]
        import pytest
        with pytest.raises(ValueError, match="basename collision"):
            bf.build_emlx_index(FakeEm())


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
        self.list_calls = []

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
        self._svc.list_calls.append({
            "q": q, "labelIds": labelIds, "includeSpamTrash": includeSpamTrash,
            "maxResults": maxResults,
        })
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


# SIZE_CAP_ERROR_MARKER value from email-migrate.py — duplicated here as a
# test literal so the fake uploader can produce a realistic oversize error.
_SIZE_CAP_MARKER = "too large for Gmail import"


class _FakeUploader:
    """Stand-in for email-migrate.py's GmailApiUploader.

    Implements just the surface backfill-attachments.py uses:
      - upload_message(service, label_id, eml_content, is_read)
          -> (bytes, error_or_None); may raise GmailLimitReached
      - _ensure_label(name) -> a label id

    Constructor flags drive the upload_message outcome:
      - raise_limit: raise GmailLimitReached on upload_message
      - size_cap:    return (0, "<...SIZE_CAP_MARKER...>")
      - import_error: return (0, "<some other error>")
      - else:        return (len(eml_content), None)  [success]
    """

    class _GmailLimitReached(Exception):
        """Stand-in for email-migrate.py's GmailLimitReached.

        The bf fixture seeds bf.em.GmailLimitReached with this same type so
        repair_one's `except em.GmailLimitReached` matches what the fake
        uploader raises.
        """
        pass

    def __init__(self, *, raise_limit=False, size_cap=False,
                 import_error=False):
        self.raise_limit = raise_limit
        self.size_cap = size_cap
        self.import_error = import_error
        self.upload_calls = []

    def _ensure_label(self, name):
        return "Label_for_" + name

    def upload_message(self, service, label_id, eml_content, is_read):
        self.upload_calls.append({
            "label_id": label_id, "eml_content": eml_content,
            "is_read": is_read,
        })
        if self.raise_limit:
            raise _FakeUploader._GmailLimitReached("Gmail API quota exceeded")
        if self.size_cap:
            return 0, (f"message {_SIZE_CAP_MARKER} "
                       f"(decoded size 99999999 exceeds 52428800)")
        if self.import_error:
            return 0, "max retries exceeded"
        return len(eml_content), None


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

    def test_passes_label_query_and_trash_exclusion_to_list(self, bf):
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={"m1": {"id": "m1", "payload": {}}},
        )
        bf.find_gmail_copies(svc, "Label_5", "abc@penn.edu")
        assert len(svc.list_calls) == 1
        call = svc.list_calls[0]
        assert call["q"] == "rfc822msgid:abc@penn.edu"
        assert call["labelIds"] == ["Label_5"]
        assert call["includeSpamTrash"] is False


class TestClassify:
    def _bodyonly(self, mid):
        return {"id": mid, "payload": {"mimeType": "multipart/alternative",
                "parts": [{"mimeType": "text/plain", "filename": "", "body": {"size": 50}}]}}

    def _withattach(self, mid):
        return {"id": mid, "payload": {"mimeType": "multipart/mixed", "parts": [
            {"mimeType": "text/plain", "filename": "", "body": {"size": 50}},
            {"mimeType": "application/pdf", "filename": "x.pdf",
             "body": {"size": 9000, "attachmentId": "a"}},
        ]}}

    def test_zero_copies_is_missing(self, bf):
        assert bf.classify([]) == "MISSING"

    def test_single_bodyonly_copy_is_would_repair(self, bf):
        copies = [self._bodyonly("m1")]
        assert bf.classify(copies) == "WOULD_REPAIR"

    def test_single_copy_with_attachments_is_already_done(self, bf):
        copies = [self._withattach("m1")]
        assert bf.classify(copies) == "ALREADY_DONE"

    def test_two_copies_one_bodyonly_one_attach_is_trash_only(self, bf):
        # Re-run after import-succeeded-trash-failed: clean up the duplicate
        copies = [self._bodyonly("m1"), self._withattach("m2")]
        assert bf.classify(copies) == "WOULD_REPAIR_TRASH_ONLY"

    def test_two_bodyonly_copies_is_ambiguous(self, bf):
        copies = [self._bodyonly("m1"), self._bodyonly("m2")]
        assert bf.classify(copies) == "AMBIGUOUS"

    def test_two_copies_both_with_attachments_is_already_done(self, bf):
        copies = [self._withattach("m1"), self._withattach("m2")]
        assert bf.classify(copies) == "ALREADY_DONE"

    def test_two_bodyonly_plus_attach_is_ambiguous(self, bf):
        # 2+ body-only copies are AMBIGUOUS even when an attachment-bearing
        # copy is also present — the attachment copy does not tell us which
        # body-only copy to trash.
        copies = [self._bodyonly("m1"), self._bodyonly("m2"),
                  self._withattach("m3")]
        assert bf.classify(copies) == "AMBIGUOUS"


def _withattach(mid):
    """A Gmail full-message resource that carries a real attachment part."""
    return {"id": mid, "payload": {"mimeType": "multipart/mixed", "parts": [
        {"mimeType": "application/pdf", "filename": "x.pdf",
         "body": {"size": 9000, "attachmentId": "a"}},
    ]}}


def _bodyonly_resource(mid):
    """A Gmail full-message resource with no attachment parts."""
    return {"id": mid, "payload": {"mimeType": "text/plain"}}


# rfc822 bytes carrying a Message-ID — repair_one's re-query verify extracts
# the bare id from these bytes via _rfc822_message_id + strip_message_id.
_REINFLATED_WITH_MID = (
    b"Message-ID: <repaired@penn.edu>\r\n"
    b"Subject: test\r\n\r\nbody bytes\r\n"
)
_BARE_MID = "repaired@penn.edu"


class TestRepairOne:
    def _bodyonly(self, mid, labels=None):
        return {"id": mid, "labelIds": labels or ["Label_5", "UNREAD"],
                "payload": {"mimeType": "text/plain"}}

    def test_import_then_verify_then_trash_on_happy_path(self, bf):
        # upload_message succeeds; verify re-query finds an attachment-bearing
        # copy on the label -> the old body-only copy is trashed.
        svc = _FakeGmailService(
            list_returns={f"rfc822msgid:{_BARE_MID}": [{"id": "new-id"}]},
            get_returns={"new-id": _withattach("new-id")},
        )
        uploader = _FakeUploader()
        old = self._bodyonly("old-id", labels=["Label_5", "STARRED", "UNREAD"])
        outcome = bf.repair_one(
            uploader, svc, label_id="Label_5",
            reinflated_bytes=_REINFLATED_WITH_MID, old_message=old,
        )
        assert outcome == "REPAIRED"
        # upload_message was called once with a SINGLE label_id + is_read=True
        assert len(uploader.upload_calls) == 1
        assert uploader.upload_calls[0]["label_id"] == "Label_5"
        assert uploader.upload_calls[0]["is_read"] is True
        # old copy was trashed AFTER import + verify
        assert svc.trash_calls == ["old-id"]

    def test_import_failure_does_not_trash(self, bf):
        # _import_raises hook -> old copy must NOT be trashed
        svc = _FakeGmailService()
        outcome = bf.repair_one(
            _FakeUploader(), svc, label_id="Label_5",
            reinflated_bytes=_REINFLATED_WITH_MID,
            old_message=self._bodyonly("old-id"),
            _import_raises=RuntimeError("import 413"),
        )
        assert outcome == "IMPORT_FAILED"
        assert svc.trash_calls == []  # CRITICAL: old copy untouched

    def test_upload_message_error_returns_import_failed(self, bf):
        # upload_message returns (0, error) for a non-size-cap error.
        svc = _FakeGmailService()
        outcome = bf.repair_one(
            _FakeUploader(import_error=True), svc, label_id="Label_5",
            reinflated_bytes=_REINFLATED_WITH_MID,
            old_message=self._bodyonly("old-id"),
        )
        assert outcome == "IMPORT_FAILED"
        assert svc.trash_calls == []  # CRITICAL: old copy untouched

    def test_upload_message_size_cap_returns_skip_too_large(self, bf):
        # upload_message returns (0, "<...too large...>") -> SKIP_TOO_LARGE.
        svc = _FakeGmailService()
        outcome = bf.repair_one(
            _FakeUploader(size_cap=True), svc, label_id="Label_5",
            reinflated_bytes=_REINFLATED_WITH_MID,
            old_message=self._bodyonly("old-id"),
        )
        assert outcome == "SKIP_TOO_LARGE"
        assert svc.trash_calls == []  # CRITICAL: old copy untouched

    def test_quota_error_propagates_not_swallowed(self, bf):
        # upload_message raising GmailLimitReached must propagate out of
        # repair_one (the clean-stop path), NOT be caught here.
        svc = _FakeGmailService()
        with pytest.raises(_FakeUploader._GmailLimitReached):
            bf.repair_one(
                _FakeUploader(raise_limit=True), svc, label_id="Label_5",
                reinflated_bytes=_REINFLATED_WITH_MID,
                old_message=self._bodyonly("old-id"),
            )
        assert svc.trash_calls == []  # CRITICAL: old copy untouched

    def test_verify_finds_no_attachment_copy_does_not_trash(self, bf):
        # upload_message succeeds, but the verify re-query finds only a
        # body-only copy -> IMPORT_FAILED, old copy untouched.
        svc = _FakeGmailService(
            list_returns={f"rfc822msgid:{_BARE_MID}": [{"id": "new-id"}]},
            get_returns={"new-id": _bodyonly_resource("new-id")},
        )
        outcome = bf.repair_one(
            _FakeUploader(), svc, label_id="Label_5",
            reinflated_bytes=_REINFLATED_WITH_MID,
            old_message=self._bodyonly("old-id"),
        )
        assert outcome == "IMPORT_FAILED"
        assert svc.trash_calls == []  # CRITICAL: old copy untouched

    def test_verify_query_returns_nothing_does_not_trash(self, bf):
        # upload_message succeeds but the verify re-query returns no copies
        # at all -> IMPORT_FAILED, old copy untouched.
        svc = _FakeGmailService(list_returns={})
        outcome = bf.repair_one(
            _FakeUploader(), svc, label_id="Label_5",
            reinflated_bytes=_REINFLATED_WITH_MID,
            old_message=self._bodyonly("old-id"),
        )
        assert outcome == "IMPORT_FAILED"
        assert svc.trash_calls == []  # CRITICAL: old copy untouched

    def test_trash_failure_after_verified_import(self, bf):
        # upload_message + verify succeed, but trash raises ->
        # REPAIRED_TRASH_FAILED, exception NOT propagated.
        svc = _FakeGmailService(
            list_returns={f"rfc822msgid:{_BARE_MID}": [{"id": "new-id"}]},
            get_returns={"new-id": _withattach("new-id")},
        )
        import types
        real_messages = svc.users().messages()

        class _TrashFailsMessages:
            def __init__(self, real):
                self._real = real
            def list(self, *a, **kw):
                return self._real.list(*a, **kw)
            def get(self, *a, **kw):
                return self._real.get(*a, **kw)
            def trash(self, userId, id):
                class _R:
                    def execute(self_inner):
                        raise RuntimeError("trash 429")
                return _R()

        svc.users = lambda: types.SimpleNamespace(
            messages=lambda: _TrashFailsMessages(real_messages))

        outcome = bf.repair_one(
            _FakeUploader(), svc, label_id="Label_5",
            reinflated_bytes=_REINFLATED_WITH_MID,
            old_message=self._bodyonly("old-id"),
        )
        assert outcome == "REPAIRED_TRASH_FAILED"


class TestTrashOnly:
    def test_trash_only_trashes_the_body_only_copy(self, bf):
        svc = _FakeGmailService()
        body_only = {"id": "dup-id", "payload": {"mimeType": "text/plain"}}
        outcome = bf.trash_only(svc, body_only)
        assert outcome == "REPAIRED"
        assert svc.trash_calls == ["dup-id"]

    def test_trash_only_reports_failure_without_raising(self, bf):
        # A trash failure means "attachment copy exists, body-only copy not
        # yet trashed" — REPAIRED_TRASH_FAILED, not IMPORT_FAILED (no import
        # happened here).
        import types

        class _RaisingMessages:
            def trash(self, userId, id):
                class _R:
                    def execute(self_inner):
                        raise RuntimeError("trash 500")
                return _R()

        svc = _FakeGmailService()
        svc.users = lambda: types.SimpleNamespace(
            messages=lambda: _RaisingMessages())
        outcome = bf.trash_only(svc, {"id": "x"})
        assert outcome == "REPAIRED_TRASH_FAILED"


class TestRunBackfill:
    def test_dry_run_makes_no_import_or_trash_calls(self, bf):
        """Dry-run (execute=False) classifies and counts but never mutates."""
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={"m1": {"id": "m1", "payload": {"mimeType": "text/plain"}}},
        )
        uploader = _FakeUploader()
        candidates = [
            bf.Candidate(folder="Inbox", basename="101.partial.emlx",
                         label_id="Label_5", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(uploader, svc, candidates, execute=False,
                                 rate_limit_s=0)
        assert counts["WOULD_REPAIR"] == 1
        assert uploader.upload_calls == []
        assert svc.trash_calls == []

    def test_skip_no_attachments_candidate_counted_and_not_queried(self, bf):
        svc = _FakeGmailService()
        candidates = [
            bf.Candidate(folder="Inbox", basename="1.partial.emlx",
                         label_id="L", bare_mid="x@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=False),
        ]
        counts = bf.run_backfill(_FakeUploader(), svc, candidates,
                                 execute=True, rate_limit_s=0)
        assert counts["SKIP_NO_ATTACHMENTS"] == 1
        # no Gmail query made for a no-attachment candidate
        assert svc.list_calls == []

    def test_execute_repairs_would_repair_candidate(self, bf):
        # The candidate's reinflated_bytes carry a Message-ID; repair_one's
        # verify re-query (rfc822msgid:repaired@penn.edu) finds the new copy.
        svc = _FakeGmailService(
            list_returns={
                "rfc822msgid:abc@penn.edu": [{"id": "m1"}],
                f"rfc822msgid:{_BARE_MID}": [{"id": "new-id"}],
            },
            get_returns={
                "m1": {"id": "m1", "labelIds": ["Label_5"],
                       "payload": {"mimeType": "text/plain"}},
                "new-id": _withattach("new-id"),
            },
        )
        uploader = _FakeUploader()
        candidates = [
            bf.Candidate(folder="Inbox", basename="101.partial.emlx",
                         label_id="Label_5", bare_mid="abc@penn.edu",
                         reinflated_bytes=_REINFLATED_WITH_MID,
                         reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(uploader, svc, candidates, execute=True,
                                 rate_limit_s=0)
        assert counts["WOULD_REPAIR"] == 1
        assert len(uploader.upload_calls) == 1
        assert svc.trash_calls == ["m1"]

    def test_missing_candidate_bucketed(self, bf):
        svc = _FakeGmailService(list_returns={})  # no Gmail match
        candidates = [
            bf.Candidate(folder="Inbox", basename="9.partial.emlx",
                         label_id="L", bare_mid="gone@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        uploader = _FakeUploader()
        counts = bf.run_backfill(uploader, svc, candidates, execute=True,
                                 rate_limit_s=0)
        assert counts["MISSING"] == 1
        assert uploader.upload_calls == []
        assert svc.trash_calls == []

    def test_import_failed_increments_only_import_failed_bucket(self, bf, monkeypatch):
        # A WOULD_REPAIR candidate whose repair_one fails: IMPORT_FAILED++,
        # WOULD_REPAIR stays 0.
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={"m1": {"id": "m1", "labelIds": ["L"],
                                "payload": {"mimeType": "text/plain"}}},
        )
        monkeypatch.setattr(bf, "repair_one",
                            lambda *a, **kw: "IMPORT_FAILED")
        candidates = [
            bf.Candidate(folder="Inbox", basename="1.partial.emlx",
                         label_id="L", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(_FakeUploader(), svc, candidates,
                                 execute=True, rate_limit_s=0)
        assert counts["IMPORT_FAILED"] == 1
        assert counts["WOULD_REPAIR"] == 0

    def test_skip_too_large_outcome_bucketed(self, bf, monkeypatch):
        # repair_one returning SKIP_TOO_LARGE lands in the SKIP_TOO_LARGE
        # bucket — WOULD_REPAIR stays 0.
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={"m1": {"id": "m1", "labelIds": ["L"],
                                "payload": {"mimeType": "text/plain"}}},
        )
        monkeypatch.setattr(bf, "repair_one",
                            lambda *a, **kw: "SKIP_TOO_LARGE")
        candidates = [
            bf.Candidate(folder="Inbox", basename="1.partial.emlx",
                         label_id="L", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(_FakeUploader(), svc, candidates,
                                 execute=True, rate_limit_s=0)
        assert counts["SKIP_TOO_LARGE"] == 1
        assert counts["WOULD_REPAIR"] == 0

    def test_quota_error_propagates_out_of_run_backfill(self, bf):
        # A real upload_message raising GmailLimitReached must propagate out
        # of run_backfill so main's clean-stop handler is reachable.
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={"m1": {"id": "m1", "labelIds": ["L"],
                                "payload": {"mimeType": "text/plain"}}},
        )
        uploader = _FakeUploader(raise_limit=True)
        candidates = [
            bf.Candidate(folder="Inbox", basename="1.partial.emlx",
                         label_id="L", bare_mid="abc@penn.edu",
                         reinflated_bytes=_REINFLATED_WITH_MID,
                         reinflated_has_attachments=True),
        ]
        with pytest.raises(_FakeUploader._GmailLimitReached):
            bf.run_backfill(uploader, svc, candidates, execute=True,
                            rate_limit_s=0)

    def test_repaired_trash_failed_double_counts(self, bf, monkeypatch):
        # repair_one returning REPAIRED_TRASH_FAILED increments BOTH the
        # WOULD_REPAIR bucket and the REPAIRED_TRASH_FAILED bucket.
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={"m1": {"id": "m1", "labelIds": ["L"],
                                "payload": {"mimeType": "text/plain"}}},
        )
        monkeypatch.setattr(bf, "repair_one",
                            lambda *a, **kw: "REPAIRED_TRASH_FAILED")
        candidates = [
            bf.Candidate(folder="Inbox", basename="1.partial.emlx",
                         label_id="L", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(_FakeUploader(), svc, candidates,
                                 execute=True, rate_limit_s=0)
        assert counts["WOULD_REPAIR"] == 1
        assert counts["REPAIRED_TRASH_FAILED"] == 1

    def test_trash_only_trash_failed_double_counts(self, bf, monkeypatch):
        # trash_only returning REPAIRED_TRASH_FAILED is counted the same way
        # as repair_one returning it: the WOULD_REPAIR_TRASH_ONLY bucket AND
        # the REPAIRED_TRASH_FAILED bucket both increment.
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}, {"id": "m2"}]},
            get_returns={
                "m1": {"id": "m1", "payload": {"mimeType": "text/plain"}},
                "m2": _withattach("m2"),
            },
        )
        monkeypatch.setattr(bf, "trash_only",
                            lambda *a, **kw: "REPAIRED_TRASH_FAILED")
        candidates = [
            bf.Candidate(folder="Inbox", basename="1.partial.emlx",
                         label_id="L", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(_FakeUploader(), svc, candidates,
                                 execute=True, rate_limit_s=0)
        assert counts["WOULD_REPAIR_TRASH_ONLY"] == 1
        assert counts["REPAIRED_TRASH_FAILED"] == 1

    def test_would_repair_trash_only_routed_through_run_backfill(self, bf):
        # A candidate whose Gmail state is 1 body-only + 1 attachment-bearing
        # copy classifies WOULD_REPAIR_TRASH_ONLY; run_backfill calls
        # trash_only and counts the bucket on REPAIRED.
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}, {"id": "m2"}]},
            get_returns={
                "m1": {"id": "m1", "payload": {"mimeType": "text/plain"}},
                "m2": {"id": "m2", "payload": {"mimeType": "multipart/mixed",
                       "parts": [{"mimeType": "application/pdf",
                                  "filename": "x.pdf",
                                  "body": {"size": 9000, "attachmentId": "a"}}]}},
            },
        )
        candidates = [
            bf.Candidate(folder="Inbox", basename="1.partial.emlx",
                         label_id="L", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        uploader = _FakeUploader()
        counts = bf.run_backfill(uploader, svc, candidates, execute=True,
                                 rate_limit_s=0)
        assert counts["WOULD_REPAIR_TRASH_ONLY"] == 1
        # trash_only was used: the body-only copy m1 was trashed, no upload
        assert svc.trash_calls == ["m1"]
        assert uploader.upload_calls == []

    def test_execute_mode_already_done_and_ambiguous_pass_through(self, bf):
        # ALREADY_DONE and AMBIGUOUS are counted via the early-continue
        # branch in execute mode — no import, no trash.
        attach_part = {"mimeType": "application/pdf", "filename": "x.pdf",
                       "body": {"size": 9000, "attachmentId": "a"}}
        svc = _FakeGmailService(
            list_returns={
                "rfc822msgid:done@y": [{"id": "d1"}],
                "rfc822msgid:ambig@y": [{"id": "a1"}, {"id": "a2"}],
            },
            get_returns={
                "d1": {"id": "d1", "payload": {"mimeType": "multipart/mixed",
                       "parts": [attach_part]}},
                "a1": {"id": "a1", "payload": {"mimeType": "text/plain"}},
                "a2": {"id": "a2", "payload": {"mimeType": "text/plain"}},
            },
        )
        candidates = [
            bf.Candidate(folder="Inbox", basename="d.partial.emlx",
                         label_id="L", bare_mid="done@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
            bf.Candidate(folder="Inbox", basename="a.partial.emlx",
                         label_id="L", bare_mid="ambig@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        uploader = _FakeUploader()
        counts = bf.run_backfill(uploader, svc, candidates, execute=True,
                                 rate_limit_s=0)
        assert counts["ALREADY_DONE"] == 1
        assert counts["AMBIGUOUS"] == 1
        assert uploader.upload_calls == []
        assert svc.trash_calls == []

    def test_multi_bucket_end_to_end_bucket_sum_equals_candidate_count(
            self, bf, monkeypatch):
        # Drive a realistic mix through run_backfill in execute mode and
        # assert each bucket count plus that the total across all buckets
        # equals the candidate count. repair_one is monkeypatched per-call
        # so each WOULD_REPAIR candidate lands in a chosen outcome.
        attach_part = {"mimeType": "application/pdf", "filename": "x.pdf",
                       "body": {"size": 9000, "attachmentId": "a"}}
        body_only = {"mimeType": "text/plain"}
        svc = _FakeGmailService(
            list_returns={
                # three single-body-only copies -> WOULD_REPAIR
                "rfc822msgid:repair-ok@y": [{"id": "r1"}],
                "rfc822msgid:repair-big@y": [{"id": "r2"}],
                "rfc822msgid:repair-fail@y": [{"id": "r3"}],
                # one already-done
                "rfc822msgid:done@y": [{"id": "d1"}],
                # 'missing@y' deliberately absent -> MISSING
            },
            get_returns={
                "r1": {"id": "r1", "labelIds": ["L"], "payload": body_only},
                "r2": {"id": "r2", "labelIds": ["L"], "payload": body_only},
                "r3": {"id": "r3", "labelIds": ["L"], "payload": body_only},
                "d1": {"id": "d1", "payload": {"mimeType": "multipart/mixed",
                       "parts": [attach_part]}},
            },
        )
        # Map each WOULD_REPAIR candidate's bare_mid to a repair_one outcome.
        outcome_by_mid = {
            "repair-ok@y": "REPAIRED",
            "repair-big@y": "SKIP_TOO_LARGE",
            "repair-fail@y": "IMPORT_FAILED",
        }

        def fake_repair_one(uploader, service, label_id, reinflated_bytes,
                            old_message, _import_raises=None):
            mid = old_message["id"]
            mid_to_outcome = {"r1": "REPAIRED", "r2": "SKIP_TOO_LARGE",
                              "r3": "IMPORT_FAILED"}
            return mid_to_outcome[mid]

        monkeypatch.setattr(bf, "repair_one", fake_repair_one)

        candidates = [
            bf.Candidate(folder="Inbox", basename="1.partial.emlx",
                         label_id="L", bare_mid="repair-ok@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
            bf.Candidate(folder="Inbox", basename="2.partial.emlx",
                         label_id="L", bare_mid="repair-big@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
            bf.Candidate(folder="Inbox", basename="3.partial.emlx",
                         label_id="L", bare_mid="repair-fail@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
            bf.Candidate(folder="Inbox", basename="4.partial.emlx",
                         label_id="L", bare_mid="done@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
            bf.Candidate(folder="Inbox", basename="5.partial.emlx",
                         label_id="L", bare_mid="missing@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
            bf.Candidate(folder="Inbox", basename="6.partial.emlx",
                         label_id="L", bare_mid="noattach@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=False),
        ]
        counts = bf.run_backfill(_FakeUploader(), svc, candidates,
                                 execute=True, rate_limit_s=0)
        assert counts["WOULD_REPAIR"] == 1        # repair-ok -> REPAIRED
        assert counts["SKIP_TOO_LARGE"] == 1      # repair-big
        assert counts["IMPORT_FAILED"] == 1       # repair-fail
        assert counts["ALREADY_DONE"] == 1        # done@y
        assert counts["MISSING"] == 1             # missing@y
        assert counts["SKIP_NO_ATTACHMENTS"] == 1 # noattach@y
        # Every candidate is accounted for in exactly one bucket here (no
        # REPAIRED_TRASH_FAILED double-count in this mix).
        assert sum(counts.values()) == len(candidates)


class TestMain:
    def test_main_returns_1_when_module_load_raises_systemexit(
            self, bf, monkeypatch):
        # _load_migrate_module raising SystemExit (missing Gmail token) is
        # the simple-to-exercise failure path: main must catch it, log, and
        # return 1 cleanly rather than propagating SystemExit.
        def _boom():
            raise SystemExit(1)
        monkeypatch.setattr(bf, "_load_migrate_module", _boom)
        monkeypatch.setattr(sys, "argv", ["backfill-attachments.py"])
        assert bf.main() == 1

    def test_main_dry_run_end_to_end_returns_0(self, bf, monkeypatch):
        # Wire fakes for the whole dry-run path: a fake em module, fake
        # credentials/uploader, and fake state so main() runs end-to-end
        # without touching Gmail or Mac Mail, and returns 0.
        import types

        fake_uploader = _FakeUploader()

        class _FakeEm:
            GmailLimitReached = _FakeUploader._GmailLimitReached

            @staticmethod
            def load_gmail_api_credentials():
                return object()

            @staticmethod
            def GmailApiUploader(creds):
                # main reads uploader._admin_service
                fake_uploader._admin_service = _FakeGmailService()
                return fake_uploader

            @staticmethod
            def load_state():
                return {"folders": {}}

            @staticmethod
            def discover_folders():
                return []

            @staticmethod
            def folder_to_label(folder):
                return "Outlook/" + folder

            @staticmethod
            def parse_emlx(path):
                return None

        monkeypatch.setattr(bf, "_load_migrate_module", lambda: _FakeEm())
        monkeypatch.setattr(sys, "argv", ["backfill-attachments.py"])
        assert bf.main() == 0


class TestBuildCandidates:
    def test_skips_non_partial_emlx(self, bf, tmp_path):
        """Only .partial.emlx files become candidates; full .emlx skipped."""
        class FakeEm:
            @staticmethod
            def folder_to_label(folder):
                return "Outlook/" + folder
            @staticmethod
            def parse_emlx(path):
                rfc = (b"Message-ID: <m@penn.edu>\r\n"
                       b'Content-Type: multipart/mixed; boundary="b"\r\n\r\n'
                       b"--b\r\nContent-Disposition: attachment; filename=x.pdf\r\n"
                       b"Content-Transfer-Encoding: base64\r\n\r\n"
                       b"ZGF0YQ==\r\n--b--\r\n")
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

    def test_basename_in_ledger_but_not_on_disk_is_skipped(self, bf, tmp_path):
        class FakeEm:
            @staticmethod
            def folder_to_label(folder): return "Outlook/" + folder
            @staticmethod
            def parse_emlx(path):
                return (b"Message-ID: <m@penn.edu>\r\n\r\nbody\r\n", True, 0)

        class FakeUploader:
            def _ensure_label(self, name): return "L"

        # ledger lists a .partial.emlx the disk index does not contain
        emlx_index = {"Inbox": {}}
        state = {"folders": {"Inbox": {"migrated_files": ["ghost.partial.emlx"]}}}
        cands = bf.build_candidates(FakeEm(), emlx_index, state,
                                    FakeUploader(), folder_filter=None)
        assert cands == []

    def test_default_scope_excludes_archive_and_sent(self, bf, tmp_path):
        # With folder_filter=None, only Inbox + Inbox/PennWide are scanned;
        # Archive and Sent Items partials must NOT become candidates.
        class FakeEm:
            @staticmethod
            def folder_to_label(folder): return "Outlook/" + folder
            @staticmethod
            def parse_emlx(path):
                return (b"Message-ID: <m@penn.edu>\r\n\r\nbody\r\n", True, 0)

        class FakeUploader:
            def _ensure_label(self, name): return "L"

        emlx_index = {
            "Inbox": {"1.partial.emlx": tmp_path / "1.partial.emlx"},
            "Inbox/PennWide": {"2.partial.emlx": tmp_path / "2.partial.emlx"},
            "Archive": {"3.partial.emlx": tmp_path / "3.partial.emlx"},
            "Sent Items": {"4.partial.emlx": tmp_path / "4.partial.emlx"},
        }
        state = {"folders": {
            "Inbox": {"migrated_files": ["1.partial.emlx"]},
            "Inbox/PennWide": {"migrated_files": ["2.partial.emlx"]},
            "Archive": {"migrated_files": ["3.partial.emlx"]},
            "Sent Items": {"migrated_files": ["4.partial.emlx"]},
        }}
        cands = bf.build_candidates(FakeEm(), emlx_index, state,
                                    FakeUploader(), folder_filter=None)
        assert {c.folder for c in cands} == {"Inbox", "Inbox/PennWide"}

    def test_folder_filter_can_target_an_out_of_scope_folder(self, bf, tmp_path):
        # --folder Archive explicitly targets a normally-out-of-scope folder.
        class FakeEm:
            @staticmethod
            def folder_to_label(folder): return "Outlook/" + folder
            @staticmethod
            def parse_emlx(path):
                return (b"Message-ID: <m@penn.edu>\r\n\r\nbody\r\n", True, 0)

        class FakeUploader:
            def _ensure_label(self, name): return "L"

        emlx_index = {
            "Inbox": {"1.partial.emlx": tmp_path / "1.partial.emlx"},
            "Archive": {"3.partial.emlx": tmp_path / "3.partial.emlx"},
        }
        state = {"folders": {
            "Inbox": {"migrated_files": ["1.partial.emlx"]},
            "Archive": {"migrated_files": ["3.partial.emlx"]},
        }}
        cands = bf.build_candidates(FakeEm(), emlx_index, state,
                                    FakeUploader(), folder_filter="Archive")
        assert {c.folder for c in cands} == {"Archive"}

    def test_parse_emlx_returning_none_is_skipped(self, bf, tmp_path):
        # If parse_emlx fails (returns None) for a candidate, it is skipped
        # rather than crashing the run.
        class FakeEm:
            @staticmethod
            def folder_to_label(folder): return "Outlook/" + folder
            @staticmethod
            def parse_emlx(path):
                return None  # parse failure

        class FakeUploader:
            def _ensure_label(self, name): return "L"

        emlx_index = {"Inbox": {"1.partial.emlx": tmp_path / "1.partial.emlx"}}
        state = {"folders": {"Inbox": {"migrated_files": ["1.partial.emlx"]}}}
        cands = bf.build_candidates(FakeEm(), emlx_index, state,
                                    FakeUploader(), folder_filter=None)
        assert cands == []

    def test_message_without_message_id_is_skipped(self, bf, tmp_path):
        # An rfc822 with no Message-ID header cannot be matched in Gmail —
        # skip it rather than build an unusable Candidate.
        class FakeEm:
            @staticmethod
            def folder_to_label(folder): return "Outlook/" + folder
            @staticmethod
            def parse_emlx(path):
                return (b"Subject: no message-id here\r\n\r\nbody\r\n", True, 0)

        class FakeUploader:
            def _ensure_label(self, name): return "L"

        emlx_index = {"Inbox": {"1.partial.emlx": tmp_path / "1.partial.emlx"}}
        state = {"folders": {"Inbox": {"migrated_files": ["1.partial.emlx"]}}}
        cands = bf.build_candidates(FakeEm(), emlx_index, state,
                                    FakeUploader(), folder_filter=None)
        assert cands == []
