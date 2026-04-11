# Passive Email Knowledge Ingestion

**Date:** 2026-04-11
**Status:** Approved (revised after peer review + feasibility audit)
**Goal:** NanoClaw passively reads, classifies, and ingests knowledge from all emails (Gmail + Exchange) so any agent can recall email context without the sender addressing the message to an agent alias.

## Problem

Currently emails only enter NanoClaw's knowledge when:
- They're unread in Gmail's Primary category (Gmail Channel, 60s poll)
- They're explicitly addressed to `mgandal+marvin@gmail.com` or similar aliases

This means grant updates, collaborator replies, scheduling threads, paper notifications, and institutional emails all go unseen unless the user manually asks about them. Agents can't answer "what's the status of X?" if X only exists in email.

## Architecture

A new Python script `scripts/sync/email-ingest.py` runs as a step in the existing `sync-all.sh` pipeline (cadence changed from 8h to 4h). It fetches recent emails from two sources, classifies and summarizes each in a single Ollama call with source-specific prompts, filters by relevance, and writes enriched markdown files to a QMD collection.

```
Gmail API ──┐                                              
            ├──→ Normalize ──→ Truncate body ──→ Source-specific     ──→ Threshold filter
Exchange  ──┘                  (max 16K chars)   Ollama classify+       │
(Mac Mail)                                       summarize (1 call)  relevant emails
                                                                        │
                                                              Write enriched markdown
                                                                        │
                                                          ┌─────────────┴──────────────┐
                                                    QMD collection           Hindsight retain
                                                    (durable layer)          (optional, >= 0.7)
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
  body: string;        // plain text, truncated to 16,000 chars
  labels: string[];    // Gmail labels or Exchange mailbox name
  metadata: Record<string, any>;  // source-specific signals
}
```

**Gmail adapter:**
- Uses `google-auth` + `google-api-python-client` (same credentials as `gmail-sync.py`)
- Credential loading: try `~/.google_workspace_mcp/credentials/mgandal@gmail.com.json` first, fall back to `~/.gmail-mcp/credentials.json` (same fallback chain as `gmail-sync.py` lines 30-108)
- Fetches messages after `last_gmail_epoch` using `q=after:{epoch}`
- Read-only API calls only — must NOT call `messages.modify` or mark emails as read
- Extracts: category, labels, starred, thread ID
- Uses a dedicated token file (`~/.cache/email-ingest/gmail-token.json`) to avoid OAuth token refresh contention with GmailChannel's live 60s polling

**Exchange adapter:**
- Shells out to `~/claire-tools/exchange-mail.sh search --since <days> --limit 500 --mailbox <name>` for each target mailbox
- Target mailboxes: **Inbox** and **Sent Items** (covers both received and sent context)
- Other mailboxes (custom folders, Archive) are out of scope
- Shells out to `~/claire-tools/exchange-mail.sh read <message-id>` for full body per message
- Extracts: mailbox name, flagged status, read status, internal vs external sender (domain check)
- Per-run batch limit: max 100 Exchange emails processed per run to keep AppleScript overhead bounded (~5 min). Remaining emails are picked up on next run via epoch tracking.
- `--since` days computed as: `ceil((now - last_exchange_epoch) / 86400)`, minimum 1 day

**Body truncation:** Both adapters truncate email body to 16,000 characters (~4K tokens) before passing to Ollama. This ensures the combined classify+summarize call completes in ~5-8 seconds per email, keeping the pipeline within the 10-minute target for typical volumes.

## Classification

### Two Classifiers, Single Combined Call

Separate system prompts for Gmail and Exchange, each tuned to their source's signal space. Classification and summarization are combined into a **single Ollama call** per email (not two separate calls) to halve inference time.

**Gmail classifier** inputs:
- From, To, Subject, Date
- Body (truncated to 16K chars)
- Category (Primary/Updates/Social/Promotions/Forums)
- Labels, starred status

**Exchange classifier** inputs:
- From, To, Subject, Date
- Body (truncated to 16K chars)
- Mailbox name (Inbox or Sent Items)
- Flagged status, read/unread
- Internal domain flag (true if sender/recipient @upenn.edu, @chop.edu, @pennmedicine.upenn.edu)

**Shared output schema (single combined response):**

```json
{
  "relevance": 0.0,
  "topic": "grant | hiring | research | admin | scheduling | collaboration | review | notification",
  "summary": "2-3 sentence summary of email content and significance",
  "entities": ["person names", "deadlines", "action items", "project names"],
  "action_items": ["specific next steps if any"],
  "skip_reason": null
}
```

**Model:** phi4-mini via Ollama (localhost:11434). The script explicitly sets `model=phi4-mini` in the Ollama API call — it does NOT use the `OLLAMA_MODEL` env var (which defaults to `qwen3:8b` in NanoClaw config and is intended for the event-router).

### Fast-Skip Rules (No Ollama Call)

Skip these outright to save inference time:

**Gmail:**
- Category is Promotions or Social
- Sender matches automated patterns: `noreply@`, `notifications@`, `no-reply@`, `*@github.com` CI notifications, `*@docs.google.com` (edit notifications)

**Exchange:**
- Mailbox is Junk, Deleted Items, or Drafts (skipped at the mailbox selection level — we only search Inbox and Sent Items)

Note: The original spec proposed checking `X-Auto-Response-Suppress` headers for Exchange fast-skip, but `exchange-mail.sh search` does not return headers. This rule has been removed. Auto-generated Exchange emails will be filtered by the Ollama relevance score instead.

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

[Original email body, truncated to 16K chars]
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
├── gmail-token.json          # Separate OAuth token (avoids contention with GmailChannel)
├── email-ingest-state.json
└── email-ingest.log
```

### Filesystem Security

`~/.cache/email-ingest/` must be created with `chmod 700` permissions. Email bodies contain sensitive content (grant financials, hiring discussions, institutional admin). All agent groups can query QMD collections, so the `email` collection is accessible to CLAIRE, LAB-claw, SCIENCE-claw, etc. This is consistent with the existing Apple Notes collection which has the same access profile.

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

### Dedup Strategy

- **Primary gate:** Epoch timestamp. Only fetch emails after `last_{source}_epoch`.
- **Secondary gate:** Processed ID set (capped at 10,000 per source, oldest evicted). Catches duplicates within the epoch window.
- **Epoch advancement rule:** Epoch is ONLY advanced after at least one email is successfully exported, OR after the fetch returns zero new emails. If Ollama is down and classification fails, the epoch is NOT advanced — the same window will be retried on the next run.

### First Run vs Backfill

- **First run** (no state file): Fetches last 14 days from both sources.
- **Backfill** (`--backfill 180`): Overrides the epoch to 180 days ago regardless of existing state. Processes emails from that point forward. For Exchange, backfill is limited by what Mac Mail has synced locally (typically 90 days for Exchange ActiveSync — check Mac Mail settings if more history is needed).
- **Backfill + existing state:** `--backfill` always overrides the existing epoch. It does NOT reset the processed ID set, so already-exported emails won't be re-processed.
- **Exchange backfill throughput:** Expect 1-3 hours for a 6-month window depending on mailbox size (per-message AppleScript calls at ~2-4 seconds each). Exchange backfill can be interrupted — it saves state after each batch. Use `--exchange-batch-size 50` to limit per-run processing (default: 100).

## Sync Integration

### Changes to sync-all.sh

Insert email-ingest as a new step between the Gmail migration sync (current step 2) and Apple Notes export (current step 4). Uses `$PYTHON3` (the anaconda Python already configured in sync-all.sh), not a separate venv:

```bash
# Step 3: Email knowledge ingestion (new)
log "=== [3/7] Email knowledge ingestion ==="
$PYTHON3 scripts/sync/email-ingest.py 2>&1 | tee -a "$LOG" || warn "Email ingest failed"
```

All required Python packages (`google-auth`, `google-api-python-client`, `requests`) are already available in the anaconda environment used by `gmail-sync.py`. No new venv needed.

### Launchd Cadence Change

Update `~/Library/LaunchAgents/com.nanoclaw.sync.plist`:
- Change `StartInterval` from 28800 (8h) to 14400 (4h)

### New QMD Collection

Register the email collection using the same pattern as the apple-notes collection:

```bash
qmd add email ~/.cache/email-ingest/exported/
```

Verify the collection is registered with `qmd status`. Existing `qmd update` + `qmd embed` steps in sync-all.sh will pick up new/changed email markdown files automatically.

## Hindsight Integration (Optional Layer)

For emails with `relevance >= 0.7`, after writing markdown, fire a Hindsight `retain` call:

```python
requests.post(f"{HINDSIGHT_URL}/retain", json={
    "bank": "hermes",
    "content": f"Email from {email['from']} re: {email['subject']}\n{result['summary']}\nEntities: {result['entities']}",
    "metadata": {"source": "email-ingest", "message_id": email['id']}
}, timeout=10)
```

This is fire-and-forget. Failures are logged but do not block the pipeline. If Hindsight is unavailable or removed in the future, the QMD collection remains the authoritative source.

## Dependencies

**Python packages** (all already in anaconda env via `$PYTHON3`):
- `google-auth`, `google-auth-oauthlib`, `google-api-python-client` (used by gmail-sync.py)
- `requests` (verified present by sync-health-check.sh)
- No new venv needed. No new system-level dependencies.

**External services:**
- Ollama on localhost:11434 (phi4-mini — loaded explicitly, not via OLLAMA_MODEL config)
- Mac Mail with Exchange account configured (for Exchange adapter)
- QMD on localhost:8181
- Hindsight on localhost:8889 (optional)

## Error Handling

- **Gmail API auth failure:** Log error, skip Gmail source, continue with Exchange. Do NOT advance Gmail epoch.
- **Exchange Mac Mail not running or AppleScript timeout:** Log error, skip Exchange source, continue with Gmail. Do NOT advance Exchange epoch.
- **Ollama down:** Log error, export nothing, do NOT advance either epoch. The missed window will be retried on next run.
- **Single email failure** (body fetch, classification, or write): Log and continue to next email. Do not abort batch.
- **QMD collection not configured:** Warn on first run with setup instructions.
- **Hindsight down:** Log, continue (non-blocking).
- **OAuth token refresh:** Uses dedicated token file at `~/.cache/email-ingest/gmail-token.json` to avoid contention with GmailChannel's token at `~/.gmail-mcp/credentials.json`.

## Concurrency Safety

Three systems read from the same Gmail account:

| System | Query | Writes to Gmail? | State File |
|--------|-------|:-:|---|
| GmailChannel (live) | `is:unread category:primary` | Yes (marks read) | `data/gmail-channel-state.json` |
| GmailWatcher (live) | `labelIds: ['INBOX']` | No | `gmail-state.json` |
| email-ingest (batch) | `q=after:{epoch}` | **No** | `~/.cache/email-ingest/email-ingest-state.json` |

**email-ingest is strictly read-only on Gmail.** It never modifies labels, marks read, or writes back to the API. The separate token file prevents OAuth refresh contention. Gmail API quota (250 units/s per user) is not a concern at batch volumes (50-200 emails every 4h).

## Success Criteria

1. After backfill + 2 sync cycles, an agent asked "what's the status of the scRBP grant?" can find the answer via QMD search without the user forwarding the email
2. Exchange institutional emails (from @upenn.edu, @chop.edu) are ingested alongside Gmail, including Sent Items
3. Promotional/automated emails are filtered out without Ollama calls
4. Pipeline completes within 10 minutes for a typical 4-hour window (~50-200 emails) using a single combined classify+summarize Ollama call
5. No impact on NanoClaw runtime — script runs independently of whether the service is up
6. Ollama failure does not cause permanent data loss — missed windows are retried

## Out of Scope

- Real-time email ingestion (polling/push) — this is a batch pipeline
- Email reply/send capability — existing Gmail Channel handles that
- Attachment processing — text body only for now (PDFs handled separately by PageIndex)
- Thread reconstruction — each email is a standalone document; thread context comes from QMD's semantic search finding related emails
- Exchange folders beyond Inbox and Sent Items — custom folders, Archive, etc. can be added later by extending the mailbox list
