"""phi4-mini extraction of commitments, asks, and significant decisions."""

import json
import logging
import re
from dataclasses import dataclass
from typing import Optional

import requests

from email_ingest.types import NormalizedEmail

log = logging.getLogger("email-ingest.extractor")

_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*\n(.*?)\n\s*```\s*$", re.DOTALL)

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "phi4-mini"
OLLAMA_TIMEOUT = 30

BODY_CAP = 2000

_SYSTEM_PROMPT = """You are analyzing a single email for commitment, ask, and decision signals.
Output valid JSON only — no prose, no markdown.

Schema:
{
  "kind": "i-owe" | "they-owe-me" | "none",
  "who": "<counterparty name or email>",
  "what": "<one-line action, <= 120 chars, imperative mood>",
  "due": "YYYY-MM-DD" | "none",
  "significant": true | false,
  "decision_summary": "<one-line summary of a decision the user made, or empty>"
}

Rules:
- kind = "i-owe" only if the user (sender, if direction=sent) made a clear commitment to send/do/deliver something.
- kind = "they-owe-me" only if the email contains a clear ask directed at the user that awaits their reply.
- kind = "none" if routine (FYI, thanks, scheduling chitchat, newsletter, confirmation).
- significant = true only if the email reflects a meaningful decision by the user about: funding, scope, hiring/firing, methodology, collaboration, or a public position. Routine scheduling, acknowledgments, FYI replies → false.
- decision_summary empty unless significant = true.
- due must be explicit in the email; otherwise "none".
"""


@dataclass
class ExtractionResult:
    kind: str  # "i-owe" | "they-owe-me" | "none"
    who: str
    what: str
    due: str  # ISO date or "none"
    significant: bool
    decision_summary: str


def build_prompt(email: NormalizedEmail, direction: str) -> str:
    body = email.body[:BODY_CAP] if email.body else ""
    return "\n".join([
        f"Direction: {direction}",
        f"From: {email.from_addr}",
        f"To: {', '.join(email.to)}",
        f"Date: {email.date}",
        f"Subject: {email.subject}",
        "Body:",
        body,
    ])


def _parse_response(raw: str) -> Optional[ExtractionResult]:
    cleaned = (raw or "").strip()
    if not cleaned:
        return None
    fence_match = _FENCE_RE.match(cleaned)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        log.warning("extractor: malformed JSON: %s", raw[:200])
        return None
    try:
        return ExtractionResult(
            kind=str(data["kind"]),
            who=str(data.get("who", "")),
            what=str(data.get("what", "")),
            due=str(data.get("due", "none")),
            significant=bool(data.get("significant", False)),
            decision_summary=str(data.get("decision_summary", "")),
        )
    except (KeyError, TypeError, ValueError) as e:
        log.warning("extractor: schema mismatch: %s (raw: %s)", e, raw[:200])
        return None


def extract(email: NormalizedEmail, direction: str) -> Optional[ExtractionResult]:
    """Run phi4-mini extraction. Returns None on any failure."""
    if not email.body:
        return None
    prompt = build_prompt(email, direction)
    try:
        resp = requests.post(
            OLLAMA_URL,
            json={
                "model": OLLAMA_MODEL,
                "system": _SYSTEM_PROMPT,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.1, "num_predict": 256},
            },
            timeout=OLLAMA_TIMEOUT,
        )
        resp.raise_for_status()
        raw = resp.json().get("response", "")
    except requests.RequestException as e:
        log.warning("extractor: Ollama request failed: %s", e)
        return None
    return _parse_response(raw)
