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
import base64
import email as _email
import importlib.util
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("backfill-attachments")

MIGRATE_USER = "mikejg1838@gmail.com"
_MIGRATE_PATH = Path(__file__).resolve().parent / "email-migrate.py"

# Default backfill scope. The migration ledger holds ~13,291 .partial.emlx
# across all 12 Penn folders (Archive ~8,729, Sent Items ~4,280); a default
# run must NOT touch those. Only Inbox + Inbox/PennWide (~253 partials) are
# in scope by default. --folder <name> overrides this to one named folder.
DEFAULT_SCOPE_FOLDERS = ("Inbox", "Inbox/PennWide")


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


def repair_one(service, label_id, reinflated_bytes, old_message,
               _import_raises=None):
    """Import-first repair of one WOULD_REPAIR message.

    1. messages.import the reinflated rfc822, labelIds = folder label +
       user labels copied from the old body-only message.
    2. messages.get the new id, verify it has attachment parts.
    3. Only if verify passes: messages.trash the old body-only copy.

    On any failure before step 3, the old copy is left untouched — worst
    case is a harmless duplicate, never data loss.

    `_import_raises` is a test-only hook to simulate an import exception.

    Returns "REPAIRED", "REPAIRED_TRASH_FAILED", or "IMPORT_FAILED".
    """
    # Compose labelIds: folder label + user labels from the old copy.
    # Drop Gmail system labels that import sets itself or that don't
    # transfer meaningfully.
    skip_labels = {"UNREAD", "TRASH", "SPAM", "INBOX", "SENT", "DRAFT"}
    old_labels = [l for l in (old_message.get("labelIds") or [])
                  if l not in skip_labels]
    label_ids = list(dict.fromkeys([label_id] + old_labels))

    raw = base64.urlsafe_b64encode(reinflated_bytes).decode("ascii")
    body = {"raw": raw, "labelIds": label_ids}

    try:
        if _import_raises is not None:
            raise _import_raises
        result = (
            service.users().messages()
            .import_(userId="me", body=body,
                     internalDateSource="dateHeader", neverMarkSpam=True)
            .execute()
        )
    except Exception as e:
        log.warning("  import failed for old id %s: %s",
                    old_message.get("id"), e)
        return "IMPORT_FAILED"

    new_id = result.get("id")
    if not new_id:
        log.warning("  import returned no id for old id %s; leaving old "
                    "copy intact", old_message.get("id"))
        return "IMPORT_FAILED"
    # Verify the new message actually has attachments.
    try:
        new_msg = (
            service.users().messages()
            .get(userId="me", id=new_id, format="full")
            .execute()
        )
    except Exception as e:
        log.warning("  verify get failed for new id %s: %s", new_id, e)
        return "IMPORT_FAILED"

    if not message_has_attachments(new_msg):
        log.warning("  verify failed: imported msg %s has no attachments; "
                    "leaving old copy %s intact", new_id, old_message.get("id"))
        return "IMPORT_FAILED"

    # Verified — safe to trash the old body-only copy. If the trash itself
    # fails, the import already succeeded: a recoverable duplicate now
    # exists (a later run classifies it WOULD_REPAIR_TRASH_ONLY). Return a
    # distinct outcome so the caller logs it and continues the batch
    # instead of aborting on one transient trash error.
    try:
        service.users().messages().trash(
            userId="me", id=old_message["id"]
        ).execute()
    except Exception as e:
        log.warning("  trash failed for old id %s after a verified import "
                    "(duplicate left for re-run): %s",
                    old_message.get("id"), e)
        return "REPAIRED_TRASH_FAILED"
    return "REPAIRED"


@dataclass
class Candidate:
    """One backfill candidate: a pre-fix .partial.emlx and its lookup keys."""
    folder: str
    basename: str
    label_id: str
    bare_mid: str
    reinflated_bytes: bytes
    reinflated_has_attachments: bool


def trash_only(service, body_only_message):
    """Trash a leftover body-only copy (WOULD_REPAIR_TRASH_ONLY bucket).

    Used when a prior --execute imported the attachment copy but failed to
    trash the body-only original. Returns "REPAIRED" or "IMPORT_FAILED".
    """
    try:
        service.users().messages().trash(
            userId="me", id=body_only_message["id"]
        ).execute()
        return "REPAIRED"
    except Exception as e:
        log.warning("  trash-only failed for id %s: %s",
                    body_only_message.get("id"), e)
        return "IMPORT_FAILED"


# All buckets the report tracks.
BUCKETS = [
    "WOULD_REPAIR", "WOULD_REPAIR_TRASH_ONLY", "ALREADY_DONE", "MISSING",
    "AMBIGUOUS", "SKIP_NO_ATTACHMENTS", "SKIP_TOO_LARGE", "IMPORT_FAILED",
    "REPAIRED_TRASH_FAILED",
]


def run_backfill(service, candidates, execute, rate_limit_s=0.3):
    """Classify and (if execute) repair each candidate.

    Returns a dict of bucket -> count. In dry-run (execute=False) it
    classifies and counts but performs no import/trash.

    Raising GmailLimitReached propagates to the caller (main), which stops
    cleanly — partial progress is fine because re-runs are idempotent.
    """
    counts = {b: 0 for b in BUCKETS}
    # Count accounting: in DRY-RUN every candidate lands in exactly one
    # bucket (the classify bucket), so the bucket sum == candidate count.
    # In EXECUTE mode WOULD_REPAIR / WOULD_REPAIR_TRASH_ONLY count only
    # SUCCESSES — a candidate whose repair_one returns IMPORT_FAILED moves
    # to the IMPORT_FAILED bucket instead. So execute-mode WOULD_REPAIR can
    # be lower than the dry-run WOULD_REPAIR; the difference is in
    # IMPORT_FAILED. REPAIRED_TRASH_FAILED additionally double-counts (the
    # WOULD_REPAIR bucket AND REPAIRED_TRASH_FAILED both increment) because
    # the import succeeded but a recoverable duplicate was left.

    for cand in candidates:
        if not cand.reinflated_has_attachments:
            counts["SKIP_NO_ATTACHMENTS"] += 1
            continue

        copies = find_gmail_copies(service, cand.label_id, cand.bare_mid)
        bucket = classify(copies)

        if not execute or bucket in ("ALREADY_DONE", "MISSING", "AMBIGUOUS"):
            counts[bucket] += 1
            if bucket == "MISSING":
                log.info("  MISSING (no Gmail copy): %s/%s",
                         cand.folder, cand.basename)
            continue

        # execute mode, actionable bucket
        if bucket == "WOULD_REPAIR":
            body_only = [m for m in copies
                         if not message_has_attachments(m)][0]
            outcome = repair_one(service, cand.label_id,
                                 cand.reinflated_bytes, body_only)
        elif bucket == "WOULD_REPAIR_TRASH_ONLY":
            body_only = [m for m in copies
                         if not message_has_attachments(m)][0]
            outcome = trash_only(service, body_only)
        else:
            outcome = None

        if outcome == "REPAIRED":
            counts[bucket] += 1
        elif outcome == "REPAIRED_TRASH_FAILED":
            # import+verify succeeded; a recoverable duplicate was left.
            # Count the bucket as actioned AND record the trash failure.
            counts[bucket] += 1
            counts["REPAIRED_TRASH_FAILED"] += 1
        elif outcome == "IMPORT_FAILED":
            counts["IMPORT_FAILED"] += 1

        if rate_limit_s:
            time.sleep(rate_limit_s)

    return counts


def _rfc822_has_attachment(rfc822_bytes):
    """True if the rfc822 message has a MIME part with a non-empty
    attachment payload (filename + decoded bytes)."""
    try:
        msg = _email.message_from_bytes(rfc822_bytes)
    except Exception:
        return False
    for part in msg.walk():
        if part.get_filename() and (part.get_payload(decode=True) or b""):
            return True
    return False


def _rfc822_message_id(rfc822_bytes):
    """Read the Message-ID header straight from the rfc822 bytes.

    The backfill resolves the Gmail copy by rfc822msgid, so the id must come
    from the same bytes about to be (re)imported — parsing the header here
    keeps that single source of truth instead of trusting a sidecar value.
    """
    try:
        msg = _email.message_from_bytes(rfc822_bytes)
    except Exception:
        return None
    return msg.get("Message-ID")


def build_candidates(em, emlx_index, state, uploader, folder_filter):
    """Build the list of Candidate objects from the migration ledger.

    Only `.partial.emlx` files are candidates (full .emlx never had stubs).
    Resolves each basename to a full disk path via emlx_index, runs
    parse_emlx (attachment-aware), and resolves the folder's Gmail label.

    Folder scope: when `folder_filter` is None the scan is restricted to
    `DEFAULT_SCOPE_FOLDERS` (Inbox + Inbox/PennWide, ~253 partials) — the
    other Penn folders (Archive, Sent Items, etc.) are out of scope for a
    default run. A non-None `folder_filter` overrides this to that one
    named folder, which may be any folder including a normally-out-of-scope
    one.
    """
    candidates = []
    if folder_filter:
        in_scope = {folder_filter}
        if folder_filter not in state.get("folders", {}):
            log.warning("--folder %r is not a known ledger folder; "
                        "0 candidates will be found.", folder_filter)
    else:
        in_scope = set(DEFAULT_SCOPE_FOLDERS)
    for folder, fstate in state.get("folders", {}).items():
        if folder not in in_scope:
            continue
        label_name = em.folder_to_label(folder)
        label_id = uploader._ensure_label(label_name)
        folder_index = emlx_index.get(folder, {})
        for basename in fstate.get("migrated_files", []):
            if ".partial." not in basename:
                continue
            full_path = folder_index.get(basename)
            if full_path is None:
                log.warning("  %s/%s in ledger but not on disk — skipping",
                            folder, basename)
                continue
            parsed = em.parse_emlx(full_path)
            if parsed is None:
                log.warning("  parse_emlx failed for %s/%s", folder, basename)
                continue
            rfc822, _is_read, _ts = parsed
            mid = strip_message_id(_rfc822_message_id(rfc822))
            if not mid:
                log.warning("  no Message-ID for %s/%s — skipping",
                            folder, basename)
                continue
            candidates.append(Candidate(
                folder=folder,
                basename=basename,
                label_id=label_id,
                bare_mid=mid,
                reinflated_bytes=rfc822,
                reinflated_has_attachments=_rfc822_has_attachment(rfc822),
            ))
    return candidates


def _print_report(counts, execute):
    """Print the bucket-count report.

    WOULD_REPAIR and IMPORT_FAILED are printed adjacently: in execute mode
    a WOULD_REPAIR candidate that fails import moves to IMPORT_FAILED, so
    the two together explain any shrink vs. the dry-run WOULD_REPAIR count.
    """
    mode = "EXECUTE" if execute else "DRY RUN"
    log.info("")
    log.info("=== Backfill report (%s) ===", mode)
    for bucket in BUCKETS:
        log.info("  %-26s %d", bucket, counts.get(bucket, 0))
    log.info("")
    if not execute and counts.get("WOULD_REPAIR", 0):
        log.info("Re-run with --execute to repair %d message(s).",
                 counts["WOULD_REPAIR"])
    if counts.get("MISSING", 0):
        log.info("NOTE: %d message(s) have no Gmail copy at all — these are "
                 "migration gaps, not backfill candidates.", counts["MISSING"])


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description="Penn email attachment backfill")
    parser.add_argument("--execute", action="store_true",
                        help="Perform the repair (default: dry-run report)")
    parser.add_argument("--folder", default=None,
                        help="Restrict to one folder (e.g. Inbox)")
    args = parser.parse_args()

    try:
        em = _load_migrate_module()
    except SystemExit:
        log.error("Could not load email-migrate.py (missing Gmail token?)")
        return 1

    try:
        creds = em.load_gmail_api_credentials()
        uploader = em.GmailApiUploader(creds)
        service = uploader._admin_service
        state = em.load_state()
        emlx_index = build_emlx_index(em)
        candidates = build_candidates(em, emlx_index, state, uploader,
                                      args.folder)
    except Exception as e:
        log.error("Backfill setup failed: %s", e)
        return 1
    log.info("Found %d .partial.emlx candidate(s).", len(candidates))

    try:
        counts = run_backfill(service, candidates, execute=args.execute)
    except em.GmailLimitReached as e:
        log.warning("Gmail quota reached — stopping. Re-run to resume. %s", e)
        return 0

    _print_report(counts, args.execute)
    return 0


if __name__ == "__main__":
    sys.exit(main())
