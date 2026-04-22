"""Classify a BCC'd email into one of four processing buckets.

Used by the mgandal-cc-inbox NanoClaw skill (ported from Hermes
hermes-inbox-monitor). Labels:

  A — Calendar event (meeting invite, scheduling info)
  B — Action instruction (Mike added a directive at top)
  C — Knowledge content (research, references, attachments to save)
  D — Unclear (don't mark read; surface for review)

The LLM skill makes the final call; this helper is a deterministic
pre-pass so (a) trivial classifications skip the LLM entirely, and
(b) there's a testable invariant for the red/green migration loop.
"""

from __future__ import annotations

import re
from typing import Mapping


# Ordered: action > calendar > knowledge > unclear.
# Action wins over calendar because a user directive at the top of a forwarded
# calendar invite is still an explicit instruction (type B).

ACTION_PREFIXES = (
    "draft ",          # draft reply / draft decline / draft response
    "reply ",
    "schedule ",
    "add to tasks",
    "add to todoist",
    "follow up",
    "follow-up",
    "decline",
    "accept",
    "forward to",
    "fyi",             # informational but still a directive
    "remind me",
    "save ",
    "save to",
)

CALENDAR_KEYWORDS = (
    "calendar invite",
    "meeting",
    "let's meet",
    "lets meet",
    "zoom",
    "reschedul",
    "at 3pm",          # timebound phrasing
    "at 2pm",
    "invite:",
    "RSVP",
    "attendees",
)

KNOWLEDGE_KEYWORDS = (
    "pdf attached",
    "attached",
    "adding for the kb",
    "for the kb",
    "preprint",
    "paper on",
    "nature paper",
    "benchmark",
    "reference",
    "saving this",
    "for reference",
)


def _instruction_line(body: str) -> str:
    """Return the first non-empty line of the body in lowercase, or ''."""
    for line in body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped.lower()
    return ""


def _has_action_directive(body: str) -> bool:
    """Mike puts directives at the very top, before any forwarded content."""
    first = _instruction_line(body)
    if not first:
        return False
    # Cheap length guard — directives are short ("draft decline", not a paragraph).
    if len(first) > 120:
        return False
    # Don't match forward-header lines ("---------- Forwarded message ---------").
    if first.startswith("-") or first.startswith("from:") or first.startswith("subject:"):
        return False
    return any(first.startswith(p) or p in first for p in ACTION_PREFIXES)


def _has_calendar_signal(subject: str, body: str) -> bool:
    blob = f"{subject}\n{body}".lower()
    if any(k.lower() in blob for k in CALENDAR_KEYWORDS):
        return True
    # Timestamped phrasing: "Thursday at 3pm", "Mon 3:30", "Tuesday 10am".
    if re.search(
        r"\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b.*\b\d{1,2}(:\d{2})?\s*(am|pm)\b",
        blob,
    ):
        return True
    return False


def _has_knowledge_signal(subject: str, body: str) -> bool:
    blob = f"{subject}\n{body}".lower()
    return any(k in blob for k in KNOWLEDGE_KEYWORDS)


def classify(email: Mapping[str, str]) -> str:
    """Return 'A' | 'B' | 'C' | 'D' for a BCC'd email.

    Expects dict-like with keys 'subject', 'from', 'body' — matches the
    shape Hermes's hermes-inbox-monitor skill reads from Gmail API.
    """
    subject = (email.get("subject") or "").strip()
    body = email.get("body") or ""

    # Order matters: action directive wins over embedded calendar/knowledge
    # content because Mike's top-of-body note is the operative instruction.
    if _has_action_directive(body):
        return "B"
    if _has_calendar_signal(subject, body):
        return "A"
    if _has_knowledge_signal(subject, body):
        return "C"
    return "D"
