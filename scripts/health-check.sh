#!/bin/bash
# NanoClaw infrastructure health check.
# Run manually or via cron to catch regressions early.
# Exit 0 = all healthy, exit 1 = failures detected.
#
# Usage: ./scripts/health-check.sh [--quiet]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
QUIET="${1:-}"
FAILURES=0

pass() { [ "$QUIET" != "--quiet" ] && echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAILURES=$((FAILURES + 1)); }
section() { [ "$QUIET" != "--quiet" ] && echo ""; echo "[$1]"; }

# --- Bridge ---
section "Bridge (BrokenPipeError handling)"

if grep -q "except (BrokenPipeError, ConnectionResetError)" "$PROJECT_DIR/tools/bridge/bridge.py"; then
    pass "_send_json has BrokenPipeError guard"
else
    fail "_send_json missing BrokenPipeError guard — client disconnects will crash the bridge"
fi

# --- Credential Proxy ---
section "Credential Proxy (per-request token refresh)"

if grep -q "freshCredentials()" "$PROJECT_DIR/src/credential-proxy.ts"; then
    pass "Proxy uses freshCredentials() for per-request token reads"
else
    fail "Proxy reads credentials at startup only — token refreshes won't take effect"
fi

if grep -q "readEnvFile" "$PROJECT_DIR/src/credential-proxy.ts" | grep -c "readEnvFile" > /dev/null; then
    pass "readEnvFile still imported"
fi

# --- Graceful Restart ---
section "Restart Scripts (graceful bootout+bootstrap)"

for script in refresh-api-key.sh refresh-oauth.sh; do
    if grep -q "bootout" "$PROJECT_DIR/scripts/$script"; then
        pass "$script uses graceful bootout+bootstrap"
    else
        fail "$script still uses kickstart -k (SIGKILL) — will cause 401s during token refresh"
    fi
done

# --- Calendar Watcher ---
section "Calendar Watcher"

if grep -q "^CALENDAR_WATCHER_ENABLED=true" "$PROJECT_DIR/.env" 2>/dev/null; then
    pass "Calendar watcher enabled in .env"
else
    fail "CALENDAR_WATCHER_ENABLED not set to true in .env"
fi

# Verify calendar names match icalBuddy (macOS only)
if command -v /opt/homebrew/bin/icalBuddy &>/dev/null; then
    CALENDARS=$(/opt/homebrew/bin/icalBuddy calendars 2>/dev/null)
    for cal in MJG Outlook Gandal_Lab_Meetings; do
        if echo "$CALENDARS" | grep -q "• $cal"; then
            pass "Calendar '$cal' exists in icalBuddy"
        else
            fail "Calendar '$cal' not found in icalBuddy — watcher will fail"
        fi
    done
fi

# --- Ollama / SimpleMem ---
section "Ollama (SimpleMem LLM backend)"

if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    pass "Ollama is running"
    if curl -sf http://localhost:11434/api/tags 2>/dev/null | python3 -c "import json,sys; models=[m['name'] for m in json.load(sys.stdin)['models']]; sys.exit(0 if any('llama3.1' in m for m in models) else 1)" 2>/dev/null; then
        pass "llama3.1 model available"
    else
        fail "llama3.1 model not found — SimpleMem query synthesis will fail"
    fi
else
    fail "Ollama not running — SimpleMem will fail"
fi

# --- Summary ---
echo ""
if [ "$FAILURES" -eq 0 ]; then
    echo "All checks passed."
    exit 0
else
    echo "$FAILURES check(s) failed."
    exit 1
fi
