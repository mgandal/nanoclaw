# Penn Email Attachment Backfill — Design

**Date:** 2026-05-22
**Status:** Approved (brainstorming complete, 3-reviewer audit applied)
**Author:** Claude Code session

## Problem

`scripts/sync/email-migrate.py` migrates Penn Exchange email from Mac Mail's
on-disk `.emlx` files to a backup Gmail account (`mikejg1838@gmail.com`).

Before commit `0844e5b4` (2026-05-21), the migration uploaded Apple Mail
`.partial.emlx` files body-only: Mac Mail stores Exchange attachments in a
sidecar `Attachments/<msgnum>/<part_dir>/<filename>` directory, not inline,
and the migration read only the `.emlx` byte range. The attachment-fix
(`reinflate_apple_stub_attachments`, shipped `0844e5b4`..`85072d20`) now
inlines those attachments — but only for newly-arriving mail. The
~192 Penn INBOX `.partial.emlx` files migrated *before* the fix are in
Gmail as body-only copies, and the migration ledger
(`~/.cache/email-migrate/email-migration.json`) marks them `migrated`, so
the recurring sync will never re-upload them.

This backfill is a one-shot repair: for each pre-fix `.partial.emlx`,
re-upload the attachment-bearing version and remove the body-only copy.

## Scope

- **In scope:** a standalone one-shot script that repairs the
  already-migrated `.partial.emlx` messages in the **`Inbox` and
  `Inbox/PennWide` folders only** (~253 partials, of which ~192 have
  recoverable attachments) whose attachments were dropped.
- **In scope:** a lightweight regression canary in `sync-health-check.sh`
  that flags if a freshly-migrated `.partial.emlx` ever uploads body-only
  again (verifies the shipped fix stays working).
- **Out of scope:** the other 10 Penn folders. The migration ledger holds
  ~13,291 `.partial.emlx` across all folders — `Archive` (8,729),
  `Sent Items` (4,280), and small `Archive/*` subfolders. A `.partial.emlx`
  means Mac Mail did a *partial download*, not necessarily that an
  attachment was dropped; many old Archive/Sent partials never had their
  sidecar bytes downloaded and would bucket `MISSING`/`SKIP_NO_ATTACHMENTS`.
  Backfilling those is a deliberately-separate, larger-blast-radius decision
  (a 2+ hour dry-run, multi-day quota windows, trash/re-import across the
  whole Penn archive). The script supports `--folder <name>` so any folder
  can be targeted later, but the **default scope is `Inbox` + `Inbox/PennWide`**.
- **Out of scope:** wiring the backfill into the recurring `sync-all.sh`
  (it is run once, manually). No cron, no recurring monitor.
- **Out of scope:** non-Penn accounts. `email-migrate.py` only reads the
  Penn Exchange Mac Mail account (`EF7AC40E-...`); the backfill inherits
  that scope.

## Architecture

A new script `scripts/sync/backfill-attachments.py`, modeled on
`email-migrate.py` conventions:

- Same `STATE_DIR` (`~/.cache/email-migrate/`), same Gmail credential
  loading, same `--dry-run` (default) / `--execute` flag style.
- Imports and reuses from `email-migrate.py`: `parse_emlx` (attachment-
  aware), `extract_message_id`, `folder_to_label`, `discover_folders`,
  `GmailApiUploader`, `load_gmail_api_credentials`, the
  `GmailLimitReached` exception, and the `SIZE_CAP_ERROR_MARKER` constant.
- New logic only: locate-body-only-copy-by-Message-ID, the import →
  verify → trash sequence, and report generation.

### Import-time requirements (from codebase audit C6, C1)

`email-migrate.py` freezes `GMAIL_USER` from `os.environ["GMAIL_MIGRATE_USER"]`
at import time. The backfill MUST set
`os.environ["GMAIL_MIGRATE_USER"] = "mikejg1838@gmail.com"` *before*
`importlib` loads the module, or credential resolution fails.
`load_gmail_api_credentials()` calls `sys.exit(1)` on missing token — the
backfill wraps the import/credential-load in a `try/except SystemExit` to
fail with a clear message.

Importing the module registers SIGINT/SIGTERM handlers (sets the shared
`_shutdown_event`). This is desirable — Ctrl-C cancels the backfill
gracefully mid-run.

## Core algorithm

Candidate enumeration is restricted to the in-scope folders: with no
`--folder` argument, `build_candidates` iterates **only** the `Inbox` and
`Inbox/PennWide` ledger entries. `--folder <name>` overrides this to a
single named folder. The ledger's other 10 folders are never scanned by
default — this is the load-bearing scope guard (a default run must not
touch the ~13k Archive/Sent partials).

Per `.partial.emlx` file listed in `state["folders"][folder]["migrated_files"]`
(for an in-scope folder):

1. **Resolve full path.** Reuse `discover_folders()` to build a
   `{folder: {basename: full_Path}}` index. Basenames alone cannot locate
   the Apple sidecar dir, and the folder→disk mapping is non-deterministic
   (opaque 36-char UUID subdirs). `discover_folders()` returns full
   `Path` objects.

2. **Reinflate check.** Run `parse_emlx()` (attachment-aware). Parse the
   result; if zero MIME parts have a non-empty attachment payload, the
   message never had recoverable attachments → bucket `SKIP_NO_ATTACHMENTS`.

3. **Locate body-only copy.** `extract_message_id()` returns the header
   *with* angle brackets; strip them. Query:
   `messages.list(userId="me", q=f"rfc822msgid:{mid_stripped}",
   labelIds=[folder_label], includeSpamTrash=False)`.
   `q` and `labelIds` are AND-combined. Default `includeSpamTrash=false`
   means Trash is excluded — intentional here (see Re-run safety).

4. **Match gate.** Three buckets:
   - **0 matches** → bucket `MISSING`. The message exists nowhere in
     Gmail (under that label). This is a real migration gap, NOT a
     backfill candidate. Report separately so the user knows N messages
     need a full re-migration.
   - **exactly 1 match** → inspect it (step 5).
   - **2+ matches** → inspect all (step 5a).

5. **Single-match idempotency.** `messages.get` the match. If it already
   has attachment parts → bucket `ALREADY_DONE`, skip. Else → bucket
   `WOULD_REPAIR` (the body-only copy to replace).

5a. **Multi-match resolution.** `messages.get` each of the 2+ matches.
   - If exactly one is body-only and the rest already have attachments:
     this is a re-run after a prior `--execute` that imported but failed
     to trash. Bucket `WOULD_REPAIR_TRASH_ONLY` — trash the body-only
     copy, do NOT re-import (the attachment copy already exists).
   - If 2+ are body-only, or the shape is otherwise unclear → bucket
     `AMBIGUOUS`, skip, manual review.

6. **Repair (`--execute` only) — import-first ordering.**
   For `WOULD_REPAIR`:
   a. `messages.import` the reinflated rfc822, with `labelIds` = folder
      label + any user-applied labels copied from the old body-only
      message (preserves stars/labels), `internalDateSource="dateHeader"`,
      `neverMarkSpam=True`.
   b. **Verify:** `messages.get` the newly-imported id; confirm
      attachment parts are present.
   c. **Only if verify passes:** `messages.trash` the old body-only id.
   - If (a) or (b) fails → leave the old copy untouched, bucket
     `IMPORT_FAILED`. Worst case is a harmless duplicate; never data loss.

   For `WOULD_REPAIR_TRASH_ONLY`: just `messages.trash` the body-only id.

7. **Rate limiting.** ~70 quota units/message; the per-second cap
   (250 units/user/sec) allows ~3 messages/sec. Sleep ~300 ms between
   messages; exponential backoff on HTTP 429.

8. **Quota / size handling.** `upload_message` *raises* `GmailLimitReached`
   on quota — catch it, save progress, stop cleanly. It *returns*
   `(0, error)` with `SIZE_CAP_ERROR_MARKER` in the string on oversize —
   bucket `SKIP_TOO_LARGE`, continue.

### Why import-first (the load-bearing safety decision)

The original design trashed the old copy first, then imported. Reviewer
audit (adversarial critic A1/A3, confirmed by Gmail API researcher G3)
found this is a data-loss bug:

- `messages.import` is the most failure-prone call (large payload, 413,
  network, quota).
- If `trash` succeeds and `import` then fails, the only copy is in Trash
  with a 30-day auto-purge fuse.
- `messages.list` with `q=` excludes Trash by default
  (`includeSpamTrash=false`). A re-run's `rfc822msgid:` query returns 0
  matches → the stranded message is bucketed `MISSING` and never
  recovered. It silently purges after 30 days.

Import-first inverts the risk: a failure at any step leaves the original
body-only copy intact. The worst outcome is a duplicate (recoverable,
visible), never silent loss.

## Re-run safety / idempotency

The script is safe to run dry-run → `--execute` → re-run `--execute`
(e.g. after a quota stop or Ctrl-C):

- A fully-repaired message: single match, has attachments → `ALREADY_DONE`.
- An imported-but-not-trashed message (6a/6b succeeded, 6c failed, or run
  died between): 2 matches, one body-only one with attachments →
  `WOULD_REPAIR_TRASH_ONLY` → trash completes on re-run.
- An untouched message: single body-only match → `WOULD_REPAIR`.

No state file of the backfill's own — Gmail's own message state is the
source of truth, queried fresh each run. (The script reads
`email-migration.json` only to enumerate candidate `.partial.emlx`
basenames; it never writes it.)

## Run model

- **Default (no flag):** dry-run. Enumerate, classify every message into
  buckets, print a report (counts per bucket, total attachment MB that
  would be uploaded, the `MISSING` list). Writes nothing to Gmail.
- **`--execute`:** perform the import → verify → trash sequence for
  `WOULD_REPAIR` and the trash for `WOULD_REPAIR_TRASH_ONLY`. Prints the
  same report plus per-message action results.
- `--folder <name>` optional: restrict to one folder for testing.

## Report buckets

| Bucket | Meaning | `--execute` action |
|---|---|---|
| `WOULD_REPAIR` | body-only copy found, has recoverable attachments | import → verify → trash |
| `WOULD_REPAIR_TRASH_ONLY` | attachment copy already imported, body-only copy still present | trash body-only |
| `ALREADY_DONE` | Gmail copy already has attachments | none |
| `MISSING` | no Gmail copy at all — real migration gap | none (report only) |
| `AMBIGUOUS` | 2+ body-only matches / unclear shape | none (manual review) |
| `SKIP_NO_ATTACHMENTS` | `.partial.emlx` with no recoverable attachments | none |
| `SKIP_TOO_LARGE` | reinflated message exceeds Gmail import cap | none |
| `IMPORT_FAILED` | import or verify failed during `--execute` | none (old copy intact) |

## Future-proofing (regression canary)

The reinflate fix is shipped and verified. To ensure it *stays* working,
add one check to `sync-health-check.sh`: after a sync run, sample the
most-recent `.partial.emlx` files uploaded in that run and confirm their
Gmail copies have attachment parts. If a fresh `.partial.emlx` ever
uploads body-only again, the health check flags it. No new pipeline —
one assertion in the existing health script.

## Testing (TDD)

New test file `scripts/sync/tests/test_backfill_attachments.py`. All tests
monkeypatch `STATE_DIR`/`STATE_FILE` and use fake Gmail services — no test
touches the real `~/.cache/email-migrate/` or the real Gmail account
(per the state-isolation discipline; a prior test clobbered production
state by omitting this).

Test coverage:
- Bucket classification: each of the 8 buckets gets a test driving a
  fake Gmail service into that state.
- Message-ID angle-bracket stripping before `rfc822msgid:` query.
- Import-first ordering: a fake service where `import` fails — assert the
  old message is NOT trashed (`messages.trash` never called).
- Import-first ordering: `import` succeeds, `verify` fails — assert old
  not trashed.
- Re-run idempotency: `WOULD_REPAIR_TRASH_ONLY` path — 2 matches, one
  body-only — assert trash-only, no re-import.
- Dry-run writes nothing: assert no `import`/`trash`/`delete` calls in
  default mode.
- `labelIds` copy: user labels on the old message appear on the import.
- `GmailLimitReached` mid-run: assert clean stop, partial progress fine.
- `discover_folders` path resolution: basename → full path.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Data loss on partial failure | Import-first ordering; old copy never removed before new copy verified |
| Wrong message trashed | Exactly-1-match gate; `AMBIGUOUS` skip; trash only after verifying the *new* copy has attachments |
| Recovered ledger lists never-uploaded files | `MISSING` bucket surfaces these as a real gap, not a silent skip |
| Quota exhaustion mid-run | Catch `GmailLimitReached`, stop cleanly; re-run resumes idempotently |
| Duplicate left after trash failure | `WOULD_REPAIR_TRASH_ONLY` path cleans it on re-run |
| Lost user labels/stars | Copy `labelIds` from old message onto the import |
| Test clobbers production state | All tests monkeypatch `STATE_DIR`/`STATE_FILE`; no real Gmail calls |
