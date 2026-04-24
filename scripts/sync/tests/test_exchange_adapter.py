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


def _preloaded_pipe(data: bytes):
    """Build a real OS pipe that yields `data` then EOF.

    Returns a file object wrapping the read fd. Because it is a real fd,
    `select.select()` in the production path works correctly — fixes the
    breakage of duck-typed fake readers when `_run_exchange` gained a
    select() call in the hanging-child followup.

    For payloads larger than the OS pipe buffer (~64 KB on macOS), a
    daemon writer thread feeds the pipe while the consumer drains. The
    thread closes the write end once all bytes are delivered, signalling
    EOF.
    """
    import os
    import threading
    read_fd, write_fd = os.pipe()
    if not data:
        os.close(write_fd)
        return os.fdopen(read_fd, "rb", buffering=0)

    def _feed():
        try:
            os.write(write_fd, data)
        except BrokenPipeError:
            pass  # consumer closed early (e.g., cap exceeded + kill)
        finally:
            try:
                os.close(write_fd)
            except OSError:
                pass

    threading.Thread(target=_feed, daemon=True).start()
    return os.fdopen(read_fd, "rb", buffering=0)


def _empty_pipe():
    """Build a real OS pipe that is empty and already EOF'd."""
    return _preloaded_pipe(b"")


def test_exchange_stdout_cap_truncates_oversize_output():
    """`_run_exchange` must bound stdout to EXCHANGE_STDOUT_MAX_BYTES and
    return "" for anything bigger. Simulates a runaway bridge."""
    from email_ingest import exchange_adapter as mod
    # Build a fake Popen whose stdout is a real pipe preloaded with >cap bytes.
    oversize = b"X" * (EXCHANGE_STDOUT_MAX_BYTES + 1024)

    class FakePopen:
        def __init__(self, *args, **kwargs):
            self.stdout = _preloaded_pipe(oversize)
            self.stderr = _empty_pipe()
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
            self.stdout = _preloaded_pipe(small_json)
            self.stderr = _empty_pipe()
            self.pid = 99999

        def wait(self, timeout=None):
            return 0

        def kill(self):
            pass

        def terminate(self):
            pass

        def poll(self):
            return 0

    fake_script = MagicMock()
    fake_script.exists.return_value = True
    with patch.object(mod, "EXCHANGE_SCRIPT", fake_script), \
         patch.object(mod.subprocess, "Popen", FakePopen):
        out = mod._run_exchange(["search", "--since", "1"], timeout=5)
    assert out == small_json.decode("utf-8")


# ─────────────────────────────────────────────────
# C17 followup: hanging-child deadline enforcement via select.select
# ─────────────────────────────────────────────────
#
# Prior fix (commit b2a875f3) guarded against runaway STDOUT volume but
# NOT against a child that opens stdout, writes nothing, and hangs. The
# old `proc.stdout.read(64KB)` blocks forever in that scenario because
# the deadline check only runs between reads. Fix: use
# `select.select([stdout], [], [], remaining)` so the read is actually
# bounded by the deadline.


def test_c17_hanging_child_triggers_deadline():
    """A child that opens stdout but never writes must NOT wedge the
    adapter past its timeout. `_run_exchange` should kill + return ""."""
    import os
    import time as time_mod
    from email_ingest import exchange_adapter as mod

    # Real os.pipe(): write end stays open (simulates a child still
    # running, stdout open), read end gets no bytes. select() will
    # block on this fd until the deadline fires, then the loop kills.
    read_fd, write_fd = os.pipe()
    reader = os.fdopen(read_fd, "rb", buffering=0)

    class HangingPopen:
        def __init__(self, *args, **kwargs):
            self.stdout = reader
            self.stderr = _empty_pipe()
            self.pid = 77777
            self._killed = False

        def wait(self, timeout=None):
            # If we get here without a kill first, the test is broken.
            if not self._killed:
                raise AssertionError(
                    "wait() called before kill() — deadline not enforced"
                )
            return -9

        def kill(self):
            self._killed = True

        def poll(self):
            return -9 if self._killed else None

    fake_script = MagicMock()
    fake_script.exists.return_value = True
    # Tight timeout so the test runs fast.
    start = time_mod.time()
    try:
        with patch.object(mod, "EXCHANGE_SCRIPT", fake_script), \
             patch.object(mod.subprocess, "Popen", HangingPopen):
            out = mod._run_exchange(["search", "--since", "1"], timeout=1)
        elapsed = time_mod.time() - start
        # Returned empty string (kill happened) and did not wedge forever.
        assert out == ""
        # Deadline enforcement: must finish near the 1-s timeout, not
        # indefinitely. Allow generous slack (3 s) for CI scheduler jitter.
        assert elapsed < 3.0, f"deadline not enforced: elapsed={elapsed:.2f}s"
    finally:
        try:
            os.close(write_fd)
        except OSError:
            pass
