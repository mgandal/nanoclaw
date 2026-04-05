#!/bin/bash
# Restart Todoist MCP via launchd
set -euo pipefail
UID_NUM=$(id -u)
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would restart com.todoist-mcp"
  exit 0
fi
launchctl kickstart -k "gui/${UID_NUM}/com.todoist-mcp" 2>&1
sleep 2
