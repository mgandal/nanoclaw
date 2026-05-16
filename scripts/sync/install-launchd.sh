#!/bin/bash
# install-launchd.sh — idempotent installer for the two launchd plists
# that back the sync hardening introduced after the 2026-05-16 Notes.app
# lockup incident:
#
#   1. com.nanoclaw.sync               — the periodic sync job, plus
#      ExitTimeOut=300 and ThrottleInterval=60 (outer kill switch and
#      respawn rate limit, added 2026-05-16).
#   2. com.nanoclaw.sync-pinning-watchdog — the watchdog of watchdogs
#      that catches GUI-app pinning by sync-* processes (added
#      2026-05-16).
#
# Previously these plists existed only as deployed config in
# ~/Library/LaunchAgents/. Per code-review issue #11 (2026-05-16): a
# new machine setup would lose them and the hardening with them. This
# installer is the version-controlled, idempotent, testable install
# path that closes that gap.
#
# Flags:
#   --dry-run      Print what would be installed, don't write anything
#   --no-restart   Install files but skip launchctl bootstrap/kickstart
#
# Environment overrides (primarily for tests):
#   LAUNCH_AGENTS_DIR  defaults to ~/Library/LaunchAgents
#
# References: scripts/bridges/install-start-updates.sh has the analogous
# pattern for MCP bridge start.sh files.

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
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLISTBUDDY=/usr/libexec/PlistBuddy

if [ ! -x "$PLISTBUDDY" ]; then
  echo "ERROR: $PLISTBUDDY not found — required for plist manipulation" >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR"

# Capture existing EnvironmentVariables (if any) before we overwrite the
# plist, so we can re-apply user customizations on top of our defaults.
# Returns: list of "KEY=VALUE" lines via stdout, one per env var.
capture_env_vars() {
  local plist="$1"
  if [ ! -f "$plist" ]; then
    return 0
  fi
  # PlistBuddy doesn't have a clean "list keys" output, so parse the
  # `Print :EnvironmentVariables` Dict output. Format:
  #   Dict {
  #       KEY = value
  #       ...
  #   }
  "$PLISTBUDDY" -c "Print :EnvironmentVariables" "$plist" 2>/dev/null \
    | sed -n -E 's/^[[:space:]]+([A-Za-z_][A-Za-z0-9_]*) = (.*)$/\1=\2/p' \
    || true
}

# Keys our template sets by default. Captured user customizations for
# these keys are dropped on re-install (they'd conflict and our default
# values are the canonical ones). Only env vars OUTSIDE this set get
# re-applied — those are genuinely user-added.
SYNC_TEMPLATE_KEYS="PATH HOME EMAIL_FOLLOWUPS_ENABLED TASK_CLOSURE_ENABLED TASK_CLOSURE_DRY_RUN"

is_template_key() {
  local key="$1"
  for tk in $SYNC_TEMPLATE_KEYS; do
    [ "$key" = "$tk" ] && return 0
  done
  return 1
}

apply_env_vars() {
  local target="$1"; shift
  for kv in "$@"; do
    local key="${kv%%=*}"
    local val="${kv#*=}"
    # Skip keys that are part of our default template — re-Adding fails
    # (already exists) and Setting overrides our defaults with potentially
    # stale captured values.
    if is_template_key "$key"; then
      continue
    fi
    # User-added key — Add it (it cannot exist in our just-written template).
    "$PLISTBUDDY" -c "Add :EnvironmentVariables:$key string $val" "$target" >/dev/null
  done
}

write_sync_plist() {
  local target="$1"
  local captured_env=()
  if [ -f "$target" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && captured_env+=("$line")
    done < <(capture_env_vars "$target")
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] would write $target"
    return 0
  fi

  cat > "$target" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${SCRIPT_DIR}/sync-all.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>14400</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ExitTimeOut</key>
    <integer>300</integer>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${SCRIPT_DIR}/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${SCRIPT_DIR}/launchd-stderr.log</string>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>EMAIL_FOLLOWUPS_ENABLED</key>
        <string>1</string>
        <key>TASK_CLOSURE_ENABLED</key>
        <string>1</string>
        <key>TASK_CLOSURE_DRY_RUN</key>
        <string>1</string>
    </dict>
</dict>
</plist>
EOF

  if [ "${#captured_env[@]}" -gt 0 ]; then
    apply_env_vars "$target" "${captured_env[@]}"
  fi

  echo "  wrote $target"
}

write_watchdog_plist() {
  local target="$1"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] would write $target"
    return 0
  fi
  cat > "$target" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.sync-pinning-watchdog</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>${HOME}/.hermes/scripts/sync_pinning_watchdog.py</string>
    </array>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME}/.cache/sync-pinning-watchdog/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.cache/sync-pinning-watchdog/launchd-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
EOF
  echo "  wrote $target"
}

reload_label() {
  local label="$1"
  local plist="$LAUNCH_AGENTS_DIR/${label}.plist"
  if [ "$DRY_RUN" = "1" ] || [ "$NO_RESTART" = "1" ]; then
    return 0
  fi
  launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "  reloaded $label"
}

echo "== com.nanoclaw.sync =="
write_sync_plist "$LAUNCH_AGENTS_DIR/com.nanoclaw.sync.plist"
reload_label "com.nanoclaw.sync"

echo ""
echo "== com.nanoclaw.sync-pinning-watchdog =="
write_watchdog_plist "$LAUNCH_AGENTS_DIR/com.nanoclaw.sync-pinning-watchdog.plist"
reload_label "com.nanoclaw.sync-pinning-watchdog"

echo ""
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] nothing was actually written."
elif [ "$NO_RESTART" = "1" ]; then
  echo "Installed. Skipped launchctl reload (--no-restart). Run:"
  echo "  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw.sync"
  echo "  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw.sync-pinning-watchdog"
else
  echo "Installed and reloaded."
fi
