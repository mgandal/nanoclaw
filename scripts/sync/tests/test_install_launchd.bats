#!/usr/bin/env bats
#
# Tests for install-launchd.sh — idempotent installer for the two
# launchd plists that back sync hardening: com.nanoclaw.sync (with
# ExitTimeOut=300, ThrottleInterval=60 added 2026-05-16) and
# com.nanoclaw.sync-pinning-watchdog (NEW, added 2026-05-16).
#
# Per code reviewer issue #11: these plists were previously deployed
# config only — a fresh machine setup would lose them. This installer
# closes that gap.
#
# Tests use a scratch LaunchAgents dir so they don't touch the real
# launchd domain (no bootstrap/bootout side effects). The installer
# must honor LAUNCH_AGENTS_DIR for testability.

setup() {
  export SCRATCH="$BATS_TMPDIR/install-launchd-$$-$RANDOM"
  mkdir -p "$SCRATCH/LaunchAgents"
  export LAUNCH_AGENTS_DIR="$SCRATCH/LaunchAgents"
  export INSTALLER="$BATS_TEST_DIRNAME/../install-launchd.sh"
}

teardown() {
  rm -rf "$SCRATCH"
}

# ──────────────────────────────────────────────────────────────────────
# Contract 1: installer exists, is executable, accepts --dry-run
# ──────────────────────────────────────────────────────────────────────

@test "installer exists and is executable" {
  [ -x "$INSTALLER" ]
}

@test "installer --dry-run does not write any files" {
  run bash "$INSTALLER" --dry-run
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$LAUNCH_AGENTS_DIR")" ]
}

# ──────────────────────────────────────────────────────────────────────
# Contract 2: installer creates BOTH plists with the required keys
# ──────────────────────────────────────────────────────────────────────

@test "installer creates com.nanoclaw.sync.plist with ExitTimeOut=300" {
  run bash "$INSTALLER" --no-restart
  [ "$status" -eq 0 ]
  PLIST="$LAUNCH_AGENTS_DIR/com.nanoclaw.sync.plist"
  [ -f "$PLIST" ]
  exit_timeout=$(/usr/libexec/PlistBuddy -c "Print :ExitTimeOut" "$PLIST" 2>/dev/null)
  [ "$exit_timeout" = "300" ]
}

@test "installer creates com.nanoclaw.sync.plist with ThrottleInterval=60" {
  run bash "$INSTALLER" --no-restart
  [ "$status" -eq 0 ]
  PLIST="$LAUNCH_AGENTS_DIR/com.nanoclaw.sync.plist"
  throttle=$(/usr/libexec/PlistBuddy -c "Print :ThrottleInterval" "$PLIST" 2>/dev/null)
  [ "$throttle" = "60" ]
}

@test "installer creates com.nanoclaw.sync.plist with StartInterval=14400" {
  run bash "$INSTALLER" --no-restart
  [ "$status" -eq 0 ]
  PLIST="$LAUNCH_AGENTS_DIR/com.nanoclaw.sync.plist"
  interval=$(/usr/libexec/PlistBuddy -c "Print :StartInterval" "$PLIST" 2>/dev/null)
  [ "$interval" = "14400" ]
}

@test "installer creates watchdog plist com.nanoclaw.sync-pinning-watchdog.plist" {
  run bash "$INSTALLER" --no-restart
  [ "$status" -eq 0 ]
  PLIST="$LAUNCH_AGENTS_DIR/com.nanoclaw.sync-pinning-watchdog.plist"
  [ -f "$PLIST" ]
  interval=$(/usr/libexec/PlistBuddy -c "Print :StartInterval" "$PLIST" 2>/dev/null)
  [ "$interval" = "60" ]
}

@test "installer points sync.plist Program at /bin/bash" {
  run bash "$INSTALLER" --no-restart
  PLIST="$LAUNCH_AGENTS_DIR/com.nanoclaw.sync.plist"
  prog=$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$PLIST" 2>/dev/null)
  [ "$prog" = "/bin/bash" ]
}

@test "installer points watchdog plist Program at /usr/bin/python3" {
  run bash "$INSTALLER" --no-restart
  PLIST="$LAUNCH_AGENTS_DIR/com.nanoclaw.sync-pinning-watchdog.plist"
  prog=$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$PLIST" 2>/dev/null)
  [ "$prog" = "/usr/bin/python3" ]
}

# ──────────────────────────────────────────────────────────────────────
# Contract 3: idempotent — running twice produces the same result
# ──────────────────────────────────────────────────────────────────────

@test "installer is idempotent (run twice = same plist content)" {
  run bash "$INSTALLER" --no-restart
  [ "$status" -eq 0 ]
  PLIST="$LAUNCH_AGENTS_DIR/com.nanoclaw.sync.plist"
  first_hash=$(shasum "$PLIST" | awk '{print $1}')
  run bash "$INSTALLER" --no-restart
  [ "$status" -eq 0 ]
  second_hash=$(shasum "$PLIST" | awk '{print $1}')
  [ "$first_hash" = "$second_hash" ]
}

# ──────────────────────────────────────────────────────────────────────
# Contract 4: installer preserves user-set EnvironmentVariables on
# the sync plist (the real plist has EMAIL_FOLLOWUPS_ENABLED, etc.)
# This is the "don't clobber the user's customization" contract.
# ──────────────────────────────────────────────────────────────────────

@test "installer does not clobber existing EnvironmentVariables" {
  PLIST="$LAUNCH_AGENTS_DIR/com.nanoclaw.sync.plist"
  cat > "$PLIST" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/some/old/path/sync.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>14400</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CUSTOM_USER_FLAG</key>
        <string>preserved_value</string>
    </dict>
</dict>
</plist>
EOF
  run bash "$INSTALLER" --no-restart
  [ "$status" -eq 0 ]
  preserved=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:CUSTOM_USER_FLAG" "$PLIST" 2>/dev/null)
  [ "$preserved" = "preserved_value" ]
}

# ──────────────────────────────────────────────────────────────────────
# Contract 5: --no-restart skips launchctl kickstart (safety for CI)
# ──────────────────────────────────────────────────────────────────────

@test "installer --no-restart does not invoke launchctl kickstart" {
  STUB="$SCRATCH/bin"
  mkdir -p "$STUB"
  cat > "$STUB/launchctl" <<EOF
#!/bin/bash
echo "LAUNCHCTL_CALL: \$*" >> "$SCRATCH/launchctl.log"
exit 0
EOF
  chmod +x "$STUB/launchctl"
  PATH="$STUB:$PATH" run bash "$INSTALLER" --no-restart
  [ "$status" -eq 0 ]
  if [ -f "$SCRATCH/launchctl.log" ]; then
    ! grep -q "kickstart" "$SCRATCH/launchctl.log"
  fi
}
