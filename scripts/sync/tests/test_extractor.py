"""Tests for phi4-mini extraction."""
import json
from unittest.mock import patch, MagicMock

import pytest

from email_ingest.extractor import (
    extract,
    ExtractionResult,
    _parse_response,
    build_prompt,
)
from email_ingest.types import NormalizedEmail


def _email(source="gmail", from_addr="mike@upenn.edu", subject="Re: methods",
           body="Thanks. I'll send the revised methods by Friday."):
    return NormalizedEmail(
        id="msg1", source=source, from_addr=from_addr,
        to=["sarah@gmail.com"], cc=[], subject=subject,
        date="2026-04-15T14:22:00Z", body=body,
        labels=[], metadata={"threadId": "abc"},
    )


def test_parse_valid_i_owe():
    raw = json.dumps({
        "kind": "i-owe", "who": "Sarah Chen",
        "what": "Send revised methods section",
        "due": "2026-04-22", "significant": False,
        "decision_summary": "",
    })
    r = _parse_response(raw)
    assert r is not None
    assert r.kind == "i-owe"
    assert r.who == "Sarah Chen"
    assert r.due == "2026-04-22"
    assert r.significant is False


def test_parse_they_owe_me():
    raw = json.dumps({
        "kind": "they-owe-me", "who": "po@nih.gov",
        "what": "Confirm budget line", "due": "none",
        "significant": False, "decision_summary": "",
    })
    r = _parse_response(raw)
    assert r.kind == "they-owe-me"
    assert r.due == "none"


def test_parse_none_kind_returns_result_not_none():
    raw = json.dumps({
        "kind": "none", "who": "", "what": "", "due": "none",
        "significant": False, "decision_summary": "",
    })
    r = _parse_response(raw)
    assert r is not None
    assert r.kind == "none"


def test_parse_markdown_fenced_response():
    raw = "```json\n" + json.dumps({
        "kind": "i-owe", "who": "X", "what": "Y", "due": "none",
        "significant": False, "decision_summary": "",
    }) + "\n```"
    r = _parse_response(raw)
    assert r is not None
    assert r.kind == "i-owe"


def test_parse_malformed_returns_none():
    assert _parse_response("not json") is None
    assert _parse_response("{incomplete") is None
    assert _parse_response("") is None


def test_parse_missing_required_field_returns_none():
    raw = json.dumps({"who": "X"})
    assert _parse_response(raw) is None


def test_parse_significant_decision():
    raw = json.dumps({
        "kind": "none", "who": "Program Officer", "what": "",
        "due": "none", "significant": True,
        "decision_summary": "Decided to decline the renewal",
    })
    r = _parse_response(raw)
    assert r.significant is True
    assert r.decision_summary == "Decided to decline the renewal"


def test_build_prompt_includes_direction():
    email = _email()
    prompt = build_prompt(email, direction="sent")
    assert "Direction: sent" in prompt
    assert "Subject: Re: methods" in prompt
    assert email.body in prompt


def test_build_prompt_truncates_long_body():
    email = _email(body="x" * 5000)
    prompt = build_prompt(email, direction="received")
    assert len(prompt) < 3500


@patch("email_ingest.extractor.requests.post")
def test_extract_makes_ollama_request(mock_post):
    mock_post.return_value = MagicMock(
        status_code=200,
        raise_for_status=MagicMock(),
        json=lambda: {"response": json.dumps({
            "kind": "i-owe", "who": "Sarah",
            "what": "Send methods", "due": "none",
            "significant": False, "decision_summary": "",
        })},
    )
    email = _email()
    result = extract(email, direction="sent")
    assert result is not None
    assert result.kind == "i-owe"
    mock_post.assert_called_once()
    args, kwargs = mock_post.call_args
    assert kwargs["json"]["model"] == "phi4-mini"


@patch("email_ingest.extractor.requests.post")
def test_extract_network_error_returns_none(mock_post):
    import requests
    mock_post.side_effect = requests.RequestException("down")
    email = _email()
    assert extract(email, direction="sent") is None


@patch("email_ingest.extractor.requests.post")
def test_extract_empty_body_returns_none_without_ollama(mock_post):
    email = _email(body="")
    assert extract(email, direction="sent") is None
    mock_post.assert_not_called()
