#!/bin/bash
# Kill a process squatting on a NanoClaw port (only if NOT the expected service)
# Usage: kill-port-squatter.sh <port> <expected_pattern>
set -euo pipefail

PORT="${1:?Usage: kill-port-squatter.sh <port> <expected_pattern>}"
EXPECTED="${2:?Usage: kill-port-squatter.sh <port> <expected_pattern>}"

PID=$(lsof -ti ":${PORT}" -sTCP:LISTEN 2>/dev/null | head -1)
if [ -z "$PID" ]; then
  echo "No process found on port $PORT"
  exit 0
fi

CMD=$(ps -p "$PID" -o command= 2>/dev/null || echo "unknown")
USER_NAME=$(ps -p "$PID" -o user= 2>/dev/null || echo "unknown")

if echo "$CMD" | grep -qi "$EXPECTED"; then
  echo "Port $PORT held by expected process (PID=$PID CMD=$CMD)"
  exit 0
fi

if [ "${3:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would kill PID=$PID USER=$USER_NAME CMD=$CMD on port $PORT (expected: $EXPECTED)"
  exit 0
fi

echo "Killing port squatter: PORT=$PORT PID=$PID USER=$USER_NAME CMD=$CMD (expected: $EXPECTED)"
kill "$PID" 2>/dev/null || true
sleep 1

if lsof -ti ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "WARNING: Port $PORT still occupied after kill"
  exit 1
fi
echo "Port $PORT freed"
