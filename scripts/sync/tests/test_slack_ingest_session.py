"""Tests for slack-ingest.py MCP session resilience (findings #2-#4).

#2: a RuntimeError from the initialize handshake must not escape mcp_call's
    retry/bounce machinery and abort the whole run.
#3: a non-404 session-expiry signal (e.g. JSON-RPC error in a 200 body, or a
    non-404 HTTP status) must invalidate the cached session, not leave it dead.
#4: after a server bounce, the cached _session_id must be reset so the fresh
    server is re-initialized rather than handed a dead id.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests

_SLACK_PATH = Path(__file__).resolve().parents[1] / "slack-ingest.py"


def _load_slack():
    spec = importlib.util.spec_from_file_location("slack_ingest_under_test", _SLACK_PATH)
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["slack-ingest.py"]
    sys.modules["slack_ingest_under_test"] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


@pytest.fixture
def slack():
    mod = _load_slack()
    mod._session_id = None  # ensure a clean session per test
    yield mod
    mod._session_id = None


def _json_resp(payload: dict, *, status: int = 200, ctype: str = "application/json",
               session_id: str | None = None) -> MagicMock:
    r = MagicMock()
    r.status_code = status
    r.headers = {"Content-Type": ctype}
    if session_id is not None:
        r.headers["Mcp-Session-Id"] = session_id
    r.text = __import__("json").dumps(payload)
    if status >= 400:
        r.raise_for_status.side_effect = requests.exceptions.HTTPError(response=r)
    else:
        r.raise_for_status.return_value = None
    return r


def test_runtime_error_in_handshake_is_recovered_not_aborted(slack):
    """#2: initialize returning no session id raises RuntimeError; mcp_call must
    NOT let it abort the run — it should retry (and eventually bounce)."""
    # Every initialize POST returns 200 but NO Mcp-Session-Id header → RuntimeError.
    bad_init = _json_resp({"jsonrpc": "2.0", "id": 0, "result": {}}, session_id=None)

    with patch.object(slack.requests, "post", return_value=bad_init), \
         patch.object(slack, "_bounce_mcp_server", return_value=False) as bounce, \
         patch.object(slack.time, "sleep"):
        with pytest.raises(Exception):
            slack.mcp_call("tools/call", {"name": "x"}, timeout=5)
    # The run-aborting RuntimeError must have been routed through the retry loop,
    # which exhausts retries and attempts a server bounce.
    bounce.assert_called_once()


def test_non_404_session_expiry_invalidates_session(slack):
    """#3: a non-404 HTTP error (e.g. 400/500) must clear the cached session so
    the next call re-initializes, instead of reusing a dead id forever."""
    slack._session_id = "dead-session"
    err = _json_resp({"error": "session expired"}, status=400)

    with patch.object(slack.requests, "post", return_value=err), \
         patch.object(slack, "_bounce_mcp_server", return_value=False), \
         patch.object(slack.time, "sleep"):
        with pytest.raises(Exception):
            slack.mcp_call("tools/call", {"name": "x"}, timeout=5)
    # After a failed call against a stale session, the cached id must be cleared.
    assert slack._session_id is None


def test_bounce_resets_session_id(slack):
    """#4: after a successful server bounce the cached _session_id must be reset
    so the fresh server is re-initialized, not handed a dead session id."""
    slack._session_id = "stale-before-bounce"
    seen_ids: list = []
    bounced = {"done": False}

    def fake_single(method, params, timeout):
        # Record the session id at each call so we can isolate the post-bounce one.
        seen_ids.append((slack._session_id, bounced["done"]))
        raise requests.exceptions.ConnectionError("still warming")

    def fake_bounce():
        bounced["done"] = True
        return True

    with patch.object(slack, "_single_mcp_call", side_effect=fake_single), \
         patch.object(slack, "_bounce_mcp_server", side_effect=fake_bounce), \
         patch.object(slack.time, "sleep"):
        with pytest.raises(Exception):
            slack.mcp_call("tools/call", {"name": "x"}, timeout=5)

    # The post-bounce attempt (bounced["done"] == True) must see a reset id.
    post_bounce = [sid for sid, after_bounce in seen_ids if after_bounce]
    assert post_bounce, "expected a post-bounce retry call"
    assert post_bounce[0] is None
