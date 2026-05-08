# Runtime changes

This directory holds snapshots of changes to runtime state (SQL rows, launchd plists, etc.) that are not version-controlled by themselves.

These are records, not the source of truth — the actual state lives in production. Use them for archaeology.

## 2026-05-06: claire-morning-briefing prompt

Added STEP 2.5 (auto-closed tasks surfaced from email-task-closure JSONL) and a closure-decisions counts line.

- `2026-05-06-claire-morning-briefing-prompt-before.txt` — exact pre-change prompt
- `2026-05-06-claire-morning-briefing-prompt-after.txt` — exact post-change prompt
- `scripts/update-claire-morning-briefing-prompt.sh` — applies the update to the live DB

To apply: run `./scripts/update-claire-morning-briefing-prompt.sh` from the project root during Stage I3 of the email-task-closure rollout. Backs up the current prompt before applying.
