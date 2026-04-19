#!/bin/bash
set -e

# Shadow .env so the agent cannot read host secrets.
# Try mount --bind first (Docker), fall back to truncation (Apple Container,
# which only supports directory VirtioFS mounts and can't bind a host file).
if [ -f /workspace/project/.env ]; then
  if [ "$(id -u)" = "0" ]; then
    mount --bind /dev/null /workspace/project/.env 2>/dev/null || : > /workspace/project/.env
  else
    : > /workspace/project/.env 2>/dev/null || true
  fi
fi

# Capture stdin (secrets JSON) to temp file
cat > /tmp/input.json

# Inline script that seeds per-CLI config files from env vars that the CLIs
# don't natively read, then execs the agent runner. Runs as whichever uid
# owns the node process — post-setpriv for main groups, current uid
# otherwise — so files land under the right $HOME with the right ownership.
# Seeding failures must not break container startup.
run_agent='
  # @readwise/cli (0.5.x) only reads ~/.readwise-cli.json; it ignores
  # READWISE_ACCESS_TOKEN. Mirror what `readwise login-with-token` writes.
  if [ -n "$READWISE_ACCESS_TOKEN" ] && [ ! -f "$HOME/.readwise-cli.json" ]; then
    umask 077
    printf "{\n  \"access_token\": \"%s\",\n  \"auth_type\": \"token\"\n}\n" \
      "$READWISE_ACCESS_TOKEN" > "$HOME/.readwise-cli.json" 2>/dev/null || true
  fi
  exec node /app/dist/index.js < /tmp/input.json
'

# Drop privileges if running as root (main-group containers)
if [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then
  chown "$RUN_UID:$RUN_GID" /tmp/input.json
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- \
    bash -c "$run_agent"
fi

exec bash -c "$run_agent"
