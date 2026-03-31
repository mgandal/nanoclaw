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

# 1. SimpleMem reachable
SM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8200/ 2>/dev/null)
if [ "$SM_STATUS" != "000" ]; then
    check "SimpleMem reachable (port 8200)" "" 0
else
    check "SimpleMem reachable (port 8200)" "connection refused" 1
fi

# 2. SimpleMem MCP initialize works
SM_INIT=$($PYTHON3 -c "
import json, sys
from urllib.parse import parse_qs, urlparse
import requests

with open('$NANOCLAW_DIR/.env') as f:
    for line in f:
        if line.startswith('SIMPLEMEM_URL='):
            url = line.strip().split('=', 1)[1]
            break
    else:
        print('SIMPLEMEM_URL not in .env'); sys.exit(1)

parsed = urlparse(url)
token = parse_qs(parsed.query).get('token', [''])[0]
base_url = f'{parsed.scheme}://{parsed.hostname}:{parsed.port}/mcp/message'
headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
resp = requests.post(base_url, headers=headers, json={
    'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
    'params': {'protocolVersion': '2024-11-05', 'capabilities': {},
               'clientInfo': {'name': 'health-check', 'version': '1.0'}}
}, timeout=10)
data = resp.json()
if 'result' in data:
    print('OK: ' + data['result'].get('serverInfo', {}).get('name', '?'))
else:
    print('ERROR: ' + json.dumps(data)[:100]); sys.exit(1)
" 2>&1)
check "SimpleMem MCP initialize" "$SM_INIT" $?

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

# 4. Gmail credentials valid
GMAIL_CHECK=$($PYTHON3 -c "
import json, sys
from google.oauth2.credentials import Credentials
cred_path = '/Users/mgandal/.google_workspace_mcp/credentials/mgandal@gmail.com.json'
try:
    creds = Credentials.from_authorized_user_file(cred_path)
    if creds.expired:
        print('token expired (will auto-refresh)')
    else:
        print('OK')
except Exception as e:
    print(str(e)); sys.exit(1)
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
