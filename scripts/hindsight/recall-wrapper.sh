#!/bin/bash
# recall-wrapper.sh — drop-in replacement for the hindsight-memory plugin's
# UserPromptSubmit hook command, with agent-reflection filtering applied.
#
# Pipes the hook stdin JSON through the plugin's recall.py, then through
# scripts/hindsight/reflection_filter.py (which strips
# `[experience]` memories that involve only `claude_code (AI agent)`).
#
# HANDOFF — Claude Code merges hooks across all sources (plugin + user
# settings) rather than letting one shadow another, so this wrapper
# cannot simply be added alongside the plugin's hook. The plugin must
# be DISABLED first (set `"hindsight-memory@hindsight": false` in
# `enabledPlugins` in `~/.claude/settings.json`), then this wrapper
# added as a top-level user `UserPromptSubmit` hook. See
# `scripts/hindsight/README.md` (section "Activate") for the full
# two-step procedure.
#
# Failure mode: if the filter crashes, the original recall output is passed
# through unchanged AND a stderr breadcrumb fires (plus a timestamped marker
# file at ~/.cache/hindsight-filter-fallback). We never drop the hook
# entirely — silent passthrough would let the noise problem return
# unnoticed if a future plugin update breaks the filter.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FILTER="${REPO_ROOT}/scripts/hindsight/reflection_filter.py"
FALLBACK_MARKER="${HOME}/.cache/hindsight-filter-fallback"

# Emit a breadcrumb when filtering fails. The recall path is preserved (the
# caller still sees the unfiltered recall output), but the breadcrumb makes
# the failure visible to ops monitoring + leaves a timestamp on disk.
_breadcrumb() {
    local reason="${1:-unknown}"
    echo "[recall-wrapper] filter failed (${reason}), passing through unfiltered" >&2
    mkdir -p "$(dirname "${FALLBACK_MARKER}")" 2>/dev/null || true
    date -u +%Y-%m-%dT%H:%M:%SZ >> "${FALLBACK_MARKER}" 2>/dev/null || true
}

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

# Apply the filter; capture its exit code so we can detect a real crash
# vs. an empty-but-successful filter result.
FILTERED="$(printf '%s' "${RECALL_OUT}" | (python3 "${FILTER}" \
    || python "${FILTER}") 2>/dev/null)"
FILTER_RC=$?

if [[ ${FILTER_RC} -ne 0 ]]; then
    _breadcrumb "exit ${FILTER_RC}"
    printf '%s' "${RECALL_OUT}"
elif [[ -z "${FILTERED}" ]]; then
    # Filter exited 0 but produced no output — treat as crash, fall back.
    _breadcrumb "empty output"
    printf '%s' "${RECALL_OUT}"
else
    printf '%s' "${FILTERED}"
fi
