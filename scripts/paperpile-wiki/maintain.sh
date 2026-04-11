#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV="$SCRIPT_DIR/venv"
PYTHON="$VENV/bin/python3"
LOG="$SCRIPT_DIR/pipeline.log"
ERRORS=0

exec > >(tee -a "$LOG") 2>&1
echo ""
echo "=========================================="
echo "Paperpile Wiki Maintenance: $(date)"
echo "=========================================="

# Stage 1: Ingest (incremental — assign new papers to existing clusters)
echo "[1/3] Ingest (incremental)..."
$PYTHON "$SCRIPT_DIR/ingest.py" --incremental --skip-pdf 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[1/3] WARNING: Ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# Stage 2: Synthesize stale clusters
# synthesize.py reads CLAUDE_CODE_OAUTH_TOKEN from .env directly (no proxy needed)
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
