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


def build_emlx_index(em):
    """Build {folder_path: {basename: full_Path}} from discover_folders().

    discover_folders() returns a sorted list of
    [(folder_path_str, mbox_dir_Path, [emlx_full_Path, ...])]. The backfill
    resolves ledger basenames to full paths because parse_emlx needs the
    full path to find the sibling Attachments/ sidecar dir.

    Mac Mail .emlx basenames are the message UID — folder-unique in
    practice (verified: 0 collisions across the live Penn mailbox). The
    collision check below is a loud guard: if two distinct paths ever
    share a basename within one folder, that breaks the basename->path
    contract this index depends on, and we must not silently drop one.
    """
    index = {}
    for folder_path, _mbox_dir, emlx_files in em.discover_folders():
        folder = {}
        for p in emlx_files:
            existing = folder.get(p.name)
            if existing is not None and existing != p:
                raise ValueError(
                    f"emlx basename collision in {folder_path!r}: "
                    f"{existing} vs {p} — basename->path index is unsafe"
                )
            folder[p.name] = p
        index[folder_path] = folder
    return index


def find_gmail_copies(service, label_id, bare_message_id):
    """Return the list of full Gmail message resources whose RFC822
    Message-ID matches `bare_message_id`, scoped to `label_id`.

    Uses q="rfc822msgid:..." (AND-combined with labelIds). includeSpamTrash
    is passed explicitly as False — a body-only copy we want to repair lives
    on the label, not in Trash; this exclusion is load-bearing for the
    caller's match-gate, so it is not left to an API default.
    """
    query = f"rfc822msgid:{bare_message_id}"
    resp = (
        service.users().messages()
        .list(userId="me", q=query, labelIds=[label_id], maxResults=100,
              includeSpamTrash=False)
        .execute()
    )
    if resp.get("nextPageToken"):
        raise RuntimeError(
            f"find_gmail_copies: >100 matches for {bare_message_id!r} — "
            "the caller's exact-count gate cannot be trusted"
        )
    stubs = resp.get("messages", []) or []
    copies = []
    for stub in stubs:
        msg = (
            service.users().messages()
            .get(userId="me", id=stub["id"], format="full")
            .execute()
        )
        copies.append(msg)
    return copies


def classify(gmail_copies):
    """Classify one candidate message into a repair bucket.

    gmail_copies: list of full Gmail message resources matching the
      message's rfc822msgid on the folder label.

    The caller decides SKIP_NO_ATTACHMENTS (the local .emlx has no
    recoverable attachments) before ever calling classify — so classify
    only reasons about the Gmail-side state.

    Returns one of: MISSING, WOULD_REPAIR, WOULD_REPAIR_TRASH_ONLY,
    ALREADY_DONE, AMBIGUOUS.
    """
    if not gmail_copies:
        return "MISSING"

    body_only = [m for m in gmail_copies if not message_has_attachments(m)]
    with_attach = [m for m in gmail_copies if message_has_attachments(m)]

    if not body_only:
        # Every copy already has attachments.
        return "ALREADY_DONE"

    if len(body_only) == 1 and with_attach:
        # One body-only copy + at least one attachment-bearing copy:
        # a prior --execute imported but did not finish trashing.
        return "WOULD_REPAIR_TRASH_ONLY"

    if len(body_only) == 1 and not with_attach:
        return "WOULD_REPAIR"

    # 2+ body-only copies — unclear which (if any) to trash; manual review.
    return "AMBIGUOUS"
