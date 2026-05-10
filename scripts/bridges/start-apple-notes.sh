#!/bin/bash
# Apple Notes MCP launchd entrypoint. Wraps sweetrb/apple-notes-mcp via
# supergateway (stdio→Streamable HTTP on 8183) plus a bearer-enforcing
# TCP proxy on 8184 for Apple Container VMs. Needs macOS automation
# permission for Notes.app to read note bodies.
#
# Deployed to ~/.cache/apple-notes-mcp/start.sh by
# scripts/bridges/install-start-updates.sh.
set -e

NODE="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/node"
SUPERGATEWAY="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/supergateway"
APPLE_NOTES_MCP="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/apple-notes-mcp"
PROXY="/Users/mgandal/.cache/apple-notes-mcp/proxy.mjs"

export PATH="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:$PATH"

# Start supergateway: wraps apple-notes-mcp stdio as Streamable HTTP on port 8183 (localhost)
"$SUPERGATEWAY" --stdio "$APPLE_NOTES_MCP" --outputTransport streamableHttp --port 8183 --streamableHttpPath /mcp --cors &
SG_PID=$!

# Wait for supergateway to be ready
for i in $(seq 1 20); do
  curl -s http://localhost:8183/mcp >/dev/null 2>&1 && break
  sleep 0.5
done

# Start proxy (0.0.0.0:8184 → 127.0.0.1:8183) for Apple Container VMs
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
