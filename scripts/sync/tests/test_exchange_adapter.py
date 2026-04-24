"""Tests for Exchange adapter."""

import json
from unittest.mock import patch, MagicMock
import pytest

from email_ingest.exchange_adapter import (
    ExchangeAdapter, parse_search_output, parse_read_output,
    compute_since_days,
    EXCHANGE_STDOUT_MAX_BYTES,
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


# ─────────────────────────────────────────────────
# C17: cap exchange-mail.sh stdout + schema-validate parse output
# ─────────────────────────────────────────────────
#
# subprocess.run(capture_output=True) previously buffered all stdout
# in memory. A misbehaving Mail bridge or corrupted mailbox producing
# 100 MB of JSON would OOM the ingest. Fix: cap stdout read via
# Popen + bounded read; schema-validate the parsed output.


def test_parse_search_output_rejects_non_list():
    # A bridge that returns {"error": "..."} as a top-level JSON object
    # was previously accepted by json.loads and would crash downstream.
    assert parse_search_output('{"error": "bridge failed"}') == []


def test_parse_search_output_rejects_scalar():
    assert parse_search_output('"just a string"') == []
    assert parse_search_output('42') == []
    assert parse_search_output('null') == []


def test_parse_search_output_accepts_list_of_dicts():
    raw = json.dumps([{"id": "msg1", "subject": "ok"}])
    result = parse_search_output(raw)
    assert len(result) == 1
    assert result[0]["id"] == "msg1"


def test_parse_search_output_drops_non_dict_items():
    # Bridge could return a list with mixed garbage entries.
    raw = json.dumps([
        {"id": "msg1", "subject": "ok"},
        "not a dict",
        42,
        None,
        {"id": "msg2"},
    ])
    result = parse_search_output(raw)
    assert len(result) == 2
    assert {r["id"] for r in result} == {"msg1", "msg2"}


def test_parse_read_output_rejects_non_dict():
    # A bridge that returns a list at the top level for a `read`
    # command is malformed — must not be silently used as a message.
    assert parse_read_output('[1, 2, 3]') == {}
    assert parse_read_output('"string"') == {}
    assert parse_read_output('null') == {}


def test_parse_read_output_accepts_dict():
    raw = json.dumps({"id": "msg1", "subject": "hi"})
    assert parse_read_output(raw)["id"] == "msg1"


def test_exchange_stdout_cap_truncates_oversize_output():
    """`_run_exchange` must bound stdout to EXCHANGE_STDOUT_MAX_BYTES and
    return "" for anything bigger. Simulates a runaway bridge."""
    from email_ingest import exchange_adapter as mod
    # Build a fake Popen that spits out more than the cap
    oversize = b"X" * (EXCHANGE_STDOUT_MAX_BYTES + 1024)

    class FakePopen:
        def __init__(self, *args, **kwargs):
            self.stdout = _FakeReader(oversize)
            self.stderr = _FakeReader(b"")
            self.pid = 99999
            self._killed = False
            self._terminated = False

        def wait(self, timeout=None):
            return 1  # non-zero — but we should already have bailed on cap

        def kill(self):
            self._killed = True

        def terminate(self):
            self._terminated = True

        def poll(self):
            return None

    class _FakeReader:
        def __init__(self, buf):
            self._buf = buf
            self._pos = 0

        def read(self, n=-1):
            if self._pos >= len(self._buf):
                return b""
            if n < 0 or n > len(self._buf) - self._pos:
                chunk = self._buf[self._pos:]
                self._pos = len(self._buf)
            else:
                chunk = self._buf[self._pos:self._pos + n]
                self._pos += n
            return chunk

        def close(self):
            pass

    fake_script = MagicMock()
    fake_script.exists.return_value = True
    with patch.object(mod, "EXCHANGE_SCRIPT", fake_script), \
         patch.object(mod.subprocess, "Popen", FakePopen):
        out = mod._run_exchange(["search", "--since", "1"], timeout=5)
    # Over-cap stdout must return "" so no partial JSON is fed downstream.
    assert out == ""


def test_exchange_stdout_cap_passes_small_output():
    """Under-cap stdout flows through normally."""
    from email_ingest import exchange_adapter as mod
    small_json = json.dumps([{"id": "m1"}]).encode("utf-8")

    class FakePopen:
        def __init__(self, *args, **kwargs):
            self.stdout = _FakeReader(small_json)
            self.stderr = _FakeReader(b"")
            self.pid = 99999

        def wait(self, timeout=None):
            return 0

        def kill(self):
            pass

        def terminate(self):
            pass

        def poll(self):
            return 0

    class _FakeReader:
        def __init__(self, buf):
            self._buf = buf
            self._pos = 0

        def read(self, n=-1):
            if self._pos >= len(self._buf):
                return b""
            chunk = self._buf[self._pos:]
            self._pos = len(self._buf)
            return chunk

        def close(self):
            pass

    fake_script = MagicMock()
    fake_script.exists.return_value = True
    with patch.object(mod, "EXCHANGE_SCRIPT", fake_script), \
         patch.object(mod.subprocess, "Popen", FakePopen):
        out = mod._run_exchange(["search", "--since", "1"], timeout=5)
    assert out == small_json.decode("utf-8")
