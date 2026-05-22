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
