#!/bin/bash
# Master sync script: email + QMD indexing + Apple Notes export
# Runs every 4 hours via launchd
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/sync.log"
PYTHON3="/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3"

# B9: concurrent-run guard. launchd fires every 4h; a slow run (ollama
# classification, gmail rate limit) must not collide with the next tick
# or email-ingest-state.json ends up last-writer-wins.
#
# flock(1) isn't installed on macOS by default (util-linux is a separate
# brew formula); use mkdir atomicity instead — POSIX-guaranteed, zero
# dependencies. The lock dir is cleaned up by the EXIT trap on normal
# exit; a hung previous run would leave the dir behind, so we also
# check the stored PID and break the lock if the holder is dead.
LOCK_DIR="${NANOCLAW_SYNC_LOCK:-/var/tmp/nanoclaw-sync.lock.d}"
if mkdir "$LOCK_DIR" 2>/dev/null; then
  echo $$ > "$LOCK_DIR/pid"
  trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
else
  # Stale lock check: if holder PID is dead, steal the lock.
  if [ -f "$LOCK_DIR/pid" ]; then
    holder=$(cat "$LOCK_DIR/pid" 2>/dev/null)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      echo "[lock] Stale lock from dead PID $holder — breaking" >&2
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR" || exit 0
      echo $$ > "$LOCK_DIR/pid"
      trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
    else
      # Live holder — exit silently. stderr goes to launchd's own log; we
      # intentionally don't write to sync.log here to avoid noise when
      # everything is fine.
      exit 0
    fi
  else
    exit 0
  fi
fi

# Test seam — lets B9 tests verify the lock path without running any
# real sync work. Consumers: scripts/sync/tests/test_sync_lock.bats.
if [ "${HALT_AFTER_LOCK:-}" = "1" ]; then
  echo "HALT_AFTER_LOCK"
  exit 0
fi

# C8: sync logs contain credential paths + tracebacks; mode them 0600
# before we start appending. touch + chmod is idempotent and keeps the
# existing file across runs. Cover all three live logs + two orphans
# (claude-ingest / telegram-ingest) that no writer in-repo references
# today but are world-readable on disk.
LAUNCHD_STDOUT_LOG="$SCRIPT_DIR/launchd-stdout.log"
LAUNCHD_STDERR_LOG="$SCRIPT_DIR/launchd-stderr.log"
for f in "$LOG_FILE" "$LAUNCHD_STDOUT_LOG" "$LAUNCHD_STDERR_LOG" \
         "$SCRIPT_DIR/claude-ingest.log" "$SCRIPT_DIR/telegram-ingest.log"; do
  [ -e "$f" ] || touch "$f"
  chmod 0600 "$f" 2>/dev/null || true
done

# Redirect all output to log (and stdout for launchd)
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "=========================================="
echo "SYNC RUN: $(date)"
echo "=========================================="

# Ensure pip packages are available
export PATH="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export GMAIL_MIGRATE_USER="mikejg1838@gmail.com"

# Two-counter exit classifier (sync-exit-triage 2026-05-16). Replaces
# the legacy `ERRORS=$((ERRORS + 1))` ... `exit $ERRORS` pattern that
# treated all warnings the same and produced exit codes equal to the
# raw warning count. See sync-exit-classifier.sh for the contract.
# shellcheck source=./sync-exit-classifier.sh
source "$SCRIPT_DIR/sync-exit-classifier.sh"
# Back-compat alias so the SYNC COMPLETE summary line can still print
# a total. Recomputed at the end.
ERRORS=0

# --- Pre-flight: verify dependencies are reachable ---
# Health check exit (1 = one or more checks failed) is captured into ERRORS
# so the final banner reflects pre-flight failures. We do NOT hard-abort:
# a failing prerequisite for one step (e.g. Apple Notes unmounted) shouldn't
# block mission-critical steps like Step 1 (Outlook→Gmail forwarding).
# `set -o pipefail` (line 4) ensures the pipe exit reflects the script exit.
echo ""
echo "[pre-flight] Checking sync dependencies..."
bash "$SCRIPT_DIR/sync-health-check.sh" 2>&1 | grep -E '✓|✗|⚠|Results'
HEALTH_EC=${PIPESTATUS[0]}
if [ "$HEALTH_EC" -ne 0 ]; then
    # SOFT: every pre-flight FAIL today is an external-dep flake
    # (Ollama daemon bounce, slack-mcp 404, mikejg token refresh blip,
    # vault unmount, etc.). A hard pre-flight bug — e.g. health-check
    # script itself errored — would surface as EC=2 or higher, but the
    # health-check exits 1 for any failed sub-check by design. We treat
    # all pre-flight as SOFT because the individual step that actually
    # depends on the unhealthy dep will fire its own HARD bump if the
    # dep stays down.
    bump_soft "pre-flight health check reported failures (exit $HEALTH_EC)"
fi
echo ""

# --- Step 1: Exchange email sync (Mac Mail Outlook → mikejg1838@gmail.com) ---
# Reads .emlx files directly from ~/Library/Mail/V10/<EXCHANGE_UUID>/ and
# uploads new ones via Gmail API. Dedupes by emlx filename in
# ~/.cache/email-migrate/email-migration.json. Writes a last-success.json
# marker on clean exit (watched by sync-health-check.sh). Reacts to Gmail
# API quota errors (no preemptive byte cap). Wrapped in `timeout 1800` so
# a hung upload can't wedge the global sync lock for the next 4h tick.
echo ""
echo "[1/10] Exchange email sync (Mac Mail → mikejg1838@gmail.com)..."
MIGRATE_SCRIPT="$SCRIPT_DIR/email-migrate.py"
if [ -f "$MIGRATE_SCRIPT" ]; then
    # Use /usr/bin/perl (Apple-signed platform binary) instead of homebrew
    # `timeout` so TCC's responsibility check resolves to a binary it trusts.
    # See 2026-05-02 incident: gtimeout in /opt/homebrew/Cellar caused
    # Mail.app FDA reads to fail under launchd despite python having FDA.
    /usr/bin/perl -e 'alarm 1800; exec @ARGV' $PYTHON3 "$MIGRATE_SCRIPT" 2>&1
    EC=$?
    if [ $EC -eq 142 ]; then
        bump_soft "[1/10] Exchange sync timed out after 1800s (Mac Mail flaky)"
    elif [ $EC -eq 143 ]; then
        # 128 + SIGTERM (15). Sent by `launchctl kickstart -k` mid-step or by
        # launchd's ExitTimeOut. Distinct from a 1800s alarm so the operator
        # can tell "alarm fired" from "we got killed externally."
        bump_soft "[1/10] Exchange sync killed (SIGTERM — kickstart -k or launchd ExitTimeOut)"
    elif [ $EC -ne 0 ]; then
        # Real script error (traceback, OAuth scope downgrade, etc.) — HARD.
        bump_hard "[1/10] Exchange sync had errors (exit $EC)"
    fi
else
    bump_hard "[1/10] $MIGRATE_SCRIPT not found"
fi

# --- Step 2: Gmail sync (mgandal → mikejg1838) ---
echo ""
echo "[2/10] Gmail sync: mgandal@gmail.com → mikejg1838@gmail.com..."
$PYTHON3 "$SCRIPT_DIR/gmail-sync.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    # Gmail API rate-limits / 5xx are TRANSIENT; real script errors are HARD.
    # gmail-sync.py doesn't currently distinguish, so any nonzero is HARD
    # until we have better signal. False positives surface as a real
    # regression alert — preferable to silent degrade.
    bump_hard "[2/10] Gmail sync had errors (exit $EC)"
fi

# --- Step 3: Email knowledge ingestion ---
# Wrapped in gtimeout because email-ingest.py calls Ollama (phi4-mini for
# classification). If Ollama hangs (see ~/.claude/projects/.../memory/
# project_qwen3_ollama_bug.md — qwen3:8b hangs after first request on
# Ollama 0.20.x), this step would hang indefinitely under launchd. The
# pinning watchdog won't catch it (Ollama hang = python at 0% CPU).
# Same gtimeout-without-foreground pattern as notes-export-step.sh.
# 1200s = 20 min, generous for ~100 emails through classification.
echo ""
echo "[3/10] Email knowledge ingestion..."
gtimeout --kill-after=10 1200 $PYTHON3 "$SCRIPT_DIR/email-ingest.py" 2>&1
EC=$?
case "$EC" in
    0) ;;
    124)
        bump_soft "[3/10] Email ingest timed out after 1200s (Ollama hung?)"
        ;;
    137)
        bump_soft "[3/10] Email ingest hard-killed after 1200s+10s"
        ;;
    143)
        bump_soft "[3/10] Email ingest killed (SIGTERM)"
        ;;
    *)
        # Unexpected nonzero — could be classifier crash, JSON parse, etc. HARD.
        bump_hard "[3/10] Email ingest had errors (exit $EC)"
        ;;
esac

# --- Step 4: Slack message ingestion (DMs + channels → ~/.cache/slack-ingest/exported) ---
echo ""
echo "[4/10] Slack ingest..."
$PYTHON3 "$SCRIPT_DIR/slack-ingest.py" 2>&1 | tail -5
EC=${PIPESTATUS[0]}
if [ $EC -ne 0 ]; then
    # slack-mcp at :8190 is chronically 404/race-conditiony per
    # project_slack_ingest_self_heal.md. Treat as SOFT — operator alerted
    # by the dedicated slack-mcp self-heal task, not by sync exit code.
    bump_soft "[4/10] Slack ingest had errors (exit $EC) — likely slack-mcp flake"
fi

# --- Step 5: Apple Notes re-export to markdown ---
# Delegated to notes-export-step.sh so the step is testable in isolation
# and has its own timeout / skip-if-in-use / atomic-rename discipline.
# Original inline Step 5 (2026-05-16 incident): no timeout, no skip,
# unconditional `activate` foreground-stole the user's session, and
# `export-notes.js` destructively wiped the previous export dir before
# the new run was verified. See notes-export-step.sh for the four
# defense-in-depth layers.
echo ""
echo "[5/10] Apple Notes re-export..."
bash "$SCRIPT_DIR/notes-export-step.sh"
EC=$?
case "$EC" in
    0) ;;  # success or graceful skip
    124|137|143)
        # Notes.app deadlock / killed by external signal. Chronic and
        # benign — previous export is preserved (notes-export-step.sh
        # has the atomic-rename guard).
        bump_soft "[5/10] notes-export-step exited $EC (timeout / killed)"
        ;;
    *)
        # Real script error — missing notes-export-step.sh, malformed
        # JSON output, etc. HARD.
        bump_hard "[5/10] notes-export-step exited $EC"
        ;;
esac

# ─── Step 6: Skill catalog refresh ───
echo ""
echo "=== [6/10] Skill catalog refresh ==="
bash "$SCRIPT_DIR/skill-catalog-sync.sh"
EC=$?
if [ $EC -ne 0 ]; then
    # No external deps — purely local file scan. HARD.
    bump_hard "[6/10] Skill catalog sync had errors (exit $EC)"
fi

# --- Step 7: QMD update (re-scan collections for new/changed files) ---
echo ""
# BUN_INSTALL in ~/.bash_profile causes qmd's shim to use bun instead of node,
# which crashes on sqlite-vec extension loading. Force node runtime.
echo "[7/10] QMD update..."
if command -v qmd &>/dev/null; then
    BUN_INSTALL= qmd update 2>&1
    EC=$?
    if [ $EC -ne 0 ]; then
        # qmd update wraps 16 collection scans; today's chronic failure
        # is the slack collection's `update-cmd` hitting slack-mcp at
        # :8190 (404). One sub-collection flake is SOFT because the
        # other 15 still indexed. A real qmd bug surfaces as EC>1 or
        # repeated failures across collections — operator catches that
        # via run-to-run log diff, not via exit code alone.
        bump_soft "[7/10] QMD update had errors (exit $EC)"
    fi
else
    echo "[7/10] SKIP: qmd not found in PATH"
fi

# --- Step 8: QMD embed (vectorize pending docs) ---
# Wrapped in gtimeout because qmd embed calls Ollama (nomic-embed-text
# or embeddinggemma). Same Ollama-hang risk as Step 3. 600s = 10 min,
# covers typical batches of ~hundreds of doc chunks. Same pattern as
# notes-export-step.sh: gtimeout without --foreground.
echo ""
echo "[8/10] QMD embed..."
if command -v qmd &>/dev/null; then
    gtimeout --kill-after=10 600 env BUN_INSTALL= qmd embed 2>&1
    EC=$?
    case "$EC" in
        0) ;;
        124)
            bump_soft "[8/10] QMD embed timed out after 600s (Ollama hung?)"
            ;;
        137)
            bump_soft "[8/10] QMD embed hard-killed after 600s+10s"
            ;;
        143)
            bump_soft "[8/10] QMD embed killed (SIGTERM)"
            ;;
        134)
            # SIGABRT — sqlite-vec extension crash from BUN_INSTALL leaking
            # in. Per CLAUDE.md sync-area note: BUN_INSTALL= prefix prevents
            # this, but a bad env can still bleed through. HARD because the
            # operator must fix it; retrying won't help.
            bump_hard "[8/10] QMD embed crashed (SIGABRT, exit 134) — check BUN_INSTALL leak"
            ;;
        *)
            bump_hard "[8/10] QMD embed had errors (exit $EC)"
            ;;
    esac
else
    echo "[8/10] SKIP: qmd not found in PATH"
fi

# --- Step 9: Trust promotion analyzer (dry-run; logs candidates) ---
echo ""
echo "[9/10] Trust promotion analysis..."
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if command -v bun &>/dev/null && [ -f "$PROJECT_ROOT/scripts/trust/run-analyzer.ts" ]; then
    (cd "$PROJECT_ROOT" && bun scripts/trust/run-analyzer.ts 2>&1)
    EC=$?
    if [ $EC -ne 0 ]; then
        # Local TS analyzer. No external deps. HARD.
        bump_hard "[9/10] Trust analyzer had errors (exit $EC)"
    fi
else
    echo "[9/10] SKIP: bun or run-analyzer.ts not found"
fi

# --- Step 10: Knowledge Graph Phase 1 re-seed ---
echo ""
echo "[10/10] Knowledge Graph Phase 1 seed..."
if [ -f "$PROJECT_ROOT/scripts/kg/ingest_phase1.py" ]; then
    (cd "$PROJECT_ROOT" && $PYTHON3 scripts/kg/ingest_phase1.py 2>&1)
    EC=$?
    if [ $EC -ne 0 ]; then
        # Local Python over SQLite. No external deps. HARD.
        bump_hard "[10/10] KG ingest had errors (exit $EC)"
    fi
else
    echo "[10/10] SKIP: ingest_phase1.py not found"
fi

echo ""
echo "=========================================="
# Compute final exit code via the two-counter classifier. ERRORS in the
# legacy summary line is now soft+hard so existing log-scrapers
# (sync-health-check.sh, launchd-health-monitor) still see a single
# integer. The classifier_summary line gives the category split.
ERRORS=$((SOFT_ERRORS + HARD_ERRORS))
SYNC_EXIT_CODE=$(compute_exit_code)
echo "SYNC COMPLETE: $(date '+%a %b %d %H:%M:%S %Z %Y') (errors: $ERRORS — $(classifier_summary), exit=$SYNC_EXIT_CODE)"
echo "=========================================="

# C8: trim ALL live sync-area logs if over 1 MB, not just sync.log.
# launchd-stdout.log was previously unrotated — it grew to 1 MB+ and held
# duplicate copies of every `tee`-captured line plus anything written
# before the exec redirect on line 59. Same 5000-line tail + 0600 chmod
# for every file so a rotation does not reset permissions to umask.
for logf in "$LOG_FILE" "$LAUNCHD_STDOUT_LOG" "$LAUNCHD_STDERR_LOG"; do
    [ -f "$logf" ] || continue
    SIZE=$(stat -f%z "$logf" 2>/dev/null || stat -c%s "$logf" 2>/dev/null)
    # Guard against empty $SIZE — stat failure on both macOS and Linux
    # otherwise fires a `[: integer expression expected` stderr. The
    # `2>/dev/null` on the test suppresses that but the exit code still
    # follows the error path, so the rotation is skipped silently.
    if [ -n "$SIZE" ] && [ "$SIZE" -gt 1048576 ] 2>/dev/null; then
        tail -5000 "$logf" > "$logf.tmp" && mv "$logf.tmp" "$logf"
        chmod 0600 "$logf" 2>/dev/null || true
    fi
done

# SYNC_EXIT_CODE was set above by compute_exit_code; preserve it so the
# log rotation block can't override the exit status via a late command.
exit "$SYNC_EXIT_CODE"
