#!/usr/bin/env bash
# Idempotent installer for com.nanoclaw.train-task-closure.
# Mirrors com.nanoclaw.train-classifier.plist (StartCalendarInterval).
#
# RUN MANUALLY during Stage I3 of the email-task-closure rollout, AFTER:
#   1. The feat/email-task-closure branch is merged to main.
#   2. The email-task-closure system has been running in dry-run mode (Stage I1)
#      and suggest-only mode (Stage I2) for ~6 days.
#   3. ~/.cache/email-ingest/task-closures.jsonl has accumulated some events
#      that the trainer can actually learn from.
#
# What it does:
#   - Writes the plist to ~/Library/LaunchAgents/com.nanoclaw.train-task-closure.plist
#   - Verifies plist XML is well-formed (plutil -lint)
#   - Reloads launchd (unload then load — idempotent across re-runs)
#   - Prints the active launchctl list entry to confirm

set -euo pipefail

PLIST_PATH="$HOME/Library/LaunchAgents/com.nanoclaw.train-task-closure.plist"
PYTHON="/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3"
SCRIPT_DIR="/Users/mgandal/Agents/nanoclaw/scripts/sync"
LOG_DIR="$HOME/.cache/email-ingest"
mkdir -p "$LOG_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.train-task-closure</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>-m</string>
        <string>email_ingest.task_closure_trainer</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Hour</key>
        <integer>2</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/train-task-closure-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/train-task-closure-stderr.log</string>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PYTHONPATH</key>
        <string>$SCRIPT_DIR</string>
    </dict>
</dict>
</plist>
EOF

# Verify plist syntax before loading
plutil -lint "$PLIST_PATH"

# Idempotent reload
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "Installed: $PLIST_PATH"
launchctl list | grep -F com.nanoclaw.train-task-closure || true
