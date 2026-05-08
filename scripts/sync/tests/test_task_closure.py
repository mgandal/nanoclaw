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
