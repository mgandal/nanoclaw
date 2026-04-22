#!/bin/bash
# NanoClaw external heartbeat monitor
# Runs via launchd every 2 minutes. Detects process stalls and crash-loops.
# Coordinates with in-process watchdog via filesystem lock.
set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Single source of truth for the health port:
#   1. explicit env var NANOCLAW_HEALTH_PORT wins
#   2. otherwise read NANOCLAW_HEALTH_PORT from .env
#   3. otherwise derive from CREDENTIAL_PROXY_PORT+1 (matches src/config.ts default)
#   4. otherwise fall back to 3002 (pre-OneCLI default, 3001+1)
# Must agree with src/config.ts :: NANOCLAW_HEALTH_PORT.
if [ -z "${NANOCLAW_HEALTH_PORT:-}" ] && [ -f "${NANOCLAW_DIR}/.env" ]; then
  # grep returns 1 when no match; keep pipefail happy with `|| true`.
  ENV_HEALTH=$(grep -E '^NANOCLAW_HEALTH_PORT=' "${NANOCLAW_DIR}/.env" 2>/dev/null | cut -d= -f2 | tr -d ' "' || true)
  ENV_CRED=$(grep -E '^CREDENTIAL_PROXY_PORT=' "${NANOCLAW_DIR}/.env" 2>/dev/null | cut -d= -f2 | tr -d ' "' || true)
  if [ -n "$ENV_HEALTH" ]; then
    NANOCLAW_HEALTH_PORT="$ENV_HEALTH"
  elif [ -n "$ENV_CRED" ]; then
    NANOCLAW_HEALTH_PORT=$((ENV_CRED + 1))
  fi
fi
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

# Rotate NanoClaw's launchd-owned logs. These files have an open FD held by the main
# process (StandardOutPath / StandardErrorPath), so we must truncate in place — NOT mv.
# Keeps last ~500 lines to preserve recent context for debugging.
for NC_LOG in "${NANOCLAW_DIR}/logs/nanoclaw.log" "${NANOCLAW_DIR}/logs/nanoclaw.error.log"; do
  if [ -f "$NC_LOG" ] && [ "$(stat -f%z "$NC_LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
    tail -500 "$NC_LOG" > "${NC_LOG}.tmp" 2>/dev/null \
      && cat "${NC_LOG}.tmp" > "$NC_LOG" \
      && rm -f "${NC_LOG}.tmp"
  fi
done

# Sibling check: detect launchd-driven restart bursts that never reach the watchdog's own
# circuit breaker (which only counts its own kicks). Runs in parallel to the health check
# below — a burst can happen even when /health succeeds between respawns.
"${NANOCLAW_DIR}/scripts/check-restart-burst.sh" || true

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
  echo ""
  echo "=== Last 20 error log lines ==="
  tail -20 "${NANOCLAW_DIR}/logs/nanoclaw.error.log" 2>/dev/null || echo "(no error log)"
} >> "$LOG_FILE" 2>&1

# Pre-restart build guard: if src/ is newer than dist/, the launchd-spawned
# `bun dist/index.js` will load stale JS and SyntaxError-loop at ~6 respawns/min.
# Rebuild before we kick; a failed build means the stale dist is still running,
# which is less bad than a guaranteed restart loop. See scripts/check-restart-burst.sh.
SRC_NEWEST=$(find "${NANOCLAW_DIR}/src" -name '*.ts' -not -path '*/node_modules/*' -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)
DIST_NEWEST=$(find "${NANOCLAW_DIR}/dist" -name '*.js' -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)
if [ -n "$SRC_NEWEST" ] && [ -n "$DIST_NEWEST" ] && [ "$SRC_NEWEST" -gt "$DIST_NEWEST" ]; then
  DRIFT=$((SRC_NEWEST - DIST_NEWEST))
  log "src newer than dist by ${DRIFT}s — rebuilding before kickstart"
  if (cd "$NANOCLAW_DIR" && /Users/mgandal/.bun/bin/bun run build) >> "$LOG_FILE" 2>&1; then
    log "build OK — proceeding with kickstart"
  else
    log "WARN: build failed — kicking anyway; stale dist may restart-loop"
  fi
fi

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
