# Email-driven Task Closure — Design

**Date:** 2026-05-06
**Author:** brainstormed with Mike via Claire (Opus 4.7)
**Status:** approved, awaiting implementation plan
**Related work:** builds on `scripts/sync/email-ingest.py` (2026-04-11 spec), reuses the trainer pattern from `2026-04-12-personalized-classifier-training-design.md`

## Problem

NanoClaw already ingests email every 4h and auto-closes followups in `groups/global/state/followups.md` when threads show closure-worthy activity (`scripts/sync/email_ingest/closure.py`). However, the **authoritative `tasks` table** (`store/messages.db`, 28 open rows as of design date) has no equivalent feedback loop. Tasks like `id:55 Respond to Elise email` or `id:14 Respond to Jade England` stay open in the morning briefing long after Mike has actually replied — because nothing connects email activity back to task state.

The result: stale items in the morning briefing erode trust in the briefing itself. The user must manually reconcile what's actually done.

## Goal

When email activity makes it obvious a task is complete, NanoClaw closes the task automatically. The morning briefing reports overnight closures with reasoning. The user can dispute incorrect closures via natural-language reply or a slash command. The system learns over time which closure rules and counterparties are reliable.

## Non-goals

- Replacing manual `task_close` flow — agents and users still close tasks directly.
- Detecting OOO/canned auto-replies upfront (handled implicitly via trainer's per-counterparty trust scores).
- Online learning or LLM-in-the-loop matching for v1 (heuristic-only matcher; LLM disambiguation is a future option if heuristics underperform).

## Success criteria

- ≥80% precision on dry-run smoke test before going live (manually verified against real threads).
- Steady-state per-run cap of 5 auto-closures; never auto-close priority-4 (top-3) tasks the user wouldn't have closed themselves.
- Morning briefing always reports decision counts (closed/suggested/cooling-off) so silent failures are visible.
- User dispute path (reply to digest OR `/reopen <id> <reason>`) feeds labels into trainer; per-counterparty trust scores adjust within one weekly retrain.

## Architecture

### High-level data flow

```
                                  ┌──────────────────────────────┐
                                  │ scripts/sync/sync-all.sh     │
                                  │ (every 4h via launchd)        │
                                  └──────────────┬───────────────┘
                                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │  email-ingest.py                                            │
   │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
   │  │ adapters │→ │classifier│→ │ exporter │→ │ followups  │ │
   │  │(gmail/exch)│ │+extractor│  │ (QMD)    │  │+ closure.py│ │
   │  └──────────┘  └──────────┘  └──────────┘  └────────────┘ │
   │                                                  │          │
   │                              ┌───────────────────▼────────┐ │
   │                              │  task_closure.py (NEW)      │ │
   │                              │  • read tasks via SQLite RO │ │
   │                              │  • match each to threads    │ │
   │                              │  • score + tier             │ │
   │                              │  • high → close (SQL UPDATE)│ │
   │                              │  • low → pending file       │ │
   │                              │  • log all to JSONL         │ │
   │                              └─────────────────────────────┘ │
   └────────────────────────────────────────────────────────────┘
                          │                │
                          ▼                ▼
        ~/.cache/email-ingest/      store/messages.db
        ├── task-closures.jsonl     ├── tasks (status flips)
        ├── task-closures-pending.json
        └── task-closure-profile.json (read by matcher; written by trainer)

   ┌──────────────────────────────────────┐
   │ Weekly trainer (Sun 2am via launchd): │
   │ ~/Library/LaunchAgents/               │
   │   com.nanoclaw.train-task-closure     │
   │ runs scripts/sync/email_ingest/       │
   │   task_closure_trainer.py             │
   │ Plist uses StartCalendarInterval      │
   │ (NOT StartInterval) for clock-time    │
   │ scheduling, mirroring the existing    │
   │ com.nanoclaw.train-classifier.plist.  │
   │                                       │
   │ JSONL → per-counterparty trust scores │
   │       → per-rule precision            │
   │ → writes task-closure-profile.json    │
   └──────────────────────────────────────┘

   ┌──────────────────────────────────────┐
   │ Morning briefing prompt extended:     │
   │ • Reads task-closures.jsonl (last 24h)│
   │ • Renders "✅ Auto-closed overnight"  │
   │ • Lists pending suggestions inline    │
   │ • User reply → Claire calls           │
   │   task_reopen(id, reason)             │
   └──────────────────────────────────────┘
```

### Key boundaries

- `task_closure.py` is the **only** module that mutates the `tasks` table from email-ingest. Direct SQLite write, mirroring how `closure.py` mutates `followups.md`. No new IPC abstraction for closures.
- Reading tasks is also direct SQLite (read-only connection).
- One new IPC action: `task_reopen(id, reason)` — used by the agent in response to a user dispute.
- Trainer is fully decoupled (separate cron, reads logs, writes profile, never touches the live tasks table).

### Per-ingest-run sequence

1. Existing pipeline runs through `followups.py` + `closure.py` as today.
2. `task_closure.py` runs: opens read connection, fetches `WHERE status='open'`, loads profile + new emails surfaced this run.
3. For each task, builds candidate-thread set, scores, decides tier.
4. High-tier closures: opens write connection, `UPDATE tasks SET status='done', completed_at=NOW WHERE id=?`. Append to JSONL.
5. Low-tier: write to pending file. Append to JSONL with `action:"suggested"`.
6. Drops below floor: append to JSONL with `action:"ignored"` (so the trainer can analyze near-misses too).

## Matching & scoring

### Inputs (per task)

- `task.id`, `task.title`, `task.context`, `task.created_at`, `task.source`, `task.source_ref`, `task.owner`
- All thread activity since `task.created_at` from Gmail + Exchange (already cached by ingest run)
- `task-closure-profile.json` (counterparty trust scores; empty on first run)
- Open follow-ups in `followups.md` (cross-reference: a task pointing at the same thread as an open follow-up holds closure)

### Path A — Provenance match (highest confidence)

- **Trigger:** `task.source = 'email'` AND `task.source_ref` is set.
- **Action:** scan that exact thread for activity since `task.created_at`. Mirror the i-owe / they-owe-me distinction from `closure.py`:
  - For tasks whose title or context indicates **i-owe** (e.g., "Respond to…", "Reply to…", "Send… to…"): closes only on a **user-sent message** in the thread since `task.created_at`.
  - For tasks indicating **they-owe-me** (e.g., "Awaiting…", "Follow up with… for…"): closes only on a **counterparty reply** since `task.created_at`.
  - When the kind cannot be inferred from the title/context, default to requiring a user-sent message (more conservative — matches the typical task pattern in the existing 28 open rows).
- **Score:** 1.0 if the matching activity exists. Auto-close threshold met immediately.
- **Activity-window guard:** Path A also requires the qualifying activity to be within the last **90 days** of the scan time, OR more recent than `task.created_at` if the task is newer than that. Prevents stale-thread-revival closures (e.g., a months-old task whose thread gets a tangential CC today).
- **Rationale:** zero ambiguity — task was born from this thread, thread moved in the right direction, work is done.

### Path B — Retroactive match (the existing 28 open tasks)

**Step 1 — Extract entities from task title + context:**
- Email addresses (regex)
- Names from `Key Contacts` table in `groups/global/CLAUDE.md` (Lucinda, Liqing, Yunlong, Michael Margolis, Raquel, Morgan)
- Project codes / identifiers via patterns: `R[0-9]+`, `K99/R00`, `RIS \d+`, `T32`, manuscript IDs like `COGEDE-D-26-00011`
- Capitalized first-name+last-name pairs not in contacts (e.g., "Joe Buxbaum", "Jade England")

**Step 2 — Find candidate threads** among threads with activity since task creation:
- Filter to threads where (a) sender or recipient address matches an extracted email, OR (b) sender display-name matches an extracted name, OR (c) thread subject contains an extracted project code.
- Cap at top 5 candidates.

**Step 3 — Score each candidate (0.0 to 1.0):**

| Signal | Weight |
|---|---|
| Counterparty match strength: exact email = 1.0, full name = 0.8, last name only = 0.5, project code only = 0.3 | × 0.40 |
| Activity recency: within 24h = 1.0, 7d = 0.8, 30d = 0.5, older = 0.2 | × 0.20 |
| Counterparty trust score from profile (default 0.5; contacts default 0.7) | × 0.20 |
| User-sent reply in thread since task creation (i-owe signal) | + 0.20 |
| Counterparty replied since task creation (they-owe-me signal) | + 0.10 |
| Penalty: another open task references this same thread | − 0.30 |

**Step 4 — Tier the result:**
- Score ≥ **0.75** AND winning candidate ≥ **0.20 above** runner-up → **auto-close** (high confidence).
- Score ≥ **0.55** OR top-two too close to call → **suggest** (low confidence, write to pending file).
- Score < 0.55 → drop (log as `action:"ignored"`).

### Reasoning string

Every closure produces a non-empty human-readable reasoning string captured in JSONL and surfaced in the digest. Example:
```
Closed: Lucinda replied 2026-05-04 14:23 in thread 'Re: 10X PO status' — matches contact 'Lucinda Bertsinger' (score 0.86). You sent reply 2026-05-04 09:15.
```
Empty reasoning → drop to suggested-tier (defensive against scoring bugs).

### Cross-reference with `followups.md`

The `FollowUp.thread` field is shaped `"gmail:<id>" | "exchange:<id>"` (per `email_ingest/types.py`); `task.source_ref` uses the same convention when set.

- **Path A (provenance match):** join is direct. If `task.source_ref == followup.thread` AND that followup is still `open`, the task closure is **held** and the task drops to suggested-tier.
- **Path B (retroactive match):** the task has no `source_ref`, so the cross-reference is applied **per candidate thread** during scoring. For each candidate, look up whether any open followup points at that thread; if so, that candidate's score is capped at the suggest tier (cannot auto-close), regardless of total score.
- **Why the per-candidate version of the rule:** in Path B the matcher might pick the wrong thread among multiple candidates. We don't want a high-scoring-but-wrong candidate to bypass the held-closure rule just because the *correct* candidate (the one with the open followup) happened to score lower. Capping per-candidate avoids that pathology.
- The followup's own closure logic always runs first (existing behavior in `closure.py`); if the followup gets auto-closed in the same run, the held task closure can fire on the next run.

## Components & file layout

### New code (8 files)

```
scripts/sync/email_ingest/
├── task_closure.py          NEW — matcher + scorer + writer
└── task_closure_trainer.py  NEW — weekly profile recomputation

scripts/sync/
└── email-ingest.py          MODIFIED — invokes task_closure after followups

src/
├── tasks.ts                 MODIFIED — adds reopenTask() helper sibling to closeTask()
├── tasks-ipc.ts             MODIFIED — registers 'task_reopen' request type, handler
└── tasks-ipc.test.ts        MODIFIED — adds tests for the reopen path

container/agent-runner/src/
└── ipc-mcp-stdio.ts         MODIFIED — exposes nanoclaw.task_reopen MCP tool to in-container agents

scripts/sync/tests/
└── test_task_closure.py     NEW — unit tests for matcher

~/Library/LaunchAgents/
└── com.nanoclaw.train-task-closure.plist   NEW — weekly trainer cron
                                            (StartCalendarInterval, NOT StartInterval —
                                             matches existing com.nanoclaw.train-classifier.plist)
```

**Note on the IPC change:** `task_reopen` is not a single-file addition. The full surface is the host helper (`tasks.ts`), the host-side IPC dispatcher (`tasks-ipc.ts`), the container-side MCP wrapper (`ipc-mcp-stdio.ts`, where all `nanoclaw.*` tools are exposed), and the test file. Symmetric to how `task_close` is wired today.

### State files (`~/.cache/email-ingest/`)

| File | Owner | Purpose |
|---|---|---|
| `task-closures.jsonl` | task_closure.py (append) + trainer (read) | every decision: action, task_id, score, reasoning, thread_ref, timestamp |
| `task-closures-pending.json` | task_closure.py (rewrite) | low-confidence suggestions, surfaced in digest |
| `task-closure-profile.json` | trainer (write) + task_closure.py (read) | per-counterparty trust scores, per-rule precision, tunable thresholds |

### Module interfaces

`task_closure.py`:
```python
def scan_and_close(
    db_path: Path,
    gmail_adapter,
    exchange_adapter,
    profile: ClosureProfile,
    contacts: dict[str, ContactInfo],
    followups: list[FollowUp],
    now: datetime,
) -> ClosureRunReport
```
Returns a report with counts (closed, suggested, ignored) and the list of decisions for logging. **No side effects beyond the SQL UPDATE and the JSONL append** — both happen inside this function so a test can stub them with a temp DB and a temp file.

`task_closure_trainer.py`:
```python
def train(jsonl_path: Path, out_path: Path, lookback_days: int = 30) -> None
```
Reads the JSONL, computes per-counterparty trust scores from confirm/reopen feedback, recomputes per-rule precision, writes the profile.

### Profile schema

```json
{
  "version": 1,
  "generated_at": "2026-05-12T02:00:00Z",
  "lookback_days": 30,
  "counterparty_trust": {
    "lucinda.bertsinger@pennmedicine.upenn.edu": {"closed": 4, "stuck": 4, "trust": 0.95},
    "noreply@chop.edu": {"closed": 2, "stuck": 0, "trust": 0.10}
  },
  "rule_precision": {
    "provenance_match": {"fired": 12, "stuck": 12, "precision": 1.00},
    "retroactive_full_email_match": {"fired": 8, "stuck": 7, "precision": 0.875},
    "retroactive_name_only_match": {"fired": 4, "stuck": 2, "precision": 0.50}
  },
  "thresholds": {
    "auto_close": 0.75,
    "suggest": 0.55
  },
  "contact_base_trust": 0.7,
  "default_base_trust": 0.5
}
```

### JSONL log format (one event per line)

```json
{"ts":"2026-05-05T11:18:35Z","action":"closed","task_id":55,"task_title":"Respond to Elise email","thread_ref":"gmail:abc123","score":0.86,"rule":"retroactive_full_email_match","reasoning":"Elise replied 2026-05-04 14:23. You sent reply 2026-05-04 09:15.","candidates_considered":1}
{"ts":"2026-05-05T11:18:35Z","action":"suggested","task_id":3,"task_title":"Reach out to Joe Buxbaum re: ASD cohort","thread_ref":"gmail:def456","score":0.62,"rule":"retroactive_name_only_match","reasoning":"Joe Buxbaum thread had activity but no explicit you→them message yet","candidates_considered":2}
{"ts":"2026-05-06T08:30:00Z","action":"reopened","task_id":55,"reason":"OOO not a real reply","feedback_source":"morning-digest-reply"}
```

The `reopened` event with the user's reason verbatim is what powers the trainer's learning — it ties a closure to a labeled outcome (stuck = correct, reopened = incorrect, with a reason category we can later cluster).

## Error handling & edge cases

| Failure | Behavior |
|---|---|
| SQLite write fails (lock, schema) | Log error, skip task, continue. Do NOT crash the email-ingest run. |
| Gmail/Exchange thread fetch fails | Skip that task this run; log as `action:"skipped"`. Retry next run. |
| Profile file missing or malformed | Fall back to baked-in defaults (contact_base 0.7, default_base 0.5, thresholds 0.75/0.55). Log warning. Matcher must work on day 1 before any training has run. |
| `task_reopen` IPC fails | Surface error verbatim to user in chat. Don't silently swallow. |
| Concurrent `task_close` from agent during scan | Re-read task status before each UPDATE; skip if status changed since fetch. |
| Trainer parses corrupt JSONL line | Skip that line, log warning, continue. |

### Edge cases (explicit)

1. **Tasks closed manually between scans.** Handled by `WHERE status='open'` filter. No special logic.
2. **Tasks reopened, then thread activity again.** Any task reopened within the last **7 days** is excluded from auto-closure (cooling-off window). Logged as `action:"cooling_off"`.
   - **How the matcher detects this:** no schema change. The matcher reads `task-closures.jsonl` at start of each scan and builds an in-memory set of `task_id`s with `action:"reopened"` events in the last 7 days. Any task in that set is automatically masked from Path A and Path B regardless of score. This keeps with the design's "JSONL is the audit trail" principle and avoids a tasks-table migration.
   - The `--rollback <task_id>` command also writes a `reopened` event so manual rollbacks trigger the same cooling-off behavior.
3. **Multiple tasks pointing at the same thread.** Existing −0.30 penalty handles typical case. Hard rule: if 3+ open tasks match the same thread, no auto-closure on any of them — flag all to suggested.
4. **`source_ref` is stale (thread deleted/archived).** Adapter returns empty for that thread → falls through to retroactive matching. No special handling.
5. **Automated user-side reply (calendar invite, OOO, canned "thanks").** Heuristic limitation. Trainer learns over time; counterparty/sender trust drops. Acceptable v1 leak.
6. **Followups cross-reference.** Open followup with same `thread_ref` → task drops to suggested-tier (covered in matching section).
7. **`group_folder` set vs. NULL (global).** Closures fire regardless of group. Existing IPC group-restriction is bypassed because we're writing directly to SQLite — JSONL is the audit trail.
8. **Empty contacts table or schema drift in CLAUDE.md.** Parser is tolerant — if Key Contacts section unparseable, contact_base_trust is not applied (everyone gets default 0.5). Logged once per run.
9. **Daylight saving / TZ confusion.** All timestamps in JSONL and DB are UTC.

### Guardrails

- **Dry-run mode** (`--dry-run`): full scan, JSONL with `dry-` prefix, no SQL UPDATEs. Used by tests and first manual validation runs.
- **Per-run cap**: max 5 auto-closures per scan (3 during initial guarded rollout). Beyond that, drops to suggested-tier with note "(per-run cap exceeded)". Hard ceiling against bad heuristic deployments torching the task list.
- **Cooling-off window**: 7 days post-reopen (mechanism specified in Edge case 2).
- **Mandatory reasoning string**: empty reasoning → drop to suggested-tier.
- **JSONL append safety**: every JSONL append is wrapped in an `fcntl.flock(LOCK_EX)` to prevent interleaved writes if two ingest runs overlap (e.g., post-sleep wakeups firing back-to-back). Trainer reads with `LOCK_SH`.
- **Idempotency**: closed tasks are excluded from candidate selection by the `WHERE status='open'` filter, so a second run on the same data simply does not re-decide them — no duplicate JSONL entry, no second SQL write. Suggested-tier candidates *are* re-evaluated on each run; the pending file is **rewritten in full** each run (atomic write to `pending.json.tmp` + `os.rename`), and JSONL gets one fresh `suggested` entry per run per still-pending task. Dropping out of the candidate set (e.g., because thread activity expired) removes the entry from pending but does not write a `dropped` event.

## Testing strategy

### 1. Unit tests (`test_task_closure.py`)

Hermetic, fast, no network/DB. Target **30+ tests**, mirroring the 42-test email-ingest suite.

- Scoring math: each weight tier, signal combinations, contact vs. non-contact base, cooling-off mask
- Entity extraction: emails, contacts-table names, project codes, name+last-name pairs
- Tier assignment: boundary cases at 0.55 / 0.75, runner-up gap rule
- Edge cases 1–9, each with a focused test
- Dry-run mode: assert no DB writes, JSONL still appended with `dry-` prefix
- Trainer math: per-counterparty trust update, per-rule precision, default-fallback when JSONL empty

### 2. Integration test

Temp SQLite + fixture emails:
- 5 task fixtures spanning every path (provenance match, full-name retroactive, ambiguous, multi-task-same-thread, cooling-off)
- Mock Gmail/Exchange adapters return canned thread activity
- Run `scan_and_close()` end-to-end → assert (i) correct status flips, (ii) JSONL entries match, (iii) pending file contents correct, (iv) reasoning strings non-empty
- Agent reply path: simulate a digest reply, assert `task_reopen` IPC fires with correct id + reason

### 3. Smoke test (required before live)

`python -m email_ingest.task_closure --dry-run --since=7d` against the live DB:
- Manually review every dry-closure decision against the actual thread (open Gmail, confirm)
- Iterate on heuristics if false-positive rate >20% on the smoke run
- **Gate to flip live:** ≥80% precision on dry-run smoke, AND no auto-closure on any priority-4 task the user wouldn't have closed themselves

## Rollout plan (4 stages, ~2 weeks)

| Stage | Duration | Mode | What ships |
|---|---|---|---|
| 1. Dry-run only | 3 days | `--dry-run` flag baked into sync-all.sh | JSONL fills with `dry-` decisions; nothing user-visible. Daily JSONL spot-check. |
| 2. Suggest-only | 3 days | Auto-close threshold raised to 1.01 (unreachable) | Everything goes to pending file. Briefing surfaces "🔔 Closure candidates" section. Manual approve/reject. Trainer starts running. |
| 3. Live with guardrails | 7 days | Normal thresholds + per-run cap of 3 (lower than steady-state 5) | First real auto-closures fire. Briefing gets "✅ Auto-closed overnight" section. JSONL captures reopens. Trainer runs weekly Sunday 2am. |
| 4. Steady state | ongoing | Cap raised to 5; thresholds tuned by trainer | System runs normally. Monthly review of profile to catch drift. |

## Observability

- `tail -20 ~/.cache/email-ingest/task-closures.jsonl` shows recent decisions.
- `python -m email_ingest.task_closure --explain <task_id>` runs the matcher against one task and prints the full scoring breakdown without writing.
- Morning briefing always prints the count of decisions in the last 24h ("✅ Auto-closed 3 · 🔔 Suggested 2 · ⏭ Cooling-off 1") so silent failures (zero counts for days) are visible.

## Failure-recovery commands

- `python -m email_ingest.task_closure --rollback <task_id>` reopens the task, appends a `manual-rollback` JSONL entry plus a `reopened` event (so the cooling-off window kicks in). For bad closures found long after the digest reply window. **Safety check:** before reopening, verifies that the current `tasks.title` matches the `task_title` recorded in the most recent `closed`/`dry-closed` JSONL entry for that id. If they differ (e.g., the id was reused after an `archived → re-add` cycle), the command refuses with a clear error and prints both titles.
- `python -m email_ingest.task_closure_trainer --recompute --since=14d` re-runs trainer ignoring stale JSONL. Used if profile gets poisoned.

## Documentation updates

- Update `groups/global/CLAUDE.md` Task Table section with one paragraph: "Tasks may auto-close from email activity. Auto-closures appear in your morning briefing under '✅ Auto-closed overnight' — reply naturally to dispute, or use `/reopen <id> <reason>`."
- The `/reopen` form is not a new top-level slash command; it is a convention recognized by the lead agent's prompt. The agent parses `/reopen <id> [reason]` and calls the `task_reopen(id, reason)` IPC action. This keeps the implementation surface to one IPC action plus a prompt update.
- Add a memory entry pointing at this design doc + the JSONL location, so future debugging knows where to look.

## Deliberate v1 limitations

- **Auto-closures that turn out wrong are reopened by the user, not auto-detected.** No "wait, that was wrong" detector — the trainer just lowers trust over time.
- **OOO/canned-reply false positives** rely on training to fix. We don't try to detect them upfront.
- **Heuristic-only matching.** No LLM disambiguation in v1. If the trainer's per-rule precision shows retroactive matching is the bottleneck, an LLM disambiguator becomes a targeted v2 addition.

All three are intentional YAGNI calls. Revisit after 4 weeks of steady-state data.
