"""Tests for fetch_thread_messages on both adapters."""
from unittest.mock import MagicMock, patch

from email_ingest.gmail_adapter import GmailAdapter
from email_ingest.exchange_adapter import ExchangeAdapter


def test_gmail_fetch_thread_filters_by_epoch():
    adapter = GmailAdapter()
    fake_service = MagicMock()
    adapter._service = fake_service

    fake_service.users.return_value.threads.return_value.get.return_value.execute.return_value = {
        "messages": [
            {
                "id": "m1", "threadId": "t1",
                "internalDate": "1700000000000",  # older than epoch
                "payload": {"headers": [
                    {"name": "From", "value": "a@x.com"},
                    {"name": "To", "value": "me@me.com"},
                    {"name": "Subject", "value": "s"},
                    {"name": "Date", "value": "2023-11-14"},
                ]},
                "labelIds": [],
            },
            {
                "id": "m2", "threadId": "t1",
                "internalDate": "1900000000000",  # newer than epoch
                "payload": {"headers": [
                    {"name": "From", "value": "b@x.com"},
                    {"name": "To", "value": "me@me.com"},
                    {"name": "Subject", "value": "s"},
                    {"name": "Date", "value": "2030-03-14"},
                ]},
                "labelIds": ["SENT"],
            },
        ]
    }

    results = adapter.fetch_thread_messages("t1", since_epoch=1_800_000_000)
    assert len(results) == 1
    assert results[0].id == "m2"
    assert "SENT" in results[0].labels


def test_gmail_fetch_thread_empty_when_not_connected():
    adapter = GmailAdapter()
    adapter._service = None
    assert adapter.fetch_thread_messages("t1", since_epoch=0) == []


def test_gmail_fetch_thread_api_error_returns_empty():
    adapter = GmailAdapter()
    fake_service = MagicMock()
    fake_service.users.return_value.threads.return_value.get.return_value.execute.side_effect = Exception("boom")
    adapter._service = fake_service
    assert adapter.fetch_thread_messages("t1", since_epoch=0) == []


def test_gmail_fetch_message_returns_none_when_not_connected():
    adapter = GmailAdapter()
    adapter._service = None
    assert adapter.fetch_message("msg-id") is None


def test_gmail_fetch_message_api_error_returns_none():
    adapter = GmailAdapter()
    fake_service = MagicMock()
    fake_service.users.return_value.messages.return_value.get.return_value.execute.side_effect = Exception("boom")
    adapter._service = fake_service
    assert adapter.fetch_message("msg-id") is None


def test_gmail_fetch_message_returns_normalized_email():
    adapter = GmailAdapter()
    fake_service = MagicMock()
    adapter._service = fake_service
    fake_service.users.return_value.messages.return_value.get.return_value.execute.return_value = {
        "id": "m1", "threadId": "t1",
        "payload": {"headers": [
            {"name": "From", "value": "a@x.com"},
            {"name": "To", "value": "me@me.com"},
            {"name": "Subject", "value": "s"},
            {"name": "Date", "value": "2026-04-16T00:00:00Z"},
        ]},
        "labelIds": [],
    }
    result = adapter.fetch_message("m1")
    assert result is not None
    assert result.id == "m1"
    assert result.from_addr == "a@x.com"


def test_exchange_fetch_thread_not_available_returns_empty():
    """If exchange-mail.sh is missing (is_available() False), returns []."""
    adapter = ExchangeAdapter()
    with patch.object(adapter, "is_available", return_value=False):
        assert adapter.fetch_thread_messages("conv-123", since_epoch=0) == []


def test_exchange_fetch_thread_when_available_returns_empty():
    """Bridge has no conversation endpoint in v1 — returns [] by design."""
    adapter = ExchangeAdapter()
    with patch.object(adapter, "is_available", return_value=True):
        assert adapter.fetch_thread_messages("conv-123", since_epoch=0) == []
