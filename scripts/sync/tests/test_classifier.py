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
    # M6 (review): tightened from `>= 2` to exact match against the constant —
    # a regression that retried only twice would previously slip past `>= 2`.
    from email_ingest import classifier as _c
    assert call_count["n"] == _c.OLLAMA_MAX_ATTEMPTS, (
        f"expected exactly {_c.OLLAMA_MAX_ATTEMPTS} attempts, got {call_count['n']}"
    )


def test_classify_does_not_retry_on_4xx_client_error(monkeypatch):
    """4xx HTTPError (e.g. malformed prompt, model name typo) is deterministic;
    fast-fail without burning ~3s of retry on misconfiguration. Only retry on
    transport errors (ConnectionError/Timeout) and 5xx (server-side recoverable)."""
    import requests
    from email_ingest import classifier

    call_count = {"n": 0}

    def fake_post(*args, **kwargs):
        call_count["n"] += 1
        resp = MagicMock()
        resp.status_code = 400
        # raise_for_status raises HTTPError with `.response` attached
        err = requests.HTTPError("400 Client Error: Bad Request")
        err.response = resp
        resp.raise_for_status.side_effect = err
        return resp

    monkeypatch.setattr(classifier.requests, "post", fake_post)
    import time as _time
    monkeypatch.setattr(_time, "sleep", lambda _s: None)

    email = _make_email(id="t3")
    result = classify_email(email)

    assert result.skip_reason == "ollama_error"
    assert call_count["n"] == 1, (
        f"4xx is deterministic and must NOT retry, got {call_count['n']} attempts"
    )


# --- 429 rate-limit is transient, not deterministic (RCA 2026-08-17) ---
# Log evidence: 3339x "Ollama request failed after 3 attempts: 429 Client Error:
# Too Many Requests" — the single most common error, 3x more frequent than
# ConnectionError. Ollama is configured OLLAMA_NUM_PARALLEL=3 and shared with
# other nanoclaw consumers on localhost:11434; 429 signals slot contention, not
# a malformed prompt / model typo / oversized num_predict like other 4xx codes.

def _make_429_response(retry_after: str | None = None) -> MagicMock:
    import requests
    resp = MagicMock()
    resp.status_code = 429
    resp.headers = {"Retry-After": retry_after} if retry_after else {}
    err = requests.HTTPError("429 Client Error: Too Many Requests")
    err.response = resp
    resp.raise_for_status.side_effect = err
    return resp


def test_classify_retries_on_429_rate_limit(monkeypatch):
    """429 (Too Many Requests) must be retried like a transient failure, not
    treated as a deterministic 4xx misconfiguration."""
    from email_ingest import classifier

    call_count = {"n": 0}

    def fake_post(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] < 3:
            return _make_429_response()
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = _ollama_success_payload(relevance=0.8)
        return resp

    monkeypatch.setattr(classifier.requests, "post", fake_post)
    import time as _time
    monkeypatch.setattr(_time, "sleep", lambda _s: None)

    email = _make_email(id="t429-retry")
    result = classify_email(email)

    assert result.skip_reason is None, (
        f"429 must be retried, not fast-failed — got skip_reason={result.skip_reason!r}"
    )
    assert call_count["n"] == 3, (
        f"expected 3 attempts (2x 429 + 1 success), got {call_count['n']}"
    )


def test_classify_honors_retry_after_header_on_429(monkeypatch):
    """When Ollama sends Retry-After on a 429, the classifier should sleep
    that duration instead of the fixed OLLAMA_BACKOFF_SEC schedule."""
    from email_ingest import classifier

    call_count = {"n": 0}
    sleep_calls = []

    def fake_post(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] < 2:
            return _make_429_response(retry_after="7")
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = _ollama_success_payload(relevance=0.8)
        return resp

    monkeypatch.setattr(classifier.requests, "post", fake_post)
    import time as _time
    monkeypatch.setattr(_time, "sleep", lambda s: sleep_calls.append(s))

    email = _make_email(id="t429-retryafter")
    result = classify_email(email)

    assert result.skip_reason is None
    assert sleep_calls, "expected classifier to sleep before retrying the 429"
    assert sleep_calls[0] == 7.0, (
        f"expected Retry-After=7 to be honored, got sleep({sleep_calls[0]})"
    )


def test_classify_429_exhausted_retries_returns_ollama_error(monkeypatch):
    """Sustained 429s (contention doesn't clear within the retry budget) still
    exhaust OLLAMA_MAX_ATTEMPTS and return ollama_error — proving 429 now goes
    through the full retry budget instead of breaking after attempt 1."""
    from email_ingest import classifier

    call_count = {"n": 0}

    def fake_post(*args, **kwargs):
        call_count["n"] += 1
        return _make_429_response()

    monkeypatch.setattr(classifier.requests, "post", fake_post)
    import time as _time
    monkeypatch.setattr(_time, "sleep", lambda _s: None)

    email = _make_email(id="t429-exhausted")
    result = classify_email(email)

    assert result.skip_reason == "ollama_error"
    assert call_count["n"] == classifier.OLLAMA_MAX_ATTEMPTS, (
        f"expected all {classifier.OLLAMA_MAX_ATTEMPTS} attempts to be used on "
        f"sustained 429s (transient, not deterministic), got {call_count['n']}"
    )


def test_classify_genuine_4xx_still_fast_fails(monkeypatch):
    """404 (e.g. model name typo) and 422 (malformed prompt) must remain
    deterministic fast-fails — only 429 changes behavior."""
    import requests
    from email_ingest import classifier

    for status in (404, 422):
        call_count = {"n": 0}

        def fake_post(*args, __status=status, **kwargs):
            call_count["n"] += 1
            resp = MagicMock()
            resp.status_code = __status
            err = requests.HTTPError(f"{__status} Client Error")
            err.response = resp
            resp.raise_for_status.side_effect = err
            return resp

        monkeypatch.setattr(classifier.requests, "post", fake_post)
        import time as _time
        monkeypatch.setattr(_time, "sleep", lambda _s: None)

        email = _make_email(id=f"t{status}")
        result = classify_email(email)

        assert result.skip_reason == "ollama_error"
        assert call_count["n"] == 1, (
            f"{status} is a genuine deterministic 4xx and must NOT retry, "
            f"got {call_count['n']} attempts"
        )


def test_classify_error_log_reports_true_attempt_count_on_4xx(monkeypatch, caplog):
    """The final error log line must report how many attempts were actually
    made, not the hardcoded OLLAMA_MAX_ATTEMPTS constant. A genuine 4xx breaks
    after exactly 1 attempt, so the log must say 1, not 3."""
    import logging as _logging
    import requests
    from email_ingest import classifier

    def fake_post(*args, **kwargs):
        resp = MagicMock()
        resp.status_code = 400
        err = requests.HTTPError("400 Client Error: Bad Request")
        err.response = resp
        resp.raise_for_status.side_effect = err
        return resp

    monkeypatch.setattr(classifier.requests, "post", fake_post)
    import time as _time
    monkeypatch.setattr(_time, "sleep", lambda _s: None)

    email = _make_email(id="t400-logcount")
    with caplog.at_level(_logging.ERROR):
        result = classify_email(email)

    assert result.skip_reason == "ollama_error"
    error_records = [r for r in caplog.records if r.levelno == _logging.ERROR
                      and "Ollama request failed after" in r.getMessage()]
    assert error_records, "expected an 'Ollama request failed after N attempts' error log"
    msg = error_records[0].getMessage()
    assert "after 1 attempt" in msg, (
        f"log must report the true attempt count (1), not the hardcoded "
        f"OLLAMA_MAX_ATTEMPTS constant — got: {msg!r}"
    )
