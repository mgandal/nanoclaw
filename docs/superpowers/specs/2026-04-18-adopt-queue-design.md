# Adopt Queue — `/queue-adopt` command + laptop runner

**Date:** 2026-04-18
**Status:** Design
**Owner:** Mike

## Problem

`/eval-repo` in Telegram gives a strong verdict (ADOPT / STEAL / SKIP) for GitHub repos and tools. When the verdict is ADOPT or STEAL, the natural follow-up is laptop-side work: `git clone`, dependency install, skill branch, PR. Doing this from Telegram is error-prone (no shell, no editor, interactive auth). Today the verdict lands in chat and drifts away.

We need a way to **queue an adoption decision in Telegram** and **pick it up on the laptop** when Mike sits down to work.

## Goals

- One-command queue from Telegram after (or independent of) an `/eval-repo` run.
- Rich queue items: URL, verdict, Simon's evaluation, proposed install commands, which files to steal, target location.
- Laptop-side CLI (`adopt-queue.sh`) to list / show / clone / archive items.
- Soft dedup: re-queueing a pending item updates it; re-queueing an archived item warns and asks.
- Zero new services. Queue = plain markdown files in a shared directory.

## Non-goals

- Automatic install / test execution on the laptop (Mike decides).
- Cross-channel queue (only CODE-claw needs this; other groups can adopt later).
- Web UI, TUI, or editor integration.
- Syncing queue state back to Telegram (done items don't bubble back).

## Architecture

```
Telegram                Container                        Host (~/claire-tools/)
───────                 ─────────                        ─────────────────────
/eval-repo <url>   →    eval-repo skill (Simon)
                        posts verdict in Telegram
user: "/queue"     →    queue-adopt skill (Simon)
                        writes pending/<slug>.md    →   ~/claire-tools/adopt-queue/
                        sends "queued ✓"                ├── pending/
                                                        │   └── gbrain.md
                                                        ├── archive/
                                                        └── adopt-queue.sh

laptop:                                                 ./adopt-queue.sh list
                                                        ./adopt-queue.sh show gbrain
                                                        ./adopt-queue.sh clone gbrain
                                                        ./adopt-queue.sh done gbrain
```

Two pieces, connected only by a shared directory — no IPC, DB, or daemon.

### Piece 1: Container skill `queue-adopt`

- Lives at `groups/telegram_code-claw/skills/queue-adopt/SKILL.md`
- Invoked by `/queue-adopt` OR the natural-language forms `"queue it"`, `"queue this"` right after an `/eval-repo` verdict.
- **Trigger shape B (primary):** re-uses the evaluation already in session context. No re-fetch.
- **Trigger shape A (fallback):** `/queue-adopt <url>` with no prior eval — runs `/eval-repo` internally first, then writes the queue item.

### Piece 2: Host script `adopt-queue.sh`

- Lives at `~/claire-tools/adopt-queue.sh`
- Bash, matches the style of `gcal.sh` and `exchange-mail.sh` (set -euo pipefail, short and direct).
- Subcommands: `list`, `show <id>`, `clone <id>`, `done <id>`.

### Mount changes

`~/claire-tools/` is already allowlisted but **read-only**. We need write access *only for the queue subdir*, leaving the rest of claire-tools read-only (the CLI scripts should stay untouched by containers).

Add to `~/.config/nanoclaw/mount-allowlist.json`:

```json
{
  "path": "/Users/mgandal/claire-tools/adopt-queue",
  "allowReadWrite": true,
  "description": "Adoption queue — container writes pending items, host script consumes"
}
```

Add the mount to CODE-claw's `containerConfig.additionalMounts` so it appears as `/workspace/adopt-queue` inside the container.

## Data model

Each queue item is one markdown file in `pending/<slug>.md` with YAML frontmatter. Slug is derived from the repo name (e.g. `gbrain`, `anthropic-cookbook`). Collisions append `-2`, `-3`.

### Frontmatter schema

```yaml
---
id: gbrain                              # slug, primary key
url: https://github.com/garrytan/gbrain
verdict: STEAL                           # ADOPT | STEAL | SKIP (SKIP is rare — usually not queued)
repo_name: gbrain
stars: 342
language: Python
last_updated: 2026-03-20
queued_at: 2026-04-18T14:22:00Z
queued_from: telegram_code-claw
status: pending                          # pending | done
# STEAL-specific:
steal_target: src/graph/traversal.py     # for STEAL: which file/module to copy
integration_point: src/memory-graph/     # where in NanoClaw it'd land
# ADOPT-specific:
install_commands:                        # shell commands (ordered)
  - git clone https://github.com/garrytan/gbrain ~/src/adopt/gbrain
  - cd ~/src/adopt/gbrain && pip install -e .
test_command: pytest tests/              # optional
---
```

### Body

Freeform markdown written by Simon. Suggested sections:

```markdown
## What it does
[2 sentences from the eval]

## Why we queued
[The verdict reasoning]

## Adoption plan
[Step-by-step — what to do on the laptop]

## Risks / unknowns
[Anything that might bite during install]

## Files of interest
[Specific paths worth reading first]
```

### Archive

When `done` is called, file moves to `archive/<slug>-<done_date>.md` and `status:` flips to `done` + `done_at:` added.

## Skill flow

`queue-adopt` SKILL.md instructs Simon to:

1. **Determine the repo:**
   - If invoked after `/eval-repo`: pull URL + verdict + evaluation from session context.
   - If invoked with a URL arg and no prior eval: run eval-repo inline, then continue.
   - If no URL and no prior eval: ask Mike for the URL; abort if not provided.

2. **Check for existing item (soft dedup):**
   - `ls /workspace/adopt-queue/pending/<slug>.md` — if exists, update in place (preserve queued_at, bump queued_updated_at).
   - `ls /workspace/adopt-queue/archive/<slug>-*.md` — if exists, send Telegram: "You already adopted this on <date>. Re-queue anyway? Reply yes/no." Only proceed on explicit yes.

3. **Draft the rich plan:**
   - Pull URL, stars, language, last_updated from gh CLI (already done by `/eval-repo`).
   - Write install commands based on the repo type (Python: `pip install -e .`; Node: `npm install`; etc. — Simon uses judgment).
   - For STEAL: name the specific file(s) and where they'd land.

4. **Write the file** to `/workspace/adopt-queue/pending/<slug>.md`.

5. **Confirm in Telegram:**
   ```
   *Queued: gbrain* ⚡ STEAL
   _Writing: src/graph/traversal.py → src/memory-graph/_

   On laptop: `~/claire-tools/adopt-queue.sh show gbrain`
   ```

## Host runner

`adopt-queue.sh` — about 150 lines of bash. Subcommands:

### `list`
```
$ ./adopt-queue.sh list
PENDING (2):
  gbrain            ⚡ STEAL    2026-04-18  garrytan/gbrain
  datasette         ✅ ADOPT    2026-04-17  simonw/datasette

ARCHIVED (5, last 7 days):
  anthropic-cookbook ✅ ADOPT   2026-04-15  done 2026-04-16
  ...
```

Sorted newest-first. Reads frontmatter via `awk` block between `---` markers; no yaml parser dependency.

### `show <id>`
Cat the file with a header:
```
$ ./adopt-queue.sh show gbrain
=== gbrain ===
  URL:     https://github.com/garrytan/gbrain
  Verdict: ⚡ STEAL
  Queued:  2026-04-18 14:22 UTC

[full markdown body of the file]
```

### `clone <id>`
1. Read `url` from frontmatter.
2. Mkdir `~/src/adopt/` if missing.
3. `git clone <url> ~/src/adopt/<repo_name>`
4. `cd` into it and print next steps from `install_commands:`.
5. Open in `$EDITOR` if set (optional `--open` flag).

### `done <id>`
1. Verify file exists in `pending/`.
2. Add `done_at:` to frontmatter, flip `status: pending` → `status: done`.
3. `mv pending/<id>.md archive/<id>-$(date +%Y%m%d).md`
4. Print: `Archived gbrain.`

### Error handling

- Missing id → exit 1 with "No pending item: <id>. Try: ./adopt-queue.sh list"
- Missing directory → create on demand (`mkdir -p pending archive`)
- Git clone failure → surface stderr, don't archive the queue item

## Security / isolation

- The mount is scoped to `adopt-queue/` only; the rest of `claire-tools/` stays read-only. Container can't overwrite `gcal.sh` or other host scripts.
- Queue files are plain markdown with no code execution. `clone` is the only command that runs shell based on file content — and it only runs `git clone <url>`, nothing from the body.
- `install_commands:` are **displayed**, not executed by `adopt-queue.sh`. Mike copy-pastes.

## Testing

- **Container side:** spin up CODE-claw, `/eval-repo https://github.com/simonw/datasette`, wait for verdict, send `/queue`. Verify file at `~/claire-tools/adopt-queue/pending/datasette.md`.
- **Dedup:** re-send `/queue` on same session → file updated, not duplicated. Run `done datasette`, then `/queue` the same URL fresh → Simon warns.
- **Host runner:** `list`, `show datasette`, `clone datasette`, `done datasette` end-to-end.
- **Mount scoping:** from inside container, attempt to write to `/workspace/adopt-queue/../gcal.sh` → should fail (parent mount is read-only / not traversable).

## File touchlist

**New:**
- `groups/telegram_code-claw/skills/queue-adopt/SKILL.md` (container skill)
- `~/claire-tools/adopt-queue.sh` (host runner, **outside repo** — this is user's home dir)
- `~/claire-tools/adopt-queue/pending/.gitkeep` (just creates the dir)
- `~/claire-tools/adopt-queue/archive/.gitkeep`

**Modified:**
- `~/.config/nanoclaw/mount-allowlist.json` — add adopt-queue path (write access)
- CODE-claw group registration in DB — add `additionalMounts` entry for `adopt-queue/` → `/workspace/adopt-queue`. Done by calling `register_group` IPC from the CLAIRE (main) group with the updated containerConfig; `src/ipc.ts:993-1002` preserves `isMain` and replaces the rest. No SQL migration needed.
- `groups/telegram_code-claw/skills/eval-repo/SKILL.md` — add a one-line "To queue this for laptop adoption, reply `/queue`" at the end of the output template.

## Open questions

None — design decisions all made during brainstorming (queue location B, rich payload, trigger B+A fallback, medium runner scope, soft dedup).

## Out of scope for v1

- Auto-run installs on the laptop (explicitly rejected — Mike wants the decision gate).
- Sync between claire-tools adoption queue and Todoist.
- Multi-group queue (only CODE-claw for now; easy to add later by extending the mount and skill copy).
- Web view / Obsidian plugin.
