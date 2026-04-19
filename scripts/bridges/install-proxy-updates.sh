#!/bin/bash
# Install bearer-enforcing proxy.mjs files into each bridge's cache
# dir, then kickstart the launchd job to pick them up. Idempotent —
# re-running overwrites with the same content and restarts the jobs.
#
# Warn mode is the default (missing bearer is logged but forwarded).
# Flip to enforce per-bridge by adding NANOCLAW_BRIDGE_AUTH=enforce
# to the plist's EnvironmentVariables and reloading — see task 6 of
# the B1 server-enforcement plan.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/proxy-template.mjs"
SHARED_AUTH="$SCRIPT_DIR/shared-auth.mjs"

if [ ! -f "$TEMPLATE" ] || [ ! -f "$SHARED_AUTH" ]; then
  echo "ERROR: proxy-template.mjs or shared-auth.mjs missing in $SCRIPT_DIR" >&2
  exit 1
fi

# Each bridge: (cache_dir|listen_port|target_port|service_name|launchd_label)
BRIDGES=(
  "$HOME/.cache/apple-notes-mcp|8184|8183|apple-notes|com.apple-notes-mcp"
  "$HOME/.cache/todoist-mcp|8186|8185|todoist|com.todoist-mcp"
  "$HOME/.cache/calendar-mcp|8188|8187|calendar|com.calendar-mcp"
)

for entry in "${BRIDGES[@]}"; do
  IFS='|' read -r cache_dir listen_port target_port service launchd_label <<< "$entry"
  if [ ! -d "$cache_dir" ]; then
    echo "SKIP: $cache_dir does not exist"
    continue
  fi
  echo "== $service =="

  # Back up the existing proxy.mjs once — lets operators diff or
  # restore the old TCP passthrough if something breaks.
  if [ -f "$cache_dir/proxy.mjs" ] && [ ! -f "$cache_dir/proxy.mjs.pre-b1" ]; then
    cp "$cache_dir/proxy.mjs" "$cache_dir/proxy.mjs.pre-b1"
    echo "  backed up old proxy.mjs → proxy.mjs.pre-b1"
  fi

  # Copy shared auth + template into the bridge dir so the launchd
  # script doesn't need a project-root path (which could break if
  # the repo moves or is removed).
  cp -f "$SHARED_AUTH" "$cache_dir/shared-auth.mjs"
  cp -f "$TEMPLATE" "$cache_dir/proxy-template.mjs"

  # Write the bridge-specific entrypoint.
  cat > "$cache_dir/proxy.mjs" <<EOF
// Auto-installed by scripts/bridges/install-proxy-updates.sh
// Bridge: $service (listen $listen_port → target 127.0.0.1:$target_port)
//
// HTTP-aware proxy with optional bearer enforcement. Default is warn
// mode — missing bearers are logged but forwarded. Set
// NANOCLAW_BRIDGE_AUTH=enforce in the launchd plist EnvironmentVariables
// to hard-reject.
import { createBridgeProxy } from './proxy-template.mjs';
await createBridgeProxy({
  listenPort: $listen_port,
  targetHost: '127.0.0.1',
  targetPort: $target_port,
  serviceName: '$service',
});
EOF

  # Restart the launchd job so the new proxy binds the port.
  launchctl kickstart -k "gui/$(id -u)/$launchd_label"
  echo "  kickstarted $launchd_label"
done

echo
echo "Installed. Bridges started in WARN mode — missing bearers are logged but forwarded."
echo "To enforce: add NANOCLAW_BRIDGE_AUTH=enforce to each plist and reload."
