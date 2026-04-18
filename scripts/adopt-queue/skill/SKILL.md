---
name: queue-adopt
description: "Queue a repository for laptop-side adoption. Use after /eval-repo produces an ADOPT or STEAL verdict, or when Mike says 'queue it', 'queue this', 'queue adopt'. Also accepts /queue-adopt <url> to queue without a prior eval (auto-runs eval-repo first)."
---

# /queue-adopt — Queue a repo for laptop pickup

Write a rich adoption plan to the host queue at `/workspace/adopt-queue/pending/<id>.md` so Mike can work on it from the laptop with `~/claire-tools/adopt-queue.sh`.

## When to use

- After `/eval-repo` returns ADOPT or STEAL and Mike says `/queue`, "queue it", "queue this", or "queue adopt"
- `/queue-adopt <url>` — fresh invocation, no prior eval in session
- `/queue-adopt` with no args but prior eval in session — uses the prior eval

## Procedure

### Step 1 — Determine the target repo

- If the last few turns include a completed `/eval-repo` run, use THAT evaluation (URL, verdict, repo metadata, reasoning). Do not re-fetch.
- If `/queue-adopt <url>` is invoked and there's no prior eval: run the `/eval-repo` skill inline on that URL first, then continue with the result.
- If neither: send a Telegram message asking "Which repo should I queue? Give me the URL." and stop.

### Step 2 — Derive the slug

Slug = lowercase repo name from URL (`github.com/<owner>/<repo>` → `<repo>`). Strip `.git` suffix. Use hyphens for separators.

### Step 3 — Check for duplicates (soft dedup)

Run:
```bash
ls /workspace/adopt-queue/pending/<slug>.md 2>/dev/null
ls /workspace/adopt-queue/archive/<slug>-*.md 2>/dev/null
```

- If pending match exists → this is an update. Preserve `queued_at` from the existing file, bump `queued_updated_at` to now, and overwrite the rest. Skip to Step 5.
- If archive match exists → send Telegram:
  > "⚠️ You already adopted *<slug>* on <date>. Re-queue anyway? Reply yes/no."

  Wait for explicit "yes". On "no" or anything else, abort with "Ok, skipped."
- If neither → proceed to Step 4.

### Step 4 — Write the queue file

Write to `/workspace/adopt-queue/pending/<slug>.md`. Use this exact frontmatter template (omit empty fields):

```markdown
---
id: <slug>
url: <repo URL>
verdict: <ADOPT|STEAL>
repo_name: <slug>
stars: <from gh repo view>
language: <primary language>
last_updated: <YYYY-MM-DD>
queued_at: <current UTC timestamp, ISO 8601>
queued_from: telegram_code-claw
status: pending
# STEAL only:
steal_target: <file/module path to copy>
integration_point: <where it goes in NanoClaw>
# ADOPT only:
install_commands:
  - <command 1>
  - <command 2>
test_command: <optional test command>
---

## What it does
<2 sentences from the eval — plain English>

## Why we queued
<verdict reasoning — why ADOPT or STEAL, not SKIP>

## Adoption plan
<Step-by-step for laptop work. Be specific: which files, what commands, which NanoClaw dir it lands in.>

## Risks / unknowns
<What might bite during install — missing deps, interactive prompts, license concerns, etc.>

## Files of interest
<Specific paths in the repo worth reading first.>
```

**Install command guidance:**
- Python repo (has `pyproject.toml` / `setup.py`): `pip install -e .`
- Node repo (has `package.json`): `npm install` (or `bun install` / `pnpm install` based on lockfile)
- Rust: `cargo build --release`
- Shell-only tool: just the clone + `chmod +x`
- For STEAL, there may be no install commands at all — that's fine, omit the key.

### Step 5 — Confirm in Telegram

Send via `mcp__nanoclaw__send_message`:

```
*Queued: <slug>* <emoji> <verdict>
_<one-line summary — STEAL target or ADOPT rationale>_

On laptop: `~/claire-tools/adopt-queue.sh show <slug>`
```

Emoji: ✅ for ADOPT, ⚡ for STEAL.

## Error handling

- `/workspace/adopt-queue/` missing (mount not attached) → send Telegram: "Queue mount not available yet — Mike, please re-register CODE-claw with the adopt-queue mount (see `docs/superpowers/specs/2026-04-18-adopt-queue-design.md`)." and stop.
- Write failure → report the error to Telegram verbatim; don't silently fail.

## Examples

### Example 1 — after eval-repo (trigger B)
```
/eval-repo https://github.com/garrytan/gbrain
<Simon returns ⚡ STEAL verdict for the graph traversal code>
queue it
<Simon writes /workspace/adopt-queue/pending/gbrain.md and sends confirmation>
```

### Example 2 — fresh (trigger A)
```
/queue-adopt https://github.com/simonw/datasette
<Simon runs eval-repo internally, gets ADOPT, writes queue file, sends confirmation>
```

### Example 3 — duplicate warning
```
/queue-adopt https://github.com/garrytan/gbrain
<Simon detects archive/gbrain-20260410.md exists>
⚠️ You already adopted *gbrain* on 2026-04-10. Re-queue anyway? Reply yes/no.
```
