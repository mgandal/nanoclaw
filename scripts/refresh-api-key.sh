#!/bin/bash
# Refresh NanoClaw's Claude Code OAuth token in .env.
#
# ROBUST PATH (2026-07-14 rewrite): renew claude's keychain token via `claude -p`,
# then copy the fresh accessToken into .env. This REPLACES the old HTTP
# capture-proxy mechanism, which used Python `server.serve_forever()` with an
# ignored `server.timeout` and HUNG INDEFINITELY (23.5h wedge on 2026-07-13,
# PID 80295) whenever the inner `claude -p` made no request to the proxy
# (i.e. whenever claude itself was logged out / couldn't silently refresh).
# A wedged run held launchd's slot so NO subsequent 4h renewal could fire,
# causing recurring keychain expiry -> nanoclaw 401s.
#
# Guarantees now:
#   - HARD `timeout` on the only blocking call -> can never wedge the slot again.
#   - Expired-token guard -> refuses to clobber a good .env with a dead token.
#   - Copier-only for the token (keychain is source of truth), same as refresh-oauth.sh.
#
# Runs via launchd (com.nanoclaw.key-refresh) every 4h. Credential proxy re-reads
# .env per request, so no container restart is required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
LOG="$SCRIPT_DIR/../logs/key-refresh.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

kc_field() {  # $1 = accessToken | expiresAt-minutes-remaining
  security find-generic-password -s "Claude Code-credentials" -a "mgandal" -w 2>/dev/null \
    | python3 -c "
import json,sys,time
d=json.load(sys.stdin)['claudeAiOauth']
if '$1'=='token': print(d.get('accessToken',''))
else: print(int((d.get('expiresAt',0)/1000 - time.time())/60))
" 2>/dev/null
}

log "Starting API key refresh (renew keychain + sync)"

# 1. Renew claude's own keychain OAuth token (non-interactive when the refresh
#    token is still alive). HARD timeout so this can NEVER wedge the launchd slot.
if ! timeout 60 claude -p "ok" --max-turns 1 >/dev/null 2>&1; then
  log "WARNING: 'claude -p' returned non-zero (logged out or rate-limited) — will still try to sync if keychain token is valid"
fi

# 2. Extract fresh token from keychain (source of truth).
NEW_KEY=$(kc_field token)
if [ -z "$NEW_KEY" ]; then
  log "ERROR: Could not extract OAuth token from keychain — claude is logged out; needs interactive '/login' at the Mac"
  exit 1
fi

# 2b. GUARD: never write an already-expired token (that is exactly what clobbered
#     a good .env on 2026-07-13, flipping working auth to 401).
REMAIN=$(kc_field minutes)
if [ -n "$REMAIN" ] && [ "$REMAIN" -lt 5 ]; then
  log "ERROR: keychain token expired (${REMAIN}min left) — NOT clobbering .env; needs interactive '/login'"
  exit 1
fi

# 3. Copy into .env only if changed.
CURRENT_KEY=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
if [ "$NEW_KEY" = "$CURRENT_KEY" ]; then
  log "Token unchanged (valid ${REMAIN}min), no update needed"
  exit 0
fi
sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$NEW_KEY|" "$ENV_FILE"
log "OAuth token refreshed (prefix: ${NEW_KEY:0:15}..., valid ${REMAIN}min) — credential proxy picks it up automatically"

exit 0
