"""Unit tests for email_ingest.task_closure_trainer."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from email_ingest.task_closure_trainer import train, compute_counterparty_trust


def _now() -> datetime:
    return datetime(2026, 5, 5, 12, 0, 0, tzinfo=timezone.utc)


def _ev(action, task_id, *, age_days=1, addr=None, rule="retroactive_full_email_match"):
    ts = (_now() - timedelta(days=age_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"ts": ts, "action": action, "task_id": task_id, "rule": rule}
    if addr:
        out["thread_addrs"] = [addr]
    return out


def _write_jsonl(path: Path, events: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n")


def test_compute_counterparty_trust_high_for_clean_record():
    events = [_ev("closed", i, addr="lucinda@x.com") for i in range(1, 5)]
    trust = compute_counterparty_trust(events)
    assert trust["lucinda@x.com"] >= 0.85


def test_compute_counterparty_trust_low_after_reopens():
    events = [
        _ev("closed", 1, addr="noisy@x.com"),
        _ev("reopened", 1),
        _ev("closed", 2, addr="noisy@x.com"),
        _ev("reopened", 2),
    ]
    trust = compute_counterparty_trust(events)
    assert trust["noisy@x.com"] <= 0.30


def test_train_writes_profile(tmp_path):
    log_path = tmp_path / "events.jsonl"
    out_path = tmp_path / "profile.json"
    _write_jsonl(log_path, [
        _ev("closed", 1, addr="a@x.com"),
        _ev("closed", 2, addr="a@x.com"),
        _ev("closed", 3, addr="b@x.com"),
        _ev("reopened", 3),
    ])
    train(log_path, out_path, lookback_days=30, now=_now())
    profile = json.loads(out_path.read_text())
    assert profile["version"] == 1
    assert "a@x.com" in profile["counterparty_trust"]


def test_train_handles_empty_jsonl(tmp_path):
    log_path = tmp_path / "events.jsonl"
    log_path.write_text("")
    out_path = tmp_path / "profile.json"
    train(log_path, out_path, lookback_days=30, now=_now())
    profile = json.loads(out_path.read_text())
    assert profile["contact_base_trust"] == 0.7
