#!/usr/bin/env python3
"""Filter agent-reflection noise out of Hindsight recall output.

Why this exists
---------------
The external `hindsight-memory` Claude Code plugin
(vectorize-io/hindsight, at ~/.claude/plugins/cache/hindsight/) ships every
session transcript to the Hindsight server, which then uses an LLM to
extract memories. The LLM happily extracts agent self-narration like
"the next step is X" or "options for next steps include Y" and labels them
`[experience]` with `Involving: claude_code (AI agent)`.

The `UserPromptSubmit` hook (`recall.py`) then injects these into EVERY
future prompt as a `<hindsight_memories>` block, polluting context with
stale agent self-talk.

The fix
-------
Filter the recall output at the prompt-time boundary. A memory is treated
as a "reflection" (and dropped) when ALL of the following hold:

  1. Its type tag is `[experience]` (not `[world]`, not `[directive]`)
  2. Its `Involving:` segment names ONLY `claude_code (AI agent)` —
     i.e. no human user is involved.

This is conservative: any memory that mentions a human peer (e.g.
`mike_gandal, claude_code (AI agent)`) is kept, and any `[world]`-typed
fact is kept regardless of involvement.

How to wire it in (handoff)
---------------------------
The plugin lives outside this repo and MUST NOT be modified directly per
the project constraint. To activate this filter, the user can either:

  A. Wrap the plugin's recall hook with `recall-wrapper.sh` (also in this
     directory) so it filters the JSON output before Claude Code sees it.
     Edit `~/.claude/settings.json` to replace the UserPromptSubmit
     command with the wrapper path.

  B. Run as a standalone deduplicator on `~/.claude/plugins/data/
     hindsight-memory-hindsight/state/last_recall.json` (diagnostic mode).

Both modes use the same `filter_block` / `filter_hook_output_json` API
exercised by `tests/test_reflection_filter.py`.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Optional

# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

# A memory line looks like:
#   - <text> [<type>] (<iso-timestamp>)
# inside a <hindsight_memories>...</hindsight_memories> block, separated
# by blank lines. The "type" tag is the LAST `[xxx]` before the parenthesised
# date.
_TYPE_TAG = re.compile(r"\[(?P<type>[a-z_]+)\](?=\s*\([^)]*\)\s*$)", re.IGNORECASE)

# `Involving: <comma-separated names>` — usually the last segment of a pipe-
# delimited memory line, but may appear anywhere. Capture only the contents
# up to the next pipe or the type tag.
_INVOLVING = re.compile(
    r"Involving:\s*(?P<who>[^|\[]+?)\s*(?=\||\[[a-z_]+\]\s*\(|$)",
    re.IGNORECASE,
)

# The plugin's full memory block, as emitted by recall.py.
_BLOCK_RE = re.compile(
    r"<hindsight_memories>(?P<inner>[\s\S]*?)</hindsight_memories>",
)

# Canonical agent-only "involving" set. Lowercased for comparison.
_AGENT_TOKENS = frozenset({"claude_code (ai agent)", "claude_code", "agent"})


# ---------------------------------------------------------------------------
# Per-line classifier
# ---------------------------------------------------------------------------


def _parse_type(line: str) -> Optional[str]:
    m = _TYPE_TAG.search(line)
    return m.group("type").lower() if m else None


def _parse_involving(line: str) -> list[str]:
    m = _INVOLVING.search(line)
    if not m:
        return []
    raw = m.group("who").strip()
    return [tok.strip().lower() for tok in raw.split(",") if tok.strip()]


def is_reflection(line: str) -> bool:
    """Return True if `line` is an agent self-reflection memory.

    A reflection is `[experience]`-typed AND involves only the agent.
    Empty / structural lines return False so the block-level filter can
    pass them through untouched.
    """
    if not line or not line.strip():
        return False
    if not line.lstrip().startswith("-"):
        # Header / preamble / current-time line
        return False

    mem_type = _parse_type(line)
    if mem_type != "experience":
        # `[world]`, `[directive]`, untyped → keep
        return False

    involving = _parse_involving(line)
    if not involving:
        # No involving segment at all — could be a generic experience.
        # Be conservative: keep it (don't drop ambiguous content).
        return False

    # Only drop if EVERY named party is an agent token (no human peer).
    for who in involving:
        if who not in _AGENT_TOKENS:
            return False
    return True


# ---------------------------------------------------------------------------
# Block-level filter
# ---------------------------------------------------------------------------


def _split_memory_entries(inner_block: str) -> tuple[str, list[str]]:
    """Split the inner block into (preamble, memory_lines).

    The preamble includes the recall instruction text and "Current time -"
    line. Memory lines start with `- ` and are separated by blank lines.
    """
    lines = inner_block.split("\n")
    preamble_parts: list[str] = []
    entries: list[str] = []
    in_entries = False
    current: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not in_entries:
            if stripped.startswith("-"):
                in_entries = True
                current = [line]
            else:
                preamble_parts.append(line)
            continue

        if not stripped:
            # Blank line — flush current entry if any
            if current:
                entries.append("\n".join(current).rstrip())
                current = []
            continue

        if stripped.startswith("-") and current:
            # New entry starts; flush previous
            entries.append("\n".join(current).rstrip())
            current = [line]
        else:
            # Continuation of current entry
            current.append(line)

    if current:
        entries.append("\n".join(current).rstrip())

    return "\n".join(preamble_parts).rstrip(), entries


def filter_block(text: str) -> str:
    """Filter agent-reflection memories out of a hindsight_memories block.

    If `text` doesn't contain a block, it's returned unchanged.
    If filtering drops every memory, the returned block contains only
    the preamble (no memory lines).
    """
    if not text or "<hindsight_memories>" not in text:
        return text

    def _replace(m: re.Match) -> str:
        inner = m.group("inner")
        preamble, entries = _split_memory_entries(inner)
        kept = [e for e in entries if not is_reflection(e)]
        if kept:
            body = preamble + "\n\n" + "\n\n".join(kept) + "\n"
        else:
            # No memories survived; keep the wrapper but make the body empty
            body = preamble + "\n"
        return f"<hindsight_memories>\n{body.lstrip()}</hindsight_memories>"

    return _BLOCK_RE.sub(_replace, text)


# ---------------------------------------------------------------------------
# Hook-output filter (JSON in / JSON out)
# ---------------------------------------------------------------------------


def _has_useful_memories(filtered_block: str) -> bool:
    """Return True if the filtered block contains at least one `- ` memory line."""
    if "<hindsight_memories>" not in filtered_block:
        return False
    m = _BLOCK_RE.search(filtered_block)
    if not m:
        return False
    inner = m.group("inner")
    for line in inner.split("\n"):
        if line.strip().startswith("-"):
            return True
    return False


def filter_hook_output_json(raw: str) -> str:
    """Filter a Claude Code hook-output JSON envelope.

    `recall.py` emits:
        {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                "additionalContext": "<hindsight_memories>...</hindsight_memories>"}}

    Returns the JSON serialized form with reflection memories stripped.
    If filtering leaves no memories, `additionalContext` is removed so
    Claude Code doesn't see an empty injection block.

    Malformed input is returned unchanged (defensive — graceful
    degradation matches the plugin's own posture).
    """
    if not raw or not raw.strip():
        return raw
    try:
        envelope = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return raw

    hook_out = envelope.get("hookSpecificOutput")
    if not isinstance(hook_out, dict):
        return raw
    ctx = hook_out.get("additionalContext")
    if not isinstance(ctx, str):
        return raw

    filtered_ctx = filter_block(ctx)

    if _has_useful_memories(filtered_ctx):
        hook_out["additionalContext"] = filtered_ctx
    else:
        # Strip the block entirely so Claude Code doesn't render an empty
        # `<hindsight_memories>` wrapper.
        hook_out.pop("additionalContext", None)

    return json.dumps(envelope, ensure_ascii=False)


# ---------------------------------------------------------------------------
# CLI entrypoint (stdin → stdout): pipe through to filter the JSON envelope.
# ---------------------------------------------------------------------------


def _main() -> int:
    raw = sys.stdin.read()
    sys.stdout.write(filter_hook_output_json(raw))
    return 0


if __name__ == "__main__":
    sys.exit(_main())
