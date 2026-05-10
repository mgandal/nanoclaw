#!/bin/bash
# PostToolUse hook: run `bun run typecheck` after edits to src/**/*.ts.
#
# Why this is separate from run-colocated-test.sh:
#   - run-colocated-test.sh answers "did I break this file's behavior?"
#   - this hook answers "did I break a caller in another file?"
#
# Co-located tests miss cross-file type errors; tsc catches them in ~3-8s.
# Output is tail-trimmed so a clean run stays quiet but failures surface.

set -u

payload=$(cat)
file_path=$(echo "$payload" | jq -r '.tool_response.filePath // .tool_input.file_path // empty')

# Only trigger for edits inside src/, and only for .ts files.
# Skip .test.ts — those are already covered by run-colocated-test.sh.
case "$file_path" in
  */nanoclaw/src/*.ts|src/*.ts) : ;;
  *) exit 0 ;;
esac
case "$file_path" in
  *.test.ts) exit 0 ;;
esac

cd /Users/mgandal/Agents/nanoclaw || exit 0

# Run typecheck. tsc returns nonzero on type errors. We surface only the
# error lines — a clean run produces no output, so the hook is silent on
# success and informative on failure.
out=$(bun run typecheck 2>&1)
status=$?

if [ $status -ne 0 ]; then
  echo "[typecheck] errors after edit to $file_path:" >&2
  echo "$out" | grep -E "error TS|^\S" | head -20 >&2
fi

# Don't block — typecheck is informational, not gating. The user/agent
# decides whether to fix now or continue. Returning 0 keeps the edit applied.
exit 0
