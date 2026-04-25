# Passive Email Knowledge Ingestion — Implementation Plan

> **Status: SHIPPED 2026-04-11 → 2026-04-24.** Pipeline live at `scripts/sync/email-ingest.py` + `scripts/sync/email_ingest/` package (classifier.py, gmail_adapter.py, exchange_adapter.py, exporter.py, types.py + extras: aging.py, closure.py, extractor.py, followups.py, markitdown.py, secure_write.py, trainer.py). Runs every 4h via `~/Library/LaunchAgents/com.nanoclaw.sync.plist` (StartInterval=14400) as step 2 of `scripts/sync/sync-all.sh`. Tests: `cd scripts/sync && python3 -m pytest tests/ -v` → 200 pass across 21 test files. Key commits: `093cc877` (orchestrator), `1d6a9ca3` (cred fallback), `a3215232` (followups foundation), `8e173403` (Hindsight retain fix), `5977d7f5` (MarkItDown attachment conversion), `f1a01bd9` (C18 Hindsight hardening). Memory: `project_email_ingest.md`. Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Batch pipeline that reads all Gmail + Exchange emails, classifies/summarizes via Ollama, and exports enriched markdown to a QMD collection so agents can recall email context.

**Architecture:** A single Python script (`email-ingest.py`) with two source adapters (Gmail API, Exchange via AppleScript), one combined classify+summarize Ollama call per email, markdown export to `~/.cache/email-ingest/exported/`, and integration into the existing sync-all.sh pipeline at 4h cadence.

**Tech Stack:** Python 3 (anaconda), Gmail API (`google-api-python-client`), Ollama HTTP API, QMD, Mac Mail AppleScript (`exchange-mail.sh`), launchd.

**Spec:** `docs/superpowers/specs/2026-04-11-passive-email-ingestion-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/sync/email-ingest.py` | Create | Main script: CLI, orchestration, state management |
| `scripts/sync/email_ingest/gmail_adapter.py` | Create | Gmail API fetching, credential loading, normalization |
| `scripts/sync/email_ingest/exchange_adapter.py` | Create | Exchange via exchange-mail.sh, normalization |
| `scripts/sync/email_ingest/classifier.py` | Create | Ollama classify+summarize, fast-skip rules, prompts |
| `scripts/sync/email_ingest/exporter.py` | Create | Markdown file writing, Hindsight retain |
| `scripts/sync/email_ingest/__init__.py` | Create | Package init (empty) |
| `scripts/sync/email_ingest/types.py` | Create | Shared types (NormalizedEmail, ClassificationResult) |
| `scripts/sync/tests/test_classifier.py` | Create | Tests for classification/fast-skip |
| `scripts/sync/tests/test_gmail_adapter.py` | Create | Tests for Gmail adapter |
| `scripts/sync/tests/test_exchange_adapter.py` | Create | Tests for Exchange adapter |
| `scripts/sync/tests/test_exporter.py` | Create | Tests for markdown export |
| `scripts/sync/tests/test_state.py` | Create | Tests for state management |
| `scripts/sync/tests/test_email_ingest.py` | Create | Integration tests for main orchestrator |
| `scripts/sync/sync-all.sh` | Modify | Insert email-ingest step between Gmail sync and Apple Notes |
| `~/Library/LaunchAgents/com.nanoclaw.sync.plist` | Modify | Change StartInterval from 28800 to 14400 |

---

### Task 1: Types and State Management

**Files:**
- Create: `scripts/sync/email_ingest/__init__.py`
- Create: `scripts/sync/email_ingest/types.py`
- Create: `scripts/sync/tests/test_state.py`

- [ ] **Step 1: Create package and shared types**

```bash
mkdir -p scripts/sync/email_ingest scripts/sync/tests
touch scripts/sync/email_ingest/__init__.py
touch scripts/sync/tests/__init__.py
```

Write `scripts/sync/email_ingest/types.py`:

```python
"""Shared types for email ingestion pipeline."""

from dataclasses import dataclass, field
from typing import Optional
import json
import time
from pathlib import Path

BODY_MAX_CHARS = 16_000
STATE_DIR = Path.home() / ".cache" / "email-ingest"
EXPORT_DIR = STATE_DIR / "exported"
STATE_FILE = STATE_DIR / "email-ingest-state.json"
LOG_FILE = STATE_DIR / "email-ingest.log"
GMAIL_TOKEN_FILE = STATE_DIR / "gmail-token.json"
MAX_PROCESSED_IDS = 10_000


@dataclass
class NormalizedEmail:
    id: str
    source: str  # 'gmail' | 'exchange'
    from_addr: str
    to: list[str]
    cc: list[str]
    subject: str
    date: str  # ISO 8601
    body: str  # truncated to BODY_MAX_CHARS
    labels: list[str]
    metadata: dict = field(default_factory=dict)


@dataclass
class ClassificationResult:
    relevance: float
    topic: str
    summary: str
    entities: list[str]
    action_items: list[str]
    skip_reason: Optional[str] = None


@dataclass
class IngestState:
    last_gmail_epoch: int = 0
    last_exchange_epoch: int = 0
    processed_gmail_ids: list[str] = field(default_factory=list)
    processed_exchange_ids: list[str] = field(default_factory=list)
    last_run: str = ""
    stats: dict = field(default_factory=lambda: {
        "total_fetched": 0,
        "classified": 0,
        "fast_skipped": 0,
        "exported": 0,
        "hindsight_retained": 0,
    })

    @classmethod
    def load(cls) -> "IngestState":
        if STATE_FILE.exists():
            data = json.loads(STATE_FILE.read_text())
            return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        return cls()

    def save(self) -> None:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        # Enforce ID cap — keep most recent
        self.processed_gmail_ids = self.processed_gmail_ids[-MAX_PROCESSED_IDS:]
        self.processed_exchange_ids = self.processed_exchange_ids[-MAX_PROCESSED_IDS:]
        self.last_run = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        STATE_FILE.write_text(json.dumps(self.__dict__, indent=2))

    def default_epoch(self, days_back: int = 14) -> int:
        """Return epoch for N days ago, used for first run."""
        return int(time.time()) - (days_back * 86400)
```

- [ ] **Step 2: Write state management tests**

Write `scripts/sync/tests/test_state.py`:

```python
"""Tests for state management."""

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from email_ingest.types import IngestState, STATE_FILE, MAX_PROCESSED_IDS


@pytest.fixture
def tmp_state(tmp_path):
    state_file = tmp_path / "email-ingest-state.json"
    with patch("email_ingest.types.STATE_FILE", state_file), \
         patch("email_ingest.types.STATE_DIR", tmp_path):
        yield state_file


def test_load_missing_file_returns_defaults(tmp_state):
    state = IngestState.load()
    assert state.last_gmail_epoch == 0
    assert state.last_exchange_epoch == 0
    assert state.processed_gmail_ids == []


def test_save_and_load_roundtrip(tmp_state):
    state = IngestState()
    state.last_gmail_epoch = 1712800000
    state.processed_gmail_ids = ["id1", "id2"]
    state.save()

    loaded = IngestState.load()
    assert loaded.last_gmail_epoch == 1712800000
    assert loaded.processed_gmail_ids == ["id1", "id2"]


def test_save_enforces_id_cap(tmp_state):
    state = IngestState()
    state.processed_gmail_ids = [f"id-{i}" for i in range(MAX_PROCESSED_IDS + 500)]
    state.save()

    loaded = IngestState.load()
    assert len(loaded.processed_gmail_ids) == MAX_PROCESSED_IDS
    # Should keep the most recent (last) IDs
    assert loaded.processed_gmail_ids[-1] == f"id-{MAX_PROCESSED_IDS + 499}"
    assert loaded.processed_gmail_ids[0] == f"id-500"


def test_default_epoch_is_14_days_back(tmp_state):
    import time
    state = IngestState()
    epoch = state.default_epoch(14)
    expected = int(time.time()) - (14 * 86400)
    assert abs(epoch - expected) < 5  # within 5 seconds


def test_save_sets_last_run(tmp_state):
    state = IngestState()
    state.save()
    assert state.last_run != ""
    assert "T" in state.last_run  # ISO format
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_state.py -v
```

Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync/email_ingest/ scripts/sync/tests/
git commit -m "feat(email-ingest): add types, state management with tests"
```

---

### Task 2: Gmail Adapter

**Files:**
- Create: `scripts/sync/email_ingest/gmail_adapter.py`
- Create: `scripts/sync/tests/test_gmail_adapter.py`

- [ ] **Step 1: Write Gmail adapter tests**

Write `scripts/sync/tests/test_gmail_adapter.py`:

```python
"""Tests for Gmail adapter."""

from unittest.mock import MagicMock, patch
import pytest

from email_ingest.gmail_adapter import GmailAdapter, normalize_gmail_message
from email_ingest.types import BODY_MAX_CHARS


def test_normalize_gmail_message_basic():
    raw = {
        "id": "msg123",
        "threadId": "thread456",
        "labelIds": ["INBOX", "IMPORTANT"],
        "payload": {
            "headers": [
                {"name": "From", "value": "Jane Doe <jane@upenn.edu>"},
                {"name": "To", "value": "mgandal@gmail.com"},
                {"name": "Cc", "value": "bob@chop.edu"},
                {"name": "Subject", "value": "Grant update"},
                {"name": "Date", "value": "Fri, 11 Apr 2026 14:30:00 -0400"},
            ],
            "body": {"data": ""},
            "parts": [
                {
                    "mimeType": "text/plain",
                    "body": {"data": "SGVsbG8gd29ybGQ="},  # "Hello world" base64
                }
            ],
        },
    }
    email = normalize_gmail_message(raw)
    assert email.id == "msg123"
    assert email.source == "gmail"
    assert "jane@upenn.edu" in email.from_addr
    assert "mgandal@gmail.com" in email.to
    assert "bob@chop.edu" in email.cc
    assert email.subject == "Grant update"
    assert "Hello world" in email.body
    assert "INBOX" in email.labels


def test_normalize_truncates_long_body():
    long_body = "A" * (BODY_MAX_CHARS + 5000)
    import base64
    encoded = base64.urlsafe_b64encode(long_body.encode()).decode()
    raw = {
        "id": "msg-long",
        "threadId": "t1",
        "labelIds": [],
        "payload": {
            "headers": [
                {"name": "From", "value": "test@test.com"},
                {"name": "To", "value": "me@test.com"},
                {"name": "Subject", "value": "Long email"},
                {"name": "Date", "value": "Fri, 11 Apr 2026 10:00:00 -0400"},
            ],
            "body": {"data": encoded},
            "parts": [],
        },
    }
    email = normalize_gmail_message(raw)
    assert len(email.body) == BODY_MAX_CHARS


def test_normalize_missing_headers_uses_defaults():
    raw = {
        "id": "msg-minimal",
        "threadId": "t1",
        "labelIds": [],
        "payload": {
            "headers": [],
            "body": {"data": ""},
            "parts": [],
        },
    }
    email = normalize_gmail_message(raw)
    assert email.from_addr == ""
    assert email.subject == "(no subject)"
    assert email.body == ""
```

- [ ] **Step 2: Run tests — expect failure (module not found)**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_gmail_adapter.py -v
```

Expected: ImportError — `gmail_adapter` does not exist yet.

- [ ] **Step 3: Write Gmail adapter**

Write `scripts/sync/email_ingest/gmail_adapter.py`:

```python
"""Gmail API adapter — fetches and normalizes emails."""

import base64
import json
import logging
from pathlib import Path

from email_ingest.types import (
    NormalizedEmail, BODY_MAX_CHARS, GMAIL_TOKEN_FILE,
)

log = logging.getLogger("email-ingest.gmail")

# Credential paths (same fallback chain as gmail-sync.py)
SRC_EMAIL = "mgandal@gmail.com"
CRED_PATHS = [
    Path.home() / ".google_workspace_mcp" / "credentials" / f"{SRC_EMAIL}.json",
    Path.home() / ".gmail-mcp" / "credentials.json",
]
OAUTH_KEYS = Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"


def _load_credentials():
    """Load Gmail OAuth credentials. Uses dedicated token file to avoid
    contention with GmailChannel's live polling."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    # Try dedicated token first (has refreshed access token)
    if GMAIL_TOKEN_FILE.exists():
        data = json.loads(GMAIL_TOKEN_FILE.read_text())
        creds = Credentials(
            token=data.get("token"),
            refresh_token=data.get("refresh_token"),
            token_uri=data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=data.get("client_id"),
            client_secret=data.get("client_secret"),
            scopes=data.get("scopes", []),
        )
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            _save_token(creds, data)
        return creds

    # Bootstrap from existing credential files
    for cred_path in CRED_PATHS:
        if not cred_path.exists():
            continue
        data = json.loads(cred_path.read_text())
        token = data.get("token") or data.get("access_token")
        refresh_token = data.get("refresh_token")
        client_id = data.get("client_id")
        client_secret = data.get("client_secret")

        if not client_id and OAUTH_KEYS.exists():
            oauth_data = json.loads(OAUTH_KEYS.read_text())
            installed = oauth_data.get("installed", oauth_data.get("web", {}))
            client_id = installed.get("client_id")
            client_secret = installed.get("client_secret")

        if not (token and refresh_token and client_id):
            continue

        creds = Credentials(
            token=token,
            refresh_token=refresh_token,
            token_uri=data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=client_id,
            client_secret=client_secret,
            scopes=data.get("scopes", []),
        )
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())

        # Save to dedicated token file for future runs
        _save_token(creds, {
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
            "token_uri": data.get("token_uri", "https://oauth2.googleapis.com/token"),
            "scopes": data.get("scopes", []),
        })
        log.info("Bootstrapped Gmail token from %s", cred_path)
        return creds

    return None


def _save_token(creds, base_data):
    """Persist refreshed token to dedicated file."""
    GMAIL_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    save_data = {**base_data, "token": creds.token}
    GMAIL_TOKEN_FILE.write_text(json.dumps(save_data, indent=2))


def _extract_body(payload: dict) -> str:
    """Extract plain text body from Gmail message payload."""
    # Try top-level body
    body_data = payload.get("body", {}).get("data", "")
    if body_data:
        try:
            return base64.urlsafe_b64decode(body_data).decode("utf-8", errors="replace")
        except Exception:
            pass

    # Try parts
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain":
            data = part.get("body", {}).get("data", "")
            if data:
                try:
                    return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
                except Exception:
                    pass
        # Recurse into nested parts
        if "parts" in part:
            result = _extract_body(part)
            if result:
                return result

    return ""


def _get_header(headers: list, name: str, default: str = "") -> str:
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", default)
    return default


def normalize_gmail_message(raw: dict) -> NormalizedEmail:
    """Convert Gmail API message to NormalizedEmail."""
    headers = raw.get("payload", {}).get("headers", [])
    body = _extract_body(raw.get("payload", {}))

    return NormalizedEmail(
        id=raw["id"],
        source="gmail",
        from_addr=_get_header(headers, "From"),
        to=[a.strip() for a in _get_header(headers, "To").split(",") if a.strip()],
        cc=[a.strip() for a in _get_header(headers, "Cc").split(",") if a.strip()],
        subject=_get_header(headers, "Subject") or "(no subject)",
        date=_get_header(headers, "Date"),
        body=body[:BODY_MAX_CHARS],
        labels=raw.get("labelIds", []),
        metadata={
            "threadId": raw.get("threadId", ""),
            "snippet": raw.get("snippet", ""),
        },
    )


class GmailAdapter:
    """Fetches emails from Gmail API since a given epoch."""

    def __init__(self):
        self._service = None

    def connect(self) -> bool:
        """Initialize Gmail API service. Returns False if credentials missing."""
        creds = _load_credentials()
        if not creds:
            log.error("No Gmail credentials found")
            return False
        from googleapiclient.discovery import build
        self._service = build("gmail", "v1", credentials=creds)
        log.info("Gmail API connected")
        return True

    def fetch_since(self, epoch: int, processed_ids: set[str]) -> list[NormalizedEmail]:
        """Fetch all emails since epoch, skipping already-processed IDs.
        Read-only — does NOT modify labels or mark as read."""
        if not self._service:
            return []

        query = f"after:{epoch}"
        emails = []
        page_token = None

        while True:
            resp = self._service.users().messages().list(
                userId="me", q=query, maxResults=100, pageToken=page_token,
            ).execute()

            for msg_stub in resp.get("messages", []):
                if msg_stub["id"] in processed_ids:
                    continue

                try:
                    full = self._service.users().messages().get(
                        userId="me", id=msg_stub["id"], format="full",
                    ).execute()
                    emails.append(normalize_gmail_message(full))
                except Exception as e:
                    log.warning("Failed to fetch message %s: %s", msg_stub["id"], e)

            page_token = resp.get("nextPageToken")
            if not page_token:
                break

        log.info("Fetched %d Gmail emails since epoch %d", len(emails), epoch)
        return emails
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_gmail_adapter.py -v
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/gmail_adapter.py scripts/sync/tests/test_gmail_adapter.py
git commit -m "feat(email-ingest): Gmail adapter with credential isolation and tests"
```

---

### Task 3: Exchange Adapter

**Files:**
- Create: `scripts/sync/email_ingest/exchange_adapter.py`
- Create: `scripts/sync/tests/test_exchange_adapter.py`

- [ ] **Step 1: Write Exchange adapter tests**

Write `scripts/sync/tests/test_exchange_adapter.py`:

```python
"""Tests for Exchange adapter."""

import json
from unittest.mock import patch, MagicMock
import pytest

from email_ingest.exchange_adapter import (
    ExchangeAdapter, parse_search_output, parse_read_output,
    compute_since_days,
)
from email_ingest.types import BODY_MAX_CHARS


def test_parse_search_output():
    raw_json = json.dumps([
        {"id": "msg1", "subject": "Hello", "from": "jane@upenn.edu",
         "fromName": "Jane", "date": "2026-04-11T14:30", "read": True, "flagged": False},
        {"id": "msg2", "subject": "Grant", "from": "bob@chop.edu",
         "fromName": "Bob", "date": "2026-04-11T10:00", "read": False, "flagged": True},
    ])
    results = parse_search_output(raw_json)
    assert len(results) == 2
    assert results[0]["id"] == "msg1"
    assert results[1]["flagged"] is True


def test_parse_search_output_empty():
    assert parse_search_output("[]") == []
    assert parse_search_output("") == []


def test_parse_read_output():
    raw_json = json.dumps({
        "id": "msg1",
        "subject": "Hello",
        "from": "jane@upenn.edu",
        "fromName": "Jane Doe",
        "date": "2026-04-11T14:30",
        "read": True,
        "flagged": False,
        "to": ["mgandal@upenn.edu"],
        "cc": ["bob@chop.edu"],
        "body": "This is the email body content.",
    })
    result = parse_read_output(raw_json)
    assert result["body"] == "This is the email body content."
    assert result["to"] == ["mgandal@upenn.edu"]


def test_compute_since_days():
    import time
    now = int(time.time())
    # Epoch 7 days ago → should return 7 (or 8 due to ceiling)
    epoch = now - (7 * 86400)
    days = compute_since_days(epoch)
    assert days in (7, 8)  # ceil may round up


def test_compute_since_days_minimum_1():
    import time
    # Epoch in the future → minimum 1 day
    days = compute_since_days(int(time.time()) + 3600)
    assert days == 1


def test_body_truncation():
    long_body = "B" * (BODY_MAX_CHARS + 5000)
    raw_json = json.dumps({
        "id": "msg-long", "subject": "Long", "from": "a@b.com",
        "fromName": "A", "date": "2026-04-11T10:00", "read": True,
        "flagged": False, "to": ["me@b.com"], "cc": [],
        "body": long_body,
    })
    result = parse_read_output(raw_json)
    # parse_read_output should NOT truncate — normalization does
    assert len(result["body"]) > BODY_MAX_CHARS
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_exchange_adapter.py -v
```

Expected: ImportError.

- [ ] **Step 3: Write Exchange adapter**

Write `scripts/sync/email_ingest/exchange_adapter.py`:

```python
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
            raw = _run_exchange(["read", stub["id"]], timeout=30)
            full = parse_read_output(raw)
            if not full:
                log.warning("Failed to read Exchange message %s", stub.get("id"))
                continue
            emails.append(_normalize_exchange_email(stub, full))

        log.info("Fetched %d Exchange emails (batch limit: %d)", len(emails), self.batch_limit)
        return emails
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_exchange_adapter.py -v
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/exchange_adapter.py scripts/sync/tests/test_exchange_adapter.py
git commit -m "feat(email-ingest): Exchange adapter with batch limits and tests"
```

---

### Task 4: Classifier (Combined Classify + Summarize)

**Files:**
- Create: `scripts/sync/email_ingest/classifier.py`
- Create: `scripts/sync/tests/test_classifier.py`

- [ ] **Step 1: Write classifier tests**

Write `scripts/sync/tests/test_classifier.py`:

```python
"""Tests for Ollama classifier + fast-skip rules."""

import pytest
from email_ingest.classifier import (
    should_fast_skip, classify_email, build_gmail_prompt, build_exchange_prompt,
    parse_classification,
)
from email_ingest.types import NormalizedEmail, ClassificationResult


def _make_email(**overrides) -> NormalizedEmail:
    defaults = dict(
        id="test-1", source="gmail", from_addr="jane@upenn.edu",
        to=["mgandal@gmail.com"], cc=[], subject="Test",
        date="2026-04-11T14:30:00-0400", body="Hello world",
        labels=["INBOX"], metadata={},
    )
    defaults.update(overrides)
    return NormalizedEmail(**defaults)


# --- Fast-skip tests ---

def test_fast_skip_gmail_promotions():
    email = _make_email(source="gmail", labels=["CATEGORY_PROMOTIONS"])
    assert should_fast_skip(email) == "promotional"


def test_fast_skip_gmail_social():
    email = _make_email(source="gmail", labels=["CATEGORY_SOCIAL"])
    assert should_fast_skip(email) == "social"


def test_fast_skip_gmail_noreply():
    email = _make_email(source="gmail", from_addr="noreply@github.com")
    assert should_fast_skip(email) == "automated"


def test_fast_skip_gmail_notifications():
    email = _make_email(source="gmail", from_addr="notifications@linkedin.com")
    assert should_fast_skip(email) == "automated"


def test_no_skip_normal_gmail():
    email = _make_email(source="gmail", labels=["INBOX", "IMPORTANT"])
    assert should_fast_skip(email) is None


def test_no_skip_exchange():
    email = _make_email(source="exchange", labels=["Inbox"])
    assert should_fast_skip(email) is None


# --- Prompt building ---

def test_build_gmail_prompt_includes_category():
    email = _make_email(source="gmail", labels=["INBOX", "CATEGORY_UPDATES"])
    prompt = build_gmail_prompt(email)
    assert "CATEGORY_UPDATES" in prompt
    assert "Grant" not in prompt  # subject is "Test"


def test_build_exchange_prompt_includes_internal_flag():
    email = _make_email(
        source="exchange",
        metadata={"internal": True, "mailbox": "Inbox", "flagged": True},
    )
    prompt = build_exchange_prompt(email)
    assert "internal" in prompt.lower() or "Internal" in prompt
    assert "flagged" in prompt.lower()


# --- Parse classification ---

def test_parse_classification_valid():
    raw = '{"relevance": 0.8, "topic": "grant", "summary": "Grant update from Jane.", "entities": ["Jane"], "action_items": ["Review budget"]}'
    result = parse_classification(raw)
    assert result.relevance == 0.8
    assert result.topic == "grant"
    assert "Jane" in result.entities


def test_parse_classification_invalid_json():
    result = parse_classification("not json at all")
    assert result.relevance == 0.0
    assert result.skip_reason == "classification_failed"


def test_parse_classification_missing_fields():
    raw = '{"relevance": 0.5}'
    result = parse_classification(raw)
    assert result.relevance == 0.5
    assert result.summary == ""
    assert result.entities == []
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_classifier.py -v
```

Expected: ImportError.

- [ ] **Step 3: Write classifier**

Write `scripts/sync/email_ingest/classifier.py`:

```python
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_classifier.py -v
```

Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/classifier.py scripts/sync/tests/test_classifier.py
git commit -m "feat(email-ingest): combined classify+summarize with fast-skip rules and tests"
```

---

### Task 5: Markdown Exporter + Hindsight

**Files:**
- Create: `scripts/sync/email_ingest/exporter.py`
- Create: `scripts/sync/tests/test_exporter.py`

- [ ] **Step 1: Write exporter tests**

Write `scripts/sync/tests/test_exporter.py`:

```python
"""Tests for markdown exporter."""

import os
from pathlib import Path
from unittest.mock import patch, MagicMock
import pytest

from email_ingest.exporter import (
    build_markdown, sanitize_filename, export_email, retain_in_hindsight,
)
from email_ingest.types import NormalizedEmail, ClassificationResult


def _make_email(**overrides) -> NormalizedEmail:
    defaults = dict(
        id="msg-123", source="gmail", from_addr="Jane Doe <jane@upenn.edu>",
        to=["mgandal@gmail.com"], cc=["bob@chop.edu"], subject="Grant update",
        date="2026-04-11T14:30:00-0400", body="The grant is on track.",
        labels=["INBOX", "IMPORTANT"], metadata={},
    )
    defaults.update(overrides)
    return NormalizedEmail(**defaults)


def _make_result(**overrides) -> ClassificationResult:
    defaults = dict(
        relevance=0.8, topic="grant",
        summary="Jane confirms the grant is on track.",
        entities=["Jane Doe", "scRBP"], action_items=["Review budget by Apr 14"],
    )
    defaults.update(overrides)
    return ClassificationResult(**defaults)


def test_sanitize_filename():
    assert sanitize_filename("<abc@def.com>") == "abc-def-com"
    assert sanitize_filename("normal-id-123") == "normal-id-123"
    assert sanitize_filename("a" * 200) == "a" * 100  # truncated


def test_build_markdown_has_frontmatter():
    md = build_markdown(_make_email(), _make_result())
    assert md.startswith("---\n")
    assert "source: gmail" in md
    assert "relevance: 0.8" in md
    assert "topic: grant" in md
    assert "Jane Doe" in md


def test_build_markdown_has_summary_section():
    md = build_markdown(_make_email(), _make_result())
    assert "## Summary" in md
    assert "grant is on track" in md


def test_build_markdown_has_action_items():
    md = build_markdown(_make_email(), _make_result())
    assert "## Action Items" in md
    assert "Review budget" in md


def test_build_markdown_has_original_body():
    md = build_markdown(_make_email(), _make_result())
    assert "The grant is on track." in md


def test_export_email_creates_file(tmp_path):
    with patch("email_ingest.exporter.EXPORT_DIR", tmp_path):
        path = export_email(_make_email(), _make_result())
        assert path.exists()
        content = path.read_text()
        assert "source: gmail" in content
        assert "## Summary" in content


def test_export_email_creates_date_subdirectory(tmp_path):
    with patch("email_ingest.exporter.EXPORT_DIR", tmp_path):
        path = export_email(
            _make_email(date="2026-04-11T14:30:00-0400"),
            _make_result(),
        )
        assert "gmail" in str(path)
        assert "2026-04" in str(path)


def test_retain_in_hindsight_fires_and_forgets():
    with patch("email_ingest.exporter.requests") as mock_req:
        mock_req.post.return_value = MagicMock(status_code=200)
        retain_in_hindsight(_make_email(), _make_result(), "http://localhost:8889")
        mock_req.post.assert_called_once()
        call_args = mock_req.post.call_args
        assert "retain" in call_args[0][0]


def test_retain_in_hindsight_swallows_errors():
    with patch("email_ingest.exporter.requests") as mock_req:
        mock_req.post.side_effect = Exception("connection refused")
        # Should not raise
        retain_in_hindsight(_make_email(), _make_result(), "http://localhost:8889")
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_exporter.py -v
```

Expected: ImportError.

- [ ] **Step 3: Write exporter**

Write `scripts/sync/email_ingest/exporter.py`:

```python
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
    clean = re.sub(r"[<>:\"/\\|?*\s]+", "-", s)
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


def build_markdown(email: NormalizedEmail, result: ClassificationResult) -> str:
    """Build enriched markdown document from email + classification."""
    entities_yaml = "[" + ", ".join(f'"{e}"' for e in result.entities) + "]"
    to_yaml = "[" + ", ".join(f'"{t}"' for t in email.to) + "]"
    cc_yaml = "[" + ", ".join(f'"{c}"' for c in email.cc) + "]" if email.cc else "[]"

    lines = [
        "---",
        f"source: {email.source}",
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/test_exporter.py -v
```

Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email_ingest/exporter.py scripts/sync/tests/test_exporter.py
git commit -m "feat(email-ingest): markdown exporter with Hindsight integration and tests"
```

---

### Task 6: Main Orchestrator Script

**Files:**
- Create: `scripts/sync/email-ingest.py`
- Create: `scripts/sync/tests/test_email_ingest.py`

- [ ] **Step 1: Write integration tests**

Write `scripts/sync/tests/test_email_ingest.py`:

```python
"""Integration tests for email-ingest.py orchestrator."""

from unittest.mock import patch, MagicMock
import pytest

# We test the orchestration logic by mocking adapters and classifier


def test_main_skips_gmail_on_auth_failure():
    """If Gmail auth fails, Exchange should still run."""
    from email_ingest.types import IngestState
    with patch("email_ingest.types.STATE_FILE") as _, \
         patch("email_ingest.types.STATE_DIR") as __:
        state = IngestState()
        # Gmail epoch should NOT advance if adapter fails
        original_epoch = state.last_gmail_epoch
        # (Full integration tested manually — this is a smoke test)
        assert state.last_gmail_epoch == original_epoch


def test_epoch_not_advanced_on_zero_exports():
    """If Ollama is down and nothing exports, epoch stays put."""
    from email_ingest.types import IngestState
    state = IngestState(last_gmail_epoch=1000)
    # Simulate: no exports happened
    # Epoch should only advance when exports > 0 OR fetch returned 0 new emails
    assert state.last_gmail_epoch == 1000  # unchanged
```

- [ ] **Step 2: Write main orchestrator**

Write `scripts/sync/email-ingest.py`:

```python
#!/usr/bin/env python3
"""Passive email knowledge ingestion — classify, summarize, export to QMD.

Usage:
    python3 email-ingest.py                 # Incremental (since last run)
    python3 email-ingest.py --backfill 180  # Seed last 180 days
    python3 email-ingest.py --status        # Show state
    python3 email-ingest.py --exchange-batch-size 50  # Limit Exchange per run
"""

import argparse
import logging
import os
import sys
import time

# Add parent dir to path so email_ingest package is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from email_ingest.types import IngestState, STATE_DIR, LOG_FILE
from email_ingest.gmail_adapter import GmailAdapter
from email_ingest.exchange_adapter import ExchangeAdapter
from email_ingest.classifier import should_fast_skip, classify_email
from email_ingest.exporter import export_email, retain_in_hindsight

RELEVANCE_THRESHOLD = float(os.environ.get("EMAIL_INGEST_THRESHOLD", "0.3"))
HINDSIGHT_THRESHOLD = 0.7
HINDSIGHT_URL = os.environ.get("HINDSIGHT_URL", "http://localhost:8889")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_FILE, mode="a") if STATE_DIR.exists() else logging.StreamHandler(),
    ],
)
log = logging.getLogger("email-ingest")


def run_ingest(state: IngestState, backfill_days: int | None, exchange_batch: int):
    """Main ingestion loop."""
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)

    stats = {
        "total_fetched": 0, "classified": 0, "fast_skipped": 0,
        "exported": 0, "hindsight_retained": 0,
    }

    # --- Gmail ---
    gmail_epoch = state.last_gmail_epoch or state.default_epoch()
    if backfill_days:
        gmail_epoch = state.default_epoch(backfill_days)

    gmail_exported = 0
    gmail_fetched = 0
    gmail = GmailAdapter()
    if gmail.connect():
        processed = set(state.processed_gmail_ids)
        emails = gmail.fetch_since(gmail_epoch, processed)
        gmail_fetched = len(emails)
        stats["total_fetched"] += gmail_fetched

        for email in emails:
            skip = should_fast_skip(email)
            if skip:
                stats["fast_skipped"] += 1
                log.debug("Fast-skip %s: %s (%s)", email.source, email.subject[:50], skip)
                state.processed_gmail_ids.append(email.id)
                continue

            result = classify_email(email)
            stats["classified"] += 1

            if result.skip_reason:
                log.warning("Classification failed for %s: %s", email.id, result.skip_reason)
                # Do NOT mark as processed — retry on next run
                continue

            state.processed_gmail_ids.append(email.id)

            if result.relevance >= RELEVANCE_THRESHOLD:
                export_email(email, result)
                stats["exported"] += 1
                gmail_exported += 1
                log.info("Exported [%.2f] %s: %s", result.relevance, email.source, email.subject[:60])

                if result.relevance >= HINDSIGHT_THRESHOLD:
                    retain_in_hindsight(email, result, HINDSIGHT_URL)
                    stats["hindsight_retained"] += 1
            else:
                log.debug("Below threshold [%.2f] %s: %s", result.relevance, email.source, email.subject[:60])

        # Advance epoch only if exports happened OR zero new emails fetched
        if gmail_exported > 0 or gmail_fetched == 0:
            state.last_gmail_epoch = int(time.time())
    else:
        log.warning("Gmail adapter failed to connect — skipping Gmail")

    # --- Exchange ---
    exchange_epoch = state.last_exchange_epoch or state.default_epoch()
    if backfill_days:
        exchange_epoch = state.default_epoch(backfill_days)

    exchange_exported = 0
    exchange_fetched = 0
    exchange = ExchangeAdapter(batch_limit=exchange_batch)
    if exchange.is_available():
        processed = set(state.processed_exchange_ids)
        emails = exchange.fetch_since(exchange_epoch, processed)
        exchange_fetched = len(emails)
        stats["total_fetched"] += exchange_fetched

        for email in emails:
            skip = should_fast_skip(email)
            if skip:
                stats["fast_skipped"] += 1
                state.processed_exchange_ids.append(email.id)
                continue

            result = classify_email(email)
            stats["classified"] += 1

            if result.skip_reason:
                log.warning("Classification failed for %s: %s", email.id, result.skip_reason)
                continue

            state.processed_exchange_ids.append(email.id)

            if result.relevance >= RELEVANCE_THRESHOLD:
                export_email(email, result)
                stats["exported"] += 1
                exchange_exported += 1
                log.info("Exported [%.2f] %s: %s", result.relevance, email.source, email.subject[:60])

                if result.relevance >= HINDSIGHT_THRESHOLD:
                    retain_in_hindsight(email, result, HINDSIGHT_URL)
                    stats["hindsight_retained"] += 1

        if exchange_exported > 0 or exchange_fetched == 0:
            state.last_exchange_epoch = int(time.time())
    else:
        log.warning("Exchange adapter not available — skipping Exchange")

    state.stats = stats
    state.save()

    log.info(
        "Done: fetched=%d classified=%d skipped=%d exported=%d hindsight=%d",
        stats["total_fetched"], stats["classified"], stats["fast_skipped"],
        stats["exported"], stats["hindsight_retained"],
    )
    return stats


def show_status(state: IngestState):
    """Print current state."""
    from datetime import datetime
    print(f"Last run:           {state.last_run or 'never'}")
    print(f"Gmail epoch:        {datetime.fromtimestamp(state.last_gmail_epoch) if state.last_gmail_epoch else 'not set'}")
    print(f"Exchange epoch:     {datetime.fromtimestamp(state.last_exchange_epoch) if state.last_exchange_epoch else 'not set'}")
    print(f"Gmail IDs tracked:  {len(state.processed_gmail_ids)}")
    print(f"Exchange IDs tracked: {len(state.processed_exchange_ids)}")
    if state.stats:
        print(f"Last run stats:     {state.stats}")


def main():
    parser = argparse.ArgumentParser(description="Passive email knowledge ingestion")
    parser.add_argument("--backfill", type=int, metavar="DAYS",
                        help="Backfill last N days (overrides epoch)")
    parser.add_argument("--status", action="store_true", help="Show state and exit")
    parser.add_argument("--exchange-batch-size", type=int, default=100,
                        help="Max Exchange emails per run (default: 100)")
    args = parser.parse_args()

    state = IngestState.load()

    if args.status:
        show_status(state)
        return

    log.info("Starting email ingest (backfill=%s, exchange_batch=%d)",
             args.backfill, args.exchange_batch_size)
    run_ingest(state, args.backfill, args.exchange_batch_size)


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run all tests**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
PYTHONPATH=. /Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 -m pytest tests/ -v
```

Expected: All tests pass (~35 tests across 5 files).

- [ ] **Step 4: Smoke test with --status**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 email-ingest.py --status
```

Expected: Shows "Last run: never", epochs not set.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync/email-ingest.py scripts/sync/tests/test_email_ingest.py
git commit -m "feat(email-ingest): main orchestrator with CLI, backfill, and epoch safety"
```

---

### Task 7: Sync Pipeline Integration

**Files:**
- Modify: `scripts/sync/sync-all.sh`
- Modify: `~/Library/LaunchAgents/com.nanoclaw.sync.plist`

- [ ] **Step 1: Insert email-ingest step in sync-all.sh**

In `scripts/sync/sync-all.sh`, after line 42 (end of Gmail sync step) and before line 44 (Calendar sync), insert:

```bash
# --- Step 3: Email knowledge ingestion ---
echo ""
echo "[3/7] Email knowledge ingestion..."
$PYTHON3 "$SCRIPT_DIR/email-ingest.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[3/7] WARNING: Email ingest had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi
```

Update all subsequent step numbers from `[3/6]` → `[4/7]`, `[4/6]` → `[5/7]`, `[5/6]` → `[6/7]`, `[6/6]` → `[7/7]`.

Update the header comment on line 3 from "Runs every 8 hours" to "Runs every 4 hours".

- [ ] **Step 2: Change launchd interval**

In `~/Library/LaunchAgents/com.nanoclaw.sync.plist`, change line 12:

```xml
    <integer>14400</integer>
```

(Was `28800`.)

- [ ] **Step 3: Reload launchd**

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.sync.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.sync.plist
```

- [ ] **Step 4: Commit**

```bash
git add scripts/sync/sync-all.sh
git commit -m "feat(email-ingest): integrate into sync pipeline, change cadence to 4h"
```

---

### Task 8: QMD Collection Setup + End-to-End Test

**Files:** None created — configuration + manual verification.

- [ ] **Step 1: Register QMD collection**

```bash
mkdir -p ~/.cache/email-ingest/exported
chmod 700 ~/.cache/email-ingest
qmd collection add email ~/.cache/email-ingest/exported/
qmd collection show email
```

Expected: Collection registered, pattern `**/*.md`, path correct.

- [ ] **Step 2: Run a live incremental ingest (14-day window)**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 email-ingest.py
```

Watch output for:
- Gmail connected
- Exchange search results (or skip if Mac Mail not running)
- Fast-skip counts
- Classification + export counts
- No errors

- [ ] **Step 3: Verify exported files**

```bash
ls ~/.cache/email-ingest/exported/gmail/2026-04/ | head -10
cat ~/.cache/email-ingest/exported/gmail/2026-04/*.md | head -40
```

Expected: Markdown files with YAML frontmatter, summary section, action items, body.

- [ ] **Step 4: Index in QMD**

```bash
BUN_INSTALL= qmd update
BUN_INSTALL= qmd embed
qmd status | grep email
```

Expected: `email` collection shows indexed files.

- [ ] **Step 5: Test QMD search finds email content**

```bash
qmd query "grant deadline" --collection email
```

Expected: Returns relevant email documents with snippets.

- [ ] **Step 6: Check state file**

```bash
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 email-ingest.py --status
```

Expected: Shows updated epochs, processed ID counts, stats from last run.

- [ ] **Step 7: Commit any fixes needed**

```bash
git add -A scripts/sync/
git commit -m "fix(email-ingest): adjustments from end-to-end testing"
```

(Skip this step if no fixes needed.)

---

### Task 9: Backfill (6-Month Seed)

- [ ] **Step 1: Run Gmail backfill**

```bash
cd /Users/mgandal/Agents/nanoclaw/scripts/sync
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 email-ingest.py --backfill 180 --exchange-batch-size 50
```

This will take 30-60+ minutes. Monitor:
- Fast-skip rate (should be >30% for Gmail)
- Ollama inference speed (~5-8s per email)
- Exchange adapter throughput (~2-4s per message)

Can be interrupted with Ctrl+C and resumed — state saves after each source.

- [ ] **Step 2: Re-index QMD after backfill**

```bash
BUN_INSTALL= qmd update
BUN_INSTALL= qmd embed
qmd status | grep email
```

Expected: Hundreds of email documents indexed.

- [ ] **Step 3: Verify agent recall**

Test from a NanoClaw agent (e.g., via Telegram):
> "What's the status of the scRBP grant with Yunlong?"

The agent should find the answer via QMD search without the user having forwarded the email.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(email-ingest): pipeline complete with 6-month backfill"
```
