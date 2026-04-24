"""Tests for markdown exporter."""

import os
import re
from pathlib import Path
from unittest.mock import patch, MagicMock
import pytest
import yaml

from email_ingest.exporter import (
    build_markdown, sanitize_filename, export_email, retain_in_hindsight,
)
from email_ingest.types import NormalizedEmail, ClassificationResult


def _parse_frontmatter(md: str) -> dict:
    """Extract the leading YAML frontmatter block and return the parsed dict.

    Frontmatter is delimited by the first two `---` lines. Body can contain
    its own `---` separator (between summary/action-items and body fence),
    so the regex only captures the first fenced block.
    """
    m = re.match(r"^---\n(.*?)\n---\n", md, re.DOTALL)
    if not m:
        raise AssertionError("No frontmatter block found")
    return yaml.safe_load(m.group(1)) or {}


def _make_email(**overrides) -> NormalizedEmail:
    defaults = dict(
        id="msg-123", source="gmail", from_addr="Jane Doe <jane@upenn.edu>",
        to=["mgandal@gmail.com"], cc=["bob@chop.edu"], subject="Grant update",
        date="2026-04-11T14:30:00-0400", body="The grant is on track.",
        labels=["INBOX", "IMPORTANT"], metadata={},
    )
    defaults.update(overrides)
    return NormalizedEmail(**defaults)


def _make_result(**overrides) -> ClassificationResult:
    defaults = dict(
        relevance=0.8, topic="grant",
        summary="Jane confirms the grant is on track.",
        entities=["Jane Doe", "scRBP"], action_items=["Review budget by Apr 14"],
    )
    defaults.update(overrides)
    return ClassificationResult(**defaults)


def test_sanitize_filename():
    assert sanitize_filename("<abc@def.com>") == "abc-def-com"
    assert sanitize_filename("normal-id-123") == "normal-id-123"
    assert sanitize_filename("a" * 200) == "a" * 100  # truncated


def test_build_markdown_has_frontmatter():
    md = build_markdown(_make_email(), _make_result())
    assert md.startswith("---\n")
    assert "source: gmail" in md
    assert "relevance: 0.8" in md
    assert "topic: grant" in md
    assert "Jane Doe" in md


def test_build_markdown_has_summary_section():
    md = build_markdown(_make_email(), _make_result())
    assert "## Summary" in md
    assert "grant is on track" in md


def test_build_markdown_has_action_items():
    md = build_markdown(_make_email(), _make_result())
    assert "## Action Items" in md
    assert "Review budget" in md


def test_build_markdown_has_original_body():
    md = build_markdown(_make_email(), _make_result())
    assert "The grant is on track." in md


def test_build_markdown_has_direction_inbound_when_no_sent_label():
    md = build_markdown(_make_email(labels=["INBOX", "IMPORTANT"]), _make_result())
    assert "direction: inbound" in md


def test_build_markdown_has_direction_outbound_when_sent_label_present():
    md = build_markdown(_make_email(labels=["SENT"]), _make_result())
    assert "direction: outbound" in md


def test_build_markdown_includes_thread_id_from_metadata():
    md = build_markdown(
        _make_email(metadata={"threadId": "thread-abc-123"}),
        _make_result(),
    )
    fm = _parse_frontmatter(md)
    assert fm["thread_id"] == "thread-abc-123"


def test_build_markdown_thread_id_empty_when_metadata_missing():
    md = build_markdown(_make_email(metadata={}), _make_result())
    fm = _parse_frontmatter(md)
    assert fm["thread_id"] == ""


# ─────────────────────────────────────────────────
# C7: YAML frontmatter injection
# ─────────────────────────────────────────────────
#
# Attacker-controlled strings (subject, from, entities, summary) must never
# escape the frontmatter. A subject like `"Hi\n---\nmalicious: true\n"`
# previously broke out of the fence because build_markdown relied on hand-spun
# f-string quoting (`f'"{email.subject}"'`). The fix routes every value
# through `yaml.safe_dump` so escaping happens in one place.


def test_c7_subject_with_yaml_fence_does_not_escape():
    """A subject containing `---` must stay inside the `subject:` value."""
    injected = 'Hello\n---\nmalicious: true\n# pwn'
    md = build_markdown(_make_email(subject=injected), _make_result())
    fm = _parse_frontmatter(md)
    assert fm["subject"] == injected
    assert "malicious" not in fm
    assert "pwn" not in fm


def test_c7_subject_with_double_quotes_round_trips():
    """Embedded double quotes must not break YAML parsing."""
    injected = 'Re: "urgent" request'
    md = build_markdown(_make_email(subject=injected), _make_result())
    fm = _parse_frontmatter(md)
    assert fm["subject"] == injected


def test_c7_from_addr_with_injection_round_trips():
    """`from` is attacker-controlled via email headers."""
    injected = 'Mallory <m@x.com>"\nprivileged: true\n"'
    md = build_markdown(_make_email(from_addr=injected), _make_result())
    fm = _parse_frontmatter(md)
    assert fm["from"] == injected
    assert "privileged" not in fm


def test_c7_entities_with_injection_round_trip():
    """Classification entities are Ollama-derived → adversarial."""
    injected_entities = ['Jane"\nescaped: yes', 'normal']
    md = build_markdown(
        _make_email(),
        _make_result(entities=injected_entities),
    )
    fm = _parse_frontmatter(md)
    assert fm["entities"] == injected_entities
    assert "escaped" not in fm


def test_c7_summary_injection_stays_in_body():
    """`summary` is the only field that leaves frontmatter as free text —
    but the body-level delimiter (`---` between summary and body) should
    survive a summary containing its own `---`."""
    injected_summary = "Line 1\n---\nfake_field: true"
    md = build_markdown(
        _make_email(),
        _make_result(summary=injected_summary),
    )
    # Frontmatter itself must still parse cleanly.
    fm = _parse_frontmatter(md)
    assert "fake_field" not in fm
    assert "## Summary" in md
    assert injected_summary in md


def test_c7_labels_with_injection_preserved_as_list():
    """`labels` was previously emitted via Python list __repr__ (fragile)."""
    injected_labels = ['INBOX', 'IMPORTANT', 'x"\ninjected: yes']
    md = build_markdown(_make_email(labels=injected_labels), _make_result())
    fm = _parse_frontmatter(md)
    assert fm["labels"] == injected_labels
    assert "injected" not in fm


def test_export_email_creates_file(tmp_path):
    with patch("email_ingest.exporter.EXPORT_DIR", tmp_path):
        path = export_email(_make_email(), _make_result())
        assert path.exists()
        content = path.read_text()
        assert "source: gmail" in content
        assert "## Summary" in content


def test_export_email_creates_date_subdirectory(tmp_path):
    with patch("email_ingest.exporter.EXPORT_DIR", tmp_path):
        path = export_email(
            _make_email(date="2026-04-11T14:30:00-0400"),
            _make_result(),
        )
        assert "gmail" in str(path)
        assert "2026-04" in str(path)


def test_export_email_appends_attachments_section(tmp_path):
    email = _make_email(attachments=[
        {"filename": "report.docx", "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
         "size": 1234, "attachment_id": "att-1"},
    ])
    downloader = MagicMock(return_value=b"fake-docx-bytes")
    with patch("email_ingest.exporter.EXPORT_DIR", tmp_path), \
         patch("email_ingest.exporter.md_adapter.is_available", return_value=True), \
         patch("email_ingest.exporter.md_adapter.is_supported", return_value=True), \
         patch("email_ingest.exporter.md_adapter.convert_bytes", return_value="# report\n\nbody"):
        path = export_email(email, _make_result(), downloader=downloader)
        content = path.read_text()
        assert "## Attachments" in content
        assert "### report.docx" in content
        assert "# report" in content
        downloader.assert_called_once_with("msg-123", "att-1")


def test_export_email_skips_unsupported_attachments(tmp_path):
    email = _make_email(attachments=[
        {"filename": "movie.mov", "mime_type": "video/quicktime",
         "size": 500, "attachment_id": "att-2"},
    ])
    downloader = MagicMock()
    with patch("email_ingest.exporter.EXPORT_DIR", tmp_path), \
         patch("email_ingest.exporter.md_adapter.is_available", return_value=True):
        path = export_email(email, _make_result(), downloader=downloader)
        content = path.read_text()
        assert "### movie.mov" in content
        assert "unsupported" in content
        downloader.assert_not_called()


def test_export_email_no_attachments_section_without_downloader(tmp_path):
    email = _make_email(attachments=[
        {"filename": "a.docx", "mime_type": "application/x", "size": 100, "attachment_id": "x"},
    ])
    with patch("email_ingest.exporter.EXPORT_DIR", tmp_path):
        path = export_email(email, _make_result(), downloader=None)
        content = path.read_text()
        assert "## Attachments" not in content


def test_retain_in_hindsight_fires_and_forgets():
    with patch("email_ingest.exporter.requests") as mock_req:
        mock_req.post.return_value = MagicMock(status_code=200)
        retain_in_hindsight(_make_email(), _make_result(), "http://localhost:8889")
        mock_req.post.assert_called_once()
        call_args = mock_req.post.call_args
        assert "retain" in call_args[0][0]


def test_retain_in_hindsight_swallows_errors():
    with patch("email_ingest.exporter.requests") as mock_req:
        mock_req.post.side_effect = Exception("connection refused")
        # Should not raise
        retain_in_hindsight(_make_email(), _make_result(), "http://localhost:8889")


# ─────────────────────────────────────────────────
# C18: Hindsight retain safety — URL check + bearer auth
# ─────────────────────────────────────────────────
#
# email content is POSTed fire-and-forget to a URL derived from the
# HINDSIGHT_URL env var. If that variable is ever misconfigured to a
# non-local target, every relevant email silently exfiltrates.
# Defense-in-depth: reject non-local URLs before POST, and send a bearer
# token when HINDSIGHT_API_KEY is set so an on-box attacker cannot
# read memory via /recall without the shared secret.

from email_ingest.exporter import hindsight_url_is_safe


def test_hindsight_url_is_safe_allows_localhost():
    assert hindsight_url_is_safe("http://localhost:8889") is True
    assert hindsight_url_is_safe("http://localhost:8889/") is True
    assert hindsight_url_is_safe("http://localhost") is True


def test_hindsight_url_is_safe_allows_loopback_ipv4():
    assert hindsight_url_is_safe("http://127.0.0.1:8889") is True
    assert hindsight_url_is_safe("http://127.0.0.1") is True


def test_hindsight_url_is_safe_allows_container_gateway():
    # src/container-runner.ts rewrites localhost → 192.168.64.1 for
    # the agent-runner container. Host-side retain calls might use
    # either form, so both must be allowed.
    assert hindsight_url_is_safe("http://192.168.64.1:8889") is True


def test_hindsight_url_is_safe_rejects_remote_host():
    assert hindsight_url_is_safe("http://attacker.com:8889") is False
    assert hindsight_url_is_safe("http://evil.example.com/retain") is False


def test_hindsight_url_is_safe_rejects_https():
    # https:// to a remote target would be the worst-case exfil
    # path; reject on principle even for loopback (we serve plain HTTP).
    assert hindsight_url_is_safe("https://attacker.com:8889") is False


def test_hindsight_url_is_safe_rejects_file_and_empty():
    assert hindsight_url_is_safe("file:///etc/passwd") is False
    assert hindsight_url_is_safe("") is False
    assert hindsight_url_is_safe(None) is False


def test_hindsight_url_is_safe_rejects_missing_scheme():
    # `localhost:8889` without scheme — urlparse treats `localhost` as
    # scheme, which would bypass the scheme check if we only looked at
    # hostname. Belt-and-braces rejection.
    assert hindsight_url_is_safe("localhost:8889") is False


def test_retain_in_hindsight_skips_when_url_unsafe():
    """Misconfigured HINDSIGHT_URL must NOT leak email content."""
    with patch("email_ingest.exporter.requests") as mock_req:
        retain_in_hindsight(
            _make_email(), _make_result(), "http://attacker.com:8889"
        )
        mock_req.post.assert_not_called()


def test_retain_in_hindsight_sends_bearer_when_env_set():
    import os
    with patch.dict(os.environ, {"HINDSIGHT_API_KEY": "test-secret-123"}), \
         patch("email_ingest.exporter.requests") as mock_req:
        mock_req.post.return_value = MagicMock(status_code=200)
        retain_in_hindsight(
            _make_email(), _make_result(), "http://localhost:8889"
        )
        mock_req.post.assert_called_once()
        kwargs = mock_req.post.call_args.kwargs
        headers = kwargs.get("headers") or {}
        assert headers.get("Authorization") == "Bearer test-secret-123"


def test_retain_in_hindsight_no_bearer_when_env_unset():
    import os
    # Explicitly clear the env var for this test
    env = {k: v for k, v in os.environ.items() if k != "HINDSIGHT_API_KEY"}
    with patch.dict(os.environ, env, clear=True), \
         patch("email_ingest.exporter.requests") as mock_req:
        mock_req.post.return_value = MagicMock(status_code=200)
        retain_in_hindsight(
            _make_email(), _make_result(), "http://localhost:8889"
        )
        mock_req.post.assert_called_once()
        kwargs = mock_req.post.call_args.kwargs
        headers = kwargs.get("headers") or {}
        assert "Authorization" not in headers
