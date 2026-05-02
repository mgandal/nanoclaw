#!/bin/bash
# Guard-script wrapper for check-launchd-health.py.
# Translates the health script's exit codes into the scheduler's guard-script
# semantics (see runGuardScript in src/task-scheduler.ts):
#   our 0 (clean)     → guard exit 1 (skip silently — daily heartbeat, no alert)
#   our 2 (issues)    → guard exit 0 (wake the agent so it can DM CLAIRE)
#   our 3 (launchctl) → guard exit 2 (route to the alerts table — guard itself broken)
#
# Writes the full JSON output to data/launchd-health.json so the woken
# container agent can read it at /workspace/project/data/launchd-health.json
# (the scheduler does NOT forward guard stdout to the container).
set -u
OUT=/Users/mgandal/Agents/nanoclaw/data/launchd-health.json
mkdir -p "$(dirname "$OUT")"
python3 /Users/mgandal/Agents/nanoclaw/scripts/check-launchd-health.py >"$OUT" 2>/dev/null
rc=$?
case $rc in
  0) exit 1 ;;
  2) exit 0 ;;
  *) exit 2 ;;
esac
