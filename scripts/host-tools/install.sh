#!/bin/bash
# Install repo-managed host tools into ~/claire-tools/.
# Symlinks each script so edits in the repo propagate automatically.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$HOME/claire-tools"

mkdir -p "$TOOLS_DIR"

for src in "$REPO_DIR"/*.sh; do
  name="$(basename "$src")"
  [[ "$name" == "install.sh" ]] && continue

  dest="$TOOLS_DIR/$name"

  if [[ -L "$dest" ]] && [[ "$(readlink "$dest")" == "$src" ]]; then
    echo "ok    $name (already linked)"
    continue
  fi

  if [[ -e "$dest" ]] && ! [[ -L "$dest" ]]; then
    backup="$dest.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$dest" "$backup"
    echo "saved $name existing copy -> $(basename "$backup")"
  fi

  ln -sf "$src" "$dest"
  chmod +x "$src"
  echo "link  $name"
done
