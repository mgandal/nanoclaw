-- Migration: import todo.md + lab-todos.md → tasks table
-- Source: 2026-04-24 plan at docs/plan-task-table-migration.md
-- Idempotent: aborts cleanly if migration-2026-04-23 source already present.
--
-- Priority mapping: OVERDUE/CRITICAL→4, HIGH/named-blocker→3, normal→2, FYI/reading→1
-- Owner: mike (only owner appearing in source files)

-- Idempotency guard via UNIQUE index on (source, source_ref).
-- INSERT OR IGNORE makes re-running this script a no-op for existing rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_dedup
  ON tasks(source, source_ref) WHERE source LIKE 'migration-%';

BEGIN;

-- Priority 4: deadline this month or named-person blocker
INSERT OR IGNORE INTO tasks (title, context, owner, priority, due_date, source, source_ref) VALUES
  ('Provide Ziller project scope/budget for RIS 97589/00', 'Stalled — may need follow-up call instead of email', 'mike', 4, NULL, 'migration-2026-04-23', 'todo.md:37'),
  ('Reach out to Joe Buxbaum re: ASD cohort', 'Already in current.md "High Priority"', 'mike', 4, NULL, 'migration-2026-04-23', 'lab-todos.md:10'),
  ('Follow up with Lucinda: 10X PO ($162K stalled), R01 subcontract docs, UCLA subcontract', '[stale: from Feb] multi-item bundle — verify still pending', 'mike', 4, NULL, 'migration-2026-04-23', 'todo.md:38');

-- Priority 3: active lab/mentee or named blocker
INSERT OR IGNORE INTO tasks (title, context, owner, priority, due_date, source, source_ref) VALUES
  ('Liqing — ASPE ciliopathy', 'Recurring mentee work', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:25'),
  ('Review Sylvanus K99/R00 thread', 'Already in current.md "Needs Reply"', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:26'),
  ('Review Rachel Smith Hierarchical HotNet/BrainGO analysis', 'Active project', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:28'),
  ('Review Miao Tang''s review comments (Google Doc shared Feb 10)', '[stale: 10 weeks old] verify still pending', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:27'),
  ('Briana Macedo — thesis committee scheduling', 'No date; verify if already scheduled', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:29'),
  ('Yanli Wang — PsychENCODE/ASD GWAS data', '[stale] no date; verify still pending', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:30'),
  ('Jaeseung Song — postdoc inquiry response', '[stale] no date; may have lapsed', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:31'),
  ('R01 subcontract docs — due Feb 23 (Lucinda coordinating)', '[stale: 2 months past deadline] verify with Lucinda', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:18'),
  ('R01 resubmission — coordinate with Lucinda/Anne (Mar 5 deadline)', '[stale: 7 weeks past] verify with Lucinda', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:19'),
  ('Respond to Jade England "Clinical Note" email', 'Already in current.md as "Slack DM could NOT be sent — needs manual follow-up"', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:21');

-- Priority 2: research, no deadline
INSERT OR IGNORE INTO tasks (title, context, owner, priority, due_date, source, source_ref) VALUES
  ('Write to Brian Li about folate', 'No deadline given; verify still relevant', 'mike', 2, NULL, 'migration-2026-04-23', 'todo.md:35'),
  ('Follow up with Jakob Grove re: ASD sumstats', '[~] emails sent Feb 3-4, awaiting reply; 11 weeks of silence — likely dead thread', 'mike', 2, NULL, 'migration-2026-04-23', 'todo.md:34'),
  ('Intersect ASD risk genes with MAGICC modules (BrainGO)', 'Long-standing, no deadline', 'mike', 2, NULL, 'migration-2026-04-23', 'todo.md:41'),
  ('Review Salmon TPM vs long-read correlation figures for publication (Iso-Seq)', '[stale: from Feb 4 meeting]', 'mike', 2, NULL, 'migration-2026-04-23', 'todo.md:44'),
  ('Check height enrichment issue in Shridhar''s WGCNA (UKBB artifact?)', '[stale: from Feb 4 meeting]', 'mike', 2, NULL, 'migration-2026-04-23', 'todo.md:45');

-- Priority 1: reading list (Zaitlen Seminar)
INSERT OR IGNORE INTO tasks (title, context, owner, priority, due_date, source, source_ref) VALUES
  ('Read: Border et al., Science 2023 — Intergenerational dynamics', 'From Zaitlen Seminar', 'mike', 1, NULL, 'migration-2026-04-23', 'todo.md:48'),
  ('Read: Chun Chieh Fan et al. — Spousal correlations in psychiatric disorders', 'From Zaitlen Seminar', 'mike', 1, NULL, 'migration-2026-04-23', 'todo.md:49'),
  ('Read: Peyrot et al., JAMA Psychiatry 2016 — Fertility and psychiatric genetics', 'From Zaitlen Seminar', 'mike', 1, NULL, 'migration-2026-04-23', 'todo.md:50'),
  ('Read: Gorla PACA 2025 bioRxiv — Disease subtyping', 'From Zaitlen Seminar', 'mike', 1, NULL, 'migration-2026-04-23', 'todo.md:51');

COMMIT;

-- Verify
SELECT 'Total imported:', count(*) FROM tasks WHERE source = 'migration-2026-04-23';
SELECT priority, count(*) FROM tasks WHERE source = 'migration-2026-04-23' GROUP BY priority ORDER BY priority DESC;
