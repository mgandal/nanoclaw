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

# Add parent dir to path so email_ingest package is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from email_ingest.types import IngestState, STATE_DIR, LOG_FILE
from email_ingest.gmail_adapter import GmailAdapter
from email_ingest.exchange_adapter import ExchangeAdapter
from email_ingest.classifier import should_fast_skip, classify_email
from email_ingest.exporter import export_email, retain_in_hindsight

RELEVANCE_THRESHOLD = float(os.environ.get("EMAIL_INGEST_THRESHOLD", "0.3"))
HINDSIGHT_THRESHOLD = 0.7
HINDSIGHT_URL = os.environ.get("HINDSIGHT_URL", "http://localhost:8889")


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

            if result.relevance >= RELEVANCE_THRESHOLD:
                export_email(email, result)
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

    state.stats = stats
    state.save()

    log.info(
        "Done: fetched=%d classified=%d skipped=%d exported=%d hindsight=%d",
        stats["total_fetched"], stats["classified"], stats["fast_skipped"],
        stats["exported"], stats["hindsight_retained"],
    )
    return stats


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
