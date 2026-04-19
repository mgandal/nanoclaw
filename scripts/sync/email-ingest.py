#!/usr/bin/env python3
"""Passive email knowledge ingestion — classify, summarize, export to QMD.

Usage:
    python3 email-ingest.py                 # Incremental (since last run)
    python3 email-ingest.py --backfill 180  # Seed last 180 days
    python3 email-ingest.py --status        # Show state
    python3 email-ingest.py --exchange-batch-size 50  # Limit Exchange per run
"""

import argparse
import logging
import os
import sys
import time

import requests

# Add parent dir to path so email_ingest package is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from email_ingest.types import IngestState, STATE_DIR, LOG_FILE, FollowUp, FOLLOWUPS_FILE
from email_ingest.gmail_adapter import GmailAdapter
from email_ingest.exchange_adapter import ExchangeAdapter
from email_ingest.classifier import should_fast_skip, classify_email
from email_ingest.exporter import export_email, retain_in_hindsight
import email_ingest.followups as _followups_mod
import email_ingest.extractor as _extractor_mod
import email_ingest.closure as _closure_mod
import email_ingest.aging as _aging_mod

RELEVANCE_THRESHOLD = float(os.environ.get("EMAIL_INGEST_THRESHOLD", "0.3"))
HINDSIGHT_THRESHOLD = 0.7
HINDSIGHT_URL = os.environ.get("HINDSIGHT_URL", "http://localhost:8889")

FOLLOWUP_GMAIL_SENDER = "mgandal@gmail.com"


def _setup_logging():
    """Configure logging to stderr + file (if state dir exists)."""
    handlers = [logging.StreamHandler()]
    if STATE_DIR.exists():
        handlers.append(logging.FileHandler(LOG_FILE, mode="a"))

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )


log = logging.getLogger("email-ingest")


def run_ingest(state: IngestState, backfill_days: int | None, exchange_batch: int):
    """Main ingestion loop."""
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)

    stats = {
        "total_fetched": 0, "classified": 0, "fast_skipped": 0,
        "exported": 0, "hindsight_retained": 0,
    }
    all_classified = []

    # --- Gmail ---
    gmail_epoch = state.last_gmail_epoch or state.default_epoch()
    if backfill_days:
        gmail_epoch = state.default_epoch(backfill_days)

    gmail_exported = 0
    gmail_fetched = 0
    gmail = GmailAdapter()
    if gmail.connect():
        processed = set(state.processed_gmail_ids)
        try:
            emails = gmail.fetch_since(gmail_epoch, processed)
        except Exception as e:
            log.error("Gmail fetch failed: %s", e)
            emails = []
        gmail_fetched = len(emails)
        stats["total_fetched"] += gmail_fetched

        for email in emails:
            skip = should_fast_skip(email)
            if skip:
                stats["fast_skipped"] += 1
                log.debug("Fast-skip %s: %s (%s)", email.source, email.subject[:50], skip)
                state.processed_gmail_ids.append(email.id)
                continue

            result = classify_email(email)
            stats["classified"] += 1

            if result.skip_reason:
                log.warning("Classification failed for %s: %s", email.id, result.skip_reason)
                # Do NOT mark as processed — retry on next run
                continue

            state.processed_gmail_ids.append(email.id)
            all_classified.append((email, result.relevance))

            if result.relevance >= RELEVANCE_THRESHOLD:
                export_email(email, result, downloader=gmail.download_attachment)
                stats["exported"] += 1
                gmail_exported += 1
                log.info("Exported [%.2f] %s: %s", result.relevance, email.source, email.subject[:60])

                if result.relevance >= HINDSIGHT_THRESHOLD:
                    retain_in_hindsight(email, result, HINDSIGHT_URL)
                    stats["hindsight_retained"] += 1
            else:
                log.debug("Below threshold [%.2f] %s: %s", result.relevance, email.source, email.subject[:60])

        # Advance epoch only if exports happened OR zero new emails fetched
        if gmail_exported > 0 or gmail_fetched == 0:
            state.last_gmail_epoch = int(time.time())
    else:
        log.warning("Gmail adapter failed to connect — skipping Gmail")

    # --- Exchange ---
    exchange_epoch = state.last_exchange_epoch or state.default_epoch()
    if backfill_days:
        exchange_epoch = state.default_epoch(backfill_days)

    exchange_exported = 0
    exchange_fetched = 0
    exchange = ExchangeAdapter(batch_limit=exchange_batch)
    if exchange.is_available():
        processed = set(state.processed_exchange_ids)
        emails = exchange.fetch_since(exchange_epoch, processed)
        exchange_fetched = len(emails)
        stats["total_fetched"] += exchange_fetched

        for email in emails:
            skip = should_fast_skip(email)
            if skip:
                stats["fast_skipped"] += 1
                state.processed_exchange_ids.append(email.id)
                continue

            result = classify_email(email)
            stats["classified"] += 1

            if result.skip_reason:
                log.warning("Classification failed for %s: %s", email.id, result.skip_reason)
                continue

            state.processed_exchange_ids.append(email.id)
            all_classified.append((email, result.relevance))

            if result.relevance >= RELEVANCE_THRESHOLD:
                export_email(email, result)
                stats["exported"] += 1
                exchange_exported += 1
                log.info("Exported [%.2f] %s: %s", result.relevance, email.source, email.subject[:60])

                if result.relevance >= HINDSIGHT_THRESHOLD:
                    retain_in_hindsight(email, result, HINDSIGHT_URL)
                    stats["hindsight_retained"] += 1

        if exchange_exported > 0 or exchange_fetched == 0:
            state.last_exchange_epoch = int(time.time())
    else:
        log.warning("Exchange adapter not available — skipping Exchange")

    # --- Follow-ups pipeline (gated by EMAIL_FOLLOWUPS_ENABLED=1) ---
    try:
        fu_stats = run_followups_passes(gmail, exchange, new_emails=all_classified)
        if not fu_stats.get("skipped"):
            for k, v in fu_stats.items():
                stats[k] = v
            log.info(
                "followups: closed=%d aged=%d commitments=%d asks=%d decisions=%d",
                fu_stats.get("followups_closed", 0),
                fu_stats.get("followups_aged", 0),
                fu_stats.get("commitments_added", 0),
                fu_stats.get("asks_added", 0),
                fu_stats.get("decisions_retained", 0),
            )
    except Exception as e:
        log.warning("Follow-ups pipeline failed (non-fatal): %s", e)

    state.stats = stats
    state.save()

    log.info(
        "Done: fetched=%d classified=%d skipped=%d exported=%d hindsight=%d",
        stats["total_fetched"], stats["classified"], stats["fast_skipped"],
        stats["exported"], stats["hindsight_retained"],
    )
    return stats


def _direction_for(email):
    """Return 'sent' | 'received' | None (skip)."""
    if email.source == "gmail":
        from_addr = email.from_addr.lower()
        if FOLLOWUP_GMAIL_SENDER in from_addr:
            return "sent"
        return "received"
    if email.source == "exchange":
        if email.metadata.get("is_sent") or email.metadata.get("mailbox") == "Sent Items":
            return "sent"
        return "received"
    return None


def _email_qualifies_for_extraction(email, relevance):
    """Return direction to extract with, or None to skip."""
    direction = _direction_for(email)
    if direction is None:
        return None
    if email.source == "gmail" and "mikejg1838" in email.from_addr.lower():
        return None
    if direction == "sent":
        return "sent"
    if relevance >= 0.7:
        return "received"
    return None


def _ext_to_followup(email, r):
    if r.kind not in ("i-owe", "they-owe-me"):
        return None
    thread_src = email.source
    thread_id = email.metadata.get("threadId") or email.metadata.get("conversationId") or email.id
    return FollowUp(
        kind=r.kind,
        who=r.who or email.from_addr,
        what=r.what,
        due=r.due or "none",
        thread=f"{thread_src}:{thread_id}",
        source_msg=f"{thread_src}:{email.id}",
        created=email.date,
        status="open",
    )


def _retain_decision(email, r):
    """Retain a decision to Hindsight. Fire-and-forget; returns 1 on send attempted."""
    hindsight_url = os.environ.get("HINDSIGHT_URL", "http://localhost:8889")
    date_slug = email.date[:10] if email.date else "unknown-date"
    who_slug = (r.who or "unknown").replace(" ", "-").lower()[:40]
    doc_id = f"decision-{date_slug}-{who_slug}"
    content = (
        f"Decision: {r.decision_summary}\n\n"
        f"Subject: {email.subject}\n"
        f"Thread: {email.source}:{email.metadata.get('threadId', email.id)}\n"
        f"Excerpt: {email.body[:500]}"
    )
    try:
        resp = requests.post(
            f"{hindsight_url}/retain",
            json={
                "bank": "hermes",
                "content": content,
                "metadata": {
                    "source": "email-ingest-decision",
                    "document_id": doc_id,
                    "message_id": email.id,
                    "kind": "decision",
                },
            },
            timeout=10,
        )
        resp.raise_for_status()
        return 1
    except Exception as e:
        log.debug("Decision retain failed (non-blocking): %s", e)
        return 0


def run_followups_passes(
    gmail_adapter,
    exchange_adapter,
    new_emails=None,
    now=None,
):
    """Run closure → aging → extraction → write in sequence.
    No-op unless EMAIL_FOLLOWUPS_ENABLED=1.
    new_emails is a list of (email, relevance) produced by the main ingest loop."""
    if os.environ.get("EMAIL_FOLLOWUPS_ENABLED") != "1":
        return {"skipped": True}

    from datetime import datetime, timezone
    if now is None:
        now = datetime.now(timezone.utc)
    new_emails = new_emails or []

    items = _followups_mod.parse_file(FOLLOWUPS_FILE)

    items, closed_count = _closure_mod.apply_closure(items, gmail_adapter, exchange_adapter, now=now)
    items, aged_count = _aging_mod.apply_aging(items, now=now)

    commitments_added = 0
    asks_added = 0
    decisions_retained = 0

    for email, relevance in new_emails:
        direction = _email_qualifies_for_extraction(email, relevance)
        if direction is None:
            continue
        result = _extractor_mod.extract(email, direction=direction)
        if result is None:
            continue
        if result.significant and direction == "sent":
            decisions_retained += _retain_decision(email, result)
        fu = _ext_to_followup(email, result)
        if fu is None:
            continue
        if any(_followups_mod.is_duplicate(fu, existing) for existing in items):
            continue
        items.append(fu)
        if fu.kind == "i-owe":
            commitments_added += 1
        else:
            asks_added += 1

    _followups_mod.write_file(FOLLOWUPS_FILE, items)

    return {
        "followups_closed": closed_count,
        "followups_aged": aged_count,
        "commitments_added": commitments_added,
        "asks_added": asks_added,
        "decisions_retained": decisions_retained,
    }


def show_status(state: IngestState):
    """Print current state."""
    from datetime import datetime
    print(f"Last run:           {state.last_run or 'never'}")
    print(f"Gmail epoch:        {datetime.fromtimestamp(state.last_gmail_epoch) if state.last_gmail_epoch else 'not set'}")
    print(f"Exchange epoch:     {datetime.fromtimestamp(state.last_exchange_epoch) if state.last_exchange_epoch else 'not set'}")
    print(f"Gmail IDs tracked:  {len(state.processed_gmail_ids)}")
    print(f"Exchange IDs tracked: {len(state.processed_exchange_ids)}")
    if state.stats:
        print(f"Last run stats:     {state.stats}")


def main():
    parser = argparse.ArgumentParser(description="Passive email knowledge ingestion")
    parser.add_argument("--backfill", type=int, metavar="DAYS",
                        help="Backfill last N days (overrides epoch)")
    parser.add_argument("--status", action="store_true", help="Show state and exit")
    parser.add_argument("--exchange-batch-size", type=int, default=100,
                        help="Max Exchange emails per run (default: 100)")
    args = parser.parse_args()

    _setup_logging()
    state = IngestState.load()

    if args.status:
        show_status(state)
        return

    log.info("Starting email ingest (backfill=%s, exchange_batch=%d)",
             args.backfill, args.exchange_batch_size)
    run_ingest(state, args.backfill, args.exchange_batch_size)


if __name__ == "__main__":
    main()
