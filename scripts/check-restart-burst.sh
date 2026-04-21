#!/bin/bash
# Detect NanoClaw restart bursts. Invoked by watchdog-heartbeat.sh (every 2m) as a sibling check.
#
# Counts distinct PIDs that printed the startup banner line in the last N log-events window,
# NOT a real time window — the runtime log doesn't timestamp with dates. For our use this is
# close enough: the "Calendar watcher disabled" line is one of the first emitted at startup,
# so each distinct PID there ≈ one restart.
#
# Exits 0 on healthy (< BURST_THRESHOLD restarts). Exits 2 and sends a Telegram alert on burst.
# Alerting uses the same ~/.config/nanoclaw/watchdog-bot-token path as the parent watchdog.

set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${NANOCLAW_DIR}/logs/nanoclaw.log"
ERR_LOG="${NANOCLAW_DIR}/logs/nanoclaw.error.log"
BURST_LOG="${NANOCLAW_DIR}/logs/restart-burst.log"
BOT_TOKEN_FILE="${HOME}/.config/nanoclaw/watchdog-bot-token"
STATE_FILE="${HOME}/.nanoclaw/restart-burst-state"

# Look at the last 500 log lines — covers ~30 min of typical runtime output, or ~50 restarts
# if the process is actually looping. More than enough for a 10-min-window-equivalent check.
TAIL_LINES="${TAIL_LINES:-500}"
BURST_THRESHOLD="${BURST_THRESHOLD:-3}"

mkdir -p "${HOME}/.nanoclaw" "$(dirname "$BURST_LOG")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$BURST_LOG"; }

if [ ! -f "$LOG_FILE" ]; then
  log "no runtime log found at $LOG_FILE — nothing to check"
  exit 0
fi

# Extract distinct PIDs from the startup banner. ANSI color codes surround "INFO" and the
# message body, so strip them before grepping. PID is in parens after "INFO".
DISTINCT_PIDS=$(tail -n "$TAIL_LINES" "$LOG_FILE" \
  | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -oE 'INFO \([0-9]+\): Calendar watcher disabled' \
  | grep -oE '\([0-9]+\)' \
  | sort -u \
  | wc -l \
  | tr -d ' ')

log "distinct startup PIDs in last ${TAIL_LINES} lines: ${DISTINCT_PIDS} (threshold: ${BURST_THRESHOLD})"

if [ "$DISTINCT_PIDS" -lt "$BURST_THRESHOLD" ]; then
  # Healthy — clear any stale alert state so next burst re-alerts
  rm -f "$STATE_FILE"
  exit 0
fi

# De-dupe: only alert once per distinct burst event. If the state file is younger than
# 30 min AND holds the same PID count, we've already paged; stay quiet.
if [ -f "$STATE_FILE" ]; then
  STATE_AGE=$(( $(date +%s) - $(stat -f '%m' "$STATE_FILE" 2>/dev/null || echo 0) ))
  STATE_COUNT=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  if [ "$STATE_AGE" -lt 1800 ] && [ "$STATE_COUNT" -eq "$DISTINCT_PIDS" ]; then
    log "already alerted on this burst (age ${STATE_AGE}s, count ${STATE_COUNT}) — skipping re-alert"
    exit 2
  fi
fi

# Capture the error log — this is where the real crash reason lives (SyntaxError, etc.).
# The parent watchdog only reads nanoclaw.log (stdout); we read nanoclaw.error.log (stderr).
# Prefer actual error lines over noise: SyntaxError / TypeError / "error:" beat generic warns.
if [ -s "$ERR_LOG" ]; then
  ERR_TAIL=$(tail -200 "$ERR_LOG" 2>/dev/null \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -iE '(SyntaxError|TypeError|ReferenceError|uncaught|unhandled|fatal|^error:|Cannot find|not found in module)' \
    | tail -5)
  # Fall back to a plain tail if no error-ish lines matched
  if [ -z "$ERR_TAIL" ]; then
    ERR_TAIL=$(tail -20 "$ERR_LOG" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tail -c 800)
  fi
else
  ERR_TAIL="(no error log)"
fi

log "BURST DETECTED: ${DISTINCT_PIDS} restarts. Error log tail:"
echo "$ERR_TAIL" >> "$BURST_LOG"

# Send Telegram alert
if [ -f "$BOT_TOKEN_FILE" ]; then
  TOKEN=$(head -1 "$BOT_TOKEN_FILE")
  CHAT_ID=$(sed -n '2p' "$BOT_TOKEN_FILE")
  if [ -n "$TOKEN" ] && [ -n "$CHAT_ID" ]; then
    # Trim to ~500 chars; Telegram hard limit is 4096 but brevity beats spam
    MSG="NanoClaw restart burst: ${DISTINCT_PIDS} distinct PIDs in last ${TAIL_LINES} log lines. Likely cause (error log tail):
${ERR_TAIL:0:500}"
    curl -sf --max-time 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" --data-urlencode "text=${MSG}" >/dev/null 2>&1 \
      && log "alert sent to chat ${CHAT_ID}" \
      || log "WARN: alert send failed"
  fi
fi

# Remember this alert so next invocation within 30m doesn't re-page
echo "$DISTINCT_PIDS" > "$STATE_FILE"

exit 2
