#!/bin/bash
# Refresh NanoClaw's OAuth token from Claude Code's keychain entry.
# Claude Code refreshes the token automatically; this script copies
# the latest token into .env and restarts NanoClaw if it changed.
#
# Runs via launchd every hour. No restart needed — credential proxy re-reads
# .env on every request.

set -euo pipefail
LOCKDIR="/tmp/nanoclaw-oauth.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # Stale lock? Remove if older than 5 minutes
  if [ -d "$LOCKDIR" ] && find "$LOCKDIR" -maxdepth 0 -mmin +5 | grep -q .; then
    rmdir "$LOCKDIR" 2>/dev/null || true
    mkdir "$LOCKDIR" 2>/dev/null || { echo "Another OAuth refresh is running, skipping"; exit 0; }
  else
    echo "Another OAuth refresh is running, skipping"; exit 0
  fi
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
LOG_FILE="$SCRIPT_DIR/sync/sync.log"

log() { echo "[$(date '+%H:%M:%S')] [oauth-refresh] $*" >> "$LOG_FILE"; }

# Extract fresh token from macOS keychain (where Claude Code stores it)
NEW_TOKEN=$(security find-generic-password -s "Claude Code-credentials" -a "mgandal" -w 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null)

if [ -z "$NEW_TOKEN" ]; then
  log "ERROR: Could not extract OAuth token from keychain"
  exit 1
fi

# Check token expiry — on EVERY run, before the unchanged-token early exit.
#
# This script cannot renew anything; it only copies whatever Claude Code last
# wrote to the keychain. The keychain token lives ~8h and is refreshed only as
# a side effect of Claude Code running, so any stretch longer than that (e.g.
# overnight) leaves an EXPIRED token that this script happily reports as
# "unchanged, no update needed" while every scheduled task 401s. Checking
# expiry here is the only place that state becomes visible before the failures.
#
# The helper must ALWAYS exit 0 and signal via stdout. Under `set -euo pipefail`
# a `VAR=$(cmd)` whose cmd exits non-zero aborts the whole script at the
# assignment — the previous `sys.exit(1)` on a nearly-expired token killed the
# run *before* it wrote the token to .env, making the `if [ $? -ne 0 ]`
# "updating anyway" branch unreachable. That inverted the intent: the one case
# where a refresh matters most never refreshed. Same failure as 2b541732.
EXPIRES_RAW=$(security find-generic-password -s "Claude Code-credentials" -a "mgandal" -w 2>/dev/null \
  | python3 -c "
import json, sys, time
try:
    data = json.load(sys.stdin)
    expires = data['claudeAiOauth']['expiresAt'] / 1000
    remaining_h = (expires - time.time()) / 3600
    state = 'EXPIRED' if remaining_h <= 0 else ('LOW' if remaining_h < 0.5 else 'OK')
    print(f'{remaining_h:.1f} {state}')
except Exception:
    print('? UNKNOWN')
" 2>/dev/null)

EXPIRES_OK="${EXPIRES_RAW%% *}"
EXPIRES_STATE="${EXPIRES_RAW##* }"

case "$EXPIRES_STATE" in
  EXPIRED)
    log "ERROR: keychain OAuth token EXPIRED ${EXPIRES_OK}h ago — scheduled tasks will 401 until Claude Code refreshes it (run \`claude\` interactively, or re-auth with /login)"
    ;;
  LOW)
    log "WARNING: keychain OAuth token expires in ${EXPIRES_OK}h (<30min)"
    ;;
  UNKNOWN)
    log "WARNING: Could not read token expiry from keychain"
    ;;
esac

# Check current token in .env
CURRENT_TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)

if [ "$NEW_TOKEN" = "$CURRENT_TOKEN" ]; then
  log "Token unchanged (${EXPIRES_OK}h left), no update needed"
  exit 0
fi

# Update .env with new token
python3 -c "
with open('$ENV_FILE') as f:
    lines = f.readlines()
with open('$ENV_FILE', 'w') as f:
    for line in lines:
        if line.startswith('CLAUDE_CODE_OAUTH_TOKEN='):
            f.write('CLAUDE_CODE_OAUTH_TOKEN=$NEW_TOKEN\n')
        else:
            f.write(line)
"

log "Token refreshed (expires in ${EXPIRES_OK}h) — credential proxy picks up new token automatically"

exit 0
