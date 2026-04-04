#!/bin/bash
# Restart Apple Container runtime
set -euo pipefail
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would run 'container system start'"
  exit 0
fi
/usr/local/bin/container system start 2>&1
sleep 2
