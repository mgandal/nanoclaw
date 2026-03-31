#!/bin/bash
# Master sync script: email + calendar + SimpleMem ingest
# Runs every 8 hours via launchd
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

# --- Step 1: Exchange email → mikejg1838@gmail.com ---
# DISABLED: Migration completed (1.4GB uploaded, last run 2026-03-21).
# Cannot run from launchd — requires Full Disk Access to read ~/Library/Mail/V10/.
# Has failed every run since installation. Run manually if needed:
#   python3 /Users/mgandal/Agents/marvin2/scripts/email-migrate.py
echo ""
echo "[1/11] Exchange email sync... SKIPPED (migration complete, requires Full Disk Access)"

# --- Step 2: Gmail sync (mgandal → mikejg1838) ---
echo ""
echo "[2/11] Gmail sync: mgandal@gmail.com → mikejg1838@gmail.com..."
$PYTHON3 "$SCRIPT_DIR/gmail-sync.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[2/11] WARNING: Gmail sync had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 3: Calendar sync (DISABLED — clear-and-rewrite triggers repeated attendee notifications) ---
echo ""
echo "[3/11] Calendar sync... SKIPPED (disabled — causes repeated email notifications)"

# --- Step 4: SimpleMem email ingest ---
echo ""
echo "[4/11] SimpleMem email ingest..."
$PYTHON3 "$SCRIPT_DIR/simplemem-ingest.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[4/11] WARNING: SimpleMem ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 5: Claude history → SimpleMem ---
echo ""
echo "[5/11] Claude history → SimpleMem..."
$PYTHON3 "$SCRIPT_DIR/claude-history-ingest.py" --max-sessions 20 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[5/11] WARNING: Claude history ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 6: Telegram history → SimpleMem ---
echo ""
echo "[6/11] Telegram history → SimpleMem..."
$PYTHON3 "$SCRIPT_DIR/telegram-history-ingest.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[6/11] WARNING: Telegram history ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 7: QMD update (re-scan collections for new/changed files) ---
echo ""
# BUN_INSTALL in ~/.bash_profile causes qmd's shim to use bun instead of node,
# which crashes on sqlite-vec extension loading. Force node runtime.
echo "[7/11] QMD update..."
if command -v qmd &>/dev/null; then
    BUN_INSTALL= qmd update 2>&1
    EC=$?
    if [ $EC -ne 0 ]; then
        echo "[7/11] WARNING: QMD update had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[7/11] SKIP: qmd not found in PATH"
fi

# --- Step 8: QMD embed (vectorize pending docs) ---
echo ""
echo "[8/11] QMD embed..."
if command -v qmd &>/dev/null; then
    BUN_INSTALL= qmd embed 2>&1
    EC=$?
    if [ $EC -ne 0 ]; then
        echo "[8/11] WARNING: QMD embed had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[8/11] SKIP: qmd not found in PATH"
fi

# --- Step 9: Vault → SimpleMem ingest ---
echo ""
echo "[9/11] Vault → SimpleMem ingest..."
$PYTHON3 "$SCRIPT_DIR/vault-ingest.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[9/11] WARNING: Vault ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 10: Re-export Apple Notes to markdown ---
echo ""
echo "[10/11] Apple Notes re-export..."
EXPORT_SCRIPT="$HOME/.cache/apple-notes-mcp/export-notes.js"
if [ -f "$EXPORT_SCRIPT" ]; then
    osascript -e 'tell application "Notes" to activate' 2>/dev/null
    sleep 2
    node "$EXPORT_SCRIPT" 2>&1 | tail -5
    EC=$?
    osascript -e 'tell application "Notes" to quit' 2>/dev/null
    if [ $EC -ne 0 ]; then
        echo "[10/11] WARNING: Apple Notes export had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[10/11] SKIP: export-notes.js not found"
fi

# --- Step 11: Apple Notes → SimpleMem ingest ---
echo ""
echo "[11/11] Apple Notes → SimpleMem ingest..."
$PYTHON3 "$SCRIPT_DIR/apple-notes-ingest.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[11/11] WARNING: Apple Notes ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
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
