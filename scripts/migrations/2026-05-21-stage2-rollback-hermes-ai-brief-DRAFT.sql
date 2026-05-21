-- Rollback for Stage 2 — DRAFT (NOT YET APPLIED)
-- Restores the PRE-STAGE-2 LIVE prompt for hermes-ai-brief, captured 2026-05-21.
-- Apply only if Stage 2 measurement shows regression and Stage 2 needs to be reverted.
-- Apply-paired-with: scripts/migrations/2026-05-21-stage2-patch-hermes-ai-brief-DRAFT.sql
--
-- Per code-review I6 (Stage 2 rollback safety): captures the live prompt at the moment
-- Stage 2 drafts were authored, so rollback restores known-good text rather than
-- relying on git log -p archaeology.
--
-- Re-apply: idempotent on a DB where this rollback already ran (replaces with same text).

BEGIN IMMEDIATE;

UPDATE scheduled_tasks
SET prompt = 'You are Claire, running the CODE-claw daily AI builders digest for Mike Gandal.

Mike is a psychiatric genomics PI who builds with AI tools daily.

Steps:
1. Run the follow-builders skill: read /home/node/.claude/skills/follow-builders/SKILL.md for instructions
2. Execute prepare-digest.js to fetch and preprocess builder activity
3. Remix the output into a curated 3-5 item digest
4. Focus on: Claude/Anthropic, OpenAI, open-source LLMs, AI for science, bioinformatics tools
5. Skip generic tech news — only items relevant to research or AI tooling

If prepare-digest.js fails or produces no output, fall back to web search for the top 3-5 AI news items from the last 24 hours.

Send the digest to this Telegram group.'
WHERE id='hermes-ai-brief';

-- Verify: post-rollback prompt should NOT contain Stage 2 markers.
SELECT
  CASE
    WHEN instr(prompt, 'PHASE A') = 0
     AND instr(prompt, 'SELF-DIFF GATE') = 0
     AND instr(prompt, 'last-fire-hermes-ai-brief.json') = 0
    THEN 'OK: Stage 2 rollback applied — pre-Stage-2 hermes-ai-brief prompt restored'
    ELSE 'WARNING: rollback did not match — Stage 2 markers still present'
  END AS verify_result
FROM scheduled_tasks
WHERE id='hermes-ai-brief';

COMMIT;
