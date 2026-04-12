"""Tests for classifier training — data collection and labeling."""

import json
import pytest
from unittest.mock import patch, MagicMock

from email_ingest.trainer import (
    normalize_subject,
    match_sent_to_inbox,
    label_gmail_threads,
    classify_topic_by_keywords,
    compute_weights,
    select_few_shot_examples,
    TrainingExample,
)


# --- Subject normalization ---

def test_normalize_subject_strips_re_prefix():
    assert normalize_subject("Re: Grant update") == "grant update"


def test_normalize_subject_strips_fw_prefix():
    assert normalize_subject("FW: [External] Talk Title") == "[external] talk title"


def test_normalize_subject_strips_multiple_prefixes():
    assert normalize_subject("Re: Fwd: RE: Hello") == "hello"


def test_normalize_subject_strips_whitespace():
    assert normalize_subject("  Re:  spaced out  ") == "spaced out"


# --- Exchange sent-to-inbox matching ---

def test_match_sent_to_inbox_basic():
    inbox = [
        {"id": "msg1", "subject": "Grant update", "from": "jane@upenn.edu",
         "fromName": "Jane", "date": "2026-04-10T10:00"},
        {"id": "msg2", "subject": "Lunch?", "from": "bob@gmail.com",
         "fromName": "Bob", "date": "2026-04-10T12:00"},
    ]
    sent = [
        {"id": "s1", "subject": "Re: Grant update", "date": "2026-04-10T14:00"},
    ]
    labels = match_sent_to_inbox(inbox, sent, max_hours=48)
    assert labels["msg1"] is True  # replied
    assert labels["msg2"] is False  # not replied


def test_match_sent_to_inbox_no_match_outside_window():
    inbox = [
        {"id": "msg1", "subject": "Old topic", "from": "a@b.com",
         "fromName": "A", "date": "2026-04-01T10:00"},
    ]
    sent = [
        {"id": "s1", "subject": "Re: Old topic", "date": "2026-04-05T10:00"},
    ]
    labels = match_sent_to_inbox(inbox, sent, max_hours=48)
    assert labels["msg1"] is False  # too far apart


# --- Gmail thread labeling ---

def test_label_gmail_threads_replied():
    threads = [
        {
            "id": "t1",
            "messages": [
                {"from": "jane@upenn.edu", "subject": "Paper draft", "date": "2026-04-10"},
                {"from": "mgandal@gmail.com", "subject": "Re: Paper draft", "date": "2026-04-10"},
            ],
        },
    ]
    labels = label_gmail_threads(threads, "mgandal@gmail.com")
    assert labels[0]["replied"] is True


def test_label_gmail_threads_not_replied():
    threads = [
        {
            "id": "t2",
            "messages": [
                {"from": "newsletter@nature.com", "subject": "Weekly digest", "date": "2026-04-10"},
            ],
        },
    ]
    labels = label_gmail_threads(threads, "mgandal@gmail.com")
    assert labels[0]["replied"] is False


def test_label_gmail_threads_outbound_only_excluded():
    threads = [
        {
            "id": "t3",
            "messages": [
                {"from": "mgandal@gmail.com", "subject": "Outbound", "date": "2026-04-10"},
            ],
        },
    ]
    labels = label_gmail_threads(threads, "mgandal@gmail.com")
    assert len(labels) == 0  # excluded — outbound only


# --- Keyword topic tagging ---

def test_classify_topic_grant():
    assert classify_topic_by_keywords("R01 budget revision needed") == "grant"


def test_classify_topic_hiring():
    assert classify_topic_by_keywords("Postdoc candidate interview schedule") == "hiring"


def test_classify_topic_research():
    assert classify_topic_by_keywords("Manuscript figure revisions") == "research"


def test_classify_topic_unknown():
    assert classify_topic_by_keywords("Hello there") == "other"


# --- Weight computation ---

def test_compute_weights_basic():
    examples = [
        TrainingExample(source="exchange", from_domain="chop.edu", subject="A", topic="grant", replied=True),
        TrainingExample(source="exchange", from_domain="chop.edu", subject="B", topic="grant", replied=True),
        TrainingExample(source="exchange", from_domain="chop.edu", subject="C", topic="admin", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="D", topic="notification", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="E", topic="notification", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="F", topic="notification", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="G", topic="notification", replied=False),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="H", topic="notification", replied=False),
    ]
    sender_w, topic_w, baseline = compute_weights(examples, min_sender_count=2, min_topic_count=2)
    # baseline = 2/8 = 0.25
    assert abs(baseline - 0.25) < 0.01
    # chop.edu: 2/3 replied = 0.67, weight = (0.67 - 0.25) * 0.5 = 0.21
    assert sender_w["chop.edu"]["weight"] > 0.1
    # linkedin.com: 0/5 = 0.0, weight = (0.0 - 0.25) * 0.5 = -0.125
    assert sender_w["linkedin.com"]["weight"] < -0.05


def test_compute_weights_skips_small_domains():
    examples = [
        TrainingExample(source="exchange", from_domain="rare.edu", subject="X", topic="other", replied=True),
    ]
    sender_w, _, _ = compute_weights(examples, min_sender_count=5)
    assert "rare.edu" not in sender_w


# --- Few-shot selection ---

def test_select_few_shot_diverse_domains():
    examples = [
        TrainingExample(source="exchange", from_domain="chop.edu", subject="A", topic="grant", replied=True, date="2026-04-01"),
        TrainingExample(source="exchange", from_domain="upenn.edu", subject="B", topic="research", replied=True, date="2026-04-02"),
        TrainingExample(source="gmail", from_domain="nature.com", subject="C", topic="research", replied=True, date="2026-04-03"),
        TrainingExample(source="exchange", from_domain="chop.edu", subject="D", topic="admin", replied=False, date="2026-04-01"),
        TrainingExample(source="exchange", from_domain="linkedin.com", subject="E", topic="notification", replied=False, date="2026-04-02"),
        TrainingExample(source="gmail", from_domain="zoom.us", subject="F", topic="notification", replied=False, date="2026-04-03"),
    ]
    selected = select_few_shot_examples(examples, n_positive=3, n_negative=3)
    assert len(selected) == 6
    replied = [e for e in selected if e.replied]
    ignored = [e for e in selected if not e.replied]
    assert len(replied) == 3
    assert len(ignored) == 3
    # No duplicate domains within replied or ignored groups
    replied_domains = [e.from_domain for e in replied]
    assert len(replied_domains) == len(set(replied_domains))
