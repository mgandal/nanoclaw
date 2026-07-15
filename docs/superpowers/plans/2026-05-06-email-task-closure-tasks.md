# Email-Driven Task Closure — Detailed Tasks

Companion to `2026-05-06-email-task-closure.md`. Engineers should not skip ahead between stages.

This file is intentionally large; for hook compatibility the schema-setup blocks in the test fixtures use `db.run(...)` for individual statements rather than batched-statement helpers. The semantics are identical for the test scenarios; if the engineer prefers the batched form, both `Database.exec` and `Database.run` are valid in `bun:sqlite` for the table creation statements shown.

## Stage A — Host-side IPC: task_reopen

### Task A1 — Add reopenTask() to src/tasks.ts

**Files:**
- Modify: `src/tasks.ts` (after `closeTask` block, near line 320)
- Test: `src/tasks-ipc-reopen.test.ts` (new)

#### Step 1: Failing test

Create `src/tasks-ipc-reopen.test.ts`. The test creates an in-memory SQLite database with the same shape as `store/messages.db`, inserts a task via `addTask`, marks it done with a direct UPDATE, and then verifies that `reopenTask` flips it back to `open` and clears `completed_at`. Mirror the test setup pattern already used in `src/tasks-ipc.test.ts` (use the same `__setDbForTests`/`__resetDbForTests` helpers if they exist; otherwise mirror whatever pattern that file uses).

Key assertions:
- After reopen: `status === 'open'`, `completed_at === null`, context contains `[reopened: <reason>]`.
- Reopen on an already-open task returns `{ success: false, error: <contains "not closed"> }`.
- Reopen on missing id returns `{ success: false, error: <contains "not found"> }`.
- Reopen preserves and appends to existing context with a newline separator.

Use four `it(...)` cases — one per assertion above. Use `bun:sqlite`'s `Database` for the in-memory store.

#### Step 2: Run failing test

```
bun --bun vitest run src/tasks-ipc-reopen.test.ts
```

Expected: FAIL — `reopenTask is not exported from './tasks.js'`.

#### Step 3: Implement reopenTask in src/tasks.ts

Add types near the other input/result types (around line 75, near `TaskCloseInput`):

```ts
export interface TaskReopenInput {
  id: number;
  reason: string;
}

export interface TaskReopenResult {
  success: boolean;
  id?: number;
  status?: 'open';
  error?: string;
}
```

After the `closeTask()` block ending near line 320, add the implementation. The function:
1. Validates `input.id` is a positive integer; returns `{ success: false, error: 'id must be a positive integer' }` otherwise.
2. SELECTs `id, status, context FROM tasks WHERE id = ?`.
3. Returns `{ success: false, error: 'task <id> not found' }` if no row.
4. Returns `{ success: false, error: 'task <id> is not closed (status=<s>)' }` if `status === 'open'`.
5. Appends `[reopened: <reason truncated to 200 chars>]` to existing context (newline-separated) or makes it the new context.
6. Runs `UPDATE tasks SET status='open', completed_at=NULL, context=? WHERE id=? AND status!='open' RETURNING id, status` and treats `rowcount=0` as a race (`{ success: false, error: 'race: task changed status during reopen' }`).
7. Logs `{ taskId, reason }` at info level on success.
8. Returns `{ success: true, id, status: 'open' }`.

Use `db()` accessor (same pattern as `closeTask`).

#### Step 4: Run to confirm pass

```
bun --bun vitest run src/tasks-ipc-reopen.test.ts
```

Expected: PASS — 4 tests.

#### Step 5: Run full TS suite

```
bun --bun vitest run
```

Expected: PASS, no regressions.

#### Step 6: Commit

```
git add src/tasks.ts src/tasks-ipc-reopen.test.ts
git commit -m "feat(tasks): add reopenTask() helper"
```

### Task A2 — Wire task_reopen into the IPC handler

**Files:**
- Modify: `src/tasks-ipc.ts` (line 15 imports, line 18 `TASK_TYPES`, branch inside `handleTasksIpc`)
- Test: extend `src/tasks-ipc-reopen.test.ts`

#### Step 1: Failing test for IPC dispatch

Append a new `describe('handleTasksIpc — task_reopen', ...)` block. Two `it(...)` cases:
1. **Success path:** add a task, mark done, call `handleTasksIpc({ type: 'task_reopen', requestId: 'req-test-1', id, reason: 'wrong thread' }, 'telegram_claire', true, dataDir)`. Expect `handled === true`, then read `<dataDir>/ipc/telegram_claire/task_results/req-test-1.json`, parse, expect `success: true, id: <task id>`.
2. **Malformed requestId:** call with `requestId: '../escape'`. Expect handler returns `true` (drop is reported as handled) and `<dataDir>/ipc/` does NOT exist.

Use `fs.mkdtempSync` for `dataDir`; clean up with `fs.rmSync(..., {recursive: true, force: true})` in `afterEach`.

#### Step 2: Run to confirm fail

```
bun --bun vitest run src/tasks-ipc-reopen.test.ts
```

Expected: FAIL — `task_reopen` not handled (existing branch returns `false` on unknown types, so the result file never gets written).

#### Step 3: Wire the handler in src/tasks-ipc.ts

Update line 15 imports:

```ts
import { addTask, closeTask, listTasksDetailed, reopenTask } from './tasks.js';
```

Update line 18 `TASK_TYPES`:

```ts
const TASK_TYPES = new Set(['task_add', 'task_list', 'task_close', 'task_reopen']);
```

Inside `handleTasksIpc`, add a new branch after the `task_close` branch (just before the `} catch (err) {`). The branch should:
1. Validate `data.id` is a positive integer; on failure call `writeResult({ success: false, error: 'id must be a positive integer' })` and return `true`.
2. Read `data.reason` as string; require non-empty after trim. On failure: `writeResult({ success: false, error: 'reason is required' })` and return `true`.
3. Call `reopenTask({ id, reason })`, write the result, log info with `{ sourceGroup, isMain, taskId: id, success }`, return `true`.

#### Step 4: Run to confirm pass

```
bun --bun vitest run src/tasks-ipc-reopen.test.ts
```

Expected: PASS — all reopen tests green.

#### Step 5: Full TS suite

```
bun --bun vitest run
```

Expected: PASS.

#### Step 6: Commit

```
git add src/tasks.ts src/tasks-ipc.ts src/tasks-ipc-reopen.test.ts
git commit -m "feat(tasks-ipc): handle task_reopen requests"
```

### Task A3 — Expose nanoclaw.task_reopen MCP tool

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (after the `task_close` `server.tool` block ending around line 1036)

#### Step 1: Add the MCP tool wrapper

Add a new `server.tool('task_reopen', ...)` block. The description must include:
- "Reopen a previously closed task" lead.
- Use-when: user disputes auto-closure in morning digest; user types `/reopen <id> <reason>`; you closed in error.
- Do-not-use-for: already-open tasks; editing in flight.
- Inputs: `id` (positive int, required), `reason` (non-empty string, required, used by trainer).
- Returns shape on success and on failure.

Schema (Zod): `{ id: z.number().int().positive(), reason: z.string().min(1) }`.

Handler: same pattern as `task_close` (line 1021–1035): generate `requestId` like `treopen-<ts>-<rand>`, call `writeIpcFile(TASKS_DIR, { type: 'task_reopen', requestId, ...args, groupFolder, timestamp })`, await `waitForIpcResult(TASK_RESULTS_DIR, requestId, 30000)`, return `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !success }`.

#### Step 2: Type-check the container code

```
cd container/agent-runner && bun run typecheck
```

Expected: clean. Fall back to `bun --bun tsc --noEmit -p container/agent-runner` if no typecheck script.

#### Step 3: Rebuild the agent-runner artifact

```
./container/build.sh
```

Expected: build success.

#### Step 4: Smoke-test from the host

```
ls container/agent-runner/dist/ipc-mcp-stdio.js
grep -c "'task_reopen'" container/agent-runner/dist/ipc-mcp-stdio.js
```

Expected: file exists; count >= 1.

#### Step 5: Commit

```
git add container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/dist/
git commit -m "feat(agent-runner): expose nanoclaw.task_reopen MCP tool"
```

> If `dist/` is gitignored, only commit the source file.

---

## Stage B — Python module: task_closure.py

This is the heart of the system. Build under TDD, one rule at a time. All tests live in `scripts/sync/tests/test_task_closure.py`. Canonical interpreter: `/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3` (matches the trainer plist).

### Task B1 — Module skeleton + types + first test

**Files:**
- Create: `scripts/sync/email_ingest/task_closure.py`
- Create: `scripts/sync/tests/test_task_closure.py`

#### Step 1: Failing test

Create `scripts/sync/tests/test_task_closure.py`:

```python
"""Unit tests for email_ingest.task_closure."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from email_ingest.task_closure import (
    ClosureProfile,
    OpenTask,
    ThreadActivity,
    ClosureDecision,
    score_candidate,
    Tier,
    DEFAULT_PROFILE,
)

def test_profile_defaults():
    p = ClosureProfile.default()
    assert p.contact_base_trust == 0.7
    assert p.default_base_trust == 0.5
    assert p.thresholds["auto_close"] == 0.75
    assert p.thresholds["suggest"] == 0.55
```

#### Step 2: Run to confirm fail

```
cd scripts/sync && /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_task_closure.py -v
```

Expected: FAIL — module does not exist.

#### Step 3: Create the skeleton

Create `scripts/sync/email_ingest/task_closure.py`:

```python
"""Email-driven auto-closure of tasks in store/messages.db.

Runs at the end of each email-ingest cycle. Reads open tasks via direct
SQLite, scores each against candidate Gmail/Exchange threads, and closes
high-confidence matches. Mirrors email_ingest.closure (followups.md) but
writes to the SQL tasks table.

See docs/superpowers/specs/2026-05-06-email-task-closure-design.md.
"""
from __future__ import annotations

import enum
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

log = logging.getLogger("email-ingest.task-closure")

class Tier(enum.Enum):
    AUTO_CLOSE = "auto_close"
    SUGGEST = "suggest"
    DROP = "drop"

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
    created_at: datetime  # UTC

@dataclass(frozen=True)
class ThreadActivity:
    thread_ref: str  # "gmail:<id>" | "exchange:<id>"
    subject: str
    user_sent_count: int
    counterparty_replied_count: int
    last_activity: datetime
    counterparty_addrs: tuple[str, ...]

@dataclass
class ClosureProfile:
    contact_base_trust: float
    default_base_trust: float
    thresholds: dict[str, float]
    counterparty_trust: dict[str, float] = field(default_factory=dict)
    rule_precision: dict[str, float] = field(default_factory=dict)
    version: int = 1

    @classmethod
    def default(cls) -> "ClosureProfile":
        return cls(
            contact_base_trust=0.7,
            default_base_trust=0.5,
            thresholds={"auto_close": 0.75, "suggest": 0.55},
        )

DEFAULT_PROFILE = ClosureProfile.default()

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

def score_candidate(*args, **kwargs) -> float:
    """Score a (task, thread) pair. Implementation in Task B2."""
    raise NotImplementedError("filled in Task B2")
```

#### Step 4: Pass

```
cd scripts/sync && /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_task_closure.py -v
```

Expected: PASS — 1 test.

#### Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(email-ingest): scaffold task_closure module"
```

### Task B2 — Scoring function (TDD)

**Files:** modify both `task_closure.py` and `test_task_closure.py`.

#### Step 1: Failing tests

Append to test file:

```python
def _now() -> datetime:
    return datetime(2026, 5, 5, 12, 0, 0, tzinfo=timezone.utc)

def _task(**overrides) -> OpenTask:
    base = dict(
        id=42, title="Respond to Elise email", context=None, owner="mike",
        priority=3, source="manual", source_ref=None, group_folder=None,
        created_at=_now() - timedelta(days=1),
    )
    base.update(overrides)
    return OpenTask(**base)

def _thread(**overrides) -> ThreadActivity:
    base = dict(
        thread_ref="gmail:abc", subject="Re: 10X PO status",
        user_sent_count=0, counterparty_replied_count=0,
        last_activity=_now(), counterparty_addrs=(),
    )
    base.update(overrides)
    return ThreadActivity(**base)

def test_score_full_signal_known_contact():
    score = score_candidate(
        task=_task(),
        thread=_thread(
            user_sent_count=1, counterparty_replied_count=1,
            counterparty_addrs=("lucinda.bertsinger@pennmedicine.upenn.edu",),
        ),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    assert 0.90 <= score <= 1.0

def test_score_unknown_full_name_only_below_auto_close():
    score = score_candidate(
        task=_task(),
        thread=_thread(
            counterparty_replied_count=1,
            counterparty_addrs=("joe.buxbaum@example.org",),
        ),
        match_strength=0.8, is_known_contact=False,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    assert 0.65 <= score <= 0.75
    assert score < 0.75

def test_score_recency_decay():
    fresh = score_candidate(
        task=_task(created_at=_now() - timedelta(days=60)),
        thread=_thread(last_activity=_now()),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    stale = score_candidate(
        task=_task(created_at=_now() - timedelta(days=60)),
        thread=_thread(last_activity=_now() - timedelta(days=20)),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    assert fresh > stale

def test_score_multi_open_task_penalty():
    base = score_candidate(
        task=_task(), thread=_thread(user_sent_count=1),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    penalized = score_candidate(
        task=_task(), thread=_thread(user_sent_count=1),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=1,
    )
    assert base - penalized == pytest.approx(0.30, abs=0.001)

def test_score_clamps_to_unit_interval():
    score = score_candidate(
        task=_task(),
        thread=_thread(user_sent_count=1, counterparty_replied_count=1),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    assert 0.0 <= score <= 1.0
```

#### Step 2: Fail

```
cd scripts/sync && /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_task_closure.py -v
```

Expected: 5 FAIL with `NotImplementedError`.

#### Step 3: Implement

Replace the `score_candidate` stub:

```python
def _recency_factor(last_activity: datetime, now: datetime) -> float:
    delta = now - last_activity
    if delta.total_seconds() < 0:
        return 1.0
    if delta <= timedelta(hours=24):
        return 1.0
    if delta <= timedelta(days=7):
        return 0.8
    if delta <= timedelta(days=30):
        return 0.5
    return 0.2

def score_candidate(
    *,
    task: OpenTask,
    thread: ThreadActivity,
    match_strength: float,
    is_known_contact: bool,
    profile: ClosureProfile,
    now: datetime,
    same_thread_other_open_tasks: int,
) -> float:
    base_trust = (
        profile.contact_base_trust if is_known_contact
        else profile.default_base_trust
    )
    cp_trust = base_trust
    for addr in thread.counterparty_addrs:
        if addr in profile.counterparty_trust:
            cp_trust = profile.counterparty_trust[addr]
            break

    score = 0.0
    score += match_strength * 0.40
    score += _recency_factor(thread.last_activity, now) * 0.20
    score += cp_trust * 0.20
    if thread.user_sent_count > 0:
        score += 0.20
    if thread.counterparty_replied_count > 0:
        score += 0.10
    if same_thread_other_open_tasks > 0:
        score -= 0.30
    return max(0.0, min(1.0, score))
```

#### Step 4: Pass

```
cd scripts/sync && /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_task_closure.py -v
```

Expected: PASS — 6 tests.

#### Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): scoring function"
```

### Task B3 — Tier assignment with runner-up gap

#### Step 1: Failing tests

```python
from email_ingest.task_closure import assign_tier

def test_tier_auto_close_clear_winner():
    assert assign_tier(top_score=0.86, runner_up=0.40, profile=DEFAULT_PROFILE) == Tier.AUTO_CLOSE

def test_tier_too_close_to_call_drops_to_suggest():
    assert assign_tier(top_score=0.80, runner_up=0.78, profile=DEFAULT_PROFILE) == Tier.SUGGEST

def test_tier_just_above_suggest():
    assert assign_tier(top_score=0.60, runner_up=0.20, profile=DEFAULT_PROFILE) == Tier.SUGGEST

def test_tier_below_floor_drops():
    assert assign_tier(top_score=0.40, runner_up=0.10, profile=DEFAULT_PROFILE) == Tier.DROP

def test_tier_no_runner_up_uses_zero():
    assert assign_tier(top_score=0.80, runner_up=None, profile=DEFAULT_PROFILE) == Tier.AUTO_CLOSE
```

#### Step 2: Fail / Step 3: Implement

```python
RUNNER_UP_GAP_REQUIRED = 0.20

def assign_tier(
    *,
    top_score: float,
    runner_up: Optional[float],
    profile: ClosureProfile,
) -> Tier:
    auto = profile.thresholds.get("auto_close", 0.75)
    suggest = profile.thresholds.get("suggest", 0.55)
    runner = runner_up if runner_up is not None else 0.0
    if top_score >= auto and (top_score - runner) >= RUNNER_UP_GAP_REQUIRED:
        return Tier.AUTO_CLOSE
    if top_score >= suggest:
        return Tier.SUGGEST
    return Tier.DROP
```

#### Step 4: Pass / Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): tier assignment with runner-up gap rule"
```

### Task B4 — Entity extraction

#### Step 1: Failing tests

```python
from email_ingest.task_closure import extract_entities, ExtractedEntities

def test_extract_email_address():
    e = extract_entities(
        title="Follow up with lucinda.bertsinger@pennmedicine.upenn.edu re: PO",
        context=None, contacts={},
    )
    assert "lucinda.bertsinger@pennmedicine.upenn.edu" in e.emails

def test_extract_known_contact_first_name():
    e = extract_entities(
        title="Respond to Lucinda about R01 budget",
        context=None,
        contacts={"lucinda bertsinger": {"email": "lucinda.bertsinger@pennmedicine.upenn.edu"}},
    )
    assert "lucinda bertsinger" in e.contact_keys

def test_extract_project_codes():
    e = extract_entities(
        title="Update R01-MH137578 documentation",
        context="Also covers RIS 97589/00 and the COGEDE-D-26-00011 manuscript",
        contacts={},
    )
    assert any("R01" in p for p in e.project_codes)
    assert any("RIS 97589" in p for p in e.project_codes)
    assert any("COGEDE-D-26-00011" in p for p in e.project_codes)

def test_extract_unknown_full_name():
    e = extract_entities(
        title="Reach out to Joe Buxbaum re: ASD cohort",
        context=None, contacts={},
    )
    assert ("Joe", "Buxbaum") in e.unknown_full_names

def test_extract_ignores_common_capitalized_words():
    e = extract_entities(
        title="Respond to Elise email",
        context=None, contacts={},
    )
    assert ("Respond", "To") not in e.unknown_full_names
```

#### Step 2: Fail / Step 3: Implement

Append to `task_closure.py`:

```python
import re

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PROJECT_PATTERNS = [
    re.compile(r"\bR0?[01][0-9-]+", re.IGNORECASE),
    re.compile(r"\bK99/R00\b", re.IGNORECASE),
    re.compile(r"\bRIS\s+\d+(?:/\d+)?", re.IGNORECASE),
    re.compile(r"\bT32[\w-]*\b", re.IGNORECASE),
    re.compile(r"\b[A-Z]{4,}-D-\d{2}-\d{5}\b"),
]
NAME_STOPWORDS = frozenset({
    "Respond", "Reply", "Follow", "Reach", "Send", "Email", "To", "From",
    "Update", "Review", "Submit", "Check", "Schedule", "Cancel", "Confirm",
    "About", "With", "Re", "Subject", "Note",
})

@dataclass(frozen=True)
class ExtractedEntities:
    emails: tuple[str, ...]
    contact_keys: tuple[str, ...]
    project_codes: tuple[str, ...]
    unknown_full_names: tuple[tuple[str, str], ...]

def extract_entities(
    *,
    title: str,
    context: Optional[str],
    contacts: dict[str, dict],
) -> ExtractedEntities:
    body = title if context is None else f"{title}\n{context}"
    emails = tuple(sorted({m.group(0).lower() for m in EMAIL_RE.finditer(body)}))

    contact_keys: list[str] = []
    body_lower = body.lower()
    for full_name in contacts.keys():
        for part in full_name.split():
            if len(part) >= 3 and re.search(rf"\b{re.escape(part)}\b", body_lower):
                contact_keys.append(full_name)
                break

    project_codes: list[str] = []
    for pat in PROJECT_PATTERNS:
        for m in pat.finditer(body):
            project_codes.append(m.group(0))

    full_name_re = re.compile(r"\b([A-Z][a-z]{1,})\s+([A-Z][a-z]{1,})\b")
    contact_words = set()
    for full_name in contacts.keys():
        contact_words.update(full_name.split())
    unknown_pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for m in full_name_re.finditer(body):
        first, last = m.group(1), m.group(2)
        if first in NAME_STOPWORDS or last in NAME_STOPWORDS:
            continue
        if first.lower() in contact_words or last.lower() in contact_words:
            continue
        if (first, last) in seen:
            continue
        seen.add((first, last))
        unknown_pairs.append((first, last))

    return ExtractedEntities(
        emails=emails,
        contact_keys=tuple(sorted(set(contact_keys))),
        project_codes=tuple(project_codes),
        unknown_full_names=tuple(unknown_pairs),
    )
```

#### Step 4: Pass / Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): entity extraction"
```

### Task B5 — Profile JSON load/save with version guard

#### Step 1: Failing tests

```python
from email_ingest.task_closure import load_profile, save_profile

def test_profile_round_trip(tmp_path):
    p = ClosureProfile(
        contact_base_trust=0.8,
        default_base_trust=0.4,
        thresholds={"auto_close": 0.80, "suggest": 0.60},
        counterparty_trust={"a@b.com": 0.95},
        rule_precision={"provenance_match": 1.0},
        version=1,
    )
    out = tmp_path / "profile.json"
    save_profile(p, out)
    loaded = load_profile(out)
    assert loaded.contact_base_trust == 0.8
    assert loaded.thresholds["auto_close"] == 0.80
    assert loaded.counterparty_trust == {"a@b.com": 0.95}

def test_profile_missing_file_returns_defaults(tmp_path):
    p = load_profile(tmp_path / "absent.json")
    assert p.contact_base_trust == 0.7

def test_profile_malformed_returns_defaults(tmp_path, caplog):
    out = tmp_path / "bad.json"
    out.write_text("{ not valid json")
    import logging as _logging
    with caplog.at_level(_logging.WARNING):
        p = load_profile(out)
    assert p.contact_base_trust == 0.7
    assert any("malformed" in r.message.lower() for r in caplog.records)

def test_profile_newer_version_falls_back(tmp_path, caplog):
    out = tmp_path / "future.json"
    out.write_text(json.dumps({"version": 99, "contact_base_trust": 0.9}))
    import logging as _logging
    with caplog.at_level(_logging.WARNING):
        p = load_profile(out)
    assert p.contact_base_trust == 0.7
```

#### Step 3: Implement

```python
PROFILE_VERSION = 1

def save_profile(profile: ClosureProfile, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": profile.version,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "contact_base_trust": profile.contact_base_trust,
        "default_base_trust": profile.default_base_trust,
        "thresholds": profile.thresholds,
        "counterparty_trust": profile.counterparty_trust,
        "rule_precision": profile.rule_precision,
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(path)

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
    return ClosureProfile(
        contact_base_trust=float(data.get("contact_base_trust", 0.7)),
        default_base_trust=float(data.get("default_base_trust", 0.5)),
        thresholds=dict(data.get("thresholds", {"auto_close": 0.75, "suggest": 0.55})),
        counterparty_trust=dict(data.get("counterparty_trust", {})),
        rule_precision=dict(data.get("rule_precision", {})),
        version=PROFILE_VERSION,
    )
```

#### Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): profile JSON load/save with version guard"
```

### Task B6 — JSONL audit log with fcntl locking

#### Step 1: Failing tests

```python
from email_ingest.task_closure import append_jsonl_event, read_recent_reopens

def test_append_jsonl_writes_one_line_per_event(tmp_path):
    log_path = tmp_path / "events.jsonl"
    append_jsonl_event(log_path, {"action": "closed", "task_id": 1})
    append_jsonl_event(log_path, {"action": "suggested", "task_id": 2})
    lines = log_path.read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["task_id"] == 1
    assert "ts" in json.loads(lines[0])

def test_read_recent_reopens(tmp_path):
    log_path = tmp_path / "events.jsonl"
    fixed_now = _now()
    rows = []
    for i, age_days in enumerate([1, 3, 30]):
        ts = (fixed_now - timedelta(days=age_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows.append(json.dumps({"ts": ts, "action": "reopened", "task_id": 100 + i}))
    log_path.write_text("\n".join(rows) + "\n")
    recent = read_recent_reopens(log_path, window_days=7, now=fixed_now)
    assert recent == {100, 101}

def test_read_recent_reopens_skips_corrupt_lines(tmp_path, caplog):
    log_path = tmp_path / "events.jsonl"
    log_path.write_text(
        '{"ts":"2026-05-05T12:00:00Z","action":"reopened","task_id":1}\n'
        'NOT VALID JSON\n'
        '{"ts":"2026-05-05T12:00:00Z","action":"reopened","task_id":2}\n'
    )
    import logging as _logging
    with caplog.at_level(_logging.WARNING):
        recent = read_recent_reopens(log_path, window_days=7, now=_now())
    assert recent == {1, 2}
```

#### Step 3: Implement

```python
import fcntl

def append_jsonl_event(path: Path, event: dict) -> None:
    """Append one JSONL event under exclusive file lock."""
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

def read_recent_reopens(path: Path, *, window_days: int, now: datetime) -> set[int]:
    if not path.exists():
        return set()
    cutoff = now - timedelta(days=window_days)
    out: set[int] = set()
    with path.open("r") as fp:
        fcntl.flock(fp.fileno(), fcntl.LOCK_SH)
        try:
            for raw in fp:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("corrupt JSONL line skipped: %r", raw[:120])
                    continue
                if obj.get("action") != "reopened":
                    continue
                ts_str = obj.get("ts", "")
                try:
                    ts = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                if ts >= cutoff:
                    tid = obj.get("task_id")
                    if isinstance(tid, int):
                        out.add(tid)
        finally:
            fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
    return out
```

#### Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): JSONL audit log with fcntl locking"
```

### Task B7 — SQLite read/write helpers

#### Step 1: Failing tests

```python
import sqlite3
from email_ingest.task_closure import fetch_open_tasks, close_task_in_db

def _make_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "messages.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          context TEXT,
          owner TEXT,
          priority INTEGER NOT NULL DEFAULT 3,
          due_date TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          source TEXT NOT NULL DEFAULT 'manual',
          source_ref TEXT,
          group_folder TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          CHECK (status IN ('open','done','archived')),
          CHECK (priority BETWEEN 1 AND 4)
        );
        INSERT INTO tasks (title, status, created_at) VALUES
          ('Open task A', 'open',  '2026-05-01T12:00:00Z'),
          ('Open task B', 'open',  '2026-05-02T12:00:00Z'),
          ('Closed task', 'done', '2026-04-01T12:00:00Z');
        """
    )
    conn.commit()
    conn.close()
    return db_path

def test_fetch_open_tasks_excludes_closed(tmp_path):
    db_path = _make_db(tmp_path)
    open_tasks = fetch_open_tasks(db_path)
    assert {t.title for t in open_tasks} == {"Open task A", "Open task B"}

def test_close_task_flips_status_and_writes_completed_at(tmp_path):
    db_path = _make_db(tmp_path)
    [task_a] = [t for t in fetch_open_tasks(db_path) if t.title == "Open task A"]
    ok = close_task_in_db(db_path, task_a.id, reasoning="auto: Lucinda replied")
    assert ok is True
    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT status, completed_at, context FROM tasks WHERE id=?", (task_a.id,)).fetchone()
    conn.close()
    status, completed_at, context = row
    assert status == "done"
    assert completed_at is not None
    assert "auto" in (context or "")

def test_close_task_idempotent_against_race(tmp_path):
    db_path = _make_db(tmp_path)
    [task_a] = [t for t in fetch_open_tasks(db_path) if t.title == "Open task A"]
    assert close_task_in_db(db_path, task_a.id, reasoning="r") is True
    assert close_task_in_db(db_path, task_a.id, reasoning="r2") is False
```

#### Step 3: Implement

```python
import sqlite3

def _parse_db_ts(s: str) -> datetime:
    s = s.replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    if "+" not in s and "-" not in s[10:]:
        s = s + "+00:00"
    return datetime.fromisoformat(s)

def fetch_open_tasks(db_path: Path) -> list[OpenTask]:
    conn = sqlite3.connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, title, context, owner, priority, source, source_ref,
                   group_folder, created_at
              FROM tasks
             WHERE status = 'open'
            """
        ).fetchall()
    finally:
        conn.close()

    out: list[OpenTask] = []
    for r in rows:
        try:
            created = _parse_db_ts(r["created_at"])
        except ValueError:
            log.warning("task %s: unparseable created_at %r; skipping", r["id"], r["created_at"])
            continue
        out.append(OpenTask(
            id=r["id"], title=r["title"], context=r["context"],
            owner=r["owner"], priority=r["priority"],
            source=r["source"], source_ref=r["source_ref"],
            group_folder=r["group_folder"], created_at=created,
        ))
    return out

def close_task_in_db(db_path: Path, task_id: int, *, reasoning: str) -> bool:
    note = f"[auto-closed: {reasoning[:200]}]"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            """
            UPDATE tasks
               SET status = 'done',
                   completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                   context = CASE WHEN context IS NULL THEN ?
                                  ELSE context || char(10) || ? END
             WHERE id = ? AND status = 'open'
            """,
            (note, note, task_id),
        )
        conn.commit()
        return cur.rowcount == 1
    finally:
        conn.close()
```

#### Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): SQLite read/write helpers"
```

### Task B8 — scan_and_close orchestrator (Path A + dry-run + cooling-off + per-run cap)

This task combines the Path A flow, the dry-run guard, the cooling-off filter, and the per-run cap. Path B is added in Task B9.

#### Step 1: Failing tests

```python
from email_ingest.task_closure import scan_and_close, ClosureRunReport
from unittest.mock import MagicMock

class _FakeAdapter:
    def __init__(self, threads: dict[str, list]):
        self._threads = threads
        self.fetch_message = MagicMock(return_value=None)

    def fetch_thread_messages(self, thread_id, since_epoch):
        return self._threads.get(thread_id, [])

def _user_sent_msg():
    m = MagicMock()
    m.labels = ["SENT"]
    m.metadata = {"is_sent": True}
    m.from_addr = "mike@self"
    m.id = "m1"
    m.subject = "Re: thing"
    return m

def test_scan_path_a_auto_closes_when_user_replied(tmp_path):
    db_path = _make_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO tasks (title, source, source_ref, status, created_at) VALUES (?, ?, ?, ?, ?)",
        ("Respond to Elise email", "email", "gmail:t-elise", "open", "2026-05-04T12:00:00Z"),
    )
    conn.commit()
    elise_id = conn.execute("SELECT id FROM tasks WHERE title='Respond to Elise email'").fetchone()[0]
    conn.close()

    gmail = _FakeAdapter({"t-elise": [_user_sent_msg()]})
    exchange = _FakeAdapter({})
    jsonl = tmp_path / "task-closures.jsonl"
    pending = tmp_path / "pending.json"

    report = scan_and_close(
        db_path=db_path, gmail_adapter=gmail, exchange_adapter=exchange,
        profile=DEFAULT_PROFILE, contacts={}, followups=[], now=_now(),
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=False,
    )

    conn = sqlite3.connect(db_path)
    status = conn.execute("SELECT status FROM tasks WHERE id=?", (elise_id,)).fetchone()[0]
    conn.close()
    assert status == "done"

    events = [json.loads(l) for l in jsonl.read_text().splitlines()]
    closed = [e for e in events if e["action"] == "closed" and e["task_id"] == elise_id]
    assert len(closed) == 1
    assert closed[0]["thread_ref"] == "gmail:t-elise"
    assert report.closed_count == 1

def test_scan_dry_run_does_not_mutate_db(tmp_path):
    db_path = _make_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO tasks (title, source, source_ref, status, created_at) VALUES (?, ?, ?, ?, ?)",
        ("Respond to Elise email", "email", "gmail:t-elise", "open", "2026-05-04T12:00:00Z"),
    )
    conn.commit()
    conn.close()

    gmail = _FakeAdapter({"t-elise": [_user_sent_msg()]})
    exchange = _FakeAdapter({})

    report = scan_and_close(
        db_path=db_path, gmail_adapter=gmail, exchange_adapter=exchange,
        profile=DEFAULT_PROFILE, contacts={}, followups=[], now=_now(),
        jsonl_path=tmp_path / "events.jsonl", pending_path=tmp_path / "p.json",
        per_run_cap=5, dry_run=True,
    )
    conn = sqlite3.connect(db_path)
    statuses = [r[0] for r in conn.execute("SELECT status FROM tasks").fetchall()]
    conn.close()
    assert statuses.count("open") == 3  # nothing closed
    events = [json.loads(l) for l in (tmp_path / "events.jsonl").read_text().splitlines()]
    actions = [e["action"] for e in events]
    assert any(a.startswith("dry-") for a in actions)

def test_scan_respects_cooling_off(tmp_path):
    """A task with a recent 'reopened' event is masked from auto-close."""
    db_path = _make_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO tasks (title, source, source_ref, status, created_at) VALUES (?, ?, ?, ?, ?)",
        ("Respond to Elise email", "email", "gmail:t-elise", "open", "2026-05-04T12:00:00Z"),
    )
    conn.commit()
    tid = conn.execute("SELECT id FROM tasks WHERE title='Respond to Elise email'").fetchone()[0]
    conn.close()

    jsonl = tmp_path / "events.jsonl"
    # Pre-seed a 'reopened' event 1 day ago
    ts = (_now() - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    jsonl.write_text(json.dumps({"ts": ts, "action": "reopened", "task_id": tid}) + "\n")

    gmail = _FakeAdapter({"t-elise": [_user_sent_msg()]})
    exchange = _FakeAdapter({})

    report = scan_and_close(
        db_path=db_path, gmail_adapter=gmail, exchange_adapter=exchange,
        profile=DEFAULT_PROFILE, contacts={}, followups=[], now=_now(),
        jsonl_path=jsonl, pending_path=tmp_path / "p.json",
        per_run_cap=5, dry_run=False,
    )

    conn = sqlite3.connect(db_path)
    status = conn.execute("SELECT status FROM tasks WHERE id=?", (tid,)).fetchone()[0]
    conn.close()
    assert status == "open"  # still open due to cooling-off
    assert report.cooling_off_count == 1
```

#### Step 3: Implement

```python
PATH_A_ACTIVITY_WINDOW_DAYS = 90
COOLING_OFF_DAYS = 7

@dataclass
class ClosureRunReport:
    closed_count: int = 0
    suggested_count: int = 0
    cooling_off_count: int = 0
    skipped_count: int = 0
    decisions: list[ClosureDecision] = field(default_factory=list)

def _is_user_sent(msg) -> bool:
    labels = getattr(msg, "labels", None) or []
    if "SENT" in labels:
        return True
    meta = getattr(msg, "metadata", None) or {}
    return bool(meta.get("is_sent", False))

def _classify_kind(task: OpenTask) -> str:
    text = (task.title or "").lower() + " " + (task.context or "").lower()
    if any(p in text for p in ["awaiting", "follow up with", "they owe", "waiting for"]):
        return "they-owe-me"
    return "i-owe"

def _msg_dt(m) -> Optional[datetime]:
    ts = getattr(m, "timestamp", None) or (getattr(m, "metadata", None) or {}).get("internalDate")
    if ts is None:
        return None
    try:
        if isinstance(ts, (int, float)) or (isinstance(ts, str) and ts.isdigit()):
            return datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc)
        return _parse_db_ts(str(ts))
    except (ValueError, OSError):
        return None

def _path_a_should_close(task: OpenTask, thread_msgs: list, now: datetime) -> tuple[bool, str, tuple[str, ...]]:
    cutoff = now - timedelta(days=PATH_A_ACTIVITY_WINDOW_DAYS)
    relevant = [
        m for m in thread_msgs
        if _msg_dt(m) is None or _msg_dt(m) >= max(cutoff, task.created_at)
    ]
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
    pending_decisions: list[dict] = []
    closed_this_run = 0

    for task in open_tasks:
        if task.id in cooling_off:
            append_jsonl_event(jsonl_path, {
                "action": "cooling_off",
                "task_id": task.id, "task_title": task.title,
                "reasoning": f"Within {COOLING_OFF_DAYS}-day cooling-off after recent reopen",
            })
            report.cooling_off_count += 1
            continue

        # Path A: provenance match
        if task.source == "email" and task.source_ref:
            try:
                src, tid = task.source_ref.split(":", 1)
            except ValueError:
                src, tid = "", task.source_ref
            adapter = gmail_adapter if src == "gmail" else exchange_adapter if src == "exchange" else None
            if adapter is None:
                report.skipped_count += 1
                continue
            try:
                thread_msgs = adapter.fetch_thread_messages(tid, int(task.created_at.timestamp()))
            except Exception as e:
                log.warning("task %s: thread fetch failed: %s", task.id, e)
                report.skipped_count += 1
                continue

            should_close, reasoning, addrs = _path_a_should_close(task, thread_msgs, now)
            if not should_close:
                continue

            if task.source_ref in open_followup_threads:
                tier = Tier.SUGGEST
                reasoning += " (held: open followup on same thread)"
            else:
                tier = Tier.AUTO_CLOSE

            decision = ClosureDecision(
                task_id=task.id, task_title=task.title,
                thread_ref=task.source_ref, thread_addrs=addrs,
                score=1.0, tier=tier, rule="provenance_match",
                reasoning=reasoning, candidates_considered=1,
            )
            closed_this_run = _emit_decision(
                decision, jsonl_path, pending_decisions, report,
                db_path=db_path, dry_run=dry_run,
                closed_this_run=closed_this_run, per_run_cap=per_run_cap,
            )
            continue

        # Path B is added in Task B9.

    # Rewrite pending file atomically
    pending_payload = {
        "version": 1,
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "items": pending_decisions,
    }
    tmp = pending_path.with_suffix(pending_path.suffix + ".tmp")
    pending_path.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(pending_payload, indent=2))
    tmp.replace(pending_path)

    return report

def _emit_decision(
    decision: ClosureDecision,
    jsonl_path: Path,
    pending_decisions: list[dict],
    report: ClosureRunReport,
    *,
    db_path: Path,
    dry_run: bool,
    closed_this_run: int,
    per_run_cap: int,
) -> int:
    """Returns updated closed_this_run counter."""
    prefix = "dry-" if dry_run else ""

    if decision.tier == Tier.AUTO_CLOSE:
        if closed_this_run >= per_run_cap:
            event = {
                "action": f"{prefix}suggested",
                "task_id": decision.task_id, "task_title": decision.task_title,
                "thread_ref": decision.thread_ref,
                "thread_addrs": list(decision.thread_addrs),
                "score": decision.score, "rule": decision.rule,
                "reasoning": decision.reasoning + " (per-run cap exceeded)",
                "candidates_considered": decision.candidates_considered,
            }
            append_jsonl_event(jsonl_path, event)
            pending_decisions.append(event)
            report.suggested_count += 1
            return closed_this_run

        if not dry_run:
            ok = close_task_in_db(db_path, decision.task_id, reasoning=decision.reasoning)
            if not ok:
                log.warning("task %s: close failed (status changed); skipping", decision.task_id)
                report.skipped_count += 1
                return closed_this_run

        event = {
            "action": f"{prefix}closed",
            "task_id": decision.task_id, "task_title": decision.task_title,
            "thread_ref": decision.thread_ref,
            "thread_addrs": list(decision.thread_addrs),
            "score": decision.score, "rule": decision.rule,
            "reasoning": decision.reasoning,
            "candidates_considered": decision.candidates_considered,
        }
        append_jsonl_event(jsonl_path, event)
        report.closed_count += 1
        report.decisions.append(decision)
        return closed_this_run + (0 if dry_run else 1)

    if decision.tier == Tier.SUGGEST:
        event = {
            "action": f"{prefix}suggested",
            "task_id": decision.task_id, "task_title": decision.task_title,
            "thread_ref": decision.thread_ref,
            "thread_addrs": list(decision.thread_addrs),
            "score": decision.score, "rule": decision.rule,
            "reasoning": decision.reasoning,
            "candidates_considered": decision.candidates_considered,
        }
        append_jsonl_event(jsonl_path, event)
        pending_decisions.append(event)
        report.suggested_count += 1
    return closed_this_run
```

#### Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): scan_and_close (Path A + dry-run + cooling-off + cap)"
```

### Task B9 — Path B retroactive matching

#### Step 1: Failing test

```python
def test_scan_path_b_known_contact_auto_closes(tmp_path):
    db_path = _make_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO tasks (title, status, created_at) VALUES (?, ?, ?)",
        ("Respond to Lucinda about R01 budget", "open", "2026-05-04T12:00:00Z"),
    )
    conn.commit()
    tid = conn.execute("SELECT id FROM tasks WHERE title LIKE '%Lucinda%'").fetchone()[0]
    conn.close()

    user_msg = _user_sent_msg()
    cp_msg = MagicMock()
    cp_msg.labels = []
    cp_msg.metadata = {"is_sent": False}
    cp_msg.from_addr = "lucinda.bertsinger@pennmedicine.upenn.edu"
    cp_msg.subject = "R01 budget"

    gmail = _FakeAdapter({"t-lucinda": [user_msg, cp_msg]})
    gmail.search_threads_since = MagicMock(return_value=[
        {"thread_id": "t-lucinda", "subject": "R01 budget",
         "addrs": ["lucinda.bertsinger@pennmedicine.upenn.edu", "mike@self"]},
    ])
    exchange = _FakeAdapter({})
    exchange.search_threads_since = MagicMock(return_value=[])

    report = scan_and_close(
        db_path=db_path, gmail_adapter=gmail, exchange_adapter=exchange,
        profile=DEFAULT_PROFILE,
        contacts={"lucinda bertsinger": {"email": "lucinda.bertsinger@pennmedicine.upenn.edu"}},
        followups=[], now=_now(),
        jsonl_path=tmp_path / "events.jsonl", pending_path=tmp_path / "p.json",
        per_run_cap=5, dry_run=False,
    )

    conn = sqlite3.connect(db_path)
    status = conn.execute("SELECT status FROM tasks WHERE id=?", (tid,)).fetchone()[0]
    conn.close()
    assert status == "done"
    assert report.closed_count == 1
```

#### Step 3: Implement

Add to `task_closure.py`:

```python
@dataclass(frozen=True)
class ThreadCandidate:
    thread_ref: str
    subject: str
    counterparty_addrs: tuple[str, ...]
    last_activity: datetime
    user_sent_count: int
    counterparty_replied_count: int

def _gather_candidate_threads(
    *,
    entities: ExtractedEntities,
    contacts: dict[str, dict],
    gmail_adapter,
    exchange_adapter,
    since: datetime,
) -> list[ThreadCandidate]:
    addrs: list[str] = list(entities.emails)
    for k in entities.contact_keys:
        email = contacts.get(k, {}).get("email")
        if email:
            addrs.append(email.lower())
    if not addrs:
        return []
    epoch = int(since.timestamp())
    out: list[ThreadCandidate] = []
    for src, adapter in [("gmail", gmail_adapter), ("exchange", exchange_adapter)]:
        if not hasattr(adapter, "search_threads_since"):
            continue
        try:
            hits = adapter.search_threads_since(epoch, addrs) or []
        except Exception as e:
            log.warning("search_threads_since(%s) failed: %s", src, e)
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
    return out

def _match_strength_for(
    entities: ExtractedEntities, candidate: ThreadCandidate, contacts: dict[str, dict]
) -> float:
    cand_set = set(candidate.counterparty_addrs)
    if entities.emails and any(e in cand_set for e in entities.emails):
        return 1.0
    for k in entities.contact_keys:
        email = (contacts.get(k, {}).get("email") or "").lower()
        if email and email in cand_set:
            return 0.8
    for code in entities.project_codes:
        if code.lower() in (candidate.subject or "").lower():
            return 0.3
    return 0.5

def _is_known_contact(candidate: ThreadCandidate, contacts: dict[str, dict]) -> bool:
    cand_set = set(candidate.counterparty_addrs)
    for v in contacts.values():
        email = (v.get("email") or "").lower()
        if email and email in cand_set:
            return True
    return False
```

In `scan_and_close()`, replace the comment `# Path B is added in Task B9.` with:

```python
        # Path B: retroactive match
        entities = extract_entities(title=task.title, context=task.context, contacts=contacts)
        candidates = _gather_candidate_threads(
            entities=entities, contacts=contacts,
            gmail_adapter=gmail_adapter, exchange_adapter=exchange_adapter,
            since=task.created_at,
        )
        same_thread_other_open: dict[str, int] = {}
        for other in open_tasks:
            if other.id == task.id:
                continue
            if other.source_ref:
                same_thread_other_open[other.source_ref] = same_thread_other_open.get(other.source_ref, 0) + 1

        scored: list[tuple[float, ThreadCandidate]] = []
        for c in candidates[:5]:
            ms = _match_strength_for(entities, c, contacts)
            score = score_candidate(
                task=task,
                thread=ThreadActivity(
                    thread_ref=c.thread_ref, subject=c.subject,
                    user_sent_count=c.user_sent_count,
                    counterparty_replied_count=c.counterparty_replied_count,
                    last_activity=c.last_activity,
                    counterparty_addrs=c.counterparty_addrs,
                ),
                match_strength=ms,
                is_known_contact=_is_known_contact(c, contacts),
                profile=profile, now=now,
                same_thread_other_open_tasks=same_thread_other_open.get(c.thread_ref, 0),
            )
            scored.append((score, c))
        if not scored:
            continue
        scored.sort(key=lambda x: x[0], reverse=True)
        top_score, top = scored[0]
        runner = scored[1][0] if len(scored) > 1 else None
        tier = assign_tier(top_score=top_score, runner_up=runner, profile=profile)

        if top.thread_ref in open_followup_threads and tier == Tier.AUTO_CLOSE:
            tier = Tier.SUGGEST

        if same_thread_other_open.get(top.thread_ref, 0) >= 2:
            tier = Tier.SUGGEST

        rule = (
            "retroactive_full_email_match" if any(e in set(top.counterparty_addrs) for e in entities.emails)
            else "retroactive_full_name_match" if entities.contact_keys
            else "retroactive_name_only_match"
        )
        reasoning = (
            f"Matched thread '{top.subject}' (score {top_score:.2f}, rule {rule}). "
            f"User-sent {top.user_sent_count}, counterparty-replied {top.counterparty_replied_count}."
        )
        decision = ClosureDecision(
            task_id=task.id, task_title=task.title,
            thread_ref=top.thread_ref, thread_addrs=top.counterparty_addrs,
            score=top_score, tier=tier, rule=rule,
            reasoning=reasoning, candidates_considered=len(scored),
        )
        closed_this_run = _emit_decision(
            decision, jsonl_path, pending_decisions, report,
            db_path=db_path, dry_run=dry_run,
            closed_this_run=closed_this_run, per_run_cap=per_run_cap,
        )
```

#### Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): Path B retroactive matching"
```

### Task B10 — search_threads_since on Gmail/Exchange adapters

**Files:**
- Modify: `scripts/sync/email_ingest/gmail_adapter.py`
- Modify: `scripts/sync/email_ingest/exchange_adapter.py`
- Modify: `scripts/sync/tests/test_gmail_adapter.py`

#### Step 1: Failing adapter test

```python
from unittest.mock import MagicMock
from email_ingest.gmail_adapter import GmailAdapter

def test_search_threads_since_uses_query_addrs():
    g = GmailAdapter()
    g._service = MagicMock()
    g._service.users.return_value.threads.return_value.list.return_value.execute.return_value = {
        "threads": [{"id": "t1", "snippet": "Re: Test"}],
    }
    g._service.users.return_value.threads.return_value.get.return_value.execute.return_value = {
        "id": "t1", "messages": [
            {"payload": {"headers": [
                {"name": "Subject", "value": "Re: Test"},
                {"name": "From", "value": "Lucinda <lucinda@x.com>"},
                {"name": "To", "value": "mike@self"},
            ]}},
        ],
    }
    out = g.search_threads_since(epoch=1700000000, addrs=["lucinda@x.com"])
    assert len(out) == 1
    assert out[0]["thread_id"] == "t1"
    assert "lucinda@x.com" in [a.lower() for a in out[0]["addrs"]]
```

#### Step 3: Implement on GmailAdapter

In `gmail_adapter.py`, near `fetch_thread_messages` (around line 278):

```python
def search_threads_since(self, epoch: int, addrs: list[str]) -> list[dict]:
    """Find Gmail threads with activity since `epoch` involving any `addrs`.

    Returns up to 25 dicts with thread_id, subject, addrs.
    """
    if not addrs:
        return []
    if not self._service:
        if not self.connect():
            return []
    addr_q = " OR ".join(f"(from:{a} OR to:{a})" for a in addrs[:10])
    q = f"({addr_q}) after:{epoch}"
    try:
        resp = self._service.users().threads().list(
            userId="me", q=q, maxResults=25,
        ).execute()
    except Exception as e:
        log.warning("search_threads_since list failed: %s", e)
        return []
    out: list[dict] = []
    for t in resp.get("threads", []):
        tid = t.get("id")
        if not tid:
            continue
        try:
            full = self._service.users().threads().get(
                userId="me", id=tid, format="metadata",
                metadataHeaders=["Subject", "From", "To", "Cc"],
            ).execute()
        except Exception:
            continue
        subject = ""
        addrs_seen: set[str] = set()
        for msg in full.get("messages", []):
            for h in (msg.get("payload") or {}).get("headers", []):
                name = h.get("name", "").lower()
                val = h.get("value", "")
                if name == "subject" and not subject:
                    subject = val
                elif name in ("from", "to", "cc"):
                    for piece in val.split(","):
                        m = re.search(r"<([^>]+)>", piece)
                        addr = (m.group(1) if m else piece).strip().lower()
                        if "@" in addr:
                            addrs_seen.add(addr)
        out.append({"thread_id": tid, "subject": subject, "addrs": sorted(addrs_seen)})
    return out
```

Add `import re` at top if not already present.

#### Step 4: Implement on ExchangeAdapter

In `exchange_adapter.py`, near `fetch_thread_messages` (around line 281):

```python
def search_threads_since(self, epoch: int, addrs: list[str]) -> list[dict]:
    """Exchange thread search by participant addresses.

    AppleScript-driven Exchange is slow (~22s/query). v1: scan recent
    inbox+sent, filter by participant overlap, cap to 25 threads.
    """
    if not addrs:
        return []
    addrs_lc = {a.lower() for a in addrs}
    threads: dict[str, dict] = {}
    try:
        recent = self.list_recent_messages(epoch=epoch, limit=50)
    except AttributeError:
        # list_recent_messages may not exist yet; v1 limitation.
        log.info("ExchangeAdapter.list_recent_messages not available; skipping")
        return []
    except Exception as e:
        log.warning("exchange search_threads_since failed: %s", e)
        return []
    for m in recent:
        thread_id = getattr(m, "thread_id", None) or m.id
        m_addrs = set()
        from_a = (getattr(m, "from_addr", "") or "").lower()
        if from_a:
            m_addrs.add(from_a)
        for r in getattr(m, "to_addrs", None) or []:
            m_addrs.add(r.lower())
        if not (m_addrs & addrs_lc):
            continue
        if thread_id not in threads:
            threads[thread_id] = {
                "thread_id": thread_id,
                "subject": getattr(m, "subject", ""),
                "addrs": sorted(m_addrs),
            }
    return list(threads.values())[:25]
```

> If `list_recent_messages` doesn't exist on `ExchangeAdapter`, the method gracefully degrades to returning `[]` — Path B simply won't find Exchange candidates until that helper is added. Document as v1 limitation.

#### Step 5: Pass / Step 6: Full suite

```
cd scripts/sync && /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest -v
```

Expected: PASS, no regressions.

#### Step 7: Commit

```
git add scripts/sync/email_ingest/gmail_adapter.py scripts/sync/email_ingest/exchange_adapter.py scripts/sync/tests/test_gmail_adapter.py
git commit -m "feat(adapters): search_threads_since for retroactive task closure"
```

---

## Stage C — Trainer module

### Task C1 — Trainer scaffold + tests

**Files:**
- Create: `scripts/sync/email_ingest/task_closure_trainer.py`
- Create: `scripts/sync/tests/test_task_closure_trainer.py`

#### Step 1: Failing tests

```python
"""Unit tests for email_ingest.task_closure_trainer."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from email_ingest.task_closure_trainer import train, compute_counterparty_trust

def _now() -> datetime:
    return datetime(2026, 5, 5, 12, 0, 0, tzinfo=timezone.utc)

def _ev(action, task_id, *, age_days=1, addr=None, rule="retroactive_full_email_match"):
    ts = (_now() - timedelta(days=age_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"ts": ts, "action": action, "task_id": task_id, "rule": rule}
    if addr:
        out["thread_addrs"] = [addr]
    return out

def _write_jsonl(path: Path, events: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n")

def test_compute_counterparty_trust_high_for_clean_record():
    events = [_ev("closed", i, addr="lucinda@x.com") for i in range(1, 5)]
    trust = compute_counterparty_trust(events)
    assert trust["lucinda@x.com"] >= 0.85

def test_compute_counterparty_trust_low_after_reopens():
    events = [
        _ev("closed", 1, addr="noisy@x.com"),
        _ev("reopened", 1),
        _ev("closed", 2, addr="noisy@x.com"),
        _ev("reopened", 2),
    ]
    trust = compute_counterparty_trust(events)
    assert trust["noisy@x.com"] <= 0.30

def test_train_writes_profile(tmp_path):
    log_path = tmp_path / "events.jsonl"
    out_path = tmp_path / "profile.json"
    _write_jsonl(log_path, [
        _ev("closed", 1, addr="a@x.com"),
        _ev("closed", 2, addr="a@x.com"),
        _ev("closed", 3, addr="b@x.com"),
        _ev("reopened", 3),
    ])
    train(log_path, out_path, lookback_days=30, now=_now())
    profile = json.loads(out_path.read_text())
    assert profile["version"] == 1
    assert "a@x.com" in profile["counterparty_trust"]

def test_train_handles_empty_jsonl(tmp_path):
    log_path = tmp_path / "events.jsonl"
    log_path.write_text("")
    out_path = tmp_path / "profile.json"
    train(log_path, out_path, lookback_days=30, now=_now())
    profile = json.loads(out_path.read_text())
    assert profile["contact_base_trust"] == 0.7
```

#### Step 3: Implement

Create `scripts/sync/email_ingest/task_closure_trainer.py`:

```python
"""Weekly trainer: derive per-counterparty trust + per-rule precision.

Reads ~/.cache/email-ingest/task-closures.jsonl, recomputes weights,
writes ~/.cache/email-ingest/task-closure-profile.json. Pure offline:
never touches the live tasks table.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from email_ingest.task_closure import ClosureProfile, save_profile

log = logging.getLogger("email-ingest.task-closure-trainer")

DEFAULT_JSONL = Path.home() / ".cache" / "email-ingest" / "task-closures.jsonl"
DEFAULT_PROFILE = Path.home() / ".cache" / "email-ingest" / "task-closure-profile.json"

def _parse_ts(s: str) -> datetime | None:
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None

def _load_events(path: Path, lookback_days: int, now: datetime) -> list[dict]:
    if not path.exists():
        return []
    cutoff = now - timedelta(days=lookback_days)
    out: list[dict] = []
    for raw in path.read_text().splitlines():
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("trainer: corrupt JSONL line: %r", raw[:120])
            continue
        ts = _parse_ts(obj.get("ts", ""))
        if ts is None or ts < cutoff:
            continue
        out.append(obj)
    return out

def compute_counterparty_trust(events: list[dict]) -> dict[str, float]:
    closed_by_task: dict[int, list[str]] = {}
    reopened_tasks: set[int] = set()
    for ev in events:
        action = ev.get("action", "")
        if action.startswith("dry-"):
            continue
        tid = ev.get("task_id")
        if not isinstance(tid, int):
            continue
        if action == "closed":
            addrs = ev.get("thread_addrs") or []
            if addrs:
                closed_by_task[tid] = [a.lower() for a in addrs]
        elif action == "reopened":
            reopened_tasks.add(tid)

    counts: dict[str, dict[str, int]] = {}
    for tid, addrs in closed_by_task.items():
        for addr in addrs:
            d = counts.setdefault(addr, {"stuck": 0, "total": 0})
            d["total"] += 1
            if tid not in reopened_tasks:
                d["stuck"] += 1
    return {a: round(d["stuck"] / d["total"], 3) for a, d in counts.items() if d["total"] >= 1}

def compute_rule_precision(events: list[dict]) -> dict[str, float]:
    fired: dict[str, int] = {}
    rule_by_task: dict[int, str] = {}
    reopened: set[int] = set()
    for ev in events:
        action = ev.get("action", "")
        if action.startswith("dry-"):
            continue
        tid = ev.get("task_id")
        if not isinstance(tid, int):
            continue
        if action == "closed":
            rule = ev.get("rule", "unknown")
            fired[rule] = fired.get(rule, 0) + 1
            rule_by_task[tid] = rule
        elif action == "reopened":
            reopened.add(tid)
    stuck: dict[str, int] = {}
    for tid, rule in rule_by_task.items():
        if tid not in reopened:
            stuck[rule] = stuck.get(rule, 0) + 1
    return {r: round(stuck.get(r, 0) / n, 3) for r, n in fired.items() if n > 0}

def train(
    jsonl_path: Path,
    out_path: Path,
    lookback_days: int = 30,
    now: datetime | None = None,
) -> None:
    if now is None:
        now = datetime.now(timezone.utc)
    events = _load_events(jsonl_path, lookback_days, now)
    cp_trust = compute_counterparty_trust(events)
    rule_precision = compute_rule_precision(events)
    profile = ClosureProfile.default()
    profile.counterparty_trust = cp_trust
    profile.rule_precision = rule_precision
    save_profile(profile, out_path)
    log.info("trainer: wrote profile (cp=%d, rules=%d, lookback=%d)",
             len(cp_trust), len(rule_precision), lookback_days)

def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser()
    p.add_argument("--jsonl", default=str(DEFAULT_JSONL))
    p.add_argument("--out", default=str(DEFAULT_PROFILE))
    p.add_argument("--lookback-days", type=int, default=30)
    p.add_argument("--recompute", action="store_true",
                   help="ignored for v1 — recompute is the default mode")
    args = p.parse_args(argv)
    train(Path(args.jsonl), Path(args.out), args.lookback_days)
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

#### Step 5: Commit

```
git add scripts/sync/email_ingest/task_closure_trainer.py scripts/sync/tests/test_task_closure_trainer.py
git commit -m "feat(task-closure-trainer): per-counterparty + per-rule weights"
```

---

## Stage D — CLI tools (--explain, --rollback, --dry-run)

### Task D1 — Implement __main__ entry point

**Files:**
- Modify: `scripts/sync/email_ingest/task_closure.py` (add `main()` and CLI helpers)
- Modify: `scripts/sync/tests/test_task_closure.py` (basic CLI test)

#### Step 1: Failing test

```python
def test_explain_returns_breakdown(tmp_path):
    db_path = _make_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO tasks (title, status, created_at) VALUES (?, ?, ?)",
                 ("Respond to Lucinda", "open", "2026-05-04T12:00:00Z"))
    conn.commit()
    tid = conn.execute("SELECT id FROM tasks WHERE title LIKE '%Lucinda%'").fetchone()[0]
    conn.close()

    from email_ingest.task_closure import explain_task
    out = explain_task(
        db_path=db_path, task_id=tid,
        gmail_adapter=_FakeAdapter({}), exchange_adapter=_FakeAdapter({}),
        profile=DEFAULT_PROFILE,
        contacts={"lucinda bertsinger": {"email": "lucinda@x.com"}},
        followups=[], now=_now(),
    )
    assert out["task_id"] == tid
    assert "candidates" in out
```

#### Step 3: Implement

Append to `task_closure.py`:

```python
import argparse

def explain_task(
    *,
    db_path: Path, task_id: int,
    gmail_adapter, exchange_adapter,
    profile: ClosureProfile, contacts: dict[str, dict],
    followups: list, now: datetime,
) -> dict:
    open_tasks = fetch_open_tasks(db_path)
    target = next((t for t in open_tasks if t.id == task_id), None)
    if target is None:
        return {"task_id": task_id, "error": "task not found or not open"}
    entities = extract_entities(title=target.title, context=target.context, contacts=contacts)
    candidates = _gather_candidate_threads(
        entities=entities, contacts=contacts,
        gmail_adapter=gmail_adapter, exchange_adapter=exchange_adapter,
        since=target.created_at,
    )
    scored = []
    for c in candidates[:5]:
        ms = _match_strength_for(entities, c, contacts)
        s = score_candidate(
            task=target,
            thread=ThreadActivity(
                thread_ref=c.thread_ref, subject=c.subject,
                user_sent_count=c.user_sent_count,
                counterparty_replied_count=c.counterparty_replied_count,
                last_activity=c.last_activity,
                counterparty_addrs=c.counterparty_addrs,
            ),
            match_strength=ms,
            is_known_contact=_is_known_contact(c, contacts),
            profile=profile, now=now,
            same_thread_other_open_tasks=0,
        )
        scored.append({
            "thread_ref": c.thread_ref, "subject": c.subject,
            "match_strength": ms, "score": round(s, 3),
        })
    return {
        "task_id": task_id, "title": target.title,
        "entities": {
            "emails": list(entities.emails),
            "contact_keys": list(entities.contact_keys),
            "project_codes": list(entities.project_codes),
            "unknown_full_names": list(entities.unknown_full_names),
        },
        "candidates": scored,
    }

def rollback_task(*, db_path: Path, task_id: int, jsonl_path: Path) -> dict:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT title, status FROM tasks WHERE id=?", (task_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        return {"success": False, "error": f"task {task_id} not found"}
    cur_title, cur_status = row
    last_close = None
    if jsonl_path.exists():
        for raw in jsonl_path.read_text().splitlines():
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if ev.get("task_id") == task_id and ev.get("action") in ("closed", "dry-closed"):
                last_close = ev
    if last_close and last_close.get("task_title") and last_close["task_title"] != cur_title:
        return {
            "success": False,
            "error": (
                f"safety abort: task {task_id} title in DB ({cur_title!r}) does not "
                f"match title in last closure entry ({last_close['task_title']!r}). "
                "ID may have been reused."
            ),
        }
    if cur_status == "open":
        return {"success": False, "error": "already open"}
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "UPDATE tasks SET status='open', completed_at=NULL WHERE id=? AND status!='open'",
            (task_id,),
        )
        conn.commit()
    finally:
        conn.close()
    if cur.rowcount == 1:
        append_jsonl_event(jsonl_path, {
            "action": "manual-rollback", "task_id": task_id, "task_title": cur_title,
        })
        append_jsonl_event(jsonl_path, {
            "action": "reopened", "task_id": task_id, "task_title": cur_title,
            "reason": "manual --rollback", "feedback_source": "cli",
        })
        return {"success": True}
    return {"success": False, "error": "race during rollback"}

def _load_contacts_from_claude_md(path: Path) -> dict[str, dict]:
    if not path.exists():
        log.info("contacts: %s not found, skipping", path)
        return {}
    text = path.read_text()
    out: dict[str, dict] = {}
    in_table = False
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("| Name ") and "Email" in line:
            in_table = True
            continue
        if in_table:
            if not line.startswith("|"):
                in_table = False
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) >= 3 and "@" in cells[2]:
                out[cells[0].lower()] = {"email": cells[2].lower()}
    return out

def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=str(Path.cwd() / "store" / "messages.db"))
    p.add_argument("--jsonl", default=str(Path.home() / ".cache/email-ingest/task-closures.jsonl"))
    p.add_argument("--pending", default=str(Path.home() / ".cache/email-ingest/task-closures-pending.json"))
    p.add_argument("--profile", default=str(Path.home() / ".cache/email-ingest/task-closure-profile.json"))
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--explain", type=int)
    p.add_argument("--rollback", type=int)
    p.add_argument("--per-run-cap", type=int, default=5)
    args = p.parse_args(argv)

    profile = load_profile(Path(args.profile))
    from email_ingest.gmail_adapter import GmailAdapter
    from email_ingest.exchange_adapter import ExchangeAdapter
    gmail = GmailAdapter()
    gmail.connect()
    exchange = ExchangeAdapter()
    contacts = _load_contacts_from_claude_md(Path("groups/global/CLAUDE.md"))
    followups: list = []
    now = datetime.now(timezone.utc)

    if args.explain is not None:
        result = explain_task(
            db_path=Path(args.db), task_id=args.explain,
            gmail_adapter=gmail, exchange_adapter=exchange,
            profile=profile, contacts=contacts, followups=followups, now=now,
        )
        print(json.dumps(result, indent=2))
        return 0

    if args.rollback is not None:
        result = rollback_task(
            db_path=Path(args.db), task_id=args.rollback,
            jsonl_path=Path(args.jsonl),
        )
        print(json.dumps(result, indent=2))
        return 0 if result.get("success") else 1

    report = scan_and_close(
        db_path=Path(args.db),
        gmail_adapter=gmail, exchange_adapter=exchange,
        profile=profile, contacts=contacts, followups=followups, now=now,
        jsonl_path=Path(args.jsonl), pending_path=Path(args.pending),
        per_run_cap=args.per_run_cap, dry_run=args.dry_run,
    )
    log.info("task-closure: closed=%d suggested=%d cooling_off=%d skipped=%d",
             report.closed_count, report.suggested_count,
             report.cooling_off_count, report.skipped_count)
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

Add `import sys` at top if not already present.

#### Step 4: Pass

```
cd scripts/sync && /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_task_closure.py -v
```

Expected: PASS.

#### Step 5: Manual smoke

```
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m email_ingest.task_closure --help
```

Expected: argparse usage prints; no traceback.

#### Step 6: Commit

```
git add scripts/sync/email_ingest/task_closure.py scripts/sync/tests/test_task_closure.py
git commit -m "feat(task-closure): CLI subcommands (scan/explain/rollback)"
```

---

## Stage E — Wire into email-ingest.py

### Task E1 — Invoke scan_and_close after followups closure

#### Step 1: Locate the followups-closure call site

```
grep -n "apply_closure\|_closure_mod" scripts/sync/email-ingest.py
```

Find the line where `_closure_mod.apply_closure(...)` is called for followups. Insertion point is just after that call.

#### Step 2: Add the invocation

Append after the followups closure block (replacing `updated_items` with the actual variable name holding the post-closure followups list — verify by reading the surrounding lines):

```python
    # --- Task closure (auto-close tasks table from email activity) ---
    if os.environ.get("TASK_CLOSURE_ENABLED", "1") == "1":
        try:
            from email_ingest.task_closure import (
                scan_and_close, load_profile, _load_contacts_from_claude_md,
            )
            from pathlib import Path as _P
            project_root = _P(__file__).resolve().parents[2]
            db_path = project_root / "store" / "messages.db"
            cache_dir = _P.home() / ".cache" / "email-ingest"
            jsonl = cache_dir / "task-closures.jsonl"
            pending = cache_dir / "task-closures-pending.json"
            profile_path = cache_dir / "task-closure-profile.json"
            contacts = _load_contacts_from_claude_md(
                project_root / "groups" / "global" / "CLAUDE.md"
            )
            profile = load_profile(profile_path)
            dry_run = os.environ.get("TASK_CLOSURE_DRY_RUN", "0") == "1"
            per_run_cap = int(os.environ.get("TASK_CLOSURE_CAP", "3"))
            report = scan_and_close(
                db_path=db_path,
                gmail_adapter=gmail,
                exchange_adapter=exchange,
                profile=profile,
                contacts=contacts,
                followups=updated_items,  # replace with actual var name
                now=datetime.now(timezone.utc),
                jsonl_path=jsonl, pending_path=pending,
                per_run_cap=per_run_cap, dry_run=dry_run,
            )
            log.info(
                "task-closure: closed=%d suggested=%d cooling_off=%d skipped=%d (dry_run=%s)",
                report.closed_count, report.suggested_count,
                report.cooling_off_count, report.skipped_count, dry_run,
            )
        except Exception as e:
            log.exception("task-closure failed (non-fatal): %s", e)
```

Add `from datetime import datetime, timezone` at the top of `email-ingest.py` if not already imported.

#### Step 3: Manual smoke in dry-run

```
cd /Users/mgandal/Agents/nanoclaw/scripts/sync && \
  TASK_CLOSURE_ENABLED=1 TASK_CLOSURE_DRY_RUN=1 \
  /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 email-ingest.py 2>&1 | tail -20
```

Expected: existing email-ingest output PLUS `task-closure: closed=N suggested=M ...`.

```
ls -la ~/.cache/email-ingest/task-closures.jsonl
tail -5 ~/.cache/email-ingest/task-closures.jsonl
```

Expected: file exists, lines start with `{"ts":...,"action":"dry-..."`.

#### Step 4: Verify the live tasks table did not change

```
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db "SELECT COUNT(*) FROM tasks WHERE status='open';"
```

Expected: 28 (or whatever the count was before).

#### Step 5: Commit

```
git add scripts/sync/email-ingest.py
git commit -m "feat(email-ingest): invoke task_closure (env-gated, dry-run default)"
```

---

## Stage F — Morning briefing surface

### Task F1 — Add closure summary to claire-morning-briefing

**Files:**
- Modify: SQLite `scheduled_tasks` row `claire-morning-briefing`'s `prompt` column

#### Step 1: Backup the current prompt

```
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT prompt FROM scheduled_tasks WHERE id='claire-morning-briefing';" \
  > /tmp/claire-morning-briefing.prompt.bak
wc -l /tmp/claire-morning-briefing.prompt.bak
```

#### Step 2: Build the new prompt

The engineer must paste the current prompt body into `/tmp/claire-morning-briefing.prompt.new` and add a new STEP 2.5 block plus the closing counts line. The added content:

```text
STEP 2.5 — Auto-closed tasks (NEW):
Read /Users/mgandal/.cache/email-ingest/task-closures.jsonl. From the last 24h,
collect every event with action == "closed" (NOT "dry-closed"). For each, render:

✅ *Auto-closed overnight* (only if any)
• [id:N] <task_title> — <reasoning, one line>

If the user disputes one ("that wasn't actually done", "reopen 55", "no, that
was OOO"), parse the task id and call mcp__nanoclaw__task_reopen with id and
reason.

If `/reopen <id> <reason>` appears in the user's message, parse and call
mcp__nanoclaw__task_reopen directly.

Also include this single counts line at the end of the briefing (always, even
when zero):
📊 Closure decisions in last 24h: ✅ closed N · 🔔 suggested M · ⏭ cooling-off K
```

#### Step 3: Apply via parameter binding (NOT readfile — see memory note about BLOB corruption)

```
NEW_PROMPT="$(cat /tmp/claire-morning-briefing.prompt.new)"
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "UPDATE scheduled_tasks SET prompt = ? WHERE id='claire-morning-briefing';" \
  "$NEW_PROMPT"
```

Verify the column type is `text` not `blob`:

```
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT typeof(prompt) FROM scheduled_tasks WHERE id='claire-morning-briefing';"
```

Expected: `text`. If `blob`, restore from backup and retry.

#### Step 4: Snapshot for archaeology

```
mkdir -p docs/runtime-changes
cp /tmp/claire-morning-briefing.prompt.bak docs/runtime-changes/2026-05-06-claire-morning-briefing-prompt-before.txt
cp /tmp/claire-morning-briefing.prompt.new docs/runtime-changes/2026-05-06-claire-morning-briefing-prompt-after.txt
git add docs/runtime-changes/
git commit -m "docs(runtime-changes): record morning-briefing prompt update"
```

> The actual prompt lives in SQL, not git. Snapshots are for archaeology only.

---

## Stage G — Trainer launchd plist

### Task G1 — Plist installer

**Files:**
- Create: `scripts/install-train-task-closure-plist.sh`
- Create: `~/Library/LaunchAgents/com.nanoclaw.train-task-closure.plist` (via the installer)

#### Step 1: Write the installer script

Create `scripts/install-train-task-closure-plist.sh` (chmod +x):

```bash
#!/usr/bin/env bash
# Idempotent installer for com.nanoclaw.train-task-closure.
# Mirrors com.nanoclaw.train-classifier.plist (StartCalendarInterval).

set -euo pipefail

PLIST_PATH="$HOME/Library/LaunchAgents/com.nanoclaw.train-task-closure.plist"
PYTHON="/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3"
SCRIPT_DIR="/Users/mgandal/Agents/nanoclaw/scripts/sync"
LOG_DIR="$HOME/.cache/email-ingest"
mkdir -p "$LOG_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.train-task-closure</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>-m</string>
        <string>email_ingest.task_closure_trainer</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Hour</key>
        <integer>2</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/train-task-closure-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/train-task-closure-stderr.log</string>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PYTHONPATH</key>
        <string>$SCRIPT_DIR</string>
    </dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "Installed: $PLIST_PATH"
launchctl list | grep -F com.nanoclaw.train-task-closure || true
```

#### Step 2: Run the installer

```
chmod +x scripts/install-train-task-closure-plist.sh
./scripts/install-train-task-closure-plist.sh
```

Expected: `Installed: ...` line and a `launchctl list` entry showing the job.

#### Step 3: Sanity-check plist syntax

```
plutil -lint ~/Library/LaunchAgents/com.nanoclaw.train-task-closure.plist
```

Expected: `OK`.

#### Step 4: Manual one-shot

```
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.train-task-closure
sleep 2
tail -20 ~/.cache/email-ingest/train-task-closure-stderr.log
tail -20 ~/.cache/email-ingest/train-task-closure-stdout.log
```

Expected: trainer runs to completion; profile.json file exists at `~/.cache/email-ingest/task-closure-profile.json`.

#### Step 5: Commit

```
git add scripts/install-train-task-closure-plist.sh
git commit -m "feat(launchd): weekly trainer plist + installer"
```

---

## Stage H — Documentation

### Task H1 — Update groups/global/CLAUDE.md

```
grep -n "Task Table" groups/global/CLAUDE.md
```

Append after the Task Table section's existing paragraph:

```markdown
**Auto-closure from email activity (added 2026-05-06):** Tasks may auto-close
when email thread activity makes completion obvious. Auto-closures appear in
the morning briefing under "✅ Auto-closed overnight" with a one-line reason.
To dispute: reply naturally ("reopen 55, OOO not real reply") OR use
`/reopen <id> <reason>` — Claire parses both and calls
`mcp__nanoclaw__task_reopen`. The audit log lives at
`~/.cache/email-ingest/task-closures.jsonl`. Run
`python -m email_ingest.task_closure --explain <id>` to inspect why a closure
fired or didn't.
```

```
wc -l groups/global/CLAUDE.md
```

If under 250 lines, commit. Otherwise, run the `agent-md-refactor` skill before continuing.

```
git add groups/global/CLAUDE.md
git commit -m "docs(claude-md): document email-driven task auto-closure"
```

### Task H2 — Memory entry

Create `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/project_email_task_closure.md`:

```markdown
---
name: Email-driven task auto-closure
description: Auto-closes tasks in store/messages.db from email thread activity. Per-counterparty trust learned weekly.
type: project
---

Live as of 2026-05-06 (rollout in progress).

**Code:** `scripts/sync/email_ingest/task_closure.py` (matcher), `task_closure_trainer.py` (weekly weights).
**Audit log:** `~/.cache/email-ingest/task-closures.jsonl`.
**Profile:** `~/.cache/email-ingest/task-closure-profile.json`.
**Spec:** `docs/superpowers/specs/2026-05-06-email-task-closure-design.md`.
**IPC:** `task_reopen(id, reason)` in `src/tasks-ipc.ts`, container MCP `mcp__nanoclaw__task_reopen`.
**Trainer cron:** `~/Library/LaunchAgents/com.nanoclaw.train-task-closure.plist`, Sunday 2am.

**When debugging:**
- "Why didn't task N close?" → `python -m email_ingest.task_closure --explain N --db /Users/mgandal/Agents/nanoclaw/store/messages.db`
- "Auto-closure was wrong" → user replies in morning briefing OR `/reopen N reason`. Trainer learns over 30-day window.
- "Need to undo a closure long after digest" → `python -m email_ingest.task_closure --rollback N`. Refuses if title in DB diverges from closure entry.
- Dry-run: `TASK_CLOSURE_DRY_RUN=1` env var.
- Per-run cap: `TASK_CLOSURE_CAP` env var (default 3 rollout, 5 steady-state).

**Rollout stages:** dry-run (3d) → suggest-only (3d) → live cap=3 (7d) → steady cap=5.

**Why:** stale tasks in morning briefing erode trust. Closing the obvious ones automatically frees Mike from manual reconciliation while keeping a dispute path that feeds back into learning.
```

Add to `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md` under "Linked topic files":

```
- [Email-driven task auto-closure](project_email_task_closure.md) — auto-closes tasks from email thread activity; trainer learns per-counterparty trust weekly
```

(Memory dir is outside the repo; no git commit needed.)

---

## Stage I — Operational rollout

### Task I1 — Stage 1: Dry-run for 3 days

Edit `~/Library/LaunchAgents/com.nanoclaw.sync.plist` to add:

```xml
<key>TASK_CLOSURE_ENABLED</key>
<string>1</string>
<key>TASK_CLOSURE_DRY_RUN</key>
<string>1</string>
```

Reload:

```
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.sync.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.sync.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.sync
```

Verify after 30s:

```
tail -5 ~/.cache/email-ingest/task-closures.jsonl
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db "SELECT COUNT(*) FROM tasks WHERE status='open';"
```

Expected: JSONL shows `dry-closed` / `dry-suggested`; open count unchanged.

For each `dry-closed` decision over 3 days, manually verify against the actual Gmail/Exchange thread. Iterate on heuristics if false-positive rate >20%.

### Task I2 — Stage 2: Suggest-only for 3 days

Bump auto_close threshold to 1.01 (unreachable):

```
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -c "
import json
from pathlib import Path
p = Path.home()/'.cache/email-ingest/task-closure-profile.json'
data = json.loads(p.read_text()) if p.exists() else {'version':1,'contact_base_trust':0.7,'default_base_trust':0.5,'thresholds':{'auto_close':1.01,'suggest':0.55},'counterparty_trust':{},'rule_precision':{}}
data['thresholds']['auto_close'] = 1.01
p.write_text(json.dumps(data, indent=2))
print('threshold bumped:', data['thresholds'])
"
```

Disable dry-run by changing `TASK_CLOSURE_DRY_RUN` from `"1"` to `"0"` in the sync plist; reload.

Verify: open count unchanged after a cycle; pending file populated.

For 3 days, review "🔔 Closure candidates" in the morning briefing each morning and use `/task close <id>` to approve confirmed ones manually.

### Task I3 — Stage 3: Live with guardrails for 7 days

Reset auto_close threshold to 0.75:

```
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -c "
import json
from pathlib import Path
p = Path.home()/'.cache/email-ingest/task-closure-profile.json'
data = json.loads(p.read_text())
data['thresholds']['auto_close'] = 0.75
p.write_text(json.dumps(data, indent=2))
"
```

Cap stays at 3. Daily reopen-rate review:

```
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -c "
import json
from pathlib import Path
events = [json.loads(l) for l in (Path.home()/'.cache/email-ingest/task-closures.jsonl').read_text().splitlines()]
closed = sum(1 for e in events if e.get('action') == 'closed')
reopened = sum(1 for e in events if e.get('action') == 'reopened')
print(f'closed={closed} reopened={reopened} reopen_rate={reopened/max(closed,1):.2%}')
"
```

Target: reopen rate <= 20%.

### Task I4 — Stage 4: Steady state

Bump cap to 5 by editing the sync plist (`TASK_CLOSURE_CAP=5`); reload.

Add a monthly TODO via `task_add(title="Review email-task-closure profile drift", priority=2, due_date="<+30d>")`.
