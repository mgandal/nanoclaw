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

### 1. `OpenTask.scan_since` field at fetch boundary

Add to dataclass at `scripts/sync/email_ingest/task_closure.py:37-48`:

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
    created_at: datetime  # UTC, raw from DB
    scan_since: datetime  # UTC, derived per-source policy (see fetch_open_tasks)
```

In `fetch_open_tasks` (line ~327), compute `scan_since` per row:

```python
def _compute_scan_since(source: str, created_at: datetime, profile: ClosureProfile, now: datetime) -> datetime:
    """Decide how far back to search Gmail/Exchange for matching threads.

    Email-source tasks (Path A primary) use created_at as floor. Path A is
    the dominant code path for those, so this branch is defensive.
    All other sources (migration, manual, scheduled-task) use a fixed lookback
    from now, taken from profile.path_b_lookback_days (default 365).
    """
    if source == "email":
        return created_at
    return now - timedelta(days=profile.path_b_lookback_days)
```

`fetch_open_tasks` takes `profile` and `now` as new parameters; callers pass them in.

**All consumers** read `task.scan_since`:
- `scan_and_close` line 600: `since=task.scan_since`
- `explain_task` line 768: `since=target.scan_since`
- `_path_a_should_close` line 505: `floor = max(cutoff, task.scan_since)` (replaces `task.created_at`)

`_gather_candidate_threads` signature change: returns `tuple[list[ThreadCandidate], list[dict]]` where the second element is a list of `{adapter_name: str, error_message: str}` entries — one per adapter that raised. Callers can now distinguish "no hits" from "search failed". Existing `log.warning` is preserved; we just additionally surface the errors to the caller.

**Rationale (R2 #3):** Policy lives at the SQL boundary, not in the matcher hot path. Adding a new consumer can't forget to apply the policy. `_compute_scan_since` is a single function with one responsibility.

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
```

Update `save_profile` (line 232) and `load_profile` (line 248) to persist/restore the field. Default 365 used on load if absent.

**Rationale (R2 #2):** The trainer (`task_closure_trainer.py`) can later adapt the lookback per-counterparty without code change, mirroring how `thresholds` already lives in profile.

### 3. Event taxonomy — 5 distinct actions

Existing actions retained: `dry-closed`, `dry-suggested`, `closed`, `suggested`, `cooling_off`, `reopened`, `manual-rollback`. Three new actions added (with `dry-` prefix in dry-run mode):

#### `dry-considered`

Emitted whenever the matcher evaluated a top candidate but did NOT close/suggest it. This is the **gate denominator** — the signal for I1 evaluation.

Fires when:
- `_emit_decision` is called with `Tier.DROP`.
- Followup-thread cap at line 630 pushed a real candidate into DROP.
- Path A's `_path_a_should_close` returned `(False, "", addrs)`.

Schema:

```json
{
  "ts": "2026-05-14T11:30:00Z",
  "action": "dry-considered",
  "task_id": 4,
  "task_title": "Follow up with Lucinda: 10X PO...",
  "top_thread_ref": "gmail:18c4...",
  "top_subject": "Re: 10X PO status",
  "top_score": 0.62,
  "top_addrs": ["lucinda.bertsinger@pennmedicine.upenn.edu"],
  "runner_up_score": 0.41,
  "match_strength": 0.8,
  "rule": "retroactive_full_name_match",
  "candidates_considered": 3,
  "would_close_if_threshold": "auto",
  "reasoning": "Top score 0.62 below auto_close=0.75. User-sent 2, counterparty-replied 1."
}
```

`would_close_if_threshold` ∈ `{auto, suggest, never}`:
- `auto` — top_score ≥ auto_close threshold (would have auto-closed at prod settings).
- `suggest` — top_score ≥ suggest threshold but < auto_close.
- `never` — top_score < suggest threshold.

#### `dry-entity-miss`

Emitted when Path B reached entity extraction but `entities.contact_keys` is empty AND `entities.emails` is empty. The matcher couldn't identify any addresses to search.

Schema:

```json
{
  "ts": "...",
  "action": "dry-entity-miss",
  "task_id": 3,
  "task_title": "Reach out to Joe Buxbaum re: ASD cohort",
  "unknown_full_names": [["Joe", "Buxbaum"]],
  "project_codes": [],
  "reason": "no_contact_keys_or_emails"
}
```

#### `dry-search-miss`

Emitted when the search adapter returned empty hits OR raised an exception. Distinguishes "no thread activity" from "adapter failure".

Schema:

```json
{
  "ts": "...",
  "action": "dry-search-miss",
  "task_id": 4,
  "task_title": "Follow up with Lucinda...",
  "addrs_queried": ["lucinda.bertsinger@pennmedicine.upenn.edu"],
  "cause": "empty_hits",      // or "adapter_error", or "adapter_unknown_for_source"
  "adapters_tried": ["gmail"],
  "error_message": null        // populated only when cause=adapter_error
}
```

Three causes:
- `empty_hits` — adapter returned `[]` cleanly.
- `adapter_error` — adapter raised; `error_message` carries the exception string.
- `adapter_unknown_for_source` — Path A had `source_ref = "<unknown_src>:..."` and no adapter matched (line 562-563).

#### `dry-needs-contact-resolution`

Emitted independently when `entities.unknown_full_names` is non-empty. Fires alongside `dry-entity-miss` (when both apply); briefing surface deduplicates by `full_name` at display time. Not emitted if `entities.contact_keys` resolved at least one contact (signals that extraction is partially working).

Schema:

```json
{
  "ts": "...",
  "action": "dry-needs-contact-resolution",
  "task_id": 3,
  "task_title": "Reach out to Joe Buxbaum re: ASD cohort",
  "full_name": "Joe Buxbaum",
  "suggested_action": "add to groups/global/state/USER.md"
}
```

One event per unknown name per scan cycle. No state-file dedup; the briefing-surface layer dedupes by `(task_id, full_name)` within its display window.

### 4. Per-task event invariant

After this change, every task examined in `scan_and_close` emits **at least one event per cycle**. The decision tree:

```
For each open task in scan_and_close:
  if task.id in cooling_off:
    emit cooling_off
    continue

  # Path A
  if task.source == "email" and task.source_ref:
    parse src,tid
    if adapter is None:
      emit dry-search-miss(cause=adapter_unknown_for_source)
      continue
    try:
      thread_msgs = fetch_thread_messages
    except:
      emit dry-search-miss(cause=adapter_error, error_message=str(e))
      continue
    should_close, reasoning, addrs = _path_a_should_close
    if not should_close:
      emit dry-considered(top_score=0, would_close_if_threshold=never, reasoning=...)
      continue
    -> _emit_decision (existing: dry-closed or dry-suggested if cap-exceeded)

  # Path B
  entities = extract_entities
  if entities.unknown_full_names:
    for name in unknown_full_names:
      emit dry-needs-contact-resolution
  if not entities.contact_keys and not entities.emails:
    emit dry-entity-miss
    continue
  # _gather_candidate_threads returns (candidates, adapter_errors)
  # where adapter_errors is a list of {adapter_name: str, error_message: str}
  candidates, adapter_errors = _gather_candidate_threads(since=task.scan_since)
  if not candidates:
    if adapter_errors:
      emit dry-search-miss(cause=adapter_error, error_message=adapter_errors[0]["error_message"], adapters_tried=[e["adapter_name"] for e in adapter_errors])
    else:
      emit dry-search-miss(cause=empty_hits, adapters_tried=["gmail", "exchange"])
    continue
  # ... existing scoring loop ...
  # _emit_decision now emits dry-considered for DROP tier
```

**Invariant:** for any task examined, exactly one of `{cooling_off, dry-closed, dry-suggested, dry-considered, dry-entity-miss, dry-search-miss}` is emitted per cycle. `dry-needs-contact-resolution` is an independent track and may co-occur with `dry-entity-miss`.

### 5. Error guards on event emission

`append_jsonl_event` (line 271) wrapped in try/except. On failure (disk-full, permission, lock-timeout), `log.warning` + increment a new `report.write_failure_count` field; never raise. Caller's loop continues.

Pending file write (lines 670-678) wrapped in try/except. On failure, log.warning + append a `pending_write_failed` event to JSONL (best-effort; double-failure is logged but tolerated). Decisions already committed to DB are not rolled back; the next cycle will rewrite pending.

### 6. Contacts loader sanity check

`_load_contacts_from_claude_md` (line 853) — if file exists but no `| Name ` table header found, `log.warning("contacts: %s has no contacts table; entity extraction will degrade", path)`. Distinguishes parse-failure from empty-file-by-design.

### 7. Stage F: morning briefing surface

#### Host-side: publish closure-candidates digest

After `scan_and_close` returns in `email-ingest.py` (line ~344), publish a digest to `groups/global/state/closure-candidates.json`:

```python
publish_closure_candidates_digest(
    pending_path=PENDING_PATH,
    jsonl_path=JSONL_PATH,
    digest_path=Path("/Users/mgandal/Agents/nanoclaw/groups/global/state/closure-candidates.json"),
    lookback_hours=24,
)
```

The digest function:
1. Reads `task-closures-pending.json` → `pending_items`.
2. Scans last 24h of JSONL for `dry-needs-contact-resolution` events; deduplicates by `full_name` (keeps the most recent occurrence per name).
3. Writes atomically (tmp+rename) to digest_path:

```json
{
  "version": 1,
  "generated_at": "2026-05-14T11:30:00Z",
  "pending_items": [ /* same shape as task-closures-pending.json items */ ],
  "needs_contact_resolution": [
    {
      "full_name": "Joe Buxbaum",
      "task_id": 3,
      "task_title": "Reach out to Joe Buxbaum re: ASD cohort",
      "last_seen": "2026-05-14T11:30:00Z"
    }
  ]
}
```

#### Container-side: briefing prompt update

Modify the `claire-morning-briefing` row in `scheduled_tasks.prompt`. Add to STEP 1:

```
- Closure candidates: read /workspace/project/groups/global/state/closure-candidates.json. Parse pending_items[] and needs_contact_resolution[].
```

Add new section between "📋 Follow-ups" and "💬 Slack":

```
🔔 *Closure candidates* (only if pending_items or needs_contact_resolution non-empty)

[For each pending_item:]
• [task_title] → matched "[top_subject]" (score [top_score])
  Reply "close [task_id]" to confirm, "reopen [task_id]" if wrong.

[If needs_contact_resolution non-empty:]
*Unknown contacts to add to USER.md*
• [full_name] — referenced in task #[task_id] "[task_title]"
```

Omit section entirely if both are empty.

### 8. I1→I2 advance gate (reformulated)

The original criterion in `docs/superpowers/plans/2026-05-06-email-task-closure-tasks.md:2661` is replaced by the following 3-part criterion. **All three must be satisfied to advance to I2.**

1. **Signal volume:** ≥ 10 events with `action=dry-considered` AND `would_close_if_threshold=auto` accumulate in `~/.cache/email-ingest/task-closures.jsonl` over ≥ 3 days.

2. **Near-miss precision:** User-conducted review (Mike inspects each event in #1, optionally using `task_closure.py --explain <task_id>`) shows ≤ 20% of those events would have been wrong auto-closures. "Wrong" = matched thread is unrelated, or the task is still genuinely open after the matched activity, or the activity-window guard would have produced a spurious close.

3. **Briefing surface verification:** At least one `🔔 Closure candidates` section has appeared in a morning-briefing Telegram message during I1, with either pending_items or needs_contact_resolution non-empty. Confirms end-to-end Stage F path is live.

#### 14-day fallback decision tree

Clock starts when the new matcher code is deployed and the first sync cycle has completed (i.e., the first cycle where new event types could appear in JSONL). At 14 days from that point:

| Condition | Action |
|---|---|
| All 3 criteria met | Advance to I2 (Task I2 in original plan). |
| (1) < 10 + ≥ 5 new contacts added to USER.md during I1 | Extend I1 by 7 more days (contacts table growing → matcher recall improving). |
| (1) < 10 + < 5 new contacts added | Freeze I1. File separate brainstorming task: "Contacts-table-coverage is the upstream blocker for email-task-closure recall." Do not advance until coverage improves. |
| (1) ≥ 10 but (2) fails | Freeze I1. Investigate scoring weights or threshold calibration. Defer I2. |
| (1) ≥ 10 and (2) ok, but (3) fails | Investigate Stage F surface; briefing-surface may have broken. Fix and re-check. |

### 9. Telemetry stewardship — JSONL growth

`read_recent_reopens` (line 285-315) scans the full JSONL. With the new event volume estimate:

- 21 tasks × 6 cycles/day × (1 verdict event + up to 5 needs-contact-resolution) ≈ 750 events/day worst-case.
- Steady-state once contacts table fills out ≈ 200 events/day (mostly dry-considered + dry-search-miss).
- 7-day cooling-off window scans 5,250 events worst-case. At 200 bytes/event ≈ 1MB. Fine for now.

**Future work (out of scope for this fix):** add monthly JSONL rotation (mv to `task-closures.jsonl.YYYY-MM`) when file exceeds 10MB. Trainer reads all rotated files via `glob`. Not blocking I1→I2.

## Test plan

### Unit tests in `scripts/sync/tests/test_task_closure.py`

1. **`test_scan_since_email_source_uses_created_at`** — Build `OpenTask` with `source='email'`, `created_at=2026-04-01`. `fetch_open_tasks` should populate `scan_since=2026-04-01`.
2. **`test_scan_since_migration_uses_profile_lookback`** — `source='migration-2026-04-23'`, `now=2026-05-13`, `profile.path_b_lookback_days=365`. `scan_since` should equal `2025-05-13`.
3. **`test_scan_since_manual_uses_profile_lookback`** — Same as above but `source='manual'`.
4. **`test_profile_load_default_lookback`** — Profile JSON without `path_b_lookback_days` field loads with 365 default.
5. **`test_profile_save_load_roundtrip_with_lookback`** — Set lookback=180, save+load, value preserved.
6. **`test_dry_entity_miss_event_emitted`** — Task whose extraction yields no contact_keys and no emails. Verify exactly one `dry-entity-miss` event in JSONL with correct schema. Also verify `dry-needs-contact-resolution` co-emitted per unknown name.
7. **`test_dry_search_miss_empty_hits`** — Mock adapter returning `[]`. Verify `dry-search-miss(cause=empty_hits)`.
8. **`test_dry_search_miss_adapter_error`** — Mock adapter raising. Verify `dry-search-miss(cause=adapter_error)` with `error_message` populated.
9. **`test_dry_considered_drop_tier`** — Mock candidate with score 0.4 (below suggest=0.55). Verify `dry-considered` event with `would_close_if_threshold=never`.
10. **`test_dry_considered_above_auto`** — Mock candidate with score 0.85. Verify normal `dry-closed` emitted (NOT `dry-considered`) and `report.closed_count==1` in dry-run mode (but DB not mutated).
11. **`test_dry_considered_followup_clip`** — Mock candidate with raw_score 0.8 but `open_followup_threads` contains its thread_ref. Score clipped to suggest-0.001. Verify `dry-considered` event with `would_close_if_threshold=auto` AND reasoning notes the clip.
12. **`test_path_a_should_close_false_emits_dry_considered`** — Mock Path A with no relevant messages in window. Verify `dry-considered(top_score=0, would_close_if_threshold=never)`.
13. **`test_path_a_floor_uses_scan_since`** — Task with `source='email'`, `created_at=2026-04-01`, message at 2026-03-15 (before created_at). With activity-window cutoff at 90d from now (2026-02-12), `floor = max(2026-02-12, 2026-04-01) = 2026-04-01`. Message excluded.
14. **`test_path_a_floor_uses_scan_since_migration_case`** — Hypothetical: backfilled task with `source='email'` but `scan_since` set explicitly to `now-365d`. `floor = max(cutoff, scan_since)`. Activity in last year included.
15. **`test_append_jsonl_event_disk_full_does_not_raise`** — Mock `fp.write` raising OSError(ENOSPC). Verify `report.write_failure_count==1` and no exception propagated.
16. **`test_pending_write_failure_logged_not_raised`** — Mock `tmp.replace` raising. Verify `pending_write_failed` event in JSONL and `report` returned cleanly.
17. **`test_contacts_loader_no_table_warns`** — USER.md with no `| Name ` table header. Returns `{}` AND emits log.warning (assert via caplog).
18. **`test_per_task_event_invariant`** — Inject 5 tasks into a fresh JSONL: cooling_off, dry-entity-miss, dry-search-miss, dry-considered, dry-closed (auto). Verify exactly 5 verdict events + N needs-contact events.

### Integration tests

19. **`test_explain_uses_scan_since`** — `--explain <task_id>` on a migration task. Verify candidates list is non-empty if Gmail mock has matching threads in the 365d window.
20. **`test_publish_closure_candidates_digest`** — JSONL with 3 `dry-needs-contact-resolution` events (2 for "Joe Buxbaum", 1 for "Jane Doe") + pending.json with 1 item. Digest should have 1 pending_item + 2 needs_contact_resolution entries (deduped, most-recent kept).
21. **`test_gather_candidate_threads_returns_errors`** — Mock gmail adapter raising, exchange adapter returning `[]`. Verify return value is `([], [{adapter_name: "gmail", error_message: "<exception str>"}])`.

### Manual/operational tests

22. **End-to-end Stage F surface:** after deploying, force a sync cycle (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw.sync`), then trigger a morning briefing manually. Verify the `🔔 Closure candidates` section appears with at least one entry from the 9 `unknown_only` tasks (Joe Buxbaum likely surfaces).

23. **Gate re-evaluation:** 3 days after deploy, count `dry-considered` events with `would_close_if_threshold=auto`. If ≥ 10, perform manual review per criterion (2).

## File-touch list

**Modify:**
- `scripts/sync/email_ingest/task_closure.py` — OpenTask field, `_compute_scan_since`, `fetch_open_tasks` signature, all `since=task.created_at` → `task.scan_since`, `_path_a_should_close` floor, event emissions throughout `scan_and_close` + `_emit_decision`, error guards on `append_jsonl_event` and pending write, contacts loader warning, `publish_closure_candidates_digest` helper.
- `scripts/sync/email_ingest/task_closure_trainer.py` — read new event actions when filtering JSONL.
- `scripts/sync/email-ingest.py` — invoke `publish_closure_candidates_digest` after `scan_and_close` returns.
- `scripts/sync/tests/test_task_closure.py` — 22 new tests (see test plan).
- `store/messages.db::scheduled_tasks` — UPDATE `claire-morning-briefing` prompt to add closure-candidates STEP 1 read + section between Follow-ups and Slack.
- `docs/superpowers/plans/2026-05-06-email-task-closure-tasks.md` — Stage I1 criterion section: redirect to this design's gate criterion.

**Create:**
- `groups/global/state/closure-candidates.json` — atomically written each sync cycle.

**No changes:**
- `score_candidate`, `assign_tier`, `extract_entities` (entity extraction stays; we just emit telemetry when it whiffs).
- `src/container-runner.ts` — no new mounts (we use existing `/workspace/project`).
- `src/tasks-ipc.ts` — no IPC changes.

## Open questions

None remaining; all 5 decision points resolved via reviewer-guided brainstorming. The user-confirmed decisions are:

1. `scan_since` on `OpenTask` populated by `fetch_open_tasks`.
2. `path_b_lookback_days=365` in profile.
3. 5 distinct event actions (`dry-considered`, `dry-entity-miss`, `dry-search-miss`, `dry-needs-contact-resolution`, plus existing `dry-closed`/`dry-suggested`).
4. Stage F surface published to `groups/global/state/closure-candidates.json`.
5. 3-part gate criterion with 14-day fallback decision tree.

## References

- `scripts/sync/email_ingest/task_closure.py` — the matcher.
- `docs/superpowers/specs/2026-05-06-email-task-closure-design.md` — original spec.
- `docs/superpowers/plans/2026-05-06-email-task-closure-tasks.md` — Stage I rollout plan (this design supersedes Task I1's gate criterion).
- Commits: `e1ec1761` (contacts loader fix), `3ba723f4` (test pollution fix).
- Memory: `feedback_silent_failure_wedge`, `feedback_adversarial_reviewer_prompt`.
- Reviewer outputs: silent-failure-hunter audit + code-reviewer architectural audit (both 2026-05-13).
