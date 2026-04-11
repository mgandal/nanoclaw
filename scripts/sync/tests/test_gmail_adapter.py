"""Tests for Gmail adapter."""

from unittest.mock import MagicMock, patch
import pytest

from email_ingest.gmail_adapter import GmailAdapter, normalize_gmail_message
from email_ingest.types import BODY_MAX_CHARS


def test_normalize_gmail_message_basic():
    raw = {
        "id": "msg123",
        "threadId": "thread456",
        "labelIds": ["INBOX", "IMPORTANT"],
        "payload": {
            "headers": [
                {"name": "From", "value": "Jane Doe <jane@upenn.edu>"},
                {"name": "To", "value": "mgandal@gmail.com"},
                {"name": "Cc", "value": "bob@chop.edu"},
                {"name": "Subject", "value": "Grant update"},
                {"name": "Date", "value": "Fri, 11 Apr 2026 14:30:00 -0400"},
            ],
            "body": {"data": ""},
            "parts": [
                {
                    "mimeType": "text/plain",
                    "body": {"data": "SGVsbG8gd29ybGQ="},  # "Hello world" base64
                }
            ],
        },
    }
    email = normalize_gmail_message(raw)
    assert email.id == "msg123"
    assert email.source == "gmail"
    assert "jane@upenn.edu" in email.from_addr
    assert "mgandal@gmail.com" in email.to
    assert "bob@chop.edu" in email.cc
    assert email.subject == "Grant update"
    assert "Hello world" in email.body
    assert "INBOX" in email.labels


def test_normalize_truncates_long_body():
    long_body = "A" * (BODY_MAX_CHARS + 5000)
    import base64
    encoded = base64.urlsafe_b64encode(long_body.encode()).decode()
    raw = {
        "id": "msg-long",
        "threadId": "t1",
        "labelIds": [],
        "payload": {
            "headers": [
                {"name": "From", "value": "test@test.com"},
                {"name": "To", "value": "me@test.com"},
                {"name": "Subject", "value": "Long email"},
                {"name": "Date", "value": "Fri, 11 Apr 2026 10:00:00 -0400"},
            ],
            "body": {"data": encoded},
            "parts": [],
        },
    }
    email = normalize_gmail_message(raw)
    assert len(email.body) == BODY_MAX_CHARS


def test_normalize_missing_headers_uses_defaults():
    raw = {
        "id": "msg-minimal",
        "threadId": "t1",
        "labelIds": [],
        "payload": {
            "headers": [],
            "body": {"data": ""},
            "parts": [],
        },
    }
    email = normalize_gmail_message(raw)
    assert email.from_addr == ""
    assert email.subject == "(no subject)"
    assert email.body == ""
