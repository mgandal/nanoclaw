#!/bin/bash
# Master sync script: email + QMD indexing + Apple Notes export
# Runs every 4 hours via launchd
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/sync.log"
PYTHON3="/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3"

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
echo ""
echo "[pre-flight] Checking sync dependencies..."
bash "$SCRIPT_DIR/sync-health-check.sh" 2>&1 | grep -E '✓|✗|⚠|Results'
echo ""

# --- Step 1: Exchange email sync (DISABLED — migration complete) ---
echo ""
echo "[1/9] Exchange email sync... SKIPPED (migration complete, requires Full Disk Access)"

# --- Step 2: Gmail sync (mgandal → mikejg1838) ---
echo ""
echo "[2/9] Gmail sync: mgandal@gmail.com → mikejg1838@gmail.com..."
$PYTHON3 "$SCRIPT_DIR/gmail-sync.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[2/9] WARNING: Gmail sync had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 3: Email knowledge ingestion ---
echo ""
echo "[3/9] Email knowledge ingestion..."
$PYTHON3 "$SCRIPT_DIR/email-ingest.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[3/9] WARNING: Email ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 4: Calendar sync (DISABLED — causes repeated email notifications) ---
echo ""
echo "[4/9] Calendar sync... SKIPPED (disabled — causes repeated email notifications)"

# --- Step 5: Apple Notes re-export to markdown ---
echo ""
echo "[5/9] Apple Notes re-export..."
EXPORT_SCRIPT="$HOME/.cache/apple-notes-mcp/export-notes.js"
if [ -f "$EXPORT_SCRIPT" ]; then
    osascript -e 'tell application "Notes" to activate' 2>/dev/null
    sleep 2
    node "$EXPORT_SCRIPT" 2>&1 | tail -5
    EC=$?
    osascript -e 'tell application "Notes" to quit' 2>/dev/null
    if [ $EC -ne 0 ]; then
        echo "[5/9] WARNING: Apple Notes export had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[5/9] SKIP: export-notes.js not found"
fi

# ─── Step 6: Skill catalog refresh ───
echo ""
echo "=== [6/9] Skill catalog refresh ==="
bash "$SCRIPT_DIR/skill-catalog-sync.sh"
EC=$?
if [ $EC -ne 0 ]; then
    echo "[6/9] WARNING: Skill catalog sync had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 7: QMD update (re-scan collections for new/changed files) ---
echo ""
# BUN_INSTALL in ~/.bash_profile causes qmd's shim to use bun instead of node,
# which crashes on sqlite-vec extension loading. Force node runtime.
echo "[7/9] QMD update..."
if command -v qmd &>/dev/null; then
    BUN_INSTALL= qmd update 2>&1
    EC=$?
    if [ $EC -ne 0 ]; then
        echo "[7/9] WARNING: QMD update had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[7/9] SKIP: qmd not found in PATH"
fi

# --- Step 8: QMD embed (vectorize pending docs) ---
echo ""
echo "[8/9] QMD embed..."
if command -v qmd &>/dev/null; then
    BUN_INSTALL= qmd embed 2>&1
    EC=$?
    if [ $EC -ne 0 ]; then
        echo "[8/9] WARNING: QMD embed had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[8/9] SKIP: qmd not found in PATH"
fi

# --- Step 9: Trust promotion analyzer (dry-run; logs candidates) ---
echo ""
echo "[9/9] Trust promotion analysis..."
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if command -v bun &>/dev/null && [ -f "$PROJECT_ROOT/scripts/trust/run-analyzer.ts" ]; then
    (cd "$PROJECT_ROOT" && bun scripts/trust/run-analyzer.ts 2>&1)
    EC=$?
    if [ $EC -ne 0 ]; then
        echo "[9/9] WARNING: Trust analyzer had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[9/9] SKIP: bun or run-analyzer.ts not found"
fi

echo ""
echo "=========================================="
echo "SYNC COMPLETE: $(date) (errors: $ERRORS)"
echo "=========================================="

# Trim log file if over 1MB
if [ -f "$LOG_FILE" ]; then
    SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null)
    if [ "$SIZE" -gt 1048576 ] 2>/dev/null; then
        tail -5000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
fi

exit $ERRORS
