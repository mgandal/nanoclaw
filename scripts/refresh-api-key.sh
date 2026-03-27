#!/bin/bash
# Refresh the temporary API key in .env by capturing it from a claude -p call.
# Runs a one-shot HTTP server that intercepts the x-api-key or Authorization
# header from claude's API request, then updates .env and restarts NanoClaw.
#
# Usage: ./scripts/refresh-api-key.sh
# Designed to run as a launchd scheduled task.

set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
LOG="$(cd "$(dirname "$0")/.." && pwd)/logs/key-refresh.log"
CAPTURE_PORT=3098

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

log "Starting API key refresh"

# Start capture server that grabs the key from claude's request
python3 -c "
import http.server, json, sys, urllib.request, ssl, threading, os

captured_key = None

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global captured_key
        # Check for x-api-key header first, then Authorization Bearer
        key = self.headers.get('x-api-key', '')
        if not key:
            auth = self.headers.get('Authorization', '')
            if auth.startswith('Bearer '):
                key = auth[7:]

        if key and not captured_key:
            captured_key = key

        # Forward to real API
        length = int(self.headers.get('content-length', 0))
        body = self.rfile.read(length) if length else b''
        req = urllib.request.Request(
            'https://api.anthropic.com' + self.path,
            data=body, method='POST'
        )
        for h in self.headers:
            if h.lower() not in ('host', 'content-length', 'transfer-encoding', 'connection'):
                req.add_header(h, self.headers[h])
        req.add_header('Content-Length', str(len(body)))
        ctx = ssl.create_default_context()
        try:
            resp = urllib.request.urlopen(req, context=ctx, timeout=30)
            self.send_response(resp.status)
            for h, v in resp.getheaders():
                if h.lower() not in ('transfer-encoding',):
                    self.send_header(h, v)
            self.end_headers()
            self.wfile.write(resp.read())
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(str(e).encode())

        if captured_key:
            with open('/tmp/nanoclaw-refreshed-key', 'w') as f:
                f.write(captured_key)
            threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', $CAPTURE_PORT), Handler)
server.timeout = 45
try:
    server.serve_forever()
except:
    pass
" &
CAPTURE_PID=$!

sleep 1

# Run claude -p with our capture proxy as base URL
# Use minimal env to simulate launchd context
env -i \
  HOME="$HOME" \
  USER="$(whoami)" \
  PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$CAPTURE_PORT" \
  claude -p "respond with: ok" --output-format text > /dev/null 2>&1 || true

# Wait for capture server
wait $CAPTURE_PID 2>/dev/null || true

# Read captured key
if [ -f /tmp/nanoclaw-refreshed-key ]; then
    NEW_KEY=$(cat /tmp/nanoclaw-refreshed-key)
    rm -f /tmp/nanoclaw-refreshed-key

    if [ -z "$NEW_KEY" ]; then
        log "ERROR: Captured empty key"
        exit 1
    fi

    # Update CLAUDE_CODE_OAUTH_TOKEN in .env with the fresh token
    if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE"; then
        sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$NEW_KEY|" "$ENV_FILE"
    else
        echo "CLAUDE_CODE_OAUTH_TOKEN=$NEW_KEY" >> "$ENV_FILE"
    fi

    log "OAuth token refreshed successfully (prefix: ${NEW_KEY:0:15}...)"

    # Restart NanoClaw to pick up the new key
    launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>/dev/null || true
    log "NanoClaw restarted"
else
    log "ERROR: Failed to capture API key from claude CLI"
    exit 1
fi
