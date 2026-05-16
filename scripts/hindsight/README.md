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
     (`claude_code (AI agent)`, no human peer).

Anything `[world]`-typed, anything mentioning a human, anything ambiguous —
preserved.

## Files

| File | Role |
|------|------|
| `reflection_filter.py` | Pure-Python filter. `is_reflection(line)`, `filter_block(block)`, `filter_hook_output_json(raw)`. Also runs as a stdin→stdout CLI. |
| `recall-wrapper.sh` | Drop-in replacement for the plugin's `UserPromptSubmit` command — pipes plugin output through the filter. |
| `tests/test_reflection_filter.py` | 20 unit + block + envelope tests, plus the live canary corpus from `last_recall.json`. |

## Activate

The plugin source itself lives outside this repo
(`~/.claude/plugins/cache/hindsight/`) and **must not be modified**.
To turn the filter on, edit `~/.claude/settings.json` and replace the
hindsight `UserPromptSubmit` command:

```diff
 "UserPromptSubmit": [
   {
     "hooks": [
       {
         "type": "command",
-        "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/recall.py\" || python \"${CLAUDE_PLUGIN_ROOT}/scripts/recall.py\""
+        "command": "/Users/mgandal/Agents/nanoclaw/scripts/hindsight/recall-wrapper.sh"
       }
     ]
   }
 ]
```

The wrapper still runs the plugin's `recall.py` (resolving the newest cached
version automatically) — it just filters the output. If the filter crashes
the wrapper falls back to the unfiltered recall output so the recall path
never goes silent.

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
  happens, the malformed-input path in `filter_hook_output_json` passes
  the original through unchanged.
