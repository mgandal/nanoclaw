"""Unit tests for email_ingest.task_closure."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from email_ingest.task_closure import (
    ClosureProfile,
    OpenTask,
    ThreadActivity,
    ClosureDecision,
    score_candidate,
    assign_tier,
    Tier,
    DEFAULT_PROFILE,
    extract_entities,
    ExtractedEntities,
    fetch_open_tasks,
    close_task_in_db,
)


def test_profile_defaults():
    p = ClosureProfile.default()
    assert p.contact_base_trust == 0.7
    assert p.default_base_trust == 0.5
    assert p.thresholds["auto_close"] == 0.75
    assert p.thresholds["suggest"] == 0.55


def _now() -> datetime:
    return datetime(2026, 5, 5, 12, 0, 0, tzinfo=timezone.utc)


def _task(**overrides) -> OpenTask:
    base = dict(
        id=42, title="Respond to Elise email", context=None, owner="mike",
        priority=3, source="manual", source_ref=None, group_folder=None,
        created_at=_now() - timedelta(days=1),
    )
    base.update(overrides)
    return OpenTask(**base)


def _thread(**overrides) -> ThreadActivity:
    base = dict(
        thread_ref="gmail:abc", subject="Re: 10X PO status",
        user_sent_count=0, counterparty_replied_count=0,
        last_activity=_now(), counterparty_addrs=(),
    )
    base.update(overrides)
    return ThreadActivity(**base)


def test_score_full_signal_known_contact():
    score = score_candidate(
        task=_task(),
        thread=_thread(
            user_sent_count=1, counterparty_replied_count=1,
            counterparty_addrs=("lucinda.bertsinger@pennmedicine.upenn.edu",),
        ),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    assert 0.90 <= score <= 1.0


def test_score_unknown_full_name_only_below_auto_close():
    score = score_candidate(
        task=_task(),
        thread=_thread(
            counterparty_replied_count=1,
            counterparty_addrs=("joe.buxbaum@example.org",),
        ),
        match_strength=0.8, is_known_contact=False,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    assert 0.65 <= score <= 0.75
    assert score < 0.75


def test_score_recency_decay():
    fresh = score_candidate(
        task=_task(created_at=_now() - timedelta(days=60)),
        thread=_thread(last_activity=_now()),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    stale = score_candidate(
        task=_task(created_at=_now() - timedelta(days=60)),
        thread=_thread(last_activity=_now() - timedelta(days=20)),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    assert fresh > stale


def test_score_multi_open_task_penalty():
    base = score_candidate(
        task=_task(), thread=_thread(user_sent_count=1),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    penalized = score_candidate(
        task=_task(), thread=_thread(user_sent_count=1),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=1,
    )
    assert base - penalized == pytest.approx(0.30, abs=0.001)


def test_score_clamps_to_unit_interval():
    score = score_candidate(
        task=_task(),
        thread=_thread(user_sent_count=1, counterparty_replied_count=1),
        match_strength=1.0, is_known_contact=True,
        profile=DEFAULT_PROFILE, now=_now(),
        same_thread_other_open_tasks=0,
    )
    assert 0.0 <= score <= 1.0


def test_tier_auto_close_clear_winner():
    assert assign_tier(top_score=0.86, runner_up=0.40, profile=DEFAULT_PROFILE) == Tier.AUTO_CLOSE


def test_tier_too_close_to_call_drops_to_suggest():
    assert assign_tier(top_score=0.80, runner_up=0.78, profile=DEFAULT_PROFILE) == Tier.SUGGEST


def test_tier_just_above_suggest():
    assert assign_tier(top_score=0.60, runner_up=0.20, profile=DEFAULT_PROFILE) == Tier.SUGGEST


def test_tier_below_floor_drops():
    assert assign_tier(top_score=0.40, runner_up=0.10, profile=DEFAULT_PROFILE) == Tier.DROP


def test_tier_no_runner_up_uses_zero():
    assert assign_tier(top_score=0.80, runner_up=None, profile=DEFAULT_PROFILE) == Tier.AUTO_CLOSE


def test_extract_email_address():
    e = extract_entities(
        title="Follow up with lucinda.bertsinger@pennmedicine.upenn.edu re: PO",
        context=None, contacts={},
    )
    assert "lucinda.bertsinger@pennmedicine.upenn.edu" in e.emails


def test_extract_known_contact_first_name():
    e = extract_entities(
        title="Respond to Lucinda about R01 budget",
        context=None,
        contacts={"lucinda bertsinger": {"email": "lucinda.bertsinger@pennmedicine.upenn.edu"}},
    )
    assert "lucinda bertsinger" in e.contact_keys


def test_extract_project_codes():
    e = extract_entities(
        title="Update R01-MH137578 documentation",
        context="Also covers RIS 97589/00 and the COGEDE-D-26-00011 manuscript",
        contacts={},
    )
    assert any("R01" in p for p in e.project_codes)
    assert any("RIS 97589" in p for p in e.project_codes)
    assert any("COGEDE-D-26-00011" in p for p in e.project_codes)


def test_extract_unknown_full_name():
    e = extract_entities(
        title="Reach out to Joe Buxbaum re: ASD cohort",
        context=None, contacts={},
    )
    assert ("Joe", "Buxbaum") in e.unknown_full_names


def test_extract_ignores_common_capitalized_words():
    e = extract_entities(
        title="Respond to Elise email",
        context=None, contacts={},
    )
    assert ("Respond", "To") not in e.unknown_full_names


def test_profile_round_trip(tmp_path):
    from email_ingest.task_closure import load_profile, save_profile
    p = ClosureProfile(
        contact_base_trust=0.8,
        default_base_trust=0.4,
        thresholds={"auto_close": 0.80, "suggest": 0.60},
        counterparty_trust={"a@b.com": 0.95},
        rule_precision={"provenance_match": 1.0},
        version=1,
    )
    out = tmp_path / "profile.json"
    save_profile(p, out)
    loaded = load_profile(out)
    assert loaded.contact_base_trust == 0.8
    assert loaded.thresholds["auto_close"] == 0.80
    assert loaded.counterparty_trust == {"a@b.com": 0.95}


def test_profile_missing_file_returns_defaults(tmp_path):
    from email_ingest.task_closure import load_profile
    p = load_profile(tmp_path / "absent.json")
    assert p.contact_base_trust == 0.7


def test_profile_malformed_returns_defaults(tmp_path, caplog):
    from email_ingest.task_closure import load_profile
    out = tmp_path / "bad.json"
    out.write_text("{ not valid json")
    import logging as _logging
    with caplog.at_level(_logging.WARNING):
        p = load_profile(out)
    assert p.contact_base_trust == 0.7
    assert any("malformed" in r.message.lower() for r in caplog.records)


def test_profile_newer_version_falls_back(tmp_path, caplog):
    from email_ingest.task_closure import load_profile
    out = tmp_path / "future.json"
    out.write_text(json.dumps({"version": 99, "contact_base_trust": 0.9}))
    import logging as _logging
    with caplog.at_level(_logging.WARNING):
        p = load_profile(out)
    assert p.contact_base_trust == 0.7


def test_append_jsonl_writes_one_line_per_event(tmp_path):
    from email_ingest.task_closure import append_jsonl_event
    log_path = tmp_path / "events.jsonl"
    append_jsonl_event(log_path, {"action": "closed", "task_id": 1})
    append_jsonl_event(log_path, {"action": "suggested", "task_id": 2})
    lines = log_path.read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["task_id"] == 1
    assert "ts" in json.loads(lines[0])


def test_read_recent_reopens(tmp_path):
    from email_ingest.task_closure import read_recent_reopens
    log_path = tmp_path / "events.jsonl"
    fixed_now = _now()
    rows = []
    for i, age_days in enumerate([1, 3, 30]):
        ts = (fixed_now - timedelta(days=age_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows.append(json.dumps({"ts": ts, "action": "reopened", "task_id": 100 + i}))
    log_path.write_text("\n".join(rows) + "\n")
    recent = read_recent_reopens(log_path, window_days=7, now=fixed_now)
    assert recent == {100, 101}


def test_read_recent_reopens_skips_corrupt_lines(tmp_path, caplog):
    from email_ingest.task_closure import read_recent_reopens
    log_path = tmp_path / "events.jsonl"
    log_path.write_text(
        '{"ts":"2026-05-05T12:00:00Z","action":"reopened","task_id":1}\n'
        'NOT VALID JSON\n'
        '{"ts":"2026-05-05T12:00:00Z","action":"reopened","task_id":2}\n'
    )
    import logging as _logging
    with caplog.at_level(_logging.WARNING):
        recent = read_recent_reopens(log_path, window_days=7, now=_now())
    assert recent == {1, 2}


def _make_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "messages.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          context TEXT,
          owner TEXT,
          priority INTEGER NOT NULL DEFAULT 3,
          due_date TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          source TEXT NOT NULL DEFAULT 'manual',
          source_ref TEXT,
          group_folder TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          CHECK (status IN ('open','done','archived')),
          CHECK (priority BETWEEN 1 AND 4)
        );
        INSERT INTO tasks (title, status, created_at) VALUES
          ('Open task A', 'open',  '2026-05-01T12:00:00Z'),
          ('Open task B', 'open',  '2026-05-02T12:00:00Z'),
          ('Closed task', 'done', '2026-04-01T12:00:00Z');
        """
    )
    conn.commit()
    conn.close()
    return db_path


def test_fetch_open_tasks_excludes_closed(tmp_path):
    db_path = _make_db(tmp_path)
    open_tasks = fetch_open_tasks(db_path)
    assert {t.title for t in open_tasks} == {"Open task A", "Open task B"}


def test_close_task_flips_status_and_writes_completed_at(tmp_path):
    db_path = _make_db(tmp_path)
    [task_a] = [t for t in fetch_open_tasks(db_path) if t.title == "Open task A"]
    ok = close_task_in_db(db_path, task_a.id, reasoning="auto: Lucinda replied")
    assert ok is True
    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT status, completed_at, context FROM tasks WHERE id=?", (task_a.id,)).fetchone()
    conn.close()
    status, completed_at, context = row
    assert status == "done"
    assert completed_at is not None
    assert "auto" in (context or "")


def test_close_task_idempotent_against_race(tmp_path):
    db_path = _make_db(tmp_path)
    [task_a] = [t for t in fetch_open_tasks(db_path) if t.title == "Open task A"]
    assert close_task_in_db(db_path, task_a.id, reasoning="r") is True
    assert close_task_in_db(db_path, task_a.id, reasoning="r2") is False


from email_ingest.task_closure import scan_and_close, ClosureRunReport
from unittest.mock import MagicMock


class _FakeAdapter:
    def __init__(self, threads: dict[str, list]):
        self._threads = threads
        self.fetch_message = MagicMock(return_value=None)

    def fetch_thread_messages(self, thread_id, since_epoch):
        return self._threads.get(thread_id, [])


def _user_sent_msg():
    m = MagicMock()
    m.labels = ["SENT"]
    m.metadata = {"is_sent": True}
    m.from_addr = "mike@self"
    m.id = "m1"
    m.subject = "Re: thing"
    return m


def test_scan_path_a_auto_closes_when_user_replied(tmp_path):
    db_path = _make_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO tasks (title, source, source_ref, status, created_at) VALUES (?, ?, ?, ?, ?)",
        ("Respond to Elise email", "email", "gmail:t-elise", "open", "2026-05-04T12:00:00Z"),
    )
    conn.commit()
    elise_id = conn.execute("SELECT id FROM tasks WHERE title='Respond to Elise email'").fetchone()[0]
    conn.close()

    gmail = _FakeAdapter({"t-elise": [_user_sent_msg()]})
    exchange = _FakeAdapter({})
    jsonl = tmp_path / "task-closures.jsonl"
    pending = tmp_path / "pending.json"

    report = scan_and_close(
        db_path=db_path, gmail_adapter=gmail, exchange_adapter=exchange,
        profile=DEFAULT_PROFILE, contacts={}, followups=[], now=_now(),
        jsonl_path=jsonl, pending_path=pending, per_run_cap=5, dry_run=False,
    )

    conn = sqlite3.connect(db_path)
    status = conn.execute("SELECT status FROM tasks WHERE id=?", (elise_id,)).fetchone()[0]
    conn.close()
    assert status == "done"

    events = [json.loads(l) for l in jsonl.read_text().splitlines()]
    closed = [e for e in events if e["action"] == "closed" and e["task_id"] == elise_id]
    assert len(closed) == 1
    assert closed[0]["thread_ref"] == "gmail:t-elise"
    assert report.closed_count == 1


def test_scan_dry_run_does_not_mutate_db(tmp_path):
    db_path = _make_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO tasks (title, source, source_ref, status, created_at) VALUES (?, ?, ?, ?, ?)",
        ("Respond to Elise email", "email", "gmail:t-elise", "open", "2026-05-04T12:00:00Z"),
    )
    conn.commit()
    conn.close()

    gmail = _FakeAdapter({"t-elise": [_user_sent_msg()]})
    exchange = _FakeAdapter({})

    report = scan_and_close(
        db_path=db_path, gmail_adapter=gmail, exchange_adapter=exchange,
        profile=DEFAULT_PROFILE, contacts={}, followups=[], now=_now(),
        jsonl_path=tmp_path / "events.jsonl", pending_path=tmp_path / "p.json",
        per_run_cap=5, dry_run=True,
    )
    conn = sqlite3.connect(db_path)
    statuses = [r[0] for r in conn.execute("SELECT status FROM tasks").fetchall()]
    conn.close()
    assert statuses.count("open") == 3  # nothing closed
    events = [json.loads(l) for l in (tmp_path / "events.jsonl").read_text().splitlines()]
    actions = [e["action"] for e in events]
    assert any(a.startswith("dry-") for a in actions)


def test_scan_respects_cooling_off(tmp_path):
    """A task with a recent 'reopened' event is masked from auto-close."""
    db_path = _make_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO tasks (title, source, source_ref, status, created_at) VALUES (?, ?, ?, ?, ?)",
        ("Respond to Elise email", "email", "gmail:t-elise", "open", "2026-05-04T12:00:00Z"),
    )
    conn.commit()
    tid = conn.execute("SELECT id FROM tasks WHERE title='Respond to Elise email'").fetchone()[0]
    conn.close()

    jsonl = tmp_path / "events.jsonl"
    # Pre-seed a 'reopened' event 1 day ago
    ts = (_now() - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    jsonl.write_text(json.dumps({"ts": ts, "action": "reopened", "task_id": tid}) + "\n")

    gmail = _FakeAdapter({"t-elise": [_user_sent_msg()]})
    exchange = _FakeAdapter({})

    report = scan_and_close(
        db_path=db_path, gmail_adapter=gmail, exchange_adapter=exchange,
        profile=DEFAULT_PROFILE, contacts={}, followups=[], now=_now(),
        jsonl_path=jsonl, pending_path=tmp_path / "p.json",
        per_run_cap=5, dry_run=False,
    )

    conn = sqlite3.connect(db_path)
    status = conn.execute("SELECT status FROM tasks WHERE id=?", (tid,)).fetchone()[0]
    conn.close()
    assert status == "open"  # still open due to cooling-off
    assert report.cooling_off_count == 1


def test_scan_path_b_known_contact_auto_closes(tmp_path):
    db_path = _make_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO tasks (title, status, created_at) VALUES (?, ?, ?)",
        ("Respond to Lucinda about R01 budget", "open", "2026-05-04T12:00:00Z"),
    )
    conn.commit()
    tid = conn.execute("SELECT id FROM tasks WHERE title LIKE '%Lucinda%'").fetchone()[0]
    conn.close()

    user_msg = _user_sent_msg()
    cp_msg = MagicMock()
    cp_msg.labels = []
    cp_msg.metadata = {"is_sent": False}
    cp_msg.from_addr = "lucinda.bertsinger@pennmedicine.upenn.edu"
    cp_msg.subject = "R01 budget"

    gmail = _FakeAdapter({"t-lucinda": [user_msg, cp_msg]})
    gmail.search_threads_since = MagicMock(return_value=[
        {"thread_id": "t-lucinda", "subject": "R01 budget",
         "addrs": ["lucinda.bertsinger@pennmedicine.upenn.edu", "mike@self"]},
    ])
    exchange = _FakeAdapter({})
    exchange.search_threads_since = MagicMock(return_value=[])

    report = scan_and_close(
        db_path=db_path, gmail_adapter=gmail, exchange_adapter=exchange,
        profile=DEFAULT_PROFILE,
        contacts={"lucinda bertsinger": {"email": "lucinda.bertsinger@pennmedicine.upenn.edu"}},
        followups=[], now=_now(),
        jsonl_path=tmp_path / "events.jsonl", pending_path=tmp_path / "p.json",
        per_run_cap=5, dry_run=False,
    )

    conn = sqlite3.connect(db_path)
    status = conn.execute("SELECT status FROM tasks WHERE id=?", (tid,)).fetchone()[0]
    conn.close()
    assert status == "done"
    assert report.closed_count == 1
