# Proactive Claire — v1 Design

**Date:** 2026-04-18
**Status:** Design
**Scope:** Cross-surface awareness + anticipatory speech, reusing existing NanoClaw infrastructure (EventRouter, MessageBus, bus-watcher, task-scheduler, agent architecture).

## Goal

Make NanoClaw feel alive the way OpenClaw does: the assistant notices patterns across email, calendar, vault, and task activity, and speaks up when — and only when — it's earned the interruption. This spec delivers the *substrate* for proactivity (signal sources, delivery governor, audit log) in v1. The cross-surface correlator is explicitly deferred to v2, after the governor's proactive log gives us real data about what patterns matter.

## Design Principle

**Measure before you build the smart part.** The v1 system ships with zero correlation rules. Instead it ships expanded signal sources, a hard chokepoint for unprompted speech (the governor), and a comprehensive audit log. Two to four weeks of running v1 will reveal which patterns actually warrant correlation. v2's correlator is then grounded in observation, not archetype.

## Non-Goals (v1)

- Cross-surface correlation rules (deferred to v2)
- Self-editing rule catalogs driven by user feedback
- New signal sources beyond vault deltas, thread silence, and task outcomes
- Any changes to existing EventRouter / event-routing / bus-watcher / task-scheduler / container-runner behavior when `PROACTIVE_GOVERNOR=false`

## Architecture

Three layers, two of which already exist.

```
LAYER 1: SIGNAL GENERATION (reuse + extend)
  existing:
    gmail-watcher      ──┐
    calendar-watcher   ──┤
  new in v1:             ├──→ EventRouter.route() ──→ classify ──→ MessageBus
    vault-delta-watcher  │
    thread-silence-watcher │
    task-outcome-watcher ──┘

LAYER 2: AGENT ROUTING (existing, unchanged)
  MessageBus → bus-watcher → specialist agent container → agent decides to send

LAYER 3: OUTBOUND GOVERNOR (new — the v1 centerpiece)
  every proactive send → governor.decide() → { send | defer | drop } + reason
  every decision logged to proactive_log (SQLite)
  deferred sends held in proactive_log, re-checked on schedule
  kill switch: PROACTIVE_ENABLED=false → all decisions become drop:kill_switch
```

**Separation of concerns:**

- **Generation** — what signals exist. Watchers + EventRouter. Already classifies via phi4-mini.
- **Routing** — which agent handles which signal. event-routing.ts scores agents by topic. Unchanged.
- **Delivery** — should this actually leave, now, to whom. The new layer. Single chokepoint.

This separation is the most important property of the design. Without it, proactivity tangles with wake-up logic and becomes impossible to reason about.

## Components

### 1. Vault Delta Watcher

**File:** `src/watchers/vault-delta-watcher.ts`

**Purpose:** Emit `vault_change` events when files in the mounted vault are written.

**Behavior:**
- `fs.watch` (recursive) on each mounted vault root.
- Coalesce repeat events on the same path within 30s into one event with `coalesced_count`.
- Extract tag from path (e.g. `99-wiki/papers/` → `papers`).
- Classify author heuristically: path-based (agent writes are under `agents/output/`; user writes are elsewhere). Future refinement possible.
- Emit `RawEvent { type: 'vault_change', payload: { path, tag, author, coalesced_count } }` to EventRouter.

**Classification payload:** extends `classification-prompts.ts` with a `getVaultChangeClassificationPrompt` function. Output is the same `Classification` shape (importance, urgency, topic, summary, suggestedRouting, requiresClaude, confidence).

**Default routing for user-authored changes:** low importance, suggestedRouting='notify'. Most user vault writes are not interesting signals by themselves.

### 2. Thread Silence Watcher

**File:** `src/watchers/thread-silence-watcher.ts`

**Purpose:** Emit `silent_thread` events when an email thread has gone ≥48h with the user not having replied to the latest inbound message.

**Data gap — must be resolved before implementation.** The current email-ingest pipeline (`scripts/sync/email-ingest.py`) ingests incoming mail into QMD but does not track *sent* mail from the user. Without knowing what the user sent, we cannot determine whether they replied. Two options; pick one in implementation:

- **Option A (recommended):** extend `email-ingest.py` to also fetch the user's Sent folder via Gmail API (`in:sent`) and tag each record with `direction: inbound|outbound`. Thread reply detection becomes a straight query: "thread has inbound as latest, no outbound in the thread after the inbound timestamp."
- **Option B:** query Gmail API live in the watcher via the existing OAuth credentials, per thread, to check for user replies. Higher API cost; no new ingest work.

Option A is cleaner and gives QMD a complete thread view as a side benefit. The implementation plan must start by making this change.

**Behavior (assuming Option A):**
- Scheduled every 4h (or after every sync-all run).
- Query QMD `email` collection for threads where:
  - Most recent message in thread has `direction='inbound'`.
  - That message is ≥48h old.
  - No `direction='outbound'` message exists in the thread after that inbound timestamp.
- Dedup against `proactive_log` — if a `silent_thread` event with the same `correlation_id` (`"silent_thread:" + thread_id`) was emitted in the last 7d, skip.
- Emit one `RawEvent { type: 'silent_thread', payload: { thread_id, sender, subject, last_received_at, days_silent } }` per qualifying thread.

**Why a watcher, not a correlator:** silence-since-last-message is a single-source pattern. It's just an overdue-reply check. No cross-surface correlation needed.

### 3. Task Outcome Watcher

**File:** `src/watchers/task-outcome-watcher.ts`

**Purpose:** Emit `task_outcome` events when scheduled tasks produce surface-worthy *output*. Failure alerts are **not** this watcher's job — `task-scheduler.ts:checkAlerts()` already emits on consecutive failures and routes to `OPS_ALERT_FOLDER`. Duplicating that here would cause double-alerts. This watcher only handles positive outcomes.

**Behavior:**
- Polls `task_run_logs` table (existing) every 60s for rows with `status = 'success'` and `outcome_emitted = 0` (new column).
- Joins against `tasks` table: emit only if the task has `surface_outputs = 1` (new column on `tasks`, default 0).
- If task output is non-empty, emit `RawEvent { type: 'task_outcome', payload: { task_id, task_name, output_preview } }`.
- Set `outcome_emitted = 1` on the log row after emitting (idempotent).

**Note on existing status values:** `task_run_logs.status` uses `'success'` / `'error'` / `'skipped'` (see `db.ts:805-820`), not `'completed'` / `'failed'`. Watcher code must use the real values.

**Migration:** adds `surface_outputs INTEGER DEFAULT 0` to `tasks` table and `outcome_emitted INTEGER DEFAULT 0` to `task_run_logs` table.

**Coordination with `checkAlerts()`:** both systems read `task_run_logs`. This watcher only touches `status='success'` rows; `checkAlerts()` only touches `status='error'` rows. No overlap.

### 4. Outbound Governor

**File:** `src/outbound-governor.ts`

**Purpose:** The single chokepoint for all unprompted agent speech. Every unsolicited message passes through `governor.decide()`.

**Interface:**

```ts
interface ProactiveSend {
  fromAgent: string;
  toGroup: string;               // JID
  message: string;
  urgency: number;               // 0-1, from Classification
  correlationId: string;         // stable dedup key; composed per source
  ruleId?: string;               // 'escalate' | 'scheduled_task' | (future) 'correlation:<id>'
  contributingEvents: string[];  // classified_event IDs
}

interface GovernorDecision {
  decision: 'send' | 'defer' | 'drop';
  reason: string;
  deliverAt?: string;            // ISO timestamp, for 'defer'
}

function decide(send: ProactiveSend): GovernorDecision;
```

**Decision logic (in order):**

1. `PROACTIVE_ENABLED=false` → `drop: kill_switch`
2. Manual pause active (`pause proactive for Nh` command, stored in `data/proactive/pause.json`) → `drop: paused`
3. Dedup: `proactive_log` has a row with same `correlationId` and either `delivered_at IS NOT NULL` OR `dispatched_at IS NOT NULL` in the last `DEDUP_WINDOW_HOURS` (default 24) → `drop: duplicate_recent`. See "In-flight race" note below. Pending defers (no `dispatched_at` yet) do NOT suppress new candidates; if a fresher version of the same correlation is submitted while the first is deferred, both live in the log and whichever dispatches first wins dedup against the other.
4. Agent cooldown: `proactive_log` has a `send` from `fromAgent` within `AGENT_COOLDOWN_MINUTES` (default 20) → `defer` to `now + cooldown_remaining`
5. Quiet hours: current time (in `TIMEZONE`) outside `QUIET_HOURS_START`–`QUIET_HOURS_END` local on weekdays, **or** current day is in `QUIET_DAYS_OFF`, **and** `urgency < QUIET_OVERRIDE_THRESHOLD` (default 0.8) → `defer` to next weekday's `QUIET_HOURS_START`
6. Otherwise → `send`

**All times stored and compared in UTC.** `deliver_at` is always written as a UTC ISO string. The "next weekday 08:00" computation converts to local tz (`TIMEZONE` from config) for reasoning, then back to UTC for storage. The deferred-send processor compares UTC-to-UTC. No local-tz comparisons anywhere in governor code.

**In-flight race.** `deliverSendMessage` must set `dispatched_at = now()` on the `proactive_log` row *before* the network call to the channel. `delivered_at` is set after the send succeeds. Dedup checks both, so a second call arriving while the first is mid-flight sees `dispatched_at` and drops as duplicate. On send failure, `dispatched_at` is cleared so a retry can proceed.

**Correlation ID composition:**
- Escalation path: `"escalate:" + classification.topic + ":" + primary_entity_hash`
- Scheduled task: `"task:" + task_id + ":" + run_date`
- Future correlator: `"corr:" + rule_id + ":" + sorted_subject_entities_hash`

The governor does not invent correlation IDs; each producer is responsible for composing a stable one. A send with no `correlationId` is rejected with `drop: missing_correlation_id`.

**Persistence:** every `decide()` call writes a row to `proactive_log` before returning.

### 5. Proactive Log

**File:** `src/db.ts` (migration + CRUD)

**Schema:**

```sql
CREATE TABLE proactive_log (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,               -- ISO, UTC
  from_agent TEXT NOT NULL,
  to_group TEXT NOT NULL,
  decision TEXT NOT NULL,                -- 'send' | 'defer' | 'drop'
  reason TEXT NOT NULL,                  -- 'approved' | 'kill_switch' | 'paused' |
                                         -- 'duplicate_recent' | 'agent_cooldown' |
                                         -- 'quiet_hours' | 'missing_correlation_id' |
                                         -- 'governor_error'
  urgency REAL,
  rule_id TEXT,
  correlation_id TEXT NOT NULL,
  message_preview TEXT,                  -- first 200 chars of message
  contributing_events TEXT,              -- JSON array
  deliver_at TEXT,                       -- UTC ISO, when deferred send should fire
  dispatched_at TEXT,                    -- UTC ISO, when send was started (pre-network-call)
  delivered_at TEXT,                     -- UTC ISO, when send succeeded (null if pending/failed)
  reaction_kind TEXT,                    -- 'emoji' | 'reply' | null
  reaction_value TEXT                    -- emoji char OR first 500 chars of reply text
);
CREATE INDEX idx_proactive_log_time ON proactive_log(timestamp DESC);
CREATE INDEX idx_proactive_log_dedup ON proactive_log(correlation_id, timestamp DESC);
CREATE INDEX idx_proactive_log_pending ON proactive_log(decision, delivered_at)
  WHERE decision='defer' AND delivered_at IS NULL;
```

**Retention:** 90 days. A daily scheduled task (`proactive-log-archiver`) archives older rows to `data/proactive/archive/YYYY-MM.jsonl` and deletes from the table.

### 6. Deferred Send Processor

**File:** `src/watchers/deferred-send-processor.ts` (or integrated into existing scheduler loop)

**Purpose:** Find deferred sends whose `deliver_at` has elapsed and attempt delivery.

**Behavior:**
- Runs every 60s.
- Query `proactive_log WHERE decision='defer' AND delivered_at IS NULL AND deliver_at <= now()`.
- For each row, reconstruct a `ProactiveSend` and re-run `governor.decide()`.
  - Dedup and cooldown may now apply (e.g. moot message that would arrive after an earlier send).
  - Quiet hours may now pass.
  - A fresh `send` decision delivers via existing router and sets `delivered_at`.
  - A new `drop` records a second row; original row stays with `delivered_at=null` (auditable).

**Crash recovery:** deferred queue lives entirely in SQLite; restart reads the table. No in-memory state.

### 7. Kill Switch and Pause Command

**Kill switch:** `PROACTIVE_ENABLED` env var. Absent or `false` → governor drops everything with reason `kill_switch`. Watchers still emit; EventRouter still classifies; the only change is no proactive speech leaves. Already-deferred rows in `proactive_log` are *not* cleared on kill — when they next come due, the deferred-send processor re-runs the governor, which drops them with `kill_switch`. Flipping `PROACTIVE_ENABLED` back to true is instant and requires no state surgery; pending defers resume normal processing.

**Pause command:** Claire recognizes messages like `@claire pause proactive for 4h` or `pause proactive` (indefinite) and calls a new IPC action `set_proactive_pause` (from within her container) which writes `data/proactive/pause.json` on the host:

```json
{ "paused_until": "2026-04-18T23:00:00Z", "set_by": "user", "set_at": "..." }
```

`paused_until: null` means indefinite. `@claire resume proactive` calls `set_proactive_pause` with null. Governor reads the file (cached 5s) before other rules. Corrupt/unreadable file → fail closed (treat as paused indefinitely) + log error.

**IPC addition:** `src/ipc.ts` grows a new action `set_proactive_pause` with payload `{ pausedUntil: string | null }`. Host-side implementation writes the JSON atomically (write to tmp + rename) to avoid partial reads.

### 8. Daily Review Task

**Scheduled task:** `proactive-daily-review`, fires at 19:30 local Mon–Fri (inside the 08:00–20:00 window so it is never deferred by quiet hours). Weekend activity is rolled into Monday's digest.

**Action:** runs Claire in the main group with a templated prompt that reads `proactive_log` entries since the last successful review digest and composes:

```
Recent proactive activity (since <last_review_at>):
- N sent (list with agent, time, preview)
- N deferred (list with reason)
- N dropped (list with reason)
Anything feel wrong?
```

The digest itself is a proactive send with `correlationId = "task:proactive-daily-review:YYYY-MM-DD"` (where `YYYY-MM-DD` is today's date in `TIMEZONE`) and `urgency = 1.0`. Governor dedup ensures the digest fires exactly once per day; the high urgency makes it immune to quiet-hours deferral if the task ever slips past `QUIET_HOURS_END`.

**Correlation ID threading.** The task's agent runs inside a container via `runContainerAgent` and doesn't otherwise know what `correlationId` to stamp on its IPC send. Two implementation options:
- **Preferred:** the task-scheduler injects a `PROACTIVE_CORRELATION_ID` env var into the container when launching a task whose definition has `proactive=true`. The container-side IPC helper automatically attaches it to any `send_message` call made with `proactive: true`.
- **Fallback:** the task prompt template embeds the correlation ID as a literal string and instructs the agent to pass it. Error-prone but doesn't require container-runner changes.

The preferred option adds a small (~30 LOC) change to `container-runner.ts` to pipe the env var and to the in-container IPC wrapper to attach it.

**User reply capture:** when the user replies to the digest message in the main group within 60 minutes, the inbound-message handler in `src/index.ts` looks up the most recent `send`-decision `proactive_log` row with `correlation_id LIKE 'task:proactive-daily-review:%'` to the same `to_group`, and writes `reaction_kind='reply'` + `reaction_value=<first 500 chars>`. Claire also appends a bullet to `groups/global/memory.md` under a `## Proactive tuning notes` section. **No automatic rule/threshold changes** — all calibration is manual in v1.

### 9. Configuration

New env vars (defaults in `src/config.ts`):

| Var | Default | Meaning |
|---|---|---|
| `PROACTIVE_ENABLED` | `false` in v1 rollout, flip to `true` after governor stable | Master kill switch |
| `PROACTIVE_GOVERNOR` | `false` in first week | When false, all existing send paths bypass governor |
| `PROACTIVE_GOVERNOR_STRICT` | `true` | When true and governor crashes, sends fail closed |
| `QUIET_HOURS_START` | `"20:00"` | Local time (in `TIMEZONE`), HH:MM. Quiet starts at this time on weekdays. |
| `QUIET_HOURS_END` | `"08:00"` | Local time, HH:MM. Quiet ends at this time on weekdays. Between end and start on weekdays, sends are allowed. |
| `QUIET_DAYS_OFF` | `"Sat,Sun"` | Days treated as entirely quiet (24h). `QUIET_HOURS_START`/`END` ignored on these days. |
| `QUIET_OVERRIDE_THRESHOLD` | `0.8` | Urgency ≥ this bypasses quiet hours |
| `AGENT_COOLDOWN_MINUTES` | `20` | Min gap between unprompted sends from same agent |
| `DEDUP_WINDOW_HOURS` | `24` | Window for duplicate correlation_id suppression |
| `PROACTIVE_LOG_RETENTION_DAYS` | `90` | Before archive + delete |

## Data Flow — Worked Traces

### Trace A: Escalated email, deferred by quiet hours

Scenario: Friday 2026-04-17 at 22:14 local.

1. Gmail push → `gmail-watcher` → `EventRouter.route()` → classify → `{ importance: 0.9, urgency: 0.4, topic: "grant timeline", suggestedRouting: 'escalate' }`.
2. Trust rules apply → `routing: 'escalate'`. MessageBus publishes `classified_event`. `onEscalate` fires.
3. `routeClassifiedEvent` picks agent einstein (matched urgent topic "grant").
4. Bus file at `data/bus/agents/einstein/msg-001.json`. `bus-watcher` dispatches to einstein's container.
5. Einstein decides to surface; IPC `send_message` calls `governor.decide()`.
6. Governor checks: not killed, not paused, no dedup hit, cooldown OK. Current time 22:14 Friday, urgency 0.4, below 0.8 → `defer` until 2026-04-20T08:00 (Monday 8am — Sat/Sun are in `QUIET_DAYS_OFF`).
7. Row written to `proactive_log` with `decision=defer`, `reason=quiet_hours`, `deliver_at=2026-04-20T08:00`.
8. Deferred send processor picks it up Monday 8am, re-runs governor. If still OK → send, set `delivered_at`. If now a duplicate → new row with `decision=drop,reason=duplicate_recent`; original row remains with null `delivered_at`.

### Trace B: Vault write, no escalation

1. User edits `99-wiki/papers/foo.md`.
2. `vault-delta-watcher` coalesces any rapid repeats, emits `RawEvent { type: 'vault_change', ... }`.
3. `EventRouter.route()` classifies → low importance, `suggestedRouting: 'notify'`.
4. MessageBus publishes `classified_event`. No escalation, no agent routing.
5. No send, no governor call, no `proactive_log` entry.

Exposes: the governor is the chokepoint for *proactive speech*, not for all events. Most events never reach it. `proactive_log` reflects speech decisions only.

### Trace C: Daily review at 19:30

1. `task-scheduler` fires `proactive-daily-review`. Launch includes `PROACTIVE_CORRELATION_ID=task:proactive-daily-review:2026-04-17` env var.
2. Claire's container reads `proactive_log` entries since the last successful digest via a host-side IPC action (`read_proactive_log` — new, simple passthrough).
3. Claire composes a digest and calls `send_message` with `proactive: true`. The container IPC wrapper automatically attaches the correlation ID from env.
4. Governor: kill-switch off, not paused, no dedup hit, cooldown OK, in-window (19:30 is inside 08:00–20:00), urgency 1.0 — `send`. Row written.
5. User's reply (if any) is captured in the normal message loop. The inbound handler backfills the digest's `reaction_kind` / `reaction_value`. Claire appends calibration notes to `groups/global/memory.md` manually (no automatic rule changes).

## Error Handling

| Failure mode | Behavior |
|---|---|
| Ollama unavailable (classification) | EventRouter's existing fallback: `DEFAULT_CLASSIFICATION`, routing=`notify`, no escalation. Governor sees nothing. Fails quiet. |
| Governor throws | With `PROACTIVE_GOVERNOR_STRICT=true` (default): send is rejected, row written with `decision=drop,reason=governor_error`. With strict=false: falls through to direct delivery (legacy path). |
| `proactive_log` write fails | Send is aborted, error logged. Better to lose a proactive message than to send without audit. |
| Deferred send processor crashes | Rows remain in DB with `delivered_at=null`; restart reads them and retries. Idempotent. |
| Watcher floods events (e.g. fs churn) | Watchers coalesce at source (30s window for vault). EventRouter also has its own classification rate limits. |
| `proactive_log` grows unbounded | Daily archiver job moves >90d rows to JSONL. Table stays bounded. |
| Pause file corrupt / unreadable | Governor treats as `paused indefinitely` — fail closed. Logs error. |
| SQLite partial-index not supported on target Bun | Fall back to full index on `(decision, delivered_at)`; query remains correct, slightly less efficient. Verify in Bun smoke test during v1 rollout. |
| Daily-review task misses a day (scheduler off during 19:30) | Next run reads `proactive_log` since last successful digest (not strict 24h), so missed days roll forward into the next digest. |
| New proactive producer forgets `proactive: true` flag | Governor never called, send goes out silently. Mitigation: each new producer has an integration test asserting a `proactive_log` row is created. |

## Testing Strategy

- **Unit tests** for `governor.decide()` covering each decision branch and ordering (kill beats pause beats dedup beats cooldown beats quiet-hours).
- **Unit tests** for each watcher's event emission given controlled fs / DB / QMD fixtures.
- **Integration test:** end-to-end trace A — inject a raw email → verify governor defers → fast-forward time → verify delivery.
- **Integration test:** pause command — set pause → verify all sends dropped → resume → verify sends resume.
- **Regression guard:** with `PROACTIVE_GOVERNOR=false`, all existing send paths behave identically to today. A before/after test snapshot of existing escalation tests must be byte-identical.

## Migration / Rollout

The two flags have distinct roles:
- `PROACTIVE_GOVERNOR` gates whether producers *call* `governor.decide()`. When false, `deliverSendMessage` ignores the `proactive: true` flag on payloads — they behave exactly like reactive sends. No governor call, no `proactive_log` row.
- `PROACTIVE_ENABLED` gates the governor's decision. When false, governor still runs (logging to `proactive_log`) but always returns `drop: kill_switch`.

This means shadow mode (observe what *would* fire) is `PROACTIVE_GOVERNOR=true` + `PROACTIVE_ENABLED=false`: governor runs, logs populate, nothing sends.

1. Ship code with both flags false. New producers set `proactive: true` on their payloads but `deliverSendMessage` strips/ignores it. Functionally identical to today.
2. In a staging config, flip `PROACTIVE_GOVERNOR=true` with `PROACTIVE_ENABLED=false`. Shadow mode: `proactive_log` fills with `drop: kill_switch` rows carrying the would-be decisions. Inspect for 48h.
3. Flip `PROACTIVE_ENABLED=true`. Real proactive sends begin.
4. Run for 2–4 weeks. Use daily reviews and manual log inspection to identify patterns worth correlating.
5. Open v2 spec for the correlator, grounded in observed patterns.

## Open Decisions (deferred, not blocking implementation)

- Where the daily review digest is delivered (main group vs. silent file). Default: main group, can be overridden later without code change (task prompt controls it).
- Whether `PROACTIVE_GOVERNOR` needs its own env var or can collapse into `PROACTIVE_ENABLED`. Kept separate in v1 for shadow-mode testing; may merge post-rollout.

## Out of Scope (v2 and beyond)

- **Correlator:** cross-surface pattern matching over the classified_event stream. Design will be driven by what `proactive_log` reveals in v1.
- **Self-editing rules:** Claire proposing YAML rule changes based on user feedback. v1 logs feedback; v2 closes the loop.
- **More watchers:** git activity, paper citations, calendar-conflict detection, etc. Added per rule as patterns emerge.
- **Feedback reactions on Telegram/Slack:** wiring the user's emoji reactions back into `proactive_log.user_reaction`. Plumbing is in the schema; hook-up is v2.

## Files Changed (summary)

**New:**
- `src/watchers/vault-delta-watcher.ts` (+ test)
- `src/watchers/thread-silence-watcher.ts` (+ test)
- `src/watchers/task-outcome-watcher.ts` (+ test)
- `src/watchers/deferred-send-processor.ts` (+ test)
- `src/outbound-governor.ts` (+ test)
- `docs/superpowers/specs/2026-04-18-proactive-claire-design.md` (this file)

**Modified:**
- `src/db.ts` — add `proactive_log` table and CRUD; add `surface_outputs` column on `tasks`, `outcome_emitted` column on `task_run_logs`
- `src/config.ts` — new env vars listed above
- `src/classification-prompts.ts` — add `getVaultChangeClassificationPrompt`, `getSilentThreadPrompt`, `getTaskOutcomePrompt`
- `src/event-router.ts` — extend `RawEvent.type` union AND extend `buildPrompt()` dispatch (hard if/else currently falls through to calendar for unknown types; silent miscategorization risk)
- `src/ipc.ts` — inject governor at `deliverSendMessage` call site (line ~338) gated by `payload.proactive === true`; reactive IPC sends carry no `proactive` flag and skip governor entirely
- `src/index.ts` — wire new watchers at startup under flag
- `scripts/sync/email-ingest.py` — add Sent-folder ingestion with `direction` tag (prerequisite for thread-silence-watcher)
- `src/task-scheduler.ts` — thread `correlationId` into the proactive-daily-review task's agent prompt/env so the container agent can set it on its IPC send
- `src/router.ts` / channel adapters — no changes needed; they sit below the governor
- Scheduled task definitions — add `proactive-daily-review` and `proactive-log-archiver`

**Why this intercept point.** `ipc.ts:deliverSendMessage` already sits below the trust-decision layer at line 338, which is where unprompted agent sends land. Reactive replies use the same path but are initiated synchronously from a user message. We discriminate with an explicit `proactive: boolean` field in the `send_message` IPC payload — reactive callers omit it (defaults false), proactive callers (escalation handler, scheduled tasks, future correlator) set it true. Governor is only invoked when the flag is true. This keeps reactive latency untouched.

## Risk Register

| Risk | Mitigation |
|---|---|
| Governor refactor misses a send path | Explicit grep audit as first implementation step; tests assert no direct sends except through governor |
| User finds v1 noisy with no correlator | Easy kill switch + pause command. Per-agent cooldown defaults tight (20m). |
| User finds v1 too quiet | Daily review surfaces "X dropped today" so silence is visible, not invisible. |
| `proactive_log` schema changes in v2 | Keep v1 schema additive-only; v2 adds columns, never removes. |
| Watcher coalescing drops a real signal | Coalescing retains `coalesced_count`; classification can weight it. 30s window is conservative. |

## Acceptance Criteria (v1)

- With `PROACTIVE_GOVERNOR=false`, existing tests pass byte-identical to pre-change.
- With `PROACTIVE_GOVERNOR=true` and `PROACTIVE_ENABLED=false`, escalation paths produce `drop:kill_switch` rows in `proactive_log` but send nothing.
- With both flags true:
  - Quiet-hours trace A behaves exactly as specified.
  - Pause command halts all sends within 10s and resumes cleanly.
  - Dedup suppresses a repeat correlation ID within 24h.
  - Agent cooldown defers a rapid-fire second send.
  - Daily review fires at 21:00 and produces a digest in main.
- No proactive send bypasses `governor.decide()`. Enforced by discriminator, not by token:
  - The `send_message` IPC payload's `proactive: boolean` flag is the single discriminator. Any caller that sets it true triggers the governor.
  - All existing and new proactive producers (EventRouter escalation callback, task-outcome-watcher bus dispatch, scheduled-task agent prompts that know they are proactive) must set `proactive: true`.
  - An integration test asserts: for each proactive producer path (escalation, daily review, task outcome), a synthetic event end-to-end results in a `proactive_log` row.
  - A unit test of `deliverSendMessage` asserts that when `proactive: true` and no governor decision is attached, the call throws — preventing a producer from setting the flag but forgetting to run the governor.
  - Runtime `GovernorToken` class was considered and rejected: nothing in TS/JS prevents forging tokens cheaply, so it adds complexity without real enforcement. The tests above are the actual guardrail.
