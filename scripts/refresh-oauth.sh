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

# Check current token in .env
CURRENT_TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)

if [ "$NEW_TOKEN" = "$CURRENT_TOKEN" ]; then
  log "Token unchanged, no update needed"
  exit 0
fi

# Check token expiry
EXPIRES_OK=$(security find-generic-password -s "Claude Code-credentials" -a "mgandal" -w 2>/dev/null \
  | python3 -c "
import json, sys, time
data = json.load(sys.stdin)
expires = data['claudeAiOauth']['expiresAt'] / 1000
remaining_h = (expires - time.time()) / 3600
print(f'{remaining_h:.1f}')
if remaining_h < 0.5:
    sys.exit(1)
" 2>/dev/null)

if [ $? -ne 0 ]; then
  log "WARNING: New token expires in <30min, updating anyway"
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
