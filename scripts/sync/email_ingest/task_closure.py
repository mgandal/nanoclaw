"""Email-driven auto-closure of tasks in store/messages.db.

Runs at the end of each email-ingest cycle. Reads open tasks via direct
SQLite, scores each against candidate Gmail/Exchange threads, and closes
high-confidence matches. Mirrors email_ingest.closure (followups.md) but
writes to the SQL tasks table.

See docs/superpowers/specs/2026-05-06-email-task-closure-design.md.
"""
from __future__ import annotations

import enum
import fcntl
import json
import logging
import re
import sqlite3
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


def append_jsonl_event(path: Path, event: dict) -> None:
    """Append one JSONL event under exclusive file lock."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if "ts" not in event:
        event = {"ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **event}
    line = json.dumps(event) + "\n"
    with path.open("a") as fp:
        fcntl.flock(fp.fileno(), fcntl.LOCK_EX)
        try:
            fp.write(line)
        finally:
            fcntl.flock(fp.fileno(), fcntl.LOCK_UN)


def read_recent_reopens(path: Path, *, window_days: int, now: datetime) -> set[int]:
    if not path.exists():
        return set()
    cutoff = now - timedelta(days=window_days)
    out: set[int] = set()
    with path.open("r") as fp:
        fcntl.flock(fp.fileno(), fcntl.LOCK_SH)
        try:
            for raw in fp:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("corrupt JSONL line skipped: %r", raw[:120])
                    continue
                if obj.get("action") != "reopened":
                    continue
                ts_str = obj.get("ts", "")
                try:
                    ts = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                if ts >= cutoff:
                    tid = obj.get("task_id")
                    if isinstance(tid, int):
                        out.add(tid)
        finally:
            fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
    return out


def _parse_db_ts(s: str) -> datetime:
    s = s.replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    if "+" not in s and "-" not in s[10:]:
        s = s + "+00:00"
    return datetime.fromisoformat(s)


def fetch_open_tasks(db_path: Path) -> list[OpenTask]:
    conn = sqlite3.connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, title, context, owner, priority, source, source_ref,
                   group_folder, created_at
              FROM tasks
             WHERE status = 'open'
            """
        ).fetchall()
    finally:
        conn.close()

    out: list[OpenTask] = []
    for r in rows:
        try:
            created = _parse_db_ts(r["created_at"])
        except ValueError:
            log.warning("task %s: unparseable created_at %r; skipping", r["id"], r["created_at"])
            continue
        out.append(OpenTask(
            id=r["id"], title=r["title"], context=r["context"],
            owner=r["owner"], priority=r["priority"],
            source=r["source"], source_ref=r["source_ref"],
            group_folder=r["group_folder"], created_at=created,
        ))
    return out


def close_task_in_db(db_path: Path, task_id: int, *, reasoning: str) -> bool:
    note = f"[auto-closed: {reasoning[:200]}]"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            """
            UPDATE tasks
               SET status = 'done',
                   completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                   context = CASE WHEN context IS NULL THEN ?
                                  ELSE context || char(10) || ? END
             WHERE id = ? AND status = 'open'
            """,
            (note, note, task_id),
        )
        conn.commit()
        return cur.rowcount == 1
    finally:
        conn.close()


PATH_A_ACTIVITY_WINDOW_DAYS = 90
COOLING_OFF_DAYS = 7


@dataclass
class ClosureRunReport:
    closed_count: int = 0
    suggested_count: int = 0
    cooling_off_count: int = 0
    skipped_count: int = 0
    decisions: list[ClosureDecision] = field(default_factory=list)


def _is_user_sent(msg) -> bool:
    labels = getattr(msg, "labels", None) or []
    if "SENT" in labels:
        return True
    meta = getattr(msg, "metadata", None) or {}
    return bool(meta.get("is_sent", False))


def _classify_kind(task: OpenTask) -> str:
    text = (task.title or "").lower() + " " + (task.context or "").lower()
    if any(p in text for p in ["awaiting", "follow up with", "they owe", "waiting for"]):
        return "they-owe-me"
    return "i-owe"


def _msg_dt(m) -> Optional[datetime]:
    ts = getattr(m, "timestamp", None) or (getattr(m, "metadata", None) or {}).get("internalDate")
    if ts is None:
        return None
    try:
        if isinstance(ts, (int, float)) or (isinstance(ts, str) and ts.isdigit()):
            return datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc)
        return _parse_db_ts(str(ts))
    except (ValueError, OSError):
        return None


def _path_a_should_close(task: OpenTask, thread_msgs: list, now: datetime) -> tuple[bool, str, tuple[str, ...]]:
    cutoff = now - timedelta(days=PATH_A_ACTIVITY_WINDOW_DAYS)
    floor = max(cutoff, task.created_at)
    relevant = []
    for m in thread_msgs:
        dt = _msg_dt(m)
        if dt is None or dt >= floor:
            relevant.append(m)
    if not relevant:
        return False, "", ()
    addrs = tuple({(getattr(m, "from_addr", "") or "").lower() for m in relevant if getattr(m, "from_addr", None)} - {""})
    kind = _classify_kind(task)
    if kind == "i-owe":
        for m in relevant:
            if _is_user_sent(m):
                return True, f"You sent reply in thread '{getattr(m, 'subject', '')}' since task creation.", addrs
        return False, "", addrs
    else:
        for m in relevant:
            if not _is_user_sent(m):
                return True, "Counterparty replied in thread since task creation.", addrs
        return False, "", addrs


def scan_and_close(
    *,
    db_path: Path, gmail_adapter, exchange_adapter,
    profile: ClosureProfile, contacts: dict[str, dict],
    followups: list, now: datetime,
    jsonl_path: Path, pending_path: Path,
    per_run_cap: int = 5, dry_run: bool = False,
) -> ClosureRunReport:
    report = ClosureRunReport()
    cooling_off = read_recent_reopens(jsonl_path, window_days=COOLING_OFF_DAYS, now=now)
    open_followup_threads = {
        f.thread for f in followups
        if getattr(f, "status", "open") == "open" and getattr(f, "thread", None)
    }
    open_tasks = fetch_open_tasks(db_path)
    pending_decisions: list[dict] = []
    closed_this_run = 0

    for task in open_tasks:
        if task.id in cooling_off:
            append_jsonl_event(jsonl_path, {
                "action": "cooling_off",
                "task_id": task.id, "task_title": task.title,
                "reasoning": f"Within {COOLING_OFF_DAYS}-day cooling-off after recent reopen",
            })
            report.cooling_off_count += 1
            continue

        # Path A: provenance match
        if task.source == "email" and task.source_ref:
            try:
                src, tid = task.source_ref.split(":", 1)
            except ValueError:
                src, tid = "", task.source_ref
            adapter = gmail_adapter if src == "gmail" else exchange_adapter if src == "exchange" else None
            if adapter is None:
                report.skipped_count += 1
                continue
            try:
                thread_msgs = adapter.fetch_thread_messages(tid, int(task.created_at.timestamp()))
            except Exception as e:
                log.warning("task %s: thread fetch failed: %s", task.id, e)
                report.skipped_count += 1
                continue

            should_close, reasoning, addrs = _path_a_should_close(task, thread_msgs, now)
            if not should_close:
                continue

            if task.source_ref in open_followup_threads:
                tier = Tier.SUGGEST
                reasoning += " (held: open followup on same thread)"
            else:
                tier = Tier.AUTO_CLOSE

            decision = ClosureDecision(
                task_id=task.id, task_title=task.title,
                thread_ref=task.source_ref, thread_addrs=addrs,
                score=1.0, tier=tier, rule="provenance_match",
                reasoning=reasoning, candidates_considered=1,
            )
            closed_this_run = _emit_decision(
                decision, jsonl_path, pending_decisions, report,
                db_path=db_path, dry_run=dry_run,
                closed_this_run=closed_this_run, per_run_cap=per_run_cap,
            )
            continue

        # Path B is added in Task B9.

    # Rewrite pending file atomically
    pending_payload = {
        "version": 1,
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "items": pending_decisions,
    }
    tmp = pending_path.with_suffix(pending_path.suffix + ".tmp")
    pending_path.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(pending_payload, indent=2))
    tmp.replace(pending_path)

    return report


def _emit_decision(
    decision: ClosureDecision,
    jsonl_path: Path,
    pending_decisions: list[dict],
    report: ClosureRunReport,
    *,
    db_path: Path,
    dry_run: bool,
    closed_this_run: int,
    per_run_cap: int,
) -> int:
    """Returns updated closed_this_run counter."""
    prefix = "dry-" if dry_run else ""

    if decision.tier == Tier.AUTO_CLOSE:
        if closed_this_run >= per_run_cap:
            event = {
                "action": f"{prefix}suggested",
                "task_id": decision.task_id, "task_title": decision.task_title,
                "thread_ref": decision.thread_ref,
                "thread_addrs": list(decision.thread_addrs),
                "score": decision.score, "rule": decision.rule,
                "reasoning": decision.reasoning + " (per-run cap exceeded)",
                "candidates_considered": decision.candidates_considered,
            }
            append_jsonl_event(jsonl_path, event)
            pending_decisions.append(event)
            report.suggested_count += 1
            return closed_this_run

        if not dry_run:
            ok = close_task_in_db(db_path, decision.task_id, reasoning=decision.reasoning)
            if not ok:
                log.warning("task %s: close failed (status changed); skipping", decision.task_id)
                report.skipped_count += 1
                return closed_this_run

        event = {
            "action": f"{prefix}closed",
            "task_id": decision.task_id, "task_title": decision.task_title,
            "thread_ref": decision.thread_ref,
            "thread_addrs": list(decision.thread_addrs),
            "score": decision.score, "rule": decision.rule,
            "reasoning": decision.reasoning,
            "candidates_considered": decision.candidates_considered,
        }
        append_jsonl_event(jsonl_path, event)
        report.closed_count += 1
        report.decisions.append(decision)
        return closed_this_run + (0 if dry_run else 1)

    if decision.tier == Tier.SUGGEST:
        event = {
            "action": f"{prefix}suggested",
            "task_id": decision.task_id, "task_title": decision.task_title,
            "thread_ref": decision.thread_ref,
            "thread_addrs": list(decision.thread_addrs),
            "score": decision.score, "rule": decision.rule,
            "reasoning": decision.reasoning,
            "candidates_considered": decision.candidates_considered,
        }
        append_jsonl_event(jsonl_path, event)
        pending_decisions.append(event)
        report.suggested_count += 1
    return closed_this_run
