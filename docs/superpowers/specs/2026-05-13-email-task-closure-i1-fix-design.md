# Email-Task-Closure I1→I2 Gate Fix — Design

> **Status:** spec, not yet implemented.
> **Predecessor:** `docs/superpowers/specs/2026-05-06-email-task-closure-design.md` (the original closure system).
> **Predecessor rollout plan:** `docs/superpowers/plans/2026-05-06-email-task-closure-tasks.md` (Stage I = operational rollout).
> **Reviewers:** silent-failure-hunter (R1) + code-reviewer (R2) — both invoked before any code was written; verdicts incorporated below.

## Problem

Stage I1 (dry-run) of the email-task-closure rollout has been live since 2026-05-09. The I1→I2 advance gate fires when "FP rate ≤ 20% over the dry-closed decisions". After 4 days, **zero closure decisions have been emitted to `~/.cache/email-ingest/task-closures.jsonl`**, so the gate is unevaluable.

### Empirical baseline (2026-05-13)

Of 21 currently-open tasks in `store/messages.db`:

| Property | Count |
|---|---|
| `source='email'` (Path A eligible) | 0 |
| `source='migration-2026-04-23'` | 17 |
| `source='manual'` | 4 |
| Entity extraction yields `contact_keys` | 2 (Lucinda, Liqing) |
| Entity extraction yields raw email addresses | 0 |
| `addrs_empty` (Path B early-return at line 408) | 19 |
| `unknown_full_names`-only (no contact_keys, but unknown names extracted) | 9 |

### Three layered root causes

1. **`since=task.created_at` policy mismatch.** `scan_and_close` (line 600) and `explain_task` (line 768) pass `task.created_at` as the lookback floor to `_gather_candidate_threads`. For migrated tasks, `created_at = 2026-04-24` (the migration date), so the Gmail/Exchange search only looks back 19 days — missing the real email threads which are typically months/years older.

2. **Silent dropouts on every dead-end path.** When `_gather_candidate_threads` returns empty, when adapters throw, when `_path_a_should_close` returns False, when `assign_tier` returns DROP — the matcher `continue`s without emitting any JSONL event. The I1 gate has no signal to measure.

3. **No briefing-surface consumer for closure events.** `task-closures-pending.json` has writers but no readers; today's `dry-suggested` events are accumulating silently. R2 verified via grep: the morning-briefing prompt does not read pending or scan JSONL.

### What the matcher silently swallows today

- 19/21 tasks: `_gather_candidate_threads` early-returns at line 408 (`if not addrs: return []`). No event.
- Path A `continue` points (lines 562-574): adapter unknown, fetch_thread_messages exception, `_path_a_should_close=False`. No events.
- DROP-tier candidates: `_emit_decision` returns silently for `Tier.DROP`. No events.
- The followup-thread cap at line 630 (`score = min(score, suggest_threshold - 0.001)`) forces real candidates into DROP. No events.
- `append_jsonl_event` raise propagates and aborts mid-cycle. Partial telemetry.
- `task-closures-pending.json` write at lines 670-678 has no try/except. Pending decisions silently lost on disk-full.
- `_load_contacts_from_claude_md` returns `{}` on parse failure. Contacts-format regression masquerades as legitimate "no contacts".

## Goals

1. The I1 gate becomes **evaluable** — every scanned task produces at least one JSONL event per cycle.
2. The matcher behavior is **observable end-to-end** — the morning briefing surfaces closure-candidate signal so the user can see what the matcher is doing.
3. The I1→I2 gate criterion is **measurable** — replace undefined "FP rate" with a 3-part criterion grounded in event counts.
4. No silent failures introduced. No new wedge patterns.

## Non-goals

- Backfilling `source='email'` on the 17 migrated tasks (requires per-task Gmail thread lookup; out of scope).
- Building a `source='email'` task-ingestion pipeline (0/21 tasks have it today; separate feature).
- Modifying the closure scoring model itself (`score_candidate`, `assign_tier`, etc.). The scoring stays.

## Design

### 1. `OpenTask.scan_since` as `@property` method

`OpenTask` keeps `created_at` as the single date-source-of-truth. `scan_since` is exposed as a property that takes the current profile and clock, computing the lookback floor at access time. This subsumes the "stale scan_since across profile changes" concern that arose if the field were precomputed at fetch time.

Modify dataclass at `scripts/sync/email_ingest/task_closure.py:37-48`:

```python
@dataclass(frozen=True)
class OpenTask:
    id: int
    title: str
    context: Optional[str]
    owner: Optional[str]
    priority: int
    source: str
    source_ref: Optional[str]
    group_folder: Optional[str]
    created_at: datetime  # UTC, single source of truth for task creation time

    def scan_since(self, profile: "ClosureProfile", now: datetime) -> datetime:
        """Compute Gmail/Exchange lookback floor.

        Email-source tasks (Path A primary) use created_at as the floor.
        Path A is the dominant code path for those, so this branch is
        defensive. All other sources (migration, manual, scheduled-task)
        use a fixed lookback from now, controlled by
        profile.path_b_lookback_days (default 365).
        """
        if self.source == "email":
            return self.created_at
        return now - timedelta(days=profile.path_b_lookback_days)
```

`fetch_open_tasks` signature is **unchanged** (still `fetch_open_tasks(db_path)`). No breaking changes to existing callers (incl. test fixtures and `explain_task`).

**All consumers** call `task.scan_since(profile, now)`:
- `scan_and_close` line 600: `since=task.scan_since(profile, now)`
- `explain_task` line 768: `since=target.scan_since(profile, now)`
- `_path_a_should_close` line 505: `floor = max(cutoff, task.scan_since(profile, now))` (replaces `task.created_at`); helper signature gains `profile` and `now` parameters.

#### `_gather_candidate_threads` returns `(list[ThreadCandidate], list[AdapterError])`

Define a new frozen dataclass next to existing types (around line 50-58):

```python
@dataclass(frozen=True)
class AdapterError:
    adapter_name: str   # "gmail" | "exchange"
    error_message: str  # str(exception) — single-line, no traceback
```

Return signature: `tuple[list[ThreadCandidate], list[AdapterError]]`. Existing `log.warning` calls preserved; errors *additionally* surface to caller. Empty `list[AdapterError]` distinguishes "search ran cleanly, returned no hits" from "search raised".

**Rationale (R2 #3, R4 H1, R4 H2):** Single source of truth (`created_at`); policy is type-bound to `OpenTask` so a future consumer can't forget it; `AdapterError` matches existing dataclass style (`ClosureDecision`, `ThreadActivity`) instead of leaking dict shape.

### 2. `ClosureProfile.path_b_lookback_days`

Add field to `ClosureProfile` (line 60-75):

```python
@dataclass
class ClosureProfile:
    contact_base_trust: float
    default_base_trust: float
    thresholds: dict[str, float]
    path_b_lookback_days: int = 365   # new
    counterparty_trust: dict[str, float] = field(default_factory=dict)
    rule_precision: dict[str, float] = field(default_factory=dict)
    version: int = 1

    def __post_init__(self) -> None:
        if self.path_b_lookback_days < 1:
            raise ValueError(
                f"path_b_lookback_days must be >= 1, got {self.path_b_lookback_days}"
            )
```

Update `save_profile` (line 232) and `load_profile` (line 248) to persist/restore the field. Default 365 used on load if absent. `load_profile` clamps loaded values to `>= 1` (with `log.warning`) rather than raising, to avoid wedge-on-load.

**Rationale (R2 #2, R4 H6):** The trainer (`task_closure_trainer.py`) can later adapt the lookback per-counterparty without code change. The `__post_init__` guard prevents a calibration bug from silently scanning 0 days or a future window.

### 3. Event taxonomy — 7 distinct actions, each a frozen dataclass

Existing actions retained: `dry-closed`, `dry-suggested`, `closed`, `suggested`, `cooling_off`, `reopened`, `manual-rollback`. Seven new actions added (with `dry-` prefix in dry-run mode), each backed by a frozen dataclass that JSON-serializes via `dataclasses.asdict()`. This parallels how `ClosureDecision` (line 104-114) is the source-of-truth for `dry-closed`/`dry-suggested` payloads. Writer and consumer never drift; renaming a field is a refactor across the codebase, not a silent JSON break.

Enums (defined alongside the dataclasses, near the existing `Tier`):

```python
class EntityMissReason(enum.Enum):
    NO_CONTACT_KEYS_OR_EMAILS = "no_contact_keys_or_emails"


class SearchMissCause(enum.Enum):
    EMPTY_HITS = "empty_hits"
    ADAPTER_ERROR = "adapter_error"
    ADAPTER_UNKNOWN_FOR_SOURCE = "adapter_unknown_for_source"
```

All event dataclasses include `ts` (UTC ISO-8601) and `action` (literal string matching the JSONL action). The base `append_jsonl_event` helper accepts a typed event dataclass and serializes.

#### `dry-considered` — the I1 gate denominator

Emitted whenever the matcher evaluated a top candidate but did NOT close/suggest it. Fires when:
- `_emit_decision` is called with `Tier.DROP`.
- Followup-thread cap at line 630 pushed a real candidate into DROP.
- Path A's `_path_a_should_close` returned `(False, "", addrs)`.

```python
@dataclass(frozen=True)
class DryConsideredEvent:
    ts: str
    task_id: int
    task_title: str
    top_thread_ref: Optional[str]            # None when Path A close=False with no relevant msgs
    top_subject: str                         # "" when none available
    top_score: float                         # 0.0 for Path A close=False
    top_addrs: list[str]                     # [] never null
    runner_up_score: Optional[float]         # None when only 1 candidate
    runner_up_gap_satisfied: bool            # True iff (top_score - runner_up_score) >= RUNNER_UP_GAP_REQUIRED (0.20). False for runner_up=None implies vacuously True (gap measured against 0.0).
    match_strength: float
    rule: str                                # e.g. "retroactive_full_name_match"
    candidates_considered: int
    would_close_if: str                      # Tier.value: "auto_close" | "suggest" | "drop"
    reasoning: str
    action: str = "dry-considered"
```

**`would_close_if` semantics** — this is the gate's discriminator. The value is the `Tier` (serialized via `tier.value`) that the existing `assign_tier` function (line 166-179) returned for this candidate. Crucially, `Tier.AUTO_CLOSE` is **only** returned when `top_score >= auto_close threshold AND (top_score - runner_up) >= RUNNER_UP_GAP_REQUIRED`. So events with `would_close_if == "auto_close"` are the events that *would have been auto-closed in production* — runner-up gap already factored in. No parallel enum naming.

For inspection purposes `runner_up_gap_satisfied` is also written; a `top_score >= auto_close` candidate that failed the gap requirement gets `would_close_if == "suggest"` and `runner_up_gap_satisfied == False`. The gate criterion in §8 measures only events where `would_close_if == "auto_close"` — this is automatically AND'ed with the gap.

#### `dry-entity-miss`

Emitted when Path B reached entity extraction but `entities.contact_keys` and `entities.emails` are both empty.

```python
@dataclass(frozen=True)
class DryEntityMissEvent:
    ts: str
    task_id: int
    task_title: str
    unknown_full_names: list[tuple[str, str]]   # [] never null
    project_codes: list[str]                    # [] never null
    reason: str                                  # EntityMissReason.value
    action: str = "dry-entity-miss"
```

#### `dry-search-miss`

Emitted when the search adapter returned empty hits OR raised. Distinguishes "no thread activity" from "adapter failure" from "no adapter for this source".

```python
@dataclass(frozen=True)
class DrySearchMissEvent:
    ts: str
    task_id: int
    task_title: str
    addrs_queried: list[str]                # [] for adapter_unknown_for_source
    cause: str                              # SearchMissCause.value
    adapters_tried: list[str]               # ["gmail"], ["exchange"], or ["gmail","exchange"]
    error_message: Optional[str]            # populated iff cause == adapter_error
    action: str = "dry-search-miss"
```

Three causes:
- `empty_hits` — adapter returned `[]` cleanly.
- `adapter_error` — adapter raised; `error_message` carries the exception string.
- `adapter_unknown_for_source` — Path A had `source_ref = "<unknown_src>:..."` and no adapter matched (line 562-563).

#### `dry-needs-contact-resolution`

Emitted independently when `entities.unknown_full_names` is non-empty. Fires alongside `dry-entity-miss` (when both apply); briefing surface deduplicates by `full_name` at display time. Not emitted if `entities.contact_keys` resolved at least one contact (signals that extraction is partially working).

Schema:

```json
```python
@dataclass(frozen=True)
class DryNeedsContactResolutionEvent:
    ts: str
    task_id: int
    task_title: str
    full_name: str                           # canonical "First Last"
    qmd_candidate_email: Optional[str]       # auto-suggest from QMD email collection lookup; None if QMD found 0 prior threads
    qmd_candidate_thread_count: int          # 0 when qmd_candidate_email is None
    suggested_action: str                    # "add to groups/global/state/USER.md"
    action: str = "dry-needs-contact-resolution"
```

**Auto-suggest path (D1):** the writer performs a single QMD lookup against the `email` collection (intent: `"emails from <full_name>"`, type `lex`) before emitting the event. If at least 3 prior threads are found, populate `qmd_candidate_email` with the most-frequent sender address. The morning briefing then surfaces "Joe Buxbaum → suggested: jbuxbaum@mssm.edu (3 prior threads). Add to USER.md?". If QMD returns nothing or < 3 threads, fields stay `None` / `0` and the user gets a name-only nudge.

One event per `(task_id, full_name)` per UTC day. The matcher reads the last 24h of JSONL on cycle start and skips emission for any `(task_id, full_name)` pair already seen. This bounds JSONL growth at `n_unknown_names * 1 event/day` rather than `n_unknown_names * 6 cycles/day`.

#### `dry-cycle-start` — liveness sentinel (A4)

Emitted as the first event of every `scan_and_close` call, regardless of mode. The absence of `dry-cycle-start` events in JSONL distinguishes "matcher is healthy and finding nothing" from "matcher silently stopped running". I1 gate evaluation can assert one event per scheduled cycle and alarm otherwise.

```python
@dataclass(frozen=True)
class DryCycleStartEvent:
    ts: str
    open_task_count: int                # snapshot of open tasks at cycle start
    profile_version: int
    profile_path_b_lookback_days: int
    dry_run: bool
    action: str = "dry-cycle-start"
```

#### `pending-write-failed` — pending file write contract (C3)

Emitted when the atomic write of `task-closures-pending.json` (lines 670-678) raises. Best-effort: if this event also fails to append, `log.error` and `report.write_failure_count` is incremented.

```python
@dataclass(frozen=True)
class PendingWriteFailedEvent:
    ts: str
    error_message: str
    decisions_lost_count: int           # number of pending decisions in this cycle's in-memory list
    action: str = "pending-write-failed"
```

### 4. Per-task event invariant

After this change, every task examined in `scan_and_close` emits **at least one terminal event per cycle**, and `dry-cycle-start` brackets every cycle. The decision tree:

```
emit DryCycleStartEvent(open_task_count=..., dry_run=..., ...)

# Build per-(task_id, full_name) emission cache from last-24h JSONL
recent_needs_contact = scan_jsonl_last_24h("dry-needs-contact-resolution")

For each open task in scan_and_close:
  if task.id in cooling_off:
    emit CoolingOffEvent
    continue

  # Path A
  if task.source == "email" and task.source_ref:
    parse src,tid
    if adapter is None:
      emit DrySearchMissEvent(cause=ADAPTER_UNKNOWN_FOR_SOURCE, addrs_queried=[], adapters_tried=[src])
      report.skipped_count += 1   # preserved counter; event is source of truth
      continue
    try:
      thread_msgs = fetch_thread_messages
    except Exception as e:
      emit DrySearchMissEvent(cause=ADAPTER_ERROR, error_message=str(e), adapters_tried=[src])
      report.skipped_count += 1
      continue
    should_close, reasoning, addrs = _path_a_should_close(task, thread_msgs, now, profile)
    if not should_close:
      emit DryConsideredEvent(
        top_thread_ref=task.source_ref, top_subject=<subject_or_"">, top_score=0.0,
        top_addrs=list(addrs), runner_up_score=None, runner_up_gap_satisfied=True,
        match_strength=0.0, rule="path_a_no_activity",
        candidates_considered=1, would_close_if=Tier.DROP.value,
        reasoning=f"Path A: {reasoning or 'no relevant activity in window'}",
      )
      continue
    -> _emit_decision (existing: dry-closed or dry-suggested if cap-exceeded; emits DRY-suggested when source_ref in open_followup_threads)

  # Path B
  entities = extract_entities
  if entities.unknown_full_names:
    for (first, last) in entities.unknown_full_names:
      full_name = f"{first} {last}"
      if (task.id, full_name) in recent_needs_contact:
        continue   # UTC-daily dedup
      qmd_candidate = lookup_qmd_for_contact(full_name)  # returns (email_or_None, thread_count)
      emit DryNeedsContactResolutionEvent(
        task_id=task.id, task_title=task.title, full_name=full_name,
        qmd_candidate_email=qmd_candidate.email, qmd_candidate_thread_count=qmd_candidate.thread_count,
      )
      recent_needs_contact.add((task.id, full_name))

  if not entities.contact_keys and not entities.emails:
    emit DryEntityMissEvent(reason=EntityMissReason.NO_CONTACT_KEYS_OR_EMAILS.value, ...)
    continue

  candidates, adapter_errors = _gather_candidate_threads(since=task.scan_since(profile, now))
  if not candidates:
    if adapter_errors:
      first = adapter_errors[0]
      emit DrySearchMissEvent(
        cause=SearchMissCause.ADAPTER_ERROR.value,
        error_message=first.error_message,
        adapters_tried=[e.adapter_name for e in adapter_errors],
        addrs_queried=...,
      )
    else:
      emit DrySearchMissEvent(
        cause=SearchMissCause.EMPTY_HITS.value, error_message=None,
        adapters_tried=["gmail", "exchange"], addrs_queried=...,
      )
    continue

  # ... existing scoring loop (clip to followup_threshold cap, assign_tier) ...
  # _emit_decision now emits DryConsideredEvent for Tier.DROP, capturing top_score,
  # runner_up_score, runner_up_gap_satisfied, would_close_if=tier.value.

# pending file write — see §5 for try/finally semantics
```

**Per-cycle invariant:** exactly one `DryCycleStartEvent` opens each cycle. For any open task examined, exactly one of `{CoolingOffEvent, ClosedEvent (dry-closed in dry-run), SuggestedEvent (dry-suggested), DryConsideredEvent, DryEntityMissEvent, DrySearchMissEvent}` is emitted in that cycle. `DryNeedsContactResolutionEvent` is an independent track, may co-occur with `DryEntityMissEvent`, and is rate-limited to one per `(task_id, full_name)` per UTC day. `PendingWriteFailedEvent` is emitted only on the pending-file-write failure path.

**`report.skipped_count` semantics (R3 #9):** the existing counter is preserved for backwards compat with metrics consumers, but the JSONL events are the source of truth for I1 evaluation.

**`top_addrs` field handling (R3 #10, C7):** always emitted as a JSON array (`[]` when none available), never `null`. Consumer filters should not branch on null.

### 5. Error guards on event emission

#### Live-mode kill-switch on JSONL write failure (B1)

`append_jsonl_event` (line 271) wrapped in try/except. On failure (disk-full, permission, lock-timeout):
- `log.warning("task-closure: JSONL write failed: %s", e)`
- `report.write_failure_count += 1`

**Live-mode kill-switch:** if `dry_run is False` and `report.write_failure_count > 0`, `scan_and_close` ABORTS subsequent DB writes for the rest of the cycle. This preserves the cooling-off invariant: `read_recent_reopens` depends on the JSONL being a complete history of closes. A close written to DB without an audit-log entry would silently break the 7-day cooling-off window on the next cycle.

In dry-run mode, the matcher continues (no DB writes anyway; missing audit-log entries only affect I1 telemetry, which the gate evaluator can detect via missing `DryCycleStartEvent` for that cycle).

#### Pending file write (B6, C3)

Pending file write (lines 670-678) wrapped in **try/finally**. The `finally` block executes regardless of any earlier exception in the cycle's task loop, so in-memory `pending_decisions` accumulated up to the crash point are written to disk:

```python
try:
    for task in open_tasks:
        # ... main loop ...
finally:
    try:
        atomic_write_pending(pending_path, pending_decisions)
    except Exception as e:
        append_jsonl_event(jsonl_path, PendingWriteFailedEvent(
            ts=utcnow_iso(),
            error_message=str(e),
            decisions_lost_count=len(pending_decisions),
        ))
        report.write_failure_count += 1
```

This guarantees pending decisions persist on crash AND the failure is observable.

#### Briefing-surface digest contract (B2)

`publish_closure_candidates_digest` wraps its work in a try/except. On any failure (pending.json unreadable, JSONL scan throws, atomic rename fails), it writes a fallback digest:

```json
{
  "version": 1,
  "generated_at": "<ts>",
  "error": "<one-line failure description>",
  "pending_items": [],
  "needs_contact_resolution": []
}
```

The morning briefing prompt is required to **fail loud** on this `error` field (see §7).

### 6. Contacts loader sanity check

`_load_contacts_from_claude_md` (line 853) — emits a `log.warning` in two failure modes that today silently return `{}`:
- File exists but no `| Name ` table header found → `log.warning("contacts: %s has no contacts table; entity extraction will degrade", path)`.
- `| Name ` header found but the same line is missing the `Email` column token → `log.warning("contacts: %s has Name header but no Email column; renamed?", path)`. Catches header renames like "Email Address" or "Address" that would otherwise drop the table parse silently (R3 #11).

Distinguishes parse-failure from empty-file-by-design.

### 7. Stage F: morning briefing surface

**Mount scope (D8):** `/workspace/project/groups/global/state/` is the **main-only** mount path (see `src/container-runner.ts:285-291` — non-main groups receive `/workspace/global` instead). This surface only fires in the `telegram_claire` (main) group, which is also where `claire-morning-briefing` runs. Non-main groups are intentionally not addressed here.

#### Host-side: publish closure-candidates digest

After `scan_and_close` returns in `email-ingest.py` (line ~344), publish a digest to `groups/global/state/closure-candidates.json`:

```python
publish_closure_candidates_digest(
    pending_path=PENDING_PATH,
    jsonl_path=JSONL_PATH,
    digest_path=REPO_ROOT / "groups" / "global" / "state" / "closure-candidates.json",
    state_path=Path.home() / ".cache" / "email-ingest" / "closure-digest-state.json",
    lookback_hours=24,
)
```

The digest function:
1. Reads `task-closures-pending.json` → `pending_items` (each carries its own `last_seen` from emission ts).
2. Reads `closure-digest-state.json` (or initializes if absent) — stores `last_publish_ts`. Used as the lower bound for the `dry-needs-contact-resolution` scan window so events emitted before the previous publish don't re-surface, and as the source for the `since_last_briefing` field.
3. Scans JSONL for `dry-needs-contact-resolution` events between `last_publish_ts` and `now` (or last 24h, whichever is shorter). Deduplicates by **`(task_id, full_name)`** (fixes the contradiction R4 H5; multi-task signal preserved — Joe Buxbaum appearing in tasks #3 and #11 yields 2 entries).
4. Writes atomically (tmp+rename) to digest_path. Then rewrites `closure-digest-state.json` with `last_publish_ts = now`.
5. Error handling per §5 (writes the `error` sentinel digest on partial failure).

Digest schema:

```json
{
  "version": 1,
  "generated_at": "2026-05-14T11:30:00Z",
  "since_last_briefing": "2026-05-14T07:30:00Z",
  "error": null,
  "pending_items": [
    {
      "task_id": 4,
      "task_title": "Follow up with Lucinda...",
      "top_thread_ref": "gmail:18c4...",
      "top_subject": "Re: 10X PO status",
      "top_score": 0.62,
      "first_seen": "2026-05-13T11:30:00Z",
      "last_seen": "2026-05-14T11:30:00Z"
    }
  ],
  "needs_contact_resolution": [
    {
      "full_name": "Joe Buxbaum",
      "task_id": 3,
      "task_title": "Reach out to Joe Buxbaum re: ASD cohort",
      "qmd_candidate_email": "jbuxbaum@mssm.edu",
      "qmd_candidate_thread_count": 3,
      "last_seen": "2026-05-14T11:30:00Z"
    }
  ]
}
```

**Version-check contract (C5):** consumers (briefing prompt, future readers) must check `version == 1` and emit a loud warning if not. The digest writer never bumps the version without a corresponding consumer update.

#### Container-side: briefing prompt update

Modify the `claire-morning-briefing` row in `scheduled_tasks.prompt`. Add to STEP 1:

```
- Closure candidates: read /workspace/project/groups/global/state/closure-candidates.json.
  - If file does not exist, omit Closure candidates section entirely.
  - If file has `error` field set (non-null), emit the section as: "⚠️ *Closure candidates digest broken* — `<error>`. Investigate sync-health logs."
  - Otherwise parse pending_items[] and needs_contact_resolution[] for the section template.
```

Add new section between "📋 Follow-ups" and "💬 Slack" (Telegram format: single `*asterisks*` only; **no `##` headers, no `**double**` bold** — match the existing prompt's "Telegram style" rules):

```
🔔 *Closure candidates* (only if pending_items or needs_contact_resolution non-empty)

[For each pending_item, in order:]
• [task_title] → matched "[top_subject]" (score [top_score])
  Reply "close [task_id]" to confirm, "reopen [task_id]" if wrong.

[If needs_contact_resolution non-empty:]
*Unknown contacts to add to USER.md*
• [full_name] — referenced in task #[task_id] "[task_title]"
  [if qmd_candidate_email is non-null:]   Suggested: [qmd_candidate_email] ([qmd_candidate_thread_count] prior threads). Add to USER.md?
  [else:]                                  Not found in past email — manually add to USER.md if real contact.
```

Omit section entirely if both `pending_items` and `needs_contact_resolution` are empty AND `error` is null.

#### Proactive nudge surface (D2)

Add a second scheduled task `closure-pulse` to `scheduled_tasks` table:

- Schedule: `0 */4 * * *` (every 4h, aligned with sync cycle).
- Group: `telegram_claire`.
- Prompt: read `closure-candidates.json`. If either (a) `len(needs_contact_resolution) >= 3` AND `last_seen of all 3 > 4h ago` (i.e., persistent unresolved nudges), or (b) any `pending_items` entry has `first_seen > 24h ago`, send a one-shot Telegram message: "🔔 N closure candidates pending review — see `/workspace/project/groups/global/state/closure-candidates.json` or wait for morning briefing." Otherwise no-op (do NOT send a message).

This ensures weekend signal doesn't stall and 14-day clock is measured with the user actually informed.

#### SQL UPDATE migration safety (B4, R5 H8)

The briefing prompt update is destructive against `store/messages.db::scheduled_tasks.prompt`. Ship as a migration script `scripts/migrations/2026-05-14-add-closure-candidates-briefing-section.py`:

1. **Backup:** copy current `prompt` field to `data/migrations/2026-05-14-briefing-prompt-backup.txt` (verify backup written before UPDATE).
2. **Versioning sentinel:** the new prompt body must end with a hidden marker line `<!-- closure-candidates-section v1 -->`. Migration script checks for the marker before running; if present, exit 0 (idempotent re-run).
3. **Deploy ordering (R5 H8):**
   - Phase 1: deploy new matcher + digest publisher.
   - Phase 2: force-run sync (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw.sync`).
   - Phase 3: verify `groups/global/state/closure-candidates.json` exists (even with empty arrays).
   - Phase 4: ONLY THEN run the migration script to UPDATE the prompt.
   - Phase 5: install the `closure-pulse` scheduled task row.

4. **Rollback:** if the new briefing breaks (LLM produces wrong format, etc.), `scripts/migrations/2026-05-14-rollback.py` restores from the backup file and removes `closure-pulse`.

### 8. I1→I2 advance gate (reformulated)

The original criterion in `docs/superpowers/plans/2026-05-06-email-task-closure-tasks.md:2661` is replaced by the following 4-part criterion. **All four must be satisfied to advance to I2.**

1. **Liveness:** ≥ 1 `dry-cycle-start` event per scheduled cron interval (every 4h) over the evaluation window. Confirms matcher actually ran. Absence of events on this dimension implies "matcher dead", not "matcher found nothing".

2. **Signal volume:** ≥ 10 `DryConsideredEvent` events with `would_close_if == Tier.AUTO_CLOSE.value` (i.e., `"auto_close"`) accumulate in `~/.cache/email-ingest/task-closures.jsonl` over ≥ 3 days. Because `Tier.AUTO_CLOSE` is *only* returned by `assign_tier` when both `top_score >= auto_close threshold` AND `(top_score - runner_up) >= RUNNER_UP_GAP_REQUIRED` (line 175-179), this count already excludes runner-up-gap failures and is a faithful "would have auto-closed in prod" denominator (R3 #12, A1).

3. **Near-miss precision:** User-conducted review (Mike inspects each event in #2, optionally using `task_closure.py --explain <task_id>`) shows ≤ 20% of those events would have been wrong auto-closures. "Wrong" = matched thread is unrelated, or the task is still genuinely open after the matched activity, or the activity-window guard would have produced a spurious close.

4. **Briefing surface verification:** At least one `🔔 Closure candidates` section has appeared in a morning-briefing Telegram message during I1, with either pending_items or needs_contact_resolution non-empty. Confirms end-to-end Stage F path is live.

#### 14-day fallback decision tree

Clock starts when the new matcher code is deployed and the first sync cycle has completed (i.e., the first cycle where new event types could appear in JSONL). At 14 days from that point:

| Condition | Action |
|---|---|
| All 4 criteria met | Advance to I2 (Task I2 in original plan). |
| Liveness (1) fails | URGENT: matcher is silently dead. Inspect `sync.log`, `nanoclaw.error.log`, `~/.cache/email-ingest/`. Do NOT advance. |
| Signal (2) < 10 + ≥ 5 new contacts added to USER.md during I1 | Extend I1 by 7 more days (contacts table growing → matcher recall improving). |
| Signal (2) < 10 + < 5 new contacts added | **Freeze I1** (definition below). File separate brainstorming task: "Contacts-table-coverage is the upstream blocker for email-task-closure recall." |
| (2) ≥ 10 but precision (3) fails | **Freeze I1**. Investigate scoring weights or threshold calibration. Defer I2. |
| (2) ≥ 10 and precision ok, but surface (4) fails | Investigate Stage F surface; briefing prompt may have regressed. Fix and re-check. |

**Freeze definition (B7, R5 H6):** "Freeze I1" is operationally:
- Keep `TASK_CLOSURE_ENABLED=1` and `TASK_CLOSURE_DRY_RUN=1` in `~/Library/LaunchAgents/com.nanoclaw.sync.plist`. Matcher continues running and emitting telemetry — freezing the *advance*, not the data collection.
- Keep `closure-pulse` scheduled task active.
- File a `task_add` row tracking the upstream blocker (contacts coverage, scoring calibration, or surface bug).
- Do NOT advance to I2. Do NOT disable the cron. Do NOT delete state files.

Explicitly forbidden: any "freeze" interpretation that disables the matcher, since that would be the silent-failure-wedge anti-pattern documented in `feedback_silent_failure_wedge.md` (the only path that produces signal is the one we'd be turning off).

### 9. Telemetry stewardship — JSONL growth

`read_recent_reopens` (line 285-315) scans the full JSONL each cycle. With the new event volume — and crucially with the UTC-daily dedup on `DryNeedsContactResolutionEvent` (per §3) plus once-per-cycle `DryCycleStartEvent`:

- 21 tasks × 6 cycles/day × 1 terminal verdict event = ~126 verdict events/day.
- 6 `DryCycleStartEvent` / day.
- ~10 `DryNeedsContactResolutionEvent` / day (dedupe-on-write: one per `(task_id, full_name)` per UTC day).
- **Total ≈ 145 events/day steady-state.** At ~250 bytes/event ≈ 35 KB/day.
- 7-day cooling-off scan window: ~1,000 events ≈ 250 KB. Negligible.

The UTC-daily dedup (per §3) prevents the unbounded-growth scenario the original spec hand-waved. JSONL stays manageable for at least a year before any rotation is needed.

**Future work (out of scope for this fix):** add monthly JSONL rotation (mv to `task-closures.jsonl.YYYY-MM`) when file exceeds 10MB. Trainer reads all rotated files via `glob`. Not blocking I1→I2.

## Test plan

### Unit tests in `scripts/sync/tests/test_task_closure.py`

1. **`test_scan_since_email_source_uses_created_at`** — Build `OpenTask` with `source='email'`, `created_at=2026-04-01`. `fetch_open_tasks` should populate `scan_since=2026-04-01`.
2. **`test_scan_since_migration_uses_profile_lookback`** — `source='migration-2026-04-23'`, `now=2026-05-13`, `profile.path_b_lookback_days=365`. `OpenTask.scan_since(profile, now)` should equal `2025-05-13`.
3. **`test_scan_since_manual_uses_profile_lookback`** — Same as above but `source='manual'`.
4. **`test_scan_since_email_source_uses_created_at`** — `source='email'`, `created_at=2026-04-01`. `OpenTask.scan_since(profile, now)` should equal `2026-04-01` regardless of profile.
5. **`test_scan_since_picks_up_profile_change_at_access`** — Build one OpenTask; call `scan_since` twice with two profiles (lookback=180 then lookback=365). Verify both calls return correctly. Confirms the property semantics (not cached at construction).
6. **`test_profile_load_default_lookback`** — Profile JSON without `path_b_lookback_days` field loads with 365 default.
7. **`test_profile_save_load_roundtrip_with_lookback`** — Set lookback=180, save+load, value preserved.
8. **`test_profile_post_init_rejects_zero_and_negative`** — `ClosureProfile(path_b_lookback_days=0)` raises `ValueError`; same for `-1`.
9. **`test_profile_load_clamps_negative_with_warning`** — Profile file on disk with `path_b_lookback_days=-5`; load returns default 365 AND emits log.warning. (Spec §2 promises clamp-not-raise on load.)
10. **`test_dry_entity_miss_event_emitted`** — Task whose extraction yields no contact_keys and no emails. Verify exactly one `DryEntityMissEvent` in JSONL with `reason == EntityMissReason.NO_CONTACT_KEYS_OR_EMAILS.value`. Also verify `DryNeedsContactResolutionEvent` co-emitted per unknown name.
11. **`test_dry_search_miss_empty_hits`** — Mock adapter returning `[]`. Verify `DrySearchMissEvent` with `cause == SearchMissCause.EMPTY_HITS.value`.
12. **`test_dry_search_miss_adapter_error`** — Mock adapter raising. Verify `DrySearchMissEvent` with `cause == SearchMissCause.ADAPTER_ERROR.value` AND `error_message` populated.
13. **`test_gather_candidate_threads_returns_errors`** — Mock gmail adapter raising `RuntimeError("rate limit")`, exchange adapter returning `[]`. Verify return value is `([], [AdapterError(adapter_name="gmail", error_message="rate limit")])`.
14. **`test_dry_considered_drop_tier`** — Mock candidate with score 0.4 (below suggest=0.55). Verify `DryConsideredEvent` with `would_close_if == Tier.DROP.value` AND `runner_up_gap_satisfied == True` (no runner-up).
15. **`test_dry_considered_above_auto`** — Mock candidate with score 0.85 and no runner-up. Verify `dry-closed` emitted (NOT `dry-considered`) and `report.closed_count==1` in dry-run mode (DB not mutated).
16. **`test_dry_considered_above_auto_but_runner_up_gap_fails`** — Mock candidates: top=0.80, runner=0.65 (gap 0.15 < 0.20). `assign_tier` returns `SUGGEST`. Verify `dry-suggested` emitted (NOT `dry-closed`) and the event records `runner_up_gap_satisfied == False`. **Critical gate-discriminator test (A1).**
17. **`test_dry_considered_followup_clip`** — Mock candidate with raw_score 0.8 but `open_followup_threads` contains its thread_ref. Score clipped to suggest-0.001. Verify `DryConsideredEvent` with `would_close_if == Tier.DROP.value` AND reasoning notes the clip.
18. **`test_path_a_should_close_false_emits_dry_considered`** — Mock Path A with no relevant messages in window. Verify `DryConsideredEvent` with `top_score == 0.0`, `would_close_if == Tier.DROP.value`, `top_addrs == []` (not null).
19. **`test_path_a_floor_uses_scan_since_email`** — Task with `source='email'`, `created_at=2026-04-01`, message at 2026-03-15. Activity-window cutoff at 2026-02-12. `floor = max(2026-02-12, 2026-04-01) = 2026-04-01`. Message excluded.
20. **`test_path_a_floor_uses_scan_since_migration_case`** — Hypothetical: backfilled task with `source='email'` (so Path A would fire) but profile lookback effectively widens the window. Build task with `created_at = now - 400d`; activity-window cutoff at now-90d. `floor = max(now-90d, created_at) = now-90d`. Activity in last 90d included.
21. **`test_dry_cycle_start_emitted_first`** — Run `scan_and_close` with empty open_tasks. Verify exactly one event in JSONL, of type `DryCycleStartEvent`, with `open_task_count == 0`.
22. **`test_dry_cycle_start_emitted_before_terminal_events`** — Run `scan_and_close` with 3 open tasks. First event MUST be `DryCycleStartEvent`, followed by 3 terminal events. Order asserted (not just count).
23. **`test_append_jsonl_event_disk_full_does_not_raise`** — Mock `fp.write` raising `OSError(ENOSPC)`. Verify `report.write_failure_count==1` and no exception propagated.
24. **`test_live_mode_aborts_db_writes_on_jsonl_failure`** — `dry_run=False`. After first task closes successfully, next task's `append_jsonl_event` raises. Verify: no subsequent `close_task_in_db` calls for remaining tasks; `report.write_failure_count > 0`. **Critical B1 invariant.**
25. **`test_pending_write_failure_logged_not_raised`** — Mock `tmp.replace` raising. Verify `PendingWriteFailedEvent` in JSONL with `decisions_lost_count` matching what was in-memory, and `report` returned cleanly.
26. **`test_pending_write_runs_in_finally_on_crash`** — Mock the matcher's task loop to raise after the 2nd of 5 tasks. Verify `pending_path` contains the 2 already-emitted suggestions (try/finally semantics, B6).
27. **`test_contacts_loader_no_table_warns`** — USER.md with no `| Name ` table header. Returns `{}` AND emits log.warning.
28. **`test_contacts_loader_name_without_email_warns`** — USER.md with `| Name | Role |` header (no Email column). Returns `{}` AND emits log.warning matching "no Email column".
29. **`test_needs_contact_resolution_utc_daily_dedup`** — Run scan twice within 24h on the same task with same unknown name. First call emits `DryNeedsContactResolutionEvent`. Second call (same UTC day) emits zero. Third call after `now += 25h` emits again.
30. **`test_needs_contact_resolution_qmd_candidate_populated`** — Mock QMD lookup returning 3 threads with sender `jbuxbaum@mssm.edu`. Verify emitted event has `qmd_candidate_email == "jbuxbaum@mssm.edu"` and `qmd_candidate_thread_count == 3`.
31. **`test_needs_contact_resolution_qmd_candidate_below_threshold`** — Mock QMD lookup returning only 1 thread. Verify emitted event has `qmd_candidate_email is None` and `qmd_candidate_thread_count == 0` (below 3-thread floor).
32. **`test_per_task_event_invariant`** — Inject 5 tasks: cooling_off, dry-entity-miss, dry-search-miss, dry-considered, dry-closed. Verify exactly 1 `DryCycleStartEvent` + 5 terminal events (one per task); plus N `DryNeedsContactResolutionEvent` co-events.

### Integration tests

33. **`test_explain_uses_scan_since_method`** — `--explain <task_id>` on a migration task. Verify (a) `target.scan_since(profile, now)` equals `now - timedelta(days=profile.path_b_lookback_days)`; (b) the same value is passed as `since` to the mocked `search_threads_since`. Pins both the property derivation AND the call-site flow (D4).
34. **`test_publish_closure_candidates_digest_dedupe_key`** — JSONL with 3 `dry-needs-contact-resolution` events: 2 for "Joe Buxbaum" (one in task #3, one in task #11) + 1 for "Jane Doe" (task #5). Digest should have **3** `needs_contact_resolution` entries (dedup by `(task_id, full_name)`, not just `full_name`). Confirms A2 fix.
35. **`test_publish_closure_candidates_digest_writes_error_sentinel_on_failure`** — Mock `pending.json` read to raise. Verify written digest has `error` field non-null and both arrays empty.
36. **`test_publish_closure_candidates_digest_respects_since_last_briefing`** — Set `closure-digest-state.json` with `last_publish_ts = now - 2h`. JSONL has events 4h old and 1h old. Verify digest only includes the 1h-old events.
37. **`test_migration_script_idempotent`** — Run the prompt UPDATE migration twice. Verify the prompt has exactly one `<!-- closure-candidates-section v1 -->` marker and was not double-modified.

### Manual/operational tests

38. **End-to-end Stage F surface:** after deploying, force a sync cycle (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw.sync`), then trigger a morning briefing manually. Verify the `🔔 Closure candidates` section appears with at least one entry from the 9 `unknown_only` tasks (Joe Buxbaum likely surfaces with `qmd_candidate_email` populated if QMD `email` collection has prior threads).
39. **Gate re-evaluation:** 3 days after deploy, count `DryConsideredEvent` rows with `would_close_if == "auto_close"`. If ≥ 10, perform manual review per criterion (3). Also verify `DryCycleStartEvent` count ≥ 18 (≥ 6 cycles/day × 3 days).

## File-touch list

**Modify:**
- `scripts/sync/email_ingest/task_closure.py`:
  - Add `scan_since()` method to `OpenTask` (no signature change on `fetch_open_tasks`).
  - Add `AdapterError` frozen dataclass.
  - Add `path_b_lookback_days` to `ClosureProfile` with `__post_init__` guard. Update `save_profile`/`load_profile` (load clamps negative with warning).
  - Add `DryConsideredEvent`, `DryEntityMissEvent`, `DrySearchMissEvent`, `DryNeedsContactResolutionEvent`, `DryCycleStartEvent`, `PendingWriteFailedEvent` frozen dataclasses.
  - Add `EntityMissReason` and `SearchMissCause` enums.
  - Change `_gather_candidate_threads` return signature to `tuple[list[ThreadCandidate], list[AdapterError]]`.
  - Update `scan_and_close`: emit `DryCycleStartEvent` first; build `recent_needs_contact` cache from last-24h JSONL scan; per-task event invariant per §4; live-mode kill-switch on JSONL write failure (B1); try/finally around task loop wrapping pending file write (B6).
  - Update `_emit_decision`: emit `DryConsideredEvent` for `Tier.DROP` cases (and reachable via followup cap).
  - Update `_path_a_should_close` signature to take `profile, now` and use `task.scan_since(profile, now)` as floor.
  - Add `lookup_qmd_for_contact` helper (Path B QMD `email` collection one-shot search).
  - Update `_load_contacts_from_claude_md`: warn on both header-missing and Email-column-missing.
  - Wrap `append_jsonl_event` body in try/except (log + increment `write_failure_count`, never raise).
  - Add `publish_closure_candidates_digest` function.
- `scripts/sync/email_ingest/task_closure_trainer.py` — read new event types via dataclass `action` field when filtering JSONL.
- `scripts/sync/email-ingest.py` — invoke `publish_closure_candidates_digest` after `scan_and_close` returns.
- `scripts/sync/tests/test_task_closure.py` — 32 unit tests + 5 integration tests + 2 manual operational checks (see test plan). **Specifically update existing tests at lines 317, 323, 337** that use `fetch_open_tasks(db_path)` positionally — these stay valid (signature unchanged) but should add coverage for the new `scan_since()` method (D5, R5 H7).
- `docs/superpowers/plans/2026-05-06-email-task-closure-tasks.md` — Stage I1 criterion section: redirect to this design's gate criterion.

**Create:**
- `groups/global/state/closure-candidates.json` — atomically written each sync cycle. **Mount scope: main-only** per `/workspace/project` mount (D8).
- `~/.cache/email-ingest/closure-digest-state.json` — tracks `last_publish_ts` for digest dedup window.
- `scripts/migrations/2026-05-14-add-closure-candidates-briefing-section.py` — UPDATE `scheduled_tasks.prompt` for `claire-morning-briefing` with idempotency sentinel + backup; install `closure-pulse` row.
- `scripts/migrations/2026-05-14-rollback.py` — restore backup, remove `closure-pulse`.
- `data/migrations/2026-05-14-briefing-prompt-backup.txt` — backup target.

**Pre-deploy data cleanup (D7):**
- One-time dedup pass on `~/.cache/email-ingest/task-closures.jsonl` to remove phantom `task_id=1` reopened events from the prior test-pollution incident (commit `3ba723f4`). Ship as `scripts/migrations/2026-05-14-cleanup-jsonl-pollution.py`. Run before first new cycle to keep `read_recent_reopens` accurate.

**No changes:**
- `score_candidate`, `assign_tier`, `extract_entities` (entity extraction stays; we just emit telemetry when it whiffs).
- `fetch_open_tasks` signature (subsumed by property approach — A3).
- `src/container-runner.ts` — no new mounts (we use existing `/workspace/project`).
- `src/tasks-ipc.ts` — no IPC changes.

## Gmail API quota note (D6)

`search_threads_since` (`gmail_adapter.py:361`) does 1 list call + up to 25 `threads().get` calls per task = 26 API calls. Per-cycle estimate:
- 21 tasks × ~5 candidates retained (`hits[:5]`) × 1 metadata fetch per candidate × 2 adapter passes ≈ ~210 calls.
- Plus 21 `list` queries.
- Plus `fetch_thread_messages` per surviving candidate (~5 × 21 ≈ 105 calls).
- Total: ~340 API calls per 4h cycle, 5–10x current usage due to 365d window vs 19d.

Gmail quota: 250 units/sec; ~5 units per metadata fetch. ~1700 units/cycle, ~10,200 units/day. Well under 1M/day quota.

**Burst risk:** no exponential backoff on 429 rate-limit. The `_gather_candidate_threads` exception path catches all errors and returns `[]` with an `AdapterError`. Under a Gmail outage, we'll see a wave of `DrySearchMissEvent(cause=adapter_error)` — observable, recoverable. **Follow-up (not blocking I1):** add adapter-level retry-with-backoff in a separate change.

## Open questions

None remaining at design time. All 5 brainstorm decision points and all 3-reviewer findings are addressed inline.

### Brainstorm decisions (user-confirmed)

1. `scan_since` exposed as `@property` method on `OpenTask` (A3 chosen over field approach).
2. `path_b_lookback_days=365` in profile, with `__post_init__` validation.
3. 7 distinct event dataclasses (`DryConsideredEvent`, `DryEntityMissEvent`, `DrySearchMissEvent`, `DryNeedsContactResolutionEvent`, `DryCycleStartEvent`, `PendingWriteFailedEvent`, plus existing `dry-closed`/`dry-suggested`).
4. Stage F surface published to `groups/global/state/closure-candidates.json` + `closure-pulse` proactive 4h-cycle nudge.
5. 4-part gate criterion (liveness + signal + precision + surface) with 14-day fallback decision tree and explicit freeze definition.

### Reviewer findings addressed (R3 silent-failure / R4 type-design / R5 integration-ops)

- **Tier A (load-bearing):** runner-up-gap factored via `Tier.AUTO_CLOSE.value` discriminator (A1); dedup key contradiction resolved by writer using `(task_id, full_name)` (A2); `scan_since` as property method, single source of truth (A3); `DryCycleStartEvent` liveness sentinel added (A4); 7 frozen dataclasses replace prose JSON (A5); `Tier` enum reused instead of parallel naming (A6).
- **Tier B (silent-failure hardening):** live-mode JSONL kill-switch (B1); digest writes error sentinel on failure (B2); briefing fail-loud on digest error (B3); migration script with backup + idempotency sentinel (B4); `report.skipped_count` semantics preserved-but-not-canonical (B5); pending write in try/finally (B6); freeze defined operationally (B7).
- **Tier C (type polish):** `AdapterError` dataclass (C1); profile `__post_init__` guard (C2); `PendingWriteFailedEvent` schema added (C3); enums for `reason`/`cause` (C4); version check contract (C5); profile-as-positional resolved by property approach (C6); `top_addrs=[]` not null (C7); contacts loader checks Email column too (C8).
- **Tier D (operational completeness):** QMD auto-suggest path on `DryNeedsContactResolutionEvent` (D1); `closure-pulse` proactive nudge (D2); `since_last_briefing` + `last_seen` fields, digest state file (D3); test #33 pins scan_since→since flow (D4); test sites at lines 317/323/337 enumerated (D5); Gmail quota note added (D6); pre-deploy JSONL cleanup migration (D7); main-only mount scope documented (D8).
- **Refuted:** followup-cap landing in `Tier.DROP` (R3 H5; spec was correct); Telegram format conflict (R5 H4; spec was internally consistent — defensive comment added).

## References

- `scripts/sync/email_ingest/task_closure.py` — the matcher.
- `scripts/sync/email-ingest.py` — Stage F invocation point.
- `docs/superpowers/specs/2026-05-06-email-task-closure-design.md` — original spec.
- `docs/superpowers/plans/2026-05-06-email-task-closure-tasks.md` — Stage I rollout plan (this design supersedes Task I1's gate criterion).
- Commits: `e1ec1761` (contacts loader fix), `3ba723f4` (test pollution fix).
- Memory: `feedback_silent_failure_wedge`, `feedback_adversarial_reviewer_prompt`.
- Reviewer outputs (2026-05-13): silent-failure-hunter on design + code-reviewer (architecture) + silent-failure-hunter on spec + type-design-analyzer + code-reviewer (integration-ops).
