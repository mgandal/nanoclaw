"""Exchange adapter — fetches emails via Mac Mail AppleScript."""

import json
import logging
import math
import subprocess
import time
from pathlib import Path

from email_ingest.types import NormalizedEmail, BODY_MAX_CHARS

log = logging.getLogger("email-ingest.exchange")

EXCHANGE_SCRIPT = Path.home() / "claire-tools" / "exchange-mail.sh"
TARGET_MAILBOXES = ["Inbox", "Sent Items"]
INTERNAL_DOMAINS = {"upenn.edu", "chop.edu", "pennmedicine.upenn.edu"}
DEFAULT_BATCH_LIMIT = 100


def compute_since_days(epoch: int) -> int:
    """Convert epoch to days-ago for exchange-mail.sh --since flag."""
    days = math.ceil((time.time() - epoch) / 86400)
    return max(1, days)


def parse_search_output(raw: str) -> list[dict]:
    """Parse JSON array from exchange-mail.sh search output."""
    if not raw or not raw.strip():
        return []
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Failed to parse Exchange search output")
        return []


def parse_read_output(raw: str) -> dict:
    """Parse JSON object from exchange-mail.sh read output."""
    if not raw or not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Failed to parse Exchange read output")
        return {}


def _run_exchange(args: list[str], timeout: int = 30) -> str:
    """Run exchange-mail.sh with args. Returns stdout or empty string on failure."""
    if not EXCHANGE_SCRIPT.exists():
        log.error("exchange-mail.sh not found at %s", EXCHANGE_SCRIPT)
        return ""
    try:
        result = subprocess.run(
            ["bash", str(EXCHANGE_SCRIPT)] + args,
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            log.warning("exchange-mail.sh %s failed: %s", args[0], result.stderr[:200])
            return ""
        return result.stdout
    except subprocess.TimeoutExpired:
        log.warning("exchange-mail.sh %s timed out after %ds", args[0], timeout)
        return ""
    except Exception as e:
        log.warning("exchange-mail.sh %s error: %s", args[0], e)
        return ""


def _normalize_exchange_email(stub: dict, full: dict) -> NormalizedEmail:
    """Convert exchange-mail.sh read output to NormalizedEmail."""
    from_addr = full.get("fromName", "") + " <" + full.get("from", "") + ">"
    sender_domain = full.get("from", "").split("@")[-1] if "@" in full.get("from", "") else ""

    return NormalizedEmail(
        id=full.get("id", stub.get("id", "")),
        source="exchange",
        from_addr=from_addr,
        to=full.get("to", []),
        cc=full.get("cc", []),
        subject=full.get("subject", stub.get("subject", "(no subject)")),
        date=full.get("date", stub.get("date", "")),
        body=full.get("body", "")[:BODY_MAX_CHARS],
        labels=[stub.get("_mailbox", "Inbox")],
        metadata={
            "flagged": stub.get("flagged", False),
            "read": stub.get("read", True),
            "internal": sender_domain.lower() in INTERNAL_DOMAINS,
            "mailbox": stub.get("_mailbox", "Inbox"),
        },
    )


class ExchangeAdapter:
    """Fetches emails from Exchange via Mac Mail AppleScript."""

    def __init__(self, batch_limit: int = DEFAULT_BATCH_LIMIT):
        self.batch_limit = batch_limit

    def is_available(self) -> bool:
        """Check if exchange-mail.sh exists."""
        return EXCHANGE_SCRIPT.exists()

    def fetch_since(self, epoch: int, processed_ids: set[str]) -> list[NormalizedEmail]:
        """Fetch emails from Inbox + Sent Items since epoch."""
        if not self.is_available():
            log.warning("Exchange adapter not available (exchange-mail.sh missing)")
            return []

        since_days = compute_since_days(epoch)
        all_stubs = []

        for mailbox in TARGET_MAILBOXES:
            raw = _run_exchange([
                "search",
                "--since", str(since_days),
                "--limit", "500",
                "--mailbox", mailbox,
            ], timeout=60)
            stubs = parse_search_output(raw)
            for s in stubs:
                s["_mailbox"] = mailbox
            all_stubs.extend(stubs)
            log.info("Exchange search %s: %d messages", mailbox, len(stubs))

        # Filter already-processed and apply batch limit
        new_stubs = [s for s in all_stubs if s.get("id", "") not in processed_ids]
        new_stubs = new_stubs[:self.batch_limit]

        # Fetch full body for each
        emails = []
        for stub in new_stubs:
            raw = _run_exchange(["read", stub["id"]], timeout=90)
            full = parse_read_output(raw)
            if not full:
                log.warning("Failed to read Exchange message %s", stub.get("id"))
                continue
            emails.append(_normalize_exchange_email(stub, full))

        log.info("Fetched %d Exchange emails (batch limit: %d)", len(emails), self.batch_limit)
        return emails
