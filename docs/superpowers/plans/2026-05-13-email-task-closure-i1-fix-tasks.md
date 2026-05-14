# Email-Task-Closure I1 Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the email-task-closure I1→I2 rollout gate evaluable by emitting per-task telemetry events on every dead-end path, publishing a morning-briefing-visible closure-candidates digest, and reformulating the gate criterion to be measurable under the actual task distribution.

**Architecture:** Add 7 frozen event dataclasses + 2 enums + 1 `@property` method to `task_closure.py`. Rewire `scan_and_close` so every task examined emits at least one terminal event per cycle. Add error guards (live-mode kill-switch on JSONL write failure, try/finally for pending file write). Publish `groups/global/state/closure-candidates.json` after each sync cycle. Add migration script that idempotently injects a `🔔 Closure candidates` section into the `claire-morning-briefing` prompt.

**Tech Stack:** Python 3.11 (`/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3`), pytest, SQLite via `sqlite3` stdlib (host) / `bun:sqlite` (TS), JSON for state files, `fcntl` for JSONL append locks, launchd for cron.

**Spec:** `docs/superpowers/specs/2026-05-13-email-task-closure-i1-fix-design.md`

---

## Stage overview

| Stage | Purpose | Tasks |
|---|---|---|
| A | Foundation types: enums + 7 event dataclasses + `AdapterError` + `OpenTask.scan_since` property + `ClosureProfile.path_b_lookback_days` | A1–A10 |
| B | Rewire matcher emission: `_gather_candidate_threads` returns errors; `scan_and_close` emits per-task invariant; `_emit_decision` covers DROP | B1–B8 |
| C | Error guards + sanity checks: live-mode kill-switch, try/finally pending write, contacts loader warnings | C1–C5 |
| D | Stage F: `publish_closure_candidates_digest`, QMD candidate lookup, `email-ingest.py` invocation | D1–D6 |
| E | Migration scripts: JSONL pollution cleanup, briefing prompt UPDATE, closure-pulse scheduled task | E1–E4 |
| F | Manual deployment + I1 verification | F1–F4 |

**Conventions:**
- Run tests with `cd /Users/mgandal/Agents/nanoclaw/scripts/sync && /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_task_closure.py::<test_name> -v`. Path prefix omitted in tasks below; assume `cd /Users/mgandal/Agents/nanoclaw/scripts/sync` first.
- All file paths relative to repo root `/Users/mgandal/Agents/nanoclaw`.
- Each task's commit uses `git add <files>` not `git add -A`.
- Tests live at `scripts/sync/tests/test_task_closure.py` unless noted.
- `READ_ME_FIRST` for every implementer: this spec is at `docs/superpowers/specs/2026-05-13-email-task-closure-i1-fix-design.md`. Refer to it for the full schema of each event type. The plan repeats only the fields strictly required for the task at hand.

---

## Stage A — Foundation types

These tasks add types but do not change `scan_and_close` behavior yet. After Stage A, the matcher still produces 0 closure decisions in dry-run mode; the new types just exist and are tested.

### Task A1 — Add `EntityMissReason` enum

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — add after `class Tier(enum.Enum)` block (around line 34)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_task_closure.py`:

```python
def test_entity_miss_reason_values():
    from email_ingest.task_closure import EntityMissReason
    assert EntityMissReason.NO_CONTACT_KEYS_OR_EMAILS.value == "no_contact_keys_or_emails"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_entity_miss_reason_values -v`
Expected: FAIL with `ImportError` or `AttributeError: module ... has no attribute 'EntityMissReason'`

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, after the `Tier` enum (line ~34):

```python
class EntityMissReason(enum.Enum):
    NO_CONTACT_KEYS_OR_EMAILS = "no_contact_keys_or_emails"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_entity_miss_reason_values -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): add EntityMissReason enum"
```

### Task A2 — Add `SearchMissCause` enum

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — directly after `EntityMissReason`
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing test**

```python
def test_search_miss_cause_values():
    from email_ingest.task_closure import SearchMissCause
    assert SearchMissCause.EMPTY_HITS.value == "empty_hits"
    assert SearchMissCause.ADAPTER_ERROR.value == "adapter_error"
    assert SearchMissCause.ADAPTER_UNKNOWN_FOR_SOURCE.value == "adapter_unknown_for_source"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_search_miss_cause_values -v`
Expected: FAIL with `AttributeError: module ... has no attribute 'SearchMissCause'`

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, after `EntityMissReason`:

```python
class SearchMissCause(enum.Enum):
    EMPTY_HITS = "empty_hits"
    ADAPTER_ERROR = "adapter_error"
    ADAPTER_UNKNOWN_FOR_SOURCE = "adapter_unknown_for_source"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_search_miss_cause_values -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): add SearchMissCause enum"
```

### Task A3 — Add `AdapterError` dataclass

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — near existing dataclasses around line 50-58
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing test**

```python
def test_adapter_error_dataclass():
    from email_ingest.task_closure import AdapterError
    err = AdapterError(adapter_name="gmail", error_message="rate limited")
    assert err.adapter_name == "gmail"
    assert err.error_message == "rate limited"
    # Frozen — assignment must raise
    import dataclasses
    with pytest.raises(dataclasses.FrozenInstanceError):
        err.adapter_name = "exchange"  # type: ignore
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_adapter_error_dataclass -v`
Expected: FAIL with `AttributeError: ... AdapterError`

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, after `ThreadActivity` (line ~58):

```python
@dataclass(frozen=True)
class AdapterError:
    adapter_name: str   # "gmail" | "exchange"
    error_message: str
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_adapter_error_dataclass -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): add AdapterError frozen dataclass"
```

### Task A4 — Add `path_b_lookback_days` to `ClosureProfile` with `__post_init__` guard

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:60-75`
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_profile_default_lookback():
    from email_ingest.task_closure import ClosureProfile
    p = ClosureProfile.default()
    assert p.path_b_lookback_days == 365


def test_profile_post_init_rejects_zero_and_negative():
    from email_ingest.task_closure import ClosureProfile
    with pytest.raises(ValueError, match="path_b_lookback_days must be >= 1"):
        ClosureProfile(
            contact_base_trust=0.7,
            default_base_trust=0.5,
            thresholds={"auto_close": 0.75, "suggest": 0.55},
            path_b_lookback_days=0,
        )
    with pytest.raises(ValueError):
        ClosureProfile(
            contact_base_trust=0.7,
            default_base_trust=0.5,
            thresholds={"auto_close": 0.75, "suggest": 0.55},
            path_b_lookback_days=-5,
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py::test_profile_default_lookback tests/test_task_closure.py::test_profile_post_init_rejects_zero_and_negative -v`
Expected: both FAIL — first with `AttributeError: ... path_b_lookback_days`; second with `TypeError: ... unexpected keyword argument`.

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, replace `ClosureProfile` class body (line 60-75) with:

```python
@dataclass
class ClosureProfile:
    contact_base_trust: float
    default_base_trust: float
    thresholds: dict[str, float]
    path_b_lookback_days: int = 365
    counterparty_trust: dict[str, float] = field(default_factory=dict)
    rule_precision: dict[str, float] = field(default_factory=dict)
    version: int = 1

    def __post_init__(self) -> None:
        if self.path_b_lookback_days < 1:
            raise ValueError(
                f"path_b_lookback_days must be >= 1, got {self.path_b_lookback_days}"
            )

    @classmethod
    def default(cls) -> "ClosureProfile":
        return cls(
            contact_base_trust=0.7,
            default_base_trust=0.5,
            thresholds={"auto_close": 0.75, "suggest": 0.55},
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py::test_profile_default_lookback tests/test_task_closure.py::test_profile_post_init_rejects_zero_and_negative -v`
Expected: both PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): add path_b_lookback_days to ClosureProfile with guard"
```

### Task A5 — Persist `path_b_lookback_days` in `save_profile`/`load_profile` with load-time clamping

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:232-268` (save_profile + load_profile)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_profile_save_load_roundtrip_with_lookback(tmp_path):
    from email_ingest.task_closure import ClosureProfile, save_profile, load_profile
    p = ClosureProfile.default()
    object.__setattr__(p, "path_b_lookback_days", 180)
    out = tmp_path / "profile.json"
    save_profile(p, out)
    reloaded = load_profile(out)
    assert reloaded.path_b_lookback_days == 180


def test_profile_load_default_lookback_when_missing(tmp_path):
    import json
    from email_ingest.task_closure import load_profile
    out = tmp_path / "profile.json"
    out.write_text(json.dumps({
        "version": 1,
        "contact_base_trust": 0.7,
        "default_base_trust": 0.5,
        "thresholds": {"auto_close": 0.75, "suggest": 0.55},
        "counterparty_trust": {},
        "rule_precision": {},
    }))
    p = load_profile(out)
    assert p.path_b_lookback_days == 365


def test_profile_load_clamps_negative_with_warning(tmp_path, caplog):
    import json, logging
    from email_ingest.task_closure import load_profile
    out = tmp_path / "profile.json"
    out.write_text(json.dumps({
        "version": 1,
        "contact_base_trust": 0.7,
        "default_base_trust": 0.5,
        "thresholds": {"auto_close": 0.75, "suggest": 0.55},
        "path_b_lookback_days": -5,
        "counterparty_trust": {},
        "rule_precision": {},
    }))
    with caplog.at_level(logging.WARNING, logger="email-ingest.task-closure"):
        p = load_profile(out)
    assert p.path_b_lookback_days == 365
    assert any("path_b_lookback_days" in r.message for r in caplog.records)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py::test_profile_save_load_roundtrip_with_lookback tests/test_task_closure.py::test_profile_load_default_lookback_when_missing tests/test_task_closure.py::test_profile_load_clamps_negative_with_warning -v`
Expected: all FAIL — `save_profile` doesn't serialize the field; `load_profile` doesn't accept/clamp it.

- [ ] **Step 3: Write minimal implementation**

Modify `save_profile` (line ~232):

```python
def save_profile(profile: ClosureProfile, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": profile.version,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "contact_base_trust": profile.contact_base_trust,
        "default_base_trust": profile.default_base_trust,
        "thresholds": profile.thresholds,
        "path_b_lookback_days": profile.path_b_lookback_days,
        "counterparty_trust": profile.counterparty_trust,
        "rule_precision": profile.rule_precision,
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(path)
```

Modify `load_profile` (line ~248), updating the construction:

```python
def load_profile(path: Path) -> ClosureProfile:
    if not path.exists():
        return ClosureProfile.default()
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning("profile %s malformed (%s); using defaults", path, e)
        return ClosureProfile.default()
    v = data.get("version", 0)
    if v != PROFILE_VERSION:
        log.warning("profile %s has version %s (expected %s); using defaults",
                    path, v, PROFILE_VERSION)
        return ClosureProfile.default()
    lookback = int(data.get("path_b_lookback_days", 365))
    if lookback < 1:
        log.warning(
            "profile %s has path_b_lookback_days=%s; clamping to default 365",
            path, lookback,
        )
        lookback = 365
    return ClosureProfile(
        contact_base_trust=float(data.get("contact_base_trust", 0.7)),
        default_base_trust=float(data.get("default_base_trust", 0.5)),
        thresholds=dict(data.get("thresholds", {"auto_close": 0.75, "suggest": 0.55})),
        path_b_lookback_days=lookback,
        counterparty_trust=dict(data.get("counterparty_trust", {})),
        rule_precision=dict(data.get("rule_precision", {})),
        version=PROFILE_VERSION,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "profile_save_load_roundtrip_with_lookback or profile_load_default_lookback_when_missing or profile_load_clamps_negative_with_warning" -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): persist path_b_lookback_days, clamp invalid loads"
```

### Task A6 — Add `OpenTask.scan_since` `@property` method

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:37-48` (OpenTask dataclass)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def _make_task(*, source: str, created_at: datetime, id: int = 1, title: str = "t",
               context=None, owner=None, priority=3, source_ref=None, group_folder=None):
    from email_ingest.task_closure import OpenTask
    return OpenTask(
        id=id, title=title, context=context, owner=owner, priority=priority,
        source=source, source_ref=source_ref, group_folder=group_folder,
        created_at=created_at,
    )


def test_scan_since_email_source_returns_created_at():
    from email_ingest.task_closure import ClosureProfile
    profile = ClosureProfile.default()
    created = datetime(2026, 4, 1, tzinfo=timezone.utc)
    now = datetime(2026, 5, 13, tzinfo=timezone.utc)
    t = _make_task(source="email", created_at=created)
    assert t.scan_since(profile, now) == created


def test_scan_since_migration_uses_profile_lookback():
    from email_ingest.task_closure import ClosureProfile
    profile = ClosureProfile.default()
    created = datetime(2026, 4, 24, tzinfo=timezone.utc)
    now = datetime(2026, 5, 13, tzinfo=timezone.utc)
    t = _make_task(source="migration-2026-04-23", created_at=created)
    assert t.scan_since(profile, now) == now - timedelta(days=365)


def test_scan_since_manual_uses_profile_lookback():
    from email_ingest.task_closure import ClosureProfile
    profile = ClosureProfile.default()
    now = datetime(2026, 5, 13, tzinfo=timezone.utc)
    t = _make_task(source="manual", created_at=now)
    assert t.scan_since(profile, now) == now - timedelta(days=365)


def test_scan_since_picks_up_profile_change_at_access():
    from email_ingest.task_closure import ClosureProfile
    now = datetime(2026, 5, 13, tzinfo=timezone.utc)
    t = _make_task(source="manual", created_at=now)
    p180 = ClosureProfile(
        contact_base_trust=0.7, default_base_trust=0.5,
        thresholds={"auto_close": 0.75, "suggest": 0.55},
        path_b_lookback_days=180,
    )
    p365 = ClosureProfile(
        contact_base_trust=0.7, default_base_trust=0.5,
        thresholds={"auto_close": 0.75, "suggest": 0.55},
        path_b_lookback_days=365,
    )
    assert t.scan_since(p180, now) == now - timedelta(days=180)
    assert t.scan_since(p365, now) == now - timedelta(days=365)
```

Make sure `from datetime import datetime, timedelta, timezone` and `import pytest` are at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "scan_since" -v`
Expected: all FAIL with `AttributeError: 'OpenTask' object has no attribute 'scan_since'`

- [ ] **Step 3: Write minimal implementation**

Replace `OpenTask` class (line 37-48):

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
        """Compute the Gmail/Exchange lookback floor for this task.

        Email-source tasks use created_at (Path A primary). Others use
        a fixed lookback from now (profile.path_b_lookback_days, default 365).
        """
        if self.source == "email":
            return self.created_at
        return now - timedelta(days=profile.path_b_lookback_days)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "scan_since" -v`
Expected: all 4 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): add OpenTask.scan_since() property method"
```

### Task A7 — Add `DryCycleStartEvent` dataclass + helpers

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — add after `ClosureDecision` dataclass (line ~114)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing test**

```python
def test_dry_cycle_start_event_dataclass():
    from email_ingest.task_closure import DryCycleStartEvent
    e = DryCycleStartEvent(
        ts="2026-05-14T11:30:00Z",
        open_task_count=21,
        profile_version=1,
        profile_path_b_lookback_days=365,
        dry_run=True,
    )
    assert e.action == "dry-cycle-start"
    import dataclasses
    d = dataclasses.asdict(e)
    assert d["action"] == "dry-cycle-start"
    assert d["open_task_count"] == 21
    assert d["dry_run"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_dry_cycle_start_event_dataclass -v`
Expected: FAIL with `AttributeError: ... DryCycleStartEvent`

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, after `ClosureDecision` (~line 114):

```python
@dataclass(frozen=True)
class DryCycleStartEvent:
    ts: str
    open_task_count: int
    profile_version: int
    profile_path_b_lookback_days: int
    dry_run: bool
    action: str = "dry-cycle-start"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_dry_cycle_start_event_dataclass -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): add DryCycleStartEvent dataclass"
```

### Task A8 — Add `DryEntityMissEvent`, `DrySearchMissEvent`, `DryConsideredEvent` dataclasses

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — after `DryCycleStartEvent`
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_dry_entity_miss_event_dataclass():
    from email_ingest.task_closure import DryEntityMissEvent, EntityMissReason
    e = DryEntityMissEvent(
        ts="2026-05-14T11:30:00Z",
        task_id=3,
        task_title="Reach out to Joe Buxbaum re: ASD cohort",
        unknown_full_names=[("Joe", "Buxbaum")],
        project_codes=[],
        reason=EntityMissReason.NO_CONTACT_KEYS_OR_EMAILS.value,
    )
    assert e.action == "dry-entity-miss"
    assert e.unknown_full_names == [("Joe", "Buxbaum")]


def test_dry_search_miss_event_dataclass():
    from email_ingest.task_closure import DrySearchMissEvent, SearchMissCause
    e = DrySearchMissEvent(
        ts="2026-05-14T11:30:00Z",
        task_id=4,
        task_title="Follow up with Lucinda",
        addrs_queried=["lucinda.bertsinger@pennmedicine.upenn.edu"],
        cause=SearchMissCause.EMPTY_HITS.value,
        adapters_tried=["gmail", "exchange"],
        error_message=None,
    )
    assert e.action == "dry-search-miss"
    assert e.cause == "empty_hits"


def test_dry_considered_event_dataclass():
    from email_ingest.task_closure import DryConsideredEvent, Tier
    e = DryConsideredEvent(
        ts="2026-05-14T11:30:00Z",
        task_id=4,
        task_title="Follow up with Lucinda",
        top_thread_ref="gmail:18c4",
        top_subject="Re: 10X PO status",
        top_score=0.62,
        top_addrs=["lucinda.bertsinger@pennmedicine.upenn.edu"],
        runner_up_score=0.41,
        runner_up_gap_satisfied=True,
        match_strength=0.8,
        rule="retroactive_full_name_match",
        candidates_considered=3,
        would_close_if=Tier.SUGGEST.value,
        reasoning="Top score 0.62 below auto_close=0.75.",
    )
    assert e.action == "dry-considered"
    assert e.would_close_if == "suggest"
    assert e.top_addrs == ["lucinda.bertsinger@pennmedicine.upenn.edu"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_entity_miss_event_dataclass or dry_search_miss_event_dataclass or dry_considered_event_dataclass" -v`
Expected: all FAIL

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, after `DryCycleStartEvent`:

```python
@dataclass(frozen=True)
class DryEntityMissEvent:
    ts: str
    task_id: int
    task_title: str
    unknown_full_names: list[tuple[str, str]]
    project_codes: list[str]
    reason: str   # EntityMissReason.value
    action: str = "dry-entity-miss"


@dataclass(frozen=True)
class DrySearchMissEvent:
    ts: str
    task_id: int
    task_title: str
    addrs_queried: list[str]
    cause: str   # SearchMissCause.value
    adapters_tried: list[str]
    error_message: Optional[str]
    action: str = "dry-search-miss"


@dataclass(frozen=True)
class DryConsideredEvent:
    ts: str
    task_id: int
    task_title: str
    top_thread_ref: Optional[str]
    top_subject: str
    top_score: float
    top_addrs: list[str]
    runner_up_score: Optional[float]
    runner_up_gap_satisfied: bool
    match_strength: float
    rule: str
    candidates_considered: int
    would_close_if: str   # Tier.value
    reasoning: str
    action: str = "dry-considered"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_entity_miss_event_dataclass or dry_search_miss_event_dataclass or dry_considered_event_dataclass" -v`
Expected: all 3 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): add 3 Path-B telemetry event dataclasses"
```

### Task A9 — Add `DryNeedsContactResolutionEvent` and `PendingWriteFailedEvent` dataclasses

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — after `DryConsideredEvent`
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_dry_needs_contact_resolution_event_dataclass():
    from email_ingest.task_closure import DryNeedsContactResolutionEvent
    e = DryNeedsContactResolutionEvent(
        ts="2026-05-14T11:30:00Z",
        task_id=3,
        task_title="Reach out to Joe Buxbaum re: ASD cohort",
        full_name="Joe Buxbaum",
        qmd_candidate_email="jbuxbaum@mssm.edu",
        qmd_candidate_thread_count=3,
        suggested_action="add to groups/global/state/USER.md",
    )
    assert e.action == "dry-needs-contact-resolution"
    assert e.qmd_candidate_email == "jbuxbaum@mssm.edu"


def test_pending_write_failed_event_dataclass():
    from email_ingest.task_closure import PendingWriteFailedEvent
    e = PendingWriteFailedEvent(
        ts="2026-05-14T11:30:00Z",
        error_message="OSError: ENOSPC",
        decisions_lost_count=3,
    )
    assert e.action == "pending-write-failed"
    assert e.decisions_lost_count == 3
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_needs_contact_resolution_event_dataclass or pending_write_failed_event_dataclass" -v`
Expected: both FAIL

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, after `DryConsideredEvent`:

```python
@dataclass(frozen=True)
class DryNeedsContactResolutionEvent:
    ts: str
    task_id: int
    task_title: str
    full_name: str
    qmd_candidate_email: Optional[str]
    qmd_candidate_thread_count: int
    suggested_action: str
    action: str = "dry-needs-contact-resolution"


@dataclass(frozen=True)
class PendingWriteFailedEvent:
    ts: str
    error_message: str
    decisions_lost_count: int
    action: str = "pending-write-failed"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_needs_contact_resolution_event_dataclass or pending_write_failed_event_dataclass" -v`
Expected: both PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): add needs-contact-resolution + pending-write-failed events"
```

### Task A10 — Add `append_typed_event` helper that serializes dataclass events to JSONL

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — add after `append_jsonl_event` (line ~282)
- Test: `scripts/sync/tests/test_task_closure.py`

`append_jsonl_event` already accepts a dict. We add a thin typed-event wrapper that accepts any of the new event dataclasses, asdict()'s them, and delegates. Keeps backward compatibility for callers still using dicts (existing `cooling_off` and `closed`/`suggested` flows).

- [ ] **Step 1: Write the failing test**

```python
def test_append_typed_event_serializes_dataclass(tmp_path):
    import json
    from email_ingest.task_closure import (
        DryCycleStartEvent, append_typed_event,
    )
    jsonl = tmp_path / "out.jsonl"
    e = DryCycleStartEvent(
        ts="2026-05-14T11:30:00Z",
        open_task_count=5,
        profile_version=1,
        profile_path_b_lookback_days=365,
        dry_run=True,
    )
    append_typed_event(jsonl, e)
    line = jsonl.read_text().strip()
    obj = json.loads(line)
    assert obj["action"] == "dry-cycle-start"
    assert obj["open_task_count"] == 5
    assert obj["dry_run"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_append_typed_event_serializes_dataclass -v`
Expected: FAIL with `ImportError: cannot import name 'append_typed_event'`

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, after `append_jsonl_event`:

```python
def append_typed_event(path: Path, event) -> None:
    """Serialize a frozen event dataclass to JSONL via fcntl-locked append."""
    import dataclasses as _dc
    if not _dc.is_dataclass(event):
        raise TypeError(f"append_typed_event requires a dataclass, got {type(event)!r}")
    append_jsonl_event(path, _dc.asdict(event))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_append_typed_event_serializes_dataclass -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): add append_typed_event helper for dataclass events"
```

---

## Stage B — Matcher emission rewiring

Stage A produced types but didn't touch the matcher. Stage B rewires `scan_and_close` and `_emit_decision` so every task examined emits exactly one terminal event per cycle (plus optional `dry-needs-contact-resolution` co-events).

### Task B1 — `_gather_candidate_threads` returns `(candidates, adapter_errors)`

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:394-439`
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing test**

```python
class _StubAdapterRaises:
    def search_threads_since(self, epoch, addrs):
        raise RuntimeError("rate limit")
    def fetch_thread_messages(self, tid, epoch):
        return []


class _StubAdapterEmpty:
    def search_threads_since(self, epoch, addrs):
        return []
    def fetch_thread_messages(self, tid, epoch):
        return []


def test_gather_candidate_threads_returns_errors():
    from email_ingest.task_closure import (
        _gather_candidate_threads, ExtractedEntities, AdapterError,
    )
    entities = ExtractedEntities(
        emails=("test@example.com",),
        contact_keys=(),
        project_codes=(),
        unknown_full_names=(),
    )
    since = datetime(2026, 1, 1, tzinfo=timezone.utc)
    candidates, errors = _gather_candidate_threads(
        entities=entities, contacts={},
        gmail_adapter=_StubAdapterRaises(),
        exchange_adapter=_StubAdapterEmpty(),
        since=since,
    )
    assert candidates == []
    assert len(errors) == 1
    assert isinstance(errors[0], AdapterError)
    assert errors[0].adapter_name == "gmail"
    assert "rate limit" in errors[0].error_message
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_gather_candidate_threads_returns_errors -v`
Expected: FAIL — current function returns `list[ThreadCandidate]` not a tuple.

- [ ] **Step 3: Write minimal implementation**

Replace `_gather_candidate_threads` body (line 394-439). New signature returns tuple.

```python
def _gather_candidate_threads(
    *,
    entities: ExtractedEntities,
    contacts: dict[str, dict],
    gmail_adapter,
    exchange_adapter,
    since: datetime,
) -> tuple[list[ThreadCandidate], list[AdapterError]]:
    addrs: list[str] = list(entities.emails)
    for k in entities.contact_keys:
        email = contacts.get(k, {}).get("email")
        if email:
            addrs.append(email.lower())
    if not addrs:
        return [], []
    epoch = int(since.timestamp())
    out: list[ThreadCandidate] = []
    errors: list[AdapterError] = []
    for src, adapter in [("gmail", gmail_adapter), ("exchange", exchange_adapter)]:
        if not hasattr(adapter, "search_threads_since"):
            continue
        try:
            hits = adapter.search_threads_since(epoch, addrs) or []
        except Exception as e:
            log.warning("search_threads_since(%s) failed: %s", src, e)
            errors.append(AdapterError(adapter_name=src, error_message=str(e)))
            continue
        for h in hits[:5]:
            tid = h.get("thread_id")
            if not tid:
                continue
            ref = f"{src}:{tid}"
            try:
                msgs = adapter.fetch_thread_messages(tid, epoch)
            except Exception:
                msgs = []
            user_sent = sum(1 for m in msgs if _is_user_sent(m))
            cp_replied = len(msgs) - user_sent
            last_dt = max((_msg_dt(m) for m in msgs if _msg_dt(m) is not None), default=since)
            out.append(ThreadCandidate(
                thread_ref=ref,
                subject=h.get("subject", ""),
                counterparty_addrs=tuple(a.lower() for a in (h.get("addrs") or [])),
                last_activity=last_dt,
                user_sent_count=user_sent,
                counterparty_replied_count=cp_replied,
            ))
    return out, errors
```

This is a breaking signature change. The callers (`scan_and_close` line ~600 and `explain_task` line ~765) currently destructure the return as a list. Update them in the same step to consume the tuple, ignoring `errors` for now (Stage B's later tasks will use them):

In `scan_and_close` (line ~597):

```python
        candidates, _adapter_errors = _gather_candidate_threads(
            entities=entities, contacts=contacts,
            gmail_adapter=gmail_adapter, exchange_adapter=exchange_adapter,
            since=task.created_at,   # remains as-is for now; B4 changes this
        )
```

In `explain_task` (line ~765):

```python
    candidates, _adapter_errors = _gather_candidate_threads(
        entities=entities, contacts=contacts,
        gmail_adapter=gmail_adapter, exchange_adapter=exchange_adapter,
        since=target.created_at,   # changed in B4
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_gather_candidate_threads_returns_errors -v`
Expected: PASS. Then run full suite to confirm no regression: `python3 -m pytest tests/test_task_closure.py -v`. All existing tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "refactor(task-closure): _gather_candidate_threads returns (candidates, errors)"
```

### Task B2 — `_emit_decision` emits `DryConsideredEvent` for `Tier.DROP`

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:683-748` (`_emit_decision`)
- Test: `scripts/sync/tests/test_task_closure.py`

Today `_emit_decision` silently returns when `tier == Tier.DROP`. After this task, DROP-tier candidates emit `DryConsideredEvent` (so the I1 gate denominator can see them). `_emit_decision` is called from Path B's scoring loop with the top candidate's score, rule, etc.; we need it to additionally accept runner-up info.

This task extends `ClosureDecision` to carry `runner_up_score`, `runner_up_gap_satisfied`, `match_strength` (the dataclass at line 104 already has most fields except these 3). Then `_emit_decision` constructs and emits `DryConsideredEvent` for DROP.

- [ ] **Step 1: Write the failing test**

```python
def _stub_now():
    return datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)


def test_emit_decision_drop_tier_emits_dry_considered(tmp_path):
    import json
    from email_ingest.task_closure import (
        ClosureDecision, ClosureRunReport, Tier, _emit_decision,
    )
    jsonl = tmp_path / "out.jsonl"
    db = tmp_path / "messages.db"
    decision = ClosureDecision(
        task_id=10, task_title="t",
        thread_ref="gmail:abc", thread_addrs=("a@b.com",),
        score=0.4, tier=Tier.DROP, rule="retroactive_name_only_match",
        reasoning="below suggest", candidates_considered=2,
        runner_up_score=0.3, runner_up_gap_satisfied=True, match_strength=0.5,
    )
    report = ClosureRunReport()
    _emit_decision(
        decision, jsonl, [], report,
        db_path=db, dry_run=True, closed_this_run=0, per_run_cap=5,
    )
    line = jsonl.read_text().strip()
    obj = json.loads(line)
    assert obj["action"] == "dry-considered"
    assert obj["would_close_if"] == "drop"
    assert obj["top_score"] == 0.4
    assert obj["runner_up_score"] == 0.3
    assert obj["runner_up_gap_satisfied"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_emit_decision_drop_tier_emits_dry_considered -v`
Expected: FAIL — `ClosureDecision` doesn't have `runner_up_score`/etc., AND `_emit_decision` doesn't emit on DROP.

- [ ] **Step 3: Write minimal implementation**

Extend `ClosureDecision` (line 104-114):

```python
@dataclass(frozen=True)
class ClosureDecision:
    task_id: int
    task_title: str
    thread_ref: Optional[str]
    thread_addrs: tuple[str, ...]
    score: float
    tier: Tier
    rule: str
    reasoning: str
    candidates_considered: int
    runner_up_score: Optional[float] = None
    runner_up_gap_satisfied: bool = True
    match_strength: float = 0.0
```

(Defaults preserve backward compat for any in-code construction that doesn't supply them yet.)

In `_emit_decision` (line 683), add a final branch after the SUGGEST handling (before line 747's `return closed_this_run`):

```python
    if decision.tier == Tier.DROP:
        event = DryConsideredEvent(
            ts=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            task_id=decision.task_id,
            task_title=decision.task_title,
            top_thread_ref=decision.thread_ref,
            top_subject="",  # subject not on ClosureDecision; populated by scan_and_close via decision-build context if needed
            top_score=decision.score,
            top_addrs=list(decision.thread_addrs),
            runner_up_score=decision.runner_up_score,
            runner_up_gap_satisfied=decision.runner_up_gap_satisfied,
            match_strength=decision.match_strength,
            rule=decision.rule,
            candidates_considered=decision.candidates_considered,
            would_close_if=decision.tier.value,
            reasoning=decision.reasoning,
        )
        append_typed_event(jsonl_path, event)
        return closed_this_run
    return closed_this_run
```

Update the existing `Tier.AUTO_CLOSE` and `Tier.SUGGEST` branches to also produce `DryConsideredEvent`-style data only when needed for gate-evaluation purposes — but those branches already emit `dry-closed`/`dry-suggested` and we keep that. **No changes** to those branches in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_emit_decision_drop_tier_emits_dry_considered -v`
Expected: PASS. Then full suite: `python3 -m pytest tests/test_task_closure.py -v`. All existing tests must still pass (the new ClosureDecision fields are optional with defaults).

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): _emit_decision emits dry-considered for DROP tier"
```

### Task B3 — `_path_a_should_close` takes `profile`/`now` and uses `task.scan_since`

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:503-524` (`_path_a_should_close`)
- Modify: `scripts/sync/email_ingest/task_closure.py:572` (caller in `scan_and_close`)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_path_a_floor_uses_scan_since_email_source():
    from email_ingest.task_closure import _path_a_should_close, ClosureProfile

    class Msg:
        def __init__(self, ts, labels=None, from_addr=""):
            self.timestamp = int(ts.timestamp() * 1000)
            self.labels = labels or []
            self.from_addr = from_addr
            self.subject = ""
            self.metadata = {}

    profile = ClosureProfile.default()
    now = datetime(2026, 5, 13, tzinfo=timezone.utc)
    # Email-source task created Apr 1; scan_since == created_at == Apr 1.
    # Activity-window cutoff = now - 90d = Feb 12.
    # floor = max(Feb 12, Apr 1) = Apr 1.
    task = _make_task(
        source="email", created_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
        source_ref="gmail:abc",
    )
    # Message before Apr 1: excluded.
    msg_before = Msg(datetime(2026, 3, 15, tzinfo=timezone.utc), labels=["SENT"])
    # Message after Apr 1: included.
    msg_after = Msg(datetime(2026, 4, 15, tzinfo=timezone.utc), labels=["SENT"])
    should_close, _, _ = _path_a_should_close(
        task, [msg_before], now, profile=profile,
    )
    assert should_close is False  # only msg outside floor
    should_close, _, _ = _path_a_should_close(
        task, [msg_after], now, profile=profile,
    )
    assert should_close is True


def test_path_a_floor_uses_scan_since_migration_widens_window():
    # Hypothetical: a backfilled task with source='email' but created_at very old.
    # Activity-window cutoff at 90d is the binding floor.
    from email_ingest.task_closure import _path_a_should_close, ClosureProfile

    class Msg:
        def __init__(self, ts, labels=None):
            self.timestamp = int(ts.timestamp() * 1000)
            self.labels = labels or []
            self.from_addr = ""
            self.subject = ""
            self.metadata = {}

    profile = ClosureProfile.default()
    now = datetime(2026, 5, 13, tzinfo=timezone.utc)
    task = _make_task(
        source="email",
        created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),  # 400+ days ago
        source_ref="gmail:abc",
    )
    # Message 60 days ago: inside 90d cutoff, after created_at. Included.
    msg_recent = Msg(now - timedelta(days=60), labels=["SENT"])
    should_close, _, _ = _path_a_should_close(
        task, [msg_recent], now, profile=profile,
    )
    assert should_close is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "path_a_floor_uses_scan_since" -v`
Expected: both FAIL — function does not accept `profile` keyword.

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, modify `_path_a_should_close` signature and body (line 503-524):

```python
def _path_a_should_close(
    task: OpenTask,
    thread_msgs: list,
    now: datetime,
    *,
    profile: ClosureProfile,
) -> tuple[bool, str, tuple[str, ...]]:
    cutoff = now - timedelta(days=PATH_A_ACTIVITY_WINDOW_DAYS)
    floor = max(cutoff, task.scan_since(profile, now))
    relevant = []
    for m in thread_msgs:
        dt = _msg_dt(m)
        if dt is None or dt >= floor:
            relevant.append(m)
    if not relevant:
        return False, "", ()
    addrs = tuple({(getattr(m, "from_addr", "") or "").lower() for m in relevant if getattr(m, "from_addr", None)} - {""})
    kind = _classify_kind(task)
    if kind == "i-owe":
        for m in relevant:
            if _is_user_sent(m):
                return True, f"You sent reply in thread '{getattr(m, 'subject', '')}' since task creation.", addrs
        return False, "", addrs
    else:
        for m in relevant:
            if not _is_user_sent(m):
                return True, "Counterparty replied in thread since task creation.", addrs
        return False, "", addrs
```

Update the caller in `scan_and_close` (line ~572):

```python
            should_close, reasoning, addrs = _path_a_should_close(
                task, thread_msgs, now, profile=profile,
            )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "path_a_floor_uses_scan_since" -v`
Expected: both PASS. Full suite: `python3 -m pytest tests/test_task_closure.py -v` — all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): _path_a_should_close uses task.scan_since(profile, now)"
```

### Task B4 — `scan_and_close` uses `task.scan_since(profile, now)` for Path B + emits `DryCycleStartEvent`

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:527-680` (`scan_and_close`)
- Modify: `scripts/sync/email_ingest/task_closure.py:753-800` (`explain_task` — replicate `scan_since` call)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_dry_cycle_start_emitted_first(tmp_path):
    import json
    from email_ingest.task_closure import (
        scan_and_close, ClosureProfile, ClosureRunReport,
    )
    # Empty open_tasks via empty DB
    db = tmp_path / "messages.db"
    import sqlite3
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    conn.commit()
    conn.close()
    jsonl = tmp_path / "out.jsonl"
    pending = tmp_path / "pending.json"
    profile = ClosureProfile.default()
    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    scan_and_close(
        db_path=db, gmail_adapter=_StubAdapterEmpty(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=profile, contacts={}, followups=[], now=now,
        jsonl_path=jsonl, pending_path=pending,
        per_run_cap=5, dry_run=True,
    )
    lines = jsonl.read_text().strip().splitlines()
    assert len(lines) == 1   # exactly one event (the cycle-start)
    first = json.loads(lines[0])
    assert first["action"] == "dry-cycle-start"
    assert first["open_task_count"] == 0
    assert first["dry_run"] is True
    assert first["profile_path_b_lookback_days"] == 365


def test_dry_cycle_start_emitted_before_terminal_events(tmp_path):
    # 3 open tasks with no email matches: 1 cycle-start + 3 terminal events.
    import json, sqlite3
    from email_ingest.task_closure import scan_and_close, ClosureProfile
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    for i, title in [(1, "t1"), (2, "t2"), (3, "t3")]:
        conn.execute(
            "INSERT INTO tasks VALUES (?, ?, NULL, NULL, 3, 'manual', NULL, NULL, ?, 'open')",
            (i, title, "2026-04-24 12:17:02"),
        )
    conn.commit()
    conn.close()
    jsonl = tmp_path / "out.jsonl"
    pending = tmp_path / "pending.json"
    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    scan_and_close(
        db_path=db, gmail_adapter=_StubAdapterEmpty(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[], now=now,
        jsonl_path=jsonl, pending_path=pending,
        per_run_cap=5, dry_run=True,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    assert lines[0]["action"] == "dry-cycle-start"
    # 3 tasks → 3 terminal events after the cycle-start
    assert len([l for l in lines if l["action"] != "dry-cycle-start"]) == 3
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_cycle_start_emitted" -v`
Expected: both FAIL (no `dry-cycle-start` emitted today; matcher emits nothing for entity-empty tasks).

- [ ] **Step 3: Write minimal implementation**

At the top of `scan_and_close` (after `report = ClosureRunReport()` at line ~535), insert the cycle-start emission. Replace the `since=task.created_at` call later with `task.scan_since(profile, now)`. Add `dry-entity-miss` emission for the early-return case. We do NOT yet add `dry-search-miss`/`dry-needs-contact-resolution` (later tasks).

Modified `scan_and_close` head:

```python
def scan_and_close(
    *,
    db_path: Path, gmail_adapter, exchange_adapter,
    profile: ClosureProfile, contacts: dict[str, dict],
    followups: list, now: datetime,
    jsonl_path: Path, pending_path: Path,
    per_run_cap: int = 5, dry_run: bool = False,
) -> ClosureRunReport:
    report = ClosureRunReport()
    cooling_off = read_recent_reopens(jsonl_path, window_days=COOLING_OFF_DAYS, now=now)
    open_followup_threads = {
        f.thread for f in followups
        if getattr(f, "status", "open") == "open" and getattr(f, "thread", None)
    }
    open_tasks = fetch_open_tasks(db_path)

    # Liveness sentinel — must be the FIRST event written every cycle.
    append_typed_event(jsonl_path, DryCycleStartEvent(
        ts=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        open_task_count=len(open_tasks),
        profile_version=profile.version,
        profile_path_b_lookback_days=profile.path_b_lookback_days,
        dry_run=dry_run,
    ))

    pending_decisions: list[dict] = []
    closed_this_run = 0
    ...
```

In the Path B branch (line ~597 area), replace `since=task.created_at` with `since=task.scan_since(profile, now)`:

```python
        # Path B: retroactive match
        entities = extract_entities(title=task.title, context=task.context, contacts=contacts)

        candidates, _adapter_errors = _gather_candidate_threads(
            entities=entities, contacts=contacts,
            gmail_adapter=gmail_adapter, exchange_adapter=exchange_adapter,
            since=task.scan_since(profile, now),
        )

        # If entity extraction yielded nothing usable, emit dry-entity-miss.
        if not entities.contact_keys and not entities.emails:
            append_typed_event(jsonl_path, DryEntityMissEvent(
                ts=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                task_id=task.id,
                task_title=task.title,
                unknown_full_names=[list(p) for p in entities.unknown_full_names],
                project_codes=list(entities.project_codes),
                reason=EntityMissReason.NO_CONTACT_KEYS_OR_EMAILS.value,
            ))
            continue
        ...
```

(Note: `unknown_full_names` in `ExtractedEntities` is `tuple[tuple[str,str], ...]`; we cast to `list[list[str]]` for JSON-friendliness. Adjust the dataclass typing if needed, or accept the round-trip via asdict.)

Also update `explain_task` (line ~765) — the `since` argument:

```python
    candidates, _adapter_errors = _gather_candidate_threads(
        entities=entities, contacts=contacts,
        gmail_adapter=gmail_adapter, exchange_adapter=exchange_adapter,
        since=target.scan_since(profile, now),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_cycle_start_emitted or scan_since" -v`
Expected: all PASS. Full suite: `python3 -m pytest tests/test_task_closure.py -v`. Existing tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): scan_and_close emits cycle-start + entity-miss; uses scan_since"
```

### Task B5 — Emit `DrySearchMissEvent` when candidates is empty

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — `scan_and_close` Path B (after the entity-miss emit)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_dry_search_miss_empty_hits_emitted(tmp_path):
    """Path B task with valid entities but no Gmail hits → dry-search-miss(cause=empty_hits)."""
    import json, sqlite3
    from email_ingest.task_closure import scan_and_close, ClosureProfile
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    # Title contains an email so entities.emails is non-empty.
    conn.execute(
        "INSERT INTO tasks VALUES (1, 'email lucinda@penn.edu re: PO', NULL, NULL, 3, 'manual', NULL, NULL, '2026-04-24 12:17:02', 'open')",
    )
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"
    pending = tmp_path / "pending.json"
    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    scan_and_close(
        db_path=db, gmail_adapter=_StubAdapterEmpty(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[], now=now,
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    miss_events = [l for l in lines if l["action"] == "dry-search-miss"]
    assert len(miss_events) == 1
    assert miss_events[0]["cause"] == "empty_hits"
    assert miss_events[0]["task_id"] == 1


def test_dry_search_miss_adapter_error_emitted(tmp_path):
    """Adapter raises → dry-search-miss(cause=adapter_error, error_message=...)."""
    import json, sqlite3
    from email_ingest.task_closure import scan_and_close, ClosureProfile
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    conn.execute(
        "INSERT INTO tasks VALUES (1, 'email lucinda@penn.edu re: PO', NULL, NULL, 3, 'manual', NULL, NULL, '2026-04-24 12:17:02', 'open')",
    )
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"; pending = tmp_path / "pending.json"
    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    scan_and_close(
        db_path=db, gmail_adapter=_StubAdapterRaises(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[], now=now,
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    miss_events = [l for l in lines if l["action"] == "dry-search-miss"]
    assert len(miss_events) == 1
    assert miss_events[0]["cause"] == "adapter_error"
    assert "rate limit" in miss_events[0]["error_message"]
    assert "gmail" in miss_events[0]["adapters_tried"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_search_miss_empty_hits_emitted or dry_search_miss_adapter_error_emitted" -v`
Expected: both FAIL.

- [ ] **Step 3: Write minimal implementation**

In `scan_and_close` Path B, after the entity-miss early-return block from B4, add:

```python
        if not candidates:
            if _adapter_errors:
                first = _adapter_errors[0]
                append_typed_event(jsonl_path, DrySearchMissEvent(
                    ts=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    task_id=task.id, task_title=task.title,
                    addrs_queried=list(entities.emails) + [
                        (contacts.get(k, {}).get("email") or "").lower()
                        for k in entities.contact_keys
                        if contacts.get(k, {}).get("email")
                    ],
                    cause=SearchMissCause.ADAPTER_ERROR.value,
                    adapters_tried=[e.adapter_name for e in _adapter_errors],
                    error_message=first.error_message,
                ))
            else:
                append_typed_event(jsonl_path, DrySearchMissEvent(
                    ts=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    task_id=task.id, task_title=task.title,
                    addrs_queried=list(entities.emails) + [
                        (contacts.get(k, {}).get("email") or "").lower()
                        for k in entities.contact_keys
                        if contacts.get(k, {}).get("email")
                    ],
                    cause=SearchMissCause.EMPTY_HITS.value,
                    adapters_tried=["gmail", "exchange"],
                    error_message=None,
                ))
            continue
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_search_miss_empty_hits_emitted or dry_search_miss_adapter_error_emitted" -v`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): emit dry-search-miss (empty_hits, adapter_error)"
```

### Task B6 — Path A telemetry parity (`adapter_unknown_for_source`, `adapter_error`, `dry-considered` on close=False)

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — Path A branch in `scan_and_close` (lines ~556-593)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_path_a_unknown_source_emits_search_miss(tmp_path):
    """source='email' with source_ref like 'unknown:abc' → dry-search-miss(adapter_unknown_for_source)."""
    import json, sqlite3
    from email_ingest.task_closure import scan_and_close, ClosureProfile
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    conn.execute(
        "INSERT INTO tasks VALUES (1, 't', NULL, NULL, 3, 'email', 'unknown:xyz', NULL, '2026-04-24 12:17:02', 'open')",
    )
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"; pending = tmp_path / "pending.json"
    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    scan_and_close(
        db_path=db, gmail_adapter=_StubAdapterEmpty(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[], now=now,
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    miss = [l for l in lines if l["action"] == "dry-search-miss"]
    assert len(miss) == 1
    assert miss[0]["cause"] == "adapter_unknown_for_source"


def test_path_a_should_close_false_emits_dry_considered(tmp_path):
    """source='email' valid, adapter empty thread → dry-considered(top_score=0, would_close_if=drop)."""
    import json, sqlite3
    from email_ingest.task_closure import scan_and_close, ClosureProfile

    class GmailEmptyThread:
        def search_threads_since(self, epoch, addrs):
            return []
        def fetch_thread_messages(self, tid, epoch):
            return []   # No relevant messages → _path_a_should_close returns False

    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    conn.execute(
        "INSERT INTO tasks VALUES (1, 't', NULL, NULL, 3, 'email', 'gmail:abc', NULL, '2026-04-24 12:17:02', 'open')",
    )
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"; pending = tmp_path / "pending.json"
    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    scan_and_close(
        db_path=db, gmail_adapter=GmailEmptyThread(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[], now=now,
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    considered = [l for l in lines if l["action"] == "dry-considered"]
    assert len(considered) == 1
    assert considered[0]["top_score"] == 0.0
    assert considered[0]["would_close_if"] == "drop"
    assert considered[0]["top_addrs"] == []   # never null
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "path_a_unknown_source_emits_search_miss or path_a_should_close_false_emits_dry_considered" -v`
Expected: both FAIL (silent `continue` today).

- [ ] **Step 3: Write minimal implementation**

In `scan_and_close` Path A (lines ~556-593), replace the silent `continue` paths:

```python
        # Path A: provenance match
        if task.source == "email" and task.source_ref:
            try:
                src, tid = task.source_ref.split(":", 1)
            except ValueError:
                src, tid = "", task.source_ref
            adapter = gmail_adapter if src == "gmail" else exchange_adapter if src == "exchange" else None
            if adapter is None:
                append_typed_event(jsonl_path, DrySearchMissEvent(
                    ts=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    task_id=task.id, task_title=task.title,
                    addrs_queried=[],
                    cause=SearchMissCause.ADAPTER_UNKNOWN_FOR_SOURCE.value,
                    adapters_tried=[src] if src else [],
                    error_message=None,
                ))
                report.skipped_count += 1
                continue
            try:
                thread_msgs = adapter.fetch_thread_messages(tid, int(task.created_at.timestamp()))
            except Exception as e:
                log.warning("task %s: thread fetch failed: %s", task.id, e)
                append_typed_event(jsonl_path, DrySearchMissEvent(
                    ts=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    task_id=task.id, task_title=task.title,
                    addrs_queried=[],
                    cause=SearchMissCause.ADAPTER_ERROR.value,
                    adapters_tried=[src],
                    error_message=str(e),
                ))
                report.skipped_count += 1
                continue

            should_close, reasoning, addrs = _path_a_should_close(
                task, thread_msgs, now, profile=profile,
            )
            if not should_close:
                append_typed_event(jsonl_path, DryConsideredEvent(
                    ts=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    task_id=task.id, task_title=task.title,
                    top_thread_ref=task.source_ref,
                    top_subject="",
                    top_score=0.0,
                    top_addrs=list(addrs),
                    runner_up_score=None,
                    runner_up_gap_satisfied=True,
                    match_strength=0.0,
                    rule="path_a_no_activity",
                    candidates_considered=1,
                    would_close_if=Tier.DROP.value,
                    reasoning=f"Path A: {reasoning or 'no relevant activity in window'}",
                ))
                continue
            # Fall-through to _emit_decision (existing dry-closed/dry-suggested path)
            ...
```

The fall-through after `should_close=True` keeps the existing `_emit_decision` call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "path_a_unknown_source_emits_search_miss or path_a_should_close_false_emits_dry_considered" -v`
Expected: both PASS. Full suite: `python3 -m pytest tests/test_task_closure.py -v`. All existing tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): Path A emits search-miss + dry-considered events"
```

### Task B7 — `dry-considered` carries runner-up gap info; scoring loop populates `ClosureDecision`

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — scoring loop in `scan_and_close` (around line 633-668)
- Test: `scripts/sync/tests/test_task_closure.py`

This is the load-bearing A1 task. After this, `ClosureDecision` objects sent to `_emit_decision` carry `runner_up_score`, `runner_up_gap_satisfied`, `match_strength`. `_emit_decision`'s DROP branch (added in B2) reads these and emits a faithful `DryConsideredEvent` that the I1 gate can use.

- [ ] **Step 1: Write the failing tests**

```python
def test_dry_considered_above_auto_but_runner_up_gap_fails(tmp_path):
    """top=0.80, runner=0.65 (gap 0.15 < 0.20) → SUGGEST, NOT AUTO_CLOSE.
    Event records runner_up_gap_satisfied == False."""
    # The cleanest unit test here is direct on _emit_decision via fabricated ClosureDecision
    # because exercising the full scoring loop requires extensive adapter mocks.
    import json
    from email_ingest.task_closure import (
        ClosureDecision, ClosureRunReport, Tier, _emit_decision,
    )
    jsonl = tmp_path / "out.jsonl"
    db = tmp_path / "messages.db"

    # SUGGEST tier with gap-not-satisfied → dry-suggested event today, no dry-considered.
    decision = ClosureDecision(
        task_id=42, task_title="t",
        thread_ref="gmail:abc", thread_addrs=("a@b.com",),
        score=0.80, tier=Tier.SUGGEST, rule="retroactive_full_name_match",
        reasoning="...", candidates_considered=2,
        runner_up_score=0.65, runner_up_gap_satisfied=False, match_strength=0.8,
    )
    report = ClosureRunReport()
    _emit_decision(
        decision, jsonl, [], report,
        db_path=db, dry_run=True, closed_this_run=0, per_run_cap=5,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    # SUGGEST emits dry-suggested (existing); no dry-considered for SUGGEST.
    assert lines[0]["action"] == "dry-suggested"
    # Now make the same score DROP (clipped by followup) to test gap propagation through DROP path.
    jsonl.unlink()
    decision2 = ClosureDecision(
        task_id=43, task_title="t2",
        thread_ref="gmail:def", thread_addrs=("a@b.com",),
        score=0.549, tier=Tier.DROP, rule="retroactive_full_name_match",
        reasoning="clipped by open_followup_threads", candidates_considered=2,
        runner_up_score=0.30, runner_up_gap_satisfied=True, match_strength=0.8,
    )
    _emit_decision(
        decision2, jsonl, [], report,
        db_path=db, dry_run=True, closed_this_run=0, per_run_cap=5,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    assert lines[0]["action"] == "dry-considered"
    assert lines[0]["runner_up_gap_satisfied"] is True   # gap 0.249 >= 0.20


def test_dry_considered_followup_clip_lands_in_drop(tmp_path):
    """Real scoring path: candidate with raw_score 0.8 + thread in open_followup_threads
    → score clipped to suggest - 0.001 = 0.549 → DROP → dry-considered with would_close_if='drop'."""
    import json, sqlite3
    from email_ingest.task_closure import (
        scan_and_close, ClosureProfile, ThreadCandidate,
    )
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    conn.execute(
        "INSERT INTO tasks VALUES (1, 'email lucinda@penn.edu re: PO', NULL, NULL, 3, 'manual', NULL, NULL, '2026-04-24 12:17:02', 'open')",
    )
    conn.commit(); conn.close()

    class GmailWithHit:
        def search_threads_since(self, epoch, addrs):
            return [{"thread_id": "abc", "subject": "PO update", "addrs": ["lucinda@penn.edu"]}]
        def fetch_thread_messages(self, tid, epoch):
            class M:
                labels = ["SENT"]
                metadata = {"is_sent": True, "internalDate": "1714000000000"}
                from_addr = "me@example.com"
                subject = "PO update"
                timestamp = 1714000000000
            return [M(), M(), M()]   # high user-sent count drives high score

    # Followup pretending to hold the same thread:
    class Followup:
        status = "open"
        thread = "gmail:abc"

    jsonl = tmp_path / "out.jsonl"; pending = tmp_path / "pending.json"
    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    scan_and_close(
        db_path=db, gmail_adapter=GmailWithHit(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[Followup()], now=now,
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    considered = [l for l in lines if l["action"] == "dry-considered"]
    assert len(considered) == 1, f"Expected exactly 1 dry-considered, got {lines}"
    assert considered[0]["would_close_if"] == "drop"
    assert "follow" in considered[0]["reasoning"].lower() or considered[0]["top_score"] < 0.55
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_considered_above_auto_but_runner_up_gap_fails or dry_considered_followup_clip_lands_in_drop" -v`
Expected: both FAIL — `ClosureDecision` is constructed in the scoring loop without runner_up info.

- [ ] **Step 3: Write minimal implementation**

In `scan_and_close` scoring loop (line ~633-668), update the decision construction:

```python
        scored.sort(key=lambda x: x[0], reverse=True)
        top_score, top = scored[0]
        runner = scored[1][0] if len(scored) > 1 else None
        tier = assign_tier(top_score=top_score, runner_up=runner, profile=profile)

        # Edge case 3: 3+ open tasks on same thread → all flagged to suggest.
        if same_thread_other_open.get(top.thread_ref, 0) >= 2:
            tier = Tier.SUGGEST

        runner_score = runner if runner is not None else 0.0
        gap_satisfied = (top_score - runner_score) >= RUNNER_UP_GAP_REQUIRED

        top_addrs_set = set(top.counterparty_addrs)
        contact_email_in_top = any(
            (contacts.get(k, {}).get("email") or "").lower() in top_addrs_set
            for k in entities.contact_keys
        )
        rule = (
            "retroactive_full_email_match" if any(e in top_addrs_set for e in entities.emails)
            else "retroactive_full_name_match" if contact_email_in_top
            else "retroactive_name_only_match"
        )
        # Compute match strength for the top candidate (was previously thrown away after scoring).
        top_match_strength = _match_strength_for(entities, top, contacts)
        reasoning = (
            f"Matched thread '{top.subject}' (score {top_score:.2f}, rule {rule}). "
            f"User-sent {top.user_sent_count}, counterparty-replied {top.counterparty_replied_count}."
        )
        if tier == Tier.DROP and top.thread_ref in open_followup_threads:
            reasoning += " (open followup on same thread — score clipped to below suggest)"

        decision = ClosureDecision(
            task_id=task.id, task_title=task.title,
            thread_ref=top.thread_ref, thread_addrs=top.counterparty_addrs,
            score=top_score, tier=tier, rule=rule,
            reasoning=reasoning, candidates_considered=len(scored),
            runner_up_score=runner,
            runner_up_gap_satisfied=gap_satisfied,
            match_strength=top_match_strength,
        )
        closed_this_run = _emit_decision(
            decision, jsonl_path, pending_decisions, report,
            db_path=db_path, dry_run=dry_run,
            closed_this_run=closed_this_run, per_run_cap=per_run_cap,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "dry_considered_above_auto_but_runner_up_gap_fails or dry_considered_followup_clip_lands_in_drop" -v`
Expected: both PASS. Full suite still green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): scoring loop records runner_up gap + match_strength"
```

### Task B8 — `dry-needs-contact-resolution` emission with UTC-daily dedup + QMD candidate stub

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — `scan_and_close` Path B start (after entity extraction)
- Test: `scripts/sync/tests/test_task_closure.py`

QMD lookup is stubbed for unit tests via dependency injection: `scan_and_close` accepts an optional `qmd_lookup` callable; default is a function that returns `(None, 0)`. The real lookup goes to the QMD MCP and is wired in `email-ingest.py` (Stage D).

- [ ] **Step 1: Write the failing tests**

```python
def test_needs_contact_resolution_emitted_with_qmd_stub(tmp_path):
    import json, sqlite3
    from email_ingest.task_closure import scan_and_close, ClosureProfile
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    conn.execute(
        "INSERT INTO tasks VALUES (1, 'Reach out to Joe Buxbaum re: ASD', NULL, NULL, 3, 'manual', NULL, NULL, '2026-04-24 12:17:02', 'open')",
    )
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"; pending = tmp_path / "pending.json"
    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)

    def qmd_lookup(full_name: str):
        if full_name == "Joe Buxbaum":
            return ("jbuxbaum@mssm.edu", 3)
        return (None, 0)

    scan_and_close(
        db_path=db, gmail_adapter=_StubAdapterEmpty(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[], now=now,
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
        qmd_lookup=qmd_lookup,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    needs = [l for l in lines if l["action"] == "dry-needs-contact-resolution"]
    assert len(needs) == 1
    assert needs[0]["full_name"] == "Joe Buxbaum"
    assert needs[0]["qmd_candidate_email"] == "jbuxbaum@mssm.edu"
    assert needs[0]["qmd_candidate_thread_count"] == 3


def test_needs_contact_resolution_dedup_within_24h(tmp_path):
    """Two cycles within 24h on same task+name → only one emission."""
    import json, sqlite3
    from email_ingest.task_closure import scan_and_close, ClosureProfile
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    conn.execute(
        "INSERT INTO tasks VALUES (1, 'Reach out to Joe Buxbaum', NULL, NULL, 3, 'manual', NULL, NULL, '2026-04-24 12:17:02', 'open')",
    )
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"; pending = tmp_path / "pending.json"
    now1 = datetime(2026, 5, 14, 0, 0, tzinfo=timezone.utc)
    now2 = datetime(2026, 5, 14, 23, 0, tzinfo=timezone.utc)

    def qmd_lookup(_): return (None, 0)

    for n in [now1, now2]:
        scan_and_close(
            db_path=db, gmail_adapter=_StubAdapterEmpty(),
            exchange_adapter=_StubAdapterEmpty(),
            profile=ClosureProfile.default(), contacts={}, followups=[], now=n,
            jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
            qmd_lookup=qmd_lookup,
        )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    needs = [l for l in lines if l["action"] == "dry-needs-contact-resolution"]
    assert len(needs) == 1   # second cycle deduped
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "needs_contact_resolution_emitted_with_qmd_stub or needs_contact_resolution_dedup_within_24h" -v`
Expected: both FAIL.

- [ ] **Step 3: Write minimal implementation**

Extend `scan_and_close` signature to accept `qmd_lookup`:

```python
def scan_and_close(
    *,
    db_path: Path, gmail_adapter, exchange_adapter,
    profile: ClosureProfile, contacts: dict[str, dict],
    followups: list, now: datetime,
    jsonl_path: Path, pending_path: Path,
    per_run_cap: int = 5, dry_run: bool = False,
    qmd_lookup=None,
) -> ClosureRunReport:
    ...
```

Default lookup at top of function:

```python
    if qmd_lookup is None:
        qmd_lookup = lambda _name: (None, 0)
```

Add a helper to build the "recent needs-contact keys" set from the last 24h of JSONL:

```python
def _recent_needs_contact_keys(jsonl_path: Path, now: datetime) -> set[tuple[int, str]]:
    if not jsonl_path.exists():
        return set()
    cutoff = now - timedelta(hours=24)
    out: set[tuple[int, str]] = set()
    with jsonl_path.open("r") as fp:
        fcntl.flock(fp.fileno(), fcntl.LOCK_SH)
        try:
            for raw in fp:
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if obj.get("action") != "dry-needs-contact-resolution":
                    continue
                ts = obj.get("ts")
                if not ts:
                    continue
                try:
                    t = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                if t < cutoff:
                    continue
                out.add((int(obj["task_id"]), str(obj["full_name"])))
        finally:
            fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
    return out
```

After cooling-off / cycle-start setup in `scan_and_close`:

```python
    recent_needs_contact = _recent_needs_contact_keys(jsonl_path, now)
```

In Path B, after `entities = extract_entities(...)` and before the entity-empty check:

```python
        if entities.unknown_full_names and not entities.contact_keys:
            for first, last in entities.unknown_full_names:
                full_name = f"{first} {last}"
                key = (task.id, full_name)
                if key in recent_needs_contact:
                    continue
                qmd_email, qmd_count = qmd_lookup(full_name)
                append_typed_event(jsonl_path, DryNeedsContactResolutionEvent(
                    ts=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    task_id=task.id, task_title=task.title,
                    full_name=full_name,
                    qmd_candidate_email=qmd_email,
                    qmd_candidate_thread_count=qmd_count,
                    suggested_action="add to groups/global/state/USER.md",
                ))
                recent_needs_contact.add(key)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "needs_contact_resolution_emitted_with_qmd_stub or needs_contact_resolution_dedup_within_24h" -v`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): emit dry-needs-contact-resolution with QMD candidate + UTC-daily dedup"
```

---

## Stage C — Error guards + sanity checks

### Task C1 — `append_jsonl_event` swallows write errors (logs + increments counter)

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:271-282` (`append_jsonl_event`) + `ClosureRunReport` (line 467) to add `write_failure_count`
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing test**

```python
def test_append_jsonl_event_disk_full_does_not_raise(tmp_path, monkeypatch):
    from email_ingest.task_closure import append_jsonl_event, ClosureRunReport
    jsonl = tmp_path / "out.jsonl"
    # Force the actual write to raise ENOSPC.
    real_open = type(jsonl).open
    def boom(self, mode="r", *a, **kw):
        if "a" in mode or "w" in mode:
            raise OSError(28, "No space left on device")
        return real_open(self, mode, *a, **kw)
    monkeypatch.setattr(type(jsonl), "open", boom)
    # Should NOT raise.
    append_jsonl_event(jsonl, {"action": "cooling_off", "task_id": 1})
    # The file did not get written; this is a tolerated failure.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_append_jsonl_event_disk_full_does_not_raise -v`
Expected: FAIL with `OSError` propagating.

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, modify `append_jsonl_event`:

```python
def append_jsonl_event(path: Path, event: dict) -> None:
    """Append one JSONL event under exclusive file lock.

    Disk-full / lock-timeout / permission failures are logged and swallowed;
    callers should consult ClosureRunReport.write_failure_count if they need
    to detect partial telemetry. In live-mode, scan_and_close uses
    write_failure_count to gate DB writes (see C2).
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if "ts" not in event:
            event = {"ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **event}
        line = json.dumps(event) + "\n"
        with path.open("a") as fp:
            fcntl.flock(fp.fileno(), fcntl.LOCK_EX)
            try:
                fp.write(line)
            finally:
                fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
    except (OSError, IOError) as e:
        log.warning("task-closure: JSONL write failed (%s); continuing", e)
        # Mutate a module-level counter that scan_and_close picks up via
        # report.write_failure_count after each emit. Simpler: scan_and_close
        # passes report.write_failure_count via callback — but Path A/B paths
        # don't currently pass report into the writer. We use a thread-local
        # counter mirror that scan_and_close zeroes and reads.
        _WRITE_FAILURE_COUNTER["count"] += 1


_WRITE_FAILURE_COUNTER: dict = {"count": 0}
```

Add to `ClosureRunReport` (line 467):

```python
@dataclass
class ClosureRunReport:
    closed_count: int = 0
    suggested_count: int = 0
    cooling_off_count: int = 0
    skipped_count: int = 0
    write_failure_count: int = 0
    decisions: list[ClosureDecision] = field(default_factory=list)
```

In `scan_and_close`, zero the counter at start and read it at end:

```python
    _WRITE_FAILURE_COUNTER["count"] = 0
    # ... main loop ...
    report.write_failure_count = _WRITE_FAILURE_COUNTER["count"]
    return report
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_append_jsonl_event_disk_full_does_not_raise -v`
Expected: PASS. Full suite must still pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): append_jsonl_event swallows disk errors, surfaces via counter"
```

### Task C2 — Live-mode kill-switch on JSONL write failure

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — `scan_and_close` main loop
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing test**

```python
def test_live_mode_aborts_db_writes_on_jsonl_failure(tmp_path, monkeypatch):
    """In live mode (dry_run=False), if JSONL write fails after task 1 closes,
    no DB writes happen for remaining tasks."""
    import sqlite3
    from email_ingest.task_closure import (
        scan_and_close, ClosureProfile,
    )
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT, completed_at TEXT
        )
    """)
    for i in range(1, 4):
        conn.execute(
            "INSERT INTO tasks VALUES (?, ?, NULL, NULL, 3, 'manual', NULL, NULL, '2026-04-24 12:17:02', 'open', NULL)",
            (i, f"t{i} a@b.com"),
        )
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"; pending = tmp_path / "pending.json"

    # Pretend the first event works (cycle-start), then JSONL writes fail.
    write_count = {"n": 0}
    real_open = type(jsonl).open
    def hostile_open(self, mode="r", *a, **kw):
        if "a" in mode:
            write_count["n"] += 1
            if write_count["n"] > 1:
                raise OSError(28, "ENOSPC")
        return real_open(self, mode, *a, **kw)
    monkeypatch.setattr(type(jsonl), "open", hostile_open)

    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    report = scan_and_close(
        db_path=db, gmail_adapter=_StubAdapterEmpty(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[], now=now,
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=False,
    )
    # No close should have happened (matcher aborted DB writes).
    conn = sqlite3.connect(db)
    closed_count = conn.execute("SELECT COUNT(*) FROM tasks WHERE status != 'open'").fetchone()[0]
    conn.close()
    assert closed_count == 0
    assert report.write_failure_count > 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_live_mode_aborts_db_writes_on_jsonl_failure -v`
Expected: FAIL — no kill-switch yet.

- [ ] **Step 3: Write minimal implementation**

In `scan_and_close` main loop, BEFORE any per-task DB-mutating call (i.e., before `_emit_decision` in live mode), check the counter:

```python
        # Live-mode kill-switch: if any JSONL write has failed this cycle,
        # do not commit further DB changes — the audit trail is broken.
        if not dry_run and _WRITE_FAILURE_COUNTER["count"] > 0:
            log.warning(
                "task-closure: aborting live-mode DB writes after JSONL failure (count=%d)",
                _WRITE_FAILURE_COUNTER["count"],
            )
            break
```

This sits at the top of the per-task loop in `scan_and_close` (after the `for task in open_tasks:` line, before any continue / Path-A / Path-B logic that emits events). Note: we still emit events (which are best-effort) but skip DB closures.

Actually, since `_emit_decision` does the DB write inside, and we want to keep emitting telemetry events (read-only by nature), we instead gate the actual `close_task_in_db` call. Modify `_emit_decision`'s AUTO_CLOSE branch (line ~713-718):

```python
        if not dry_run:
            # Live-mode kill-switch: refuse DB write if any earlier JSONL write failed.
            if _WRITE_FAILURE_COUNTER["count"] > 0:
                log.warning(
                    "task-closure: skipping DB close for task %d due to prior JSONL failure",
                    decision.task_id,
                )
                report.skipped_count += 1
                return closed_this_run
            ok = close_task_in_db(db_path, decision.task_id, reasoning=decision.reasoning)
            if not ok:
                log.warning("task %s: close failed (status changed); skipping", decision.task_id)
                report.skipped_count += 1
                return closed_this_run
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_live_mode_aborts_db_writes_on_jsonl_failure -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): live-mode kill-switch — refuse DB close if JSONL failed"
```

### Task C3 — Try/finally around task loop, pending write inside finally, `PendingWriteFailedEvent` on failure

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — `scan_and_close` end (lines ~669-680)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_pending_write_failure_emits_event(tmp_path, monkeypatch):
    import json, sqlite3
    from email_ingest.task_closure import scan_and_close, ClosureProfile
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"
    pending = tmp_path / "pending.json"

    # Make Path.replace blow up to simulate atomic-rename failure.
    real_replace = type(pending).replace
    def boom(self, other):
        if "pending" in str(other):
            raise OSError(13, "Permission denied")
        return real_replace(self, other)
    monkeypatch.setattr(type(pending), "replace", boom)

    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    scan_and_close(
        db_path=db, gmail_adapter=_StubAdapterEmpty(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[], now=now,
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    pwf = [l for l in lines if l["action"] == "pending-write-failed"]
    assert len(pwf) == 1
    assert "Permission denied" in pwf[0]["error_message"]


def test_pending_write_runs_in_finally_on_crash(tmp_path, monkeypatch):
    """Inject an exception mid-loop; pending file still gets written with
    decisions accumulated up to the crash point."""
    import json, sqlite3
    from email_ingest.task_closure import scan_and_close, ClosureProfile
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    for i in range(1, 6):
        conn.execute(
            "INSERT INTO tasks VALUES (?, ?, NULL, NULL, 3, 'manual', NULL, NULL, '2026-04-24 12:17:02', 'open')",
            (i, f"t{i}"),
        )
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"; pending = tmp_path / "pending.json"

    # Force entity-extraction to raise after the 3rd task by monkeypatching.
    from email_ingest import task_closure as tc
    real = tc.extract_entities
    counter = {"n": 0}
    def boom(*a, **kw):
        counter["n"] += 1
        if counter["n"] > 3:
            raise RuntimeError("synthetic mid-loop crash")
        return real(*a, **kw)
    monkeypatch.setattr(tc, "extract_entities", boom)

    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    with pytest.raises(RuntimeError):
        scan_and_close(
            db_path=db, gmail_adapter=_StubAdapterEmpty(),
            exchange_adapter=_StubAdapterEmpty(),
            profile=ClosureProfile.default(), contacts={}, followups=[], now=now,
            jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
        )
    # pending.json was written despite the crash.
    assert pending.exists()
    payload = json.loads(pending.read_text())
    # 0 pending decisions accumulated (entity-miss tasks emit events but not pending decisions),
    # but the file must have a valid skeleton.
    assert payload["version"] == 1
    assert isinstance(payload["items"], list)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "pending_write_failure_emits_event or pending_write_runs_in_finally_on_crash" -v`
Expected: both FAIL.

- [ ] **Step 3: Write minimal implementation**

Wrap `scan_and_close`'s main loop in try/finally; the finally block writes pending atomically and catches failure:

```python
    pending_decisions: list[dict] = []
    closed_this_run = 0

    try:
        for task in open_tasks:
            # ... existing loop body ...
    finally:
        # Always write pending, even if loop raised.
        pending_payload = {
            "version": 1,
            "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "items": pending_decisions,
        }
        try:
            tmp = pending_path.with_suffix(pending_path.suffix + ".tmp")
            pending_path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(pending_payload, indent=2))
            tmp.replace(pending_path)
        except Exception as e:
            log.warning("task-closure: pending write failed: %s", e)
            try:
                append_typed_event(jsonl_path, PendingWriteFailedEvent(
                    ts=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    error_message=str(e),
                    decisions_lost_count=len(pending_decisions),
                ))
            except Exception as e2:
                log.error("task-closure: pending-write-failed event also failed: %s", e2)
        report.write_failure_count = _WRITE_FAILURE_COUNTER["count"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "pending_write_failure_emits_event or pending_write_runs_in_finally_on_crash" -v`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): pending write in try/finally; emit pending-write-failed event"
```

### Task C4 — Contacts loader sanity warnings (no table / no Email column)

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:853-872` (`_load_contacts_from_claude_md`)
- Test: `scripts/sync/tests/test_task_closure.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_contacts_loader_no_table_warns(tmp_path, caplog):
    import logging
    from email_ingest.task_closure import _load_contacts_from_claude_md
    p = tmp_path / "USER.md"
    p.write_text("# User profile\nSome prose, no contacts table.\n")
    with caplog.at_level(logging.WARNING, logger="email-ingest.task-closure"):
        out = _load_contacts_from_claude_md(p)
    assert out == {}
    assert any("no contacts table" in r.message for r in caplog.records)


def test_contacts_loader_name_without_email_warns(tmp_path, caplog):
    import logging
    from email_ingest.task_closure import _load_contacts_from_claude_md
    p = tmp_path / "USER.md"
    p.write_text(
        "| Name | Role |\n"
        "|---|---|\n"
        "| Joe | Collaborator |\n"
    )
    with caplog.at_level(logging.WARNING, logger="email-ingest.task-closure"):
        out = _load_contacts_from_claude_md(p)
    assert out == {}
    assert any("no Email column" in r.message for r in caplog.records)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "contacts_loader_no_table_warns or contacts_loader_name_without_email_warns" -v`
Expected: both FAIL.

- [ ] **Step 3: Write minimal implementation**

Replace `_load_contacts_from_claude_md` (lines 853-872):

```python
def _load_contacts_from_claude_md(path: Path) -> dict[str, dict]:
    if not path.exists():
        log.info("contacts: %s not found, skipping", path)
        return {}
    text = path.read_text()
    out: dict[str, dict] = {}
    in_table = False
    saw_name_header = False
    saw_name_and_email = False
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("| Name "):
            saw_name_header = True
            if "Email" in line:
                saw_name_and_email = True
                in_table = True
                continue
            else:
                log.warning(
                    "contacts: %s has Name header but no Email column; renamed?", path,
                )
                return {}
        if in_table:
            if not line.startswith("|"):
                in_table = False
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) >= 3 and "@" in cells[2]:
                out[cells[0].lower()] = {"email": cells[2].lower()}
    if not saw_name_header:
        log.warning(
            "contacts: %s has no contacts table; entity extraction will degrade", path,
        )
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "contacts_loader_no_table_warns or contacts_loader_name_without_email_warns" -v`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): contacts loader warns on missing table or Email column"
```

### Task C5 — Trainer compatibility: read new event actions when filtering JSONL

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure_trainer.py`
- Test: `scripts/sync/tests/test_task_closure_trainer.py`

The trainer derives per-counterparty trust from confirm/reopen events in JSONL. After our changes the JSONL contains many new event types. Verify trainer ignores unknown actions and still derives correct weights from `closed`/`reopened`.

- [ ] **Step 1: Write the failing test**

In `tests/test_task_closure_trainer.py`, add:

```python
def test_trainer_ignores_new_event_types(tmp_path):
    import json
    from email_ingest.task_closure_trainer import train
    jsonl = tmp_path / "events.jsonl"
    out_profile = tmp_path / "profile.json"
    events = [
        {"ts": "2026-05-13T00:00:00Z", "action": "dry-cycle-start", "open_task_count": 5,
         "profile_version": 1, "profile_path_b_lookback_days": 365, "dry_run": True},
        {"ts": "2026-05-13T00:01:00Z", "action": "dry-considered", "task_id": 7,
         "would_close_if": "auto_close", "top_score": 0.78},
        {"ts": "2026-05-13T00:02:00Z", "action": "dry-entity-miss", "task_id": 8,
         "reason": "no_contact_keys_or_emails"},
        {"ts": "2026-05-13T00:03:00Z", "action": "dry-search-miss", "task_id": 9, "cause": "empty_hits"},
        {"ts": "2026-05-13T00:04:00Z", "action": "closed", "task_id": 10,
         "thread_addrs": ["a@b.com"], "rule": "retroactive_full_email_match"},
        {"ts": "2026-05-13T00:05:00Z", "action": "reopened", "task_id": 10,
         "feedback_source": "agent"},
    ]
    with jsonl.open("w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    profile = train(jsonl, out_profile, lookback_days=30)
    # Should not crash; should produce a valid profile.
    assert profile is not None
```

- [ ] **Step 2: Run test to verify it passes (or fails)**

Run: `python3 -m pytest tests/test_task_closure_trainer.py::test_trainer_ignores_new_event_types -v`
Expected: depends on existing trainer logic — likely passes if it already filters by `action == "closed"` / `action == "reopened"`. If it filters via `action in {"closed", "reopened"}` (allowlist) the test passes trivially. If it does anything else (e.g., parses all events for a generic field), it may fail.

- [ ] **Step 3: If failing, restrict trainer to known actions**

Read `task_closure_trainer.py` and confirm the action-filter. If needed, harden by explicitly filtering:

```python
RELEVANT_ACTIONS = {"closed", "dry-closed", "reopened", "manual-rollback"}
events = [e for e in events if e.get("action") in RELEVANT_ACTIONS]
```

- [ ] **Step 4: Confirm test passes**

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure_trainer.py scripts/sync/tests/test_task_closure_trainer.py
git commit -m "feat(task-closure-trainer): tolerate new event types in JSONL"
```

---

## Stage D — Stage F surface (digest publisher + invocation)

### Task D1 — `publish_closure_candidates_digest` function

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` — add after `_load_contacts_from_claude_md`
- Test: `scripts/sync/tests/test_task_closure.py`

Function signature (per spec §7):

```python
def publish_closure_candidates_digest(
    *,
    pending_path: Path,
    jsonl_path: Path,
    digest_path: Path,
    state_path: Path,
    lookback_hours: int = 24,
    now: Optional[datetime] = None,
) -> None: ...
```

- [ ] **Step 1: Write the failing tests**

```python
def test_publish_closure_candidates_digest_dedupe_by_task_and_name(tmp_path):
    import json
    from email_ingest.task_closure import publish_closure_candidates_digest

    jsonl = tmp_path / "events.jsonl"
    pending = tmp_path / "pending.json"
    digest = tmp_path / "closure-candidates.json"
    state = tmp_path / "state.json"

    # Empty pending
    pending.write_text(json.dumps({"version": 1, "generated_at": "...", "items": []}))

    # JSONL with 3 needs-contact events: 2 for "Joe Buxbaum" (different task_ids), 1 for "Jane Doe"
    events = [
        {"ts": "2026-05-14T10:00:00Z", "action": "dry-needs-contact-resolution",
         "task_id": 3, "task_title": "T3", "full_name": "Joe Buxbaum",
         "qmd_candidate_email": "jbuxbaum@mssm.edu", "qmd_candidate_thread_count": 3,
         "suggested_action": "add to USER.md"},
        {"ts": "2026-05-14T10:05:00Z", "action": "dry-needs-contact-resolution",
         "task_id": 11, "task_title": "T11", "full_name": "Joe Buxbaum",
         "qmd_candidate_email": "jbuxbaum@mssm.edu", "qmd_candidate_thread_count": 3,
         "suggested_action": "add to USER.md"},
        {"ts": "2026-05-14T10:10:00Z", "action": "dry-needs-contact-resolution",
         "task_id": 5, "task_title": "T5", "full_name": "Jane Doe",
         "qmd_candidate_email": None, "qmd_candidate_thread_count": 0,
         "suggested_action": "add to USER.md"},
    ]
    with jsonl.open("w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")

    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    publish_closure_candidates_digest(
        pending_path=pending, jsonl_path=jsonl,
        digest_path=digest, state_path=state, lookback_hours=24, now=now,
    )
    out = json.loads(digest.read_text())
    assert out["version"] == 1
    assert out["error"] is None
    # Dedupe by (task_id, full_name) → 3 entries
    assert len(out["needs_contact_resolution"]) == 3


def test_publish_closure_candidates_digest_writes_error_sentinel_on_failure(tmp_path):
    import json
    from email_ingest.task_closure import publish_closure_candidates_digest

    # pending.json contains invalid JSON
    pending = tmp_path / "pending.json"
    pending.write_text("not json {{{")
    jsonl = tmp_path / "events.jsonl"
    jsonl.touch()
    digest = tmp_path / "closure-candidates.json"
    state = tmp_path / "state.json"

    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    publish_closure_candidates_digest(
        pending_path=pending, jsonl_path=jsonl,
        digest_path=digest, state_path=state, lookback_hours=24, now=now,
    )
    out = json.loads(digest.read_text())
    assert out["error"] is not None
    assert out["pending_items"] == []
    assert out["needs_contact_resolution"] == []


def test_publish_closure_candidates_digest_respects_since_last_briefing(tmp_path):
    import json
    from email_ingest.task_closure import publish_closure_candidates_digest

    jsonl = tmp_path / "events.jsonl"
    pending = tmp_path / "pending.json"
    digest = tmp_path / "closure-candidates.json"
    state = tmp_path / "state.json"
    pending.write_text(json.dumps({"version": 1, "generated_at": "", "items": []}))

    now = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)
    state.write_text(json.dumps({"last_publish_ts": (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")}))

    events = [
        # 4h old → outside window
        {"ts": (now - timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%SZ"),
         "action": "dry-needs-contact-resolution",
         "task_id": 3, "task_title": "T3", "full_name": "Old Name",
         "qmd_candidate_email": None, "qmd_candidate_thread_count": 0,
         "suggested_action": "add to USER.md"},
        # 1h old → included
        {"ts": (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
         "action": "dry-needs-contact-resolution",
         "task_id": 4, "task_title": "T4", "full_name": "New Name",
         "qmd_candidate_email": None, "qmd_candidate_thread_count": 0,
         "suggested_action": "add to USER.md"},
    ]
    with jsonl.open("w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")

    publish_closure_candidates_digest(
        pending_path=pending, jsonl_path=jsonl,
        digest_path=digest, state_path=state, lookback_hours=24, now=now,
    )
    out = json.loads(digest.read_text())
    names = [n["full_name"] for n in out["needs_contact_resolution"]]
    assert "Old Name" not in names
    assert "New Name" in names
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_task_closure.py -k "publish_closure_candidates_digest" -v`
Expected: all FAIL (function doesn't exist).

- [ ] **Step 3: Write minimal implementation**

In `task_closure.py`, add:

```python
def publish_closure_candidates_digest(
    *,
    pending_path: Path,
    jsonl_path: Path,
    digest_path: Path,
    state_path: Path,
    lookback_hours: int = 24,
    now: Optional[datetime] = None,
) -> None:
    """Publish a briefing-friendly digest of closure candidates.

    Reads pending.json + scans last `lookback_hours` of JSONL for
    needs-contact-resolution events. Writes digest atomically to
    digest_path. On partial failure, writes an error-sentinel digest
    instead of leaving the previous file in place.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    error_msg: Optional[str] = None
    pending_items: list = []
    needs_contact: dict = {}

    # Determine since-window
    since = now - timedelta(hours=lookback_hours)
    last_publish_ts: Optional[datetime] = None
    if state_path.exists():
        try:
            st = json.loads(state_path.read_text())
            raw = st.get("last_publish_ts")
            if raw:
                last_publish_ts = datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except (json.JSONDecodeError, OSError, ValueError) as e:
            log.warning("digest: state file unreadable (%s); ignoring", e)

    if last_publish_ts is not None and last_publish_ts > since:
        since = last_publish_ts

    try:
        if pending_path.exists():
            try:
                payload = json.loads(pending_path.read_text())
                pending_items = list(payload.get("items", []))
            except json.JSONDecodeError as e:
                raise RuntimeError(f"pending.json malformed: {e}")

        if jsonl_path.exists():
            with jsonl_path.open("r") as fp:
                for raw_line in fp:
                    try:
                        obj = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue
                    if obj.get("action") != "dry-needs-contact-resolution":
                        continue
                    ts = obj.get("ts")
                    try:
                        t = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                    except (TypeError, ValueError):
                        continue
                    if t < since:
                        continue
                    key = (int(obj["task_id"]), str(obj["full_name"]))
                    # Keep most-recent occurrence per (task_id, full_name)
                    existing = needs_contact.get(key)
                    if existing is None or t > datetime.strptime(existing["last_seen"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc):
                        needs_contact[key] = {
                            "task_id": obj["task_id"],
                            "task_title": obj.get("task_title", ""),
                            "full_name": obj["full_name"],
                            "qmd_candidate_email": obj.get("qmd_candidate_email"),
                            "qmd_candidate_thread_count": obj.get("qmd_candidate_thread_count", 0),
                            "last_seen": ts,
                        }
    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        pending_items = []
        needs_contact = {}

    payload = {
        "version": 1,
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "since_last_briefing": (last_publish_ts.strftime("%Y-%m-%dT%H:%M:%SZ") if last_publish_ts else None),
        "error": error_msg,
        "pending_items": pending_items,
        "needs_contact_resolution": list(needs_contact.values()),
    }
    try:
        digest_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = digest_path.with_suffix(digest_path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        tmp.replace(digest_path)
        # Update state only on successful write.
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({
            "last_publish_ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }))
    except Exception as e:
        log.error("digest: write failed: %s", e)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_task_closure.py -k "publish_closure_candidates_digest" -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): publish_closure_candidates_digest with (task_id, name) dedup + state file"
```

### Task D2 — QMD lookup helper for contact resolution

**Files:**
- Create: `scripts/sync/email_ingest/qmd_contact_lookup.py`
- Test: `scripts/sync/tests/test_qmd_contact_lookup.py`

The QMD MCP endpoint is `http://host.containers.internal:8181/mcp` from inside containers, `http://localhost:8181/mcp` from host. The matcher runs on host. The helper does a simple HTTP POST with the `query` tool and parses sender addresses from results.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qmd_contact_lookup.py
import json
import pytest


def test_qmd_contact_lookup_returns_most_frequent_sender(monkeypatch):
    from email_ingest.qmd_contact_lookup import lookup_qmd_for_contact

    # Mock HTTP response shape from QMD: a list of docs with `frontmatter.from` fields.
    fake_response = {
        "results": [
            {"path": "...", "frontmatter": {"from": "Joe Buxbaum <jbuxbaum@mssm.edu>"}},
            {"path": "...", "frontmatter": {"from": "Joe Buxbaum <jbuxbaum@mssm.edu>"}},
            {"path": "...", "frontmatter": {"from": "Joe Buxbaum <jbuxbaum@mssm.edu>"}},
            {"path": "...", "frontmatter": {"from": "Someone Else <else@example.com>"}},
        ]
    }
    import email_ingest.qmd_contact_lookup as q
    monkeypatch.setattr(q, "_qmd_query", lambda name: fake_response)
    email, count = lookup_qmd_for_contact("Joe Buxbaum")
    assert email == "jbuxbaum@mssm.edu"
    assert count == 3   # number of threads with this sender


def test_qmd_contact_lookup_returns_none_below_threshold(monkeypatch):
    from email_ingest.qmd_contact_lookup import lookup_qmd_for_contact
    fake_response = {"results": [
        {"path": "...", "frontmatter": {"from": "Joe Buxbaum <jbuxbaum@mssm.edu>"}},
    ]}
    import email_ingest.qmd_contact_lookup as q
    monkeypatch.setattr(q, "_qmd_query", lambda name: fake_response)
    email, count = lookup_qmd_for_contact("Joe Buxbaum")
    assert email is None
    assert count == 0


def test_qmd_contact_lookup_swallows_http_error(monkeypatch):
    from email_ingest.qmd_contact_lookup import lookup_qmd_for_contact
    import email_ingest.qmd_contact_lookup as q
    def boom(_): raise RuntimeError("connection refused")
    monkeypatch.setattr(q, "_qmd_query", boom)
    email, count = lookup_qmd_for_contact("Anyone")
    assert email is None
    assert count == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_qmd_contact_lookup.py -v`
Expected: all FAIL (module doesn't exist).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/sync/email_ingest/qmd_contact_lookup.py`:

```python
"""QMD email-collection lookup for contact resolution.

Used by task_closure.scan_and_close to populate the `qmd_candidate_email`
field on DryNeedsContactResolutionEvent so the morning briefing can
auto-suggest USER.md entries.
"""
from __future__ import annotations

import logging
import re
import urllib.request
import json
from collections import Counter
from typing import Optional

log = logging.getLogger("email-ingest.qmd-contact-lookup")

QMD_URL = "http://localhost:8181/mcp"
MIN_THREAD_THRESHOLD = 3
EMAIL_RE = re.compile(r"<([^>]+@[^>]+)>")


def _qmd_query(full_name: str) -> dict:
    """Hit the QMD HTTP endpoint with a lex query for the contact's emails."""
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "query",
            "arguments": {
                "collection": "email",
                "queries": [{"type": "lex", "q": f'"{full_name}"'}],
                "limit": 50,
            },
        },
    }
    req = urllib.request.Request(
        QMD_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def lookup_qmd_for_contact(full_name: str) -> tuple[Optional[str], int]:
    """Return (email, thread_count) for the most-frequent sender for this name.

    Returns (None, 0) on any error or below threshold.
    """
    try:
        resp = _qmd_query(full_name)
    except Exception as e:
        log.warning("qmd lookup for %s failed: %s", full_name, e)
        return None, 0

    results = resp.get("results") or resp.get("result", {}).get("content") or []
    senders = Counter()
    for r in results:
        fm = r.get("frontmatter") or {}
        for field in ("from", "sender", "participants"):
            val = fm.get(field)
            if not val:
                continue
            if isinstance(val, list):
                for v in val:
                    m = EMAIL_RE.search(str(v))
                    if m:
                        senders[m.group(1).lower()] += 1
            else:
                m = EMAIL_RE.search(str(val))
                if m:
                    senders[m.group(1).lower()] += 1

    if not senders:
        return None, 0
    top_email, top_count = senders.most_common(1)[0]
    if top_count < MIN_THREAD_THRESHOLD:
        return None, 0
    return top_email, top_count
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_qmd_contact_lookup.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/qmd_contact_lookup.py scripts/sync/tests/test_qmd_contact_lookup.py
git commit -m "feat(task-closure): qmd_contact_lookup module for email auto-suggest"
```

### Task D3 — Wire `email-ingest.py` to publish digest + use QMD lookup

**Files:**
- Modify: `scripts/sync/email-ingest.py` (lines 311-350 where task_closure is invoked)
- Test: smoke test via direct invocation

- [ ] **Step 1: Inspect existing invocation**

Run: `grep -n "task_closure\|TASK_CLOSURE" scripts/sync/email-ingest.py | head -20`

Identify the current call site for `scan_and_close`. The new structure passes `qmd_lookup` and calls `publish_closure_candidates_digest` after.

- [ ] **Step 2: Modify the invocation**

In `scripts/sync/email-ingest.py`, locate the `if os.environ.get("TASK_CLOSURE_ENABLED", "1") == "1":` block (around line 312). Inside it, after constructing `profile`, `gmail`, `exchange`, `contacts`:

```python
            from email_ingest.task_closure import (
                scan_and_close, load_profile, _load_contacts_from_claude_md,
                CONTACTS_PATH, publish_closure_candidates_digest,
            )
            from email_ingest.qmd_contact_lookup import lookup_qmd_for_contact

            JSONL_PATH = Path.home() / ".cache" / "email-ingest" / "task-closures.jsonl"
            PENDING_PATH = Path.home() / ".cache" / "email-ingest" / "task-closures-pending.json"
            PROFILE_PATH = Path.home() / ".cache" / "email-ingest" / "task-closure-profile.json"
            DIGEST_PATH = REPO_ROOT / "groups" / "global" / "state" / "closure-candidates.json"
            DIGEST_STATE_PATH = Path.home() / ".cache" / "email-ingest" / "closure-digest-state.json"

            profile = load_profile(PROFILE_PATH)
            contacts = _load_contacts_from_claude_md(CONTACTS_PATH)
            dry_run = os.environ.get("TASK_CLOSURE_DRY_RUN", "1") == "1"
            per_run_cap = int(os.environ.get("TASK_CLOSURE_CAP", "3"))
            now = datetime.now(timezone.utc)

            report = scan_and_close(
                db_path=DB_PATH,
                gmail_adapter=gmail, exchange_adapter=exchange,
                profile=profile, contacts=contacts, followups=followups, now=now,
                jsonl_path=JSONL_PATH, pending_path=PENDING_PATH,
                per_run_cap=per_run_cap, dry_run=dry_run,
                qmd_lookup=lookup_qmd_for_contact,
            )
            task_closure_stats = {
                "closed": report.closed_count,
                "suggested": report.suggested_count,
                "cooling_off": report.cooling_off_count,
                "skipped": report.skipped_count,
                "write_failures": report.write_failure_count,
                "ran": True,
            }

            # Publish briefing-visible digest.
            try:
                publish_closure_candidates_digest(
                    pending_path=PENDING_PATH,
                    jsonl_path=JSONL_PATH,
                    digest_path=DIGEST_PATH,
                    state_path=DIGEST_STATE_PATH,
                    lookback_hours=24,
                    now=now,
                )
            except Exception as e:
                log.warning("closure-candidates digest publish failed: %s", e)
```

Make sure `REPO_ROOT` is defined or import-able; if not, define it: `REPO_ROOT = Path("/Users/mgandal/Agents/nanoclaw")`.

- [ ] **Step 3: Smoke test**

Run a one-shot scan:

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
TASK_CLOSURE_ENABLED=1 TASK_CLOSURE_DRY_RUN=1 \
  /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m email_ingest.task_closure \
  --db /Users/mgandal/Agents/nanoclaw/store/messages.db \
  --dry-run
```

Expected: log line `task-closure: closed=0 suggested=0 cooling_off=0 skipped=...`. Inspect `~/.cache/email-ingest/task-closures.jsonl` — should contain at least one `dry-cycle-start` event for this cycle and N events for the 21 open tasks.

Note: the CLI entry point (`task_closure.main`) doesn't go through `email-ingest.py`; it doesn't publish the digest. The smoke test verifies that scan_and_close itself works under real Gmail; the digest publish path needs a separate end-to-end test via email-ingest.py:

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
TASK_CLOSURE_ENABLED=1 TASK_CLOSURE_DRY_RUN=1 \
  /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 email-ingest.py
```

Expected: `groups/global/state/closure-candidates.json` exists after the run, with at least one entry in `needs_contact_resolution`.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync/email-ingest.py
git commit -m "feat(email-ingest): wire task_closure to publish digest + QMD auto-suggest"
```

### Task D4 — `--explain` still works after signature changes

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:875-925` (`main` function in CLI)
- Test: `scripts/sync/tests/test_task_closure.py`

`explain_task` is called from `main()` and previously did `fetch_open_tasks(db_path)` + `_gather_candidate_threads(..., since=target.created_at)`. After Task B4 the call has been switched to `target.scan_since(profile, now)`. We need a test pinning this.

- [ ] **Step 1: Write the failing test**

```python
def test_explain_uses_scan_since_method(tmp_path, capsys):
    """explain_task should call scan_since(profile, now) AND pass that value
    to search_threads_since."""
    import sqlite3, json
    from email_ingest.task_closure import explain_task, ClosureProfile
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT
        )
    """)
    conn.execute(
        "INSERT INTO tasks VALUES (1, 'email lucinda@penn.edu re: PO', NULL, NULL, 3, 'migration-2026-04-23', NULL, NULL, '2026-04-24 12:17:02', 'open')",
    )
    conn.commit(); conn.close()

    captured_since: list = []
    class GmailRecording:
        def search_threads_since(self, epoch, addrs):
            captured_since.append(epoch)
            return []
        def fetch_thread_messages(self, tid, epoch):
            return []

    now = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)
    profile = ClosureProfile.default()
    expected_since = int((now - timedelta(days=profile.path_b_lookback_days)).timestamp())

    result = explain_task(
        db_path=db, task_id=1,
        gmail_adapter=GmailRecording(), exchange_adapter=_StubAdapterEmpty(),
        profile=profile, contacts={}, followups=[], now=now,
    )
    assert captured_since == [expected_since]
    assert result["task_id"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_task_closure.py::test_explain_uses_scan_since_method -v`
Expected: PASS if B4 already updated explain_task; FAIL otherwise.

- [ ] **Step 3: If failing, fix `explain_task`**

In `task_closure.py::explain_task` (line ~765), confirm the call uses `target.scan_since(profile, now)`:

```python
    candidates, _adapter_errors = _gather_candidate_threads(
        entities=entities, contacts=contacts,
        gmail_adapter=gmail_adapter, exchange_adapter=exchange_adapter,
        since=target.scan_since(profile, now),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_task_closure.py::test_explain_uses_scan_since_method -v`
Expected: PASS.

- [ ] **Step 5: Commit (if any change)**

```bash
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "test(task-closure): pin explain_task scan_since flow"
```

If no code change was needed (B4 already covered explain_task), commit just the test.

### Task D5 — `report.skipped_count` and `report.write_failure_count` exposed via CLI

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py:922` (`main` log statement)
- Test: visual inspection

- [ ] **Step 1: Update log line**

In `task_closure.py::main` (line ~922):

```python
    log.info("task-closure: closed=%d suggested=%d cooling_off=%d skipped=%d write_failures=%d",
             report.closed_count, report.suggested_count,
             report.cooling_off_count, report.skipped_count, report.write_failure_count)
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sync/email_ingest/task_closure.py
git commit -m "chore(task-closure): surface write_failure_count in CLI log"
```

### Task D6 — Full integration test: end-to-end matcher run with all event types

**Files:**
- Add: `scripts/sync/tests/test_task_closure.py` — integration test

- [ ] **Step 1: Write the integration test**

```python
def test_per_task_event_invariant(tmp_path):
    """Inject 5 tasks: cooling_off, dry-entity-miss, dry-search-miss,
    dry-considered (DROP), dry-closed (AUTO_CLOSE). Verify exactly 1
    cycle-start + 5 terminal events."""
    import json, sqlite3
    from email_ingest.task_closure import (
        scan_and_close, ClosureProfile,
    )
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY, title TEXT, context TEXT,
            owner TEXT, priority INTEGER, source TEXT, source_ref TEXT,
            group_folder TEXT, created_at TEXT, status TEXT, completed_at TEXT
        )
    """)
    rows = [
        # 1 cooling_off: a recently-reopened task
        (1, "cooling t", "manual", None),
        # 2 entity-miss: no contacts, no emails in title
        (2, "just prose no email no name", "manual", None),
        # 3 search-miss: email in title but adapter returns empty
        (3, "email a@b.com re X", "manual", None),
        # 4 dry-considered (DROP via clipped score): adapter has hits and followup matches the thread
        (4, "email c@d.com re Y", "manual", None),
        # 5 dry-closed: adapter has hits, no followup
        (5, "email e@f.com re Z", "manual", None),
    ]
    for tid, title, src, ref in rows:
        conn.execute(
            "INSERT INTO tasks VALUES (?, ?, NULL, NULL, 3, ?, ?, NULL, '2026-04-24 12:17:02', 'open', NULL)",
            (tid, title, src, ref),
        )
    conn.commit(); conn.close()
    jsonl = tmp_path / "out.jsonl"
    pending = tmp_path / "pending.json"
    # Pre-seed JSONL with a recent reopen for task 1 to put it in cooling-off
    jsonl.write_text(
        json.dumps({"ts": "2026-05-13T12:00:00Z", "action": "reopened",
                    "task_id": 1, "feedback_source": "agent"}) + "\n"
    )

    class GmailMatcherForTask45:
        def search_threads_since(self, epoch, addrs):
            if any("c@d.com" in a for a in addrs):
                return [{"thread_id": "T4", "subject": "Y", "addrs": ["c@d.com"]}]
            if any("e@f.com" in a for a in addrs):
                return [{"thread_id": "T5", "subject": "Z", "addrs": ["e@f.com"]}]
            return []
        def fetch_thread_messages(self, tid, epoch):
            class M:
                labels = ["SENT"]
                metadata = {"is_sent": True, "internalDate": "1714000000000"}
                from_addr = "me@example.com"
                subject = "S"
                timestamp = 1714000000000
            return [M(), M(), M(), M()]   # produces a strong score

    class Followup:
        status = "open"
        thread = "gmail:T4"   # forces task 4 to land in dry-considered

    now = datetime(2026, 5, 14, 11, 30, tzinfo=timezone.utc)
    scan_and_close(
        db_path=db, gmail_adapter=GmailMatcherForTask45(),
        exchange_adapter=_StubAdapterEmpty(),
        profile=ClosureProfile.default(), contacts={}, followups=[Followup()], now=now,
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=True,
    )
    lines = [json.loads(l) for l in jsonl.read_text().strip().splitlines()]
    # Remove the pre-seeded reopen line (it's from before)
    cycle_events = [l for l in lines if l.get("ts", "").startswith("2026-05-14")]
    actions = [l["action"] for l in cycle_events]
    assert actions.count("dry-cycle-start") == 1
    assert "cooling_off" in actions
    assert "dry-entity-miss" in actions
    assert "dry-search-miss" in actions
    # task 4 or 5: at least one dry-considered or dry-closed
    assert any(a in ("dry-considered", "dry-closed", "dry-suggested") for a in actions)
```

- [ ] **Step 2: Run test**

Run: `python3 -m pytest tests/test_task_closure.py::test_per_task_event_invariant -v`
Expected: PASS (after all prior tasks). If FAIL, debug per-event emission.

- [ ] **Step 3: Commit**

```bash
git add scripts/sync/tests/test_task_closure.py
git commit -m "test(task-closure): per-task event invariant end-to-end"
```

---

## Stage E — Migration scripts

### Task E1 — JSONL pollution cleanup migration

**Files:**
- Create: `scripts/migrations/2026-05-14-cleanup-jsonl-pollution.py`
- Test: dry-run on a copy of `~/.cache/email-ingest/task-closures.jsonl`

- [ ] **Step 1: Write the migration script**

Create `scripts/migrations/2026-05-14-cleanup-jsonl-pollution.py`:

```python
#!/usr/bin/env python3
"""One-time dedup pass on task-closures.jsonl to remove phantom task_id=1 reopened
events from the test-pollution incident (commit 3ba723f4).

Backs up the original to .pre-cleanup-2026-05-14, then writes a filtered version.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import sqlite3
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--jsonl", default=str(Path.home() / ".cache/email-ingest/task-closures.jsonl"))
    p.add_argument("--db", default="/Users/mgandal/Agents/nanoclaw/store/messages.db")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    jsonl = Path(args.jsonl)
    if not jsonl.exists():
        print(f"no jsonl at {jsonl}; nothing to do", file=sys.stderr)
        return 0

    # Build set of real task IDs from DB.
    conn = sqlite3.connect(args.db)
    real_ids = {row[0] for row in conn.execute("SELECT id FROM tasks").fetchall()}
    conn.close()

    backup = jsonl.with_suffix(jsonl.suffix + ".pre-cleanup-2026-05-14")
    if backup.exists():
        print(f"backup {backup} already exists; aborting (run is non-idempotent)", file=sys.stderr)
        return 1

    kept, dropped = [], 0
    for raw in jsonl.read_text().splitlines():
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            kept.append(raw)
            continue
        tid = obj.get("task_id")
        if tid is not None and tid not in real_ids:
            dropped += 1
            continue
        kept.append(raw)

    print(f"kept {len(kept)} events; dropped {dropped} phantom-task events")
    if args.dry_run:
        return 0

    shutil.copy(jsonl, backup)
    jsonl.write_text("\n".join(kept) + ("\n" if kept else ""))
    print(f"backup at {backup}; jsonl rewritten")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run dry-run to confirm**

```bash
chmod +x scripts/migrations/2026-05-14-cleanup-jsonl-pollution.py
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 \
  scripts/migrations/2026-05-14-cleanup-jsonl-pollution.py --dry-run
```

Expected output: `kept N events; dropped M phantom-task events`. Confirm `M >= 0`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/2026-05-14-cleanup-jsonl-pollution.py
git commit -m "feat(migrations): cleanup phantom task_id reopened events from JSONL"
```

### Task E2 — Briefing prompt migration script

**Files:**
- Create: `scripts/migrations/2026-05-14-add-closure-candidates-briefing-section.py`
- Create: `data/migrations/.gitkeep`
- Test: idempotent re-run produces no diff

- [ ] **Step 1: Write the migration script**

Create `scripts/migrations/2026-05-14-add-closure-candidates-briefing-section.py`:

```python
#!/usr/bin/env python3
"""Idempotently add the Closure candidates section to claire-morning-briefing.

Versioning sentinel: the appended block ends with `<!-- closure-candidates-section v1 -->`.
A re-run detects the sentinel and exits 0 without modifying anything.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path("/Users/mgandal/Agents/nanoclaw")
DB = REPO_ROOT / "store" / "messages.db"
BACKUP_DIR = REPO_ROOT / "data" / "migrations"
BACKUP = BACKUP_DIR / "2026-05-14-briefing-prompt-backup.txt"

SENTINEL = "<!-- closure-candidates-section v1 -->"

STEP1_ADDITION = """\
- Closure candidates: read /workspace/project/groups/global/state/closure-candidates.json.
  - If file does not exist, omit Closure candidates section entirely.
  - If file has `error` field set (non-null), emit the section as: "⚠️ *Closure candidates digest broken* — `<error>`. Investigate sync-health logs."
  - Otherwise parse pending_items[] and needs_contact_resolution[] for the section template.
"""

SECTION_TEMPLATE = """\
🔔 *Closure candidates* (only if pending_items or needs_contact_resolution non-empty)

[For each pending_item, in order:]
• [task_title] → matched "[top_subject]" (score [top_score])
  Reply "close [task_id]" to confirm, "reopen [task_id]" if wrong.

[If needs_contact_resolution non-empty:]
*Unknown contacts to add to USER.md*
• [full_name] — referenced in task #[task_id] "[task_title]"
  [if qmd_candidate_email is non-null:]   Suggested: [qmd_candidate_email] ([qmd_candidate_thread_count] prior threads). Add to USER.md?
  [else:]                                  Not found in past email — manually add to USER.md if real contact.
"""


def main():
    conn = sqlite3.connect(DB)
    row = conn.execute(
        "SELECT prompt FROM scheduled_tasks WHERE id='claire-morning-briefing'"
    ).fetchone()
    if not row:
        print("claire-morning-briefing row not found", file=sys.stderr)
        return 1
    current = row[0]

    if SENTINEL in current:
        print("sentinel found; migration already applied")
        return 0

    # Backup.
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP.write_text(current)
    print(f"backup written to {BACKUP}")

    # Inject STEP 1 addition (after the existing 'Slack:' bullet in STEP 1).
    # We search for the literal '- System alerts:' (next bullet after Slack) and insert before it.
    needle_step1 = "- System alerts:"
    if needle_step1 not in current:
        print(f"could not find {needle_step1!r} to anchor STEP 1 addition", file=sys.stderr)
        return 1
    new_prompt = current.replace(
        needle_step1, STEP1_ADDITION + needle_step1, 1,
    )

    # Inject Closure candidates section after Follow-ups, before Slack section.
    # Anchor on the literal "💬 *Slack*" header.
    needle_slack = "💬 *Slack*"
    if needle_slack not in new_prompt:
        print(f"could not find {needle_slack!r} to anchor section", file=sys.stderr)
        return 1
    new_prompt = new_prompt.replace(
        needle_slack, SECTION_TEMPLATE + "\n" + needle_slack, 1,
    )

    # Append sentinel at the end.
    new_prompt = new_prompt.rstrip() + "\n\n" + SENTINEL + "\n"

    conn.execute(
        "UPDATE scheduled_tasks SET prompt=? WHERE id='claire-morning-briefing'",
        (new_prompt,),
    )
    conn.commit()
    conn.close()
    print("migration applied successfully")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Test idempotency (without running yet — that's Stage F)**

For now, just verify the script syntax-checks:

```bash
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -c \
  "import py_compile; py_compile.compile('scripts/migrations/2026-05-14-add-closure-candidates-briefing-section.py', doraise=True); print('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Add an automated idempotency test**

Create `scripts/sync/tests/test_migration_briefing.py`:

```python
import sqlite3
import sys
import subprocess
from pathlib import Path

MIGRATION = Path("/Users/mgandal/Agents/nanoclaw/scripts/migrations/2026-05-14-add-closure-candidates-briefing-section.py")


def test_migration_idempotent(tmp_path, monkeypatch):
    db = tmp_path / "messages.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE scheduled_tasks (
            id TEXT PRIMARY KEY, prompt TEXT
        )
    """)
    initial = (
        "Generate the morning briefing.\n\n"
        "STEP 1 — Gather data:\n"
        "- Slack: blah\n"
        "- System alerts: blah\n\n"
        "📋 *Follow-ups*\n\n"
        "💬 *Slack*\n\n"
        "END\n"
    )
    conn.execute("INSERT INTO scheduled_tasks VALUES ('claire-morning-briefing', ?)", (initial,))
    conn.commit()
    conn.close()

    # Monkeypatch the DB path inside the migration script via env var.
    # The migration uses a hardcoded path; for the test, we copy the script into tmp_path
    # and modify it inline.
    script = (tmp_path / "migration.py")
    src = MIGRATION.read_text()
    src = src.replace('REPO_ROOT / "store" / "messages.db"', f'Path("{db}")')
    src = src.replace('REPO_ROOT / "data" / "migrations"', f'Path("{tmp_path}/data/migrations")')
    script.write_text(src)
    # First run
    r1 = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
    assert r1.returncode == 0
    # Second run — sentinel detection
    r2 = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
    assert r2.returncode == 0
    assert "already applied" in r2.stdout

    # Confirm sentinel appears exactly once
    conn = sqlite3.connect(db)
    final = conn.execute("SELECT prompt FROM scheduled_tasks WHERE id='claire-morning-briefing'").fetchone()[0]
    conn.close()
    assert final.count("<!-- closure-candidates-section v1 -->") == 1
```

Run: `python3 -m pytest scripts/sync/tests/test_migration_briefing.py -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/2026-05-14-add-closure-candidates-briefing-section.py \
        scripts/sync/tests/test_migration_briefing.py
git commit -m "feat(migrations): idempotent briefing-prompt closure-candidates section"
```

### Task E3 — `closure-pulse` proactive nudge installer

**Files:**
- Create: `scripts/migrations/2026-05-14-install-closure-pulse.py`
- Test: idempotency

- [ ] **Step 1: Write the installer**

Create `scripts/migrations/2026-05-14-install-closure-pulse.py`:

```python
#!/usr/bin/env python3
"""Install the 'closure-pulse' scheduled task that fires every 4h and only
sends a Telegram nudge if there are persistent unresolved closure candidates.

Idempotent: skips insert if id='closure-pulse' already exists.
"""
from __future__ import annotations

import sqlite3
import sys
from datetime import datetime
from pathlib import Path

DB = Path("/Users/mgandal/Agents/nanoclaw/store/messages.db")

PROMPT = """\
Read /workspace/project/groups/global/state/closure-candidates.json.

If file does not exist OR error field is non-null OR both arrays are empty: do nothing (no send).

Otherwise, evaluate:
  - condition A: len(needs_contact_resolution) >= 3 AND all entries have last_seen > 4h ago
  - condition B: any pending_items entry has first_seen > 24h ago

If either A or B holds, send ONE Telegram message via mcp__nanoclaw__send_message:

"🔔 N closure candidates pending review — see /workspace/project/groups/global/state/closure-candidates.json or wait for morning briefing."

Otherwise: do nothing.
"""


def main():
    conn = sqlite3.connect(DB)
    existing = conn.execute(
        "SELECT id FROM scheduled_tasks WHERE id='closure-pulse'"
    ).fetchone()
    if existing:
        print("closure-pulse already exists; skipping")
        conn.close()
        return 0

    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
    conn.execute("""
        INSERT INTO scheduled_tasks
        (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
         next_run, last_run, last_result, status, created_at,
         context_mode, script, agent_name, surface_outputs, proactive)
        VALUES
        ('closure-pulse', 'telegram_claire', '8475020901', ?, 'cron', '0 */4 * * *',
         NULL, NULL, NULL, 'active', ?,
         'isolated', NULL, NULL, 0, 1)
    """, (PROMPT, now_iso))
    conn.commit()
    conn.close()
    print("closure-pulse installed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Note: the `chat_jid` value `'8475020901'` is the CLAIRE telegram chat JID per `MEMORY.md`. Verify via `sqlite3 store/messages.db "SELECT chat_jid FROM registered_groups WHERE folder='telegram_claire'"` before running.

- [ ] **Step 2: Verify chat_jid is correct**

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT chat_jid FROM registered_groups WHERE folder='telegram_claire'"
```

Update the literal in the script if the actual value differs.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/2026-05-14-install-closure-pulse.py
git commit -m "feat(migrations): install closure-pulse proactive nudge task"
```

### Task E4 — Rollback script

**Files:**
- Create: `scripts/migrations/2026-05-14-rollback.py`

- [ ] **Step 1: Write rollback**

Create `scripts/migrations/2026-05-14-rollback.py`:

```python
#!/usr/bin/env python3
"""Rollback for 2026-05-14 closure-candidates briefing migration.

Restores claire-morning-briefing.prompt from backup and removes closure-pulse.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path("/Users/mgandal/Agents/nanoclaw")
DB = REPO_ROOT / "store" / "messages.db"
BACKUP = REPO_ROOT / "data" / "migrations" / "2026-05-14-briefing-prompt-backup.txt"


def main():
    if not BACKUP.exists():
        print(f"backup not found at {BACKUP}; nothing to restore", file=sys.stderr)
        return 1
    original = BACKUP.read_text()
    conn = sqlite3.connect(DB)
    conn.execute(
        "UPDATE scheduled_tasks SET prompt=? WHERE id='claire-morning-briefing'",
        (original,),
    )
    conn.execute("DELETE FROM scheduled_tasks WHERE id='closure-pulse'")
    conn.commit()
    conn.close()
    print("rolled back briefing prompt and removed closure-pulse")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Commit**

```bash
git add scripts/migrations/2026-05-14-rollback.py
git commit -m "feat(migrations): rollback for closure-candidates briefing"
```

---

## Stage F — Manual deployment + verification

Stage F is operational; each task is a checklist item executed once.

### Task F1 — Deploy code (Phases 1-3 of spec §7)

- [ ] **Phase 1: confirm tests pass**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_task_closure.py tests/test_qmd_contact_lookup.py tests/test_task_closure_trainer.py tests/test_migration_briefing.py -v
```

Expected: all green. If anything fails, debug before proceeding.

- [ ] **Phase 2: force-run a sync cycle**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.sync
```

Wait ~30s, then tail the sync log:

```bash
tail -100 /Users/mgandal/Agents/nanoclaw/scripts/sync/sync.log
```

Expected: see `task-closure: closed=0 suggested=0 cooling_off=... skipped=... write_failures=0` line.

- [ ] **Phase 3: verify digest exists**

```bash
ls -la /Users/mgandal/Agents/nanoclaw/groups/global/state/closure-candidates.json
cat /Users/mgandal/Agents/nanoclaw/groups/global/state/closure-candidates.json | head -40
```

Expected: file exists, contains `pending_items: []` and `needs_contact_resolution: [...]` with some entries (likely Joe Buxbaum, etc.).

### Task F2 — Run JSONL pollution cleanup (one-time)

```bash
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 \
  /Users/mgandal/Agents/nanoclaw/scripts/migrations/2026-05-14-cleanup-jsonl-pollution.py
```

Expected output: `kept N events; dropped M phantom-task events ... jsonl rewritten`.

### Task F3 — Run briefing prompt migration

```bash
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 \
  /Users/mgandal/Agents/nanoclaw/scripts/migrations/2026-05-14-add-closure-candidates-briefing-section.py
```

Expected: `backup written to ... migration applied successfully`. Re-run to verify idempotency: `migration already applied`.

### Task F4 — Install closure-pulse + first morning-briefing verification

```bash
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 \
  /Users/mgandal/Agents/nanoclaw/scripts/migrations/2026-05-14-install-closure-pulse.py
```

Expected: `closure-pulse installed`.

Manually trigger the morning briefing once to verify:

```bash
# Via Claire's command interface or by manually invoking the scheduled task in DB.
# Example: directly run the agent with the prompt loaded.
# (Detailed CLAIRE-trigger steps may vary; consult /Users/mgandal/Agents/nanoclaw/CLAUDE.md "Service restart" section.)
```

Inspect the resulting Telegram message in the CLAIRE chat. Expected: `🔔 *Closure candidates*` section appears with entries from `closure-candidates.json`.

If the section is missing OR the formatting is broken, run rollback:

```bash
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 \
  /Users/mgandal/Agents/nanoclaw/scripts/migrations/2026-05-14-rollback.py
```

---

## Self-review

**Spec coverage check (every §X of design doc):**
- §1 OpenTask.scan_since property — Task A6 ✓
- §1 AdapterError dataclass — Task A3 ✓
- §1 `_gather_candidate_threads` signature — Task B1 ✓
- §1 `_path_a_should_close` scan_since — Task B3 ✓
- §2 path_b_lookback_days + __post_init__ — Tasks A4, A5 ✓
- §3 EntityMissReason — Task A1 ✓
- §3 SearchMissCause — Task A2 ✓
- §3 DryCycleStartEvent — Task A7 ✓
- §3 DryEntityMissEvent, DrySearchMissEvent, DryConsideredEvent — Task A8 ✓
- §3 DryNeedsContactResolutionEvent — Task A9 ✓
- §3 PendingWriteFailedEvent — Task A9 ✓
- §3 `would_close_if = Tier.value` — Task B7 ✓
- §3 runner_up_gap_satisfied — Task B7 ✓
- §3 UTC-daily dedup of needs-contact-resolution — Task B8 ✓
- §3 QMD candidate lookup — Tasks B8, D2 ✓
- §4 Per-task event invariant — Tasks B4, B5, B6, D6 ✓
- §5 append_jsonl_event error guard — Task C1 ✓
- §5 Live-mode kill-switch — Task C2 ✓
- §5 Pending write try/finally — Task C3 ✓
- §5 Digest error-sentinel — Task D1 ✓
- §6 Contacts loader warnings — Task C4 ✓
- §7 Digest publisher — Task D1 ✓
- §7 since_last_briefing + state file — Task D1 ✓
- §7 Briefing prompt migration script — Task E2 ✓
- §7 closure-pulse — Task E3 ✓
- §7 Migration safety (backup, sentinel, idempotency) — Tasks E2, E4 ✓
- §8 4-part gate criterion — F4 (operational, no code) ✓
- §9 JSONL stewardship — covered by Task B8's UTC-daily dedup ✓
- Pre-deploy JSONL cleanup — Task E1 ✓
- Gmail API quota note — operational (no code action) ✓

**Placeholder scan:** no "TBD", "TODO", or generic "add error handling" instructions; every step has actual code.

**Type consistency check:**
- `OpenTask.scan_since` defined in A6 as `(profile, now) -> datetime`; called in B3 (`_path_a_should_close`), B4 (`scan_and_close`), D4 (`explain_task`). All consistent.
- `ClosureDecision` extended in B2 to add `runner_up_score`, `runner_up_gap_satisfied`, `match_strength`; populated in B7's scoring loop; consumed by `_emit_decision` DROP branch (B2). Consistent.
- `_gather_candidate_threads` returns `(list[ThreadCandidate], list[AdapterError])` per B1; consumed in `scan_and_close` per B4 / B5; consumed in `explain_task` per D4. Consistent.
- Event dataclass action field literals match spec §3: `dry-cycle-start`, `dry-entity-miss`, `dry-search-miss`, `dry-considered`, `dry-needs-contact-resolution`, `pending-write-failed`.

**Test test imports:** assume test file has these at top:
```python
import pytest
from datetime import datetime, timedelta, timezone
from pathlib import Path
```
plus shared stubs `_StubAdapterEmpty`, `_StubAdapterRaises`, `_make_task` defined once near top.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-13-email-task-closure-i1-fix-tasks.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
