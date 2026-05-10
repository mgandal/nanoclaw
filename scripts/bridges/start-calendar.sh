#!/bin/bash
# Calendar MCP launchd entrypoint. Wraps icalbuddy-backed calendar-mcp
# (server.mjs) via supergateway (stdio→Streamable HTTP on 8187) plus a
# bearer-enforcing TCP proxy on 8188 for Apple Container VMs.
#
# Deployed to ~/.cache/calendar-mcp/start.sh by
# scripts/bridges/install-start-updates.sh.
set -e

NODE="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/node"
SUPERGATEWAY="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/supergateway"
CALENDAR_MCP="$HOME/.cache/calendar-mcp/server.mjs"
PROXY="$HOME/.cache/calendar-mcp/proxy.mjs"

export PATH="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:$PATH"
export NODE_PATH="$HOME/.cache/calendar-mcp/node_modules"

# Start supergateway: wraps calendar-mcp stdio as Streamable HTTP on port 8187 (localhost)
"$SUPERGATEWAY" --stdio "$NODE $CALENDAR_MCP" --outputTransport streamableHttp --port 8187 --streamableHttpPath /mcp --cors &
SG_PID=$!

# Wait for supergateway to be ready
for i in $(seq 1 20); do
  curl -s http://localhost:8187/mcp >/dev/null 2>&1 && break
  sleep 0.5
done

# Start proxy (0.0.0.0:8188 → 127.0.0.1:8187)
"$NODE" "$PROXY" &
PROXY_PID=$!

cleanup() {
  kill "$SG_PID" "$PROXY_PID" 2>/dev/null
  wait 2>/dev/null
  exit 0
}
trap cleanup TERM INT

# Watchdog: exit non-zero if either child dies, so launchd KeepAlive
# respawns the whole supervisor (avoids the bare-`wait` hang where one
# dead child + one alive child leaves bash blocked indefinitely).
# See README.md in this directory.
while kill -0 "$SG_PID" 2>/dev/null && kill -0 "$PROXY_PID" 2>/dev/null; do
  sleep 5
done
echo "[start.sh] child death detected: SG=$SG_PID PROXY=$PROXY_PID; exiting for KeepAlive respawn" >&2
kill "$SG_PID" "$PROXY_PID" 2>/dev/null
wait 2>/dev/null
exit 1
