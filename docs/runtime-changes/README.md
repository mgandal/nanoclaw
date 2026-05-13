# Runtime changes

This directory holds snapshots of changes to runtime state (SQL rows, launchd plists, etc.) that are not version-controlled by themselves.

These are records, not the source of truth — the actual state lives in production. Use them for archaeology.

## 2026-05-06: claire-morning-briefing prompt

Added STEP 2.5 (auto-closed tasks surfaced from email-task-closure JSONL) and a closure-decisions counts line.

- `2026-05-06-claire-morning-briefing-prompt-before.txt` — exact pre-change prompt
- `2026-05-06-claire-morning-briefing-prompt-after.txt` — exact post-change prompt
- `scripts/update-claire-morning-briefing-prompt.sh` — applies the update to the live DB

To apply: run `./scripts/update-claire-morning-briefing-prompt.sh` from the project root during Stage I3 of the email-task-closure rollout. Backs up the current prompt before applying.

## 2026-05-12: claire-morning-briefing → single canonical message

Folded Slack digest + 7-day deadline radar into the morning briefing so Claire owns one consolidated daily message; CODE-claw / LAB-claw / VAULT-claw stop duplicating calendar, tasks, follow-ups, and deadlines. Slack section sits after Follow-ups, before Decisions, and dedupes against follow-ups.

- `2026-05-12-claire-morning-briefing-before.txt` — pre-change prompt
- `2026-05-12-claire-morning-briefing-after.txt` — post-change prompt (matches live `scheduled_tasks` row `claire-morning-briefing` as of 2026-05-13)

Applied via direct `UPDATE scheduled_tasks` against `store/messages.db`. No apply-script — the 2026-05-06 script only handles the email-task-closure STEP 2.5 patch and was not generalized.

## 2026-05-12: lab-deadline-weekly day shift

Switched the LAB-claw weekly priorities report from Monday-morning (retrospective) to Sunday-morning (looking ahead to the coming week). One-line phrasing change at the top of the prompt.

- `2026-05-12-lab-deadline-weekly-before.txt` — pre-change prompt
- `2026-05-12-lab-deadline-weekly-after.txt` — post-change prompt (matches live row `deadline-weekly-1774574963`)

Applied via direct `UPDATE scheduled_tasks`. No apply-script.

## 2026-05-12: code-claw daily-task-prep skill — silent-unless-infra-alert policy

Added a "Messaging policy (updated 2026-05-12)" section to `groups/telegram_code-claw/skills/daily-task-prep/SKILL.md`. CODE-claw no longer duplicates calendar / overdue / follow-up / deadline radar (those live in the CLAIRE morning briefing); it now stays silent unless a Todoist / Calendar / Apple Notes MCP failure occurred, a NanoClaw service degraded, or the skill caught a genuinely novel safety condition.

- `2026-05-12-code-claw-daily-task-prep-skill-before.md` — pre-change SKILL.md
- `2026-05-12-code-claw-daily-task-prep-skill-after.md` — post-change SKILL.md (the SKILL.md file is itself version-controlled; this pair is the at-change snapshot)
- `2026-05-12-code-claw-daily-task-prep-before.txt` — baseline of the cron prompt row (`task-1778540878338-n8swxv`) that points at this skill; recorded for future change-tracking even though this round of changes didn't touch the row itself

## 2026-05-12: slack-morning-digest — baseline snapshot only

Snapshot of the live `slack-morning-digest-1776622600` prompt taken alongside the morning-briefing consolidation work. The Slack digest cron is now redundant with the morning briefing's Slack section — kept as a baseline so a future retirement / further consolidation has a "before" to diff against.

- `2026-05-12-slack-morning-digest-before.txt` — current live prompt (byte-identical to DB row at snapshot time; no after-pair yet)
