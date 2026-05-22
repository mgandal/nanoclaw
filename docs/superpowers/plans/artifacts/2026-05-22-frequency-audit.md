# Frequency Audit — High-Cadence Scheduled Tasks

Date: 2026-05-22
Plan: signal-to-noise (Task 20 — investigation only; Task 21 applies changes)
DB: `store/messages.db`, `scheduled_tasks` + `task_run_logs` (last 14 days)

## Scope

Audit 10 high-frequency tasks for notification spam. A task is "spam" only if it
posts to chat too often. Silent capture tasks (which never call `send_message`)
do not contribute to spam regardless of how often they fire — their cadence is
invisible to the user.

`nonempty` (count of runs with a non-empty `result`) is a ROUGH activity signal.
It over-counts for silent tasks (`result` captures `<internal>` reasoning text)
and under-counts for tasks that deliver via `send_message` (the chat post is not
written back to `result`). Treat it as directional only.

## Summary table

| Task id | Group | Cadence | Script | 14d runs | Recommended lever |
|---------|-------|---------|--------|----------|-------------------|
| task-1776290962534-widv4w | telegram_claire | `0,30 9-17 * * 1-5` | YES | 180 | WIDEN CADENCE |
| task-1776735101104-trfhud | telegram_ops-claw | `0,30 9-17 * * 1-5` | NO | 176 | ADD GATE |
| task-1776735101107-nobd1s | telegram_ops-claw | `0,30 9-17 * * 1-5` | NO | 175 | ADD GATE |
| task-1775761988868-n4j7vg | telegram_claire | `*/30 * * * *` | YES | 684 | NO CHANGE |
| task-1774733241328-afc2hp | telegram_claire | `0 */8 * * *` | NO | 44 | NO CHANGE |
| task-1774733257696-79rc3d | telegram_code-claw | `10 */8 * * *` | NO | 44 | NO CHANGE |
| task-1774733269601-fm5fdr | telegram_home-claw | `20 */8 * * *` | NO | 44 | NO CHANGE |
| task-1774733252129-0vf58i | telegram_lab-claw | `5 */8 * * *` | NO | 44 | NO CHANGE |
| task-1774733263146-chdc23 | telegram_science-claw | `15 */8 * * *` | NO | 44 | NO CHANGE |
| task-1774733275394-jquc19 | telegram_vault-claw | `25 */8 * * *` | NO | 44 | NO CHANGE |

## Per-task findings

### task-1776290962534-widv4w — Gmail plus-inbox processor (telegram_claire)
- Cadence: `0,30 9-17 * * 1-5` — every 30 min, 9am-5pm, weekdays (~34 fires/day).
- Has script: YES — `groups/telegram_claire/scripts/gmail-plus-monitor.py`.
- 14-day runs: 180. `nonempty=0` (delivers via `send_message` from inside the
  container; chat posts are not written to `result`).
- What it does: scans `mgandal@gmail.com` INBOX for mail addressed to
  `mgandal+marvin@` / `mgandal+hermes@`. The script exits 1 (skip agent) when
  the inbox is empty, exit 0 (wake agent) when there is mail. The agent then
  processes + archives each message and DMs Mike a summary.
- Assessment: the script gate is correct and tight (real INBOX-label count,
  `maxResults=100` for an honest count, exit 1 = skip). The noise driver is raw
  CADENCE: 180 wakes/14d ≈ ~13/day means the +marvin/+hermes inbox has mail
  roughly every other fire, and each wake posts a Telegram summary. Two posts
  an hour during the workday is the spam the user feels.
- Recommended lever: **WIDEN CADENCE**.
  - Proposed new cron: `0 9-17 * * 1-5` (hourly on the hour, weekdays — halves
    fires to ~9/day). The script gate still suppresses empty hours, so worst
    case is one summary per hour instead of two. Keep the existing script
    unchanged.

### task-1776735101104-trfhud — Slack unread monitor (telegram_ops-claw)
- Cadence: `0,30 9-17 * * 1-5` — every 30 min, 9am-5pm, weekdays.
- Has script: NO.
- 14-day runs: 176. `nonempty=171` — but this is MISLEADING: the prompt wraps
  all reasoning in `<internal>` tags and the agent only `send_message`s when
  there are "genuinely actionable Slack items". The high `nonempty` reflects
  `result` capturing `<internal>` reasoning, not 171 chat posts. Actual chat
  posts are far fewer (cannot be counted from `result`).
- What it does: checks Slack unreads in the Gandal Lab workspace; posts to
  Mike's Telegram only if there are actionable items.
- Assessment: the prompt-level gate ("output NOTHING unless actionable") is
  good, but with NO host-side script the container spins up on every one of the
  176 fires regardless of whether Slack even has unreads. That is compute
  waste and a latency tax; it also leaves spam-suppression entirely to LLM
  judgment, which is the weakest gate.
- Recommended lever: **ADD GATE**.
  - Add a script that checks the slack-mcp unread cache / Slack `conversations`
    for unread count BEFORE waking the agent. The script should emit
    `{"wakeAgent": <bool>}` JSON: `wakeAgent=true` only when unread count > 0
    in monitored channels; `wakeAgent=false` (skip agent) when zero unreads or
    the slack-mcp cache is not ready. Fail-open (`wakeAgent=true`) on hard
    errors so mail is never silently lost. Pattern to copy: the `wakeAgent`
    JSON contract used by task-1775761988868-n4j7vg's script.

### task-1776735101107-nobd1s — NanoClaw inbox monitor (telegram_ops-claw)
- Cadence: `0,30 9-17 * * 1-5` — every 30 min, 9am-5pm, weekdays.
- Has script: NO.
- 14-day runs: 175. `nonempty=170` — same caveat as trfhud: `result` captures
  `<internal>` reasoning; not 170 chat posts.
- What it does: monitors and processes the NanoClaw inbox; posts to Telegram
  only on actionable findings.
- Assessment: identical shape to trfhud — good prompt-level "output NOTHING"
  gate, but NO host-side script, so the container wakes on all 175 fires even
  when the inbox is empty.
- Recommended lever: **ADD GATE**.
  - Add a script that checks whether the NanoClaw inbox actually has unprocessed
    items before waking the agent (e.g. count files in the inbox directory the
    task processes, or query the relevant table/queue). Emit
    `{"wakeAgent": <bool>}` — `true` only when item count > 0, `false` to skip
    when empty. Fail-open on errors. Reuse the n4j7vg script's JSON contract.

### task-1775761988868-n4j7vg — inbox-convert pipeline (telegram_claire)
- Cadence: `*/30 * * * *` — every 30 min, 24/7 (highest fire count here).
- Has script: YES — runs `inbox-convert.py`, parses stdout for `✓`/`✗`.
- 14-day runs: 684. `nonempty=0` — the agent essentially never wakes.
- What it does: runs the inbox-convert pipeline; the script sets
  `wakeAgent = converted > 0 or errors > 0`. The agent only runs (and only
  posts a short message) when files were actually converted or errors occurred.
- Assessment: already gates correctly. 684 fires but `nonempty=0` confirms the
  `wakeAgent` condition almost never trips, so the user sees almost no posts.
  The cadence is high but invisible — the script does the suppression.
- Recommended lever: **NO CHANGE**. Script gate already keeps it quiet;
  `nonempty=0` over 14 days is the evidence.

### task-1774733241328-afc2hp — 8h context capture, CLAIRE main (telegram_claire)
- Cadence: `0 */8 * * *` — every 8h.
- Has script: NO.
- 14-day runs: 44. `nonempty=37` — `result` holds the captured context text;
  NOT chat posts.
- What it does: SILENT 8-hour context-capture session. Prompt explicitly:
  "This is a SILENT background task. NEVER send any message to this channel."
  Operational status (cache-not-ready, errors) goes ONLY to OPS-claw, not the
  user's main channel.
- Assessment: does not post to the user's chat at all. Its frequency is
  invisible to the user, so it cannot be notification spam.
- Recommended lever: **NO CHANGE**. Silent by design; cadence is irrelevant to
  the spam problem.

### task-1774733257696-79rc3d — 8h context capture, CODE-claw (telegram_code-claw)
- Cadence: `10 */8 * * *` — every 8h.
- Has script: NO.
- 14-day runs: 44. `nonempty=35` — captured context text, not chat posts.
- What it does: SILENT 8-hour context-capture job. Prompt: "Do NOT send any
  messages to the user or group. Wrap ALL output in `<internal>` tags."
  Structured DECISIONS / TASKS_NEW / TASKS_CLOSED / PEOPLE extraction.
- Assessment: silent by design — no chat posts.
- Recommended lever: **NO CHANGE**. Cadence invisible to the user.

### task-1774733269601-fm5fdr — 8h context capture, HOME-claw (telegram_home-claw)
- Cadence: `20 */8 * * *` — every 8h.
- Has script: NO.
- 14-day runs: 44. `nonempty=41` — captured context text, not chat posts.
- What it does: SILENT 8-hour context-capture job (Jennifer/Claire in
  HOME-claw). Prompt: "Do NOT send any messages to the user or group."
- Assessment: silent by design — no chat posts.
- Recommended lever: **NO CHANGE**. Cadence invisible to the user.

### task-1774733252129-0vf58i — 8h context capture, LAB-claw (telegram_lab-claw)
- Cadence: `5 */8 * * *` — every 8h.
- Has script: NO.
- 14-day runs: 44. `nonempty=40` — captured context text, not chat posts.
- What it does: SILENT 8-hour context-capture job (LAB-claw). Prompt: "Do NOT
  send any messages to the user or group."
- Assessment: silent by design — no chat posts.
- Recommended lever: **NO CHANGE**. Cadence invisible to the user.

### task-1774733263146-chdc23 — 8h context capture, SCIENCE-claw (telegram_science-claw)
- Cadence: `15 */8 * * *` — every 8h.
- Has script: NO.
- 14-day runs: 44. `nonempty=41` — captured context text, not chat posts.
- What it does: SILENT 8-hour context-capture job (Sep/Claire in SCIENCE-claw).
  Prompt: "Do NOT send any messages to the user or group."
- Assessment: silent by design — no chat posts.
- Recommended lever: **NO CHANGE**. Cadence invisible to the user.

### task-1774733275394-jquc19 — 8h context capture, VAULT-claw (telegram_vault-claw)
- Cadence: `25 */8 * * *` — every 8h.
- Has script: NO.
- 14-day runs: 44. `nonempty=42` — captured context text, not chat posts.
- What it does: SILENT 8-hour context-capture job (VAULT-claw). Prompt: "Do NOT
  send any messages to the user or group."
- Assessment: silent by design — no chat posts.
- Recommended lever: **NO CHANGE**. Cadence invisible to the user.

## Conclusion / recommended actions for Task 21

Only 3 of the 10 tasks contribute to notification spam:

1. **task-1776290962534-widv4w** — WIDEN CADENCE: `0,30 9-17 * * 1-5` →
   `0 9-17 * * 1-5` (halve workday fires; script gate already suppresses empty
   hours).
2. **task-1776735101104-trfhud** — ADD GATE: host-side script checking Slack
   unread count > 0 before waking the agent (`wakeAgent` JSON contract).
3. **task-1776735101107-nobd1s** — ADD GATE: host-side script checking the
   NanoClaw inbox for unprocessed items before waking the agent.

The other 7 tasks (n4j7vg + the six 8h capture tasks) need NO CHANGE:
- n4j7vg already self-gates via script (`nonempty=0` over 14d proves it).
- The 8h capture tasks are SILENT by design — they never `send_message`, so
  their cadence cannot be felt by the user. Confirmed by their prompts ("NEVER
  send any message" / "Do NOT send any messages to the user or group"); their
  non-zero `nonempty` is captured context text, not chat posts.

Note on the 5-vs-6 count: the plan brief named 5 "8h context-capture" tasks
(79rc3d, fm5fdr, 0vf58i, chdc23, jquc19) but afc2hp is also an 8h capture task
(CLAIRE main). All 6 are silent by design and classified NO CHANGE — afc2hp
included.

No task was left unclassified.
