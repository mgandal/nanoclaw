"""Tests for the classifier in scripts/audit-telegram-errors.py.

The classifier maps observed log-line / DB-error shapes to one of five buckets:
transient / config / bug / infra / unknown. Rules are regex-first (deterministic,
fast); unmatched lines fall through to the LLM. These tests cover the rule table
for real error shapes observed in logs/nanoclaw.log, logs/nanoclaw.error.log, and
task_run_logs as of 2026-04-20.
"""

import importlib.util
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "audit-telegram-errors.py"


@pytest.fixture(scope="module")
def classify():
    spec = importlib.util.spec_from_file_location("audit_telegram_errors", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.classify


class TestTransient:
    def test_grammy_429_set_my_name(self, classify):
        bucket, _ = classify(
            source="main_log",
            message="Call to 'setMyName' failed! (429: Too Many Requests: retry after 10506)",
            error_type="GrammyError",
        )
        assert bucket == "transient"

    def test_grammy_429_set_my_description(self, classify):
        bucket, _ = classify(
            source="main_log",
            message="Call to 'setMyDescription' failed! (429: Too Many Requests)",
            error_type="GrammyError",
        )
        assert bucket == "transient"

    def test_pool_bot_pre_rename_fallback(self, classify):
        bucket, _ = classify(
            source="main_log",
            message="Failed to pre-rename pinned pool bot (pin kept, will send anyway)",
            error_type=None,
        )
        assert bucket == "transient"

    def test_ollama_fallback_classification(self, classify):
        bucket, _ = classify(
            source="main_log",
            message="Ollama classification failed — using fallback",
            error_type=None,
        )
        assert bucket == "transient"


class TestBugs:
    def test_syntax_error_in_error_log(self, classify):
        bucket, _ = classify(
            source="error_log",
            message="SyntaxError: Export named 'OPS_ALERT_FOLDER' not found in module",
            error_type="SyntaxError",
        )
        assert bucket == "bug"

    def test_await_in_non_async_function(self, classify):
        bucket, _ = classify(
            source="error_log",
            message='"await" can only be used inside an "async" function',
            error_type=None,
        )
        assert bucket == "bug"

    def test_random_error_log_line_is_bug(self, classify):
        """Any line reaching nanoclaw.error.log means launchd captured a crash
        before pino even initialized. Default-to-bug is the right policy —
        whitelist known transient shapes by extending the rule table, not by
        weakening the default."""
        bucket, _ = classify(
            source="error_log",
            message="TypeError: Cannot read properties of undefined (reading 'foo')",
            error_type="TypeError",
        )
        assert bucket == "bug"


class TestConfig:
    def test_guard_script_missing_file(self, classify):
        bucket, _ = classify(
            source="main_log",
            message=(
                "Guard script failed for task task-xxx (telegram_claire): "
                "Guard exit code 2: python3: can't open file "
                "'/workspace/group/scripts/gmail-plus-monitor.py': [Errno 2] No such file or directory"
            ),
            error_type=None,
        )
        assert bucket == "config"


class TestInfra:
    def test_container_timeout_is_infra_and_causal_parent(self, classify):
        bucket, meta = classify(
            source="main_log",
            message="Container timed out after 1800000ms",
            error_type=None,
        )
        assert bucket == "infra"
        assert meta.get("causal_parent") is True, \
            "container timeout should be marked causal_parent so downstream errors can be suppressed"

    def test_anthropic_401_is_infra(self, classify):
        bucket, _ = classify(
            source="task_run_logs",
            message=(
                'Container exited with code 1: rror result: Failed to authenticate. '
                'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'
            ),
            error_type=None,
        )
        assert bucket == "infra"


class TestUnknown:
    def test_unrecognized_main_log_message_is_unknown(self, classify):
        """Truly novel errors should fall through to the LLM pass, not be
        misclassified as bugs. Only nanoclaw.error.log gets default-to-bug."""
        bucket, _ = classify(
            source="main_log",
            message="Some brand-new error we've never seen before, with no matching rule",
            error_type=None,
        )
        assert bucket == "unknown"


class TestPageIndexAdapter:
    """PageIndex adapter failures are common but heterogeneous:
    - 429 rate-limit errors are infra (upstream Anthropic throttling;
      src/pageindex.ts already falls back to flat text, zero user impact)
    - Genuine adapter crashes (missing venv, Python traceback, JSON decode)
      are real bugs that need code changes.
    The rule table must separate these so daily audits don't wake anyone
    for rate-limit blips the system recovered from."""

    def test_pageindex_429_is_infra_not_bug(self, classify):
        bucket, _ = classify(
            source="main_log",
            message=(
                "PageIndex adapter failed — Command failed: .../adapter.py .../doc.pdf\n"
                "Error: API call failed: Error code: 429 - {'type': 'error', "
                "'error': {'type': 'rate_limit_error', 'message': 'Error'}}"
            ),
            error_type=None,
        )
        assert bucket == "infra", (
            "429 rate-limit errors are handled by the pageindex.ts fallback path; "
            "they should not wake anyone"
        )

    def test_pageindex_real_crash_is_bug(self, classify):
        """A genuine adapter crash (no 429, real Python traceback) still
        needs human attention — the fallback path doesn't help if the
        adapter itself is broken."""
        bucket, _ = classify(
            source="main_log",
            message=(
                "PageIndex adapter failed — Command failed: .../adapter.py .../doc.pdf\n"
                "Traceback (most recent call last):\n  File \"adapter.py\", line 247, "
                "in main\n    client = anthropic.Anthropic()\nModuleNotFoundError: "
                "No module named 'anthropic'"
            ),
            error_type=None,
        )
        assert bucket == "bug"


class TestCausalSuppression:
    def test_ollama_abort_after_container_timeout_is_transient_child(self, classify):
        """AbortError on Ollama calls happens downstream of a container timeout —
        the container process being killed cancels in-flight fetches. Rule table
        should classify AbortError on Ollama as transient so it doesn't double-count."""
        bucket, _ = classify(
            source="main_log",
            message="Ollama classification failed — using fallback",
            error_type="AbortError",
        )
        assert bucket == "transient"
