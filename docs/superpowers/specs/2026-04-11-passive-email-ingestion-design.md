# Passive Email Knowledge Ingestion

**Date:** 2026-04-11
**Status:** Approved
**Goal:** NanoClaw passively reads, classifies, and ingests knowledge from all emails (Gmail + Exchange) so any agent can recall email context without the sender addressing the message to an agent alias.

## Problem

Currently emails only enter NanoClaw's knowledge when:
- They're unread in Gmail's Primary category (Gmail Channel, 60s poll)
- They're explicitly addressed to `mgandal+marvin@gmail.com` or similar aliases

This means grant updates, collaborator replies, scheduling threads, paper notifications, and institutional emails all go unseen unless the user manually asks about them. Agents can't answer "what's the status of X?" if X only exists in email.

## Architecture

A new Python script `scripts/sync/email-ingest.py` runs as a step in the existing `sync-all.sh` pipeline (cadence changed from 8h → 4h). It fetches recent emails from two sources, classifies each with source-specific Ollama classifiers, filters by relevance, generates enriched summaries, and writes markdown files to a QMD collection.

```
Gmail API ──┐
            ├──→ Normalize ──→ Source-specific    ──→ Threshold filter
Exchange  ──┘                  Ollama classifier          │
(Mac Mail)                                         relevant emails
                                                          │
                                                 Ollama summarize + extract
                                                          │
                                            ┌─────────────┴──────────────┐
                                      Write markdown              Hindsight retain
                                      to QMD collection           (optional, ≥0.7 only)
                                            │
                                      qmd update + embed
                                      (existing sync steps)
```

### Source Adapters

Both adapters produce the same normalized format:

```typescript
interface NormalizedEmail {
  id: string;
  source: 'gmail' | 'exchange';
  from: string;        // "Name <email>"
  to: string[];
  cc: string[];
  subject: string;
  date: string;        // ISO 8601
  body: string;        // plain text
  labels: string[];    // Gmail labels or Exchange mailbox name
  metadata: Record<string, any>;  // source-specific signals
}
```

**Gmail adapter:**
- Uses `google-auth` + `google-api-python-client` (same credentials as `gmail-sync.py`: `~/.gmail-mcp/credentials.json`)
- Fetches messages after `last_gmail_epoch`
- Extracts: category, labels, starred, thread ID

**Exchange adapter:**
- Shells out to `~/claire-tools/exchange-mail.sh search --since <days>` to list messages
- Shells out to `~/claire-tools/exchange-mail.sh read <message-id>` for full body
- Extracts: mailbox name, flagged status, read status, internal vs external sender

## Classification

### Two Classifiers, Shared Output Schema

Separate classifiers for Gmail and Exchange, each tuned to their source's signal space.

**Gmail classifier** inputs:
- From, To, Subject, Date, Snippet
- Category (Primary/Updates/Social/Promotions/Forums)
- Labels, starred status, thread length

**Exchange classifier** inputs:
- From, To, Subject, Date, Snippet
- Mailbox name (Inbox, Sent, specific folders)
- Flagged status, read/unread
- Internal domain detection (@upenn.edu, @chop.edu, @pennmedicine.upenn.edu)

**Shared output schema:**

```json
{
  "relevance": 0.0,
  "topic": "grant | hiring | research | admin | scheduling | collaboration | review | notification",
  "summary": "2-3 sentence summary of email content and significance",
  "entities": ["person names", "deadlines", "action items", "project names"],
  "skip_reason": null
}
```

**Model:** phi4-mini via Ollama (localhost:11434). Same model used by event-router classification.

### Fast-Skip Rules (No Ollama Call)

Skip these outright to save inference time:

**Gmail:**
- Category is Promotions or Social
- Sender matches automated patterns: `noreply@`, `notifications@`, `no-reply@`, `*@github.com` CI notifications, `*@docs.google.com` (edit notifications)

**Exchange:**
- Mailbox is Junk, Deleted Items, or Drafts
- Auto-generated headers (X-Auto-Response-Suppress)

### Relevance Threshold

- `relevance >= 0.3` → export to markdown (QMD collection)
- `relevance >= 0.7` → also retain in Hindsight
- `relevance < 0.3` → log skip reason, do not export
- Threshold configurable via `EMAIL_INGEST_THRESHOLD` env var (default: 0.3)

## Markdown Export Format

Each email becomes one file at `~/.cache/email-ingest/exported/{source}/{YYYY-MM}/{sanitized-message-id}.md`:

```markdown
---
source: gmail
from: "Jane Doe <jane@upenn.edu>"
to: ["mgandal@gmail.com"]
cc: ["collaborator@chop.edu"]
subject: "Re: scRBP grant timeline"
date: 2026-04-11T14:30:00-04:00
labels: ["INBOX", "IMPORTANT"]
relevance: 0.82
topic: grant
entities: ["Jane Doe", "Yunlong Ma", "Apr 17 deadline", "scRBP"]
message_id: "<abc123@mail.gmail.com>"
---

## Summary
Jane confirms the Google.org AI for Science application is on track.
Yunlong Ma will submit the budget section by Apr 14. Key deadline
remains Apr 17 for the full submission.

## Action Items
- Review budget section when Yunlong sends it (by Apr 14)
- Final submission deadline: Apr 17

---

[Original email body]
```

### Directory Structure

```
~/.cache/email-ingest/
├── exported/
│   ├── gmail/
│   │   ├── 2026-03/
│   │   │   ├── abc123.md
│   │   │   └── def456.md
│   │   └── 2026-04/
│   │       └── ghi789.md
│   └── exchange/
│       └── 2026-04/
│           └── jkl012.md
├── email-ingest-state.json
└── email-ingest.log
```

## State Management

**State file:** `~/.cache/email-ingest/email-ingest-state.json`

```json
{
  "last_gmail_epoch": 1712800000,
  "last_exchange_epoch": 1712800000,
  "processed_gmail_ids": ["id1", "id2", "...up to 10000"],
  "processed_exchange_ids": ["id1", "id2", "...up to 10000"],
  "last_run": "2026-04-11T17:00:00-04:00",
  "stats": {
    "total_fetched": 150,
    "classified": 120,
    "fast_skipped": 30,
    "exported": 45,
    "hindsight_retained": 12
  }
}
```

- **Rolling window:** Each run fetches emails since last epoch
- **Dedup:** Message IDs tracked per-source, capped at 10,000 (oldest evicted)
- **First run:** If no state file, fetches last 14 days

## Backfill

One-time manual backfill to seed the last 6 months of context:

```bash
python3 scripts/sync/email-ingest.py --backfill 180
```

Uses the same pipeline — just overrides the date range. May take 30-60 minutes depending on volume and Ollama throughput. Can be interrupted and resumed (state tracks processed IDs).

## Sync Integration

### Changes to sync-all.sh

Add email-ingest as step 2 (after Gmail migration sync, before QMD update):

```bash
# Step 2: Email knowledge ingestion
log "=== Email ingestion ==="
python3 scripts/sync/email-ingest.py 2>&1 | tee -a "$LOG" || warn "Email ingest failed"
```

### Launchd Cadence Change

Update `~/Library/LaunchAgents/com.nanoclaw.sync.plist`:
- Change `StartInterval` from 28800 (8h) to 14400 (4h)

### New QMD Collection

Add `email` collection to QMD config pointing at `~/.cache/email-ingest/exported/`:

```bash
qmd add email ~/.cache/email-ingest/exported/ --glob "**/*.md"
```

Existing `qmd update` + `qmd embed` steps in sync-all.sh will pick up new/changed email files automatically.

## Hindsight Integration (Optional Layer)

For emails with `relevance >= 0.7`, after writing markdown, fire a Hindsight `retain` call:

```python
requests.post(f"{HINDSIGHT_URL}/retain", json={
    "bank": "hermes",
    "content": f"Email from {email.from} re: {email.subject}\n{classification.summary}\nEntities: {classification.entities}",
    "metadata": {"source": "email-ingest", "message_id": email.id}
})
```

This is fire-and-forget. Failures are logged but do not block the pipeline. If Hindsight is unavailable or removed in the future, the QMD collection remains the authoritative source.

## Dependencies

**Python packages** (new venv at `scripts/sync/email-ingest-venv/`):
- `google-auth`, `google-auth-oauthlib`, `google-api-python-client` (already used by gmail-sync.py — share or copy)
- `requests` (for Ollama + Hindsight HTTP calls)
- No new system-level dependencies

**External services:**
- Ollama on localhost:11434 (phi4-mini)
- Mac Mail with Exchange account configured (for Exchange adapter)
- QMD on localhost:8181
- Hindsight on localhost:8889 (optional)

## Error Handling

- **Gmail API auth failure:** Log error, skip Gmail source, continue with Exchange
- **Exchange Mac Mail not running:** Log error, skip Exchange source, continue with Gmail
- **Ollama down:** Log error, skip classification, export nothing (don't export unclassified emails)
- **Single email failure:** Log and continue to next email (don't abort batch)
- **QMD collection not configured:** Warn on first run with setup instructions
- **Hindsight down:** Log, continue (non-blocking)

## Success Criteria

1. After backfill + 2 sync cycles, an agent asked "what's the status of the scRBP grant?" can find the answer via QMD search without the user forwarding the email
2. Exchange institutional emails (from @upenn.edu, @chop.edu) are ingested alongside Gmail
3. Promotional/automated emails are filtered out without Ollama calls
4. Pipeline completes within 10 minutes for a typical 4-hour window (~50-200 emails)
5. No impact on NanoClaw runtime — script runs independently of whether the service is up

## Out of Scope

- Real-time email ingestion (polling/push) — this is a batch pipeline
- Email reply/send capability — existing Gmail Channel handles that
- Attachment processing — text body only for now (PDFs handled separately by PageIndex)
- Thread reconstruction — each email is a standalone document; thread context comes from QMD's semantic search finding related emails
