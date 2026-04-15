#!/bin/bash
# PostToolUse hook: run co-located test file after editing a source .ts file
# Receives JSON on stdin with tool_input.file_path or tool_response.filePath

f=$(jq -r '.tool_response.filePath // .tool_input.file_path' 2>/dev/null)

# Only run for src/*.ts files that aren't test files themselves
if echo "$f" | grep -qE 'src/.*\.ts$' && ! echo "$f" | grep -qE '\.test\.ts$'; then
  t="${f%.ts}.test.ts"
  if [ -f "$t" ]; then
    cd /Users/mgandal/Agents/nanoclaw
    bun --bun vitest run "$t" 2>&1 | tail -8
  fi
fi
