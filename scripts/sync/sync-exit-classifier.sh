# shellcheck shell=bash
# Sync pipeline exit-code classifier.
#
# WHY:
#   sync-all.sh used to `exit $ERRORS` where ERRORS was a raw count of
#   warnings. On a normal day with 3 chronic external-dep flakes
#   (Ollama daemon bouncing, Apple Notes deadlock, slack-mcp 404) the
#   launchd job exited 3 — indistinguishable from "3 hard regressions"
#   to com.nanoclaw.launchd-health-monitor. Result: alert fatigue and
#   a permanently-amber sync job that masked real breakages (e.g. the
#   May 11 exit-2 wedge that stalled the Stage I1 task-closure rollout).
#
# CONTRACT:
#   bump_soft <msg>     — record a transient external-dep flake.
#                          Examples: Ollama unreachable, slack-mcp 404,
#                          Apple Notes osascript ETIMEDOUT, Gmail API
#                          rate-limit.
#   bump_hard <msg>     — record an unexpected internal failure that
#                          warrants investigation. Examples: missing
#                          script, gmail-sync.py traceback, KG ingest
#                          schema mismatch, skill-catalog parse error.
#   classifier_summary  — echo "soft=N hard=M" on stdout (for the
#                          SYNC COMPLETE banner).
#   compute_exit_code   — echo the exit code on stdout:
#                          0  = clean
#                          75 = EX_TEMPFAIL (sysexits.h) — only soft
#                               failures, retry next cycle will likely
#                               clear them
#                          1  = at least one hard failure — real
#                               regression, operator should look
#
#   Both bump_* functions also print a tagged WARNING line so launchd
#   keeps capturing the message in stdout (loudness preserved).
#
# WHY NOT silent-retry/swallow:
#   Per CLAUDE.md feedback_silent_failure_wedge — a guard that masks
#   the bad-state path is the recurring bug in this codebase. Soft
#   failures are still WARNINGs in the log AND still produce a
#   nonzero exit (75 ≠ 0). Downstream monitors can choose to treat
#   75 as expected-flake-day vs 1 as real-regression, but the signal
#   is never lost.

SOFT_ERRORS=0
HARD_ERRORS=0

bump_soft() {
    local msg="$1"
    SOFT_ERRORS=$((SOFT_ERRORS + 1))
    # Print to stdout (sync-all.sh `exec > >(tee -a ...)` puts both
    # stdout and stderr into sync.log). Tag with SOFT so a human
    # grepping sync.log can distinguish categories at a glance.
    echo "  [SOFT WARNING] ${msg}"
}

bump_hard() {
    local msg="$1"
    HARD_ERRORS=$((HARD_ERRORS + 1))
    echo "  [HARD WARNING] ${msg}"
}

classifier_summary() {
    echo "soft=${SOFT_ERRORS} hard=${HARD_ERRORS}"
}

compute_exit_code() {
    if [ "${HARD_ERRORS:-0}" -gt 0 ]; then
        echo 1
    elif [ "${SOFT_ERRORS:-0}" -gt 0 ]; then
        # 75 == EX_TEMPFAIL per /usr/include/sysexits.h. "The system
        # is unable to fulfill the request — try again later."
        echo 75
    else
        echo 0
    fi
}
