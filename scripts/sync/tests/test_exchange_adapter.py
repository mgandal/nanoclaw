"""Tests for Exchange adapter."""

import json
from unittest.mock import patch, MagicMock
import pytest

from email_ingest.exchange_adapter import (
    ExchangeAdapter, parse_search_output, parse_read_output,
    compute_since_days,
)
from email_ingest.types import BODY_MAX_CHARS


def test_parse_search_output():
    raw_json = json.dumps([
        {"id": "msg1", "subject": "Hello", "from": "jane@upenn.edu",
         "fromName": "Jane", "date": "2026-04-11T14:30", "read": True, "flagged": False},
        {"id": "msg2", "subject": "Grant", "from": "bob@chop.edu",
         "fromName": "Bob", "date": "2026-04-11T10:00", "read": False, "flagged": True},
    ])
    results = parse_search_output(raw_json)
    assert len(results) == 2
    assert results[0]["id"] == "msg1"
    assert results[1]["flagged"] is True


def test_parse_search_output_empty():
    assert parse_search_output("[]") == []
    assert parse_search_output("") == []


def test_parse_read_output():
    raw_json = json.dumps({
        "id": "msg1",
        "subject": "Hello",
        "from": "jane@upenn.edu",
        "fromName": "Jane Doe",
        "date": "2026-04-11T14:30",
        "read": True,
        "flagged": False,
        "to": ["mgandal@upenn.edu"],
        "cc": ["bob@chop.edu"],
        "body": "This is the email body content.",
    })
    result = parse_read_output(raw_json)
    assert result["body"] == "This is the email body content."
    assert result["to"] == ["mgandal@upenn.edu"]


def test_compute_since_days():
    import time
    now = int(time.time())
    # Epoch 7 days ago -> should return 7 (or 8 due to ceiling)
    epoch = now - (7 * 86400)
    days = compute_since_days(epoch)
    assert days in (7, 8)  # ceil may round up


def test_compute_since_days_minimum_1():
    import time
    # Epoch in the future -> minimum 1 day
    days = compute_since_days(int(time.time()) + 3600)
    assert days == 1


def test_body_truncation():
    long_body = "B" * (BODY_MAX_CHARS + 5000)
    raw_json = json.dumps({
        "id": "msg-long", "subject": "Long", "from": "a@b.com",
        "fromName": "A", "date": "2026-04-11T10:00", "read": True,
        "flagged": False, "to": ["me@b.com"], "cc": [],
        "body": long_body,
    })
    result = parse_read_output(raw_json)
    # parse_read_output should NOT truncate -- normalization does
    assert len(result["body"]) > BODY_MAX_CHARS
