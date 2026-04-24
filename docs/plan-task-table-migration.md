# Plan: Single-Source-of-Truth Task Table

**Status:** draft, awaiting Mike's approval
**Author:** Claude (with mgandal)
**Created:** 2026-04-24
**Related:**
- `docs/context-engineering/tool-design.md` (4-question rubric for new IPC tools)
- `src/db.ts` (schema migrations)
- `container/agent-runner/src/ipc-mcp-stdio.ts` (IPC tool registry)
- `groups/global/state/current.md` (current de-facto task source)

---

## Problem

Today, "what's on Mike's task list" lives in **at least five sources**:

| Source | Owner | How updated | Read by |
|---|---|---|---|
| `current.md` | `update-current.md` task (7am M-F) | LLM-curated from Todoist + calendar + Hindsight | Morning briefing, weekly deep-dive, week-ahead, agent session start |
| `todo.md` | manual | hand-edits | rarely (stale since March) |
| `lab-todos.md` | manual | hand-edits | rarely (stale since March) |
| `followups.md` | `email-ingest.py` cron | deterministic from Gmail/Exchange threads | morning briefing, mid-week followup |
| Todoist (external) | Claire + Mike | live MCP — **broken often** (token expiry, MCP disconnects) | `update-current.md`, `daily-task-prep` |

**Consequence:** when a task is resolved in one channel (e.g., Mike tells Claire "scRBP is done"), it does not propagate. The next digest reads stale state from a different source. Mike re-receives notifications about resolved items.

**Earlier attempts:**
- *Option A* (`current.md` as canonical) — rejected; lossy LLM regeneration, multiple competing markdown files, single-point-of-staleness.
- *Option B* (Todoist canonical) — rejected; token expiry + MCP disconnects make it unreliable; Mike has hit 3 separate Todoist failures in one session.
- *Option C* (hybrid Todoist+followups+derived current.md) — rejected when Todoist proved unreliable.
- *Option C′* (current.md canonical, regenerate-on-read) — viable fallback; not chosen because lossy markdown is fundamentally inferior to structured rows.

**Chosen: Option D** — SQLite `tasks` table inside NanoClaw, queried via IPC, no external dependencies.

---

## Goals

1. **One row, one truth.** A task exists exactly once. Every agent in every group reads from the same table.
2. **Mark-done from anywhere.** "Mike, that's done" in CLAIRE flips the row; the next digest in any group sees it as completed.
3. **No external service.** No tokens, no MCP servers, no rate limits. Survives restarts of everything except SQLite itself.
4. **Backward-compatible.** Existing scheduled tasks that read markdown files continue to work during the rollout. `current.md` becomes a *rendered view* written by the morning briefing, not a source of truth.
5. **Observability.** Every task row has source + source_ref so we can trace where it came from (email msg-id, slack ts, manual entry, migration).

## Non-goals

- Phone app for managing tasks (use Claire via Telegram).
- Recurring tasks (defer — none in current data; can add later).
- Dependencies between tasks (defer — rare in current data).
- Calendar integration (calendar stays a separate source the digest reads alongside tasks).

---

## Schema

Added via migration in `src/db.ts`. Additive only — no `ALTER` on existing tables.

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  context       TEXT,
  owner         TEXT,
  priority      INTEGER NOT NULL DEFAULT 3,
  due_date      TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  source        TEXT NOT NULL DEFAULT 'manual',
  source_ref    TEXT,
  group_folder  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  CHECK (owner IS NULL OR owner = lower(owner)),
  CHECK (status IN ('open','done','archived')),
  CHECK (priority BETWEEN 1 AND 4),
  CHECK (source = 'manual' OR source IN ('email','slack','scheduled-task') OR source LIKE 'migration-%')
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);
CREATE INDEX IF NOT EXISTS idx_tasks_group_status ON tasks(group_folder, status);

-- updated_at trigger (SQLite has no ON UPDATE)
CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
  AFTER UPDATE ON tasks FOR EACH ROW
  BEGIN
    UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
```

**Constraint rationale (added per peer review B3, S1):** the recent `next_run` bug (raw SQL bypassing API computation) showed application-layer rules don't survive direct DB access. CHECK constraints enforce invariants at the schema level. `updated_at` trigger prevents the field from staying frozen at `created_at`.

**Design notes:**
- `owner` is free-text lowercase (e.g., `liqing`, `mike`). Not an enum — too restrictive for collaborator names. Validation: lowercased on insert.
- `priority` is integer 1-4 (matches existing Todoist convention so users don't relearn).
- `source` and `source_ref` are mandatory for traceability. Manual entries get `source='manual'`, `source_ref=NULL`.
- `group_folder` lets us filter tasks by group while still allowing global tasks (`NULL`).
- `status='archived'` is soft-delete — preserves history without cluttering the open list.

---

## IPC tools

**v1 = 3 tools, not 5.** Per peer review (scope question), `task_update` is dropped (use `archive + add`) and `task_complete + task_archive` are merged into `task_close(outcome)`. Matches `tool-design.md`'s consolidation principle and the CLAUDE.md scope-discipline rule. v2 can re-introduce if real friction emerges.

Added to `container/agent-runner/src/ipc-mcp-stdio.ts`. Each follows the existing pattern (Use when / Do not use for / Inputs / Returns), per `docs/context-engineering/tool-design.md`.

### `nanoclaw.task_add`

```
Create a new task in the global task table. The task is immediately visible to all agents in all groups.

Use when:
- Mike says "add to my list" or "remind me to X".
- You discover a follow-up obligation during conversation that should be tracked.
- A scheduled task identifies an action item from email/slack that needs human attention.

Do not use for:
- One-shot reminders that do not need to persist (just respond inline).
- Calendar events with a specific time (use calendar tools instead).
- Email reply obligations — those are handled by followups.md via email-ingest.py.

Inputs:
- title (required): short imperative phrase ("Reply to Lucy Bicks", "Submit dbGaP renewal").
- context: free-text background, links, why-it-matters.
- owner: lowercase name ('mike', 'liqing', etc.). Defaults to 'mike' if omitted.
- priority: 1 (low) | 2 | 3 (default) | 4 (urgent / this week).
- due_date: ISO date 'YYYY-MM-DD' or omit.
- source: where this came from ('manual', 'email', 'slack', etc.). Defaults to 'manual'.
- source_ref: email msg-id, slack ts, etc. Helpful for de-dup.

Returns: { id: <new task id> }
```

### `nanoclaw.task_list`

```
Query open tasks across all groups. The authoritative read for "what is on Mike's list."

Use when:
- Generating a daily/weekly briefing.
- Mike asks "what's on my plate?" or "what's overdue?".
- You need to check for duplicates before adding a new task.

Do not use for:
- Looking up a specific task by id (use task_get instead).

Inputs:
- status: 'open' (default) | 'done' | 'archived' | 'all'.
- owner: filter to one owner ('mike').
- due_before: ISO date — return only tasks due on or before this date.
- group_folder: filter to one group; defaults to all groups (global view).
- limit: max rows (default 100).

Returns: array of task rows (id, title, owner, priority, due_date, status, source, created_at, ...).
```

### `nanoclaw.task_close`

```
Close a task — either as done (completed) or archived (no longer relevant). One tool, two outcomes.

Use when:
- Mike says "X is done" / "I finished X" → outcome='done'.
- A scheduled task verifies an action completed → outcome='done'.
- Task was created in error / is no longer relevant → outcome='archived'.

Do not use for:
- Editing a task in flight (no edit tool in v1; use task_close + task_add to replace).

Inputs (one of id or title_match required):
- id: exact task id (preferred — unambiguous).
- title_match: case-insensitive substring on title.
- outcome (required): 'done' | 'archived'.
- reason: optional short note (stored as "[closed: <reason>]" in context).

Returns on success: { matched: <id>, status: <outcome>, completed_at: <iso> }
Returns on no match: { error: "no open task matches" }
Returns on ambiguous match: { error: "ambiguous", candidates: [{id, title}, ...] }  ← agent picks an id and retries.

Auth: callers can only close tasks created by their group_folder OR tasks where group_folder IS NULL (global). Main group can close anything.
```

**Tool count rationale (revised per peer review):** 3 tools = `task_add`, `task_list`, `task_close`. Matches the "what's the minimum that solves drift?" question. Removed: `task_update` (use archive+add), `task_archive` (merged into `task_close`). v2 can re-add if real friction emerges.

---

## Migration of existing data

Source files: `groups/global/state/todo.md` (open: 16) + `lab-todos.md` (open: ~12, partly duplicated). Claire's earlier triage produced 28 deduped items.

**Bulk insert via raw SQL** (not via IPC — this is one-time and runs from the host).

**Idempotency guard (per peer review S4):** wrap insert in a guard so re-running the migration is safe.
```sql
-- Abort if migration already ran
SELECT CASE WHEN (SELECT count(*) FROM tasks WHERE source='migration-2026-04-23') > 0
            THEN RAISE(ABORT, 'migration-2026-04-23 already applied') END;
```
Or use `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE source='migration-2026-04-23' AND source_ref=?)` per row.

**Priority mapping rule (per peer review nit):** OVERDUE/CRITICAL → 4, HIGH → 3, normal → 2, FYI/reading → 1.

```sql
INSERT INTO tasks (title, context, owner, priority, due_date, source, source_ref, group_folder)
VALUES
  -- Priority 4 (deadline this month or named-person blocker)
  ('Provide Ziller project scope/budget for RIS 97589/00', 'Stalled — may need follow-up call instead of email', 'mike', 4, NULL, 'migration-2026-04-23', 'todo.md:37', NULL),
  ('Reach out to Joe Buxbaum re: ASD cohort', 'Already in current.md "High Priority"', 'mike', 4, NULL, 'migration-2026-04-23', 'lab-todos.md:10', NULL),
  -- Priority 3 (active lab/mentee)
  ('Liqing — ASPE ciliopathy', 'Recurring mentee work', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:25', NULL),
  ('Review Sylvanus K99/R00 thread', 'Already in current.md "Needs Reply"', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:26', NULL),
  ('Review Rachel Smith Hierarchical HotNet/BrainGO analysis', 'Active project', 'mike', 3, NULL, 'migration-2026-04-23', 'todo.md:28', NULL),
  -- ... (full 28-item list assembled at execution time)
  -- Priority 1 (Zaitlen Seminar reading list)
  ('Read: Border et al., Science 2023 — Intergenerational dynamics', 'From Zaitlen Seminar', 'mike', 1, NULL, 'migration-2026-04-23', 'todo.md:48', NULL);
```

**Stale items** (>60 days old with no recent activity) get `priority=2` and an explicit context note "[stale: created 2026-02-XX, verify still relevant]" so Mike can triage in-table.

**Verification after migration:**
```sql
SELECT priority, count(*) FROM tasks WHERE source='migration-2026-04-23' GROUP BY priority;
SELECT count(*) FROM tasks WHERE status='open';  -- should equal 28 (or whatever final count)
```

---

## Digest integration

Each digest task prompt gets a new STEP 0 at the top:

```
STEP 0 — Read live tasks (authoritative)
Call mcp__nanoclaw__task_list with status='open'. This is the canonical task list.
Do NOT read /workspace/project/groups/global/state/todo.md or lab-todos.md
(those are archived). Continue to read followups.md for email obligations and
calendar tools for time-bound events.
```

Tasks affected (4):
- `claire-morning-briefing` (telegram_claire, 30 7 * * 1-5)
- `hermes-week-ahead` (telegram_claire, 0 10 * * 6)
- `task-1775850929249-olcmx8` weekly deep-dive (telegram_claire, 30 9 * * 1)
- `followup-weekly-1774574992` mid-week followup (telegram_lab-claw, 0 8 * * 3)

Also patch:
- `update-current.md` task (`task-1774027787743-upd8cur`) — change to read from `task_list` and write `current.md` as a *rendered view* (markdown formatting of the table) rather than the source of truth. Keep the file existing so humans/agents can grep it for free.

---

## Build order

**STRICT ORDERING REQUIRED — steps are NOT independent (per peer review B1, B2).** Phase A is additive write-only (table exists, nothing reads it, nothing archived). Phase B requires container rebuild + verification GATE before any prompt edits.

### Phase A — additive only (today, ~1h)

| # | Step | Files | Verifiable by |
|---|---|---|---|
| 0 | Backup DB | `cp store/messages.db store/messages.db.bak.2026-04-24` | file exists |
| 1 | Schema migration | `src/db.ts` | `sqlite3 store/messages.db ".schema tasks"` shows table + 4 CHECK constraints + trigger |
| 2 | Bulk-insert 28 items (with idempotency guard) | `scripts/migrate-todos-to-tasks.sql` | `SELECT count(*) FROM tasks WHERE source LIKE 'migration-%'` returns 28; re-running aborts cleanly |
| 2b | Audit existing prompt references | `sqlite3 store/messages.db "SELECT id FROM scheduled_tasks WHERE prompt LIKE '%todo.md%' OR prompt LIKE '%lab-todos.md%' OR prompt LIKE '%current.md%'"` | print actual count; informs Phase B step 5 scope |

**Phase A stop point:** `todo.md` and `lab-todos.md` are NOT archived. No prompts edited. Table exists in parallel with markdown files.

### Phase B — IPC + integration (separate session, ~1 working day)

| # | Step | Files | Verifiable by |
|---|---|---|---|
| 3 | Snapshot current scheduled-task prompts | `docs/snapshots/scheduled-tasks-pre-task-table-2026-04-24.json` | file exists with all prompts dumped |
| 4 | 3 IPC tools + handlers + auth | `container/agent-runner/src/ipc-mcp-stdio.ts`, `src/ipc.ts` | unit test invokes each tool, verifies DB state + auth rejection from non-creator group |
| 5 | Container rebuild | `./container/build.sh` | container builds clean |
| 5b | **GATE:** verify task_list works in live container | n/a | spawn a CLAIRE container, invoke `mcp__nanoclaw__task_list`, see 28 rows. **DO NOT PROCEED without this.** |
| 6 | Patch N digest task prompts (use 2b audit count, not "4") | `sqlite3 ... UPDATE scheduled_tasks SET prompt=...` | read prompts back; each contains `task_list` |
| 6b | Patch `update-current.md` to render from `task_list` | DB UPDATE | next 7am run produces `current.md` from table |
| 7 | End-to-end test in CLAIRE | n/a | "what's on my list?" → calls task_list → returns 28; "X is done" → task_close → next list omits it |
| 8 | Archive `todo.md` + `lab-todos.md` | rename + add header pointing to table | files renamed; old paths gone |
| 9 | Update `groups/global/CLAUDE.md` + agent identity files | docs | grep for task_list returns multiple files |

**Total estimate (revised per peer review):** Phase A ~1h, Phase B ~1 working day (8h). Step 4 alone is 4h.

---

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Schema migration breaks `store/messages.db` | Low | Additive only (`CREATE IF NOT EXISTS`). Backup DB before migration. |
| Container rebuild fails | Low | `./container/build.sh` has been run dozens of times. Roll back by restoring previous container image. |
| Agents forget the new tools exist | **High** | The only real defense is rewriting every prompt that references deprecated paths. Step 2b audits actual count via `sqlite3 ... LIKE '%todo.md%'`; step 6 must hit ALL of them, not just "the 4 digests." Tool descriptions + CLAUDE.md updates are secondary. |
| Two writers race on the same task | Low | SQLite has row-level locking. `task_close` uses `WHERE status='open'` to prevent double-close. `task_update` removed (no race). |
| Existing `current.md` references in scheduled tasks return stale data | Medium | Step 6 patches all referencing tasks; `update-current.md` (step 6b) becomes a *renderer* not a *source*. |
| Claire creates duplicates of existing tasks | Medium | `task_add` server-side rejects identical case-insensitive titles in open status unless `force: true` (per peer review S5). |
| Cross-group task_close/archive abuse | Medium | `task_close` enforces auth: only creator group OR main group can close (per peer review S6). `task_list` defaults to all-groups read (low-risk). |
| Stale items pile up | Low | `archive` is one tool call; weekly cleanup task (future) can auto-archive `done` tasks >30 days old. |

---

## Rollback plan

If anything goes wrong:
1. **Steps 1-2 only**: `DROP TABLE tasks;` — no other code references it.
2. **Steps 3-4**: revert `ipc-mcp-stdio.ts`, rebuild container. Existing scheduled tasks unaffected (they don't yet use new tools).
3. **Steps 5+**: restore previous task prompts from git history (`git log -p src/task-scheduler.ts` doesn't help — prompts live in DB; use `task_run_logs` table to recover). **Mitigation:** before step 5, dump current prompts to `docs/snapshots/scheduled-tasks-pre-task-table-2026-04-24.json`.

---

## Open questions for Mike

1. **Reading-list items** (4 Zaitlen Seminar papers) — import as `priority=1` tasks, or skip them entirely (they're not really actionable like Joe Buxbaum is)? Default: import at priority 1 with owner='mike', source='migration-2026-04-23'. They'll be at the bottom of every digest but won't be lost.

2. **`update-current.md` task fate** — should it be:
   - (a) **Patched** to render `current.md` from `task_list` (keeps the human-readable file alive)
   - (b) **Deleted** (file becomes stale; agents read directly from `task_list`)
   - Default: **(a)** — humans + ad-hoc grep still benefit from the file.

3. **Migration timing** — execute migration steps 1-2 today (pure DB, low risk), then schedule a focused block for steps 3-9 later this week? Default: **yes, split that way** — it lets you see the table populated immediately and decide whether to commit to the IPC build.

---

## Decision log

- 2026-04-24 — Mike approved Option D after rejecting C′. Reason: structured rows beat regenerated markdown long-term; Todoist's reliability problems make external services untenable.
- 2026-04-24 — defaults set: owner=free-text lowercase, task_list=all-groups by default with optional filter, build done in two phases (DB first, then IPC).
- 2026-04-24 — peer review pass (superpowers:code-reviewer agent). Incorporated: B1 (Phase A is additive-only, no archive until Phase B verified), B2 (container rebuild + GATE before prompt edits), B3 (CHECK constraints + updated_at trigger), S1 (composite index), S2 (task_close returns candidate list on ambiguous), S3 (audit query in step 2b), S4 (idempotency guard), S5 (dedup by title in task_add), S6 (auth on close), nits (DB backup step, priority mapping rule). **Scope cut: 5 tools → 3 tools** (dropped `task_update`, merged `complete+archive` into `task_close(outcome)`). Time estimate revised: Phase B ~1 working day, not 3h.
