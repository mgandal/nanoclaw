#!/bin/bash
# PreToolUse hook: block Edit/Write on groups/global/state/*.md unless the
# user's most recent prompt explicitly names the file by basename.
#
# These files are EA-schema state read by every agent (USER.md, current.md,
# grants.md, projects.md, lab-roster.md, papers.md, context.md, goals.md,
# memory.md, watchlist.md). Silent overwrites are high-blast-radius; an
# explicit prompt mention is the override.
#
# Receives JSON on stdin with tool_input.file_path and transcript_path.
# Exit 2 = block + show stderr to Claude. Exit 0 = allow.

set -u

payload=$(cat)
file_path=$(echo "$payload" | jq -r '.tool_input.file_path // empty')
transcript_path=$(echo "$payload" | jq -r '.transcript_path // empty')

# Not a state file? Allow.
case "$file_path" in
  */groups/global/state/*.md) : ;;
  *) exit 0 ;;
esac

# Override: did the most recent user prompt name this exact basename?
basename=$(basename "$file_path")
if [ -n "$transcript_path" ] && [ -r "$transcript_path" ]; then
  # Read the last user message from the JSONL transcript and check for the
  # basename. The last user message is the most recent {"type":"user",...}
  # entry; we approximate by tailing and grepping the basename, which is
  # safer than parsing JSON in bash.
  last_user_prompt=$(
    tac "$transcript_path" 2>/dev/null \
      | jq -r 'select(.type == "user") | .message.content // empty' 2>/dev/null \
      | head -c 4000
  )
  if echo "$last_user_prompt" | grep -qF "$basename"; then
    exit 0
  fi
fi

# Block.
echo "BLOCKED by protect-state-files hook: $file_path is an EA-schema state file." >&2
echo "If this edit is intentional, reissue the request naming '$basename' explicitly." >&2
exit 2
