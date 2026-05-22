# Channel Signal-to-Noise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce verbose and stale output across NanoClaw's 42 scheduled digest/monitor tasks by adding a digest-scoped concision contract, stripping contradictory inline formatting from 15 prompts, and tightening high-frequency monitors.

**Architecture:** Three independent workstreams, no new code in the formatting path (the host formatter `src/text-styles.ts` already works correctly). Workstream 1 edits one instruction file (`groups/global/CLAUDE.md`). Workstream 2 edits scheduled-task prompt rows in `store/messages.db` via SQL. Workstream 3 edits one skill file. Workstream 4 audits and adjusts task scheduling. Each prompt edit is verified by manually force-triggering that task and inspecting its posted output.

**Tech Stack:** SQLite (`store/messages.db`), Markdown instruction files, TypeScript host (read-only reference — no host code changes), bash/`sqlite3` CLI.

**Spec:** `docs/superpowers/specs/2026-05-22-channel-signal-to-noise-design.md`

---

## Pre-flight: backup and safety

The prompt edits mutate a live production database. Before any edit, snapshot the
current prompts so every change is reversible.

### Task 0: Backup current prompts

**Files:**
- Create: `docs/superpowers/plans/artifacts/2026-05-22-prompts-backup.json`

- [ ] **Step 1: Create the artifacts directory**

Run:
```bash
mkdir -p /Users/mgandal/Agents/nanoclaw/docs/superpowers/plans/artifacts
```

- [ ] **Step 2: Dump all active scheduled-task prompts to JSON**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT json_group_array(json_object('id', id, 'group_folder', group_folder, 'prompt', prompt)) FROM scheduled_tasks WHERE status='active';" \
  > docs/superpowers/plans/artifacts/2026-05-22-prompts-backup.json
```

- [ ] **Step 3: Verify the backup is non-empty and well-formed**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 -c "import json; d=json.load(open('docs/superpowers/plans/artifacts/2026-05-22-prompts-backup.json')); print(f'{len(d)} prompts backed up')"
```
Expected: `42 prompts backed up` (count may differ slightly if tasks changed; must be > 35).

- [ ] **Step 4: Commit the backup**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md docs/superpowers/plans/artifacts/2026-05-22-prompts-backup.json
git commit -m "docs(plan): channel signal-to-noise implementation plan + prompt backup"
```

**Rollback procedure (reference, for any later task):** to revert a single prompt,
read its original text from the backup JSON and run
`UPDATE scheduled_tasks SET prompt = '<original>' WHERE id = '<id>';`.

---

## Workstream 1: House Style block in global CLAUDE.md

Two edits to `groups/global/CLAUDE.md`: (1.A) correct the stale Telegram-links
claim in the existing `## Message Formatting` section; (1.B) add a new
`## House Style — Scheduled Digests` section for concision.

### Task 1: Correct the stale Telegram syntax rule

**Files:**
- Modify: `groups/global/CLAUDE.md:185`

- [ ] **Step 1: Read the current Message Formatting section**

Run: `sed -n '179,188p' /Users/mgandal/Agents/nanoclaw/groups/global/CLAUDE.md`
Confirm line 185 reads (the stale rule — note "no `[links](url)`"):
`**Telegram/WhatsApp** (`telegram_*` / `whatsapp_*`): `*bold*` (single asterisks only), `_italic_`, bullets, code blocks. No `##` headings, no `[links](url)`, no `**double stars**`.`

- [ ] **Step 2: Replace line 185 with the corrected rule**

Use the Edit tool on `groups/global/CLAUDE.md`.

old_string:
```
**Telegram/WhatsApp** (`telegram_*` / `whatsapp_*`): `*bold*` (single asterisks only), `_italic_`, bullets, code blocks. No `##` headings, no `[links](url)`, no `**double stars**`.
```

new_string:
```
**Telegram/WhatsApp** (`telegram_*` / `whatsapp_*`): `*bold*` (single asterisks only), `_italic_`, bullets, code blocks, `[text](url)` links (Telegram renders these as clickable — always prefer a link over a bare URL). No `##` headings, no `**double stars**`. The container `telegram-formatting` skill is the full syntax reference.
```

- [ ] **Step 3: Verify the edit landed**

Run: `grep -n 'clickable' /Users/mgandal/Agents/nanoclaw/groups/global/CLAUDE.md`
Expected: one line matching, at line ~185.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add groups/global/CLAUDE.md
git commit -m "fix(global): correct stale Telegram-links rule — links ARE supported"
```

### Task 2: Add the House Style (concision) section

**Files:**
- Modify: `groups/global/CLAUDE.md` (insert a new section after line 187, before `## Task Scripts`)

- [ ] **Step 1: Insert the House Style section**

Use the Edit tool on `groups/global/CLAUDE.md`.

old_string:
```
**Discord** (`discord_*`): Standard Markdown (`**bold**`, `*italic*`, `[links](url)`, `# headings`).

## Task Scripts
```

new_string:
```
**Discord** (`discord_*`): Standard Markdown (`**bold**`, `*italic*`, `[links](url)`, `# headings`).

## House Style — Scheduled Digests

When producing a **scheduled digest or notification** (a message sent by a
scheduled task, not an interactive reply to something the user just said),
follow these concision rules. They do NOT apply to interactive replies — a
direct question deserves a full conversational answer.

- No preamble and no sign-off. The first line is content. Do not open with
  "Here's your…" / "I've checked…" and do not close with a pleasantry.
- One item per bullet; one line per bullet wherever the content allows.
- Per-item summary: at most 2 sentences. Lead with the takeaway, not the setup.
- Default cap of 5 items per digest. Only exceed this if the task's own prompt
  gives an explicit higher cap.
- Omit empty sections entirely. Never emit a "Nothing to report" header.
- Every URL must be a clickable link, never a bare URL. (The per-channel
  formatting skill defines the link syntax.)
- If nothing is worth sending, send nothing at all.

## Task Scripts
```

- [ ] **Step 2: Verify the section is present and ordered correctly**

Run: `grep -n '^## ' /Users/mgandal/Agents/nanoclaw/groups/global/CLAUDE.md`
Expected: `## House Style — Scheduled Digests` appears between `## Message Formatting`'s content and `## Task Scripts`.

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add groups/global/CLAUDE.md
git commit -m "feat(global): add House Style concision contract for scheduled digests"
```

---

## Workstream 2: Prompt Diet

Each task here edits one `scheduled_tasks.prompt` row, then verifies by
force-triggering. **Force-trigger procedure** (used in every verify step below):

```bash
# 1. Force the task due (next_run a few seconds in the past — NOT far back,
#    or checkStaleTasks fires a false stale alert).
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "UPDATE scheduled_tasks SET next_run = datetime('now','-10 seconds') WHERE id='<TASK_ID>';"
# 2. Wait for the scheduler poll (poll interval is short; ~1-2 min is safe).
# 3. Inspect the run: check task_run_logs for a fresh success row, and check
#    the target Telegram/Slack channel for the posted message.
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT run_at, status, length(result) FROM task_run_logs WHERE task_id='<TASK_ID>' ORDER BY run_at DESC LIMIT 1;"
```
After the run, `updateTaskAfterRun` recomputes a correct future `next_run`
automatically — the force-trigger is self-cleaning.

**Verification standard for every Workstream 2 task:** the posted message must
render with clickable links (no raw URLs), no preamble, tight bullets. For tasks
that gate on "only send if findings," a force-trigger with no findings correctly
produces no message — that is a pass, confirmed via the `task_run_logs` success
row plus absence of a new chat message.

### Task 3: Strip formatting block — bookmark watchlist (`task-1773612236244-4np9bh`)

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='task-1773612236244-4np9bh'`

- [ ] **Step 1: Apply the prompt edit**

Run (the `replace()` swaps the formatting sentence for a House Style pointer):
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'task-1773612236244-4np9bh'
old = "Format using WhatsApp/Telegram style (*bold* with single asterisks, • bullets, no markdown headers). If nothing notable has changed for a tool, skip it. Only send messages if there is actually something worth reporting. Sign off as Claire."
new = "Format per the House Style in global CLAUDE.md and the telegram-formatting skill. If nothing notable has changed for a tool, skip it. Only send messages if there is actually something worth reporting."
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated task-1773612236244-4np9bh`. (Note: this also drops the "Sign off as Claire" instruction — the House Style's "no sign-off" rule supersedes it.)

- [ ] **Step 2: Force-trigger and verify**

Use the force-trigger procedure with `TASK_ID=task-1773612236244-4np9bh`. This task only sends when a bookmark changed; a no-change run posts nothing — confirm a `task_run_logs` success row. If it does post, confirm links are clickable and there is no "— Claire" sign-off line.

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip inline formatting from bookmark-watchlist task"
```
(The DB itself is not in git; the commit marks plan progress. Every Workstream 2 task commits this way.)

### Task 4: Strip formatting rule — morning briefing (`claire-morning-briefing`) — SPECIAL

Strip ONLY the parenthetical syntax rule. Preserve the entire emoji-section
template and all RULES — those are the intentional deliverable.

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='claire-morning-briefing'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'claire-morning-briefing'
old = "STEP 4 — Send ONE message using mcp__nanoclaw__send_message with this EXACT format (Telegram style — single *asterisks* only, NO ##, NO **double**):"
new = "STEP 4 — Send ONE message using mcp__nanoclaw__send_message with this EXACT format (formatting per the telegram-formatting skill — single *asterisks*, no ## headings):"
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated claire-morning-briefing`.

- [ ] **Step 2: Verify the template survived**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT CASE WHEN prompt LIKE '%PROTECTED TIME%' AND prompt LIKE '%DUE TODAY%' THEN 'TEMPLATE INTACT' ELSE 'TEMPLATE DAMAGED' END FROM scheduled_tasks WHERE id='claire-morning-briefing';"
```
Expected: `TEMPLATE INTACT`.

- [ ] **Step 3: Force-trigger and verify**

Force-trigger `TASK_ID=claire-morning-briefing`. Confirm the posted briefing keeps its emoji sections and renders cleanly (no literal `**`, no raw URLs).

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip stale syntax rule from morning-briefing (template preserved)"
```

### Task 5: Strip formatting rule — week-ahead (`hermes-week-ahead`) — SPECIAL

Same pattern as Task 4 — strip only the parenthetical, keep the template.

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='hermes-week-ahead'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'hermes-week-ahead'
old = "STEP 3 — Send ONE message using mcp__nanoclaw__send_message with this EXACT format (Telegram/WhatsApp style — single *asterisks* only, NO markdown ##, NO **double**):"
new = "STEP 3 — Send ONE message using mcp__nanoclaw__send_message with this EXACT format (formatting per the telegram-formatting skill — single *asterisks*, no ## headings):"
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated hermes-week-ahead`.

- [ ] **Step 2: Verify the template survived**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT CASE WHEN prompt LIKE '%WEEK AHEAD%' AND prompt LIKE '%HEADS UP%' THEN 'TEMPLATE INTACT' ELSE 'TEMPLATE DAMAGED' END FROM scheduled_tasks WHERE id='hermes-week-ahead';"
```
Expected: `TEMPLATE INTACT`.

- [ ] **Step 3: Force-trigger and verify**

Force-trigger `TASK_ID=hermes-week-ahead`. Confirm the week-ahead layout posts cleanly.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip stale syntax rule from week-ahead (template preserved)"
```

### Task 6: Strip formatting rule — weekly status (`task-1775850929249-olcmx8`)

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='task-1775850929249-olcmx8'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'task-1775850929249-olcmx8'
old = "Then send a message (via send_message) with this format. CRITICAL: Telegram formatting ONLY — single *asterisks* for bold, • bullets, NO markdown tables (no | pipes), NO ## headings, NO **double stars**:"
new = "Then send a message (via send_message) with this format, per the telegram-formatting skill (single *asterisks*, • bullets, no tables, no ## headings):"
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated task-1775850929249-olcmx8`.

- [ ] **Step 2: Force-trigger and verify**

Force-trigger `TASK_ID=task-1775850929249-olcmx8`. Confirm the weekly status posts cleanly with its section layout intact.

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip inline formatting from weekly-status task"
```

### Task 7: Strip formatting rule — Gmail plus-inbox (`task-1776290962534-widv4w`)

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='task-1776290962534-widv4w'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'task-1776290962534-widv4w'
old = "Format: Telegram (single *bold*, bullet points, 3-5 lines max)."
new = "Format per the House Style in global CLAUDE.md and the telegram-formatting skill (keep it to 3-5 lines)."
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated task-1776290962534-widv4w`.

- [ ] **Step 2: Force-trigger and verify**

Force-trigger `TASK_ID=task-1776290962534-widv4w`. This task gates on a script; a no-mail run posts nothing — confirm via `task_run_logs`. If it posts a summary, confirm clean formatting.

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip inline formatting from gmail-plus-inbox task"
```

### Task 8: Strip formatting block — psych digest (`task-1779236642172-enh5we`)

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='task-1779236642172-enh5we'`

- [ ] **Step 1: Apply the prompt edit**

The formatting block is the trailing 5 lines. Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'task-1779236642172-enh5we'
old = """Formatting rules (Telegram Markdown v1):
• *single asterisks* for bold — NEVER **double**
• Hyperlinks: [summary text](url) — one per bullet, no bare URLs
• Bullet points with •
• No ## headings"""
new = "Format per the House Style in global CLAUDE.md and the telegram-formatting skill — every item is a clickable [summary](url) link, one per • bullet."
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated task-1779236642172-enh5we`.

- [ ] **Step 2: Force-trigger and verify**

Force-trigger `TASK_ID=task-1779236642172-enh5we`. Confirm the psych digest posts with clickable links.

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip inline formatting from psych-digest task"
```

### Task 9: Strip formatting block — r/LocalLLaMA digest (`task-1776340759047-d7coxl`) — SPECIAL

Strip ONLY the "FORMATTING RULES" block. Keep the `Format:` template (the
2-line entry structure is content layout, not syntax).

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='task-1776340759047-d7coxl'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'task-1776340759047-d7coxl'
old = """FORMATTING RULES (Telegram Markdown — verified working):
- BOLD = double asterisks: **text** (preprocessor converts to Telegram *text*)
- ITALIC = underscores: _text_
- LINKS = [display text](https://full-url) — creates clickable links. NEVER wrap a link in **...** — this breaks parsing and shows the raw URL
- NO blank lines between bullet entries"""
new = "Format per the House Style in global CLAUDE.md and the telegram-formatting skill. The title IS the clickable link; never wrap a link in bold markers."
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated task-1776340759047-d7coxl`.

- [ ] **Step 2: Verify the Format template survived**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT CASE WHEN prompt LIKE '%Each entry is exactly 2 lines%' THEN 'TEMPLATE INTACT' ELSE 'TEMPLATE DAMAGED' END FROM scheduled_tasks WHERE id='task-1776340759047-d7coxl';"
```
Expected: `TEMPLATE INTACT`.

- [ ] **Step 3: Force-trigger and verify**

Force-trigger `TASK_ID=task-1776340759047-d7coxl`. Confirm the r/LocalLLaMA digest posts: clickable title links, no literal `**`, 2-line entries.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip FORMATTING RULES block from r/LocalLLaMA digest (template kept)"
```

### Task 10: Strip formatting rule — ARIA watcher (`task-1773273118866-03lyoi`)

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='task-1773273118866-03lyoi'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'task-1773273118866-03lyoi'
old = "If there is anything NEW (a new RFA, deadline, or announcement not previously known), send a message to the group using mcp__nanoclaw__send_message with this text summarizing the finding. Keep it short and direct — no markdown, use *single asterisks* for bold."
new = "If there is anything NEW (a new RFA, deadline, or announcement not previously known), send a message to the group using mcp__nanoclaw__send_message summarizing the finding. Keep it short and direct; format per the House Style in global CLAUDE.md and the telegram-formatting skill."
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated task-1773273118866-03lyoi`.

- [ ] **Step 2: Force-trigger and verify**

Force-trigger `TASK_ID=task-1773273118866-03lyoi`. This sends only on a new finding; a no-news run posts nothing — confirm via `task_run_logs`.

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip inline formatting from ARIA-watcher task"
```

### Task 11: Strip formatting rule — weekly priorities (`deadline-weekly-1774574963`)

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='deadline-weekly-1774574963'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'deadline-weekly-1774574963'
old = "FORMAT (Telegram — no markdown headings, single *asterisks* for bold):"
new = "FORMAT (per the telegram-formatting skill — single *asterisks* for bold, no ## headings):"
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated deadline-weekly-1774574963`.

- [ ] **Step 2: Force-trigger and verify**

Force-trigger `TASK_ID=deadline-weekly-1774574963`. Confirm the priorities report posts with its emoji-section layout intact.

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip inline formatting from weekly-priorities task"
```

### Task 12: Strip formatting clause — Wednesday audit (`followup-weekly-1774574992`) — SPECIAL

This task delivers via `bus_publish`, NOT `send_message`. Strip only the
formatting clause inside STEP 4; preserve the `bus_publish` delivery instruction.

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='followup-weekly-1774574992'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'followup-weekly-1774574992'
old = "- finding: [your full audit report as plain text, Telegram-formatted: single *asterisks* for bold, • bullets, no markdown headings]"
new = "- finding: [your full audit report as plain text, formatted per the telegram-formatting skill: single *asterisks* for bold, • bullets, no ## headings]"
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated followup-weekly-1774574992`.

- [ ] **Step 2: Verify the bus_publish instruction survived**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT CASE WHEN prompt LIKE '%bus_publish%' AND prompt LIKE '%Do NOT use send_message%' THEN 'DELIVERY INTACT' ELSE 'DELIVERY DAMAGED' END FROM scheduled_tasks WHERE id='followup-weekly-1774574992';"
```
Expected: `DELIVERY INTACT`.

- [ ] **Step 3: Force-trigger and verify**

Force-trigger `TASK_ID=followup-weekly-1774574992`. The audit report is delivered to the CLAIRE channel via the bus — confirm it arrives there (not in LAB-claw) and renders cleanly.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip inline formatting from Wednesday-audit task (bus_publish preserved)"
```

### Task 13: Strip formatting block — Vault briefing (`task-1774637802835-tp6ugc`) — SPECIAL

Strip the "TELEGRAM FORMATTING RULES" block. Keep the fenced `BRIEFING FORMAT`
template and the empty-section-skip rule.

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='task-1774637802835-tp6ugc'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'task-1774637802835-tp6ugc'
old = """TELEGRAM FORMATTING RULES — mandatory:
- Title and all section headers: *single asterisks* for bold (e.g. `*New Papers (3)*`)
- NEVER use _underscores_ for section headers or the title
- NEVER use **double asterisks**
- NEVER start with "_Claire:_" or any italic header — the sender field handles attribution
- Bullets: • character only
- No markdown headings (##), no [links](url)
- Only include sections that have content — skip empty sections entirely"""
new = """FORMATTING — follow the telegram-formatting skill and the House Style in global CLAUDE.md:
- Section headers and title use *single asterisks*; do not start with an italic "_Claire:_" header (the sender field handles attribution).
- Only include sections that have content — skip empty sections entirely."""
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated task-1774637802835-tp6ugc`.

- [ ] **Step 2: Verify the BRIEFING FORMAT template survived**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT CASE WHEN prompt LIKE '%New Papers (N)%' THEN 'TEMPLATE INTACT' ELSE 'TEMPLATE DAMAGED' END FROM scheduled_tasks WHERE id='task-1774637802835-tp6ugc';"
```
Expected: `TEMPLATE INTACT`.

- [ ] **Step 3: Force-trigger and verify**

Force-trigger `TASK_ID=task-1774637802835-tp6ugc`. With no vault changes it sends nothing — confirm via `task_run_logs`. If it posts, confirm the briefing template renders cleanly.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip formatting block from Vault-briefing (template kept)"
```

### Task 14: Strip formatting block — Readwise sync (`readwise-daily-sync`)

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='readwise-daily-sync'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'readwise-daily-sync'
old = """CRITICAL TELEGRAM FORMATTING:
- *single asterisks* for bold (NEVER _underscores_ for headers)
- _underscores_ only for italic
- • for bullets
- NO ## headings, NO [links](url), NO **double asterisks**"""
new = "FORMATTING: follow the telegram-formatting skill and the House Style in global CLAUDE.md — *single asterisks* for headers, • bullets, clickable [text](url) links."
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated readwise-daily-sync`. (Note: the old block said "NO [links](url)" — a stale prohibition; the new text restores links.)

- [ ] **Step 2: Force-trigger and verify**

Force-trigger `TASK_ID=readwise-daily-sync`. With no new articles it sends nothing — confirm via `task_run_logs`. If it posts, confirm clickable links.

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip formatting block from Readwise-sync (links restored)"
```

### Task 15: Strip formatting block — blogwatcher (`hermes-blogwatcher`) — SPECIAL (double-asterisk fix)

This prompt currently mandates `**double asterisks**`. Strip the whole
formatting block; it inherits the skill's `*single*` rule.

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='hermes-blogwatcher'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'hermes-blogwatcher'
old = """Formatting (standard markdown, rendered by NanoClaw for Telegram):
- **double asterisks** for bold
- [text](url) for clickable links — NEVER wrap links inside _italic_ or *italic* markers
- • for bullets, no ## headings

Output format:
**Blogwatch — [DATE]**

• **[Feed Label]** [Title](url) — one-sentence summary
• **[Feed Label]** [Title](url) — one-sentence summary"""
new = """Format per the telegram-formatting skill and the House Style in global CLAUDE.md.

Output format:
*Blogwatch — [DATE]*
• *[Feed Label]* [Title](url) — one-sentence summary
• *[Feed Label]* [Title](url) — one-sentence summary"""
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated hermes-blogwatcher`.

- [ ] **Step 2: Verify no double-asterisk instruction remains**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT CASE WHEN prompt LIKE '%double asterisk%' THEN 'STILL HAS DOUBLE' ELSE 'CLEAN' END FROM scheduled_tasks WHERE id='hermes-blogwatcher';"
```
Expected: `CLEAN`.

- [ ] **Step 3: Force-trigger and verify**

Force-trigger `TASK_ID=hermes-blogwatcher`. With no new RSS items it sends nothing — confirm via `task_run_logs`. If it posts, confirm bold renders (no literal `**`) and links are clickable.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): fix double-asterisk rule in blogwatcher → single"
```

### Task 16: Strip formatting block — Vault inbox-ingest (`vault-inbox-ingest-1776610760`) — SPECIAL

Strip the "TELEGRAM FORMATTING RULES" block. Keep the fenced CORRECT-example
template, the silent-exit rule, and the `bus_publish` instruction.

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='vault-inbox-ingest-1776610760'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'vault-inbox-ingest-1776610760'
old = """TELEGRAM FORMATTING RULES — follow these exactly or the message will be broken:
- Section headers: *single asterisks* for bold — e.g. `*New Syntheses (1)*` — NEVER use _underscores_ for headers
- _underscores_ are ONLY for italic emphasis on individual words, not section titles or the message title
- Bullets: use • character
- No ## headings, no [links](url), no **double asterisks**
- The message title itself should be *bold*: `*Vault Briefing — YYYY-MM-DD (Inbox Ingest)*`"""
new = """FORMATTING — follow the telegram-formatting skill and the House Style in global CLAUDE.md. Section headers and the message title use *single asterisks* (e.g. `*Vault Briefing — YYYY-MM-DD (Inbox Ingest)*`)."""
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated vault-inbox-ingest-1776610760`.

- [ ] **Step 2: Verify the template + bus_publish survived**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT CASE WHEN prompt LIKE '%New Syntheses (1)%' AND prompt LIKE '%bus_publish%' THEN 'INTACT' ELSE 'DAMAGED' END FROM scheduled_tasks WHERE id='vault-inbox-ingest-1776610760';"
```
Expected: `INTACT`.

- [ ] **Step 3: Force-trigger and verify**

Force-trigger `TASK_ID=vault-inbox-ingest-1776610760`. With an empty inbox it exits silently — confirm via `task_run_logs`. If it posts, confirm the briefing renders cleanly.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): strip formatting block from Vault inbox-ingest (template + bus kept)"
```

### Task 17: Strip formatting block — X bookmarks (`task-1777903475488-0zq0sd`) — SPECIAL (double-asterisk fix)

**Files:**
- Modify: `scheduled_tasks.prompt` WHERE `id='task-1777903475488-0zq0sd'`

- [ ] **Step 1: Apply the prompt edit**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = 'task-1777903475488-0zq0sd'
old = """Formatting (standard markdown, rendered by NanoClaw for Telegram):
- **double asterisks** for bold
- [text](url) for clickable links — NEVER wrap links inside _italic_ or *italic* markers
- • for bullets, no ## headings

Format:
**Bookmarks — [DATE]**

• **[Category]** [Title](url) — one-sentence note
• **[Category]** [Title](url) — one-sentence note"""
new = """Format per the telegram-formatting skill and the House Style in global CLAUDE.md.

Format:
*Bookmarks — [DATE]*
• *[Category]* [Title](url) — one-sentence note
• *[Category]* [Title](url) — one-sentence note"""
p = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()[0]
assert old in p, "OLD STRING NOT FOUND — abort"
db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p.replace(old, new), tid))
db.commit()
print("updated", tid)
PY
```
Expected: `updated task-1777903475488-0zq0sd`.

- [ ] **Step 2: Verify no double-asterisk instruction remains**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT CASE WHEN prompt LIKE '%double asterisk%' THEN 'STILL HAS DOUBLE' ELSE 'CLEAN' END FROM scheduled_tasks WHERE id='task-1777903475488-0zq0sd';"
```
Expected: `CLEAN`.

- [ ] **Step 3: Force-trigger and verify**

Force-trigger `TASK_ID=task-1777903475488-0zq0sd`. With no new bookmarks it sends nothing — confirm via `task_run_logs`. If it posts, confirm clean bold + links.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): fix double-asterisk rule in X-bookmarks → single"
```

### Task 18: Add House Style pointer to the 12 bucket-B prompts

Bucket B = posts to chat, no formatting block. Each gets one appended pointer
line. This is a single batch task (12 trivial appends), then one combined verify.

**Files:**
- Modify: `scheduled_tasks.prompt` for 12 ids (listed below)

- [ ] **Step 1: Append the pointer to all 12 bucket-B prompts**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
ids = [
  'task-1775761988868-n4j7vg', 'task-1776272791210-5dwwwa', 'hermes-ai-brief',
  'cost-report-weekly', 'hermes-slack-scanner', 'task-1776026695758-w0960t',
  'task-1776026695769-3ub984', 'task-1776026695765-w23mk8', 'audit-mcp-weekly',
  'task-1776735101092-u2lq23', 'launchd-health-1777675146-d3f4f5',
  'task-1775477404076-t58ng8',
]
pointer = "\n\nFormatting: when you send a message, follow the House Style in global CLAUDE.md and the channel formatting skill (telegram-formatting or slack-formatting) — no preamble, tight bullets, clickable links, omit empty sections."
for tid in ids:
    row = db.execute("SELECT prompt FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()
    assert row is not None, f"{tid} NOT FOUND"
    p = row[0]
    if "House Style in global CLAUDE.md" in p:
        print("skip (already has pointer)", tid); continue
    db.execute("UPDATE scheduled_tasks SET prompt=? WHERE id=?", (p + pointer, tid))
    print("appended", tid)
db.commit()
PY
```
Expected: 12 `appended …` lines (or `skip` for any already done on a re-run).

- [ ] **Step 2: Verify all 12 carry the pointer**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT COUNT(*) FROM scheduled_tasks WHERE id IN ('task-1775761988868-n4j7vg','task-1776272791210-5dwwwa','hermes-ai-brief','cost-report-weekly','hermes-slack-scanner','task-1776026695758-w0960t','task-1776026695769-3ub984','task-1776026695765-w23mk8','audit-mcp-weekly','task-1776735101092-u2lq23','launchd-health-1777675146-d3f4f5','task-1775477404076-t58ng8') AND prompt LIKE '%House Style in global CLAUDE.md%';"
```
Expected: `12`.

- [ ] **Step 3: Spot-verify two bucket-B tasks**

Force-trigger `TASK_ID=hermes-ai-brief` (a digest that posts most days — good positive check) and `TASK_ID=task-1776026695769-3ub984` (version check — usually silent). Confirm `hermes-ai-brief` posts cleanly; confirm the version check behaves as before.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(prompt): add House Style pointer to 12 bucket-B digest tasks"
```

---

## Workstream 3: Reconcile the follow-builders skill

### Task 19: Fix the double-asterisk rule in follow-builders SKILL.md

The `## Output Format` block (lines 48-56) uses `**double-asterisk**` bold and a
bare `[Link]` placeholder. Convert bold to `*single*` and make the link an
explicit `[text](url)` form to match the telegram-formatting skill.

**Files:**
- Modify: `container/skills/follow-builders/SKILL.md:50-56`

- [ ] **Step 1: Replace the Output Format code block**

Use the Edit tool on `container/skills/follow-builders/SKILL.md`.

old_string:
```
AI Builders Digest -- [DATE]

1. **[Title]** -- [1-sentence summary] [Link]
2. **[Title]** -- [1-sentence summary] [Link]
3. **[Title]** -- [1-sentence summary] [Link]
```

new_string:
```
AI Builders Digest -- [DATE]

1. *[Title]* -- [1-sentence summary] -- [source]([URL])
2. *[Title]* -- [1-sentence summary] -- [source]([URL])
3. *[Title]* -- [1-sentence summary] -- [source]([URL])
```

- [ ] **Step 2: Verify no double-asterisk bold remains in the block**

Run: `sed -n '48,57p' /Users/mgandal/Agents/nanoclaw/container/skills/follow-builders/SKILL.md | grep -c '\*\*'`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add container/skills/follow-builders/SKILL.md
git commit -m "fix(skill): follow-builders output format uses single-asterisk bold for Telegram"
```

**Note on propagation:** container skills are loaded into the agent container
per-group. The change takes effect when the container picks up the updated
skill source. If `hermes-ai-brief` output still shows `**` after this task,
the agent-runner skill cache for `telegram_code-claw` may need clearing — see
`docs/` debugging notes; this is a known cache behavior, not a plan defect.

---

## Workstream 4: Frequency audit

This workstream is investigation-led: inspect each high-frequency task, decide
the right lever (tighten gating `script`, widen cron cadence, or add a signal
threshold to the prompt), apply it, verify. The spec deliberately does not
prescribe per-task cadences — the decision depends on each task's current
gating, which Task 20 inspects.

### Task 20: Inventory high-frequency tasks and their current gating

**Files:**
- Create: `docs/superpowers/plans/artifacts/2026-05-22-frequency-audit.md`

- [ ] **Step 1: Dump the high-frequency tasks with their scripts**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3, textwrap
db = sqlite3.connect('store/messages.db')
ids = ['task-1776290962534-widv4w','task-1776735101104-trfhud','task-1776735101107-nobd1s',
       'task-1775761988868-n4j7vg','task-1774733241328-afc2hp','task-1774733257696-79rc3d',
       'task-1774733269601-fm5fdr','task-1774733252129-0vf58i','task-1774733263146-chdc23',
       'task-1774733275394-jquc19']
for tid in ids:
    r = db.execute("SELECT schedule_value, script, length(prompt) FROM scheduled_tasks WHERE id=?", (tid,)).fetchone()
    if not r: print(f"## {tid}\nNOT FOUND\n"); continue
    sv, script, plen = r
    print(f"## {tid}\n- cadence: `{sv}`\n- prompt length: {plen}")
    print(f"- has script: {'YES' if script else 'NO'}")
    if script:
        print("```\n" + textwrap.shorten(script, 600) + "\n```")
    print()
PY
```

- [ ] **Step 2: Pull per-task post rates from task_run_logs (last 14 days)**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT task_id, COUNT(*) AS runs, SUM(CASE WHEN length(COALESCE(result,''))>0 THEN 1 ELSE 0 END) AS nonempty_results FROM task_run_logs WHERE run_at >= datetime('now','-14 days') AND task_id IN ('task-1776290962534-widv4w','task-1776735101104-trfhud','task-1776735101107-nobd1s','task-1775761988868-n4j7vg','task-1774733241328-afc2hp','task-1774733257696-79rc3d','task-1774733269601-fm5fdr','task-1774733252129-0vf58i','task-1774733263146-chdc23','task-1774733275394-jquc19') GROUP BY task_id ORDER BY runs DESC;"
```
(Note: `nonempty_results` undercounts actual chat posts for `send_message`-delivering tasks — see spec. Use it as a rough activity signal, not exact post count.)

- [ ] **Step 3: Write the audit findings file**

Create `docs/superpowers/plans/artifacts/2026-05-22-frequency-audit.md`. For each
of the 10 tasks, record: cadence, whether it has a gating script, observed run
count, and a one-line recommended lever — one of:
- **TIGHTEN GATE** — has a script but the script's `wakeAgent` condition is too
  loose; narrow it.
- **ADD GATE** — no script; add a condition-checking script so it only wakes on
  signal.
- **WIDEN CADENCE** — reduce cron frequency (e.g. `0,30 9-17` → `0 9,13,17`).
- **NO CHANGE** — already gates correctly / already quiet.

- [ ] **Step 4: Commit the audit file**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/artifacts/2026-05-22-frequency-audit.md
git commit -m "docs(plan): frequency audit findings for high-cadence tasks"
```

### Task 21: Apply frequency changes from the audit

**Files:**
- Modify: `scheduled_tasks.schedule_value` and/or `scheduled_tasks.script` for the
  tasks the Task 20 audit marked TIGHTEN GATE / ADD GATE / WIDEN CADENCE.

- [ ] **Step 1: For each task marked WIDEN CADENCE, update the cron value**

For each such task, run (substituting the new cron string the audit chose):
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "UPDATE scheduled_tasks SET schedule_value='<NEW_CRON>', next_run=NULL WHERE id='<TASK_ID>';"
```
Setting `next_run=NULL` lets `healOrphanedNextRun` recompute it from the new
cron on the next poll. Verify: `SELECT schedule_value, next_run FROM scheduled_tasks WHERE id='<TASK_ID>';` — `next_run` should populate within ~2 min.

- [ ] **Step 2: For each task marked ADD GATE or TIGHTEN GATE, write/update the script**

A gating script must print a single JSON line `{"wakeAgent": true|false, "data": {...}}`
and finish within 30 s. Develop the script for each such task based on its
trigger condition (e.g. "only wake if Slack has unread messages"). Test the
script standalone first:
```bash
bash /tmp/test-gate-<TASK_ID>.sh   # must print valid JSON, exit fast
```
Then install it:
```bash
cd /Users/mgandal/Agents/nanoclaw && python3 - <<'PY'
import sqlite3
db = sqlite3.connect('store/messages.db')
tid = '<TASK_ID>'
script = open('/tmp/test-gate-<TASK_ID>.sh').read()
db.execute("UPDATE scheduled_tasks SET script=? WHERE id=?", (script, tid))
db.commit(); print("script installed for", tid)
PY
```

- [ ] **Step 3: Force-trigger each changed task and verify it still works**

For each task changed in Steps 1-2, run the force-trigger procedure. Confirm:
the task fires, the gating script (if any) returns valid JSON, and when there
IS genuine signal the task still posts. A gate that suppresses real signal is a
regression — if a task that should have posted stayed silent, revert that
task's script via the backup and re-tune.

- [ ] **Step 4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md docs/superpowers/plans/artifacts/2026-05-22-frequency-audit.md
git commit -m "feat(scheduling): tighten gating + cadence on high-frequency monitors"
```

---

## Final verification

### Task 22: End-to-end check

- [ ] **Step 1: Confirm no prompt retains a contradictory bold rule**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT id FROM scheduled_tasks WHERE status='active' AND prompt LIKE '%double asterisk%';"
```
Expected: no rows (every double-asterisk instruction was removed).

- [ ] **Step 2: Confirm no prompt retains the stale 'no links' prohibition**

Run:
```bash
cd /Users/mgandal/Agents/nanoclaw && sqlite3 store/messages.db \
  "SELECT id FROM scheduled_tasks WHERE status='active' AND prompt LIKE '%no [links](url)%';"
```
Expected: no rows.

- [ ] **Step 3: Confirm the House Style section exists and is digest-scoped**

Run: `grep -n -A1 'House Style' /Users/mgandal/Agents/nanoclaw/groups/global/CLAUDE.md`
Expected: the section header plus the "When producing a scheduled digest" guard line.

- [ ] **Step 4: Interactive-reply regression check**

In an interactive Telegram chat (e.g. CLAIRE main), send the agent a normal
direct question (e.g. "what's on my calendar tomorrow?"). Confirm the reply is
still conversational — the House Style's "no preamble / send nothing if empty"
rules must NOT have leaked into interactive replies. This guards the scoping
decision from Workstream 1.

- [ ] **Step 5: Final commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/2026-05-22-channel-signal-to-noise.md
git commit -m "chore(plan): channel signal-to-noise — final verification complete"
```

---

## Out of scope (recorded, not implemented)

- The 5 silent context-capture tasks referencing dead `mcp__simplemem__` tools
  (`79rc3d`, `fm5fdr`, `0vf58i`, `chdc23`, `jquc19`). Task 20 inventories them
  for the frequency audit; repairing the dead tool reference is a separate fix.
- A real "digest delivered to chat" signal (current `task_run_logs.result` does
  not serve this). Deferred per the spec.
- No host code changes — `src/text-styles.ts` already formats correctly.
