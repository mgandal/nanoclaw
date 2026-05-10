#!/bin/bash
# Install watchdog-enabled start.sh files into each MCP bridge's cache
# dir, then kickstart the launchd job to pick them up. Idempotent —
# re-running overwrites with the same content and restarts the jobs.
#
# Why this exists: the original cache start.sh used bare `wait`, which
# deadlocks when one of supergateway/proxy dies and the other survives
# (KeepAlive=true is fooled because bash is "alive" hung in __wait4).
# The patched versions in this directory replace that with a `kill -0`
# watchdog loop that exits non-zero on any child death so launchd
# KeepAlive respawns the whole supervisor. See README.md.
#
# Flags:
#   --dry-run      Print what would be installed/restarted, don't change anything
#   --no-restart   Install files but skip launchctl kickstart (manual restart later)
set -eu

DRY_RUN=0
NO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-restart) NO_RESTART=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Each bridge: (cache_dir|repo_source|launchd_label)
BRIDGES=(
  "$HOME/.cache/apple-notes-mcp|$SCRIPT_DIR/start-apple-notes.sh|com.apple-notes-mcp"
  "$HOME/.cache/todoist-mcp|$SCRIPT_DIR/start-todoist.sh|com.todoist-mcp"
  "$HOME/.cache/calendar-mcp|$SCRIPT_DIR/start-calendar.sh|com.calendar-mcp"
)

for entry in "${BRIDGES[@]}"; do
  IFS='|' read -r cache_dir repo_source launchd_label <<< "$entry"
  if [ ! -d "$cache_dir" ]; then
    echo "SKIP: $cache_dir does not exist"
    continue
  fi
  if [ ! -f "$repo_source" ]; then
    echo "ERROR: missing repo source $repo_source" >&2
    exit 1
  fi
  echo "== $launchd_label =="

  target="$cache_dir/start.sh"

  # Diff first so the operator can see what's changing.
  if [ -f "$target" ]; then
    if cmp -s "$target" "$repo_source"; then
      echo "  unchanged: $target already matches repo copy"
      if [ "$NO_RESTART" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
        # Even when unchanged, ensure the running bash is the patched
        # version (in case the file was edited while bash was running).
        # Skip kickstart only if --no-restart was passed.
        :
      fi
    else
      echo "  CHANGED — diff:"
      diff "$target" "$repo_source" | sed 's/^/    /' || true
    fi
  else
    echo "  NEW: target does not yet exist"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY-RUN: would copy $repo_source → $target and kickstart $launchd_label"
    continue
  fi

  # One-time backup of the prior file, like install-proxy-updates.sh.
  if [ -f "$target" ] && [ ! -f "$target.pre-watchdog" ] && ! cmp -s "$target" "$repo_source"; then
    cp "$target" "$target.pre-watchdog"
    echo "  backed up old start.sh → start.sh.pre-watchdog"
  fi

  install -m 0755 "$repo_source" "$target"
  echo "  installed $target"

  if [ "$NO_RESTART" -eq 1 ]; then
    echo "  skipping kickstart (--no-restart)"
    continue
  fi

  launchctl kickstart -k "gui/$(id -u)/$launchd_label"
  echo "  kickstarted $launchd_label"
done

echo
echo "Done. Verify with:"
echo "  bash scripts/bridges/install-start-updates.sh --dry-run"
echo "or run /healthcheck for a full bridge probe."
