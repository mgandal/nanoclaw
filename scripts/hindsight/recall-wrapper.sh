#!/bin/bash
# recall-wrapper.sh — drop-in replacement for the hindsight-memory plugin's
# UserPromptSubmit hook command, with agent-reflection filtering applied.
#
# Pipes the hook stdin JSON through the plugin's recall.py, then through
# scripts/hindsight/reflection_filter.py (which strips
# `[experience]` memories that involve only `claude_code (AI agent)`).
#
# HANDOFF — to activate, replace the UserPromptSubmit hook command in
# `~/.claude/settings.json`:
#
#   FROM:
#     "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/recall.py\" || python \"${CLAUDE_PLUGIN_ROOT}/scripts/recall.py\""
#
#   TO:
#     "command": "/Users/mgandal/Agents/nanoclaw/scripts/hindsight/recall-wrapper.sh"
#
# (Or symlink this script into ~/.claude/hooks/ and reference it there.)
#
# Failure mode: if the filter crashes, the original recall output is passed
# through unchanged. We never drop the hook entirely.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FILTER="${REPO_ROOT}/scripts/hindsight/reflection_filter.py"

# Locate the plugin's recall.py. The plugin auto-updates, so we resolve the
# newest cached version at run time rather than pinning a path.
PLUGIN_DIR="${HOME}/.claude/plugins/cache/hindsight/hindsight-memory"
LATEST_RECALL="$(ls -d "${PLUGIN_DIR}"/*/scripts/recall.py 2>/dev/null \
    | sort -V | tail -1)"

if [[ -z "${LATEST_RECALL}" || ! -f "${LATEST_RECALL}" ]]; then
    # Plugin not installed — emit empty hook output (no injection).
    exec cat >/dev/null
fi

# Stash hook stdin so we can feed both recall.py and the filter.
STDIN_BUF="$(cat)"

# Required by recall.py for state dir resolution.
PLUGIN_ROOT="$(cd "$(dirname "${LATEST_RECALL}")/.." && pwd)"
export CLAUDE_PLUGIN_ROOT="${PLUGIN_ROOT}"
export CLAUDE_PLUGIN_DATA="${HOME}/.claude/plugins/data/hindsight-memory-hindsight"

# Run recall, then filter.
RECALL_OUT="$(printf '%s' "${STDIN_BUF}" | (python3 "${LATEST_RECALL}" \
    || python "${LATEST_RECALL}") 2>/dev/null)"

if [[ -z "${RECALL_OUT}" ]]; then
    exit 0
fi

# Apply the filter; on any error, emit the unfiltered recall output.
FILTERED="$(printf '%s' "${RECALL_OUT}" | (python3 "${FILTER}" \
    || python "${FILTER}") 2>/dev/null)"

if [[ -z "${FILTERED}" ]]; then
    printf '%s' "${RECALL_OUT}"
else
    printf '%s' "${FILTERED}"
fi
