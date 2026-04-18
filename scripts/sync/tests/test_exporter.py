"""Tests for markdown exporter."""

import os
from pathlib import Path
from unittest.mock import patch, MagicMock
import pytest

from email_ingest.exporter import (
    build_markdown, sanitize_filename, export_email, retain_in_hindsight,
)
from email_ingest.types import NormalizedEmail, ClassificationResult


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
    assert 'thread_id: "thread-abc-123"' in md


def test_build_markdown_thread_id_empty_when_metadata_missing():
    md = build_markdown(_make_email(metadata={}), _make_result())
    assert 'thread_id: ""' in md


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
