#!/bin/bash
# Restart the Hindsight API upstream (launchd com.hindsight-upstream, port 8888).
#
# hindsight-api hard-gates startup on an LLM verify_connection() against the
# ollama-openai shim (11435). When the shim is wedged that probe burns its
# ~120s timeout and the process exits with "Application startup failed", so
# launchd's KeepAlive respawns it into the same failure and 8888 never binds.
# Restarting Hindsight while the shim is dark just repeats the loop — so probe
# the dependency first, exactly as restart-honcho.sh does for the Docker daemon.
#
# We deliberately do NOT restart the 8889 proxy: it tracks upstream state on its
# own and reports {"upstream":"down"} without needing a bounce.
set -euo pipefail

CURL=/usr/bin/curl
LAUNCHCTL=/bin/launchctl
UID_NUM=$(id -u)

SHIM_MODELS_URL="http://127.0.0.1:11435/v1/models"
UPSTREAM_HEALTH_URL="http://127.0.0.1:8888/health"
SHIM_LABEL="com.hermes.ollama-openai-shim"
UPSTREAM_LABEL="com.hindsight-upstream"

if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would probe ${SHIM_MODELS_URL} then restart ${UPSTREAM_LABEL}"
  exit 0
fi

# Idempotence guard. The watchdog can call us on a stale failure reading, and
# bouncing a healthy Hindsight is actively harmful: startup re-runs the LLM
# verify and the worker reclaims its task backlog, so a needless restart costs
# 20-135s of downtime and a fresh burst of LLM load.
if "$CURL" -sf -m 3 -o /dev/null "$UPSTREAM_HEALTH_URL"; then
  echo "hindsight upstream already healthy — nothing to do"
  exit 0
fi

# Dependency gate. A dead shim is the one condition we can fix from here; if
# it merely answers slowly (cold 29GB model load) we still hand off to
# Hindsight, whose own ~120s startup budget absorbs a load our 30s cannot.
if ! "$CURL" -sf -m 4 -o /dev/null "$SHIM_MODELS_URL"; then
  echo "shim unresponsive — restarting it; hindsight retried next tick"
  "$LAUNCHCTL" kickstart -k "gui/${UID_NUM}/${SHIM_LABEL}" 2>&1 || true
  exit 0
fi

"$LAUNCHCTL" kickstart -k "gui/${UID_NUM}/${UPSTREAM_LABEL}" 2>&1

# The watchdog verifies with a single immediate HTTP check, so wait for the
# port to actually bind. A warm start binds in ~10-20s; if it takes longer the
# tick fails but Hindsight keeps starting and the next poll clears the event.
for _ in $(seq 1 20); do
  if "$CURL" -sf -m 2 -o /dev/null "$UPSTREAM_HEALTH_URL"; then
    echo "hindsight upstream up"
    exit 0
  fi
  sleep 1
done

echo "hindsight upstream still binding after 20s — next tick will verify"
