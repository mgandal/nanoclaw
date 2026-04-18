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

**Behavior:**
- Scheduled every 4h (or after every sync-all run).
- Query QMD `email` collection (or read `~/.cache/email-ingest/gmail-sync-state.json`) for threads where:
  - Last message is inbound (from external sender).
  - That message is ≥48h old.
  - User has not sent any reply in the thread since.
- Dedup against `proactive_log` — if a `silent_thread` event was already emitted for this `thread_id` in the last 7d, skip.
- Emit one `RawEvent { type: 'silent_thread', payload: { thread_id, sender, subject, last_received_at, days_silent } }` per qualifying thread.

**Why a watcher, not a correlator:** silence-since-last-message is a single-source pattern. It's just an overdue-reply check. No cross-surface correlation needed.

### 3. Task Outcome Watcher

**File:** `src/watchers/task-outcome-watcher.ts`

**Purpose:** Emit `task_outcome` events when scheduled tasks produce surface-worthy output or fail repeatedly.

**Behavior:**
- Polls `task_runs` table (existing) every 60s for rows with `status IN ('completed','failed')` and `outcome_emitted=0` (new column).
- For completed runs: if `output` is non-empty and task is marked `surface_outputs=1` (new task column, default 0), emit.
- For failed runs: if consecutive-failure count crosses threshold (configurable per task, default 3), emit.
- Set `outcome_emitted=1` after emitting.
- Emit `RawEvent { type: 'task_outcome', payload: { task_id, task_name, status, output_preview, failure_count } }`.

**Migration:** adds `surface_outputs INTEGER DEFAULT 0` and `outcome_emitted INTEGER DEFAULT 0` columns to `task_runs`/tasks tables.

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
3. Dedup: `proactive_log` has a row with same `correlationId` and `delivered_at IS NOT NULL` in the last `DEDUP_WINDOW_HOURS` (default 24) → `drop: duplicate_recent`. Pending defers do NOT suppress new candidates; if a fresher version of the same correlation is submitted while the first is deferred, both live in the log and whichever delivers first wins dedup against the other.
4. Agent cooldown: `proactive_log` has a `send` from `fromAgent` within `AGENT_COOLDOWN_MINUTES` (default 20) → `defer` to `now + cooldown_remaining`
5. Quiet hours: current time outside 08:00–20:00 local Mon–Fri **and** `urgency < QUIET_OVERRIDE_THRESHOLD` (default 0.8) → `defer` to next 08:00 weekday
6. Otherwise → `send`

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
                                         -- 'quiet_hours' | 'missing_correlation_id'
  urgency REAL,
  rule_id TEXT,
  correlation_id TEXT NOT NULL,
  message_preview TEXT,                  -- first 200 chars of message
  contributing_events TEXT,              -- JSON array
  deliver_at TEXT,                       -- when deferred send should fire
  delivered_at TEXT,                     -- when actually sent (null if not)
  user_reaction TEXT                     -- '👍' | '👎' | 'reply_within_10min' | null
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

**Kill switch:** `PROACTIVE_ENABLED` env var. Absent or `false` → governor drops everything with reason `kill_switch`. Watchers still emit; EventRouter still classifies; the only change is no proactive speech leaves.

**Pause command:** Claire recognizes messages like `@claire pause proactive for 4h` or `pause proactive` (indefinite). Writes `data/proactive/pause.json`:

```json
{ "paused_until": "2026-04-18T23:00:00Z", "set_by": "user", "set_at": "..." }
```

Governor checks this file (cached 5s) before other rules. `paused_until: null` means indefinite. `@claire resume proactive` clears the file.

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

The digest itself is a proactive send with `correlationId = "task:proactive-daily-review:YYYY-MM-DD"` and `urgency = 1.0`. Governor dedup ensures the digest fires exactly once per day; the high urgency makes it immune to quiet-hours deferral if the task ever slips past 20:00.

**User reply capture:** when the user replies to the digest message in the main group within 60 minutes, the reply text is written to `proactive_log.user_reaction` on the digest's row (as `reply:<first 500 chars>`). Claire also appends a bullet to `groups/global/memory.md` under a `## Proactive tuning notes` section. **No automatic rule/threshold changes** — all calibration is manual in v1.

### 9. Configuration

New env vars (defaults in `src/config.ts`):

| Var | Default | Meaning |
|---|---|---|
| `PROACTIVE_ENABLED` | `false` in v1 rollout, flip to `true` after governor stable | Master kill switch |
| `PROACTIVE_GOVERNOR` | `false` in first week | When false, all existing send paths bypass governor |
| `PROACTIVE_GOVERNOR_STRICT` | `true` | When true and governor crashes, sends fail closed |
| `QUIET_HOURS_START` | `"20:00"` | Local time, HH:MM |
| `QUIET_HOURS_END` | `"08:00"` | Local time, HH:MM |
| `QUIET_DAYS_OFF` | `"Sat,Sun"` | Days entirely in quiet hours |
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

### Trace C: Daily review at 21:00

1. `task-scheduler` fires `proactive-daily-review`.
2. Task prompt reads `proactive_log WHERE timestamp > now()-24h`.
3. Claire composes a digest and sends it to the main group (via governor — it's itself a proactive send, but rule is `"task:proactive-daily-review:YYYY-MM-DD"` so dedup prevents double-fire on retry).
4. User's reply (if any) is captured in the normal message loop. Claire appends calibration notes to `groups/global/memory.md` manually (no automatic rule changes).

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

## Testing Strategy

- **Unit tests** for `governor.decide()` covering each decision branch and ordering (kill beats pause beats dedup beats cooldown beats quiet-hours).
- **Unit tests** for each watcher's event emission given controlled fs / DB / QMD fixtures.
- **Integration test:** end-to-end trace A — inject a raw email → verify governor defers → fast-forward time → verify delivery.
- **Integration test:** pause command — set pause → verify all sends dropped → resume → verify sends resume.
- **Regression guard:** with `PROACTIVE_GOVERNOR=false`, all existing send paths behave identically to today. A before/after test snapshot of existing escalation tests must be byte-identical.

## Migration / Rollout

1. Ship code with `PROACTIVE_ENABLED=false` and `PROACTIVE_GOVERNOR=false`. Pure dead code on send paths.
2. Enable `PROACTIVE_GOVERNOR=true` in a staging branch; run for 48h with `PROACTIVE_ENABLED=false`. Governor is called but kill-switch drops every send. Verify `proactive_log` fills with realistic decisions. This is the shadow-mode check.
3. Flip `PROACTIVE_ENABLED=true` in main config. Real proactive sends begin.
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
- `src/db.ts` — add `proactive_log` table and CRUD; add `surface_outputs`, `outcome_emitted` columns
- `src/config.ts` — new env vars listed above
- `src/classification-prompts.ts` — add `getVaultChangeClassificationPrompt`, `getSilentThreadPrompt`, `getTaskOutcomePrompt`
- `src/event-router.ts` — extend `RawEvent.type` union
- `src/index.ts` — wire new watchers at startup under flag
- Every existing unprompted-send path — route through `governor.decide()` (grep audit required during implementation)
- Scheduled task definitions — add `proactive-daily-review` and `proactive-log-archiver`

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
- No proactive send in the codebase bypasses `governor.decide()`. Enforced two ways: (a) an ESLint custom rule flags any call to `router.send*` or channel `sendMessage` outside `src/outbound-governor.ts` or explicit allowlisted reactive-reply paths; (b) at runtime, proactive send call sites require a `GovernorToken` argument that only `governor.decide()` can produce — a token-less call throws.
