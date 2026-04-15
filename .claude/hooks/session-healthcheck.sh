#!/bin/bash
# SessionStart hook: check NanoClaw service status and inject into context
# Output: JSON with hookSpecificOutput.additionalContext for model injection

LINES=()

# NanoClaw process
if pgrep -f "bun.*nanoclaw" > /dev/null 2>&1; then
  NC_PID=$(pgrep -f "bun.*nanoclaw" | head -1)
  LINES+=("NanoClaw: RUNNING (pid $NC_PID)")
else
  LINES+=("NanoClaw: DOWN")
fi

# QMD (port 8181)
QMD=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:8181/health 2>/dev/null)
if [ "$QMD" = "200" ]; then
  LINES+=("QMD: UP (8181)")
else
  LINES+=("QMD: DOWN")
fi

# Honcho/Docker (port 8010)
HONCHO=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:8010/ 2>/dev/null)
if [ "$HONCHO" != "000" ] && [ -n "$HONCHO" ]; then
  LINES+=("Honcho: UP (8010)")
else
  LINES+=("Honcho: DOWN")
fi

# Ollama (port 11434)
OLLAMA=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:11434/api/tags 2>/dev/null)
if [ "$OLLAMA" = "200" ]; then
  LINES+=("Ollama: UP (11434)")
else
  LINES+=("Ollama: DOWN")
fi

# Apple Notes MCP (port 8184) — 405 on GET means UP
AN=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:8184/mcp 2>/dev/null)
if [ "$AN" = "405" ] || [ "$AN" = "200" ]; then
  LINES+=("Apple Notes MCP: UP (8184)")
else
  LINES+=("Apple Notes MCP: DOWN")
fi

# Todoist MCP (port 8186) — 405 on GET means UP
TODO=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:8186/mcp 2>/dev/null)
if [ "$TODO" = "405" ] || [ "$TODO" = "200" ]; then
  LINES+=("Todoist MCP: UP (8186)")
else
  LINES+=("Todoist MCP: DOWN")
fi

# Calendar MCP (port 8188)
CAL=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:8188/mcp 2>/dev/null)
if [ "$CAL" = "405" ] || [ "$CAL" = "200" ]; then
  LINES+=("Calendar MCP: UP (8188)")
else
  LINES+=("Calendar MCP: DOWN")
fi

# Docker containers (one line per container)
while IFS= read -r line; do
  [ -n "$line" ] && LINES+=("Docker: $line")
done < <(docker ps --format "{{.Names}}: {{.Status}}" 2>/dev/null | head -5)

# Stale processes check (SQLite lock prevention)
STALE=$(pgrep -f "container run.*nanoclaw" 2>/dev/null | wc -l | tr -d ' ')
if [ "$STALE" -gt 0 ]; then
  LINES+=("WARNING: $STALE orphaned container process(es) detected")
fi

# Join lines with newline, then use jq to build valid JSON
BODY=$(printf '%s\n' "${LINES[@]}")
jq -n --arg ctx "Service status at session start:
$BODY" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  },
  suppressOutput: true
}'
