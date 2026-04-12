"""Tests for classifier profile loading and weight application."""

import json
from pathlib import Path
from unittest.mock import patch
import pytest

from email_ingest.classifier import (
    _load_profile,
    _build_system_prompt,
    _apply_weights,
    _format_few_shot,
    _extract_domain,
)
from email_ingest.types import NormalizedEmail


SAMPLE_PROFILE = {
    "version": 1,
    "baseline_reply_rate": 0.30,
    "sender_weights": {
        "chop.edu": {"total": 45, "replied": 38, "reply_rate": 0.84, "weight": 0.25},
        "linkedin.com": {"total": 25, "replied": 0, "reply_rate": 0.0, "weight": -0.15},
    },
    "topic_weights": {
        "grant": {"total": 80, "replied": 65, "reply_rate": 0.81, "weight": 0.25},
        "notification": {"total": 200, "replied": 5, "reply_rate": 0.03, "weight": -0.14},
    },
    "few_shot_examples": [
        {"from_domain": "chop.edu", "subject": "Talk Title", "topic": "admin", "replied": True},
        {"from_domain": "linkedin.com", "subject": "New connections", "topic": "notification", "replied": False},
    ],
}


def _make_email(**overrides) -> NormalizedEmail:
    defaults = dict(
        id="test-1", source="exchange", from_addr="Jane <jane@chop.edu>",
        to=["mgandal@upenn.edu"], cc=[], subject="Grant update",
        date="2026-04-11T14:00", body="Hello", labels=["Inbox"], metadata={},
    )
    defaults.update(overrides)
    return NormalizedEmail(**defaults)


# --- Domain extraction ---

def test_extract_domain_angle_brackets():
    assert _extract_domain("Jane Doe <jane@chop.edu>") == "chop.edu"


def test_extract_domain_plain():
    assert _extract_domain("jane@upenn.edu") == "upenn.edu"


def test_extract_domain_no_at():
    assert _extract_domain("no email here") == ""


# --- Profile loading ---

def test_load_profile_returns_none_when_missing(tmp_path):
    with patch("email_ingest.classifier.PROFILE_FILE", tmp_path / "nonexistent.json"):
        assert _load_profile() is None


def test_load_profile_returns_dict_when_valid(tmp_path):
    pf = tmp_path / "profile.json"
    pf.write_text(json.dumps(SAMPLE_PROFILE))
    with patch("email_ingest.classifier.PROFILE_FILE", pf):
        profile = _load_profile()
        assert profile is not None
        assert profile["version"] == 1


def test_load_profile_returns_none_on_corrupt_json(tmp_path):
    pf = tmp_path / "profile.json"
    pf.write_text("not json at all")
    with patch("email_ingest.classifier.PROFILE_FILE", pf):
        assert _load_profile() is None


# --- Few-shot formatting ---

def test_format_few_shot_includes_replied_and_ignored():
    text = _format_few_shot(SAMPLE_PROFILE["few_shot_examples"])
    assert "REPLIED" in text
    assert "IGNORED" in text
    assert "chop.edu" in text
    assert "linkedin.com" in text


# --- Weight application ---

def test_apply_weights_boosts_known_sender():
    result = _apply_weights(0.50, _make_email(), "grant", SAMPLE_PROFILE)
    # sender chop.edu: +0.25, topic grant: +0.25
    assert result == 1.0  # clamped to max


def test_apply_weights_penalizes_low_sender():
    email = _make_email(from_addr="recruiter@linkedin.com")
    result = _apply_weights(0.40, email, "notification", SAMPLE_PROFILE)
    # sender linkedin: -0.15, topic notification: -0.14
    assert abs(result - 0.11) < 0.01


def test_apply_weights_no_profile_returns_unchanged():
    result = _apply_weights(0.50, _make_email(), "grant", None)
    assert result == 0.50


def test_apply_weights_unknown_domain_no_change():
    email = _make_email(from_addr="someone@unknown-university.edu")
    result = _apply_weights(0.50, email, "other", SAMPLE_PROFILE)
    assert result == 0.50  # no sender weight, no topic weight


def test_apply_weights_clamps_to_zero():
    email = _make_email(from_addr="spam@linkedin.com")
    result = _apply_weights(0.10, email, "notification", SAMPLE_PROFILE)
    # 0.10 - 0.15 - 0.14 = -0.19 -> clamped to 0.0
    assert result == 0.0


# --- System prompt injection ---

def test_build_system_prompt_without_profile():
    with patch("email_ingest.classifier.PROFILE", None):
        prompt = _build_system_prompt("gmail")
        assert "REPLIED" not in prompt
        assert "email analysis assistant" in prompt


def test_build_system_prompt_with_profile():
    with patch("email_ingest.classifier.PROFILE", SAMPLE_PROFILE):
        prompt = _build_system_prompt("gmail")
        assert "REPLIED" in prompt
        assert "chop.edu" in prompt
