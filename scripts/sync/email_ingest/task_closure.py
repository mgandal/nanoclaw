"""Email-driven auto-closure of tasks in store/messages.db.

Runs at the end of each email-ingest cycle. Reads open tasks via direct
SQLite, scores each against candidate Gmail/Exchange threads, and closes
high-confidence matches. Mirrors email_ingest.closure (followups.md) but
writes to the SQL tasks table.

See docs/superpowers/specs/2026-05-06-email-task-closure-design.md.
"""
from __future__ import annotations

import enum
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

log = logging.getLogger("email-ingest.task-closure")


class Tier(enum.Enum):
    AUTO_CLOSE = "auto_close"
    SUGGEST = "suggest"
    DROP = "drop"


@dataclass(frozen=True)
class OpenTask:
    id: int
    title: str
    context: Optional[str]
    owner: Optional[str]
    priority: int
    source: str
    source_ref: Optional[str]
    group_folder: Optional[str]
    created_at: datetime  # UTC


@dataclass(frozen=True)
class ThreadActivity:
    thread_ref: str  # "gmail:<id>" | "exchange:<id>"
    subject: str
    user_sent_count: int
    counterparty_replied_count: int
    last_activity: datetime
    counterparty_addrs: tuple[str, ...]


@dataclass
class ClosureProfile:
    contact_base_trust: float
    default_base_trust: float
    thresholds: dict[str, float]
    counterparty_trust: dict[str, float] = field(default_factory=dict)
    rule_precision: dict[str, float] = field(default_factory=dict)
    version: int = 1

    @classmethod
    def default(cls) -> "ClosureProfile":
        return cls(
            contact_base_trust=0.7,
            default_base_trust=0.5,
            thresholds={"auto_close": 0.75, "suggest": 0.55},
        )


DEFAULT_PROFILE = ClosureProfile.default()


@dataclass(frozen=True)
class ClosureDecision:
    task_id: int
    task_title: str
    thread_ref: Optional[str]
    thread_addrs: tuple[str, ...]
    score: float
    tier: Tier
    rule: str
    reasoning: str
    candidates_considered: int


def score_candidate(*args, **kwargs) -> float:
    """Score a (task, thread) pair. Implementation in Task B2."""
    raise NotImplementedError("filled in Task B2")
