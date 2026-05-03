"""Tests for Ollama classifier + fast-skip rules."""

from unittest.mock import MagicMock

import pytest
from email_ingest.classifier import (
    should_fast_skip, classify_email, build_gmail_prompt, build_exchange_prompt,
    parse_classification,
)
from email_ingest.types import NormalizedEmail, ClassificationResult


def _make_email(**overrides) -> NormalizedEmail:
    defaults = dict(
        id="test-1", source="gmail", from_addr="jane@upenn.edu",
        to=["mgandal@gmail.com"], cc=[], subject="Test",
        date="2026-04-11T14:30:00-0400", body="Hello world",
        labels=["INBOX"], metadata={},
    )
    defaults.update(overrides)
    return NormalizedEmail(**defaults)


# --- Fast-skip tests ---

def test_fast_skip_gmail_promotions():
    email = _make_email(source="gmail", labels=["CATEGORY_PROMOTIONS"])
    assert should_fast_skip(email) == "promotional"


def test_fast_skip_gmail_social():
    email = _make_email(source="gmail", labels=["CATEGORY_SOCIAL"])
    assert should_fast_skip(email) == "social"


def test_fast_skip_gmail_noreply():
    email = _make_email(source="gmail", from_addr="noreply@github.com")
    assert should_fast_skip(email) == "automated"


def test_fast_skip_gmail_notifications():
    email = _make_email(source="gmail", from_addr="notifications@linkedin.com")
    assert should_fast_skip(email) == "automated"


def test_no_skip_normal_gmail():
    email = _make_email(source="gmail", labels=["INBOX", "IMPORTANT"])
    assert should_fast_skip(email) is None


def test_no_skip_exchange():
    email = _make_email(source="exchange", labels=["Inbox"])
    assert should_fast_skip(email) is None


# --- Prompt building ---

def test_build_gmail_prompt_includes_category():
    email = _make_email(source="gmail", labels=["INBOX", "CATEGORY_UPDATES"])
    prompt = build_gmail_prompt(email)
    assert "CATEGORY_UPDATES" in prompt
    assert "Grant" not in prompt  # subject is "Test"


def test_build_exchange_prompt_includes_internal_flag():
    email = _make_email(
        source="exchange",
        metadata={"internal": True, "mailbox": "Inbox", "flagged": True},
    )
    prompt = build_exchange_prompt(email)
    assert "internal" in prompt.lower() or "Internal" in prompt
    assert "flagged" in prompt.lower()


# --- Parse classification ---

def test_parse_classification_valid():
    raw = '{"relevance": 0.8, "topic": "grant", "summary": "Grant update from Jane.", "entities": ["Jane"], "action_items": ["Review budget"]}'
    result = parse_classification(raw)
    assert result.relevance == 0.8
    assert result.topic == "grant"
    assert "Jane" in result.entities


def test_parse_classification_invalid_json():
    result = parse_classification("not json at all")
    assert result.relevance == 0.0
    assert result.skip_reason == "classification_failed"


def test_parse_classification_missing_fields():
    raw = '{"relevance": 0.5}'
    result = parse_classification(raw)
    assert result.relevance == 0.5
    assert result.summary == ""
    assert result.entities == []


# --- Ollama transient-failure retry ---
# Background: ~24 connection-refused events were observed in sync logs since
# launchd-stdout.log began. Each is a single-shot Ollama hiccup that retries
# would absorb. Tests below require classify_email() to retry transient
# requests.RequestException failures before giving up.

def _ollama_success_payload(relevance: float = 0.8) -> dict:
    """Shape the Ollama /api/generate response that classify_email parses."""
    import json as _json
    return {
        "response": _json.dumps({
            "relevance": relevance,
            "topic": "research",
            "summary": "Test summary",
            "entities": ["Alice"],
            "action_items": [],
        }),
    }


def test_classify_retries_on_transient_failure(monkeypatch):
    """Two transient ConnectionErrors then success → returns parsed result, not ollama_error."""
    import requests
    from email_ingest import classifier

    call_count = {"n": 0}

    def fake_post(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] < 3:
            raise requests.ConnectionError("Failed to establish a new connection")
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = _ollama_success_payload(relevance=0.8)
        return resp

    monkeypatch.setattr(classifier.requests, "post", fake_post)
    # Skip backoff sleeps so the test is fast. Patch the global `time.sleep`
    # so the test doesn't presuppose how the retry imports time.
    import time as _time
    monkeypatch.setattr(_time, "sleep", lambda _s: None)

    email = _make_email(id="t1")
    result = classify_email(email)

    assert result.skip_reason is None, (
        f"expected successful classification after retries, got skip_reason={result.skip_reason!r}"
    )
    assert call_count["n"] == 3, (
        f"expected 3 attempts (2 fail + 1 success), got {call_count['n']}"
    )


def test_classify_returns_ollama_error_after_all_retries_exhausted(monkeypatch):
    """All attempts fail with ConnectionError → returns skip_reason='ollama_error'."""
    import requests
    from email_ingest import classifier

    call_count = {"n": 0}

    def fake_post(*args, **kwargs):
        call_count["n"] += 1
        raise requests.ConnectionError("permanently down")

    monkeypatch.setattr(classifier.requests, "post", fake_post)
    import time as _time
    monkeypatch.setattr(_time, "sleep", lambda _s: None)

    email = _make_email(id="t2")
    result = classify_email(email)

    assert result.skip_reason == "ollama_error"
    assert call_count["n"] >= 2, (
        f"expected at least 2 attempts before giving up, got {call_count['n']}"
    )
