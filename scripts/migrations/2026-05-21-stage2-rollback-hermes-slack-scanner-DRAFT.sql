-- Rollback for Stage 2 — DRAFT (NOT YET APPLIED)
-- Restores the PRE-STAGE-2 LIVE prompt for hermes-slack-scanner, captured 2026-05-21.
-- Apply only if Stage 2 measurement shows regression and Stage 2 needs to be reverted.
-- Apply-paired-with: scripts/migrations/2026-05-21-stage2-patch-hermes-slack-scanner-DRAFT.sql
--
-- Per code-review I6 (Stage 2 rollback safety): captures the live prompt at the moment
-- Stage 2 drafts were authored, so rollback restores known-good text rather than
-- relying on git log -p archaeology.
--
-- Re-apply: idempotent on a DB where this rollback already ran (replaces with same text).

BEGIN IMMEDIATE;

UPDATE scheduled_tasks
SET prompt = 'You are Claire, running the LAB-claw daily Slack context scan for Mike Gandal''s lab.

Scan these Slack channels for the last 24 hours using Slack MCP tools (mcp__slack__conversations_history, mcp__slack__conversations_search_messages):
- #papers
- #bioinformatics
- #group-meetings
- #general
- Any project-specific channels you can find

For each channel, look for:
- DEADLINES: Dates, due dates, submission deadlines
- DECISIONS: Team decisions, approvals, go/no-go calls
- ACTION ITEMS: Tasks assigned to Mike or requiring his input
- MEETING CHANGES: Rescheduled, cancelled, or new meetings
- RESEARCH UPDATES: Paper submissions, data availability, results

Classify each finding as HIGH (requires Mike''s action within 24h) or MEDIUM (awareness item).

After scanning, store any HIGH priority findings in Hindsight via mcp__hindsight__retain for future reference.

Output format:
If findings exist, send a structured summary to this Telegram group.
If nothing notable in any channel, send: "Slack scan complete — all clear."'
WHERE id='hermes-slack-scanner';

-- Verify: post-rollback prompt should NOT contain Stage 2 markers.
SELECT
  CASE
    WHEN instr(prompt, 'PHASE A') = 0
     AND instr(prompt, 'SELF-DIFF GATE') = 0
     AND instr(prompt, 'last-fire-hermes-slack-scanner.json') = 0
    THEN 'OK: Stage 2 rollback applied — pre-Stage-2 hermes-slack-scanner prompt restored'
    ELSE 'WARNING: rollback did not match — Stage 2 markers still present'
  END AS verify_result
FROM scheduled_tasks
WHERE id='hermes-slack-scanner';

COMMIT;
