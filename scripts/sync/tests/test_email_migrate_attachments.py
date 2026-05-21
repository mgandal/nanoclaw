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
