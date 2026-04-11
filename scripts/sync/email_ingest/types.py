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
