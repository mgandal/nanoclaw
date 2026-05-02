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
TMP="$OUT.tmp.$$"
mkdir -p "$(dirname "$OUT")"
# Atomic write: stage to .tmp.<pid>, rename only on healthy exit (0 or 2).
# Prevents a concurrent reader (the woken container agent) from ever seeing
# a partially-written JSON. On launchctl failure (rc=3) the partial tmp is
# discarded so the previous good file remains as fallback. mv is atomic on
# the same filesystem.
python3 /Users/mgandal/Agents/nanoclaw/scripts/check-launchd-health.py >"$TMP" 2>/dev/null
rc=$?
if [ $rc -eq 0 ] || [ $rc -eq 2 ]; then
  mv "$TMP" "$OUT"
else
  rm -f "$TMP"
fi
case $rc in
  0) exit 1 ;;
  2) exit 0 ;;
  *) exit 2 ;;
esac
