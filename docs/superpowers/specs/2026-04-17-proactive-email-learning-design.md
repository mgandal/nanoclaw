# Proactive Email Learning — Design

**Date:** 2026-04-17
**Author:** Claude (with Mike Gandal)
**Status:** Approved — ready for implementation plan

## Goal

Make Claire proactive by learning from Mike's sent and critical received email. Extract commitments Mike has made, asks awaiting his reply, and significant decisions from email flow, and surface the actionable pieces in the morning briefing.

Today, `nanoclaw-inbox-monitor` only watches unread mail to `mgandal+cc@gmail.com`, and `email-ingest.py` passively exports all mail to QMD + Hindsight (relevance ≥ 0.7) but does no structured extraction. The gap: nothing watches what Mike *sent* or what he's implicitly promised / been asked.

## Scope

**In scope — extraction sources:**
- Sent mail from `mgandal@gmail.com` (primary identity)
- Sent mail from Exchange (work identity)
- Received mail across all inboxes, filtered by existing relevance ≥ 0.7

**Out of scope:**
- `mikejg1838@gmail.com` (personal, excluded per decision)
- `mgandal+cc@gmail.com` unread monitoring — `nanoclaw-inbox-monitor` keeps doing its thing; may be simplified in a follow-on but not touched here
- Reply drafting, calendar-event creation, email routing (Claire never sends email)

## Decisions Taken

1. **Three outputs**: (a) follow-up tracking, (b) decision memory, (c) anything else signal-worthy — all three, not one of them.
2. **Sent-mail scope**: Gmail main + Exchange only. Skip `mikejg1838`.
3. **Critical received bar**: reuse existing relevance ≥ 0.7. No separate VIP list or thread-activity filter in v1.
4. **Storage**: dedicated `groups/global/state/followups.md` for commitments + asks. Decisions → Hindsight only (`decision-*`).
5. **Where extraction lives**: hybrid — `email-ingest.py` does structured extraction with `phi4-mini` (cheap, 4h cadence). Claire is thin — reads `followups.md` for the morning briefing, doesn't re-extract.
6. **Auto-closure**: conservative — close `i-owe` when Mike sends a later email in the same thread; close `they-owe-me` when the counterparty replies. No LLM-judged closure.
7. **Aging**: items open > 14 days → `status: stale`, drop from briefing (still in file).
8. **Decision significance bar**: medium — `phi4-mini` classifies `no-decision` / `routine` / `significant`. Retain only `significant` to Hindsight.
9. **Decisions are on-demand, not proactive**: no briefing line for decisions; Claire retrieves via Hindsight/QMD search when context calls for it.
10. **Briefing format**: terse two-bucket section (`You owe` / `Awaiting you`), max 5 per bucket, `[new]` tag for items created in the last 24h, overflow as `(+N more in followups.md)`.

## Architecture

```
┌─────────────────────────┐
│ email-ingest.py (4h)    │  existing passive pipeline
│  + new extraction pass  │  ← the addition
└──────────┬──────────────┘
           │
   ┌───────┼────────────────────┐
   ↓       ↓                    ↓
 QMD    Hindsight         followups.md
(search) (decision-*,   (i-owe / they-owe-me,
         followup-*)     dedupe, aging)
   │       │                    │
   │       └────┬───────────────┘
   │            ↓
   │   claire-morning-briefing
   │   reads followups.md →
   │   "Follow-ups" section
   │
   └── Claire searches Hindsight
       on demand for decision recall
```

**Pipeline additions (inside `email-ingest.py`):**

1. **Closure pass (at cycle start)** — load open entries from `followups.md`, fetch thread activity for each since `created_at`, apply closure rules, rewrite file.
2. **Aging pass** — any entry still `open` with `created_at < now - 14d` → `status: stale`.
3. **Existing passes** (unchanged) — fetch, fast-skip, classify for relevance, export to QMD, retain to Hindsight at ≥ 0.7.
4. **NEW extraction pass** — for each email where:
   - `source in {gmail-main, exchange}` AND `direction == sent` → extract `i-owe` + significant decisions
   - `direction == received` AND `relevance >= 0.7` → extract `they-owe-me` asks
   Call `phi4-mini` with a strict JSON prompt. Parse. Dedupe. Append follow-ups to `followups.md`. Retain decisions to Hindsight.

Closure and aging run before extraction so the morning briefing, if it happens to execute in the middle of a run, always sees the most recent state.

## Data Schema

### `groups/global/state/followups.md`

Location: `groups/global/state/followups.md` (globally mounted, read-only to agents via `/workspace/project/groups/global/state/`, read-write to host).

```markdown
# Follow-ups

_Managed by email-ingest.py. Claire reads this for the morning briefing. Manual edits OK — aging/closure runs on next ingest._

## Open

### 2026-04-15 · i-owe · Sarah Chen
- **what:** Send revised methods section for the aging paper
- **due:** 2026-04-22
- **thread:** gmail:17f3b2a88c1d4e55
- **source_msg:** gmail:17f3b2a88c1d4e55
- **created:** 2026-04-15T14:22:00Z
- **status:** open

### 2026-04-16 · they-owe-me · program.officer@nih.gov
- **what:** Confirm whether supplement budget includes equipment line
- **due:** (none)
- **thread:** exchange:AAMkAD...
- **source_msg:** exchange:AAMkAD...
- **created:** 2026-04-16T09:40:00Z
- **status:** open

## Stale

_Items open > 14 days. Not surfaced in briefing. Review and close/snooze periodically._

### 2026-03-20 · they-owe-me · collaborator@stanford.edu
- **what:** Send revised figure 3 panels
- ...

## Closed

### 2026-04-10 · i-owe · Marco Rossi
- **what:** Share RNA-seq preprocessing script
- **closed_reason:** replied-in-thread
- **closed_at:** 2026-04-14T10:15:00Z
- **thread:** gmail:17edcb...
```

**Fields:**

| field | type | required | purpose |
|---|---|---|---|
| heading (`YYYY-MM-DD · kind · who`) | string | yes | scannable; date = `created` |
| `what` | string | yes | one-line action summary from extraction |
| `due` | ISO date or `(none)` | yes | extracted only if explicit |
| `thread` | `gmail:<id>` or `exchange:<id>` | yes | closure key |
| `source_msg` | `gmail:<id>` or `exchange:<id>` | yes | message that spawned the item |
| `created` | ISO timestamp | yes | entry creation |
| `status` | `open` / `stale` / `closed` / `snoozed` | yes | lifecycle |
| `closed_reason` | enum | when closed | `replied-in-thread` / `counterparty-replied` / `manual` / `aged-out-manual` |
| `closed_at` | ISO timestamp | when closed | closure time |

**Dedupe rule:**

A new extraction is considered a duplicate of an existing `open` entry iff:
- `kind` matches AND
- `thread` matches AND
- Jaccard similarity on normalized-what ≥ 0.6

`normalize(what)`: lowercase → strip punctuation → remove stopwords (`the`, `a`, `to`, `for`, `on`, `in`, `of`, `and`, `or`, `with`) → take first 8 tokens → token set.

**Aging rule:**

On each `email-ingest.py` run:
- `status == open AND now - created > 14d` → set `status: stale` and move under `## Stale`.

**Closure rules:**

On each `email-ingest.py` run, for each `open` entry, fetch thread activity since `created_at`:
- `i-owe` → closed if any `sent` message by Mike appears in `thread` after `created`. `closed_reason: replied-in-thread`.
- `they-owe-me` → closed if any `received` message from the original counterparty appears in `thread` after `created`. `closed_reason: counterparty-replied`.

Counterparty identification: for `they-owe-me`, the counterparty is the `From` of the `source_msg` (the person who asked). For `i-owe`, closure doesn't need counterparty identification — any sent message by Mike in the thread after `created_at` closes it.

**Manual edits:**

Mike can edit the file directly. Aging/closure only transition entries between statuses based on the rules above; they never resurrect a manually-closed entry or touch entries with `status: snoozed`. File rewrite preserves unknown fields verbatim.

### Hindsight records

| document_id | content | retain trigger |
|---|---|---|
| `decision-YYYY-MM-DD-<slug>` | email snippet (first 500 chars) + `decision_summary` + thread-id + participants | `phi4-mini` returns `significant: true` on a sent email |
| `followup-<thread-id>` | `{kind, who, what, due, created}` + email snippet | every new open follow-up written to `followups.md` |

Closure updates the `followup-*` Hindsight record with `status: closed` (via `mcp__hindsight__update` if available, else new revision).

## Extraction

### Prompt for `phi4-mini`

One shared prompt, different inputs for sent vs received. Emits strict JSON.

```
You are analyzing a single email for commitment, ask, and decision signals.
Output valid JSON only — no prose, no markdown.

Schema:
{
  "kind": "i-owe" | "they-owe-me" | "none",
  "who": "<counterparty name or email>",
  "what": "<one-line action, <= 120 chars, imperative mood>",
  "due": "YYYY-MM-DD" | "none",
  "significant": true | false,
  "decision_summary": "<one-line summary of decision Mike made, or empty>"
}

Rules:
- kind = "i-owe" only if Mike (the sender, if this is sent mail) made a clear commitment to send/do/deliver something.
- kind = "they-owe-me" only if the email contains a clear ask directed at Mike that awaits his reply.
- kind = "none" if routine (FYI, thanks, scheduling chitchat, newsletter).
- significant = true only if this email reflects a meaningful decision by Mike about: funding, scope, hiring/firing, methodology, collaboration, or a public position. Routine scheduling, acknowledgments, FYI replies → false.
- decision_summary empty unless significant = true.
- due must be explicit in the email; otherwise "none".

Input:
Direction: <sent|received>
From: <addr>
To: <addrs>
Date: <ISO>
Subject: <subject>
Body (first 2000 chars):
<body>
```

Malformed JSON → log warning, skip this email for extraction (existing relevance/QMD/Hindsight passes still run). No retry. Extraction is best-effort.

### Python module layout

New file: `scripts/sync/email_ingest/followups.py`
- `FollowUp` dataclass (matches schema above)
- `parse_file(path) -> list[FollowUp]`
- `write_file(path, items)` — atomic `.tmp` → `rename`
- `normalize_what(s) -> set[str]`
- `jaccard(a, b) -> float`
- `is_duplicate(new, existing) -> bool`

New file: `scripts/sync/email_ingest/extractor.py`
- `extract(email, direction) -> ExtractionResult | None`
- Owns the prompt + JSON parsing
- Dataclass `ExtractionResult{kind, who, what, due, significant, decision_summary}`

New file: `scripts/sync/email_ingest/closure.py`
- `apply_closure(items, gmail_adapter, exchange_adapter) -> (updated_items, closed_count)`
- Only touches entries with `status == open`
- Queries thread activity via the adapters

New file: `scripts/sync/email_ingest/aging.py`
- `apply_aging(items, now, threshold_days=14) -> (updated_items, aged_count)`

Modified: `scripts/sync/email-ingest.py`
- Call order: load follow-ups → apply_closure → apply_aging → existing fetch loop → for each qualifying email call `extract` and append/dedupe → write follow-ups → exit
- Stats dict gets new keys: `commitments_added`, `asks_added`, `decisions_retained`, `followups_closed`, `followups_aged`

## Claire Morning Briefing Integration

`claire-morning-briefing` prompt gains one step after the existing gather-data block:

```
STEP N — Follow-ups:
Read /workspace/project/groups/global/state/followups.md.
Parse the "## Open" section only. Filter to entries where:
  - status == open
  - created is within the last 14 days
Sort by created desc.

Render a section in the briefing:

📋 *Follow-ups*

*You owe* (i-owe):
• <what> — <who>, <created_date>[, due <due>][ [new]]
  (up to 5; if more: "(+N more in followups.md)")

*Awaiting you* (they-owe-me):
• <what> — <who>, <created_date>[, due <due>][ [new]]
  (up to 5; if more: "(+N more in followups.md)")

[new] tag = created within last 24h.

If both buckets are empty, omit the section entirely.
```

This is an additive change to the existing prompt — no other step removed or altered.

## Error Handling

| failure | behavior |
|---|---|
| `phi4-mini` returns malformed JSON | log warning, skip extraction for this email, continue ingest |
| Ollama unreachable | log warning, skip extraction pass for this run, relevance/QMD/Hindsight passes still run |
| `followups.md` missing | create empty file with just the header + `## Open` section |
| `followups.md` corrupt (can't parse an entry) | log error, preserve the raw section verbatim, continue with parseable entries. Never silently drop entries. |
| Hindsight retain fails | log warning, leave follow-up in file (file is source of truth; Hindsight is mirror) |
| Thread-activity fetch fails during closure | log warning, leave entry `open`, retry next run |

No new retry loops. Best-effort extraction, authoritative file, passive Hindsight mirror.

## Testing

New test file: `scripts/sync/tests/test_followups.py`
- `parse_file` round-trips through `write_file`
- `normalize_what` removes punctuation + stopwords
- `jaccard` edge cases (empty sets, full overlap, threshold boundary)
- `is_duplicate` with matching thread + near-match what
- Manual edits preserved through a closure/aging cycle
- Corrupt entry handling does not drop siblings

New test file: `scripts/sync/tests/test_extractor.py`
- Valid JSON → parsed `ExtractionResult`
- Malformed JSON → `None` + log
- Empty body → `kind: none` return
- Mocks `phi4-mini` with canned responses (don't hit Ollama)

New test file: `scripts/sync/tests/test_closure.py`
- `i-owe` closed when later sent message in thread
- `they-owe-me` closed when counterparty replies
- No closure when only a third party replies
- Entries with `status != open` untouched

New test file: `scripts/sync/tests/test_aging.py`
- 13 days old → still `open`
- 15 days old → `stale`
- Already `stale` → untouched
- `closed` and `snoozed` → untouched

All tests must pass before the spec is considered implemented. Run via the existing `scripts/sync/tests/` runner pattern.

## Rollout

1. Ship code + tests. No behavior change yet — new module not wired in.
2. Wire new passes into `email-ingest.py` behind a `EMAIL_FOLLOWUPS_ENABLED=1` env flag (default off).
3. Enable flag in launchd plist. Let it run for one 4h cycle in observe mode (extraction runs, writes to `followups.md`, but briefing edit not live).
4. Review `followups.md` manually. Tune prompt if needed.
5. Update `claire-morning-briefing` prompt via SQLite to add the follow-ups step.
6. Remove the env-flag gate once stable.

Backfill: optional `--backfill N` on `email-ingest.py` replays the last N days. Same flag already exists — new passes just participate.

## Risks & Mitigations

| risk | mitigation |
|---|---|
| Over-extraction — every email spawns a follow-up | Medium bar on `significant`; `kind: none` common; manual review before briefing wiring |
| Under-extraction — real commitments missed | Conservative is fine for v1; we can tune the prompt after seeing a week of output |
| `followups.md` grows unbounded | Aging moves items to `## Stale`; `## Closed` can be periodically pruned (manual for v1, automation if needed) |
| Thread-id mismatch between Gmail and Exchange | Prefix thread-ids with source (`gmail:` / `exchange:`); closure only matches within the same prefix |
| Dedupe misses variants | Jaccard 0.6 is a reasonable start; tune if we see duplicates after a week |
| Manual edits lost on rewrite | Parser preserves unknown fields; atomic `.tmp` → `rename` write; keep `followups.md` in git via existing `groups/` tracking |

## Files Touched

**New:**
- `scripts/sync/email_ingest/followups.py`
- `scripts/sync/email_ingest/extractor.py`
- `scripts/sync/email_ingest/closure.py`
- `scripts/sync/email_ingest/aging.py`
- `scripts/sync/tests/test_followups.py`
- `scripts/sync/tests/test_extractor.py`
- `scripts/sync/tests/test_closure.py`
- `scripts/sync/tests/test_aging.py`
- `groups/global/state/followups.md` (initial empty template)

**Modified:**
- `scripts/sync/email-ingest.py` (wire new passes, stats dict)
- `scripts/sync/email_ingest/types.py` (if a new shared type is needed)
- `scripts/sync/email_ingest/gmail_adapter.py` (add `fetch_thread_messages(thread_id, since)` for closure)
- `scripts/sync/email_ingest/exchange_adapter.py` (same)
- Claire morning briefing prompt — update in place via `sqlite3 store/messages.db` (rollout step 5)

**Not touched:**
- `nanoclaw-inbox-monitor` scheduled task
- `groups/global/state/decisions.md` (human-curated architecture log, different purpose)
- Any agent CLAUDE.md
- Any container code

## Open Questions Deferred to Implementation

- Exact Ollama client wrapper — reuse whatever `classifier.py` already uses for `phi4-mini` calls.
- Snooze UX — out of scope for v1. Mike can set `status: snoozed` manually; aging/closure will leave it alone.
- Weekly stale review — not automated in v1. Mike reviews `## Stale` section manually.
