# Personalized Classifier Training — Implementation Plan

> **Status: SHIPPED.** `scripts/sync/email_ingest/trainer.py` (484 lines, 17K): `match_sent_to_inbox`, `label_gmail_threads`, `compute_weights`, `TrainingExample` dataclass. Builds personalized profile from reply behavior — "emails replied to = important, not replied = unimportant" — and augments the existing classifier with a sender/topic weight map. Open `- [ ]` boxes never updated retroactively.

**Goal:** Train the email classifier on the user's reply behavior — emails replied to = important, not replied = unimportant — and augment the existing classifier with a sender/topic weight map + few-shot examples.

**Architecture:** A standalone training script (`train-classifier.py`) scans Exchange Sent Items + Gmail threads to build labeled data, computes weight maps, selects few-shot examples, and writes a profile JSON. The existing `classifier.py` loads this profile and applies adjustments (prompt injection + post-scoring weights). Monthly launchd cron for retraining.

**Tech Stack:** Python 3 (anaconda), Gmail API, Exchange via `exchange-mail.sh`, JSON profile file. No Ollama calls during training.

**Spec:** `docs/superpowers/specs/2026-04-12-personalized-classifier-training-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/sync/email_ingest/trainer.py` | Create | Data collection, labeling, weight computation, few-shot selection, profile writing |
| `scripts/sync/train-classifier.py` | Create | CLI entry point for training |
| `scripts/sync/email_ingest/classifier.py` | Modify | Load profile, inject few-shot, apply post-scoring weights |
| `scripts/sync/tests/test_trainer.py` | Create | Tests for labeling, weights, few-shot selection |
| `scripts/sync/tests/test_classifier_profile.py` | Create | Tests for profile loading and weight application |
| `~/Library/LaunchAgents/com.nanoclaw.train-classifier.plist` | Create | Monthly launchd job |

---

### Task 1: Trainer — Data Collection and Labeling

**Files:**
- Create: `scripts/sync/email_ingest/trainer.py`
- Create: `scripts/sync/tests/test_trainer.py`

- [ ] **Step 1: Write tests for Exchange labeling**

Write `scripts/sync/tests/test_trainer.py`:

```python
"""Tests for classifier training — data collection and labeling."""

import json
import pytest
from unittest.mock import patch, MagicMock

from email_ingest.trainer import (
    normalize_subject,
    match_sent_to_inbox,
    label_gmail_threads,
    classify_topic_by_keywords,
    compute_weights,
    select_few_shot_examples,
    TrainingExample,
)


# --- Subject normalization ---

def test_normalize_subject_strips_re_prefix():
    assert normalize_subject("Re: Grant update") == "grant update"


def test_normalize_subject_strips_fw_prefix():
    assert normalize_subject("FW: [External] Talk Title") == "[external] talk title"


def test_normalize_subject_strips_multiple_prefixes():
    assert normalize_subject("Re: Fwd: RE: Hello") == "hello"


def test_normalize_subject_strips_whitespace():
    assert normalize_subject("  Re:  spaced out  ") == "spaced out"


# --- Exchange sent-to-inbox matching ---

def test_match_sent_to_inbox_basic():
    inbox = [
        {"id": "msg1", "subject": "Grant update", "from": "jane@upenn.edu",
         "fromName": "Jane", "date": "2026-04-10T10:00"},
        {"id": "msg2", "subject": "Lunch?", "from": "bob@gmail.com",
         "fromName": "Bob", "date": "2026-04-10T12:00"},
    ]
    sent = [
        {"id": "s1", "subject": "Re: Grant update", "date": "2026-04-10T14:00"},
    ]
    labels = match_sent_to_inbox(inbox, sent, max_hours=48)
    assert labels["msg1"] is True  # replied
    assert labels["msg2"] is False  # not replied


def test_match_sent_to_inbox_no_match_outside_window():
    inbox = [
        {"id": "msg1", "subject": "Old topic", "from": "a@b.com",
         "fromName": "A", "date": "2026-04-01T10:00"},
    ]
    sent = [
        {"id": "s1", "subject": "Re: Old topic", "date": "2026-04-05T10:00"},
    ]
    labels = match_sent_to_inbox(inbox, sent, max_hours=48)
    assert labels["msg1"] is False  # too far apart


# --- Gmail thread labeling ---

def test_label_gmail_threads_replied():
    threads = [
        {
            "id": "t1",
            "messages": [
                {"from": "jane@upenn.edu", "subject": "Paper draft", "date": "2026-04-10"},
                {"from": "mgandal@gmail.com", "subject": "Re: Paper draft", "date": "2026-04-10"},
            ],
        },
    ]
    labels = label_gmail_threads(threads, "mgandal@gmail.com")
    assert labels[0]["replied"] is True


def test_label_gmail_threads_not_replied():
    threads = [
        {
            "id": "t2",
            "messages": [
                {"from": "newsletter@nature.com", "subject": "Weekly digest", "date": "2026-04-10"},
            ],
        },
    ]
    labels = label_gmail_threads(threads, "mgandal@gmail.com")
    assert labels[0]["replied"] is False


def test_label_gmail_threads_outbound_only_excluded():
    threads = [
        {
            "id": "t3",
            "messages": [
                {"from": "mgandal@gmail.com", "subject": "Outbound", "date": "2026-04-10"},
            ],
        },
    ]
    labels = label_gmail_threads(threads, "mgandal@gmail.com")
    assert len(labels) == 0  # excluded — outbound only


# --- Keyword topic tagging ---

def test_classify_topic_grant():
    assert classify_topic_by_keywords("R01 budget revision needed") == "grant"


def test_classify_topic_hiring():
    assert classify_topic_by_keywords("Postdoc candidate interview schedule") == "hiring"


def test_classify_topic_research():
    assert classify_topic_by_keywords("Manuscript figure revisions") == "research"


def test_classify_topic_unknown():
    assert classify_topic_by_keywords("Hello there") == "other"


# --- Weight computation ---

def test_compute_weights_basic():
    examples = [
        TrainingExample(source="exchange", from_domain="chop.edu", subject="A", topic="grant", replied=True),
        TrainingExample(source="exchange", from_domain="chop.edu", subject="B", topic="grant", replied=True),
        TrainingExample(source="exchange", from_domain="chop.edu", subject="C", topic="admin", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="D", topic="notification", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="E", topic="notification", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="F", topic="notification", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="G", topic="notification", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="H", topic="notification", replied=False),
    ]
    sender_w, topic_w, baseline = compute_weights(examples, min_sender_count=2, min_topic_count=2)
    # baseline = 2/8 = 0.25
    assert abs(baseline - 0.25) < 0.01
    # chop.edu: 2/3 replied = 0.67, weight = (0.67 - 0.25) * 0.5 = 0.21
    assert sender_w["chop.edu"]["weight"] > 0.1
    # linkedin.com: 0/5 = 0.0, weight = (0.0 - 0.25) * 0.5 = -0.125
    assert sender_w["linkedin.com"]["weight"] < -0.05


def test_compute_weights_skips_small_domains():
    examples = [
        TrainingExample(source="exchange", from_domain="rare.edu", subject="X", topic="other", replied=True),
    ]
    sender_w, _, _ = compute_weights(examples, min_sender_count=5)
    assert "rare.edu" not in sender_w


# --- Few-shot selection ---

def test_select_few_shot_diverse_domains():
    examples = [
        TrainingExample(source="exchange", from_domain="chop.edu", subject="A", topic="grant", replied=True, date="2026-04-01"),
        TrainingExample(source="exchange", from_domain="upenn.edu", subject="B", topic="research", replied=True, date="2026-04-02"),
        TrainingExample(source="gmail", from_domain="nature.com", subject="C", topic="research", replied=True, date="2026-04-03"),
        TrainingExample(source="exchange", from_domain="chop.edu", subject="D", topic="admin", replied=False, date="2026-04-01"),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="E", topic="notification", replied=False, date="2026-04-02"),
        TrainingExample(source="gmail", from_domain="zoom.us", subject="F", topic="notification", replied=False, date="2026-04-03"),
    ]
    selected = select_few_shot_examples(examples, n_positive=3, n_negative=3)
    assert len(selected) == 6
    replied = [e for e in selected if e.replied]
    ignored = [e for e in selected if not e.replied]
    assert len(replied) == 3
    assert len(ignored) == 3
    # No duplicate domains within replied or ignored groups
    replied_domains = [e.from_domain for e in replied]
    assert len(replied_domains) == len(set(replied_domains))
```

- [ ] **Step 2: Run tests — expect ImportError**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_trainer.py -v
```

Expected: ImportError — `trainer` module doesn't exist.

- [ ] **Step 3: Write trainer module**

Write `scripts/sync/email_ingest/trainer.py`:

```python
"""Classifier training — builds personalized profile from reply behavior."""

import json
import logging
import re
import subprocess
import time
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from email_ingest.types import STATE_DIR, GMAIL_TOKEN_FILE

log = logging.getLogger("email-ingest.trainer")

PROFILE_FILE = STATE_DIR / "classifier-profile.json"
TRAINING_DATA_FILE = STATE_DIR / "training-data.json"
EXCHANGE_SCRIPT = Path.home() / "claire-tools" / "exchange-mail.sh"

TOPIC_KEYWORDS = {
    "grant": ["grant", "r01", "r21", "k99", "nih", "nsf", "funding", "budget", "application", "award", "subaward"],
    "hiring": ["hire", "candidate", "interview", "position", "postdoc", "salary", "offer", "recruitment"],
    "research": ["manuscript", "paper", "data", "analysis", "figure", "results", "review", "revision", "preprint"],
    "scheduling": ["meeting", "schedule", "calendar", "zoom", "appointment", "availability", "reschedule"],
    "admin": ["it", "maintenance", "hr", "payroll", "compliance", "training", "policy", "parking", "badge"],
    "collaboration": ["collaborate", "project", "proposal", "team", "lab", "join", "partnership"],
    "notification": ["alert", "notification", "digest", "newsletter", "unsubscribe", "automated"],
}

SUBJECT_PREFIX_RE = re.compile(r"^(re|fwd|fw)\s*:\s*", re.IGNORECASE)
MIN_DATASET_SIZE = 100


@dataclass
class TrainingExample:
    source: str  # 'exchange' | 'gmail'
    from_domain: str
    subject: str
    topic: str
    replied: bool
    date: str = ""
    from_name: str = ""


def normalize_subject(subject: str) -> str:
    """Strip Re:/Fwd:/FW: prefixes, normalize whitespace and case."""
    s = subject.strip()
    while True:
        new_s = SUBJECT_PREFIX_RE.sub("", s).strip()
        if new_s == s:
            break
        s = new_s
    return " ".join(s.lower().split())


def classify_topic_by_keywords(subject: str) -> str:
    """Lightweight keyword-based topic classification from subject line."""
    lower = subject.lower()
    for topic, keywords in TOPIC_KEYWORDS.items():
        for kw in keywords:
            if kw in lower:
                return topic
    return "other"


def _parse_date(date_str: str) -> Optional[datetime]:
    """Parse various date formats into datetime."""
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None


def match_sent_to_inbox(
    inbox: list[dict], sent: list[dict], max_hours: int = 48,
) -> dict[str, bool]:
    """Match Exchange Sent Items to Inbox by subject, return {msg_id: replied}."""
    # Build lookup: normalized subject → list of sent dates
    sent_by_subject: dict[str, list[datetime]] = defaultdict(list)
    for s in sent:
        norm = normalize_subject(s.get("subject", ""))
        dt = _parse_date(s.get("date", ""))
        if norm and dt:
            sent_by_subject[norm].append(dt)

    labels = {}
    for msg in inbox:
        msg_id = msg.get("id", "")
        norm = normalize_subject(msg.get("subject", ""))
        msg_dt = _parse_date(msg.get("date", ""))

        replied = False
        if norm in sent_by_subject and msg_dt:
            for sent_dt in sent_by_subject[norm]:
                # Reply must be after the received message, within max_hours
                delta = sent_dt - msg_dt
                if timedelta(0) <= delta <= timedelta(hours=max_hours):
                    replied = True
                    break
        labels[msg_id] = replied

    return labels


def label_gmail_threads(
    threads: list[dict], user_email: str,
) -> list[dict]:
    """Label Gmail threads as replied/not-replied. Excludes outbound-only threads."""
    labeled = []
    user_lower = user_email.lower()

    for thread in threads:
        messages = thread.get("messages", [])
        has_external = False
        has_user = False
        first_external = None

        for msg in messages:
            sender = msg.get("from", "").lower()
            if user_lower in sender:
                has_user = True
            else:
                has_external = True
                if first_external is None:
                    first_external = msg

        # Skip outbound-only threads
        if not has_external:
            continue

        labeled.append({
            "thread_id": thread.get("id", ""),
            "replied": has_external and has_user,
            "from_domain": _extract_domain(first_external.get("from", "")) if first_external else "",
            "from_name": first_external.get("from", "") if first_external else "",
            "subject": first_external.get("subject", "") if first_external else "",
            "date": first_external.get("date", "") if first_external else "",
        })

    return labeled


def _extract_domain(from_addr: str) -> str:
    """Extract domain from email address or From header."""
    # Handle "Name <email@domain>" format
    if "<" in from_addr:
        addr = from_addr.split("<")[-1].rstrip(">").strip()
    else:
        addr = from_addr.strip()
    return addr.split("@")[-1].lower() if "@" in addr else ""


def compute_weights(
    examples: list[TrainingExample],
    min_sender_count: int = 5,
    min_topic_count: int = 10,
    scaling: float = 0.5,
    max_weight: float = 0.25,
) -> tuple[dict, dict, float]:
    """Compute sender domain and topic weights from labeled examples.
    Returns (sender_weights, topic_weights, baseline_reply_rate)."""
    total = len(examples)
    if total == 0:
        return {}, {}, 0.0

    total_replied = sum(1 for e in examples if e.replied)
    baseline = total_replied / total

    # Sender domain weights
    domain_stats: dict[str, dict] = defaultdict(lambda: {"total": 0, "replied": 0})
    for e in examples:
        if e.from_domain:
            domain_stats[e.from_domain]["total"] += 1
            if e.replied:
                domain_stats[e.from_domain]["replied"] += 1

    sender_weights = {}
    for domain, stats in domain_stats.items():
        if stats["total"] < min_sender_count:
            continue
        reply_rate = stats["replied"] / stats["total"]
        weight = max(-max_weight, min(max_weight, (reply_rate - baseline) * scaling))
        sender_weights[domain] = {
            "total": stats["total"],
            "replied": stats["replied"],
            "reply_rate": round(reply_rate, 3),
            "weight": round(weight, 3),
        }

    # Topic weights
    topic_stats: dict[str, dict] = defaultdict(lambda: {"total": 0, "replied": 0})
    for e in examples:
        topic_stats[e.topic]["total"] += 1
        if e.replied:
            topic_stats[e.topic]["replied"] += 1

    topic_weights = {}
    for topic, stats in topic_stats.items():
        if stats["total"] < min_topic_count:
            continue
        reply_rate = stats["replied"] / stats["total"]
        weight = max(-max_weight, min(max_weight, (reply_rate - baseline) * scaling))
        topic_weights[topic] = {
            "total": stats["total"],
            "replied": stats["replied"],
            "reply_rate": round(reply_rate, 3),
            "weight": round(weight, 3),
        }

    return sender_weights, topic_weights, round(baseline, 3)


def select_few_shot_examples(
    examples: list[TrainingExample],
    n_positive: int = 5,
    n_negative: int = 5,
) -> list[TrainingExample]:
    """Select diverse few-shot examples — no duplicate domains within each group."""
    # Sort by date descending (prefer recent)
    sorted_ex = sorted(examples, key=lambda e: e.date or "", reverse=True)

    replied = [e for e in sorted_ex if e.replied]
    ignored = [e for e in sorted_ex if not e.replied]

    def pick_diverse(pool: list[TrainingExample], n: int) -> list[TrainingExample]:
        selected = []
        seen_domains = set()
        for e in pool:
            if e.from_domain in seen_domains:
                continue
            selected.append(e)
            seen_domains.add(e.from_domain)
            if len(selected) >= n:
                break
        return selected

    return pick_diverse(replied, n_positive) + pick_diverse(ignored, n_negative)


# --- Data collection ---

def collect_exchange_data(days: int = 180) -> list[TrainingExample]:
    """Fetch Exchange Inbox + Sent Items and label by reply matching."""
    if not EXCHANGE_SCRIPT.exists():
        log.warning("exchange-mail.sh not found — skipping Exchange training data")
        return []

    def run_search(mailbox: str) -> list[dict]:
        try:
            result = subprocess.run(
                ["bash", str(EXCHANGE_SCRIPT), "search",
                 "--since", str(days), "--limit", "500", "--mailbox", mailbox],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode != 0:
                return []
            return json.loads(result.stdout) if result.stdout.strip() else []
        except Exception as e:
            log.warning("Exchange search %s failed: %s", mailbox, e)
            return []

    inbox = run_search("Inbox")
    sent = run_search("Sent Items")
    log.info("Exchange training data: %d inbox, %d sent", len(inbox), len(sent))

    labels = match_sent_to_inbox(inbox, sent)

    examples = []
    for msg in inbox:
        msg_id = msg.get("id", "")
        from_addr = msg.get("from", "")
        domain = from_addr.split("@")[-1].lower() if "@" in from_addr else ""
        subject = msg.get("subject", "")
        examples.append(TrainingExample(
            source="exchange",
            from_domain=domain,
            from_name=msg.get("fromName", ""),
            subject=subject,
            topic=classify_topic_by_keywords(subject),
            replied=labels.get(msg_id, False),
            date=msg.get("date", ""),
        ))

    return examples


def collect_gmail_data(days: int = 180) -> list[TrainingExample]:
    """Fetch Gmail threads and label by reply presence."""
    try:
        from email_ingest.gmail_adapter import _load_credentials
        creds = _load_credentials()
        if not creds:
            log.warning("No Gmail credentials — skipping Gmail training data")
            return []

        from googleapiclient.discovery import build
        service = build("gmail", "v1", credentials=creds)

        # Get user email
        profile = service.users().getProfile(userId="me").execute()
        user_email = profile.get("emailAddress", "")
    except Exception as e:
        log.warning("Gmail API connection failed: %s", e)
        return []

    epoch = int(time.time()) - (days * 86400)
    query = f"after:{epoch}"

    # Fetch thread list
    thread_ids = []
    page_token = None
    while True:
        resp = service.users().threads().list(
            userId="me", q=query, maxResults=500, pageToken=page_token,
        ).execute()
        for t in resp.get("threads", []):
            thread_ids.append(t["id"])
        page_token = resp.get("nextPageToken")
        if not page_token or len(thread_ids) >= 500:
            break

    log.info("Gmail training data: %d threads to process", len(thread_ids))

    # Fetch thread metadata
    threads = []
    for tid in thread_ids:
        try:
            thread = service.users().threads().get(
                userId="me", id=tid, format="metadata",
                metadataHeaders=["From", "Subject", "Date"],
            ).execute()
            messages = []
            for msg in thread.get("messages", []):
                headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
                messages.append({
                    "from": headers.get("From", ""),
                    "subject": headers.get("Subject", ""),
                    "date": headers.get("Date", ""),
                })
            threads.append({"id": tid, "messages": messages})
        except Exception as e:
            log.debug("Failed to fetch thread %s: %s", tid, e)

    labeled = label_gmail_threads(threads, user_email)

    examples = []
    for item in labeled:
        examples.append(TrainingExample(
            source="gmail",
            from_domain=item["from_domain"],
            from_name=item["from_name"],
            subject=item["subject"],
            topic=classify_topic_by_keywords(item["subject"]),
            replied=item["replied"],
            date=item["date"],
        ))

    return examples


def balance_dataset(
    exchange: list[TrainingExample],
    gmail: list[TrainingExample],
) -> list[TrainingExample]:
    """Balance to ~2/3 Exchange, 1/3 Gmail. Use all of the smaller source."""
    import random

    if not exchange and not gmail:
        return []
    if not exchange:
        return gmail
    if not gmail:
        return exchange

    # Target: 2/3 exchange, 1/3 gmail
    target_gmail = len(exchange) // 2  # half of exchange = 1/3 of total
    if len(gmail) <= target_gmail:
        return exchange + gmail
    else:
        sampled = random.sample(gmail, target_gmail)
        return exchange + sampled


def build_profile(examples: list[TrainingExample]) -> dict:
    """Build the complete classifier profile from labeled examples."""
    if len(examples) < MIN_DATASET_SIZE:
        log.warning("Dataset too small (%d < %d) — skipping profile generation", len(examples), MIN_DATASET_SIZE)
        return {}

    sender_weights, topic_weights, baseline = compute_weights(examples)
    few_shot = select_few_shot_examples(examples)

    profile = {
        "version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "dataset_size": len(examples),
        "baseline_reply_rate": baseline,
        "sender_weights": sender_weights,
        "topic_weights": topic_weights,
        "few_shot_examples": [asdict(e) for e in few_shot],
        "stats": {
            "exchange_examples": sum(1 for e in examples if e.source == "exchange"),
            "gmail_examples": sum(1 for e in examples if e.source == "gmail"),
            "total_replied": sum(1 for e in examples if e.replied),
            "total_ignored": sum(1 for e in examples if not e.replied),
            "sender_domains_weighted": len(sender_weights),
            "topics_weighted": len(topic_weights),
        },
    }

    return profile


def save_profile(profile: dict) -> Path:
    """Write profile and training data to disk."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PROFILE_FILE.write_text(json.dumps(profile, indent=2))
    log.info("Profile written to %s", PROFILE_FILE)
    return PROFILE_FILE
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_trainer.py -v
```

Expected: All 16 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/trainer.py scripts/sync/tests/test_trainer.py
git commit -m "feat(classifier-training): data collection, labeling, weight computation, few-shot selection"
```

---

### Task 2: Classifier Profile Integration

**Files:**
- Modify: `scripts/sync/email_ingest/classifier.py`
- Create: `scripts/sync/tests/test_classifier_profile.py`

- [ ] **Step 1: Write tests for profile loading and weight application**

Write `scripts/sync/tests/test_classifier_profile.py`:

```python
"""Tests for classifier profile loading and weight application."""

import json
from pathlib import Path
from unittest.mock import patch
import pytest

from email_ingest.classifier import (
    _load_profile,
    _build_system_prompt,
    _apply_weights,
    _format_few_shot,
    _extract_domain,
)
from email_ingest.types import NormalizedEmail


SAMPLE_PROFILE = {
    "version": 1,
    "baseline_reply_rate": 0.30,
    "sender_weights": {
        "chop.edu": {"total": 45, "replied": 38, "reply_rate": 0.84, "weight": 0.25},
        "linkedin.com": {"total": 25, "replied": 0, "reply_rate": 0.0, "weight": -0.15},
    },
    "topic_weights": {
        "grant": {"total": 80, "replied": 65, "reply_rate": 0.81, "weight": 0.25},
        "notification": {"total": 200, "replied": 5, "reply_rate": 0.03, "weight": -0.14},
    },
    "few_shot_examples": [
        {"from_domain": "chop.edu", "subject": "Talk Title", "topic": "admin", "replied": True},
        {"from_domain": "linkedin.com", "subject": "New connections", "topic": "notification", "replied": False},
    ],
}


def _make_email(**overrides) -> NormalizedEmail:
    defaults = dict(
        id="test-1", source="exchange", from_addr="Jane <jane@chop.edu>",
        to=["mgandal@upenn.edu"], cc=[], subject="Grant update",
        date="2026-04-11T14:00", body="Hello", labels=["Inbox"], metadata={},
    )
    defaults.update(overrides)
    return NormalizedEmail(**defaults)


# --- Domain extraction ---

def test_extract_domain_angle_brackets():
    assert _extract_domain("Jane Doe <jane@chop.edu>") == "chop.edu"


def test_extract_domain_plain():
    assert _extract_domain("jane@upenn.edu") == "upenn.edu"


def test_extract_domain_no_at():
    assert _extract_domain("no email here") == ""


# --- Profile loading ---

def test_load_profile_returns_none_when_missing(tmp_path):
    with patch("email_ingest.classifier.PROFILE_FILE", tmp_path / "nonexistent.json"):
        assert _load_profile() is None


def test_load_profile_returns_dict_when_valid(tmp_path):
    pf = tmp_path / "profile.json"
    pf.write_text(json.dumps(SAMPLE_PROFILE))
    with patch("email_ingest.classifier.PROFILE_FILE", pf):
        profile = _load_profile()
        assert profile is not None
        assert profile["version"] == 1


def test_load_profile_returns_none_on_corrupt_json(tmp_path):
    pf = tmp_path / "profile.json"
    pf.write_text("not json at all")
    with patch("email_ingest.classifier.PROFILE_FILE", pf):
        assert _load_profile() is None


# --- Few-shot formatting ---

def test_format_few_shot_includes_replied_and_ignored():
    text = _format_few_shot(SAMPLE_PROFILE["few_shot_examples"])
    assert "REPLIED" in text
    assert "IGNORED" in text
    assert "chop.edu" in text
    assert "linkedin.com" in text


# --- Weight application ---

def test_apply_weights_boosts_known_sender():
    result = _apply_weights(0.50, _make_email(), "grant", SAMPLE_PROFILE)
    # sender chop.edu: +0.25, topic grant: +0.25
    assert result == 1.0  # clamped to max


def test_apply_weights_penalizes_low_sender():
    email = _make_email(from_addr="recruiter@linkedin.com")
    result = _apply_weights(0.40, email, "notification", SAMPLE_PROFILE)
    # sender linkedin: -0.15, topic notification: -0.14
    assert abs(result - 0.11) < 0.01


def test_apply_weights_no_profile_returns_unchanged():
    result = _apply_weights(0.50, _make_email(), "grant", None)
    assert result == 0.50


def test_apply_weights_unknown_domain_no_change():
    email = _make_email(from_addr="someone@unknown-university.edu")
    result = _apply_weights(0.50, email, "other", SAMPLE_PROFILE)
    assert result == 0.50  # no sender weight, no topic weight


def test_apply_weights_clamps_to_zero():
    email = _make_email(from_addr="spam@linkedin.com")
    result = _apply_weights(0.10, email, "notification", SAMPLE_PROFILE)
    # 0.10 - 0.15 - 0.14 = -0.19 → clamped to 0.0
    assert result == 0.0


# --- System prompt injection ---

def test_build_system_prompt_without_profile():
    with patch("email_ingest.classifier.PROFILE", None):
        prompt = _build_system_prompt("gmail")
        assert "REPLIED" not in prompt
        assert "email analysis assistant" in prompt


def test_build_system_prompt_with_profile():
    with patch("email_ingest.classifier.PROFILE", SAMPLE_PROFILE):
        prompt = _build_system_prompt("gmail")
        assert "REPLIED" in prompt
        assert "chop.edu" in prompt
```

- [ ] **Step 2: Run tests — expect failure (functions don't exist yet)**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_classifier_profile.py -v
```

Expected: ImportError for `_load_profile`, `_apply_weights`, etc.

- [ ] **Step 3: Add profile support to classifier.py**

Add the following to `scripts/sync/email_ingest/classifier.py`. Insert after the imports and before `OLLAMA_URL`:

```python
from email_ingest.types import STATE_DIR

PROFILE_FILE = STATE_DIR / "classifier-profile.json"


def _load_profile() -> dict | None:
    """Load classifier profile. Returns None if missing or corrupt."""
    if not PROFILE_FILE.exists():
        return None
    try:
        profile = json.loads(PROFILE_FILE.read_text())
        if profile.get("version") and profile.get("sender_weights") is not None:
            log.info("Loaded classifier profile (%d sender weights, %d topic weights)",
                     len(profile.get("sender_weights", {})),
                     len(profile.get("topic_weights", {})))
            return profile
    except Exception as e:
        log.warning("Failed to load classifier profile: %s", e)
    return None


def _extract_domain(from_addr: str) -> str:
    """Extract domain from email address."""
    if "<" in from_addr:
        addr = from_addr.split("<")[-1].rstrip(">").strip()
    else:
        addr = from_addr.strip()
    return addr.split("@")[-1].lower() if "@" in addr else ""


def _format_few_shot(examples: list[dict]) -> str:
    """Format few-shot examples for prompt injection."""
    replied = [e for e in examples if e.get("replied")]
    ignored = [e for e in examples if not e.get("replied")]

    lines = ["Here are examples of emails this researcher replied to vs ignored:", ""]
    if replied:
        lines.append("REPLIED:")
        for e in replied:
            lines.append(f'- From: {e.get("from_domain", "?")} | Subject: "{e.get("subject", "?")[:50]}" | Topic: {e.get("topic", "?")}')
    if ignored:
        lines.append("")
        lines.append("IGNORED:")
        for e in ignored:
            lines.append(f'- From: {e.get("from_domain", "?")} | Subject: "{e.get("subject", "?")[:50]}" | Topic: {e.get("topic", "?")}')

    lines.append("")
    lines.append("Use these patterns to inform your relevance scoring.")
    return "\n".join(lines)


def _build_system_prompt(source: str) -> str:
    """Build system prompt, injecting few-shot examples if profile exists."""
    base = SYSTEM_PROMPT_GMAIL if source == "gmail" else SYSTEM_PROMPT_EXCHANGE
    if not PROFILE or not PROFILE.get("few_shot_examples"):
        return base
    return base + "\n\n" + _format_few_shot(PROFILE["few_shot_examples"])


def _apply_weights(
    relevance: float,
    email: NormalizedEmail,
    topic: str,
    profile: dict | None,
) -> float:
    """Apply sender + topic weight adjustments. Returns clamped [0.0, 1.0]."""
    if not profile:
        return relevance

    domain = _extract_domain(email.from_addr)
    sender_adj = profile.get("sender_weights", {}).get(domain, {}).get("weight", 0.0)
    topic_adj = profile.get("topic_weights", {}).get(topic, {}).get("weight", 0.0)

    adjusted = relevance + sender_adj + topic_adj
    return max(0.0, min(1.0, round(adjusted, 3)))


# Load profile at module import (None if missing — zero behavioral change)
PROFILE = _load_profile()
```

Then modify the existing `classify_email` function to use the new functions. Replace the current `classify_email`:

```python
def classify_email(email: NormalizedEmail) -> ClassificationResult:
    """Classify and summarize an email via Ollama (single combined call).
    Applies personalized weight adjustments if profile exists."""
    system = _build_system_prompt(email.source)
    if email.source == "gmail":
        prompt = build_gmail_prompt(email)
    else:
        prompt = build_exchange_prompt(email)

    try:
        resp = requests.post(OLLAMA_URL, json={
            "model": OLLAMA_MODEL,
            "system": system,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": 512},
        }, timeout=OLLAMA_TIMEOUT)
        resp.raise_for_status()
        result = parse_classification(resp.json().get("response", ""))

        if result.skip_reason:
            return result

        # Apply personalized weight adjustments
        original = result.relevance
        result.relevance = _apply_weights(result.relevance, email, result.topic, PROFILE)
        if PROFILE and original != result.relevance:
            domain = _extract_domain(email.from_addr)
            log.debug("[%.2f → %.2f] %s: %s (sender: %s, topic: %s)",
                      original, result.relevance, email.source, email.subject[:50],
                      domain, result.topic)

        return result
    except requests.RequestException as e:
        log.error("Ollama request failed: %s", e)
        return ClassificationResult(
            relevance=0.0, topic="unknown", summary="",
            entities=[], action_items=[], skip_reason="ollama_error",
        )
```

- [ ] **Step 4: Run profile tests**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_classifier_profile.py -v
```

Expected: All 14 tests pass.

- [ ] **Step 5: Run ALL tests to check for regressions**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/ -v
```

Expected: All tests pass (42 existing + 16 trainer + 14 profile = ~72 total).

- [ ] **Step 6: Commit**

```bash
git add scripts/sync/email_ingest/classifier.py scripts/sync/tests/test_classifier_profile.py
git commit -m "feat(classifier-training): profile loading, few-shot injection, weight application"
```

---

### Task 3: Training CLI Entry Point

**Files:**
- Create: `scripts/sync/train-classifier.py`

- [ ] **Step 1: Write the training CLI**

Write `scripts/sync/train-classifier.py`:

```python
#!/usr/bin/env python3
"""Train the email classifier on reply behavior.

Scans Exchange Sent Items + Gmail threads to build a personalized
classifier profile (sender/topic weights + few-shot examples).

Usage:
    python3 train-classifier.py              # Build profile from last 180 days
    python3 train-classifier.py --days 90    # Custom window
    python3 train-classifier.py --status     # Show current profile
"""

import argparse
import json
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from email_ingest.types import STATE_DIR
from email_ingest.trainer import (
    collect_exchange_data,
    collect_gmail_data,
    balance_dataset,
    build_profile,
    save_profile,
    PROFILE_FILE,
    TRAINING_DATA_FILE,
    MIN_DATASET_SIZE,
    TrainingExample,
)
from dataclasses import asdict

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("train-classifier")


def show_status():
    """Print current profile status."""
    if not PROFILE_FILE.exists():
        print("No classifier profile found.")
        print(f"Run: python3 train-classifier.py")
        return

    profile = json.loads(PROFILE_FILE.read_text())
    print(f"Profile version:    {profile.get('version')}")
    print(f"Generated:          {profile.get('generated_at')}")
    print(f"Dataset size:       {profile.get('dataset_size')}")
    print(f"Baseline reply rate: {profile.get('baseline_reply_rate')}")
    print(f"Sender weights:     {len(profile.get('sender_weights', {}))}")
    print(f"Topic weights:      {len(profile.get('topic_weights', {}))}")
    print(f"Few-shot examples:  {len(profile.get('few_shot_examples', []))}")
    print()

    stats = profile.get("stats", {})
    print(f"Exchange examples:  {stats.get('exchange_examples', 0)}")
    print(f"Gmail examples:     {stats.get('gmail_examples', 0)}")
    print(f"Total replied:      {stats.get('total_replied', 0)}")
    print(f"Total ignored:      {stats.get('total_ignored', 0)}")
    print()

    print("Top sender weights:")
    sw = profile.get("sender_weights", {})
    for domain in sorted(sw, key=lambda d: sw[d]["weight"], reverse=True)[:10]:
        w = sw[domain]
        print(f"  {domain:30s}  weight={w['weight']:+.3f}  ({w['replied']}/{w['total']} replied)")

    print()
    print("Topic weights:")
    tw = profile.get("topic_weights", {})
    for topic in sorted(tw, key=lambda t: tw[t]["weight"], reverse=True):
        w = tw[topic]
        print(f"  {topic:20s}  weight={w['weight']:+.3f}  ({w['replied']}/{w['total']} replied)")


def main():
    parser = argparse.ArgumentParser(description="Train email classifier on reply behavior")
    parser.add_argument("--days", type=int, default=180, help="Training window in days (default: 180)")
    parser.add_argument("--status", action="store_true", help="Show current profile")
    args = parser.parse_args()

    if args.status:
        show_status()
        return

    log.info("Collecting training data (last %d days)...", args.days)

    exchange = collect_exchange_data(days=args.days)
    log.info("Exchange: %d examples (%d replied)",
             len(exchange), sum(1 for e in exchange if e.replied))

    gmail = collect_gmail_data(days=args.days)
    log.info("Gmail: %d examples (%d replied)",
             len(gmail), sum(1 for e in gmail if e.replied))

    combined = balance_dataset(exchange, gmail)
    log.info("Combined dataset: %d examples (target: 2/3 exchange, 1/3 gmail)",
             len(combined))

    if len(combined) < MIN_DATASET_SIZE:
        log.warning("Dataset too small (%d < %d). Need more email history.", len(combined), MIN_DATASET_SIZE)
        sys.exit(1)

    # Save raw training data for debugging
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    TRAINING_DATA_FILE.write_text(json.dumps([asdict(e) for e in combined], indent=2))
    log.info("Training data saved to %s", TRAINING_DATA_FILE)

    profile = build_profile(combined)
    if not profile:
        log.error("Profile generation failed")
        sys.exit(1)

    save_profile(profile)
    log.info("Done! Profile has %d sender weights, %d topic weights, %d few-shot examples",
             len(profile["sender_weights"]),
             len(profile["topic_weights"]),
             len(profile["few_shot_examples"]))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke test with --status**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 train-classifier.py --status
```

Expected: "No classifier profile found."

- [ ] **Step 3: Commit**

```bash
git add scripts/sync/train-classifier.py
git commit -m "feat(classifier-training): CLI entry point with --status and --days flags"
```

---

### Task 4: Launchd Monthly Cron

**Files:**
- Create: `~/Library/LaunchAgents/com.nanoclaw.train-classifier.plist`

- [ ] **Step 1: Create launchd plist**

Write `~/Library/LaunchAgents/com.nanoclaw.train-classifier.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.train-classifier</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3</string>
        <string>/Users/mgandal/Agents/nanoclaw/scripts/sync/train-classifier.py</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Day</key>
        <integer>1</integer>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/mgandal/.cache/email-ingest/train-classifier-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/mgandal/.cache/email-ingest/train-classifier-stderr.log</string>
    <key>WorkingDirectory</key>
    <string>/Users/mgandal/Agents/nanoclaw/scripts/sync</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/mgandal</string>
        <key>PYTHONPATH</key>
        <string>/Users/mgandal/Agents/nanoclaw/scripts/sync</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 2: Load the plist (do NOT start — just register)**

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.train-classifier.plist
```

- [ ] **Step 3: Commit**

```bash
git add scripts/sync/train-classifier.py
git commit -m "feat(classifier-training): monthly launchd cron (1st of month, 3 AM)"
```

---

### Task 5: Live Training Run + Verification

- [ ] **Step 1: Run initial training**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 train-classifier.py
```

Watch for:
- Exchange data collection (should find inbox + sent items)
- Gmail thread processing (should find threads and label replied)
- Dataset balancing (2/3 exchange, 1/3 gmail)
- Weight computation output
- Profile file written

- [ ] **Step 2: Check profile**

```bash
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 train-classifier.py --status
```

Expected: Shows sender weights, topic weights, few-shot examples, stats.

- [ ] **Step 3: Test classifier with profile**

Run a small email ingest to verify weights are being applied:

```bash
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 email-ingest.py --exchange-batch-size 3
```

Check logs for weight adjustment lines like: `[0.45 → 0.72] exchange: ...`

- [ ] **Step 4: Commit any fixes**

```bash
git add -A scripts/sync/
git commit -m "fix(classifier-training): adjustments from live training run"
```

(Skip if no fixes needed.)
