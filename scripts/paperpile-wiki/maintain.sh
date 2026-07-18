#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV="$SCRIPT_DIR/venv"
PYTHON="$VENV/bin/python3"
LOG="$SCRIPT_DIR/pipeline.log"
ERRORS=0

# The SPECTER2 model is already cached locally; run the HF stack offline so a
# transient DNS/network blip during the launchd wake-up can't kill ingest with
# a "Failed to resolve huggingface.co" NameResolutionError.
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1

exec > >(tee -a "$LOG") 2>&1
echo ""
echo "=========================================="
echo "Paperpile Wiki Maintenance: $(date)"
echo "=========================================="

# Route Claude calls through the host credential proxy (localhost) instead of
# talking to api.anthropic.com directly. This (a) handles the subscription
# OAuth token correctly — the SDK cannot use CLAUDE_CODE_OAUTH_TOKEN as an
# api-key — and (b) needs no external DNS from this child process: only the
# always-on main process (which owns the proxy) makes the upstream call.
# The proxy publishes its ephemeral token to store/.credential-proxy-token
# (0600) while it is running.
PROXY_PORT="$(grep -E '^CREDENTIAL_PROXY_PORT=' "$PROJECT_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\'' ')"
PROXY_PORT="${PROXY_PORT:-3002}"
PROXY_TOKEN_FILE="$PROJECT_ROOT/store/.credential-proxy-token"
# The token file can be STALE: if the main process crashed (SIGKILL, no clean
# 'close'), the file survives but its token no longer matches any running proxy,
# and any new proxy minted a different randomUUID(). Trusting the file blindly
# would export a dead token and fail every request with a silent 403. So we
# require BOTH: the file is readable AND the proxy port is actually accepting
# connections right now. On either failure, fall through to the actionable
# warning instead of failing deep inside synthesis.
proxy_reachable() {
    # Prefer a TCP probe (no auth needed); nc is on the launchd PATH.
    if command -v nc >/dev/null 2>&1; then
        nc -z -w 2 127.0.0.1 "$PROXY_PORT" >/dev/null 2>&1
    else
        # Fallback: bash /dev/tcp
        (exec 3<>"/dev/tcp/127.0.0.1/${PROXY_PORT}") >/dev/null 2>&1 && exec 3>&- 3<&-
    fi
}
if [ -r "$PROXY_TOKEN_FILE" ] && proxy_reachable; then
    PROXY_TOKEN="$(cat "$PROXY_TOKEN_FILE")"
    export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}/${PROXY_TOKEN}"
    export ANTHROPIC_API_KEY="sk-proxy-placeholder"  # SDK needs a non-empty key; proxy injects the real credential
    echo "Auth: routing Claude via credential proxy on :${PROXY_PORT}"
elif [ -r "$PROXY_TOKEN_FILE" ]; then
    echo "WARNING: credential proxy token file present but proxy not reachable on :${PROXY_PORT} — the NanoClaw main process may have crashed (stale token). Synthesis will fail auth; not exporting a dead token."
else
    echo "WARNING: credential proxy token not found at $PROXY_TOKEN_FILE — is the NanoClaw main process running? Synthesis will fail auth."
fi

# Stage 1: Ingest (incremental — assign new papers to existing clusters)
echo "[1/3] Ingest (incremental)..."
$PYTHON "$SCRIPT_DIR/ingest.py" --incremental --skip-pdf 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[1/3] WARNING: Ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# Stage 2: Synthesize stale clusters
# Auth flows through the credential proxy set up above (ANTHROPIC_BASE_URL).
echo "[2/3] Synthesize stale clusters..."
$PYTHON "$SCRIPT_DIR/synthesize.py" --stale-only 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[2/3] WARNING: Synthesis had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# Stage 3: QMD re-index
echo "[3/3] QMD re-index..."
if command -v qmd &>/dev/null; then
    BUN_INSTALL= qmd update 2>&1 || true
    BUN_INSTALL= qmd embed 2>&1 || true
else
    echo "[3/3] WARNING: qmd not found in PATH"
    ERRORS=$((ERRORS + 1))
fi

echo ""
echo "=========================================="
echo "Maintenance complete: $(date) | Errors: $ERRORS"
echo "=========================================="
exit $ERRORS
