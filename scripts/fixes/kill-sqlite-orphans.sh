#!/bin/bash
# Kill orphaned nanoclaw container processes that may hold SQLite locks
set -euo pipefail
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would kill orphaned nanoclaw-* container processes"
  pgrep -f "nanoclaw-" 2>/dev/null | while read -r pid; do
    echo "  Would kill PID $pid: $(ps -p "$pid" -o command= 2>/dev/null || echo unknown)"
  done || true
  exit 0
fi

KILLED=0
pgrep -f "nanoclaw-" 2>/dev/null | while read -r pid; do
  CMD=$(ps -p "$pid" -o command= 2>/dev/null || echo "unknown")
  echo "Killing orphaned process PID=$pid CMD=$CMD"
  kill "$pid" 2>/dev/null || true
  KILLED=$((KILLED + 1))
done || true

if [ "$KILLED" -eq 0 ]; then
  echo "No orphaned nanoclaw processes found"
fi
