#!/bin/bash
# Restart the Honcho docker stack (shared with Hermes at ~/.hermes/honcho).
#
# Honcho is the only MCP dependency that lives in Docker rather than launchd,
# and Docker Desktop does not start at login — so a reboot leaves Honcho dark
# until someone opens Docker by hand. If the daemon is down we launch it and
# return; the watchdog retries after its cooldown, by which point the daemon
# is up and `compose up -d` can bring the stack back.
set -euo pipefail

DOCKER=/usr/local/bin/docker
COMPOSE_FILE="${HOME}/.hermes/honcho/docker-compose.yml"

if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would run docker compose -f ${COMPOSE_FILE} up -d"
  exit 0
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "honcho compose file not found: ${COMPOSE_FILE}" >&2
  exit 1
fi

if ! "$DOCKER" info >/dev/null 2>&1; then
  echo "docker daemon unreachable — launching Docker Desktop, will retry next tick"
  /usr/bin/open -ga Docker || true
  exit 0
fi

"$DOCKER" compose -f "$COMPOSE_FILE" up -d 2>&1
