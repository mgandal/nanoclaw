"""Tests for auto-closure based on thread activity."""
from datetime import datetime, timezone
from unittest.mock import MagicMock

from email_ingest.closure import apply_closure
from email_ingest.types import FollowUp, NormalizedEmail


def _email(id_, from_addr, labels=None):
    return NormalizedEmail(
        id=id_, source="gmail", from_addr=from_addr,
        to=["sarah@gmail.com"], cc=[], subject="re",
        date="2026-04-18T12:00:00Z", body="", labels=labels or [],
        metadata={"threadId": "abc"},
    )


def test_i_owe_closed_when_user_sends_later():
    item = FollowUp(
        kind="i-owe", who="Sarah", what="send methods", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    gmail = MagicMock()
    gmail.fetch_thread_messages.return_value = [
        _email("m2", "mike@upenn.edu", labels=["SENT"])
    ]
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 1
    assert updated[0].status == "closed"
    assert updated[0].closed_reason == "replied-in-thread"
    assert updated[0].closed_at is not None


def test_they_owe_me_closed_when_counterparty_replies():
    item = FollowUp(
        kind="they-owe-me", who="po@nih.gov",
        what="confirm budget", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    source_email = _email("orig", "po@nih.gov")
    gmail = MagicMock()
    gmail.fetch_thread_messages.return_value = [source_email, _email("m2", "po@nih.gov")]
    gmail.fetch_message.return_value = source_email
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 1
    assert updated[0].status == "closed"
    assert updated[0].closed_reason == "counterparty-replied"


def test_they_owe_me_third_party_does_not_close():
    item = FollowUp(
        kind="they-owe-me", who="po@nih.gov",
        what="confirm budget", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    source_email = _email("orig", "po@nih.gov")
    gmail = MagicMock()
    gmail.fetch_thread_messages.return_value = [source_email, _email("m2", "other@nih.gov")]
    gmail.fetch_message.return_value = source_email
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 0
    assert updated[0].status == "open"


def test_non_open_entries_untouched():
    item = FollowUp(
        kind="i-owe", who="X", what="y", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="closed",
    )
    gmail = MagicMock()
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 0
    assert updated[0].status == "closed"
    gmail.fetch_thread_messages.assert_not_called()


def test_thread_without_activity_stays_open():
    item = FollowUp(
        kind="i-owe", who="X", what="y", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    gmail = MagicMock()
    gmail.fetch_thread_messages.return_value = []
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))

    assert closed == 0
    assert updated[0].status == "open"


def test_exchange_thread_routed_to_exchange_adapter():
    item = FollowUp(
        kind="i-owe", who="X", what="y", due="none",
        thread="exchange:conv-1", source_msg="exchange:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    gmail = MagicMock()
    exchange = MagicMock()
    exchange.fetch_thread_messages.return_value = []

    apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))
    gmail.fetch_thread_messages.assert_not_called()
    exchange.fetch_thread_messages.assert_called_once()


def test_counterparty_name_in_angle_brackets_matched():
    """From line like 'Program Officer <po@nih.gov>' still matches counterparty addr."""
    item = FollowUp(
        kind="they-owe-me", who="po@nih.gov",
        what="confirm", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="2026-04-15T00:00:00Z", status="open",
    )
    source_email = _email("orig", "Program Officer <po@nih.gov>")
    reply = _email("m2", "Program Officer <po@nih.gov>")
    gmail = MagicMock()
    gmail.fetch_thread_messages.return_value = [source_email, reply]
    gmail.fetch_message.return_value = source_email
    exchange = MagicMock()

    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))
    assert closed == 1


def test_unparseable_created_timestamp_skipped():
    item = FollowUp(
        kind="i-owe", who="X", what="y", due="none",
        thread="gmail:abc", source_msg="gmail:orig",
        created="garbage", status="open",
    )
    gmail = MagicMock()
    exchange = MagicMock()
    updated, closed = apply_closure([item], gmail, exchange, now=datetime(2026, 4, 18, tzinfo=timezone.utc))
    assert closed == 0
    assert updated[0].status == "open"
    gmail.fetch_thread_messages.assert_not_called()
