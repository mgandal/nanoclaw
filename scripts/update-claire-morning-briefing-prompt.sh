#!/usr/bin/env bash
# Update the claire-morning-briefing scheduled_tasks row with the new prompt.
# RUN MANUALLY during Stage I3 of the email-task-closure rollout.
#
# This script:
# 1. Backs up the current prompt to a timestamped file in /tmp.
# 2. Loads the new prompt from docs/runtime-changes/2026-05-06-...after.txt.
# 3. Applies the UPDATE via parameter binding (NOT readfile() — see memory note about BLOB corruption).
# 4. Verifies the prompt column type is still text after the update.

set -euo pipefail

DB="/Users/mgandal/Agents/nanoclaw/store/messages.db"
NEW_PROMPT_FILE="$(cd "$(dirname "$0")/.." && pwd)/docs/runtime-changes/2026-05-06-claire-morning-briefing-prompt-after.txt"
BACKUP_FILE="/tmp/claire-morning-briefing-prompt.$(date +%Y%m%dT%H%M%S).bak"

if [[ ! -f "$NEW_PROMPT_FILE" ]]; then
  echo "ERROR: new prompt file not found: $NEW_PROMPT_FILE" >&2
  exit 1
fi

echo "Backing up current prompt to $BACKUP_FILE..."
sqlite3 "$DB" "SELECT prompt FROM scheduled_tasks WHERE id='claire-morning-briefing';" > "$BACKUP_FILE"
if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "ERROR: current prompt was empty — refusing to overwrite." >&2
  exit 1
fi
echo "  Backup size: $(wc -c < "$BACKUP_FILE") bytes"

NEW_PROMPT="$(cat "$NEW_PROMPT_FILE")"
echo "Applying UPDATE (new prompt size: ${#NEW_PROMPT} bytes)..."
sqlite3 "$DB" \
  "UPDATE scheduled_tasks SET prompt = ? WHERE id='claire-morning-briefing';" \
  "$NEW_PROMPT"

# Verify column type — defensive against the readfile() BLOB-corruption issue
TYPE=$(sqlite3 "$DB" "SELECT typeof(prompt) FROM scheduled_tasks WHERE id='claire-morning-briefing';")
if [[ "$TYPE" != "text" ]]; then
  echo "ERROR: prompt column type is now '$TYPE' (expected 'text'). Restoring from backup." >&2
  RESTORE_PROMPT="$(cat "$BACKUP_FILE")"
  sqlite3 "$DB" \
    "UPDATE scheduled_tasks SET prompt = ? WHERE id='claire-morning-briefing';" \
    "$RESTORE_PROMPT"
  exit 1
fi

echo "Update applied successfully. Backup retained at: $BACKUP_FILE"
echo "Verify with:"
echo "  sqlite3 $DB \"SELECT length(prompt), substr(prompt, -200) FROM scheduled_tasks WHERE id='claire-morning-briefing';\""
