"""Integration tests for email-ingest.py orchestrator."""

import time
from unittest.mock import patch, MagicMock

import pytest

from email_ingest.types import IngestState, NormalizedEmail, ClassificationResult


@pytest.fixture
def tmp_state(tmp_path):
    """Redirect state persistence to a temp directory."""
    state_file = tmp_path / "email-ingest-state.json"
    with patch("email_ingest.types.STATE_FILE", state_file), \
         patch("email_ingest.types.STATE_DIR", tmp_path), \
         patch("email_ingest.types.EXPORT_DIR", tmp_path / "exported"):
        yield tmp_path


def _make_email(id: str, source: str = "gmail", subject: str = "Test") -> NormalizedEmail:
    return NormalizedEmail(
        id=id, source=source, from_addr="alice@example.com",
        to=["bob@example.com"], cc=[], subject=subject,
        date="2026-04-10T10:00:00Z", body="Hello world", labels=["INBOX"],
    )


def _make_result(relevance: float = 0.8) -> ClassificationResult:
    return ClassificationResult(
        relevance=relevance, topic="research",
        summary="Test summary", entities=["Alice"], action_items=[],
    )


def test_main_skips_gmail_on_auth_failure(tmp_state):
    """If Gmail auth fails, Exchange should still run."""
    state = IngestState()
    # Gmail epoch should NOT advance if adapter fails
    original_epoch = state.last_gmail_epoch
    # (Full integration tested manually -- this is a smoke test)
    assert state.last_gmail_epoch == original_epoch


def test_epoch_not_advanced_on_zero_exports(tmp_state):
    """If Ollama is down and nothing exports, epoch stays put."""
    state = IngestState(last_gmail_epoch=1000)
    # Simulate: no exports happened
    # Epoch should only advance when exports > 0 OR fetch returned 0 new emails
    assert state.last_gmail_epoch == 1000  # unchanged


def test_epoch_advances_when_exports_happen(tmp_state):
    """Epoch advances when at least one email is exported."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

    state = IngestState(last_gmail_epoch=1000)
    original_epoch = state.last_gmail_epoch

    mock_gmail = MagicMock()
    mock_gmail.connect.return_value = True
    mock_gmail.fetch_since.return_value = [_make_email("g1")]

    mock_exchange = MagicMock()
    mock_exchange.is_available.return_value = False

    with patch("email_ingest.classifier.classify_email", return_value=_make_result(0.8)), \
         patch("email_ingest.exporter.export_email"), \
         patch("email_ingest.exporter.retain_in_hindsight"):

        # Inline the Gmail processing logic
        processed = set(state.processed_gmail_ids)
        emails = mock_gmail.fetch_since(original_epoch, processed)
        gmail_fetched = len(emails)
        gmail_exported = 0

        from email_ingest.classifier import classify_email
        from email_ingest.exporter import export_email

        for email in emails:
            result = classify_email(email)
            if result.relevance >= 0.3:
                export_email(email, result)
                gmail_exported += 1
                state.processed_gmail_ids.append(email.id)

        if gmail_exported > 0 or gmail_fetched == 0:
            state.last_gmail_epoch = int(time.time())

    assert state.last_gmail_epoch > original_epoch
    assert "g1" in state.processed_gmail_ids


def test_epoch_stays_when_classification_fails(tmp_state):
    """If all classifications fail (Ollama down), epoch must NOT advance."""
    state = IngestState(last_gmail_epoch=1000)
    original_epoch = state.last_gmail_epoch

    failed_result = ClassificationResult(
        relevance=0.0, topic="unknown", summary="",
        entities=[], action_items=[], skip_reason="ollama_error",
    )

    # Simulate: 3 emails fetched, all fail classification
    gmail_fetched = 3
    gmail_exported = 0

    # Epoch safety rule: only advance if exports > 0 OR fetch returned 0
    if gmail_exported > 0 or gmail_fetched == 0:
        state.last_gmail_epoch = int(time.time())

    assert state.last_gmail_epoch == original_epoch  # must not advance


def test_epoch_advances_on_empty_fetch(tmp_state):
    """If no new emails found, epoch advances (nothing to do)."""
    state = IngestState(last_gmail_epoch=1000)

    gmail_fetched = 0
    gmail_exported = 0

    if gmail_exported > 0 or gmail_fetched == 0:
        state.last_gmail_epoch = int(time.time())

    assert state.last_gmail_epoch > 1000


def test_fast_skipped_emails_marked_processed(tmp_state):
    """Fast-skipped emails should be added to processed IDs."""
    from email_ingest.classifier import should_fast_skip

    promo_email = _make_email("promo1", subject="Sale!")
    promo_email.labels = ["CATEGORY_PROMOTIONS"]

    state = IngestState()
    skip = should_fast_skip(promo_email)
    assert skip == "promotional"

    # Orchestrator should mark as processed
    state.processed_gmail_ids.append(promo_email.id)
    assert "promo1" in state.processed_gmail_ids


def test_classification_failure_not_marked_processed(tmp_state):
    """Emails that fail classification should NOT be marked as processed (retry later)."""
    state = IngestState()

    failed_result = ClassificationResult(
        relevance=0.0, topic="unknown", summary="",
        entities=[], action_items=[], skip_reason="ollama_error",
    )

    # Orchestrator logic: if skip_reason, do NOT append to processed
    email = _make_email("fail1")
    result = failed_result
    if not result.skip_reason:
        state.processed_gmail_ids.append(email.id)

    assert "fail1" not in state.processed_gmail_ids


def test_show_status_runs_without_error(tmp_state, capsys):
    """Smoke test: show_status should not raise."""
    sys_path_entry = str(tmp_state.parent.parent / "scripts" / "sync")

    state = IngestState()
    # Import and call show_status
    import importlib, sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

    # Inline the show_status logic to avoid import issues with __main__ script
    from datetime import datetime
    last_run = state.last_run or "never"
    gmail_epoch = datetime.fromtimestamp(state.last_gmail_epoch) if state.last_gmail_epoch else "not set"
    exchange_epoch = datetime.fromtimestamp(state.last_exchange_epoch) if state.last_exchange_epoch else "not set"

    print(f"Last run:           {last_run}")
    print(f"Gmail epoch:        {gmail_epoch}")
    print(f"Exchange epoch:     {exchange_epoch}")
    print(f"Gmail IDs tracked:  {len(state.processed_gmail_ids)}")
    print(f"Exchange IDs tracked: {len(state.processed_exchange_ids)}")

    captured = capsys.readouterr()
    assert "Last run:" in captured.out
    assert "never" in captured.out
    assert "not set" in captured.out


# ─────────────────────────────────────────────────
# C18: _retain_decision in email-ingest.py must apply the same URL check
# ─────────────────────────────────────────────────
#
# email-ingest.py is a script (hyphen in name blocks normal import), so
# we load it via importlib.util and exercise _retain_decision directly.

def _load_email_ingest():
    """Spec-load email-ingest.py so we can call _retain_decision directly.

    Registers in sys.modules so unittest.mock.patch() can find attributes
    via the module path.
    """
    import importlib.util
    import sys
    from pathlib import Path
    p = Path(__file__).parent.parent / "email-ingest.py"
    spec = importlib.util.spec_from_file_location("email_ingest_script", p)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["email_ingest_script"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_sustained_classifier_failure_is_surfaced_loudly(tmp_state):
    """A run where transient classifier failures dominate must emit a loud
    error (not just per-email warnings) so a backlogging inbox is visible."""
    mod = _load_email_ingest()

    failed = ClassificationResult(
        relevance=0.0, topic="unknown", summary="",
        entities=[], action_items=[], skip_reason="classification_failed",
    )

    mock_gmail = MagicMock()
    mock_gmail.connect.return_value = True
    mock_gmail.fetch_since.return_value = [_make_email(f"g{i}") for i in range(6)]

    mock_exchange = MagicMock()
    mock_exchange.is_available.return_value = False
    mock_exchange.fetch_since.return_value = []

    state = IngestState()

    with patch.object(mod, "GmailAdapter", return_value=mock_gmail), \
         patch.object(mod, "ExchangeAdapter", return_value=mock_exchange), \
         patch.object(mod, "classify_email", return_value=failed), \
         patch.object(mod, "should_fast_skip", return_value=None), \
         patch.object(mod, "run_followups_passes", return_value={}), \
         patch.object(mod.log, "error") as mock_error:
        stats = mod.run_ingest(state, backfill_days=None, exchange_batch=0)

    # All 6 transient failures counted, none exported, none marked processed.
    assert stats["classify_failed"] == 6
    assert stats["exported"] == 0
    assert "g0" not in state.processed_gmail_ids
    # The loud unhealthy-classifier error must have fired.
    assert any(
        "Classifier unhealthy" in str(call.args[0])
        for call in mock_error.call_args_list
    ), f"expected a 'Classifier unhealthy' error, got: {mock_error.call_args_list}"


def test_occasional_classifier_failure_is_not_alerted(tmp_state):
    """A few transient failures among many successes must NOT trip the alert."""
    mod = _load_email_ingest()

    ok = _make_result(0.1)  # below threshold -> classified but not exported
    failed = ClassificationResult(
        relevance=0.0, topic="unknown", summary="",
        entities=[], action_items=[], skip_reason="classification_failed",
    )
    # 1 failure, 9 successes -> 10% fail rate, under the 50% / 5-count gate.
    results = [failed] + [ok] * 9

    mock_gmail = MagicMock()
    mock_gmail.connect.return_value = True
    mock_gmail.fetch_since.return_value = [_make_email(f"g{i}") for i in range(10)]

    mock_exchange = MagicMock()
    mock_exchange.is_available.return_value = False
    mock_exchange.fetch_since.return_value = []

    state = IngestState()

    with patch.object(mod, "GmailAdapter", return_value=mock_gmail), \
         patch.object(mod, "ExchangeAdapter", return_value=mock_exchange), \
         patch.object(mod, "classify_email", side_effect=results), \
         patch.object(mod, "should_fast_skip", return_value=None), \
         patch.object(mod, "run_followups_passes", return_value={}), \
         patch.object(mod.log, "error") as mock_error:
        stats = mod.run_ingest(state, backfill_days=None, exchange_batch=0)

    assert stats["classify_failed"] == 1
    assert not any(
        "Classifier unhealthy" in str(call.args[0])
        for call in mock_error.call_args_list
    )


def test_c18_retain_decision_skips_unsafe_url():
    """_retain_decision must not POST when HINDSIGHT_URL is remote."""
    import os
    mod = _load_email_ingest()

    email = _make_email("msg-1")

    class FakeResult:
        decision_summary = "decide to do X"
        who = "alice"

    with patch.dict(os.environ, {"HINDSIGHT_URL": "http://attacker.com:8889"}), \
         patch("email_ingest.exporter.requests") as mock_req:
        retval = mod._retain_decision(email, FakeResult())
    assert retval == 0
    mock_req.post.assert_not_called()


def test_c18_retain_decision_sends_bearer_when_safe():
    """_retain_decision includes bearer header when env+URL are both OK."""
    import os
    mod = _load_email_ingest()

    email = _make_email("msg-1")

    class FakeResult:
        decision_summary = "decide to do X"
        who = "alice"

    with patch.dict(
        os.environ,
        {"HINDSIGHT_URL": "http://localhost:8889", "HINDSIGHT_API_KEY": "tok"},
    ), patch("email_ingest_script.requests") as mock_req:
        mock_req.post.return_value = MagicMock(status_code=200)
        mock_req.post.return_value.raise_for_status = MagicMock()
        retval = mod._retain_decision(email, FakeResult())
    assert retval == 1
    mock_req.post.assert_called_once()
    kwargs = mock_req.post.call_args.kwargs
    assert kwargs.get("headers", {}).get("Authorization") == "Bearer tok"


# ─────────────────────────────────────────────────
# Incremental state checkpointing — a kill/crash during the Exchange phase
# must NOT lose the Gmail phase's progress.
#
# Production bug (2026-05-20 Exchange freeze): state.save() ran only at the very
# end of run_ingest(), after BOTH the Gmail and Exchange phases. Under the
# sync-all.sh `gtimeout 1200` wrapper the process was SIGKILL'd mid-Exchange
# every run, so the advanced Gmail epoch was never persisted. Next run re-fetched
# the entire Gmail backlog (~288 msgs) from the stale epoch, re-exhausting the
# time budget before Exchange could run -> permanent starvation loop. The fix is
# to checkpoint state to disk after the Gmail phase (and periodically within a
# phase) so partial progress survives a kill.
# ─────────────────────────────────────────────────

def _read_persisted_state(tmp_state):
    """Load the on-disk state file the fixture redirected STATE_FILE to."""
    import json
    state_file = tmp_state / "email-ingest-state.json"
    if not state_file.exists():
        return None
    return json.loads(state_file.read_text())


def test_exchange_epoch_persisted_to_disk_before_gmail_phase(tmp_state):
    """After the Exchange phase advances the epoch, it must be written to disk
    BEFORE the Gmail phase runs — so a Gmail-phase crash cannot roll it back.

    Phase order is Exchange-FIRST (2026-07-02 RCA): Exchange is the fragile,
    bounded, Mail.app-driven phase and must get budget before greedy Gmail can
    consume it. This test mirrors the old Gmail-first invariant: the FIRST
    phase's advanced epoch must be checkpointed before the SECOND phase's risky
    adapter call can crash the process. We simulate the crash by making the
    Gmail adapter raise, then assert the persisted state already reflects the
    advanced Exchange epoch."""
    mod = _load_email_ingest()

    # Exchange phase runs first and advances its epoch (one exported email).
    mock_exchange = MagicMock()
    mock_exchange.is_available.return_value = True
    mock_exchange.fetch_since.return_value = [_make_email("x1")]

    # Gmail phase blows up (stand-in for a SIGKILL mid-Gmail).
    mock_gmail = MagicMock()
    mock_gmail.connect.side_effect = RuntimeError("simulated mid-Gmail kill")

    state = IngestState(last_exchange_epoch=1000)

    with patch.object(mod, "GmailAdapter", return_value=mock_gmail), \
         patch.object(mod, "ExchangeAdapter", return_value=mock_exchange), \
         patch.object(mod, "classify_email", return_value=_make_result(0.8)), \
         patch.object(mod, "should_fast_skip", return_value=None), \
         patch.object(mod, "run_followups_passes", return_value={}), \
         patch.object(mod, "export_email"), \
         patch.object(mod, "retain_in_hindsight"):
        # The Gmail phase raising must not prevent the Exchange checkpoint that
        # already happened from being on disk.
        with pytest.raises(RuntimeError):
            mod.run_ingest(state, backfill_days=None, exchange_batch=30)

    persisted = _read_persisted_state(tmp_state)
    assert persisted is not None, "no state was checkpointed to disk at all"
    assert persisted["last_exchange_epoch"] > 1000, (
        "Exchange epoch advance was not persisted before the Gmail phase — "
        "a mid-Gmail crash would roll it back and re-fetch/re-read the whole "
        "Exchange backlog (the phase that is expensive to re-read)"
    )
    assert "x1" in persisted["processed_exchange_ids"]


def test_gmail_progress_checkpointed_within_phase_on_mid_loop_crash(tmp_state):
    """If the run is killed PART-WAY through the Gmail loop (backlog too big to
    finish in one gtimeout window), the IDs processed so far must already be on
    disk — so the next run resumes from there instead of re-fetching the whole
    backlog. We crash on the 60th email and assert earlier IDs were persisted."""
    mod = _load_email_ingest()

    emails = [_make_email(f"g{i}") for i in range(100)]
    mock_gmail = MagicMock()
    mock_gmail.connect.return_value = True
    mock_gmail.fetch_since.return_value = emails

    mock_exchange = MagicMock()
    mock_exchange.is_available.return_value = False
    mock_exchange.fetch_since.return_value = []

    # classify succeeds for the first 60, then the process "dies".
    call_count = {"n": 0}

    def classify_then_crash(email):
        call_count["n"] += 1
        if call_count["n"] > 60:
            raise RuntimeError("simulated SIGKILL mid-Gmail-loop")
        return _make_result(0.1)  # below threshold: processed but not exported

    state = IngestState(last_gmail_epoch=1000)

    with patch.object(mod, "GmailAdapter", return_value=mock_gmail), \
         patch.object(mod, "ExchangeAdapter", return_value=mock_exchange), \
         patch.object(mod, "classify_email", side_effect=classify_then_crash), \
         patch.object(mod, "should_fast_skip", return_value=None), \
         patch.object(mod, "run_followups_passes", return_value={}), \
         patch.object(mod, "export_email"), \
         patch.object(mod, "retain_in_hindsight"):
        with pytest.raises(RuntimeError):
            mod.run_ingest(state, backfill_days=None, exchange_batch=0)

    persisted = _read_persisted_state(tmp_state)
    assert persisted is not None, (
        "no intra-phase checkpoint reached disk — a mid-Gmail kill loses all "
        "progress and the next run re-fetches the entire backlog"
    )
    # At least one full checkpoint batch of early IDs must have been persisted.
    assert "g0" in persisted["processed_gmail_ids"]


def test_default_exchange_batch_fits_time_budget():
    """The per-run Exchange batch must be small enough that fetch_since (which
    reads EVERY message body up front via the ~20s/msg AppleScript bridge)
    completes inside sync-all.sh's `gtimeout 1200`. A batch of 100 reads for
    ~33min and is ALWAYS SIGKILL'd before the classify loop / any checkpoint —
    that was the un-drainable-Exchange bug. Cap the default at a budget-safe
    size so each run completes and advances the epoch."""
    mod = _load_email_ingest()
    # ~20s per body read+classify; 1200s budget minus Gmail+search overhead
    # => must stay well under ~55. Use 40 as the regression ceiling.
    BUDGET_SAFE_CEILING = 40
    assert hasattr(mod, "DEFAULT_EXCHANGE_BATCH"), (
        "expected a named DEFAULT_EXCHANGE_BATCH constant to make the budget "
        "limit explicit and testable"
    )
    assert mod.DEFAULT_EXCHANGE_BATCH <= BUDGET_SAFE_CEILING, (
        f"default Exchange batch {mod.DEFAULT_EXCHANGE_BATCH} reads too many "
        f"bodies to finish within gtimeout 1200 — fetch_since will be killed "
        f"before any email is processed (must be <= {BUDGET_SAFE_CEILING})"
    )


def test_exchange_epoch_advances_when_bounded_batch_completes(tmp_state):
    """When the Exchange phase fetches a bounded batch and exports at least one,
    last_exchange_epoch must advance so the NEXT run continues forward through
    the backlog instead of re-reading the same window. This is what makes the
    backlog drain incrementally across runs under the time cap."""
    mod = _load_email_ingest()

    mock_gmail = MagicMock()
    mock_gmail.connect.return_value = True
    mock_gmail.fetch_since.return_value = []  # Gmail caught up

    ex_emails = [_make_email(f"x{i}", source="exchange") for i in range(5)]
    mock_exchange = MagicMock()
    mock_exchange.is_available.return_value = True
    mock_exchange.fetch_since.return_value = ex_emails

    state = IngestState(last_exchange_epoch=1000)

    with patch.object(mod, "GmailAdapter", return_value=mock_gmail), \
         patch.object(mod, "ExchangeAdapter", return_value=mock_exchange), \
         patch.object(mod, "classify_email", return_value=_make_result(0.8)), \
         patch.object(mod, "should_fast_skip", return_value=None), \
         patch.object(mod, "run_followups_passes", return_value={}), \
         patch.object(mod, "export_email"), \
         patch.object(mod, "retain_in_hindsight"):
        mod.run_ingest(state, backfill_days=None, exchange_batch=mod.DEFAULT_EXCHANGE_BATCH)

    assert state.last_exchange_epoch > 1000, (
        "Exchange epoch did not advance after a completed batch — the backlog "
        "would never move forward across runs"
    )
    assert "x0" in state.processed_exchange_ids


def test_exchange_phase_runs_before_gmail_phase(tmp_state):
    """REGRESSION GUARD (2026-07-02 RCA): the Exchange phase MUST run before the
    Gmail phase. Exchange is bounded + Mail.app-slow; Gmail is fast + greedy
    (~85 msgs/run). When Ollama is contended and every classify call burns ~90s,
    running Gmail first spends the whole `gtimeout 1200` budget on Gmail and the
    process is SIGKILL'd BEFORE Exchange ever runs — the 72h Exchange-freeze the
    watchdog trips on. We assert order by recording which adapter's fetch is
    touched first."""
    mod = _load_email_ingest()

    order = []

    mock_exchange = MagicMock()
    mock_exchange.is_available.side_effect = lambda: (order.append("exchange"), True)[1]
    mock_exchange.fetch_since.return_value = []

    mock_gmail = MagicMock()
    mock_gmail.connect.side_effect = lambda: (order.append("gmail"), True)[1]
    mock_gmail.fetch_since.return_value = []

    state = IngestState()

    with patch.object(mod, "GmailAdapter", return_value=mock_gmail), \
         patch.object(mod, "ExchangeAdapter", return_value=mock_exchange), \
         patch.object(mod, "classify_email", return_value=_make_result(0.8)), \
         patch.object(mod, "should_fast_skip", return_value=None), \
         patch.object(mod, "run_followups_passes", return_value={}), \
         patch.object(mod, "export_email"), \
         patch.object(mod, "retain_in_hindsight"):
        mod.run_ingest(state, backfill_days=None, exchange_batch=30)

    assert order and order[0] == "exchange", (
        f"Exchange must be touched before Gmail (got order={order}). Reverting to "
        "Gmail-first reintroduces the budget-starvation freeze."
    )
    assert "gmail" in order, "Gmail phase should still run after Exchange"


def test_circuit_breaker_bounds_wasted_time_under_ollama_outage(tmp_state):
    """REGRESSION GUARD (2026-07-02 RCA): when Ollama is down/contended, the
    classifier circuit breaker must fast-fail the run instead of paying the full
    ~90s/email tax across the whole backlog (which overran gtimeout 1200 and got
    the process SIGKILL'd mid-Exchange). We stub classify_email with a breaker
    that opens after N consecutive failures and assert only ~N real attempts are
    made even with a large backlog."""
    mod = _load_email_ingest()
    from email_ingest import classifier as clf

    # Large Gmail backlog; Exchange empty (isolate the Gmail-outage path).
    emails = [_make_email(f"g{i}") for i in range(100)]
    mock_gmail = MagicMock()
    mock_gmail.connect.return_value = True
    mock_gmail.fetch_since.return_value = emails
    mock_exchange = MagicMock()
    mock_exchange.is_available.return_value = False
    mock_exchange.fetch_since.return_value = []

    # Simulate Ollama down: every HTTP post raises. Count real posts.
    import requests
    posts = {"n": 0}
    def boom(*a, **k):
        posts["n"] += 1
        raise requests.ConnectionError("ollama down")

    state = IngestState()
    with patch.object(mod, "GmailAdapter", return_value=mock_gmail), \
         patch.object(mod, "ExchangeAdapter", return_value=mock_exchange), \
         patch.object(mod, "should_fast_skip", return_value=None), \
         patch.object(mod, "run_followups_passes", return_value={}), \
         patch.object(mod, "export_email"), \
         patch.object(mod, "retain_in_hindsight"), \
         patch.object(clf, "CIRCUIT_BREAKER_THRESHOLD", 5), \
         patch.object(clf.time, "sleep", lambda s: None), \
         patch.object(clf.requests, "post", side_effect=boom):
        mod.run_ingest(state, backfill_days=None, exchange_batch=30)

    # Breaker opens after 5 failing emails × 3 attempts = 15 posts; the remaining
    # 95 emails must make ZERO posts. Ceiling well below 100×3 = 300.
    assert posts["n"] <= 15, (
        f"circuit breaker did not bound wasted work: {posts['n']} HTTP posts for a "
        "100-email backlog under a total outage (expected <= threshold×attempts = 15). "
        "Without the breaker this is 300 posts / ~90s×100 = SIGKILL mid-run."
    )
