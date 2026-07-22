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
# Timing is the tricky part. Hindsight takes ~20s to bind when warm and up to
# ~135s under GPU/model contention — which is the very condition that takes it
# down, so the slow case is correlated, not hypothetical. The watchdog gives
# this script 30s (execScript) and re-attempts on the handler's cooldown, so we
# must (a) stay well inside 30s and (b) refuse to re-kick a restart that is
# still in flight, or we SIGKILL the startup we are waiting for, forever.
#
# NOT covered, both of which escalate to a human rather than self-healing:
#   - A shim wedge while Hindsight is already up. 8888 keeps answering 200 (its
#     /health reports DB connectivity only), so the watchdog never fires and
#     memory derivation degrades silently. That needs a separate probe.
#   - A shim whose HTTP loop answers while generation is wedged. We restart
#     Hindsight, its LLM verify times out, and after maxAttempts the watchdog
#     escalates. We deliberately do NOT probe completions to detect this: any
#     such probe must name a model, an unknown/retagged model makes this shim
#     hang rather than return 4xx (verified), and a hang is indistinguishable
#     from a wedge — so config drift would bounce a healthy Hermes shim on
#     every attempt, forever. Escalating is the safer failure.
#
# We deliberately do NOT restart the 8889 proxy: it tracks upstream state on its
# own and reports {"upstream":"down"} without needing a bounce.
set -euo pipefail

CURL=/usr/bin/curl
LAUNCHCTL=/bin/launchctl
UID_NUM=$(id -u)

SHIM_MODELS_URL="http://127.0.0.1:11435/v1/models"
UPSTREAM_HEALTH_URL="http://127.0.0.1:8888/health"
# Owned by Hermes, not NanoClaw. Also serves the Honcho deriver and Hindsight
# retain, so a bounce interrupts those too — hence the two-strike rule below.
SHIM_LABEL="com.hermes.ollama-openai-shim"
UPSTREAM_LABEL="com.hindsight-upstream"

# execScript passes HOME as process.env.HOME || '', so an empty HOME would make
# this /.nanoclaw, and mkdir -p would EACCES and kill the script under set -e on
# every invocation. health-monitor.ts uses the same /tmp fallback for its lock.
STATE_DIR="${HOME:-/tmp}/.nanoclaw"
RESTART_STAMP="${STATE_DIR}/hindsight-restart.stamp"
SHIM_STRIKE_STAMP="${STATE_DIR}/hindsight-shim-strike.stamp"

# Must exceed the ~135s startup plus our own wait (151s worst case) but stay
# BELOW the handler's 180s cooldown. Above it, the next attempt always lands
# inside the grace window and short-circuits, so every other attempt becomes a
# no-op that still burns the maxAttempts budget — "failed after 3 attempts"
# would then mean one real restart. This is a safety net, not a scheduler; the
# cooldown is what prevents the livelock, and this catches the cross-process
# case where the in-memory cooldown map starts empty.
RESTART_GRACE_SECONDS=170
# ~2x the cooldown, so a legitimate strike pair 180s apart still lands while a
# stale strike from an unrelated incident expires before it can silently
# downgrade the two-strike gate to one.
SHIM_STRIKE_TTL_SECONDS=400
WAIT_BUDGET_SECONDS=16

if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would check ${UPSTREAM_HEALTH_URL}, probe ${SHIM_MODELS_URL}, then restart ${UPSTREAM_LABEL}"
  exit 0
fi

now_s() { date +%s; }

# Age of a stamp file in seconds; a huge number when it is missing or
# unreadable. No [ -f ] pre-check: that leaves a TOCTOU window where stat can
# fail after the test passes, and the empty expansion makes $(( )) a syntax
# error that kills the whole script under set -e. An unreadable stamp must read
# as "no restart in flight" so the fix proceeds, never abort the fix path.
stamp_age() {
  local mtime
  mtime=$(stat -f %m "$1" 2>/dev/null) || { echo 999999; return 0; }
  echo $(( $(now_s) - mtime ))
}

mkdir -p "$STATE_DIR"

# Guard 1 — already healthy. The watchdog can call us on a stale reading, and
# bouncing a healthy Hindsight costs 20-135s of downtime plus a fresh burst of
# LLM load as the worker reclaims its backlog.
if "$CURL" -sf -m 2 -o /dev/null "$UPSTREAM_HEALTH_URL"; then
  # Clear any strike here too. Otherwise a strike recorded during an incident
  # survives its full TTL once things recover — no further runs occur to clear
  # it — and the next unrelated outage would skip straight past strike one.
  rm -f "$SHIM_STRIKE_STAMP"
  echo "hindsight upstream already healthy — nothing to do"
  exit 0
fi

# Guard 2 — a restart is still in flight. Without this, the handler's cooldown
# expires while a slow start is mid-flight and the next kickstart -k SIGKILLs
# it, resetting the clock and livelocking at the cooldown cadence.
RESTART_AGE=$(stamp_age "$RESTART_STAMP")
if [ "$RESTART_AGE" -lt "$RESTART_GRACE_SECONDS" ]; then
  echo "restart already in flight (${RESTART_AGE}s ago) — letting it finish"
  exit 0
fi

# Dependency gate. Two strikes before bouncing the shim: a single failed probe
# may just be the shim serving a long completion for another consumer serially,
# and killing it mid-request would break that caller. A transient stall clears
# by the next tick; a real outage strikes twice.
if ! "$CURL" -sf -m 2 -o /dev/null "$SHIM_MODELS_URL"; then
  STRIKE_AGE=$(stamp_age "$SHIM_STRIKE_STAMP")
  if [ "$STRIKE_AGE" -ge "$SHIM_STRIKE_TTL_SECONDS" ]; then
    : > "$SHIM_STRIKE_STAMP"
    echo "shim unresponsive (first strike) — rechecking next tick"
    exit 0
  fi
  # Second consecutive strike: the shim is not answering at all, which a
  # restart can fix. A transient stall from serial generation clears by now.
  rm -f "$SHIM_STRIKE_STAMP"
  if ! "$LAUNCHCTL" kickstart -k "gui/${UID_NUM}/${SHIM_LABEL}"; then
    echo "cannot kickstart ${SHIM_LABEL} — renamed, unloaded, or not a Hermes host?" >&2
    exit 1
  fi
  echo "shim restarted; hindsight retried next tick"
  exit 0
fi
rm -f "$SHIM_STRIKE_STAMP"

if ! "$LAUNCHCTL" kickstart -k "gui/${UID_NUM}/${UPSTREAM_LABEL}"; then
  echo "cannot kickstart ${UPSTREAM_LABEL} — renamed or unloaded?" >&2
  exit 1
fi
# Stamp only after the kickstart actually succeeded. Stamping first means a
# failed kickstart leaves a stamp claiming a restart is in flight, and the next
# attempt short-circuits on it — masking the "cannot kickstart" diagnostic for
# a full grace window.
: > "$RESTART_STAMP"

# Bound the wait by wall clock, not iteration count: verifyFix runs a single
# immediate check with no retry, so catching a warm start here saves a whole
# cooldown. A slow start falls through and Guard 2 protects it until it binds.
WAIT_DEADLINE=$(( $(now_s) + WAIT_BUDGET_SECONDS ))
while [ "$(now_s)" -lt "$WAIT_DEADLINE" ]; do
  if "$CURL" -sf -m 1 -o /dev/null "$UPSTREAM_HEALTH_URL"; then
    echo "hindsight upstream up"
    exit 0
  fi
  sleep 1
done

echo "hindsight upstream still starting after ${WAIT_BUDGET_SECONDS}s — next tick verifies"
