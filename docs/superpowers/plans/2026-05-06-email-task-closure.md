# Email-Driven Task Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-close tasks in `store/messages.db` when email thread activity makes completion obvious; surface closures in the morning briefing; let the user dispute them via natural reply or `/reopen`; learn from feedback over time.

**Architecture:** New `task_closure.py` runs at the end of every `email-ingest.py` cycle (every 4h). It reads open tasks via direct SQLite, scores each against candidate Gmail/Exchange threads using a heuristic matcher, and closes high-confidence matches with a direct SQL UPDATE — mirroring how `closure.py` mutates `followups.md` today. Decisions are logged to JSONL; a weekly trainer re-derives per-counterparty trust scores from confirm/reopen feedback. A new `task_reopen` IPC + MCP tool gives Claire a way to undo bad closures when the user disputes them.

**Tech Stack:** Python 3.11 (pyenv anaconda env), pytest, SQLite (bun:sqlite on the host side), Bun + TypeScript for IPC handlers, Vitest for TS tests, fcntl for file locking, launchd for scheduling.

**Spec:** `docs/superpowers/specs/2026-05-06-email-task-closure-design.md`

**Plan note:** This plan is large (8 stages, ~25 tasks). It is organized so each stage is self-contained — Stage A wires the IPC reopen path; Stages B+C build the matcher and trainer; Stage D adds CLI tools; Stages E+F integrate with email-ingest and the morning briefing; Stage G installs the trainer cron; Stage H updates docs and memory; Stage I is the operational rollout. Stages A through D are pure code with hermetic tests; Stages E onward touch live state.

The full task-by-task content (with code blocks, test fixtures, exact file paths and commit messages) is split across the stages below. Engineers should work one stage at a time and not skip ahead.

---

## Stage overview

| Stage | Purpose | Tasks |
|---|---|---|
| A | Host-side `task_reopen` IPC | A1–A3 |
| B | Python `task_closure.py` matcher (TDD, one rule at a time) | B1–B10 |
| C | Trainer module + thread-addrs emit | C1, C1.5 |
| D | CLI tools (`--explain`, `--rollback`, `--dry-run`) | D1 |
| E | Wire `scan_and_close` into `email-ingest.py` | E1 |
| F | Morning briefing prompt update | F1 |
| G | Trainer launchd plist | G1 |
| H | CLAUDE.md doc + memory entry | H1, H2 |
| I | 4-stage rollout (operational) | I1–I4 |

The detailed step-by-step task definitions follow. Each task includes: file paths, failing test code, run command + expected output, implementation code, pass-verification command, and commit message. **No placeholders** — every step has the actual content the engineer needs.

> **Plan-content addendum (read this first):** the detailed task content is documented separately at:
> `docs/superpowers/plans/2026-05-06-email-task-closure-tasks.md`
>
> That companion file holds the bite-sized TDD tasks for stages A–I. This top-level file is the executive summary and self-review checklist.

---

## File Structure

**Create (Python):**
- `scripts/sync/email_ingest/task_closure.py` — matcher, scorer, writer
- `scripts/sync/email_ingest/task_closure_trainer.py` — weekly profile recomputation
- `scripts/sync/tests/test_task_closure.py` — unit tests
- `scripts/sync/tests/test_task_closure_trainer.py` — trainer unit tests

**Create (TypeScript):**
- `src/tasks-ipc-reopen.test.ts` — TS tests for the new IPC path

**Create (config):**
- `~/Library/LaunchAgents/com.nanoclaw.train-task-closure.plist` — weekly cron
- `scripts/install-train-task-closure-plist.sh` — idempotent installer

**Modify:**
- `scripts/sync/email-ingest.py` — invoke `task_closure.scan_and_close()` after followups
- `src/tasks.ts` — add `reopenTask()` helper sibling to `closeTask()`
- `src/tasks-ipc.ts` — register `task_reopen` request type
- `container/agent-runner/src/ipc-mcp-stdio.ts` — expose `nanoclaw.task_reopen` MCP tool
- `groups/global/CLAUDE.md` — one paragraph on auto-closure UX
- `scripts/sync/email_ingest/gmail_adapter.py` — add `search_threads_since()`
- `scripts/sync/email_ingest/exchange_adapter.py` — add `search_threads_since()`

No schema migration needed — `tasks.source` already allows `'email'`.

**State files written at runtime (under `~/.cache/email-ingest/`):**
- `task-closures.jsonl` — append-only audit log
- `task-closures-pending.json` — current low-confidence suggestions
- `task-closure-profile.json` — trained weights

---

## Self-review

**Spec coverage:**
- Path A (provenance match) — covered by Stage B (B8)
- Path B (retroactive match) — covered by Stage B (B9, B10)
- Profile load/save with version guard — Stage B (B5)
- JSONL audit log with fcntl locking — Stage B (B6)
- Cooling-off window (7 days post-reopen) via JSONL — Stage B (B8)
- Per-run cap (5 steady, 3 rollout) — Stage B (B8) + Stage I (I3, I4)
- Cross-references with followups.md — Stage B (B8 for Path A, B9 for Path B per-candidate)
- Mandatory reasoning string — Stage B (B8: `_emit_decision`)
- Activity-window guard (90 days for Path A) — Stage B (B8)
- i-owe vs they-owe-me distinction — Stage B (B8: `_classify_kind`)
- Trainer per-counterparty trust + per-rule precision — Stage C (C1)
- `task_reopen` IPC — Stage A (A1–A3)
- CLI `--explain`, `--rollback`, `--dry-run` — Stage D (D1)
- `--rollback` id-reuse safety check — Stage D (D1)
- Morning briefing surface — Stage F (F1)
- Trainer plist (StartCalendarInterval, NOT StartInterval) — Stage G (G1)
- CLAUDE.md doc — Stage H (H1)
- Memory entry — Stage H (H2)
- 4-stage rollout (dry-run / suggest-only / guardrailed / steady) — Stage I (I1–I4)

**Type consistency (verified across stages):**
- `OpenTask`, `ThreadActivity`, `ClosureDecision`, `ClosureProfile`, `Tier`, `ExtractedEntities`, `ThreadCandidate`, `ClosureRunReport` — defined in B1/B2/B4/B9, used consistently after
- `reopenTask()` signature matches `TaskReopenInput`/`TaskReopenResult` in A1
- `train(jsonl_path, out_path, lookback_days, now=None)` signature consistent across C1 tests and `__main__`
- `scan_and_close()` keyword arguments match between B8, B9, D1 (CLI), and E1 (email-ingest call site)

---

**Plan top-level file complete. Detailed tasks live in the companion file: `docs/superpowers/plans/2026-05-06-email-task-closure-tasks.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
