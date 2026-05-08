"""Unit tests for email_ingest.task_closure."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from email_ingest.task_closure import (
    ClosureProfile,
    OpenTask,
    ThreadActivity,
    ClosureDecision,
    score_candidate,
    Tier,
    DEFAULT_PROFILE,
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
