# Channel Signal-to-Noise — Design Spec

**Date:** 2026-05-22
**Status:** Approved design, pre-implementation
**Author:** Claude (brainstormed with Mike Gandal)

## Problem

NanoClaw runs 42 active scheduled "digest/monitor" tasks across 8 Telegram/Slack
groups. The user reports two distinct pain points:

1. **Verbose, low-signal messages** — digests are long, carry preamble, use raw
   URLs instead of links, and have loose formatting.
2. **Too many messages** — some monitors fire and post far too often (one Slack
   unread monitor emitted output on 402 of 408 runs ≈ 50×/weekday).

These compound: the channels feel like spam.

## Root cause

The host formatting pipeline (`src/text-styles.ts`) is **already correct** — it
converts Markdown to channel-native syntax, preserves Telegram `[text](url)`
links (`text-styles.ts:334`), folds tables, and compacts blank lines between
bullets (`compactBulletBlankLines`, `text-styles.ts:390`). Both the scheduler
send path and the IPC `send_message` path route through `formatOutbound` →
`parseTextStyles` (`src/router.ts:39`, `src/index.ts:1952-1969`). Formatting
infrastructure is not the problem.

The noise comes from two sources the infrastructure cannot fix:

- **Stale / contradictory / missing prompt instructions.** `groups/global/CLAUDE.md:185`
  tells Telegram agents "no `[links](url)`" — flatly contradicted by
  `text-styles.ts:334`, which preserves them. Result: agents emit raw URLs
  (user-confirmed). 16 scheduled-task prompts carry their own inline formatting
  blocks, several mutually contradictory (3 say Telegram bold is `**double**`,
  the rest say `*single*`). No prompt anywhere sets *concision* rules — no
  length cap, no "no preamble", no item cap.
- **Task frequency.** Formatting each message tighter does nothing about a task
  that fires every 30 minutes. Frequency is an independent driver.

## Approach

"House Style + Prompt Diet + Frequency Audit." Three workstreams, no new code in
the formatting path (the host formatter already works).

### Decision: the House Style governs concision only, NOT syntax

A `telegram-formatting` skill already exists at
`container/skills/telegram-formatting/SKILL.md` and is the deliberate, documented
syntax authority for Telegram. Its rule 6 mandates `*single*` bold **with stated
reasoning**: the host's `**`→`*` regex is best-effort and `**double**` "survives
the parser as a literal `**` if anything trips up the regex." A matching
`slack-formatting` skill exists for Slack.

Therefore the House Style does **not** invent or restate syntax rules. Syntax
stays owned by the per-channel skills. The House Style block governs only the
channel-agnostic concern: **concision**. This avoids creating a fourth source of
syntax truth that could drift from the skills.

## Workstream 1 — House Style block (concision contract)

Add a "House Style — Scheduled Digests" section to `groups/global/CLAUDE.md`,
the only instruction file every agent in every group loads (`container-runner.ts:280-287`
mounts `groups/global/` for all groups; gated on `fs.existsSync`, not `isMain`).

**Critical scoping requirement:** the concision rules must be explicitly scoped
to scheduled digest/notification output. They are wrong for interactive replies
("send nothing if empty" is wrong when the user asked a direct question). The
block MUST open with a guard clause, e.g.:

> "When producing a **scheduled digest or notification** (not an interactive
> reply to a user message), follow these rules:"

Concision rules (digest-scoped):

- No preamble and no sign-off. The first line is content. No "Here's your…",
  no "I've checked…", no closing pleasantry.
- One item per bullet; one line per bullet where the content allows.
- Per-item summary: **≤ 2 sentences.** Lead with the takeaway, not the setup.
- **Default ≤ 5 items** per digest. An individual prompt may override with a
  higher explicit cap when its content needs it.
- Omit empty sections entirely. Never emit "Nothing to report" headers.
- Every URL renders as a link, never a bare URL. (Syntax for the link is the
  channel skill's job; the *requirement to use one* is House Style.)
- If nothing is worth sending, send nothing.

**Also in this workstream:** fix the stale syntax claim. `groups/global/CLAUDE.md:185`
currently says Telegram gets "no `[links](url)`". Correct it to state Telegram
links are supported and to defer to the `telegram-formatting` skill. This is a
syntax correction, not a concision rule, but it lives in the same file and is
the same one-file edit.

## Workstream 2 — Prompt Diet

Edit scheduled-task prompts (stored in the `scheduled_tasks.prompt` column of
`store/messages.db`). The scheduler re-queries the DB every poll
(`db.ts:843-852`, `getTaskById` per fire) — a live SQL `UPDATE` to `prompt` is
picked up on the next fire with no restart.

Tasks are classified into three buckets (full inventory in Appendix A):

- **Bucket A (15 tasks)** — carry an explicit inline formatting block. Strip the
  formatting block; the prompt inherits House Style (concision) + the channel
  skill (syntax).
- **Bucket B (12 tasks)** — a digest/monitor that posts to chat but has no
  formatting block. Add a single one-line pointer: "Format per the House Style
  in global CLAUDE.md and the channel formatting skill."
- **Bucket C (15 tasks)** — does not post to chat (pure ingest, file-writes,
  "output NOTHING" maintenance monitors). **Leave alone** — no edit.

**Special-case handling (must not be flattened):**

1. `claire-morning-briefing` and `hermes-week-ahead` have rich emoji-section
   templates that ARE the deliverable. Strip ONLY the parenthetical syntax rule
   ("single *asterisks* only, NO ##, NO **double**"). Preserve every emoji
   section header, the quiet-day compression rule, and the field layout.
2. `task-1774637802835-tp6ugc` (Vault briefing) and `vault-inbox-ingest-1776610760`
   have a fenced template + a "TELEGRAM FORMATTING RULES" block. Strip the rules
   block; keep the fenced template skeleton and the empty-section-skip rule.
3. `followup-weekly-1774574992` explicitly says "do NOT use send_message" and
   delivers via `bus_publish`. Do NOT add a pointer implying direct send; if it
   is bucket A, strip its formatting block but preserve the delivery instruction.
4. The 3 `**double-asterisk**` prompts (`task-1776340759047-d7coxl` r/LocalLLaMA,
   `hermes-blogwatcher`, `task-1777903475488-0zq0sd` X bookmarks) are **wrong**,
   not just inconsistent. Their formatting block is stripped along with bucket A;
   they inherit the `telegram-formatting` skill's `*single*` rule. No prompt
   should retain a `**double**` instruction after this workstream.

## Workstream 3 — Reconcile the formatting skills

Two skill files generate or document chat-digest formatting outside the DB:

- `container/skills/follow-builders/SKILL.md` has an `## Output Format` block
  using `**double asterisks**`. It drives `hermes-ai-brief`. Correct it to
  `*single*` to match the `telegram-formatting` skill.
- `container/skills/telegram-formatting/SKILL.md` is already the de-facto house
  style and is correct (`*single*`, tight bullets, no `##`, links native). No
  change needed — it becomes the cited syntax authority.

## Workstream 4 — Frequency audit

The user explicitly chose to include frequency in scope. Audit the
high-frequency tasks and reduce how often they post:

- The `0,30 9-17 * * 1-5` work-hours monitors and `*/30 * * * *` task.
- The 8-hour context-capture tasks.

For each, the goal is **post only on genuine signal**. Means available:
tighten the condition-checking `script` so the agent only wakes when there is
something to report; widen the cron cadence; or add a signal threshold to the
prompt. The specific change per task is determined during implementation after
inspecting each task's current gating; this spec does not prescribe per-task
cadences. Tasks that already gate correctly ("output NOTHING" monitors) need no
frequency change — they are quiet by design.

**Out of scope note:** five 8-hour context-capture tasks reference dead
`mcp__simplemem__` tools (SimpleMem was replaced by Honcho). They are bucket C
and silently broken. Fixing them is a separate concern; this spec only flags
them. The frequency audit may touch their cadence but will not repair the dead
tool references.

## What this design does NOT do

- **No morning-briefing "bug" fix.** Investigation (two independent reviewers)
  established that `task_run_logs.result` captures only the agent's *final text
  return* (`task-scheduler.ts:421-424`). Tasks delivering via `send_message`
  (mid-run IPC) legitimately leave `result` empty; the `0,0,74,445,524`-char
  run lengths are noise, and every run was `status='success'`. There is no bug.
- **No new formatter code.** `src/text-styles.ts` already does the mechanical
  work. Adding a post-processor was considered and rejected — it can only do
  mechanical cleanup, not write shorter summaries, and the formatting path has a
  documented fragile one-transform invariant (`telegram.ts:464`).

## Optional follow-up (not part of this spec)

There is currently no reliable signal recording "did this digest actually reach
chat" — `task_run_logs.result` does not serve this purpose. A future change
could add a real delivery signal so a staleness/health detector is not blind.
Small, separable, deferred.

## Verification

- **Workstream 1 (House Style):** the CLAUDE.md edit is not code. Verify by
  force-triggering one digest of each channel type (Telegram, Slack) and
  confirming: links render clickable, no preamble, tight bullets, item cap
  respected. Separately confirm an *interactive* reply to a direct question is
  unaffected (still allowed to be conversational) — this guards the scoping.
- **Workstream 2 (Prompt Diet):** edit one prompt at a time. Verify each by
  **manual force-trigger** and inspecting the posted output — do NOT wait for
  the natural cron fire, which may be a day away. One-at-a-time, but minutes per
  prompt, not days.

  *Force-trigger mechanism:* `getDueTasks` (`db.ts:843-852`) selects tasks where
  `next_run <= now`. To force a run, `UPDATE scheduled_tasks SET next_run =
  <timestamp a few seconds in the past> WHERE id = '<id>'`; the scheduler picks
  it up on its next poll. **Hazard — do NOT set `next_run` far in the past.**
  `checkStaleTasks` (`task-scheduler.ts:657-658`) flags any cron task lagging
  > 24h as stale and emits an alert. A force-trigger timestamp more than 24h old
  would itself generate a noise alert — set it only a few seconds back. After
  the run, `updateTaskAfterRun` recomputes a correct future `next_run`, so the
  force-trigger is self-cleaning.
- **Workstream 3 (skills):** force-trigger `hermes-ai-brief` after the
  `follow-builders` edit; confirm no literal `**` in output.
- **Workstream 4 (frequency):** after each gating/cadence change, confirm the
  task still fires and still reports when there IS signal (a too-aggressive gate
  that suppresses real signal is a regression). Cross-check `task_run_logs` for
  the task over the following day.
- No new code paths in workstreams 1, 2, 3 → no new unit tests. The existing
  `src/text-styles.test.ts` covers the mechanical formatting layer. Any `script`
  changed in workstream 4 must be tested in a sandbox before the task is
  re-enabled (per `groups/global/CLAUDE.md` Task Scripts guidance).

## Appendix A — Scheduled-task inventory (42 active, audited 2026-05-22)

Bucket A = strip inline formatting block. Bucket B = add House Style pointer.
Bucket C = leave alone (does not post to chat).

| Task ID | Group | Bucket | Note |
|---|---|---|---|
| task-1773612236244-4np9bh | claire | A | Bookmark watchlist; inline syntax rule |
| task-1774027787743-upd8cur | claire | C | Renders current.md file only; no send |
| claire-morning-briefing | claire | A | SPECIAL — emoji template; strip only syntax rule |
| task-1774733241328-afc2hp | claire | C | Silent 8h context-capture |
| task-1775761988868-n4j7vg | claire | B | Inbox-convert; has gating script |
| hermes-week-ahead | claire | A | SPECIAL — emoji week-ahead template; strip only syntax rule |
| task-1775850929249-olcmx8 | claire | A | Weekly status; inline syntax + layout |
| task-1776272791210-5dwwwa | claire | B | GCP cost tracker |
| task-1776290962534-widv4w | claire | A | Gmail plus-inbox; has gating script |
| swarm-membership-audit | claire | C | Audit; sends only on diff/error |
| task-1779236642172-enh5we | clinic-claw | A | Psych digest; explicit format block |
| task-1774733257696-79rc3d | code-claw | C | Silent 8h capture; STALE simplemem ref |
| hermes-ai-brief | code-claw | B | follow-builders digest (skill owns format) |
| task-1775858998114-bris33 | code-claw | C | Nightly dream-cycle; file writes only |
| task-1776340759047-d7coxl | code-claw | A | SPECIAL — wrong `**double**` rule; has script |
| cost-report-weekly | code-claw | B | /cost-report skill; surface_outputs=1 |
| task-1778540878338-n8swxv | code-claw | C | daily-task-prep; silent unless flag |
| task-1774733269601-fm5fdr | home-claw | C | Silent 8h capture; STALE simplemem ref |
| task-1773273118866-03lyoi | lab-claw | A | ARIA watcher; inline syntax rule |
| deadline-weekly-1774574963 | lab-claw | A | Weekly priorities; inline syntax + emoji layout |
| followup-weekly-1774574992 | lab-claw | A | SPECIAL — delivers via bus_publish, not send_message |
| task-1774733252129-0vf58i | lab-claw | C | Silent 8h capture; STALE simplemem ref |
| hermes-slack-scanner | ops-claw | B | Slack scan |
| task-1776026695750-3ayk1i | ops-claw | C | Infra health probe; sends only on failure |
| task-1776026695758-w0960t | ops-claw | B | State-file divergence check |
| task-1776026695769-3ub984 | ops-claw | B | NanoClaw version check |
| task-1776026695765-w23mk8 | ops-claw | B | Memory integrity; alert only on failure |
| audit-mcp-weekly | ops-claw | B | /audit-mcp skill; surface_outputs=1 |
| task-1776735101104-trfhud | ops-claw | C | Slack unread; "output NOTHING" unless actionable |
| task-1776735101092-u2lq23 | ops-claw | B | Task health check |
| task-1776735101099-8nsadd | ops-claw | C | Inbox processor; "output NOTHING" unless findings |
| task-1776735101107-nobd1s | ops-claw | C | Inbox processor; "output NOTHING" unless findings |
| launchd-health-1777675146-d3f4f5 | ops-claw | B | launchd health; has gating script |
| task-1773691186724-rzixvw | science-claw | C | Skill installer; file-write, no send |
| task-1774733263146-chdc23 | science-claw | C | Silent 8h capture; STALE simplemem ref |
| task-1774637802835-tp6ugc | vault-claw | A | SPECIAL — Vault briefing; fenced template + rules block |
| task-1774733275394-jquc19 | vault-claw | C | Silent 8h capture; STALE simplemem ref |
| task-1775477404076-t58ng8 | vault-claw | B | Wiki lint; writes log.md + brief summary |
| readwise-daily-sync | vault-claw | A | Readwise sync; "CRITICAL TELEGRAM FORMATTING" block |
| hermes-blogwatcher | vault-claw | A | SPECIAL — wrong `**double**` rule + template |
| vault-inbox-ingest-1776610760 | vault-claw | A | SPECIAL — fenced template + rules block; also bus_publish |
| task-1777903475488-0zq0sd | vault-claw | A | SPECIAL — X bookmarks; wrong `**double**` rule + template |

Tally: **A = 15, B = 12, C = 15** (= 42).

High-frequency tasks for Workstream 4 (cadence shown):
- `task-1776290962534-widv4w` (claire) — `0,30 9-17 * * 1-5`
- `task-1776735101104-trfhud` (ops-claw) — `0,30 9-17 * * 1-5` (≈50×/weekday, posts almost every fire)
- `task-1776735101107-nobd1s` (ops-claw) — `0,30 9-17 * * 1-5`
- `task-1775761988868-n4j7vg` (claire) — `*/30 * * * *`
- 8-hour context-capture tasks: `afc2hp`, `79rc3d`, `fm5fdr`, `0vf58i`, `chdc23`, `jquc19`

## Appendix B — Key file references

- `groups/global/CLAUDE.md` — universal instruction file; House Style lives here;
  line 179-187 `## Message Formatting` section; line 185 stale Telegram-links claim.
- `src/text-styles.ts` — host formatter; `transformSegment` (313), `**`→`*` (326),
  Telegram link preservation (334), `compactBulletBlankLines` (390).
- `src/router.ts:39` — `formatOutbound` → `parseTextStyles`.
- `src/container-runner.ts:280-287` — `groups/global/` mount, all groups.
- `src/db.ts:843-852` — `getDueTasks` re-queries each poll (live prompt edits safe).
- `src/task-scheduler.ts:421-424, 468-475` — `result` capture / `task_run_logs` write.
- `container/skills/telegram-formatting/SKILL.md` — syntax authority for Telegram.
- `container/skills/slack-formatting/SKILL.md` — syntax authority for Slack.
- `container/skills/follow-builders/SKILL.md` — `## Output Format` block to correct.
- DB: `/Users/mgandal/Agents/nanoclaw/store/messages.db`, table `scheduled_tasks`.
