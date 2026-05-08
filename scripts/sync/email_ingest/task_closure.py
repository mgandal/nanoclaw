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
import re
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


EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PROJECT_PATTERNS = [
    re.compile(r"\bR0?[01][0-9-]+", re.IGNORECASE),
    re.compile(r"\bK99/R00\b", re.IGNORECASE),
    re.compile(r"\bRIS\s+\d+(?:/\d+)?", re.IGNORECASE),
    re.compile(r"\bT32[\w-]*\b", re.IGNORECASE),
    re.compile(r"\b[A-Z]{4,}-D-\d{2}-\d{5}\b"),
]
NAME_STOPWORDS = frozenset({
    "Respond", "Reply", "Follow", "Reach", "Send", "Email", "To", "From",
    "Update", "Review", "Submit", "Check", "Schedule", "Cancel", "Confirm",
    "About", "With", "Re", "Subject", "Note",
})


@dataclass(frozen=True)
class ExtractedEntities:
    emails: tuple[str, ...]
    contact_keys: tuple[str, ...]
    project_codes: tuple[str, ...]
    unknown_full_names: tuple[tuple[str, str], ...]


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


def _recency_factor(last_activity: datetime, now: datetime) -> float:
    delta = now - last_activity
    if delta.total_seconds() < 0:
        return 1.0
    if delta <= timedelta(hours=24):
        return 1.0
    if delta <= timedelta(days=7):
        return 0.8
    if delta <= timedelta(days=30):
        return 0.5
    return 0.2


def score_candidate(
    *,
    task: OpenTask,
    thread: ThreadActivity,
    match_strength: float,
    is_known_contact: bool,
    profile: ClosureProfile,
    now: datetime,
    same_thread_other_open_tasks: int,
) -> float:
    base_trust = (
        profile.contact_base_trust if is_known_contact
        else profile.default_base_trust
    )
    cp_trust = base_trust
    for addr in thread.counterparty_addrs:
        if addr in profile.counterparty_trust:
            cp_trust = profile.counterparty_trust[addr]
            break

    score = 0.0
    score += match_strength * 0.40
    score += _recency_factor(thread.last_activity, now) * 0.20
    score += cp_trust * 0.20
    if thread.user_sent_count > 0:
        score += 0.20
    if thread.counterparty_replied_count > 0:
        score += 0.10
    if same_thread_other_open_tasks > 0:
        score -= 0.30
    return max(0.0, min(1.0, score))


RUNNER_UP_GAP_REQUIRED = 0.20


def assign_tier(
    *,
    top_score: float,
    runner_up: Optional[float],
    profile: ClosureProfile,
) -> Tier:
    auto = profile.thresholds.get("auto_close", 0.75)
    suggest = profile.thresholds.get("suggest", 0.55)
    runner = runner_up if runner_up is not None else 0.0
    if top_score >= auto and (top_score - runner) >= RUNNER_UP_GAP_REQUIRED:
        return Tier.AUTO_CLOSE
    if top_score >= suggest:
        return Tier.SUGGEST
    return Tier.DROP


def extract_entities(
    *,
    title: str,
    context: Optional[str],
    contacts: dict[str, dict],
) -> ExtractedEntities:
    body = title if context is None else f"{title}\n{context}"
    emails = tuple(sorted({m.group(0).lower() for m in EMAIL_RE.finditer(body)}))

    contact_keys: list[str] = []
    body_lower = body.lower()
    for full_name in contacts.keys():
        for part in full_name.split():
            if len(part) >= 3 and re.search(rf"\b{re.escape(part)}\b", body_lower):
                contact_keys.append(full_name)
                break

    project_codes: list[str] = []
    for pat in PROJECT_PATTERNS:
        for m in pat.finditer(body):
            project_codes.append(m.group(0))

    full_name_re = re.compile(r"\b([A-Z][a-z]{1,})\s+([A-Z][a-z]{1,})\b")
    contact_words = set()
    for full_name in contacts.keys():
        contact_words.update(full_name.split())
    unknown_pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for m in full_name_re.finditer(body):
        first, last = m.group(1), m.group(2)
        if first in NAME_STOPWORDS or last in NAME_STOPWORDS:
            continue
        if first.lower() in contact_words or last.lower() in contact_words:
            continue
        if (first, last) in seen:
            continue
        seen.add((first, last))
        unknown_pairs.append((first, last))

    return ExtractedEntities(
        emails=emails,
        contact_keys=tuple(sorted(set(contact_keys))),
        project_codes=tuple(project_codes),
        unknown_full_names=tuple(unknown_pairs),
    )


PROFILE_VERSION = 1


def save_profile(profile: ClosureProfile, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": profile.version,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "contact_base_trust": profile.contact_base_trust,
        "default_base_trust": profile.default_base_trust,
        "thresholds": profile.thresholds,
        "counterparty_trust": profile.counterparty_trust,
        "rule_precision": profile.rule_precision,
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(path)


def load_profile(path: Path) -> ClosureProfile:
    if not path.exists():
        return ClosureProfile.default()
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning("profile %s malformed (%s); using defaults", path, e)
        return ClosureProfile.default()
    v = data.get("version", 0)
    if v != PROFILE_VERSION:
        log.warning("profile %s has version %s (expected %s); using defaults",
                    path, v, PROFILE_VERSION)
        return ClosureProfile.default()
    return ClosureProfile(
        contact_base_trust=float(data.get("contact_base_trust", 0.7)),
        default_base_trust=float(data.get("default_base_trust", 0.5)),
        thresholds=dict(data.get("thresholds", {"auto_close": 0.75, "suggest": 0.55})),
        counterparty_trust=dict(data.get("counterparty_trust", {})),
        rule_precision=dict(data.get("rule_precision", {})),
        version=PROFILE_VERSION,
    )
