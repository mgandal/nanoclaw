#!/bin/bash
# NanoClaw external heartbeat monitor
# Runs via launchd every 2 minutes. Detects process stalls and crash-loops.
# Coordinates with in-process watchdog via filesystem lock.
set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH_PORT="${NANOCLAW_HEALTH_PORT:-3002}"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
LOG_FILE="${NANOCLAW_DIR}/logs/watchdog-heartbeat.log"
LOCK_FILE="${HOME}/.nanoclaw/watchdog.lock"
STATE_FILE="${HOME}/.nanoclaw/heartbeat-state"
BOT_TOKEN_FILE="${HOME}/.config/nanoclaw/watchdog-bot-token"
MAX_LOG_SIZE=1048576  # 1MB

# Ensure directories exist
mkdir -p "${HOME}/.nanoclaw" "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# Log rotation: truncate if over 1MB
if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
  tail -100 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

# Health check
if curl -sf --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  # Healthy — clear any restart tracking
  exit 0
fi

log "Health check failed for $HEALTH_URL"

# Check filesystem lock — if Layer 1 is mid-fix, skip this cycle
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f%m "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -lt 300 ]; then
    LOCK_PID=$(python3 -c "import json; print(json.load(open('$LOCK_FILE'))['pid'])" 2>/dev/null || echo "")
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
      log "Skipping restart: Layer 1 mid-fix (PID=$LOCK_PID, age=${LOCK_AGE}s)"
      exit 0
    fi
  fi
fi

# Circuit breaker: check recent restart count
if [ -f "$STATE_FILE" ]; then
  RECENT_RESTARTS=$(python3 -c "
import json, time
try:
    state = json.load(open('$STATE_FILE'))
    cutoff = time.time() - 1800  # 30 minutes
    recent = [r for r in state.get('restarts', []) if r['ts'] > cutoff]
    print(len(recent))
except:
    print(0)
" 2>/dev/null || echo 0)

  if [ "$RECENT_RESTARTS" -ge 3 ]; then
    log "CRITICAL: Circuit breaker tripped — $RECENT_RESTARTS restarts in 30min, NOT restarting"
    # Send critical alert if we have bot token
    if [ -f "$BOT_TOKEN_FILE" ]; then
      TOKEN=$(cat "$BOT_TOKEN_FILE" | head -1)
      CHAT_ID=$(cat "$BOT_TOKEN_FILE" | sed -n '2p')
      if [ -n "$TOKEN" ] && [ -n "$CHAT_ID" ]; then
        MSG="CRITICAL: NanoClaw crash-looping. $RECENT_RESTARTS restarts in 30min. Manual intervention required."
        curl -sf --max-time 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
          -d "chat_id=${CHAT_ID}" -d "text=${MSG}" >/dev/null 2>&1 || true
      fi
    fi
    exit 1
  fi
fi

# Capture pre-restart diagnostics
log "Capturing diagnostics before restart..."
{
  echo "=== Last 50 log lines ==="
  tail -50 "${NANOCLAW_DIR}/logs/nanoclaw.log" 2>/dev/null || echo "(no log file)"
  echo ""
  echo "=== NanoClaw ports ==="
  lsof -i :3001 -i :3002 -i :8181 -i :8200 2>/dev/null || echo "(none)"
  echo ""
  echo "=== Process list ==="
  ps aux | grep -E "nanoclaw|bun.*index" | grep -v grep || echo "(no processes)"
} >> "$LOG_FILE" 2>&1

# Restart NanoClaw
log "Restarting NanoClaw via launchctl..."
UID_NUM=$(id -u)
launchctl kickstart -k "gui/${UID_NUM}/com.nanoclaw" 2>&1 | tee -a "$LOG_FILE" || true

# Record restart in state file
python3 -c "
import json, time, os
state_file = '$STATE_FILE'
try:
    state = json.load(open(state_file))
except:
    state = {'restarts': []}
state['restarts'].append({'ts': time.time()})
# Keep only last 30 min
cutoff = time.time() - 1800
state['restarts'] = [r for r in state['restarts'] if r['ts'] > cutoff]
tmp = state_file + '.tmp'
with open(tmp, 'w') as f:
    json.dump(state, f)
os.rename(tmp, state_file)
" 2>/dev/null || log "WARNING: Failed to update state file"

# Send Telegram alert
if [ -f "$BOT_TOKEN_FILE" ]; then
  TOKEN=$(cat "$BOT_TOKEN_FILE" | head -1)
  CHAT_ID=$(cat "$BOT_TOKEN_FILE" | sed -n '2p')
  if [ -n "$TOKEN" ] && [ -n "$CHAT_ID" ]; then
    DIAG=$(tail -20 "$LOG_FILE" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null | tr -d '"' || echo "diagnostics unavailable")
    MSG="NanoClaw restarted by heartbeat watchdog. Last diagnostics: ${DIAG:0:500}"
    curl -sf --max-time 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" -d "text=${MSG}" >/dev/null 2>&1 || true
  fi
fi

log "Restart complete"
