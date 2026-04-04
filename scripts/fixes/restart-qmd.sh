#!/bin/bash
# Restart QMD server and proxy via launchd
set -euo pipefail
UID_NUM=$(id -u)
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would restart com.qmd-server and com.qmd-proxy"
  exit 0
fi
launchctl kickstart -k "gui/${UID_NUM}/com.qmd-server" 2>&1
sleep 1
launchctl kickstart -k "gui/${UID_NUM}/com.qmd-proxy" 2>&1
sleep 2
