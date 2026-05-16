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

# 4. Gmail credentials valid (source: mgandal@gmail.com)
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

# 4b. Gmail credentials for upload target (mikejg1838@gmail.com)
# Tests the OAuth token used by Step 1 (Outlook→Gmail). If this token is
# revoked or scope-downgraded, Step 1 silently no-ops; staleness check at
# 7c eventually catches it (8h lag), but this gives an immediate signal.
MIKEJG_CHECK=$($PYTHON3 -c "
import json, sys
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
try:
    raw = json.load(open('$HOME/.google_workspace_mcp/credentials/mikejg1838@gmail.com.json'))
    creds = Credentials(token=raw['token'], refresh_token=raw['refresh_token'],
                        token_uri=raw['token_uri'], client_id=raw['client_id'],
                        client_secret=raw['client_secret'], scopes=raw['scopes'])
    if creds.expired or not creds.valid:
        creds.refresh(Request())
    if not any(s.endswith('gmail.modify') for s in (creds.scopes or [])):
        print(f'token missing gmail.modify scope (have: {creds.scopes})'); sys.exit(1)
    print('OK')
except FileNotFoundError:
    print('credentials file missing'); sys.exit(1)
except Exception as e:
    print(f'refresh failed: {e}'); sys.exit(1)
" 2>&1)
check "Gmail credentials (mikejg1838 — upload target)" "$MIKEJG_CHECK" $?

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
    # Parse all needed fields in one Python invocation. Outputs:
    #   <timestamp> <bytes_session> <errors_session>
    # Older marker files (pre-2026-04-26) lack the session fields; they're
    # filled with -1 to mean "unknown" and 7d skips the silent-degrade check.
    PARSE=$($PYTHON3 -c "
import json
d = json.load(open('$SUCCESS_FILE'))
print(int(d['timestamp']), d.get('bytes_session', -1), d.get('errors_session', -1))
" 2>/dev/null)
    if [ -n "$PARSE" ]; then
        LAST_SUCCESS=$(echo "$PARSE" | awk '{print $1}')
        BYTES_SESSION=$(echo "$PARSE" | awk '{print $2}')
        ERRORS_SESSION=$(echo "$PARSE" | awk '{print $3}')
        NOW=$(date "+%s")
        AGE_HOURS=$(( (NOW - LAST_SUCCESS) / 3600 ))
        if [ "$AGE_HOURS" -lt 8 ]; then
            check "Outlook→Gmail freshness (<8h)" "" 0
        else
            check "Outlook→Gmail freshness (<8h)" "${AGE_HOURS}h since last success — forwarding may be wedged" 1
        fi
        # 7d. Silent-degrade detection: marker fresh but last run failed every
        # upload it attempted. Catches OAuth scope downgrade, account
        # suspension, etc. that manifest as per-message errors which the
        # script logs but does NOT abort on.
        if [ "$ERRORS_SESSION" -gt 0 ] 2>/dev/null && [ "$BYTES_SESSION" -eq 0 ] 2>/dev/null; then
            check "Outlook→Gmail last run did work" "$ERRORS_SESSION errors and 0 bytes uploaded — silent degrade?" 1
        elif [ "$ERRORS_SESSION" -ge 0 ] 2>/dev/null; then
            check "Outlook→Gmail last run did work" "" 0
        fi
    else
        check "Outlook→Gmail freshness (<8h)" "marker file unparseable — atomic write failed?" 1
    fi
else
    warn "Outlook→Gmail freshness" "no last-success marker yet (first run after install?)"
fi

# 7e. Notes export freshness — flag if notes export dir hasn't been
# rewritten in >24h. Catches the failure mode where notes-export-step.sh
# silently skips forever (Notes always frontmost, gtimeout missing,
# atomic-rename failing, etc.) and QMD ingests stale notes for days.
# Original 2026-05-16 incident: when Step 5 was inline and pinned Notes
# for 30 minutes, the user saw it. If a future bug causes Step 5 to
# silently skip, only this check will catch it.
NOTES_EXPORT_DIR="$HOME/.cache/apple-notes-mcp/exported"
if [ -d "$NOTES_EXPORT_DIR" ]; then
    # mtime of the directory itself updates on atomic-rename
    NOTES_MTIME=$(stat -f %m "$NOTES_EXPORT_DIR" 2>/dev/null)
    if [ -n "$NOTES_MTIME" ]; then
        NOW=$(date "+%s")
        NOTES_AGE_HOURS=$(( (NOW - NOTES_MTIME) / 3600 ))
        # Threshold: 24h. Notes export runs every 4h via sync-all.sh; 24h
        # means 5+ ticks have skipped or failed. The skip-when-frontmost
        # guard could legitimately delay it a few hours during a long
        # work session, but >24h means something is structurally wrong.
        if [ "$NOTES_AGE_HOURS" -lt 24 ]; then
            check "Notes export freshness (<24h)" "" 0
        else
            check "Notes export freshness (<24h)" "${NOTES_AGE_HOURS}h since last successful export — Step 5 may be wedged or always skipping" 1
        fi
    else
        check "Notes export freshness (<24h)" "stat of $NOTES_EXPORT_DIR failed" 1
    fi
else
    warn "Notes export freshness" "$NOTES_EXPORT_DIR does not exist (first run?)"
fi

# 7f. notes-export-step.sh present (regression guard — sync-all.sh Step 5
# depends on this; if someone reverts the 2026-05-16 hardening, this fires)
NOTES_STEP="$SCRIPT_DIR/notes-export-step.sh"
if [ -x "$NOTES_STEP" ]; then
    check "notes-export-step.sh present and executable" "" 0
else
    check "notes-export-step.sh present and executable" "missing — Step 5 hardening may have been reverted" 1
fi

# 7g. gtimeout available (notes-export-step.sh depends on it; bare-PATH
# launchd jobs sometimes can't find /opt/homebrew/bin)
if command -v gtimeout >/dev/null 2>&1; then
    check "gtimeout available (coreutils)" "" 0
else
    check "gtimeout available (coreutils)" "missing — notes export timeout will fail open" 1
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
        # NOTE: deliberately do NOT re-check the prior cycle's error count
        # here. Doing so creates a self-perpetuating wedge: a single failed
        # cycle would cause this pre-flight to fail forever, since sync-all.sh
        # increments ERRORS based on this script's exit code, then writes
        # "errors: N>0" to sync.log, which the next pre-flight reads as
        # "prior cycle failed", etc. The current cycle's errors are already
        # visible in sync.log without a self-referential check (silent-failure
        # wedge anti-pattern, fixed 2026-05-13).
    else
        warn "Sync log" "no SYNC COMPLETE found in log"
    fi
else
    warn "Sync log" "sync.log not found"
fi

# 9. MLX memory governor — flag CASCADE/CRITICAL events in last 4h.
# Governor is observation-only (kill caused the 2026-05-16 panic cascade);
# real-time alerting must come from health-check sweep. See
# project_mlx_panic_20260516.md.
GOV_LOG="$HOME/.hermes/logs/mlx-memory-governor.log"
if [ -f "$GOV_LOG" ]; then
    if [ "$(find "$GOV_LOG" -mmin -240 2>/dev/null)" ]; then
        GOV_HITS=$("$PYTHON3" - "$GOV_LOG" <<'PYEOF'
import sys, re, time, datetime
cutoff = time.time() - 4*3600
pat = re.compile(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[MLX_GOV (CRITICAL|CASCADE)\]')
n = 0
with open(sys.argv[1]) as f:
    for line in f:
        m = pat.search(line)
        if not m: continue
        ts = datetime.datetime.strptime(m.group(1), '%Y-%m-%d %H:%M:%S').timestamp()
        if ts >= cutoff: n += 1
print(n)
PYEOF
)
        if [ "${GOV_HITS:-0}" -gt 0 ]; then
            warn "MLX memory governor" "$GOV_HITS CRITICAL/CASCADE events in last 4h — check $GOV_LOG"
        else
            check "MLX memory governor" "" 0
        fi
    else
        warn "MLX memory governor" "log not updated in last 4h — governor may be stalled"
    fi
else
    warn "MLX memory governor" "log not found at $GOV_LOG"
fi

# 10. MLX watchdog RESTART events in last 4h — early warning of kill-storm.
for WDOG in qwen36-a3b qwen25-vl-32b; do
    WLOG="$HOME/.hermes/logs/mlx-watchdog-$WDOG.log"
    if [ -f "$WLOG" ] && [ "$(find "$WLOG" -mmin -240 2>/dev/null)" ]; then
        RESTART_HITS=$("$PYTHON3" - "$WLOG" <<'PYEOF'
import sys, re, time, datetime
cutoff = time.time() - 4*3600
pat = re.compile(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] RESTART triggered')
n = 0
with open(sys.argv[1]) as f:
    for line in f:
        m = pat.search(line)
        if not m: continue
        ts = datetime.datetime.strptime(m.group(1), '%Y-%m-%d %H:%M:%S').timestamp()
        if ts >= cutoff: n += 1
print(n)
PYEOF
)
        if [ "${RESTART_HITS:-0}" -ge 2 ]; then
            check "MLX watchdog $WDOG" "$RESTART_HITS RESTART events in last 4h — possible kill-storm" 1
        elif [ "${RESTART_HITS:-0}" -eq 1 ]; then
            warn "MLX watchdog $WDOG" "1 RESTART event in last 4h"
        else
            check "MLX watchdog $WDOG" "" 0
        fi
    fi
done

echo "──────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed, $WARN warnings"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
