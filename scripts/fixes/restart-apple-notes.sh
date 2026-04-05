#!/bin/bash
# Restart Apple Notes MCP via launchd
set -euo pipefail
UID_NUM=$(id -u)
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would restart com.apple-notes-mcp"
  exit 0
fi
launchctl kickstart -k "gui/${UID_NUM}/com.apple-notes-mcp" 2>&1
sleep 2
