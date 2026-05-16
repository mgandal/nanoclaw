# Hindsight recall filter

Strips agent self-reflection memories out of the `<hindsight_memories>`
block injected on every `UserPromptSubmit` by the external
`hindsight-memory` Claude Code plugin (vectorize-io/hindsight).

## Why

The plugin's `Stop` hook auto-retains the full conversation transcript.
The Hindsight server's extraction LLM (phi4-mini) turns agent self-narration
("the next step is X", "options for next steps include Y") into
`[experience]` memories labelled `Involving: claude_code (AI agent)`.

`recall.py` then injects those into every future prompt, polluting context
with stale agent self-talk. Verified live 2026-05-16: 15/15 memories in
`~/.claude/plugins/data/hindsight-memory-hindsight/state/last_recall.json`
matched the reflection pattern.

## What it does

`reflection_filter.py` keeps any memory unless **both**:

  1. its type tag is `[experience]`, AND
  2. its `Involving:` segment lists *only* the agent
     (`claude_code (AI agent)`, no human peer),

AND it does **not** carry a high-signal content pattern: a backtick code
span, a SHA-like token (7-40 hex), a semver-ish version (`1.2`, `v0.33.0`),
or a path fragment (`@types/sharp`, `fix/branch-name`). Memories with those
patterns are rescued even when structurally a "reflection", because phi4-
mini regularly mis-tags durable facts (verified live adversarial probe,
2026-05-16) — e.g. `` `gbrain recall --since-last-run` `` notes, commit-
SHA references, or `@types/sharp` cruft notes.

The rescue is overridden by an explicit force-drop signature list:
"The next step…", "Options for next steps…", "The agent decided/noted/
identified/completed…", "recommended next move/action". Those phrases are
canonical self-talk and drop regardless of content.

Anything `[world]`-typed, anything mentioning a human, anything ambiguous —
preserved.

## Files

| File | Role |
|------|------|
| `reflection_filter.py` | Pure-Python filter. `is_reflection(line)`, `filter_block(block)`, `filter_hook_output_json(raw)`. Also runs as a stdin→stdout CLI. |
| `recall-wrapper.sh` | Drop-in replacement for the plugin's `UserPromptSubmit` command — pipes plugin output through the filter. On filter crash, emits a stderr breadcrumb + writes a timestamp to `~/.cache/hindsight-filter-fallback`, then passes through unfiltered. |
| `tests/test_reflection_filter.py` | 26 unit + block + envelope + wrapper-breadcrumb tests, including the live canary corpus from `last_recall.json` and adversarial-known-good rescue cases. |

## Activate

**This filter cannot be activated by simply adding a user hook.** Claude
Code's hook resolution is **additive across sources** — see the
[official docs](https://code.claude.com/docs/en/hooks): a user-level
`UserPromptSubmit` hook in `~/.claude/settings.json` does **not** shadow
or replace the plugin's hook from
`~/.claude/plugins/cache/hindsight/hindsight-memory/<version>/hooks/hooks.json`.
Both would fire, and Claude would receive both `additionalContext` blocks —
doubling the injection instead of replacing it.

Claude Code also does not support per-hook disabling: the only
plugin-scoped switch is `enabledPlugins[plugin@marketplace] = false`,
which disables **all** of the plugin's hooks (`SessionStart`,
`UserPromptSubmit`, `Stop`, `SessionEnd`) and skills.

So the activation pattern is: **disable the plugin's hook registration,
then add the wrapper as a top-level user hook**. The wrapper still runs
the plugin's bundled `recall.py` from the cache (the cache is preserved
when the plugin is disabled — only `uninstall` removes it), but it owns
the `UserPromptSubmit` registration and applies the filter.

### Step 1 — Disable the plugin's hooks

Edit `~/.claude/settings.json` and flip the plugin entry to `false`:

```diff
 "enabledPlugins": {
   ...
-  "hindsight-memory@hindsight": true,
+  "hindsight-memory@hindsight": false,
   ...
 }
```

This stops `recall.py`, `retain.py`, `session_start.py`, and
`session_end.py` from registering — but the files stay on disk under
`~/.claude/plugins/cache/hindsight/hindsight-memory/<version>/`, which is
what the wrapper resolves.

> ⚠️ This also disables auto-retention (`Stop` hook). If you still want
> Hindsight to record new memories from this session forward, you must
> re-host the `retain.py` and `session_start.py` hooks the same way (add
> them to `~/.claude/settings.json` under the matching `hookEventName`).
> For now this filter only handles the `UserPromptSubmit` (recall) path.

### Step 2 — Add the wrapper as a user hook

Add a `UserPromptSubmit` entry to `~/.claude/settings.json`. If you
already have a top-level `"hooks"` block, append to it:

```json
"hooks": {
  "UserPromptSubmit": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "/Users/mgandal/Agents/nanoclaw/scripts/hindsight/recall-wrapper.sh",
          "timeout": 12
        }
      ]
    }
  ]
}
```

The wrapper auto-resolves the newest cached `recall.py` under
`~/.claude/plugins/cache/hindsight/hindsight-memory/*/scripts/recall.py`
at run time. The hardcoded absolute path in the `command` field assumes
this repo lives at `/Users/mgandal/Agents/nanoclaw/`; adjust if your
checkout is elsewhere.

### Step 3 — Reload

Restart Claude Code or run `/reload-plugins`. Verify the change by
sending a prompt and inspecting `last_recall.json` — the noisy
`[experience]` + agent-only entries should be absent from the injected
`<hindsight_memories>` block.

### Failure mode

If the filter crashes for any reason (e.g. a future plugin update changes
the recall envelope schema), the wrapper:

1. Falls back to the unfiltered plugin output (recall path never silently
   goes dark).
2. Prints `[recall-wrapper] filter failed (...), passing through unfiltered`
   to stderr.
3. Appends an ISO timestamp to `~/.cache/hindsight-filter-fallback` so
   you can see fallback events accumulating.

Watch for the marker file to know whether the filter is healthy. If it
grows, audit the plugin's recall output schema against
`filter_hook_output_json` in `reflection_filter.py`.

## Verify

```bash
# Run the unit tests
python3 -m pytest scripts/hindsight/tests/test_reflection_filter.py -v

# Run against the live recall state (canary)
python3 -c "
import json, sys
sys.path.insert(0, 'scripts/hindsight')
import reflection_filter as rf
state = json.load(open('${HOME}/.claude/plugins/data/hindsight-memory-hindsight/state/last_recall.json'))
print(rf.filter_block(state['context']))
"
```

## What it doesn't do

- Doesn't delete memories from the Hindsight server. (Out of scope per the
  task. The bank still grows; only injection is filtered.)
- Doesn't touch the in-container `mcp__hindsight__retain` path used by
  agent personas (Claire, Simon, etc.) — those write to bank `hermes`
  with structured `agent_name: "..."` content and are NOT the source of
  the noise. The host-side plugin uses bank `claude_code`.
- Doesn't modify the plugin source. The plugin is external (auto-updates)
  and a future plugin update could change the recall envelope; if that
  happens, `filter_hook_output_json` returns the original unchanged AND
  the wrapper logs a fallback breadcrumb.
- Doesn't re-host the plugin's other hooks (`SessionStart`, `Stop`,
  `SessionEnd`). When you disable the plugin in Step 1, those go silent
  too. If you need retention to keep working, add `retain.py` as a user
  `Stop` hook the same way you add the wrapper for `UserPromptSubmit`.
- Doesn't pin a plugin version. `recall-wrapper.sh` resolves the
  newest-by-version directory under `~/.claude/plugins/cache/hindsight/
  hindsight-memory/*/scripts/recall.py` at run time. If the plugin
  publisher renames the package or the cache layout, the wrapper will
  emit the `Plugin not installed — emit empty hook output` path and
  recall will silently no-op (no breadcrumb in that case — fix planned).
