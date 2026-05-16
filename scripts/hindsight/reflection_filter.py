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
the project constraint. Claude Code merges hooks across all sources
(plugin + user settings) rather than letting one shadow another, so the
filter cannot just be added as a separate user hook — that would double
the injection. The activation pattern is two-step:

  1. Disable the plugin via `enabledPlugins["hindsight-memory@hindsight"]
     = false` in `~/.claude/settings.json`. The plugin's recall.py stays
     on disk under `~/.claude/plugins/cache/...`; only its hook
     registrations are cleared.

  2. Add `recall-wrapper.sh` (in this directory) as a top-level user
     `UserPromptSubmit` hook in `~/.claude/settings.json`. The wrapper
     invokes the plugin's cached `recall.py`, then pipes the output
     through this module's `filter_hook_output_json`.

See `scripts/hindsight/README.md` (section "Activate") for the full
procedure including the breadcrumb / fallback behaviour.

The standalone `filter_block` / `filter_hook_output_json` API is also
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
# Content-pattern allowlist (rescue clause)
# ---------------------------------------------------------------------------
#
# Even when a memory is structurally a "reflection" (experience-typed,
# agent-only involving), it may carry durable, high-signal content that the
# extraction LLM mis-categorised. Real adversarial probe on live corpus found
# `[experience]` + agent-only memories like:
#
#   - v0.33.0's headline feature is `gbrain recall --since-last-run ...`
#   - The commit SHA is 66d8e85d on branch fix/outcome-watcher-storm-...
#   - @types/sharp is considered cruft since sharp ships its own types ...
#
# These are facts the model should remember even though phi4-mini's tagging
# is wrong. The rescue clause: if the body of the memory carries any of these
# high-signal patterns, keep it.
#
# We deliberately keep the rescue conservative — patterns are precise (SHA-
# like, semver, code spans, path fragments). General prose facts that lack
# these markers will still drop, which is the desired behaviour: the
# extraction LLM's tagging is the only signal we have for those.

_RESCUE_PATTERNS = (
    # Backtick code span — `something`
    re.compile(r"`[^`\n]+`"),
    # Git-like SHA (7-40 lowercase hex). Word-bounded to avoid embedding in
    # long alphanumeric tokens.
    re.compile(r"\b[0-9a-f]{7,40}\b"),
    # Semver-ish version reference: 1.2, 1.2.3, v0.33.0
    re.compile(r"\bv?\d+\.\d+(?:\.\d+)?\b"),
    # Path fragment — at least one slash with surrounding alphanum.
    # Matches `/usr/local/bin`, `@types/sharp`, `fix/branch-name`, etc.
    re.compile(r"[A-Za-z0-9@_.-]+/[A-Za-z0-9_./-]+"),
)

# Mandatory-drop signatures: if the line matches one of these, we keep
# treating it as a reflection regardless of the rescue patterns above.
# These are the canonical "self-narration" phrases the extraction LLM
# produces for agent self-talk; their presence outweighs incidental
# code-span content.
_FORCE_DROP_PATTERNS = (
    re.compile(r"\bThe next step\b", re.IGNORECASE),
    re.compile(r"\bOptions for (?:next steps?|next moves?)\b", re.IGNORECASE),
    re.compile(
        r"\bThe agent (?:decided|noted|identified|completed)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\brecommended (?:next move|action)\b", re.IGNORECASE),
)


# Trailing `[type] (timestamp)` tail of a memory line. We strip this before
# applying the rescue patterns so the timestamp's fractional seconds and
# `2026-...` numerics don't false-positive as "version" or "SHA-like".
_TAIL_RE = re.compile(
    r"\s*\[[a-z_]+\]\s*\([^)]*\)\s*$",
    re.IGNORECASE,
)


def _content_only(line: str) -> str:
    """Strip the `[type] (iso-timestamp)` tail used for pattern matching.

    The full memory format is
        `- <body> | ... | [type] (<iso-timestamp>)`
    The trailing tail is metadata, not content; its numerics (year, micro-
    seconds) can spuriously match the version/SHA rescue patterns. Strip it.
    """
    return _TAIL_RE.sub("", line)


def _has_high_signal_content(line: str) -> bool:
    """Return True if `line` contains a rescue-worthy content pattern.

    Used by `is_reflection` to refuse to drop structurally-reflective
    memories that nonetheless carry durable factual content.
    """
    body = _content_only(line)
    return any(p.search(body) for p in _RESCUE_PATTERNS)


def _matches_force_drop(line: str) -> bool:
    """Return True if `line` carries an explicit self-narration signature.

    These signatures override the rescue clause: a memory like "The next
    step is to look at `recall.py`" still drops despite the backtick span,
    because the lead-in is canonical self-talk.
    """
    body = _content_only(line)
    return any(p.search(body) for p in _FORCE_DROP_PATTERNS)


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

    A reflection is `[experience]`-typed AND involves only the agent AND
    does NOT carry a high-signal content pattern (code span, SHA, version,
    path) — UNLESS it matches one of the explicit self-narration
    signatures (`The next step`, `Options for next steps`, etc.), which
    override the rescue and force a drop.

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

    # Structurally a reflection. Apply the content-pattern allowlist.
    # Force-drop signatures bypass the rescue (canonical self-talk wins
    # over incidental code-span content).
    if _matches_force_drop(line):
        return True
    if _has_high_signal_content(line):
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
