#!/bin/bash
# Sync pipeline health check — verifies each component is reachable and functional.
# Run manually or from sync-all.sh to catch failures early.
#
# Exit codes:
#   0 = all checks pass
#   1 = one or more checks failed (details on stdout)
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON3="/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3"
NANOCLAW_DIR="$SCRIPT_DIR/../.."

PASS=0
FAIL=0
WARN=0

check() {
    local name="$1"
    local result="$2"
    local ec="$3"
    if [ "$ec" -eq 0 ]; then
        echo "  ✓ $name"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $name — $result"
        FAIL=$((FAIL + 1))
    fi
}

warn() {
    local name="$1"
    local msg="$2"
    echo "  ⚠ $name — $msg"
    WARN=$((WARN + 1))
}

echo "Sync Health Check: $(date)"
echo "──────────────────────────────────"

# SimpleMem checks removed 2026-04-20 — SimpleMem was decommissioned and
# replaced by Honcho. The persistent FAILs were confusing real health signals.

# 3. QMD reachable (any HTTP response means the daemon is up)
QMD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8181/mcp -X POST -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
if [ "$QMD_STATUS" != "000" ]; then
    check "QMD reachable (port 8181)" "" 0
else
    check "QMD reachable (port 8181)" "connection refused" 1
fi

# 3b. QMD embed works (sqlite-vec available under node runtime)
QMD_EMBED=$(BUN_INSTALL= qmd embed --dry-run 2>&1 || BUN_INSTALL= qmd embed 2>&1)
if echo "$QMD_EMBED" | grep -qiE 'sqlite-vec|segmentation|panic|crash'; then
    check "QMD embed (sqlite-vec)" "runtime crash — check BUN_INSTALL" 1
else
    check "QMD embed (sqlite-vec)" "" 0
fi

# 3c. Ollama has required models (phi4-mini, nomic-embed-text)
# email-ingest.py uses phi4-mini for classification; QMD embed uses nomic-embed-text.
# A fresh ollama install or an accidental ~/.ollama wipe silently breaks both.
OLLAMA_TAGS=$(curl -sf --max-time 5 http://localhost:11434/api/tags 2>/dev/null || echo "")
if [ -z "$OLLAMA_TAGS" ]; then
    check "Ollama reachable (port 11434)" "daemon not reachable" 1
else
    check "Ollama reachable (port 11434)" "" 0
    for MODEL in phi4-mini nomic-embed-text; do
        if echo "$OLLAMA_TAGS" | grep -q "\"name\":\"${MODEL}:"; then
            check "Ollama model: $MODEL" "" 0
        else
            check "Ollama model: $MODEL" "not installed — run: ollama pull $MODEL" 1
        fi
    done
fi

# 4. Gmail credentials valid
GMAIL_CHECK=$($PYTHON3 -c "
import json, sys
import sys
sys.path.insert(0, '$NANOCLAW_DIR/scripts/sync')
from email_ingest.gmail_adapter import GmailAdapter
g = GmailAdapter()
if g.connect():
    print('OK via gmail_adapter fallback chain')
else:
    print('no working credentials in fallback chain'); sys.exit(1)
" 2>&1)
check "Gmail credentials (mgandal)" "$GMAIL_CHECK" $?

# 5. Vault path accessible
if [ -d "/Volumes/sandisk4TB/marvin-vault" ]; then
    VAULT_COUNT=$(ls /Volumes/sandisk4TB/marvin-vault/*.md 2>/dev/null | wc -l)
    if [ "$VAULT_COUNT" -gt 0 ]; then
        check "Vault path accessible" "" 0
    else
        check "Vault path accessible" "path exists but no .md files found" 1
    fi
else
    check "Vault path accessible" "/Volumes/sandisk4TB/marvin-vault not mounted" 1
fi

# 6. State files exist and are valid JSON
for sf in gmail-sync-state.json vault-ingest-state.json claude-history-state.json telegram-history-state.json apple-notes-ingest-state.json; do
    FULL="$SCRIPT_DIR/$sf"
    if [ -f "$FULL" ]; then
        $PYTHON3 -c "import json; json.load(open('$FULL'))" 2>/dev/null
        if [ $? -eq 0 ]; then
            check "State file: $sf" "" 0
        else
            check "State file: $sf" "invalid JSON" 1
        fi
    else
        warn "State file: $sf" "not found (first run?)"
    fi
done

# 7. Python dependencies
$PYTHON3 -c "import requests, google.oauth2" 2>/dev/null
check "Python deps (requests, google-auth)" "missing — run pip install" $?

# 7b. email-migrate.py exists (Step 1 of sync-all.sh depends on this)
MIGRATE_SCRIPT="$SCRIPT_DIR/email-migrate.py"
if [ -f "$MIGRATE_SCRIPT" ]; then
    check "email-migrate.py present" "" 0
else
    check "email-migrate.py present" "missing at $MIGRATE_SCRIPT — Outlook→Gmail forwarding will be a no-op" 1
fi

# 7c. Outlook→Gmail forwarding is fresh (last-success marker within 8h)
SUCCESS_FILE="$HOME/.cache/email-migrate/last-success.json"
if [ -f "$SUCCESS_FILE" ]; then
    LAST_SUCCESS=$($PYTHON3 -c "import json; print(int(json.load(open('$SUCCESS_FILE'))['timestamp']))" 2>/dev/null)
    NOW=$(date "+%s")
    if [ -n "$LAST_SUCCESS" ]; then
        AGE_HOURS=$(( (NOW - LAST_SUCCESS) / 3600 ))
        if [ "$AGE_HOURS" -lt 8 ]; then
            check "Outlook→Gmail freshness (<8h)" "" 0
        else
            check "Outlook→Gmail freshness (<8h)" "${AGE_HOURS}h since last success — forwarding may be wedged" 1
        fi
    else
        warn "Outlook→Gmail freshness" "marker file present but unparseable"
    fi
else
    warn "Outlook→Gmail freshness" "no last-success marker yet (first run after install?)"
fi

# 8. Check last sync completed recently (within 24h)
if [ -f "$SCRIPT_DIR/sync.log" ]; then
    LAST_COMPLETE=$(grep 'SYNC COMPLETE' "$SCRIPT_DIR/sync.log" | tail -1)
    if [ -n "$LAST_COMPLETE" ]; then
        # Extract date from log line
        LAST_DATE=$(echo "$LAST_COMPLETE" | grep -oE '[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]+ [0-9:]+ [A-Z]+ [0-9]+')
        LAST_EPOCH=$(date -j -f "%a %b %d %H:%M:%S %Z %Y" "$LAST_DATE" "+%s" 2>/dev/null || echo 0)
        NOW_EPOCH=$(date "+%s")
        AGE_HOURS=$(( (NOW_EPOCH - LAST_EPOCH) / 3600 ))
        if [ "$AGE_HOURS" -lt 24 ]; then
            check "Last sync within 24h" "" 0
        else
            warn "Last sync age" "${AGE_HOURS}h ago — expected every 8h"
        fi
        # Check error count from last run
        LAST_ERRORS=$(echo "$LAST_COMPLETE" | grep -oE 'errors: [0-9]+' | grep -oE '[0-9]+')
        if [ "$LAST_ERRORS" = "0" ]; then
            check "Last sync error-free" "" 0
        else
            check "Last sync error-free" "$LAST_ERRORS errors in last run" 1
        fi
    else
        warn "Sync log" "no SYNC COMPLETE found in log"
    fi
else
    warn "Sync log" "sync.log not found"
fi

echo "──────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed, $WARN warnings"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
