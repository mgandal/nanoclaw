#!/usr/bin/env python3
"""Train the email classifier on reply behavior.

Scans Exchange Sent Items + Gmail threads to build a personalized
classifier profile (sender/topic weights + few-shot examples).

Usage:
    python3 train-classifier.py              # Build profile from last 180 days
    python3 train-classifier.py --days 90    # Custom window
    python3 train-classifier.py --status     # Show current profile
"""

import argparse
import json
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from email_ingest.types import STATE_DIR
from email_ingest.trainer import (
    collect_exchange_data,
    collect_gmail_data,
    balance_dataset,
    build_profile,
    save_profile,
    PROFILE_FILE,
    TRAINING_DATA_FILE,
    MIN_DATASET_SIZE,
    TrainingExample,
)
from dataclasses import asdict

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("train-classifier")


def show_status():
    """Print current profile status."""
    if not PROFILE_FILE.exists():
        print("No classifier profile found.")
        print(f"Run: python3 train-classifier.py")
        return

    profile = json.loads(PROFILE_FILE.read_text())
    print(f"Profile version:    {profile.get('version')}")
    print(f"Generated:          {profile.get('generated_at')}")
    print(f"Dataset size:       {profile.get('dataset_size')}")
    print(f"Baseline reply rate: {profile.get('baseline_reply_rate')}")
    print(f"Sender weights:     {len(profile.get('sender_weights', {}))}")
    print(f"Topic weights:      {len(profile.get('topic_weights', {}))}")
    print(f"Few-shot examples:  {len(profile.get('few_shot_examples', []))}")
    print()

    stats = profile.get("stats", {})
    print(f"Exchange examples:  {stats.get('exchange_examples', 0)}")
    print(f"Gmail examples:     {stats.get('gmail_examples', 0)}")
    print(f"Total replied:      {stats.get('total_replied', 0)}")
    print(f"Total ignored:      {stats.get('total_ignored', 0)}")
    print()

    print("Top sender weights:")
    sw = profile.get("sender_weights", {})
    for domain in sorted(sw, key=lambda d: sw[d]["weight"], reverse=True)[:10]:
        w = sw[domain]
        print(f"  {domain:30s}  weight={w['weight']:+.3f}  ({w['replied']}/{w['total']} replied)")

    print()
    print("Topic weights:")
    tw = profile.get("topic_weights", {})
    for topic in sorted(tw, key=lambda t: tw[t]["weight"], reverse=True):
        w = tw[topic]
        print(f"  {topic:20s}  weight={w['weight']:+.3f}  ({w['replied']}/{w['total']} replied)")


def main():
    parser = argparse.ArgumentParser(description="Train email classifier on reply behavior")
    parser.add_argument("--days", type=int, default=180, help="Training window in days (default: 180)")
    parser.add_argument("--status", action="store_true", help="Show current profile")
    args = parser.parse_args()

    if args.status:
        show_status()
        return

    log.info("Collecting training data (last %d days)...", args.days)

    exchange = collect_exchange_data(days=args.days)
    log.info("Exchange: %d examples (%d replied)",
             len(exchange), sum(1 for e in exchange if e.replied))

    gmail = collect_gmail_data(days=args.days)
    log.info("Gmail: %d examples (%d replied)",
             len(gmail), sum(1 for e in gmail if e.replied))

    combined = balance_dataset(exchange, gmail)
    log.info("Combined dataset: %d examples (target: 2/3 exchange, 1/3 gmail)",
             len(combined))

    if len(combined) < MIN_DATASET_SIZE:
        log.warning("Dataset too small (%d < %d). Need more email history.", len(combined), MIN_DATASET_SIZE)
        sys.exit(1)

    # Save raw training data for debugging
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    TRAINING_DATA_FILE.write_text(json.dumps([asdict(e) for e in combined], indent=2))
    log.info("Training data saved to %s", TRAINING_DATA_FILE)

    profile = build_profile(combined)
    if not profile:
        log.error("Profile generation failed")
        sys.exit(1)

    save_profile(profile)
    log.info("Done! Profile has %d sender weights, %d topic weights, %d few-shot examples",
             len(profile["sender_weights"]),
             len(profile["topic_weights"]),
             len(profile["few_shot_examples"]))


if __name__ == "__main__":
    main()
