#!/usr/bin/env bash
# setup.sh — Set up the paperpile-wiki pipeline environment
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

VENV_DIR="$SCRIPT_DIR/venv"
DB_PATH="$REPO_ROOT/store/paperpile.db"
OUTPUT_DIR="/Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile"

echo "==> Creating virtualenv..."
python3 -m venv "$VENV_DIR"

echo "==> Installing dependencies..."
"$VENV_DIR/bin/pip" install --upgrade pip --quiet
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements.txt" --quiet

echo "==> Initialising database at $DB_PATH..."
"$VENV_DIR/bin/python" - <<'EOF'
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from db import init_db, DB_PATH
init_db(DB_PATH)
print(f"  DB ready: {DB_PATH}")
EOF

echo "==> Creating output directories..."
mkdir -p "$OUTPUT_DIR"
echo "  Output dir: $OUTPUT_DIR"

echo "==> Setup complete."
