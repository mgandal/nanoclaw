#!/bin/bash
# Restart SimpleMem Docker container
set -euo pipefail
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would run 'docker restart simplemem'"
  exit 0
fi
docker restart simplemem 2>&1
sleep 8  # SimpleMem needs ~5-7s to initialize after restart
