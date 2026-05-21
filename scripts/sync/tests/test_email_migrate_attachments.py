"""Regression tests for email-migrate.py — Apple Mail stub-attachment reinflation.

Root cause: Mac Mail stores Exchange attachments in a sidecar
`Attachments/<msgnum>/<part_idx>/<filename>` directory, NOT inline in the
.emlx file. The MIME body uses `X-Apple-Content-Length` headers as
placeholders. Before this fix, email-migrate.py read only the .emlx bytes
and uploaded body-only messages to Gmail — losing ~29.5% of Penn INBOX
attachments.

Protocol (TDD):
  1. RED: tests below fail against current email-migrate.py
  2. GREEN: implement `reinflate_apple_stub_attachments()` and wire into
     `parse_emlx()`; tests pass
  3. VERIFY: no other email-migrate tests regress
"""

from __future__ import annotations

import base64
import email
import importlib.util
import sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from pathlib import Path

import pytest

_MIGRATE_PATH = Path(__file__).resolve().parents[1] / "email-migrate.py"


def _load_module(name: str = "email_migrate_attachments_under_test"):
    spec = importlib.util.spec_from_file_location(name, _MIGRATE_PATH)
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["email-migrate.py"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


@pytest.fixture
def em():
    return _load_module()


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _build_stub_emlx(
    tmp_path: Path,
    msg_num: str,
    *,
    stubs: list[tuple[str, str, bytes]],
    text_body: str = "Plain body",
    sidecar_files: list[tuple[str, str, bytes]] | None = None,
) -> Path:
    """Build a Mac Mail .partial.emlx with Apple stub MIME parts.

    Args:
      msg_num: numeric basename for the .emlx file
      stubs: list of (filename, content_type, raw_attachment_bytes) — these
        become MIME parts with `X-Apple-Content-Length` headers and no body
      text_body: plain-text body for the message
      sidecar_files: list of (part_dir, filename, raw_bytes) to place under
        the sibling Attachments/<msg_num>/ directory. Defaults to mirroring
        `stubs` 1:1 (numbered "2", "3", "4"...) so the reinflater finds them.

    Returns the path to the .emlx file. Creates the sibling Attachments/
    sidecar dir at <emlx_dir>/../Attachments/<msg_num>/<part_dir>/<filename>.
    """
    # Messages live at <root>/Data/.../Messages/<n>.emlx
    # Sidecar lives at <root>/Data/.../Attachments/<n>/<part_dir>/<file>
    msg_dir = tmp_path / "Data" / "Messages"
    msg_dir.mkdir(parents=True, exist_ok=True)
    att_dir = tmp_path / "Data" / "Attachments" / msg_num
    if sidecar_files is None:
        sidecar_files = [
            (str(i), fn, raw) for i, (fn, _ct, raw) in enumerate(stubs, start=2)
        ]
    for part_dir, fn, raw in sidecar_files:
        d = att_dir / part_dir
        d.mkdir(parents=True, exist_ok=True)
        (d / fn).write_bytes(raw)

    # Build the MIME envelope. Body is multipart/mixed with text + stubs.
    root = MIMEMultipart("mixed")
    root["From"] = "sender@penn.edu"
    root["To"] = "mgandal@upenn.edu"
    root["Subject"] = "test"
    root["Message-ID"] = f"<{msg_num}@penn.edu>"
    root["Date"] = "Tue, 28 Apr 2026 12:00:00 +0000"
    root.attach(MIMEText(text_body, "plain"))

    for fn, ct, raw in stubs:
        # Build a stub part: headers but body is empty, with X-Apple-Content-Length
        # set to a base64-encoded-size value (we use 4*ceil(n/3) for sanity)
        maintype, subtype = ct.split("/", 1)
        if maintype == "image":
            part = MIMEImage(b"", _subtype=subtype, name=fn)
            # MIMEImage will base64 the empty payload — we want truly empty
            part.set_payload("")
            del part["Content-Transfer-Encoding"]
        else:
            from email.mime.application import MIMEApplication
            part = MIMEApplication(b"", _subtype=subtype, name=fn)
            part.set_payload("")
            del part["Content-Transfer-Encoding"]
        part.add_header("Content-Disposition", "attachment", filename=fn)
        # Apple-style: declared base64-encoded byte count
        b64_size = 4 * ((len(raw) + 2) // 3)
        part.add_header("X-Apple-Content-Length", str(b64_size))
        root.attach(part)

    rfc822 = root.as_bytes()
    plist = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        b'"http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        b'<plist version="1.0"><dict>'
        b"<key>flags</key><integer>1</integer>"
        b"<key>date-received</key><integer>1730000000</integer>"
        b"</dict></plist>"
    )
    path = msg_dir / f"{msg_num}.partial.emlx"
    with open(path, "wb") as f:
        f.write(f"{len(rfc822)}\n".encode("ascii"))
        f.write(rfc822)
        f.write(plist)
    return path


# ---------------------------------------------------------------------------
# Reinflation behavior
# ---------------------------------------------------------------------------


class TestReinflateAppleStubAttachments:
    """Direct tests of the reinflate helper."""

    def test_single_png_stub_is_reinflated_from_sidecar(self, em, tmp_path):
        png_bytes = b"\x89PNG\r\n\x1a\n" + b"FAKEpng" * 10
        emlx = _build_stub_emlx(
            tmp_path, "100",
            stubs=[("image001.png", "image/png", png_bytes)],
        )
        with open(emlx, "rb") as f:
            n = int(f.readline().strip())
            rfc822 = f.read(n)

        reinflated, stats = em.reinflate_apple_stub_attachments(rfc822, emlx)

        assert stats["parts_reinflated"] == 1
        assert stats["parts_skipped_no_disk"] == 0
        # Parse the reinflated bytes and verify the PNG attachment is now inline
        msg = email.message_from_bytes(reinflated)
        attachments = [p for p in msg.walk() if p.get_filename() == "image001.png"]
        assert len(attachments) == 1
        part = attachments[0]
        # X-Apple-Content-Length header must be stripped — leaving it would
        # confuse downstream Gmail-side processing and indicate stale stub
        assert part.get("X-Apple-Content-Length") is None
        # Decoded payload must equal the original raw bytes
        assert part.get_payload(decode=True) == png_bytes

    def test_multiple_stubs_all_reinflated(self, em, tmp_path):
        a = b"AAAA" * 50
        b = b"BBBB" * 60
        c = b"CCCC" * 70
        emlx = _build_stub_emlx(
            tmp_path, "200",
            stubs=[
                ("alpha.png", "image/png", a),
                ("beta.png", "image/png", b),
                ("gamma.pdf", "application/pdf", c),
            ],
        )
        with open(emlx, "rb") as f:
            n = int(f.readline().strip())
            rfc822 = f.read(n)

        reinflated, stats = em.reinflate_apple_stub_attachments(rfc822, emlx)

        assert stats["parts_reinflated"] == 3
        msg = email.message_from_bytes(reinflated)
        payloads = {
            p.get_filename(): p.get_payload(decode=True)
            for p in msg.walk() if p.get_filename()
        }
        assert payloads["alpha.png"] == a
        assert payloads["beta.png"] == b
        assert payloads["gamma.pdf"] == c

    def test_missing_sidecar_dir_skips_gracefully(self, em, tmp_path):
        """If Attachments/<msgnum>/ does not exist, stubs remain but no crash."""
        emlx = _build_stub_emlx(
            tmp_path, "300",
            stubs=[("orphan.png", "image/png", b"xxx")],
            sidecar_files=[],
        )
        # Remove the empty sidecar dir entirely
        att_root = tmp_path / "Data" / "Attachments" / "300"
        if att_root.exists():
            import shutil
            shutil.rmtree(att_root)
        with open(emlx, "rb") as f:
            n = int(f.readline().strip())
            rfc822 = f.read(n)

        reinflated, stats = em.reinflate_apple_stub_attachments(rfc822, emlx)

        assert stats["parts_reinflated"] == 0
        assert stats["parts_skipped_no_disk"] == 1
        # Original bytes should still be parseable (no corruption)
        msg = email.message_from_bytes(reinflated)
        assert msg.get("Subject") == "test"

    def test_missing_filename_in_part_skips_gracefully(self, em, tmp_path):
        """Stub MIME part without filename= attribute cannot be matched."""
        emlx = _build_stub_emlx(
            tmp_path, "400",
            stubs=[("only.png", "image/png", b"data")],
        )
        # Strip filename from the stub part to simulate the edge case
        with open(emlx, "rb") as f:
            n = int(f.readline().strip())
            rfc822 = f.read(n)
        msg = email.message_from_bytes(rfc822)
        for part in msg.walk():
            if part.get("X-Apple-Content-Length"):
                # Remove Content-Disposition filename + Content-Type name
                del part["Content-Disposition"]
                ct = part.get("Content-Type", "")
                # Strip any name= param by re-setting type without name
                part.replace_header("Content-Type", ct.split(";")[0].strip())
        rfc822 = msg.as_bytes()

        reinflated, stats = em.reinflate_apple_stub_attachments(rfc822, emlx)

        assert stats["parts_reinflated"] == 0
        assert stats["parts_skipped_no_filename"] == 1

    def test_non_stub_message_passes_through_untouched(self, em, tmp_path):
        """Messages without any X-Apple-Content-Length parts must round-trip identically."""
        # Build a normal (fully-inline) message
        msg_dir = tmp_path / "Data" / "Messages"
        msg_dir.mkdir(parents=True, exist_ok=True)
        rfc822 = (
            b"From: a@b.com\r\nTo: c@d.com\r\nSubject: clean\r\n"
            b"Message-ID: <clean@x>\r\nDate: Tue, 28 Apr 2026 12:00:00 +0000\r\n"
            b"\r\nhello world\r\n"
        )
        path = msg_dir / "500.emlx"
        path.write_bytes(rfc822)

        reinflated, stats = em.reinflate_apple_stub_attachments(rfc822, path)

        assert stats["parts_reinflated"] == 0
        assert stats["parts_skipped_no_disk"] == 0
        assert stats["parts_skipped_no_filename"] == 0
        # Output must be parseable and equivalent
        msg = email.message_from_bytes(reinflated)
        assert msg.get("Subject") == "clean"
        assert msg.get_payload() == "hello world\r\n"

    def test_partial_recovery_some_found_some_missing(self, em, tmp_path):
        """If sidecar has 1 of 2 files, reinflate one, skip the other."""
        emlx = _build_stub_emlx(
            tmp_path, "600",
            stubs=[
                ("found.png", "image/png", b"FOUND"),
                ("missing.png", "image/png", b"MISSING"),
            ],
            sidecar_files=[
                ("2", "found.png", b"FOUND"),
                # missing.png intentionally omitted
            ],
        )
        with open(emlx, "rb") as f:
            n = int(f.readline().strip())
            rfc822 = f.read(n)

        reinflated, stats = em.reinflate_apple_stub_attachments(rfc822, emlx)

        assert stats["parts_reinflated"] == 1
        assert stats["parts_skipped_no_disk"] == 1
        msg = email.message_from_bytes(reinflated)
        payloads = {
            p.get_filename(): p.get_payload(decode=True)
            for p in msg.walk() if p.get_filename()
        }
        assert payloads["found.png"] == b"FOUND"
        # missing.png part remains in tree but with no body
        assert payloads.get("missing.png") in (None, b"")

    def test_duplicate_filenames_disambiguated_by_part_dir(self, em, tmp_path):
        """When two stubs share a filename, sidecar subdirs disambiguate by order."""
        emlx = _build_stub_emlx(
            tmp_path, "700",
            stubs=[
                ("image001.png", "image/png", b"FIRST"),
                ("image001.png", "image/png", b"SECOND"),
            ],
            sidecar_files=[
                ("2", "image001.png", b"FIRST"),
                ("3", "image001.png", b"SECOND"),
            ],
        )
        with open(emlx, "rb") as f:
            n = int(f.readline().strip())
            rfc822 = f.read(n)

        reinflated, stats = em.reinflate_apple_stub_attachments(rfc822, emlx)

        assert stats["parts_reinflated"] == 2
        msg = email.message_from_bytes(reinflated)
        attachments = [p for p in msg.walk() if p.get_filename() == "image001.png"]
        assert len(attachments) == 2
        # Order in MIME tree should match order in sidecar (subdir 2, 3)
        payloads = [p.get_payload(decode=True) for p in attachments]
        assert payloads == [b"FIRST", b"SECOND"]


# ---------------------------------------------------------------------------
# Integration with parse_emlx
# ---------------------------------------------------------------------------


class TestParseEmlxReinflates:
    """parse_emlx must transparently reinflate before returning rfc822 bytes."""

    def test_parse_emlx_returns_reinflated_bytes_for_partial(self, em, tmp_path):
        png_bytes = b"\x89PNG\r\nrealbytes" + b"x" * 200
        emlx = _build_stub_emlx(
            tmp_path, "800",
            stubs=[("image001.png", "image/png", png_bytes)],
        )

        result = em.parse_emlx(emlx)
        assert result is not None
        rfc822, _is_read, _ts = result
        # rfc822 must contain the attachment bytes after base64 round-trip
        msg = email.message_from_bytes(rfc822)
        attachments = [p for p in msg.walk() if p.get_filename() == "image001.png"]
        assert len(attachments) == 1
        assert attachments[0].get_payload(decode=True) == png_bytes
        # And the stub header must be stripped
        assert attachments[0].get("X-Apple-Content-Length") is None

    def test_parse_emlx_unchanged_for_non_partial(self, em, tmp_path):
        """Non-.partial.emlx files (no stubs) must still round-trip cleanly."""
        msg_dir = tmp_path / "Data" / "Messages"
        msg_dir.mkdir(parents=True, exist_ok=True)
        rfc822 = (
            b"From: a@b.com\r\nTo: c@d.com\r\nSubject: x\r\n"
            b"Message-ID: <x@y>\r\nDate: Tue, 28 Apr 2026 12:00:00 +0000\r\n"
            b"\r\nbody\r\n"
        )
        plist = (
            b'<?xml version="1.0"?><plist version="1.0"><dict>'
            b'<key>flags</key><integer>1</integer>'
            b'<key>date-received</key><integer>1730000000</integer>'
            b'</dict></plist>'
        )
        path = msg_dir / "900.emlx"
        with open(path, "wb") as f:
            f.write(f"{len(rfc822)}\n".encode("ascii"))
            f.write(rfc822)
            f.write(plist)

        result = em.parse_emlx(path)
        assert result is not None
        out_rfc822, _is_read, _ts = result
        # Bodies must match (subject, message-id, body intact)
        out_msg = email.message_from_bytes(out_rfc822)
        assert out_msg.get("Subject") == "x"
        assert out_msg.get("Message-ID") == "<x@y>"


# ---------------------------------------------------------------------------
# Upload size cap (Gmail messages.import caps at ~35 MB base64)
# ---------------------------------------------------------------------------


class TestUploadSizeCap:
    """Skip messages whose base64-encoded body exceeds Gmail import limit.

    Gmail messages.import returns 413 Payload Too Large for bodies over ~35 MB
    base64-encoded. Without a pre-flight check, these waste MAX_RETRIES attempts
    each. The cap also defends against runaway reinflate output if a sidecar
    has an unexpectedly huge file.
    """

    def test_upload_message_rejects_oversized_body_without_calling_api(self, em):
        """If eml_content base64-encodes to over GMAIL_IMPORT_MAX_BYTES, return
        (0, '<descriptive error>') WITHOUT invoking the Gmail API at all."""
        # Cap exists as a module constant
        assert hasattr(em, "GMAIL_IMPORT_MAX_BYTES"), (
            "expected GMAIL_IMPORT_MAX_BYTES module constant for upload size cap"
        )
        # Build a payload that exceeds the cap. Use a chunk of raw bytes
        # large enough that base64-encoded length > cap.
        oversized_raw = b"A" * (em.GMAIL_IMPORT_MAX_BYTES + 1024)

        api_called = {"count": 0}

        class _FakeMessages:
            def import_(self_inner, **kwargs):  # noqa: D401
                api_called["count"] += 1
                raise AssertionError("API must not be called for oversized body")

        class _FakeUsers:
            def messages(self_inner):
                return _FakeMessages()

        class _FakeService:
            def users(self_inner):
                return _FakeUsers()

        # Instantiate the uploader. The class is GmailAPIUploader (per code).
        # We don't need real credentials for this code path.
        uploader = em.GmailApiUploader.__new__(em.GmailApiUploader)
        nbytes, err = uploader.upload_message(_FakeService(), "Label_1", oversized_raw, True)

        assert nbytes == 0
        assert err is not None
        assert "too large" in err.lower() or "exceeds" in err.lower()
        assert api_called["count"] == 0

    def test_upload_message_accepts_under_cap(self, em, monkeypatch):
        """A message under the cap must still proceed to the API call path."""
        assert hasattr(em, "GMAIL_IMPORT_MAX_BYTES")
        small_raw = b"From: a@b\r\nSubject: t\r\n\r\nhi"

        api_called = {"count": 0}

        class _FakeReq:
            def execute(self_inner):
                return {"id": "msg-id-1"}

        class _FakeMessages:
            def import_(self_inner, **kwargs):
                api_called["count"] += 1
                return _FakeReq()

        class _FakeUsers:
            def messages(self_inner):
                return _FakeMessages()

        class _FakeService:
            def users(self_inner):
                return _FakeUsers()

        uploader = em.GmailApiUploader.__new__(em.GmailApiUploader)
        nbytes, err = uploader.upload_message(_FakeService(), "Label_1", small_raw, True)

        assert err is None
        assert nbytes == len(small_raw)
        assert api_called["count"] == 1

    def test_size_cap_compares_against_decoded_message_size(self, em):
        """Gmail's cap is on the RFC822 (decoded) message, not the base64
        wire encoding. A message just over the cap raw (which base64-encodes
        to ~1.35x larger) must be rejected; a message under the cap raw
        (whose base64 expansion would exceed the cap if checked the wrong
        way) must be accepted.
        """
        cap = em.GMAIL_IMPORT_MAX_BYTES
        # Just over the cap raw → base64 ~1.35x larger. Must be rejected.
        over_raw = b"A" * (cap + 1024)

        api_called = {"count": 0}

        class _FakeService:
            def users(self_inner):
                class _U:
                    def messages(self_inner2):
                        class _M:
                            def import_(self_inner3, **kw):
                                api_called["count"] += 1
                                raise AssertionError("must not be called")
                        return _M()
                return _U()

        uploader = em.GmailApiUploader.__new__(em.GmailApiUploader)
        nbytes, err = uploader.upload_message(_FakeService(), "L", over_raw, True)
        assert nbytes == 0
        assert err and "too large" in err.lower()
        assert api_called["count"] == 0

        # Just under cap raw, whose base64 expansion (1.35x) would exceed
        # the cap if the check were on base64 not decoded. Must be ACCEPTED.
        # We use 90% of cap to ensure raw < cap but raw*1.35 > cap.
        under_raw = b"B" * int(cap * 0.9)
        api_called["count"] = 0

        class _FakeReq:
            def execute(self_inner):
                return {"id": "m1"}

        class _OkService:
            def users(self_inner):
                class _U:
                    def messages(self_inner2):
                        class _M:
                            def import_(self_inner3, **kw):
                                api_called["count"] += 1
                                return _FakeReq()
                        return _M()
                return _U()

        uploader2 = em.GmailApiUploader.__new__(em.GmailApiUploader)
        nbytes2, err2 = uploader2.upload_message(_OkService(), "L", under_raw, True)
        assert err2 is None
        assert nbytes2 == len(under_raw)
        assert api_called["count"] == 1


# ---------------------------------------------------------------------------
# H2 — fast path for non-stub messages (no MIME parse on hot path)
# ---------------------------------------------------------------------------


class TestReinflateFastPath:
    """Non-stub messages must NOT parse the MIME tree.

    Parsing every message through email.message_from_bytes is wasted CPU
    for the ~70% of Penn messages without X-Apple-Content-Length headers.
    The reinflater must short-circuit on a cheap substring check.
    """

    def test_non_stub_skips_mime_parse_entirely(self, em, tmp_path, monkeypatch):
        """email.message_from_bytes must NOT be called when no stub header."""
        rfc822 = (
            b"From: a@b.com\r\nTo: c@d.com\r\nSubject: clean\r\n"
            b"Message-ID: <abc@x>\r\nDate: Tue, 28 Apr 2026 12:00:00 +0000\r\n"
            b"\r\nhello world\r\n"
        )
        parse_count = {"calls": 0}
        real_parse = em.email.message_from_bytes

        def counting_parse(*a, **kw):
            parse_count["calls"] += 1
            return real_parse(*a, **kw)

        monkeypatch.setattr(em.email, "message_from_bytes", counting_parse)

        path = tmp_path / "1.emlx"
        path.write_bytes(rfc822)
        out, stats = em.reinflate_apple_stub_attachments(rfc822, path)

        assert out == rfc822  # byte-exact passthrough
        assert stats["parts_reinflated"] == 0
        assert parse_count["calls"] == 0, (
            "fast path must avoid email.message_from_bytes when no stub header present"
        )

    def test_stub_message_still_parses(self, em, tmp_path):
        """Sanity: when X-Apple-Content-Length IS present, parsing still happens."""
        png = b"\x89PNGfake" * 30
        emlx = _build_stub_emlx(
            tmp_path, "fast1",
            stubs=[("img.png", "image/png", png)],
        )
        with open(emlx, "rb") as f:
            n = int(f.readline().strip())
            rfc822 = f.read(n)
        # Must contain the marker substring
        assert b"X-Apple-Content-Length" in rfc822
        out, stats = em.reinflate_apple_stub_attachments(rfc822, emlx)
        assert stats["parts_reinflated"] == 1


# ---------------------------------------------------------------------------
# H5 — size-cap rejection must NOT count as silent-degrade error
# ---------------------------------------------------------------------------


class TestSizeCapAccountingDistinctFromErrors:
    """Per sync-health-check.sh:182, `errors_session > 0 AND bytes_session == 0`
    promotes the run to HARD ("silent degrade"). Size-capped skips would
    trigger a false HARD on attachment-heavy folders. We must classify them
    as SKIPPED, not ERRORED.
    """

    def test_folder_state_distinguishes_skipped_from_errored(self, em):
        """The folder_state dict must carry a `skipped` list separate from
        `errors`. This is the new shape consumed by the health-check marker
        writer.
        """
        # Build a folder_state by hand and run the size-cap-failure path
        # through upload_one -> migrate_folder error-handler logic.
        # We do this indirectly: assert that the size-cap error message,
        # when seen by the migration loop, lands in a `skipped` list and
        # NOT in `errors`.
        #
        # We test by introspecting: the constant SIZE_CAP_ERROR_MARKER must
        # exist as a string the migration loop uses to dispatch.
        assert hasattr(em, "SIZE_CAP_ERROR_MARKER"), (
            "expected module constant SIZE_CAP_ERROR_MARKER so migrate_folder "
            "can distinguish skipped (size-cap) from errored uploads"
        )
        # The marker must be a non-empty substring of the actual error msg
        # that upload_message returns, so dispatch is reliable.
        oversized = b"X" * (em.GMAIL_IMPORT_MAX_BYTES + 1024)
        uploader = em.GmailApiUploader.__new__(em.GmailApiUploader)

        class _NoCallService:
            def users(self_inner):
                class _U:
                    def messages(self_inner2):
                        class _M:
                            def import_(self_inner3, **kw):
                                raise AssertionError("must not be called")
                        return _M()
                return _U()

        _, err = uploader.upload_message(_NoCallService(), "L", oversized, True)
        assert em.SIZE_CAP_ERROR_MARKER in err, (
            f"upload_message error must contain marker {em.SIZE_CAP_ERROR_MARKER!r} "
            f"so migration loop can route to skipped/, got: {err!r}"
        )

    def test_marker_writer_reports_skipped_session_separately(self, em, tmp_path, monkeypatch):
        """write_last_success_marker must emit a `skipped_session` count distinct
        from `errors_session` so sync-health-check.sh can keep its silent-degrade
        check pure (real failures only).
        """
        monkeypatch.setattr(em, "STATE_DIR", tmp_path)
        state = {
            "folders": {
                "Inbox": {
                    "total": 5,
                    "migrated": 3,
                    "migrated_files": [],
                    "errors": [{"file": "real-fail.emlx", "error": "OAuth revoked"}],
                    "skipped": [
                        {"file": "huge1.emlx", "error": "too large for Gmail import"},
                        {"file": "huge2.emlx", "error": "too large for Gmail import"},
                    ],
                }
            },
            "bytes_uploaded_today": 12345,
        }
        em.write_success_marker(state, bytes_at_start=0, errors_at_start=0)
        marker_path = tmp_path / "last-success.json"
        import json as _json
        payload = _json.loads(marker_path.read_text())
        assert payload["errors_session"] == 1, "real errors only"
        assert payload["skipped_session"] == 2, "size-cap skips reported separately"


# ---------------------------------------------------------------------------
# H6 — real-shape Apple Mail fixture (nested multipart/related + Content-ID inline)
# ---------------------------------------------------------------------------


class TestRealAppleMailShape:
    """Real Penn .partial.emlx files use nested multipart/related →
    multipart/alternative → text/plain + text/html, with attachments at
    the outer level marked by Content-ID for inline images. Test that the
    reinflater handles this shape (and not just the simpler one in the
    other tests).
    """

    def test_nested_multipart_related_with_inline_image(self, em, tmp_path):
        # Build the exact shape we saw in 106967.partial.emlx
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText
        from email.mime.image import MIMEImage

        msg_dir = tmp_path / "Data" / "Messages"
        msg_dir.mkdir(parents=True, exist_ok=True)
        att_dir = tmp_path / "Data" / "Attachments" / "real1"

        # Real image bytes that round-trip cleanly
        png = b"\x89PNG\r\n\x1a\n" + b"realsample" * 100

        # Sidecar layout matches what we observed: 2/<filename>
        d = att_dir / "2"
        d.mkdir(parents=True, exist_ok=True)
        (d / "image001.png").write_bytes(png)

        # Build nested MIME: multipart/related[multipart/alternative[text, html], image]
        root = MIMEMultipart("related")
        root["From"] = "sender@penn.edu"
        root["To"] = "mgandal@upenn.edu"
        root["Subject"] = "Real shape"
        root["Message-ID"] = "<real1@penn.edu>"
        root["Date"] = "Tue, 28 Apr 2026 12:00:00 +0000"

        alt = MIMEMultipart("alternative")
        alt.attach(MIMEText("Plain version", "plain"))
        alt.attach(MIMEText("<p>HTML version</p>", "html"))
        root.attach(alt)

        # Image stub with Content-ID (inline reference style)
        stub = MIMEImage(b"", _subtype="png", name="image001.png")
        stub.set_payload("")
        del stub["Content-Transfer-Encoding"]
        stub.add_header("Content-Disposition", "inline", filename="image001.png")
        stub.add_header("Content-ID", "<image001.png@01DAE284.23A7F060>")
        stub.add_header("X-Apple-Content-Length", str(4 * ((len(png) + 2) // 3)))
        root.attach(stub)

        rfc822 = root.as_bytes()
        plist = (
            b'<?xml version="1.0"?><plist version="1.0"><dict>'
            b'<key>flags</key><integer>1</integer>'
            b'<key>date-received</key><integer>1730000000</integer>'
            b'</dict></plist>'
        )
        emlx = msg_dir / "real1.partial.emlx"
        with open(emlx, "wb") as f:
            f.write(f"{len(rfc822)}\n".encode("ascii"))
            f.write(rfc822)
            f.write(plist)

        # Now reinflate
        result = em.parse_emlx(emlx)
        assert result is not None
        out_rfc822, _, _ = result

        out_msg = email.message_from_bytes(out_rfc822)

        # Find the image part and verify it has the real bytes
        image_parts = [
            p for p in out_msg.walk()
            if p.get_content_type() == "image/png"
        ]
        assert len(image_parts) == 1
        part = image_parts[0]
        assert part.get_payload(decode=True) == png
        # Content-ID must be preserved (critical for inline rendering)
        assert part.get("Content-ID") == "<image001.png@01DAE284.23A7F060>"
        # X-Apple stub header must be stripped
        assert part.get("X-Apple-Content-Length") is None

        # Text/html parts must be untouched
        html_parts = [
            p for p in out_msg.walk()
            if p.get_content_type() == "text/html"
        ]
        assert len(html_parts) == 1
        assert "HTML version" in html_parts[0].get_payload()


# ---------------------------------------------------------------------------
# H6/H7 — byte-exactness regression guard for the no-stubs path
# ---------------------------------------------------------------------------


class TestSizeCapConstantMatchesDocumentedLimit:
    """Gmail messages.import documents a 150 MB cap. Round-2 used 35 MB
    (the messages.send cap), which silently routes legitimate 35-150 MB
    messages into the skipped list. Round-3 raises the cap to 50 MB
    (conservative under documented 150 MB, well above realistic Exchange
    attachment sizes)."""

    def test_size_cap_is_at_least_50_mb(self, em):
        """The cap must be at least 50 MB so we don't silently drop large
        but legitimate Exchange attachments."""
        assert em.GMAIL_IMPORT_MAX_BYTES >= 50 * 1024 * 1024, (
            f"GMAIL_IMPORT_MAX_BYTES is {em.GMAIL_IMPORT_MAX_BYTES} bytes "
            f"({em.GMAIL_IMPORT_MAX_BYTES / 1024 / 1024:.0f} MB); "
            "Gmail messages.import documents 150 MB. Round-2's 35 MB "
            "was wrong — it's the messages.send cap, not import."
        )

    def test_size_cap_below_documented_gmail_limit(self, em):
        """Stay below the documented 150 MB cap to avoid 413s."""
        assert em.GMAIL_IMPORT_MAX_BYTES <= 150 * 1024 * 1024


class TestMigrateFolderRoutesOversizedToSkipped:
    """End-to-end coverage gap from round-3 review: no test actually drives
    an oversized message through migrate_folder's as_completed loop into
    folder_state['skipped']. Marker-format drift or refactoring the
    `if SIZE_CAP_ERROR_MARKER in error:` check could silently break the
    H5 fix without any test failing."""

    def test_oversized_message_lands_in_skipped_not_errors(self, em, tmp_path, monkeypatch):
        """An oversized .emlx flows through migrate_folder and lands in
        folder_state['skipped'], not folder_state['errors']."""
        # Build a real .emlx containing a body so large that
        # GMAIL_IMPORT_MAX_BYTES is exceeded.
        msg_dir = tmp_path / "Data" / "Messages"
        msg_dir.mkdir(parents=True, exist_ok=True)
        big_body = b"X" * (em.GMAIL_IMPORT_MAX_BYTES + 4096)
        rfc822 = (
            b"From: a@b.com\r\nTo: c@d.com\r\nSubject: huge\r\n"
            b"Message-ID: <huge@x>\r\n"
            b"Date: Tue, 28 Apr 2026 12:00:00 +0000\r\n\r\n"
        ) + big_body
        plist = (
            b'<?xml version="1.0"?><plist version="1.0"><dict>'
            b'<key>flags</key><integer>1</integer>'
            b'<key>date-received</key><integer>1730000000</integer>'
            b'</dict></plist>'
        )
        path = msg_dir / "huge.emlx"
        with open(path, "wb") as f:
            f.write(f"{len(rfc822)}\n".encode("ascii"))
            f.write(rfc822)
            f.write(plist)

        # Build an uploader without going through __init__ (no real creds).
        uploader = em.GmailApiUploader.__new__(em.GmailApiUploader)
        # Stub the parts of GmailApiUploader migrate_folder needs.
        uploader._label_cache = {"Outlook/huge-folder": "Label_1"}
        uploader._admin_service = None  # seed_migrated_files_from_gmail short-circuits
        uploader._num_workers = 1
        uploader._thread_local = __import__("threading").local()

        # Force seed_migrated_files_from_gmail to no-op (no admin service).
        monkeypatch.setattr(em, "seed_migrated_files_from_gmail",
                            lambda *a, **kw: None)
        # Force label resolution to a fixed Label_1.
        monkeypatch.setattr(uploader, "_ensure_label",
                            lambda label_name: "Label_1")
        # Stub _get_thread_service to return a service whose import_ would 413
        # if called — but with our 60 MB body, the pre-flight cap MUST catch
        # it first and import_ must never be invoked.
        api_called = {"count": 0}

        class _FailService:
            def users(self_inner):
                class _U:
                    def messages(self_inner2):
                        class _M:
                            def import_(self_inner3, **kw):
                                api_called["count"] += 1
                                raise AssertionError(
                                    "API import_ must NOT be called for oversized "
                                    "message; pre-flight cap should reject first"
                                )
                        return _M()
                return _U()

        monkeypatch.setattr(uploader, "_get_thread_service",
                            lambda: _FailService())

        state = {"folders": {}, "bytes_uploaded_today": 0}
        state = uploader.migrate_folder("huge-folder", [path], state)

        folder_state = state["folders"]["huge-folder"]
        # The size-cap path must route to skipped, not errors
        assert len(folder_state.get("errors", [])) == 0, (
            f"oversized message must NOT land in errors; got "
            f"{folder_state.get('errors')}"
        )
        assert len(folder_state.get("skipped", [])) == 1, (
            f"oversized message must land in skipped; got "
            f"{folder_state.get('skipped')}"
        )
        # And the marker substring must be present in the skipped record
        assert em.SIZE_CAP_ERROR_MARKER in folder_state["skipped"][0]["error"]
        # File must be marked migrated so we don't retry it next sync
        assert "huge.emlx" in folder_state["migrated_files"]
        # And the API must NOT have been called
        assert api_called["count"] == 0


class TestByteExactnessForNonStub:
    """Even when a message has X-Apple-Content-Length stubs but the sidecar
    dir is missing entirely, the original bytes must be returned unchanged
    (we cannot improve on what we have). Verifies the early-return contract.
    """

    def test_stubs_with_no_sidecar_returns_original_bytes_byteexact(self, em, tmp_path):
        emlx = _build_stub_emlx(
            tmp_path, "exact1",
            stubs=[("ghost.png", "image/png", b"xxx")],
            sidecar_files=[],
        )
        # Remove sidecar dir to force the "skipped_no_disk" path for all parts
        att_root = tmp_path / "Data" / "Attachments" / "exact1"
        if att_root.exists():
            import shutil
            shutil.rmtree(att_root)
        with open(emlx, "rb") as f:
            n = int(f.readline().strip())
            rfc822 = f.read(n)
        out, stats = em.reinflate_apple_stub_attachments(rfc822, emlx)
        assert stats["parts_reinflated"] == 0
        assert stats["parts_skipped_no_disk"] == 1
        assert out == rfc822, (
            "when nothing was reinflated, original bytes must be returned "
            "byte-for-byte (preserve DKIM, header folding, line endings)"
        )
