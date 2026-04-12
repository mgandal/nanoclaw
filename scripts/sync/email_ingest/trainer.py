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
    # Build lookup: normalized subject -> list of sent dates
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
