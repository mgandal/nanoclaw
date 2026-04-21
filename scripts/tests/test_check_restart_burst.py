"""Tests for scripts/check-restart-burst.sh.

Focus: Telegram alert path robustness. Specifically, the "group chat upgraded
to supergroup" migration (HTTP 400 with `migrate_to_chat_id`) silently
blackholed every watchdog alert for weeks in production — we caught it by
accident, not by instrumentation. These tests lock in the fix.

Strategy: mock `curl` by shadowing it via PATH. The mock is a Python script
that prints canned responses keyed on the chat_id in the request body.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check-restart-burst.sh"

# A chat ID that the mock will treat as "migrated". Our fake Telegram API
# responds with 400 + migrate_to_chat_id pointing at MIGRATED_CHAT_ID.
STALE_CHAT_ID = "-5217849280"
MIGRATED_CHAT_ID = "-1003829244894"
UNRELATED_CHAT_ID = "-5000000000"  # for "plain failure, no migration" test


def make_mock_curl(tmp_path: Path) -> Path:
    """Create a fake `curl` that emulates the Telegram sendMessage API.

    - If the request body contains STALE_CHAT_ID, return HTTP 400 JSON with
      migrate_to_chat_id=MIGRATED_CHAT_ID. Exit 22 (same as real curl -f on 4xx).
    - If the request body contains MIGRATED_CHAT_ID, return HTTP 200 success.
      Record the successful call to a file so tests can assert delivery.
    - Non-Telegram calls (if any): pass through to real curl.
    """
    mock_bin = tmp_path / "bin"
    mock_bin.mkdir()
    delivery_log = tmp_path / "telegram-deliveries.log"

    mock_curl = mock_bin / "curl"
    # The real script calls curl with -s (not -f) and -w '\n%{http_code}', so
    # the mock must (a) append a newline + HTTP code to the body, and (b) exit
    # 0 even on 4xx (curl -s doesn't set exit code on HTTP errors without -f).
    mock_curl.write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import sys, json, os, pathlib
            DELIVERY_LOG = pathlib.Path({str(delivery_log)!r})
            STALE = {STALE_CHAT_ID!r}
            MIGRATED = {MIGRATED_CHAT_ID!r}

            args = sys.argv[1:]
            body_blob = ""
            is_telegram = any("api.telegram.org" in a for a in args)
            if not is_telegram:
                real = "/usr/bin/curl"
                if os.path.exists(real):
                    os.execv(real, [real] + args)
                sys.exit(0)

            i = 0
            while i < len(args):
                if args[i] in ("-d", "--data", "--data-urlencode"):
                    body_blob += args[i + 1] + "&"
                    i += 2
                else:
                    i += 1

            def respond(body, http_code):
                # Match the script's curl -w '\\n%{{http_code}}' contract: body then
                # newline then 3-digit status code on stdout.
                sys.stdout.write(body + "\\n" + str(http_code))
                sys.exit(0)

            if STALE in body_blob:
                respond(
                    json.dumps({{
                        "ok": False,
                        "error_code": 400,
                        "description": "Bad Request: group chat was upgraded to a supergroup chat",
                        "parameters": {{"migrate_to_chat_id": int(MIGRATED)}},
                    }}),
                    400,
                )
            elif MIGRATED in body_blob:
                with open(DELIVERY_LOG, "a") as f:
                    f.write(body_blob + "\\n")
                respond('{{"ok":true,"result":{{"message_id":1}}}}', 200)
            else:
                with open(DELIVERY_LOG, "a") as f:
                    f.write(body_blob + "\\n")
                respond('{{"ok":true}}', 200)
            """
        )
    )
    mock_curl.chmod(0o755)
    return mock_bin


def make_fake_logs(tmp_path: Path, startup_pid_count: int) -> dict[str, Path]:
    """Synthesize a nanoclaw.log that looks like the real one, with N distinct
    startup PIDs (each printing 'Calendar watcher disabled')."""
    log_dir = tmp_path / "logs"
    log_dir.mkdir()

    nanoclaw_log = log_dir / "nanoclaw.log"
    lines = []
    for i in range(startup_pid_count):
        pid = 10000 + i
        # ANSI colors match the real bun/pino output so the sed strip is exercised.
        lines.append(
            f"[12:00:0{i}.000] \x1b[32mINFO\x1b[39m ({pid}): "
            f"\x1b[36mCalendar watcher disabled (set CALENDAR_WATCHER_ENABLED=true to enable)\x1b[39m"
        )
    # Add some noise so the regex has to filter precisely
    lines.append("[12:01:00.000] \x1b[32mINFO\x1b[39m (99999): \x1b[36mUnrelated message\x1b[39m")
    nanoclaw_log.write_text("\n".join(lines) + "\n")

    err_log = log_dir / "nanoclaw.error.log"
    err_log.write_text(
        "SyntaxError: Export named 'FOO' not found in module '/path/dist/config.js'.\n"
        "error: something minor\n"
    )

    return {"log_dir": log_dir, "nanoclaw_log": nanoclaw_log, "err_log": err_log}


def make_token_file(tmp_path: Path, chat_id: str) -> Path:
    token_file = tmp_path / "watchdog-bot-token"
    token_file.write_text(f"fake-bot-token-12345:ABCDEFGHIJKLMNOPQRSTUVWXYZabc\n{chat_id}\n")
    token_file.chmod(0o600)
    return token_file


def run_detector(
    tmp_path: Path,
    *,
    mock_bin: Path,
    token_file: Path,
    log_dir: Path,
    tail_lines: int = 5000,
    burst_threshold: int = 3,
) -> subprocess.CompletedProcess:
    """Run check-restart-burst.sh in an isolated env pointing at fakes."""
    env = os.environ.copy()
    env["PATH"] = f"{mock_bin}:{env['PATH']}"
    env["HOME"] = str(tmp_path / "home")
    (tmp_path / "home" / ".nanoclaw").mkdir(parents=True, exist_ok=True)
    (tmp_path / "home" / ".config" / "nanoclaw").mkdir(parents=True, exist_ok=True)
    # Redirect where the script looks for the token + state
    env["NANOCLAW_BOT_TOKEN_FILE"] = str(token_file)
    # The script computes NANOCLAW_DIR from its own location, so symlink logs in.
    # We use a sandbox copy of the repo root to isolate logs.
    sandbox = tmp_path / "nanoclaw"
    sandbox.mkdir()
    (sandbox / "scripts").mkdir()
    shutil.copy(SCRIPT, sandbox / "scripts" / SCRIPT.name)
    (sandbox / "scripts" / SCRIPT.name).chmod(0o755)
    shutil.copytree(log_dir, sandbox / "logs")

    env["TAIL_LINES"] = str(tail_lines)
    env["BURST_THRESHOLD"] = str(burst_threshold)

    return subprocess.run(
        ["bash", str(sandbox / "scripts" / SCRIPT.name)],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )


# ---------------------------------------------------------------------------
# The tests
# ---------------------------------------------------------------------------


def test_burst_below_threshold_exits_0_no_alert(tmp_path: Path) -> None:
    """Healthy case: fewer PIDs than threshold ⇒ exit 0, no alert, no state file."""
    mock_bin = make_mock_curl(tmp_path)
    logs = make_fake_logs(tmp_path, startup_pid_count=1)
    token_file = make_token_file(tmp_path, MIGRATED_CHAT_ID)

    result = run_detector(
        tmp_path,
        mock_bin=mock_bin,
        token_file=token_file,
        log_dir=logs["log_dir"],
    )
    assert result.returncode == 0, result.stderr
    # No telegram delivery (nothing to alert)
    assert not (tmp_path / "telegram-deliveries.log").exists()


def test_burst_above_threshold_sends_alert(tmp_path: Path) -> None:
    """Unhealthy case: >= threshold PIDs ⇒ exit 2, alert sent to current chat."""
    mock_bin = make_mock_curl(tmp_path)
    logs = make_fake_logs(tmp_path, startup_pid_count=5)
    token_file = make_token_file(tmp_path, MIGRATED_CHAT_ID)

    result = run_detector(
        tmp_path,
        mock_bin=mock_bin,
        token_file=token_file,
        log_dir=logs["log_dir"],
    )
    assert result.returncode == 2, result.stderr
    deliveries = (tmp_path / "telegram-deliveries.log").read_text()
    assert MIGRATED_CHAT_ID in deliveries
    # Alert payload should reference the SyntaxError from the error log
    assert "SyntaxError" in deliveries


def test_stale_chat_id_triggers_migration_follow(tmp_path: Path) -> None:
    """Supergroup migration: send to STALE_CHAT_ID, get 400 with migrate_to,
    detector MUST follow the hint, retry with MIGRATED_CHAT_ID, AND
    persist the new ID to the token file."""
    mock_bin = make_mock_curl(tmp_path)
    logs = make_fake_logs(tmp_path, startup_pid_count=5)
    token_file = make_token_file(tmp_path, STALE_CHAT_ID)

    result = run_detector(
        tmp_path,
        mock_bin=mock_bin,
        token_file=token_file,
        log_dir=logs["log_dir"],
    )
    # The alert MUST eventually land — either as exit 2 (burst + alert sent) or
    # the script must have updated the token file so NEXT run succeeds.
    # Strongest assertion: delivery actually happened to the migrated ID.
    deliveries_path = tmp_path / "telegram-deliveries.log"
    assert deliveries_path.exists(), (
        f"No Telegram delivery occurred. Detector stderr:\n{result.stderr}\n"
        f"Detector stdout:\n{result.stdout}"
    )
    deliveries = deliveries_path.read_text()
    assert MIGRATED_CHAT_ID in deliveries, "Retry to migrated chat ID never fired"

    # Token file should have been updated (so the parent watchdog benefits too)
    updated = token_file.read_text().splitlines()
    assert updated[1] == MIGRATED_CHAT_ID, (
        f"Token file line 2 still stale: {updated[1]!r}; expected {MIGRATED_CHAT_ID!r}"
    )


def test_migration_follow_preserves_token_line_1(tmp_path: Path) -> None:
    """The bot token (line 1) must survive the rewrite — regression guard."""
    mock_bin = make_mock_curl(tmp_path)
    logs = make_fake_logs(tmp_path, startup_pid_count=5)
    token_file = make_token_file(tmp_path, STALE_CHAT_ID)
    original_token_line = token_file.read_text().splitlines()[0]

    run_detector(
        tmp_path,
        mock_bin=mock_bin,
        token_file=token_file,
        log_dir=logs["log_dir"],
    )

    after = token_file.read_text().splitlines()
    assert after[0] == original_token_line, "Bot token got clobbered during migration rewrite"


def test_migration_follow_atomic_no_partial_write(tmp_path: Path) -> None:
    """Token file rewrite must be atomic — no .tmp/.partial leftovers,
    no truncation on failure. Simplest check: perms preserved, no leftover files."""
    mock_bin = make_mock_curl(tmp_path)
    logs = make_fake_logs(tmp_path, startup_pid_count=5)
    token_file = make_token_file(tmp_path, STALE_CHAT_ID)

    run_detector(
        tmp_path,
        mock_bin=mock_bin,
        token_file=token_file,
        log_dir=logs["log_dir"],
    )

    # No .tmp left behind in the token dir
    leftovers = [p for p in token_file.parent.glob("*.tmp")]
    assert not leftovers, f"Temp files left behind: {leftovers}"
    # Perms still 600
    mode = oct(token_file.stat().st_mode)[-3:]
    assert mode == "600", f"Perms drifted after rewrite: {mode}"
