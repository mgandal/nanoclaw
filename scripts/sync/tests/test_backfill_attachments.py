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


class TestRepairOne:
    def _withattach(self, mid):
        return {"id": mid, "payload": {"mimeType": "multipart/mixed", "parts": [
            {"mimeType": "application/pdf", "filename": "x.pdf",
             "body": {"size": 9000, "attachmentId": "a"}},
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

    def test_import_returns_no_id_does_not_trash(self, bf):
        # import_ returns a malformed result with no "id" -> must not trash.
        svc = _FakeGmailService()
        # Make import_ return an empty dict (no "id")
        import types

        class _NoIdMessages:
            def __init__(self, real):
                self._real = real
            def import_(self, userId, body, **kwargs):
                class _R:
                    def execute(self_inner):
                        return {}  # malformed: no "id"
                return _R()
            def get(self, *a, **kw):
                return self._real.get(*a, **kw)
            def trash(self, *a, **kw):
                return self._real.trash(*a, **kw)

        real_messages = svc.users().messages()
        svc.users = lambda: types.SimpleNamespace(
            messages=lambda: _NoIdMessages(real_messages))

        outcome = bf.repair_one(
            svc, label_id="Label_5", reinflated_bytes=b"X",
            old_message=self._bodyonly("old-id"),
        )
        assert outcome == "IMPORT_FAILED"
        assert svc.trash_calls == []  # CRITICAL: old copy untouched

    def test_trash_failure_after_verified_import(self, bf):
        # import + verify succeed, but trash raises -> REPAIRED_TRASH_FAILED,
        # exception NOT propagated (batch must not abort).
        svc = _FakeGmailService(
            get_returns={"imported-1": self._withattach("imported-1")},
        )
        import types
        real_messages = svc.users().messages()

        class _TrashFailsMessages:
            def __init__(self, real):
                self._real = real
            def import_(self, *a, **kw):
                return self._real.import_(*a, **kw)
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
            svc, label_id="Label_5", reinflated_bytes=b"X",
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
        assert outcome == "IMPORT_FAILED"


class TestRunBackfill:
    def test_dry_run_makes_no_import_or_trash_calls(self, bf):
        """Dry-run (execute=False) classifies and counts but never mutates."""
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={"m1": {"id": "m1", "payload": {"mimeType": "text/plain"}}},
        )
        candidates = [
            bf.Candidate(folder="Inbox", basename="101.partial.emlx",
                         label_id="Label_5", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(svc, candidates, execute=False, rate_limit_s=0)
        assert counts["WOULD_REPAIR"] == 1
        assert svc.import_calls == []
        assert svc.trash_calls == []

    def test_skip_no_attachments_candidate_counted_and_not_queried(self, bf):
        svc = _FakeGmailService()
        candidates = [
            bf.Candidate(folder="Inbox", basename="1.partial.emlx",
                         label_id="L", bare_mid="x@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=False),
        ]
        counts = bf.run_backfill(svc, candidates, execute=True, rate_limit_s=0)
        assert counts["SKIP_NO_ATTACHMENTS"] == 1
        # no Gmail query made for a no-attachment candidate
        assert svc.list_calls == []

    def test_execute_repairs_would_repair_candidate(self, bf):
        svc = _FakeGmailService(
            list_returns={"rfc822msgid:abc@penn.edu": [{"id": "m1"}]},
            get_returns={
                "m1": {"id": "m1", "labelIds": ["Label_5"],
                       "payload": {"mimeType": "text/plain"}},
                "imported-1": {"id": "imported-1", "payload": {
                    "mimeType": "multipart/mixed", "parts": [
                        {"mimeType": "application/pdf", "filename": "x.pdf",
                         "body": {"size": 9000, "attachmentId": "a"}}]}},
            },
        )
        candidates = [
            bf.Candidate(folder="Inbox", basename="101.partial.emlx",
                         label_id="Label_5", bare_mid="abc@penn.edu",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(svc, candidates, execute=True, rate_limit_s=0)
        assert counts["WOULD_REPAIR"] == 1
        assert len(svc.import_calls) == 1
        assert svc.trash_calls == ["m1"]

    def test_missing_candidate_bucketed(self, bf):
        svc = _FakeGmailService(list_returns={})  # no Gmail match
        candidates = [
            bf.Candidate(folder="Inbox", basename="9.partial.emlx",
                         label_id="L", bare_mid="gone@y",
                         reinflated_bytes=b"X", reinflated_has_attachments=True),
        ]
        counts = bf.run_backfill(svc, candidates, execute=True, rate_limit_s=0)
        assert counts["MISSING"] == 1
        assert svc.import_calls == []
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
        counts = bf.run_backfill(svc, candidates, execute=True, rate_limit_s=0)
        assert counts["IMPORT_FAILED"] == 1
        assert counts["WOULD_REPAIR"] == 0

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
        counts = bf.run_backfill(svc, candidates, execute=True, rate_limit_s=0)
        assert counts["WOULD_REPAIR"] == 1
        assert counts["REPAIRED_TRASH_FAILED"] == 1

    def test_would_repair_trash_only_routed_through_run_backfill(self, bf, monkeypatch):
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
        counts = bf.run_backfill(svc, candidates, execute=True, rate_limit_s=0)
        assert counts["WOULD_REPAIR_TRASH_ONLY"] == 1
        # trash_only was used: the body-only copy m1 was trashed, no import
        assert svc.trash_calls == ["m1"]
        assert svc.import_calls == []

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
        counts = bf.run_backfill(svc, candidates, execute=True, rate_limit_s=0)
        assert counts["ALREADY_DONE"] == 1
        assert counts["AMBIGUOUS"] == 1
        assert svc.import_calls == []
        assert svc.trash_calls == []
