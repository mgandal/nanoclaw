"""Markdown file exporter + optional Hindsight retention."""

import logging
import os
import re
from pathlib import Path

import requests

from email_ingest.types import NormalizedEmail, ClassificationResult, EXPORT_DIR

log = logging.getLogger("email-ingest.exporter")


def sanitize_filename(s: str) -> str:
    """Sanitize a string for use as a filename."""
    clean = re.sub(r"[<>:\"/\\|?*\s@.]+", "-", s)
    clean = clean.strip("-")
    return clean[:100]


def _extract_yyyy_mm(date_str: str) -> str:
    """Extract YYYY-MM from an ISO date string. Falls back to 'unknown'."""
    match = re.match(r"(\d{4})-?(\d{2})", date_str)
    if match:
        return f"{match.group(1)}-{match.group(2)}"
    # Try other date formats
    import email.utils
    try:
        parsed = email.utils.parsedate_to_datetime(date_str)
        return parsed.strftime("%Y-%m")
    except Exception:
        return "unknown"


def _infer_direction(email: NormalizedEmail) -> str:
    """Infer message direction from Gmail labels.

    Gmail tags outbound mail with SENT. If label present → 'outbound'.
    Otherwise → 'inbound'. Exchange messages default to 'inbound' since
    we don't ingest the Sent Items folder for Exchange in v1.
    """
    if "SENT" in (email.labels or []):
        return "outbound"
    return "inbound"


def build_markdown(email: NormalizedEmail, result: ClassificationResult) -> str:
    """Build enriched markdown document from email + classification."""
    entities_yaml = "[" + ", ".join(f'"{e}"' for e in result.entities) + "]"
    to_yaml = "[" + ", ".join(f'"{t}"' for t in email.to) + "]"
    cc_yaml = "[" + ", ".join(f'"{c}"' for c in email.cc) + "]" if email.cc else "[]"
    direction = _infer_direction(email)
    thread_id = (email.metadata or {}).get("threadId", "")

    lines = [
        "---",
        f"source: {email.source}",
        f"direction: {direction}",
        f'thread_id: "{thread_id}"',
        f'from: "{email.from_addr}"',
        f"to: {to_yaml}",
        f"cc: {cc_yaml}",
        f'subject: "{email.subject}"',
        f"date: {email.date}",
        f"labels: {email.labels}",
        f"relevance: {result.relevance}",
        f"topic: {result.topic}",
        f"entities: {entities_yaml}",
        f'message_id: "{email.id}"',
        "---",
        "",
        "## Summary",
        result.summary,
        "",
    ]

    if result.action_items:
        lines.append("## Action Items")
        for item in result.action_items:
            lines.append(f"- {item}")
        lines.append("")

    lines.extend([
        "---",
        "",
        email.body,
    ])

    return "\n".join(lines)


def export_email(email: NormalizedEmail, result: ClassificationResult) -> Path:
    """Write enriched markdown file. Returns the file path."""
    yyyy_mm = _extract_yyyy_mm(email.date)
    out_dir = EXPORT_DIR / email.source / yyyy_mm
    out_dir.mkdir(parents=True, exist_ok=True)

    filename = sanitize_filename(email.id) + ".md"
    filepath = out_dir / filename

    content = build_markdown(email, result)
    filepath.write_text(content, encoding="utf-8")
    log.debug("Exported %s → %s", email.id, filepath)
    return filepath


def retain_in_hindsight(
    email: NormalizedEmail,
    result: ClassificationResult,
    hindsight_url: str,
) -> None:
    """Fire-and-forget Hindsight retain call. Swallows all errors."""
    try:
        content = (
            f"Email from {email.from_addr} re: {email.subject}\n"
            f"{result.summary}\n"
            f"Entities: {', '.join(result.entities)}"
        )
        if result.action_items:
            content += f"\nAction items: {', '.join(result.action_items)}"

        requests.post(
            f"{hindsight_url}/retain",
            json={
                "bank": "hermes",
                "content": content,
                "metadata": {
                    "source": "email-ingest",
                    "message_id": email.id,
                    "topic": result.topic,
                    "relevance": result.relevance,
                },
            },
            timeout=10,
        )
    except Exception as e:
        log.debug("Hindsight retain failed (non-blocking): %s", e)
