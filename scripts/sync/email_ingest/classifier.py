"""Ollama-based email classification + summarization (single combined call)."""

import json
import logging
import re

import requests

from email_ingest.types import NormalizedEmail, ClassificationResult

log = logging.getLogger("email-ingest.classifier")

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "phi4-mini"  # Explicit — does NOT use OLLAMA_MODEL env var
OLLAMA_TIMEOUT = 30  # seconds per call

# Automated sender patterns (Gmail fast-skip)
AUTOMATED_PATTERNS = [
    re.compile(r"^noreply@", re.IGNORECASE),
    re.compile(r"^no-reply@", re.IGNORECASE),
    re.compile(r"^notifications?@", re.IGNORECASE),
    re.compile(r"@github\.com$", re.IGNORECASE),
    re.compile(r"@docs\.google\.com$", re.IGNORECASE),
    re.compile(r"^mailer-daemon@", re.IGNORECASE),
]

SYSTEM_PROMPT_GMAIL = """You are an email analysis assistant for an academic researcher (neuroscience/genomics PI at UPenn). Analyze this Gmail message and return a JSON object:

{
  "relevance": 0.0-1.0 (how relevant to the researcher's work — grants, papers, collaborators, students, hiring, admin),
  "topic": "grant | hiring | research | admin | scheduling | collaboration | review | notification | personal",
  "summary": "2-3 sentence summary of the email content and its significance",
  "entities": ["person names", "project names", "deadlines", "institutions"],
  "action_items": ["specific next steps if any, empty list if none"]
}

Score relevance based on: direct communication from collaborators/students (0.7+), grant/paper updates (0.8+), scheduling (0.5), newsletters/bulk (0.1-0.2), automated notifications (0.0-0.1).

Gmail-specific: use the category and labels to inform your scoring. CATEGORY_UPDATES emails are usually lower relevance than INBOX/Primary.

Respond with ONLY the JSON object."""

SYSTEM_PROMPT_EXCHANGE = """You are an email analysis assistant for an academic researcher (neuroscience/genomics PI at UPenn). Analyze this Exchange/Outlook email and return a JSON object:

{
  "relevance": 0.0-1.0 (how relevant to the researcher's work — grants, papers, collaborators, students, hiring, admin),
  "topic": "grant | hiring | research | admin | scheduling | collaboration | review | notification | personal",
  "summary": "2-3 sentence summary of the email content and its significance",
  "entities": ["person names", "project names", "deadlines", "institutions"],
  "action_items": ["specific next steps if any, empty list if none"]
}

Score relevance based on: direct communication from internal colleagues (0.7+), institutional admin/HR (0.5+), IT notifications (0.2), automated system emails (0.0-0.1).

Exchange-specific: emails from @upenn.edu, @chop.edu, @pennmedicine.upenn.edu are internal — typically higher relevance. Flagged emails are important. Sent Items show what the researcher sent — relevant for context recall.

Respond with ONLY the JSON object."""


def should_fast_skip(email: NormalizedEmail) -> str | None:
    """Return skip reason if email should be skipped without Ollama, else None."""
    if email.source == "gmail":
        labels = set(email.labels)
        if "CATEGORY_PROMOTIONS" in labels:
            return "promotional"
        if "CATEGORY_SOCIAL" in labels:
            return "social"

        # Check automated sender patterns
        sender = email.from_addr.split("<")[-1].rstrip(">").strip() if "<" in email.from_addr else email.from_addr
        for pattern in AUTOMATED_PATTERNS:
            if pattern.search(sender):
                return "automated"

    # Exchange: no header-based fast-skip (search doesn't return headers).
    # Junk/Deleted/Drafts are excluded at the mailbox selection level.

    return None


def build_gmail_prompt(email: NormalizedEmail) -> str:
    """Build user prompt for Gmail classification."""
    lines = [
        f"From: {email.from_addr}",
        f"To: {', '.join(email.to)}",
    ]
    if email.cc:
        lines.append(f"Cc: {', '.join(email.cc)}")
    lines.extend([
        f"Subject: {email.subject}",
        f"Date: {email.date}",
        f"Labels: {', '.join(email.labels)}",
        "",
        "Body:",
        email.body[:4000] if len(email.body) > 4000 else email.body,
    ])
    return "\n".join(lines)


def build_exchange_prompt(email: NormalizedEmail) -> str:
    """Build user prompt for Exchange classification."""
    meta = email.metadata
    lines = [
        f"From: {email.from_addr}",
        f"To: {', '.join(email.to)}",
    ]
    if email.cc:
        lines.append(f"Cc: {', '.join(email.cc)}")
    lines.extend([
        f"Subject: {email.subject}",
        f"Date: {email.date}",
        f"Mailbox: {meta.get('mailbox', 'Inbox')}",
        f"Flagged: {meta.get('flagged', False)}",
        f"Internal sender: {meta.get('internal', False)}",
        "",
        "Body:",
        email.body[:4000] if len(email.body) > 4000 else email.body,
    ])
    return "\n".join(lines)


def parse_classification(raw: str) -> ClassificationResult:
    """Parse Ollama JSON response into ClassificationResult."""
    # Strip markdown code fences if present
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(cleaned.split("\n")[1:])
    if cleaned.endswith("```"):
        cleaned = "\n".join(cleaned.split("\n")[:-1])
    cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned)
        return ClassificationResult(
            relevance=float(data.get("relevance", 0.0)),
            topic=data.get("topic", "unknown"),
            summary=data.get("summary", ""),
            entities=data.get("entities", []),
            action_items=data.get("action_items", []),
        )
    except (json.JSONDecodeError, ValueError, TypeError) as e:
        log.warning("Failed to parse classification: %s — raw: %s", e, raw[:200])
        return ClassificationResult(
            relevance=0.0, topic="unknown", summary="",
            entities=[], action_items=[], skip_reason="classification_failed",
        )


def classify_email(email: NormalizedEmail) -> ClassificationResult:
    """Classify and summarize an email via Ollama (single combined call)."""
    if email.source == "gmail":
        system = SYSTEM_PROMPT_GMAIL
        prompt = build_gmail_prompt(email)
    else:
        system = SYSTEM_PROMPT_EXCHANGE
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
        return parse_classification(resp.json().get("response", ""))
    except requests.RequestException as e:
        log.error("Ollama request failed: %s", e)
        return ClassificationResult(
            relevance=0.0, topic="unknown", summary="",
            entities=[], action_items=[], skip_reason="ollama_error",
        )
