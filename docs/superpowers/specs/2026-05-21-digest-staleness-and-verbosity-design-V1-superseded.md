---
title: Digest staleness + verbosity — closure-loop and digest-envelope fixes
date: 2026-05-21
status: draft
authors: [mgandal, claude]
---

# Digest staleness + verbosity — closure-loop and digest-envelope fixes

## Problem

Across NanoClaw's 42 active scheduled tasks, two symptoms compound:

- **Staleness.** Channels surface already-handled items. Same fact appears with different freshness in different channels. Most acute in tasks-table-reading digests (CLAIRE morning briefing, hermes-week-ahead, followup-weekly, OPS task-health).
- **Verbosity.** Even quiet days produce full-envelope digests. Compression branches in prompts rarely trigger. High signal-to-noise across channels.

## Evidence (Phase 1, 2026-05-21)

1. **Tasks-table write-asymmetry.** 19 of 27 open tasks (70%) had not been written to in >14 days. 17 of those were frozen on the Phase B migration date (2026-04-24) and never reviewed since. Closures happen in 6 burst-days over 30 days (manual cleanup passes), not continuously.
2. **Read-vs-write prompt surface.** Of 42 active scheduled tasks, 6 read `task_list` and only 1 mentions `task_close` or `task_add`. The cron prompt corpus is overwhelmingly read-only.
3. **Compression-gate stuck false.** CLAIRE morning briefing's "compress to 3-4 lines" branch requires ALL of: ≤3 events AND no conflicts AND nothing urgent AND nothing overdue AND no open follow-ups AND Slack quiet. With 17 stale OVERDUE items present, `nothing overdue` is never true → full 9-section envelope renders every day.
4. **Universal verbose pattern.** Sampling 6 non-task digests (hermes-ai-brief, hermes-blogwatcher, audit-mcp-weekly, hermes-slack-scanner, 2 × 8h context capture, r/LocalLLaMA digest):
   - None has a "what's new since last fire" clause — every prompt re-derives full payload from scratch.
   - Almost all have explicit count-floors ("3-5 item digest", "5-7 most relevant"). These create a *minimum* output even when there's less than N to say.
   - None has a quiet-day kill-switch.
5. **agent_actions empty.** Audit table has 0 rows total. Separate latent bug, not chased here, but means we cannot use it as evidence; we used direct tasks-table queries instead.

## Two root causes

### RC-1: Tasks-table has no aging process

Items enter (manually, via `task_add`, via migration) but no recurring process reviews them and proposes closures. Agents handling items in chat don't call `task_close`. As a result stale items accumulate, OVERDUE bucket stays non-empty, compression branches fail to fire.

### RC-2: Cron prompts re-render full envelopes with count-floors and no diff-against-last-fire

Every digest re-computes its payload from scratch and emits at least its count-floor (typically 3-5 items). Quiet days are indistinguishable from busy days at the output layer. This is independent of which substrate the digest reads from.

These compose: RC-1 keeps OVERDUE non-empty, defeating the briefing's compression branch. RC-2 ensures even non-task digests pad to a count on quiet days.

## Falsification test (2026-05-21 evening)

Manually archived 10 explicitly-stale tasks (IDs 3,4,6,10,18,19,20,21,22,23). If hypothesis is correct, tomorrow's 7:30am briefing should compress noticeably (fewer OVERDUE lines, possibly trigger the 3-4-line quiet-day path if also a light calendar). If briefing is still verbose with shrinking-OVERDUE, RC-1 is partially-but-not-fully load-bearing for verbosity — proceed with both fixes anyway since RC-2 still holds.

## Out of scope

- `agent_actions` audit table fix (separate latent bug).
- Cross-substrate aging (Hindsight memory pruning, Honcho context decay) — these are likely also relevant but the diagnostic evidence here is tasks-table-specific.
- Bot output observability (`is_bot_message` unused in `messages` table) — would be nice for verifying improvements but isn't blocking.
- 8h `<internal>` context-capture jobs — these don't surface to user, so don't contribute to perceived noise.

## Design

Two complementary fixes, designed to compose. Either can be shipped alone and provides partial benefit.

### Fix 1: Tasks-table aging loop (RC-1)

#### New scheduled task: `tasks-stale-review`

- **Cadence:** daily 6:00 ET (before 7:30 morning briefing).
- **Group:** `telegram_claire`.
- **Type:** scheduled task with `proactive=0`, `surface_outputs=0`. Output is a queue file, not a user message.

#### Behavior

1. Read open tasks with `updated_at < datetime('now','-14 days')`.
2. For each, gather context cheaply:
   - Search Gmail for thread mentions of task title / counterparty in last 14d.
   - Search QMD slack collection for related activity in last 14d.
   - Check `current.md` priorities for matches.
3. Classify each into one of:
   - **`close-recommended`** — strong signal item is done (counterparty replied + confirmed close, deadline passed with no chase, item explicitly marked done elsewhere).
   - **`keep-active`** — strong signal item is still real (recent activity, upcoming deadline, in `current.md`).
   - **`unclear`** — neither signal strong enough.
4. Write proposals to `data/tasks-stale-proposals.json`:
   ```json
   {
     "generated_at": "2026-05-22T06:00:00-04:00",
     "proposals": [
       { "id": 14, "title": "Respond to Jade England...", "recommendation": "close", "reason": "thread shows reply 2026-05-18, no follow-up needed", "confidence": 0.85 },
       { "id": 9, "title": "Briana Macedo thesis...", "recommendation": "unclear", "reason": "no Gmail/Slack activity, no calendar match", "confidence": 0.3 }
     ]
   }
   ```
5. **Never auto-close.** All closures require user confirmation.

#### CLAIRE morning briefing integration

After the existing briefing renders, append at most one line:

> 🧹 *Task hygiene* — I propose closing N stale items: [titles]. Reply `/stale-close <ids>` to confirm or `/stale-keep <ids>` to keep.

If no `close-recommended` proposals, line is omitted entirely.

#### New slash commands

- `/stale-close <id> [<id> ...]` — calls `task_close` for each id, removes from proposal queue.
- `/stale-keep <id> [<id> ...]` — sets `updated_at = datetime('now')` on each id (so it's no longer "stale"), removes from proposal queue. Idempotent.
- `/stale-snooze <id> <Nd>` — bumps `updated_at` by N days into the future (so it falls out of the >14d window for that long). Optional.

#### Manual `task_close` reflex

Update `current.md` and the lead agents' identity.md to require: "when you observe an open task has been handled (counterparty replied, deadline passed, decision made), call `task_close` inline before continuing." This is a behavior change, not a code change. Hindsight memory entry: `agent-must-close-handled-tasks`.

### Fix 2: Universal digest envelope (RC-2)

#### Shared digest envelope skill

Create `container/skills/digest-envelope/SKILL.md` — a skill every cron-prompted digest can opt into by referencing it.

#### Envelope rules

Every digest using the envelope must:

1. **Compute a fingerprint** of items it would send: a stable hash of `(item_id_or_title, action_signal)` for each item.
2. **Read prior fingerprint** from `data/digest-fingerprints/{task_id}.json` if it exists.
3. **Apply diff logic:**
   - If overlap with prior ≥ 90% AND no new high-priority items: send `🟢 No notable changes since last digest.` ONLY. Single line.
   - If overlap with prior 50-90%: send only the *diff* items (new + materially-changed).
   - If overlap < 50%: send full envelope as today.
4. **Write new fingerprint** after sending.
5. **Drop count-floors.** Rephrase every "3-5 items" / "5-7 items" instruction in prompts to "up to N items; less is fine; if nothing meaningful, follow the quiet-day rule above."

#### Per-digest prompt edits

For each of these prompts, add `Use the digest-envelope skill before sending.` near the top and remove count-floors:

- `claire-morning-briefing` — also fix the compression-gate by dropping `nothing overdue` from the AND-chain (after Fix 1 lands, the OVERDUE bucket will be smaller but not always empty; we want the gate to depend on "nothing *new* in OVERDUE" not "nothing in OVERDUE").
- `hermes-ai-brief` — drop "3-5 item digest" floor.
- `hermes-blogwatcher` — drop "5-7 most relevant" floor.
- `task-1776340759047-d7coxl` (r/LocalLLaMA) — drop "concise digest" implicit floor.
- `audit-mcp-weekly` — output is a status report; envelope diff catches "same MCP servers, same trust levels" case.
- `hermes-slack-scanner` — high-value envelope target; many quiet days.
- `task-1773612236244-4np9bh` (bookmarks watchlist) — diff against last fire.
- `readwise-daily-sync` — diff against last fire.

Leave alone (not user-surfacing):
- 8h context-capture tasks (`<internal>` wrapped).
- Health monitors that already trip a separate alert path (`launchd-health-*`, `task-1776735101092-u2lq23`).

#### Fingerprint storage

- Path: `data/digest-fingerprints/{schedule_task_id}.json`.
- Format: `{ "task_id": "...", "computed_at": "...", "fingerprint": "sha256...", "items": [...] }`.
- TTL: 7 days. Files older than 7d are auto-purged so a long absence doesn't make tomorrow look like a no-op.
- New container IPC needed? **No** — file lives in `/workspace/project/data/digest-fingerprints/` which agents already read/write via Bash. No IPC plumbing.

### Why not Honcho-mediated diff (Approach C from brainstorm)

Considered: store digest fingerprints in Honcho user model under workspace=nanoclaw. Rejected because:
- Honcho already does conversational memory inference; using it as a keyed-blob store fights its grain.
- File-based storage in `data/digest-fingerprints/` is auditable, debuggable, and uses existing read/write paths.
- Less coupling — if Honcho is down or slow, digests still work.

## Components

| Component | Path | Type | New/Modify |
|---|---|---|---|
| `tasks-stale-review` scheduled task | `store/messages.db:scheduled_tasks` | DB row | NEW |
| Stale-review prompt | inline in scheduled_tasks.prompt | text | NEW |
| Proposals queue file | `data/tasks-stale-proposals.json` | JSON | NEW |
| `digest-envelope` skill | `container/skills/digest-envelope/SKILL.md` | skill | NEW |
| Fingerprint dir | `data/digest-fingerprints/` | dir | NEW |
| Slash commands (`/stale-close`, `/stale-keep`, `/stale-snooze`) | `src/commands/stale.ts` (new) | TS module | NEW |
| Command registration | `src/index.ts` | TS edit | MODIFY |
| Briefing prompt | `store/messages.db:scheduled_tasks.prompt` | text | MODIFY |
| 8 other digest prompts | `store/messages.db:scheduled_tasks.prompt` | text | MODIFY |
| Lead agent identity update | `data/agents/claire/identity.md` | text | MODIFY |

## Data flow

```
06:00  tasks-stale-review fires
       └─> reads tasks WHERE updated_at < now-14d
       └─> for each: classify via Gmail/QMD/current.md
       └─> writes data/tasks-stale-proposals.json

07:30  claire-morning-briefing fires
       └─> reads task_list (existing)
       └─> reads tasks-stale-proposals.json (NEW)
       └─> uses digest-envelope skill (NEW)
       └─> renders briefing + appends "Task hygiene" line if proposals exist
       └─> writes data/digest-fingerprints/claire-morning-briefing.json

User reads briefing, replies "/stale-close 14 18 22"
       └─> src/commands/stale.ts handler
       └─> calls task_close IPC for each id
       └─> removes from proposals queue

Other digests fire on their schedules:
       └─> each uses digest-envelope skill
       └─> diff against own fingerprint
       └─> emit full / diff / quiet-line
```

## Testing

### Unit tests

- `src/commands/stale.test.ts` — slash command parsers + task_close dispatch + queue file mutation.
- `container/skills/digest-envelope/test-envelope.ts` — fingerprint computation, diff logic at 90% / 50% thresholds, TTL purge.
- `scripts/tasks-stale-review/classify.test.py` — classification fixtures (closable / keep / unclear) with mocked Gmail/QMD responses.

### Integration tests

- Run `tasks-stale-review` against current DB snapshot, verify proposals file shape and that no `close-recommended` recommendation is made for tasks updated in last 14d.
- Fire `claire-morning-briefing` twice in succession with no changes between fires; second fire should emit `🟢 No notable changes` quiet-line.
- Fire with one new high-priority task added between fires; second fire should emit diff only (not full envelope).

### Acceptance (manual)

- T+1 day after deploy: morning briefing length < 50% of T-1 baseline. (Crude but observable.)
- T+7 days: tasks aged >14d count ≤ 5 (down from 19).
- T+7 days: at least 3 cron digests have triggered the `🟢 quiet day` path in their fingerprint file history.

## Phases

### Phase 0: Falsification (already underway, 2026-05-21 evening)

10 stale tasks archived. Observe tomorrow's briefing. If significant shrinkage → both RCs confirmed compose. If no shrinkage → RC-1 is real but RC-2 dominates verbosity; proceed with both fixes anyway since each is independently justified.

### Phase 1: Tasks-table aging (RC-1)

1. Write `tasks-stale-review` prompt + register as scheduled_task with `0 6 * * *` cron.
2. Implement classification logic (start dumb: regex on title + Gmail subject matches; refine later).
3. Implement `/stale-close`, `/stale-keep`, `/stale-snooze` slash commands.
4. Modify morning briefing prompt to read proposals queue + render hygiene line.
5. Update Claire identity.md with "close inline when handled" instruction.

### Phase 2: Digest envelope (RC-2)

1. Write `digest-envelope` SKILL.md with the envelope rules.
2. Implement fingerprint compute + diff utility (Node script in `container/skills/digest-envelope/envelope.ts`).
3. Migrate prompts one at a time, starting with highest-noise (hermes-blogwatcher, hermes-ai-brief, hermes-slack-scanner).
4. Drop count-floors from migrated prompts.
5. Verify each migrated digest emits quiet-line on consecutive identical fires.

### Phase 3: Observability + tightening

1. Add `data/digest-fingerprints/_summary.json` rolling log of which digests emitted full/diff/quiet over last 14 days.
2. Add weekly OPS-claw audit task that reports digest verbosity trend (full vs diff vs quiet ratios per cron).
3. Iterate on classification heuristics in `tasks-stale-review` based on user-observed false-positives (`/stale-keep` calls are the corrective signal).

## Open questions

1. **Confidence threshold for `close-recommended`.** Start at 0.7 (conservative)? Tune based on user `/stale-keep` corrections?
2. **What if Gmail/QMD search is slow?** `tasks-stale-review` fires at 6am. Budget 10min. If timeout, write partial proposals + mark with `partial=true`.
3. **What if user ignores hygiene line for days?** Proposals queue accumulates. Cap at 20 proposals; if cap reached, escalate next morning ("⚠️ Task hygiene backlog: 20+ stale items. Reply `/stale-help` for batch options.").
4. **Cross-channel: should non-CLAIRE digests also surface stale-task hygiene?** Probably no — keep it in main channel only. Stale-task closures are global state changes; one approval surface is cleaner.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Classifier closes a real task | Never auto-close; require user confirmation via `/stale-close`. |
| Fingerprint storage corruption silently makes everything "no changes" | TTL purge + on-load JSON schema validation; if invalid, treat as no prior fingerprint and emit full envelope. |
| Prompt edits break a working digest | Migrate one prompt at a time; keep `scripts/migrations/rollback-digest-envelope-2026-05-21.sql` with the prior prompt text. |
| User finds the hygiene line annoying | One-line cap; can be silenced with `/stale-mute Nd` (P3 polish). |
| `tasks-stale-review` itself goes stale (cron silently fails) | Existing `task_health_monitor` already alerts on NEVER/STALE; new task inherits this. |

## Rollback

- Phase 1: `UPDATE scheduled_tasks SET status='paused' WHERE id='tasks-stale-review'`. Slash commands harmless if unused. Briefing prompt reverts via stored prior version.
- Phase 2: Each digest prompt edit has a rollback SQL committed alongside. Fingerprint dir can be `rm -rf`'d without state loss (next fire reads no-prior, emits full envelope).

## Success criteria

- Briefing average length (over 7d) drops ≥40% vs prior 7d baseline.
- Open tasks aged >14d drops to ≤5 within 7 days of deploy.
- At least 3 digests trigger quiet-line path within 7 days.
- Zero false-positive auto-closes (manual confirmation gate enforces this).
- User reports "feels less noisy" qualitatively.
