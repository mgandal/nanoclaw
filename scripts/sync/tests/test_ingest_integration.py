"""Integration tests for the wired extraction/closure/aging passes."""
import os
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock


@patch.dict(os.environ, {"EMAIL_FOLLOWUPS_ENABLED": "1"})
@patch("email_ingest.followups.write_file")
@patch("email_ingest.followups.parse_file")
@patch("email_ingest.extractor.extract")
def test_flag_on_runs_followups_pipeline(
    mock_extract, mock_parse, mock_write
):
    """With the flag on, the wired pipeline parses, extracts, and writes."""
    import email_ingest_module_under_test as m

    mock_parse.return_value = []
    mock_extract.return_value = None  # simplest — no extraction writes

    m.run_followups_passes(
        gmail_adapter=MagicMock(),
        exchange_adapter=MagicMock(),
        new_emails=[],
        now=datetime(2026, 4, 17, tzinfo=timezone.utc),
    )
    mock_parse.assert_called_once()
    mock_write.assert_called_once()


@patch.dict(os.environ, {}, clear=True)
@patch("email_ingest.followups.parse_file")
def test_flag_off_skips_pipeline(mock_parse):
    import email_ingest_module_under_test as m
    m.run_followups_passes(
        gmail_adapter=MagicMock(),
        exchange_adapter=MagicMock(),
        new_emails=[],
        now=datetime(2026, 4, 17, tzinfo=timezone.utc),
    )
    mock_parse.assert_not_called()


@patch.dict(os.environ, {"EMAIL_FOLLOWUPS_ENABLED": "1"})
@patch("email_ingest.followups.write_file")
@patch("email_ingest.followups.parse_file")
@patch("email_ingest.extractor.extract")
def test_sent_gmail_email_triggers_extraction(mock_extract, mock_parse, mock_write):
    """A sent Gmail email (From == mgandal@gmail.com) drives extract() with direction=sent."""
    import email_ingest_module_under_test as m
    from email_ingest.types import NormalizedEmail
    from email_ingest.extractor import ExtractionResult

    mock_parse.return_value = []
    mock_extract.return_value = ExtractionResult(
        kind="i-owe", who="Sarah", what="Send methods",
        due="none", significant=False, decision_summary="",
    )
    sent = NormalizedEmail(
        id="msg1", source="gmail", from_addr="mgandal@gmail.com",
        to=["sarah@gmail.com"], cc=[], subject="re",
        date="2026-04-17T10:00:00Z", body="I'll send methods",
        labels=["SENT"], metadata={"threadId": "tid"},
    )

    m.run_followups_passes(
        gmail_adapter=MagicMock(),
        exchange_adapter=MagicMock(),
        new_emails=[(sent, 0.5)],
        now=datetime(2026, 4, 17, tzinfo=timezone.utc),
    )

    mock_extract.assert_called_once()
    args, kwargs = mock_extract.call_args
    assert kwargs.get("direction") == "sent" or (len(args) >= 2 and args[1] == "sent")

    # write_file called with items list containing the new follow-up
    write_args, _ = mock_write.call_args
    written = write_args[1]  # second positional — list of FollowUp
    assert len(written) == 1
    assert written[0].kind == "i-owe"


@patch.dict(os.environ, {"EMAIL_FOLLOWUPS_ENABLED": "1"})
@patch("email_ingest.followups.write_file")
@patch("email_ingest.followups.parse_file")
@patch("email_ingest.extractor.extract")
def test_received_low_relevance_skipped(mock_extract, mock_parse, mock_write):
    import email_ingest_module_under_test as m
    from email_ingest.types import NormalizedEmail

    mock_parse.return_value = []
    received = NormalizedEmail(
        id="msg1", source="gmail", from_addr="other@x.com",
        to=["mgandal@gmail.com"], cc=[], subject="re",
        date="2026-04-17T10:00:00Z", body="fyi",
        labels=[], metadata={"threadId": "tid"},
    )

    m.run_followups_passes(
        gmail_adapter=MagicMock(),
        exchange_adapter=MagicMock(),
        new_emails=[(received, 0.3)],  # below 0.7 threshold
        now=datetime(2026, 4, 17, tzinfo=timezone.utc),
    )
    mock_extract.assert_not_called()


@patch.dict(os.environ, {"EMAIL_FOLLOWUPS_ENABLED": "1"})
@patch("email_ingest.followups.write_file")
@patch("email_ingest.followups.parse_file")
@patch("email_ingest.extractor.extract")
def test_received_high_relevance_extracts(mock_extract, mock_parse, mock_write):
    import email_ingest_module_under_test as m
    from email_ingest.types import NormalizedEmail

    mock_parse.return_value = []
    mock_extract.return_value = None
    received = NormalizedEmail(
        id="msg1", source="gmail", from_addr="po@nih.gov",
        to=["mgandal@gmail.com"], cc=[], subject="budget?",
        date="2026-04-17T10:00:00Z", body="can you confirm?",
        labels=[], metadata={"threadId": "tid"},
    )

    m.run_followups_passes(
        gmail_adapter=MagicMock(),
        exchange_adapter=MagicMock(),
        new_emails=[(received, 0.8)],
        now=datetime(2026, 4, 17, tzinfo=timezone.utc),
    )
    mock_extract.assert_called_once()
    args, kwargs = mock_extract.call_args
    assert kwargs.get("direction") == "received" or (len(args) >= 2 and args[1] == "received")


@patch.dict(os.environ, {"EMAIL_FOLLOWUPS_ENABLED": "1"})
@patch("email_ingest.followups.write_file")
@patch("email_ingest.followups.parse_file")
@patch("email_ingest.extractor.extract")
def test_mikejg1838_sender_skipped(mock_extract, mock_parse, mock_write):
    """Spec excludes mikejg1838 from extraction scope."""
    import email_ingest_module_under_test as m
    from email_ingest.types import NormalizedEmail

    mock_parse.return_value = []
    sent = NormalizedEmail(
        id="msg1", source="gmail", from_addr="mikejg1838@gmail.com",
        to=["sarah@gmail.com"], cc=[], subject="re",
        date="2026-04-17T10:00:00Z", body="test",
        labels=["SENT"], metadata={"threadId": "tid"},
    )

    m.run_followups_passes(
        gmail_adapter=MagicMock(),
        exchange_adapter=MagicMock(),
        new_emails=[(sent, 0.5)],
        now=datetime(2026, 4, 17, tzinfo=timezone.utc),
    )
    mock_extract.assert_not_called()


@patch.dict(os.environ, {"EMAIL_FOLLOWUPS_ENABLED": "1"})
@patch("email_ingest.followups.write_file")
@patch("email_ingest.followups.parse_file")
@patch("email_ingest.extractor.extract")
def test_significant_decision_retained(mock_extract, mock_parse, mock_write):
    """A sent email with significant=True triggers a Hindsight retain call."""
    import email_ingest_module_under_test as m
    from email_ingest.types import NormalizedEmail
    from email_ingest.extractor import ExtractionResult

    mock_parse.return_value = []
    mock_extract.return_value = ExtractionResult(
        kind="none", who="PO", what="",
        due="none", significant=True,
        decision_summary="Declined the supplement renewal",
    )
    sent = NormalizedEmail(
        id="msg1", source="gmail", from_addr="mgandal@gmail.com",
        to=["po@nih.gov"], cc=[], subject="re: supplement",
        date="2026-04-17T10:00:00Z", body="We won't be renewing.",
        labels=["SENT"], metadata={"threadId": "tid"},
    )

    with patch("email_ingest_module_under_test.requests.post") as mock_post:
        mock_post.return_value = MagicMock(status_code=200)
        result = m.run_followups_passes(
            gmail_adapter=MagicMock(),
            exchange_adapter=MagicMock(),
            new_emails=[(sent, 0.5)],
            now=datetime(2026, 4, 17, tzinfo=timezone.utc),
        )
        mock_post.assert_called_once()
        assert result["decisions_retained"] == 1


@patch.dict(os.environ, {"EMAIL_FOLLOWUPS_ENABLED": "1"})
@patch("email_ingest.followups.write_file")
@patch("email_ingest.followups.parse_file")
@patch("email_ingest.extractor.extract")
def test_dedupe_skips_second_write_same_thread(mock_extract, mock_parse, mock_write):
    import email_ingest_module_under_test as m
    from email_ingest.types import NormalizedEmail, FollowUp
    from email_ingest.extractor import ExtractionResult

    existing = FollowUp(
        kind="i-owe", who="Sarah", what="send revised methods",
        due="none", thread="gmail:tid",
        source_msg="gmail:msg0", created="2026-04-15T00:00:00Z",
        status="open",
    )
    mock_parse.return_value = [existing]
    mock_extract.return_value = ExtractionResult(
        kind="i-owe", who="Sarah", what="send the revised methods",
        due="none", significant=False, decision_summary="",
    )
    sent = NormalizedEmail(
        id="msg1", source="gmail", from_addr="mgandal@gmail.com",
        to=["sarah@gmail.com"], cc=[], subject="re",
        date="2026-04-17T10:00:00Z", body="ok",
        labels=["SENT"], metadata={"threadId": "tid"},
    )

    m.run_followups_passes(
        gmail_adapter=MagicMock(),
        exchange_adapter=MagicMock(),
        new_emails=[(sent, 0.5)],
        now=datetime(2026, 4, 17, tzinfo=timezone.utc),
    )
    # write_file called, but with the original items only (dedupe skipped the new one)
    write_args, _ = mock_write.call_args
    written = write_args[1]
    assert len(written) == 1
    assert written[0].source_msg == "gmail:msg0"  # unchanged
