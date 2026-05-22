#!/usr/bin/env python3
"""Penn email attachment backfill.

One-shot repair: ~192 Penn .partial.emlx messages were migrated to the
backup Gmail account body-only (attachments dropped) before the reinflate
fix shipped. This script re-uploads the attachment-bearing version and
trashes the body-only copy.

Usage:
    python3 scripts/sync/backfill-attachments.py            # dry-run report
    python3 scripts/sync/backfill-attachments.py --execute  # perform repair
    python3 scripts/sync/backfill-attachments.py --folder Inbox  # one folder

See docs/superpowers/specs/2026-05-22-penn-email-attachment-backfill-design.md
"""
from __future__ import annotations

import argparse
import importlib.util
import logging
import os
import sys
import time
from pathlib import Path

log = logging.getLogger("backfill-attachments")

MIGRATE_USER = "mikejg1838@gmail.com"
_MIGRATE_PATH = Path(__file__).resolve().parent / "email-migrate.py"


def strip_message_id(mid):
    """Strip one surrounding pair of angle brackets and whitespace from a
    Message-ID.

    The Gmail `rfc822msgid:` search operator matches the bare id; passing
    the `<...>`-wrapped header value verbatim can return zero matches.
    Strips exactly one surrounding `<>` pair (RFC 5322 forbids bare `<`/`>`
    inside a msg-id, so a well-formed Message-ID has at most one pair).
    """
    if mid is None:
        return None
    mid = mid.strip()
    if mid.startswith("<") and mid.endswith(">"):
        mid = mid[1:-1].strip()
    return mid


def _load_migrate_module():
    """Import email-migrate.py as a module.

    GMAIL_MIGRATE_USER is frozen into email-migrate.py's GMAIL_USER constant
    at import time, so it MUST be set before exec_module. load_gmail_api_
    credentials() calls sys.exit(1) on a missing token — callers that import
    the module purely for its pure functions are unaffected (that only runs
    when credentials are actually loaded).
    """
    os.environ.setdefault("GMAIL_MIGRATE_USER", MIGRATE_USER)
    spec = importlib.util.spec_from_file_location("email_migrate_for_backfill", _MIGRATE_PATH)
    mod = importlib.util.module_from_spec(spec)
    saved_argv = sys.argv
    sys.argv = ["email-migrate.py"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved_argv
    return mod


def message_has_attachments(gmail_msg):
    """Return True if a Gmail messages.get(format=full) resource has a real
    attachment part: a part with a filename that carries attachment data
    (`attachmentId`, or non-zero inline `body.size`).

    Walks nested multiparts. A filename with size 0 is a stub, not a real
    attachment (this is exactly the body-only state we are repairing).
    """
    def _walk(part):
        filename = part.get("filename") or ""
        body = part.get("body") or {}
        size = body.get("size", 0) or 0
        if filename and (body.get("attachmentId") or size > 0):
            return True
        for child in part.get("parts", []) or []:
            if _walk(child):
                return True
        return False

    payload = gmail_msg.get("payload") or {}
    return _walk(payload)
