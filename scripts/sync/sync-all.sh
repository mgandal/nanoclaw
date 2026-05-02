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
    echo "[pre-flight] WARNING: health check reported failures (exit $HEALTH_EC)"
    ERRORS=$((ERRORS + 1))
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
        echo "[1/10] WARNING: Exchange sync timed out after 1800s (lock released)"
        ERRORS=$((ERRORS + 1))
    elif [ $EC -eq 143 ]; then
        # 128 + SIGTERM (15). Sent by `launchctl kickstart -k` mid-step or by
        # launchd's ExitTimeOut. Distinct from a 1800s alarm so the operator
        # can tell "alarm fired" from "we got killed externally."
        echo "[1/10] WARNING: Exchange sync killed (SIGTERM — kickstart -k or launchd ExitTimeOut)"
        ERRORS=$((ERRORS + 1))
    elif [ $EC -ne 0 ]; then
        echo "[1/10] WARNING: Exchange sync had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[1/10] WARNING: $MIGRATE_SCRIPT not found"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 2: Gmail sync (mgandal → mikejg1838) ---
echo ""
echo "[2/10] Gmail sync: mgandal@gmail.com → mikejg1838@gmail.com..."
$PYTHON3 "$SCRIPT_DIR/gmail-sync.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[2/10] WARNING: Gmail sync had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 3: Email knowledge ingestion ---
echo ""
echo "[3/10] Email knowledge ingestion..."
$PYTHON3 "$SCRIPT_DIR/email-ingest.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[3/10] WARNING: Email ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 4: Slack message ingestion (DMs + channels → ~/.cache/slack-ingest/exported) ---
echo ""
echo "[4/10] Slack ingest..."
$PYTHON3 "$SCRIPT_DIR/slack-ingest.py" 2>&1 | tail -5
EC=${PIPESTATUS[0]}
if [ $EC -ne 0 ]; then
    echo "[4/10] WARNING: Slack ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 5: Apple Notes re-export to markdown ---
echo ""
echo "[5/10] Apple Notes re-export..."
EXPORT_SCRIPT="$HOME/.cache/apple-notes-mcp/export-notes.js"
if [ -f "$EXPORT_SCRIPT" ]; then
    osascript -e 'tell application "Notes" to activate' 2>/dev/null
    sleep 2
    node "$EXPORT_SCRIPT" 2>&1 | tail -5
    EC=$?
    osascript -e 'tell application "Notes" to quit' 2>/dev/null
    if [ $EC -ne 0 ]; then
        echo "[5/10] WARNING: Apple Notes export had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[5/10] SKIP: export-notes.js not found"
fi

# ─── Step 6: Skill catalog refresh ───
echo ""
echo "=== [6/10] Skill catalog refresh ==="
bash "$SCRIPT_DIR/skill-catalog-sync.sh"
EC=$?
if [ $EC -ne 0 ]; then
    echo "[6/10] WARNING: Skill catalog sync had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
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
        echo "[7/10] WARNING: QMD update had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[7/10] SKIP: qmd not found in PATH"
fi

# --- Step 8: QMD embed (vectorize pending docs) ---
echo ""
echo "[8/10] QMD embed..."
if command -v qmd &>/dev/null; then
    BUN_INSTALL= qmd embed 2>&1
    EC=$?
    if [ $EC -ne 0 ]; then
        echo "[8/10] WARNING: QMD embed had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
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
        echo "[9/10] WARNING: Trust analyzer had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
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
        echo "[10/10] WARNING: KG ingest had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[10/10] SKIP: ingest_phase1.py not found"
fi

echo ""
echo "=========================================="
echo "SYNC COMPLETE: $(date '+%a %b %d %H:%M:%S %Z %Y') (errors: $ERRORS)"
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

exit $ERRORS
