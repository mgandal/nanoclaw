#!/bin/bash
# Todoist MCP launchd entrypoint. Wraps @doist/todoist-ai via
# supergateway (stdio→Streamable HTTP on 8185) plus a bearer-enforcing
# TCP proxy on 8186 for Apple Container VMs.
#
# Deployed to ~/.cache/todoist-mcp/start.sh by
# scripts/bridges/install-start-updates.sh.
set -e

NODE="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/node"
SUPERGATEWAY="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/supergateway"
TODOIST_AI="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/todoist-ai"
PROXY="/Users/mgandal/.cache/todoist-mcp/proxy.mjs"

export PATH="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:$PATH"

# Load API key from nanoclaw .env
TODOIST_KEY=$(grep '^TODOIST_API_TOKEN=' /Users/mgandal/Agents/nanoclaw/.env | cut -d= -f2)
export TODOIST_API_KEY="$TODOIST_KEY"

# Start supergateway: wraps todoist-ai stdio as Streamable HTTP on port 8185 (localhost)
"$SUPERGATEWAY" --stdio "$TODOIST_AI" --outputTransport streamableHttp --port 8185 --streamableHttpPath /mcp --cors &
SG_PID=$!

# Wait for supergateway to be ready
for i in $(seq 1 20); do
  curl -s http://localhost:8185/mcp >/dev/null 2>&1 && break
  sleep 0.5
done

# Start proxy (0.0.0.0:8186 → 127.0.0.1:8185) for Apple Container VMs
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
