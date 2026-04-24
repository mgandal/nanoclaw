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

# C17: hard cap on bytes read from exchange-mail.sh stdout. A misbehaving
# Mail bridge or corrupted mailbox could produce an arbitrarily large JSON
# response; subprocess.run(capture_output=True) would buffer all of it in
# memory before json.loads allocated its own copy on top. 16 MB is more
# than the largest realistic search result (500 message stubs × a few KB
# each) and well under the memory budget.
EXCHANGE_STDOUT_MAX_BYTES = 16 * 1024 * 1024


def compute_since_days(epoch: int) -> int:
    """Convert epoch to days-ago for exchange-mail.sh --since flag."""
    days = math.ceil((time.time() - epoch) / 86400)
    return max(1, days)


def parse_search_output(raw: str) -> list[dict]:
    """Parse JSON array from exchange-mail.sh search output.

    C17: schema-validate. Top-level must be a list; non-dict items are
    dropped. A bridge returning an object or scalar (e.g. an error
    envelope) is not silently treated as a message list.
    """
    if not raw or not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Failed to parse Exchange search output")
        return []
    if not isinstance(parsed, list):
        log.warning(
            "Exchange search output is not a list (got %s); dropping",
            type(parsed).__name__,
        )
        return []
    return [item for item in parsed if isinstance(item, dict)]


def parse_read_output(raw: str) -> dict:
    """Parse JSON object from exchange-mail.sh read output.

    C17: schema-validate. Top-level must be a dict.
    """
    if not raw or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Failed to parse Exchange read output")
        return {}
    if not isinstance(parsed, dict):
        log.warning(
            "Exchange read output is not a dict (got %s); dropping",
            type(parsed).__name__,
        )
        return {}
    return parsed


def _run_exchange(args: list[str], timeout: int = 30) -> str:
    """Run exchange-mail.sh with args. Returns stdout or empty string on failure.

    C17: stdout is read in bounded chunks via Popen, not buffered
    wholesale by subprocess.run(capture_output=True). If the output
    exceeds EXCHANGE_STDOUT_MAX_BYTES the subprocess is killed and an
    empty string is returned — no partial JSON reaches the parser.
    """
    if not EXCHANGE_SCRIPT.exists():
        log.error("exchange-mail.sh not found at %s", EXCHANGE_SCRIPT)
        return ""

    proc = None
    try:
        proc = subprocess.Popen(
            ["bash", str(EXCHANGE_SCRIPT)] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except Exception as e:
        log.warning("exchange-mail.sh %s spawn error: %s", args[0], e)
        return ""

    deadline = time.time() + timeout
    buf = bytearray()
    truncated = False
    read_size = 64 * 1024  # 64 KB chunks
    try:
        while True:
            if time.time() > deadline:
                log.warning(
                    "exchange-mail.sh %s timed out after %ds", args[0], timeout
                )
                proc.kill()
                return ""
            chunk = proc.stdout.read(read_size) if proc.stdout else b""
            if not chunk:
                break
            if len(buf) + len(chunk) > EXCHANGE_STDOUT_MAX_BYTES:
                # Hard cap hit — treat as malformed bridge output.
                truncated = True
                log.warning(
                    "exchange-mail.sh %s stdout exceeded %d bytes; killing",
                    args[0],
                    EXCHANGE_STDOUT_MAX_BYTES,
                )
                proc.kill()
                break
            buf.extend(chunk)

        if truncated:
            return ""

        # Drain any remaining stderr for the warning log.
        try:
            rc = proc.wait(timeout=max(1.0, deadline - time.time()))
        except subprocess.TimeoutExpired:
            proc.kill()
            log.warning(
                "exchange-mail.sh %s wait timeout after stdout drain", args[0]
            )
            return ""

        if rc != 0:
            err = b""
            try:
                err = proc.stderr.read() if proc.stderr else b""
            except Exception:
                pass
            log.warning(
                "exchange-mail.sh %s failed: %s",
                args[0],
                err[:200].decode("utf-8", errors="replace"),
            )
            return ""

        return buf.decode("utf-8", errors="replace")
    except Exception as e:
        log.warning("exchange-mail.sh %s error: %s", args[0], e)
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
        return ""
    finally:
        # Best-effort close of std streams; Popen does not close them on GC
        # until the process is reaped.
        for stream in (
            getattr(proc, "stdout", None),
            getattr(proc, "stderr", None),
        ):
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass


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
            ], timeout=600)
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
            raw = _run_exchange(["read", stub["id"]], timeout=180)
            full = parse_read_output(raw)
            if not full:
                log.warning("Failed to read Exchange message %s", stub.get("id"))
                continue
            emails.append(_normalize_exchange_email(stub, full))

        log.info("Fetched %d Exchange emails (batch limit: %d)", len(emails), self.batch_limit)
        return emails

    def fetch_thread_messages(
        self, conversation_id: str, since_epoch: int
    ) -> list[NormalizedEmail]:
        """Fetch Exchange messages in a conversation after since_epoch.
        v1: exchange-mail.sh does not expose a conversation endpoint, so this
        always returns []. Closure is Gmail-only until the bridge adds it.
        Returns [] if the adapter is not available."""
        if not self.is_available():
            return []
        log.debug(
            "Exchange conversation fetch not yet implemented in bridge; returning []"
        )
        return []
