# Personalized Email Classifier Training

**Date:** 2026-04-12
**Status:** Approved
**Goal:** Train the email ingestion classifier on the user's actual reply behavior so it learns what emails are personally important, rather than relying solely on generic heuristics.

## Problem

The current classifier uses a generic system prompt that scores relevance based on hardcoded rules ("collaborator emails = 0.7+, grant updates = 0.8+"). This misses personal patterns — some senders always get replies, some topics are more important than the generic prompt knows, and borderline emails (relevance 0.2-0.5) get inconsistent treatment. The user's own reply history is the best signal for what matters.

## Architecture

A new script `scripts/sync/train-classifier.py` runs monthly via launchd. It scans Exchange Sent Items and Gmail threads to build a labeled dataset (replied vs not replied), computes a sender/topic weight map from reply frequencies, selects representative few-shot examples, and writes everything to a profile file. The existing classifier loads this profile at startup and applies personalized adjustments.

```
Exchange Sent Items ──┐
(2/3 of data)         ├──→ Label: replied / not replied ──→ Aggregate by
Gmail Threads ────────┘                                     sender domain + topic
(1/3 of data)                                                      │
                                                          ┌────────┴─────────┐
                                                    Weight map          Few-shot examples
                                                    (sender + topic     (5 replied,
                                                     adjustments)        5 ignored)
                                                          │                    │
                                                          └────────┬───────────┘
                                                                   │
                                                    classifier-profile.json
                                                    (~/.cache/email-ingest/)
                                                                   │
                                                    classifier.py loads at startup
                                                    ├─ Injects few-shot into prompt
                                                    └─ Applies weight adjustments post-scoring
```

## Data Collection

### Exchange (2/3 of Training Data)

Source: `~/claire-tools/exchange-mail.sh`

**Step 1: Fetch Inbox messages** (received emails, last 6 months)
- `exchange-mail.sh search --since 180 --limit 500 --mailbox Inbox`
- Extract: message ID, from address, from domain, subject, date

**Step 2: Fetch Sent Items** (your replies, last 6 months)
- `exchange-mail.sh search --since 180 --limit 500 --mailbox "Sent Items"`
- Extract: message ID, subject, date

**Step 3: Match sent → received by subject threading**
- Strip `Re:`, `Fwd:`, `FW:`, `RE:` prefixes from subjects
- Normalize whitespace and case
- For each Sent Items message, find Inbox messages with matching normalized subject sent within 48 hours before the reply
- If a match is found: label the Inbox message as `replied=true`
- Unmatched Inbox messages: `replied=false`

**Note:** Only metadata is needed (search output). Full body reads (`exchange-mail.sh read`) are NOT required for training — this keeps the script fast (~1 minute for Exchange vs hours for full reads).

### Gmail (1/3 of Training Data)

Source: Gmail API (same credentials as email-ingest.py, using dedicated token at `~/.cache/email-ingest/gmail-token.json`)

**Step 1: Fetch threads from last 6 months**
- `users.threads.list(q="after:{epoch}", maxResults=500)`
- For each thread: `users.threads.get(id, format="metadata", metadataHeaders=["From", "Subject", "Date"])`

**Step 2: Label by reply presence**
- For each thread, check if any message has `From: mgandal@gmail.com` (or the authenticated user's email)
- If yes AND the thread also contains messages from external senders → `replied=true`
- Threads with only your messages (outbound-only) are excluded
- Threads with only external messages → `replied=false`

**Step 3: Extract training features**
- From domain, subject, date, Gmail category label (Primary/Updates/etc.)

### Combined Labeled Dataset

Merge Exchange and Gmail datasets. Target: ~500-1500 labeled examples depending on email volume.

```json
[
  {
    "source": "exchange",
    "from_domain": "chop.edu",
    "from_name": "Delaney, Susan K",
    "subject": "Re: FW: Talk Title",
    "replied": true,
    "date": "2026-04-11"
  },
  {
    "source": "gmail",
    "from_domain": "nature.com",
    "from_name": "Nature Genetics",
    "subject": "Your manuscript NG-A12345",
    "replied": true,
    "date": "2026-03-15"
  },
  {
    "source": "exchange",
    "from_domain": "upenn.edu",
    "from_name": "IT Service Desk",
    "subject": "Planned maintenance window",
    "replied": false,
    "date": "2026-02-20"
  }
]
```

### Data Split

To maintain the 2/3 Exchange + 1/3 Gmail ratio:
- If Exchange yields 600 examples and Gmail yields 800: use all 600 Exchange + randomly sample 300 Gmail = 900 total
- If either source has fewer examples, use all available from that source and adjust the other proportionally
- Minimum viable dataset: 100 examples (50 replied, 50 not replied). If below this threshold, log a warning and skip profile generation.

## Weight Map

### Sender Domain Weights

Aggregate reply rate per sender domain:

```
reply_rate(domain) = count(replied=true AND from_domain=domain) / count(from_domain=domain)
baseline = count(replied=true) / count(all)
weight(domain) = (reply_rate(domain) - baseline) * 0.5
```

- `0.5` is the scaling factor — caps individual domain adjustments to roughly ±0.25
- Domains with fewer than 5 emails in the dataset get no weight (insufficient data)
- Weight is clamped to [-0.25, +0.25]

Example output:
```json
{
  "sender_weights": {
    "chop.edu": { "total": 45, "replied": 38, "reply_rate": 0.84, "weight": 0.27 },
    "upenn.edu": { "total": 60, "replied": 42, "reply_rate": 0.70, "weight": 0.20 },
    "pennmedicine.upenn.edu": { "total": 30, "replied": 25, "reply_rate": 0.83, "weight": 0.27 },
    "gmail.com": { "total": 120, "replied": 15, "reply_rate": 0.13, "weight": -0.09 },
    "linkedin.com": { "total": 25, "replied": 0, "reply_rate": 0.00, "weight": -0.15 }
  }
}
```

### Topic Weights

The training script does NOT call Ollama to classify topics for training examples (that would be too slow for 1000+ emails). Instead, it uses a lightweight keyword-based topic tagger:

```python
TOPIC_KEYWORDS = {
    "grant": ["grant", "R01", "R21", "K99", "NIH", "NSF", "funding", "budget", "application", "award"],
    "hiring": ["hire", "candidate", "interview", "position", "postdoc", "salary", "offer"],
    "research": ["manuscript", "paper", "data", "analysis", "figure", "results", "review"],
    "scheduling": ["meeting", "schedule", "calendar", "zoom", "appointment", "availability"],
    "admin": ["IT", "maintenance", "HR", "payroll", "compliance", "training", "policy"],
    "collaboration": ["collaborate", "project", "proposal", "team", "lab", "join"],
}
```

Match subject line against keywords. If no match → topic is `"other"`.

Topic weight formula is the same as sender domain:
```
weight(topic) = (reply_rate(topic) - baseline) * 0.5
```

Clamped to [-0.25, +0.25]. Topics with fewer than 10 examples get no weight.

Example output:
```json
{
  "topic_weights": {
    "grant": { "total": 80, "replied": 65, "reply_rate": 0.81, "weight": 0.26 },
    "hiring": { "total": 30, "replied": 22, "reply_rate": 0.73, "weight": 0.22 },
    "research": { "total": 150, "replied": 90, "reply_rate": 0.60, "weight": 0.15 },
    "scheduling": { "total": 60, "replied": 40, "reply_rate": 0.67, "weight": 0.18 },
    "admin": { "total": 100, "replied": 20, "reply_rate": 0.20, "weight": -0.05 },
    "notification": { "total": 200, "replied": 5, "reply_rate": 0.03, "weight": -0.14 }
  }
}
```

## Few-Shot Examples

Select 10 examples from the labeled dataset for injection into the classifier system prompt:

**Selection criteria:**
- 5 emails you replied to (positive examples)
- 5 emails you ignored (negative examples)
- Diversity: no two examples from the same sender domain
- Prefer recent examples (last 3 months) over older ones
- For negative examples, prefer borderline cases (institutional emails you didn't reply to) over obvious spam

**Format in the system prompt:**
```
Here are examples of emails this researcher replied to vs ignored:

REPLIED:
- From: chop.edu | Subject: "Re: Talk Title" | Topic: admin
- From: upenn.edu | Subject: "NIH dbGaP application" | Topic: grant
- From: nature.com | Subject: "Your manuscript decision" | Topic: research
- From: gmail.com | Subject: "Collaboration on scRBP" | Topic: collaboration
- From: stanford.edu | Subject: "Postdoc position inquiry" | Topic: hiring

IGNORED:
- From: upenn.edu | Subject: "Planned maintenance window" | Topic: admin
- From: linkedin.com | Subject: "5 new connections" | Topic: notification
- From: noreply@zoom.us | Subject: "Cloud recording available" | Topic: notification
- From: cvent.com | Subject: "Conference registration reminder" | Topic: scheduling
- From: chop.edu | Subject: "Grand Rounds this Friday" | Topic: admin

Use these patterns to inform your relevance scoring.
```

## Classifier Profile File

All training output is written to a single JSON file:

**Path:** `~/.cache/email-ingest/classifier-profile.json`

```json
{
  "version": 1,
  "generated_at": "2026-04-12T03:00:00-0400",
  "dataset_size": 900,
  "baseline_reply_rate": 0.30,
  "sender_weights": { ... },
  "topic_weights": { ... },
  "few_shot_examples": [
    { "from_domain": "chop.edu", "subject": "Re: Talk Title", "topic": "admin", "replied": true },
    ...
  ],
  "stats": {
    "exchange_examples": 600,
    "gmail_examples": 300,
    "total_replied": 270,
    "total_ignored": 630,
    "sender_domains_weighted": 15,
    "topics_weighted": 5
  }
}
```

## Classifier Integration

Changes to `scripts/sync/email_ingest/classifier.py`:

### 1. Profile Loading

At module import, load `classifier-profile.json` if it exists. If missing, all personalization is disabled — the classifier works exactly as before (zero behavioral change without training data).

```python
PROFILE = _load_profile()  # Returns None if file missing

def _load_profile():
    path = STATE_DIR / "classifier-profile.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None
```

### 2. Prompt Injection

If PROFILE exists, append few-shot examples to the system prompt:

```python
def _build_system_prompt(source: str) -> str:
    base = SYSTEM_PROMPT_GMAIL if source == "gmail" else SYSTEM_PROMPT_EXCHANGE
    if not PROFILE or not PROFILE.get("few_shot_examples"):
        return base
    examples = _format_few_shot(PROFILE["few_shot_examples"])
    return base + "\n\n" + examples
```

The few-shot block adds ~200 tokens to the prompt. phi4-mini handles this within the same inference budget.

### 3. Post-Scoring Weight Adjustment

After Ollama returns a relevance score, apply sender + topic adjustments:

```python
def _apply_weights(relevance: float, email: NormalizedEmail, topic: str) -> float:
    if not PROFILE:
        return relevance

    # Extract sender domain
    domain = _extract_domain(email.from_addr)
    sender_adj = PROFILE.get("sender_weights", {}).get(domain, {}).get("weight", 0.0)
    topic_adj = PROFILE.get("topic_weights", {}).get(topic, {}).get("weight", 0.0)

    adjusted = relevance + sender_adj + topic_adj
    return max(0.0, min(1.0, adjusted))
```

This happens after `parse_classification()` returns and before the threshold check. The adjustment is additive and clamped to [0.0, 1.0].

### 4. Logging

When weights are applied, log the adjustment for debugging:

```
[0.45 → 0.72] exchange: Re: Talk Title (sender: +0.27 chop.edu, topic: +0.00)
```

## Schedule

### Initial Build
Run once manually after backfill completes:
```bash
cd ~/Agents/nanoclaw/scripts/sync
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 train-classifier.py
```

### Monthly Rebuild
New launchd job: `~/Library/LaunchAgents/com.nanoclaw.train-classifier.plist`
- Schedule: 1st of each month at 3:00 AM
- Script: `/Users/mgandal/Agents/nanoclaw/scripts/sync/train-classifier.py`
- Runtime: ~5-10 minutes (metadata-only API calls, no Ollama, no full body reads)

## Dependencies

**Python packages** (all in anaconda env):
- `google-auth`, `google-api-python-client` (same as email-ingest)
- `json`, `re`, `collections` (stdlib)
- No new dependencies

**External services:**
- Gmail API (read-only, metadata only)
- Mac Mail via `exchange-mail.sh` (search only, no read — fast)
- No Ollama calls during training

**Files read:**
- `~/.cache/email-ingest/gmail-token.json` (shared with email-ingest)
- `~/claire-tools/exchange-mail.sh`

**Files written:**
- `~/.cache/email-ingest/classifier-profile.json`
- `~/.cache/email-ingest/training-data.json` (raw labeled dataset, kept for debugging)

## Error Handling

- **Gmail API failure:** Log error, skip Gmail data, build profile from Exchange only (still 2/3 of data)
- **Exchange failure:** Log error, skip Exchange data, build from Gmail only (less data but functional)
- **Both fail:** Log error, do not write profile. Existing profile (if any) remains in use.
- **Dataset too small (<100 examples):** Log warning, do not write profile. Generic classifier continues as-is.
- **Corrupt profile file:** Classifier catches exception in `_load_profile()`, falls back to generic behavior.

## Success Criteria

1. After training, emails from frequent collaborators (chop.edu, upenn.edu) get a measurable relevance boost
2. Notification/automated emails get a relevance penalty even when the generic classifier scores them 0.3-0.4
3. Classifier still works identically if the profile file is deleted — zero regression risk
4. Monthly rebuild completes in under 10 minutes
5. Training data ratio is approximately 2:1 Exchange:Gmail

## Out of Scope

- Ollama fine-tuning (LoRA, Modelfile) — too heavy for this use case; few-shot + weights achieves similar personalization
- Real-time learning (update weights on every reply) — monthly batch is sufficient
- Per-email dynamic retrieval of similar replied-to examples — static few-shot is simpler and fast enough
- Body content analysis for training — subject + sender domain is sufficient signal; body would require full reads which are slow for Exchange
