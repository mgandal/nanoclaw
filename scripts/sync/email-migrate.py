#!/usr/bin/env python3
"""Email Migration: Mac Mail (Exchange) -> Gmail via Gmail API.

Reads messages directly from Mac Mail's on-disk .emlx files (bypassing
AppleScript for ~100x faster export), then uploads to Gmail via the
Gmail API messages.import endpoint, preserving dates, flags, and folder
structure.

Usage:
    python3 scripts/email-migrate.py              # Start/resume migration
    python3 scripts/email-migrate.py --status      # Show progress
    python3 scripts/email-migrate.py --dry-run     # Plan without uploading
    python3 scripts/email-migrate.py --folder Inbox # Migrate one folder
    python3 scripts/email-migrate.py --imap         # Use legacy IMAP mode
"""

import argparse
import base64
import email
import imaplib
import json
import logging
import os
import plistlib
import random
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from email.utils import parsedate_to_datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
# State + .env live in ~/.cache/email-migrate/ regardless of where this
# script is invoked from. Migrated from /Users/mgandal/Agents/marvin2/state/
# on 2026-04-26 to break the cross-repo dependency on marvin2.
# The directory is created on first IngestState.save() if missing.
STATE_DIR = Path.home() / ".cache" / "email-migrate"
STATE_FILE = STATE_DIR / "email-migration.json"
ENV_FILE = STATE_DIR / ".env"

# Mac Mail local storage
MAIL_DIR = Path.home() / "Library" / "Mail" / "V10"
EXCHANGE_ACCOUNT_ID = "EF7AC40E-29D7-47BD-AE80-2A6694A1045E"
ACCOUNT_DIR = MAIL_DIR / EXCHANGE_ACCOUNT_ID

GMAIL_HOST = "imap.gmail.com"
GMAIL_PORT = 993
GMAIL_USER = os.environ.get("GMAIL_MIGRATE_USER", "")

# Gmail API token locations (created by gmail-auth.py); populated after GMAIL_USER is validated
def _gmail_token_paths(user: str):
    return [
        SCRIPT_DIR / f"gmail-token-{user}.json",
        Path.home() / ".google_workspace_mcp" / "credentials" / f"{user}.json",
    ]

MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 2  # seconds
UPLOAD_WORKERS = 5  # parallel connections (IMAP) or threads (API)
UPLOAD_BATCH_SIZE = 500  # messages per upload round
API_UPLOAD_WORKERS = 10  # more threads for API (no connection overhead)

SKIP_FOLDERS = {
    "Deleted Items", "Junk Email", "Drafts", "Outbox", "Junk E-Mail",
    "Conflicts", "Sync Issues", "Local Failures", "Server Failures",
    "Clutter", "Conversation History", "Journal", "RSS Feeds",
    "Notes", "Tasks",
}

LABEL_MAP = {
    "Sent Items": "Outlook/Sent",
    "Sent Messages": "Outlook/Sent",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("email-migrate")

# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------


class GmailLimitReached(Exception):
    """Raised when Gmail rejects an upload due to quota/daily limit."""
    pass


class ShutdownRequested(Exception):
    pass


# ---------------------------------------------------------------------------
# Graceful shutdown
# ---------------------------------------------------------------------------

_shutdown_event = threading.Event()


def _handle_signal(signum, frame):
    _shutdown_event.set()
    log.warning("Shutdown requested — finishing current batch then saving…")


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)

# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------


def load_state():
    """Load migration state from JSON file, or return fresh state."""
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            # Corruption recovery: rotate the bad file aside so the next run
            # starts with a fresh state. The next call to migrate_folder()
            # then runs seed_migrated_files_from_gmail() to repopulate
            # migrated_files from messages already in Gmail (matched by
            # Message-ID), so we don't double-import. Without this guard,
            # a single disk-full mid-write or power-loss-during-tmp-replace
            # wedges the pipeline forever.
            ts = time.strftime("%Y-%m-%dT%H-%M-%S")
            corrupt_path = STATE_FILE.parent / f"{STATE_FILE.name}.corrupt-{ts}"
            try:
                STATE_FILE.rename(corrupt_path)
                print(
                    f"WARN: state file corrupt ({exc}); rotated to {corrupt_path}",
                    file=sys.stderr,
                )
            except OSError as rename_err:
                print(
                    f"WARN: state file corrupt ({exc}); could not rotate: {rename_err}",
                    file=sys.stderr,
                )
    return {
        "folders": {},
        "bytes_uploaded_today": 0,
        "last_run_date": None,
        "errors": [],
    }


def save_state(state):
    """Persist migration state to JSON file."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    tmp.replace(STATE_FILE)


def reset_daily_counter(state):
    """Reset byte counter if the date has changed since last run."""
    today = date.today().isoformat()
    if state.get("last_run_date") != today:
        state["bytes_uploaded_today"] = 0
        state["last_run_date"] = today
    return state


def migrate_state_format(state):
    """Migrate state from old AppleScript-index format to new filename format."""
    changed = False
    for folder_name, fstate in state.get("folders", {}).items():
        if "migrated_files" not in fstate:
            fstate["migrated_files"] = []
            total = fstate.get("total", 0)
            migrated = fstate.get("migrated", 0)
            if migrated >= total and total > 0:
                fstate["completed"] = True
                log.info("  State migration: %s marked complete (was %d/%d)", folder_name, migrated, total)
            elif migrated > 0:
                log.warning(
                    "  State migration: %s was %d/%d — will re-upload "
                    "(old index-based state cannot map to filenames)",
                    folder_name, migrated, total,
                )
                fstate["migrated"] = 0
            fstate.pop("last_index", None)
            changed = True
    if changed:
        save_state(state)
    return state

# ---------------------------------------------------------------------------
# .emlx file reading
# ---------------------------------------------------------------------------


def parse_emlx(emlx_path):
    """Parse a Mac Mail .emlx file.

    Returns (rfc822_bytes, is_read, date_received_timestamp) or None on error.
    """
    try:
        with open(emlx_path, "rb") as f:
            first_line = f.readline()
            byte_count = int(first_line.strip())
            rfc822 = f.read(byte_count)
            if len(rfc822) < byte_count:
                log.warning("  Truncated .emlx: %s (expected %d, got %d)",
                            emlx_path.name, byte_count, len(rfc822))
                return None
            plist_data = f.read()

        meta = plistlib.loads(plist_data)
        flags = meta.get("flags", 0)
        is_read = bool(flags & 1)
        date_received = meta.get("date-received", 0)
        return rfc822, is_read, date_received
    except Exception as e:
        log.warning("  Failed to parse %s: %s", emlx_path, e)
        return None


def extract_message_id(rfc822_bytes):
    """Extract the Message-ID header from an RFC 822 byte string.

    Returns the header value (typically `<id@host>`) verbatim, or None if
    the header is missing or unparseable. Used by the corruption-recovery
    seed path to match local .emlx files against messages already in Gmail.
    """
    try:
        msg = email.message_from_bytes(rfc822_bytes)
    except Exception:
        return None
    mid = msg.get("Message-ID") or msg.get("Message-Id") or msg.get("message-id")
    if not mid:
        return None
    return mid.strip()


def seed_migrated_files_from_gmail(folder_state, label_name, emlx_files, label_cache, gmail_service):
    """Populate `migrated_files` from Gmail-side state when local state was lost.

    The Gmail API reference for messages.import does not document Message-ID
    dedup, so we cannot rely on Gmail to silently drop re-uploads after a
    state-file corruption recovery. This seed bridges the gap: when local
    `migrated_files` is empty AND the Gmail label exists, intersect local
    Message-IDs with Gmail's and mark the matches as already-migrated.

    Returns the number of files seeded. No-op (returns 0) on the normal
    path where `migrated_files` is non-empty.
    """
    if folder_state.get("migrated_files"):
        return 0

    label_id = label_cache.get(label_name)
    if not label_id:
        return 0

    local_index = {}
    for emlx_path in emlx_files:
        parsed = parse_emlx(emlx_path)
        if parsed is None:
            continue
        rfc822, _is_read, _ts = parsed
        mid = extract_message_id(rfc822)
        if mid:
            local_index[mid] = emlx_path.name

    if not local_index:
        return 0

    migrated_files = folder_state.setdefault("migrated_files", [])
    seeded_count = 0
    page_token = None
    try:
        while True:
            list_kwargs = {"userId": "me", "labelIds": [label_id], "maxResults": 500}
            if page_token:
                list_kwargs["pageToken"] = page_token
            resp = gmail_service.users().messages().list(**list_kwargs).execute()
            for stub in resp.get("messages", []):
                msg = (
                    gmail_service.users()
                    .messages()
                    .get(
                        userId="me",
                        id=stub["id"],
                        format="metadata",
                        metadataHeaders=["Message-ID"],
                    )
                    .execute()
                )
                headers = msg.get("payload", {}).get("headers", [])
                gmail_mid = None
                for h in headers:
                    if h.get("name", "").lower() == "message-id":
                        gmail_mid = (h.get("value") or "").strip()
                        break
                if gmail_mid and gmail_mid in local_index:
                    migrated_files.append(local_index[gmail_mid])
                    seeded_count += 1
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
    except Exception as exc:
        log.warning(
            "  Seed: error querying Gmail for %s (got %d so far): %s",
            label_name, seeded_count, exc,
        )

    if seeded_count:
        folder_state["migrated"] = len(migrated_files)
        log.info(
            "  Seed: recovered %d already-migrated files from Gmail (%s)",
            seeded_count, label_name,
        )

    return seeded_count


def discover_folders():
    """Walk the Mac Mail account directory and find all folders with messages."""
    if not ACCOUNT_DIR.exists():
        log.error("Account directory not found: %s", ACCOUNT_DIR)
        sys.exit(1)

    folders = []
    _walk_mbox(ACCOUNT_DIR, "", folders)
    return sorted(folders, key=lambda x: x[0])


def _walk_mbox(parent_dir, prefix, results):
    """Recursively walk .mbox directories to find folders with messages."""
    for entry in sorted(parent_dir.iterdir()):
        if not entry.is_dir() or not entry.name.endswith(".mbox"):
            continue

        folder_name = entry.name[:-5]
        full_path = f"{prefix}/{folder_name}" if prefix else folder_name

        emlx_files = []
        for sub in entry.iterdir():
            if sub.is_dir() and len(sub.name) == 36 and "-" in sub.name:
                data_dir = sub / "Data"
                if data_dir.exists():
                    for emlx in data_dir.rglob("*.emlx"):
                        emlx_files.append(emlx)

        if emlx_files:
            emlx_files.sort(key=lambda p: _emlx_sort_key(p))
            results.append((full_path, entry, emlx_files))

        _walk_mbox(entry, full_path, results)


def _emlx_sort_key(path):
    """Sort .emlx files by their numeric name."""
    try:
        return int(path.stem.split(".")[0])
    except ValueError:
        return 0


# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------


def folder_to_label(folder_path):
    """Map Exchange folder path to Gmail label."""
    leaf = folder_path.split("/")[-1] if "/" in folder_path else folder_path
    if folder_path in LABEL_MAP:
        return LABEL_MAP[folder_path]
    if leaf in LABEL_MAP:
        return LABEL_MAP[leaf]
    return f"Outlook/{folder_path}"


# ---------------------------------------------------------------------------
# Gmail API uploader
# ---------------------------------------------------------------------------


def load_gmail_api_credentials():
    """Load OAuth credentials for Gmail API from token file."""
    from google.oauth2.credentials import Credentials

    for token_path in _gmail_token_paths(GMAIL_USER):
        if token_path.exists():
            with open(token_path) as f:
                cred_data = json.load(f)

            creds = Credentials(
                token=cred_data["token"],
                refresh_token=cred_data["refresh_token"],
                token_uri=cred_data.get("token_uri", "https://oauth2.googleapis.com/token"),
                client_id=cred_data["client_id"],
                client_secret=cred_data["client_secret"],
                scopes=cred_data.get("scopes", []),
            )
            log.info("Loaded Gmail API credentials from %s", token_path)
            return creds

    log.error("No Gmail API token found. Run: python3 scripts/gmail-auth.py")
    log.error("Searched: %s", ", ".join(str(p) for p in _gmail_token_paths(GMAIL_USER)))
    sys.exit(1)


class GmailApiUploader:
    """Upload messages via Gmail API messages.import endpoint.

    Uses a thread pool for parallel uploads. Each thread gets its own
    service instance via threading.local (httplib2 is not thread-safe).
    """

    def __init__(self, credentials, num_workers=API_UPLOAD_WORKERS):
        from googleapiclient.discovery import build
        import logging as _logging
        _logging.getLogger("googleapiclient.discovery_cache").setLevel(_logging.ERROR)

        self._credentials = credentials
        self._original_token = credentials.token
        self._num_workers = num_workers
        self._label_cache = {}
        self._thread_local = threading.local()

        # Build one service to manage labels (main thread only)
        self._admin_service = build("gmail", "v1", credentials=credentials)

        # Pre-fetch existing labels
        self._refresh_labels()

    def _refresh_labels(self):
        """Fetch all labels and cache name->id mapping."""
        results = self._admin_service.users().labels().list(userId="me").execute()
        self._label_cache = {}
        for label in results.get("labels", []):
            self._label_cache[label["name"]] = label["id"]

    def _ensure_label(self, label_name):
        """Create a Gmail label if it doesn't exist. Returns label ID."""
        if label_name in self._label_cache:
            return self._label_cache[label_name]

        # Create parent labels first (e.g., "Outlook" before "Outlook/Inbox")
        parts = label_name.split("/")
        for i in range(1, len(parts) + 1):
            partial = "/".join(parts[:i])
            if partial not in self._label_cache:
                try:
                    result = self._admin_service.users().labels().create(
                        userId="me",
                        body={
                            "name": partial,
                            "labelListVisibility": "labelShow",
                            "messageListVisibility": "show",
                        },
                    ).execute()
                    self._label_cache[partial] = result["id"]
                    log.info("  Created Gmail label: %s", partial)
                except Exception as e:
                    error_str = str(e)
                    if "already exists" in error_str.lower():
                        # Race condition or cache miss — refresh and retry
                        self._refresh_labels()
                        if partial in self._label_cache:
                            continue
                    log.warning("  Failed to create label '%s': %s", partial, e)
                    return None

        return self._label_cache.get(label_name)

    def _get_thread_service(self):
        """Get or create a per-thread Gmail API service (one per thread)."""
        if not hasattr(self._thread_local, "service"):
            from googleapiclient.discovery import build
            # Suppress file_cache warning from google-api-python-client
            import logging as _logging
            _logging.getLogger("googleapiclient.discovery_cache").setLevel(_logging.ERROR)
            self._thread_local.service = build("gmail", "v1", credentials=self._credentials)
        return self._thread_local.service

    def upload_message(self, service, label_id, eml_content, is_read):
        """Upload a single message via messages.import.

        Returns (bytes_uploaded, error_or_None).
        Raises GmailLimitReached on quota errors.
        """
        raw = base64.urlsafe_b64encode(eml_content).decode("ascii")

        label_ids = [label_id]
        if not is_read:
            label_ids.append("UNREAD")

        body = {
            "raw": raw,
            "labelIds": label_ids,
        }

        last_error = None
        for attempt in range(MAX_RETRIES):
            try:
                result = service.users().messages().import_(
                    userId="me",
                    body=body,
                    internalDateSource="dateHeader",
                    neverMarkSpam=True,
                ).execute()
                return len(eml_content), None
            except Exception as e:
                error_str = str(e)
                if any(kw in error_str.lower() for kw in [
                    "quota", "rate limit", "too many requests",
                    "user-rate limit", "daily limit",
                ]):
                    raise GmailLimitReached(f"Gmail API quota exceeded: {e}")
                last_error = e
                if attempt < MAX_RETRIES - 1:
                    wait = RETRY_BACKOFF_BASE ** (attempt + 1) + random.uniform(0, 1)
                    log.warning("  API attempt %d failed: %s (retry in %.1fs)", attempt + 1, e, wait)
                    time.sleep(wait)

        return 0, str(last_error) if last_error else "max retries exceeded"

    def migrate_folder(self, folder_name, emlx_files, state):
        """Migrate all messages in a folder using Gmail API."""
        label_name = folder_to_label(folder_name)
        folder_state = state["folders"].setdefault(
            folder_name, {"total": 0, "migrated": 0, "migrated_files": [], "errors": []}
        )

        total = len(emlx_files)
        folder_state["total"] = total

        # Corruption-recovery seed: if migrated_files is empty but Gmail
        # already has messages on this label, fill from Gmail-side state.
        seed_migrated_files_from_gmail(
            folder_state, label_name, emlx_files,
            self._label_cache, self._admin_service,
        )

        # Always re-scan: the `completed` flag is informational only.
        # Mac Mail can write new .emlx into any folder (incl. ones marked
        # "done" in a prior run), and we must pick those up.
        migrated_set = set(folder_state.get("migrated_files", []))
        remaining_files = [f for f in emlx_files if f.name not in migrated_set]

        if not remaining_files:
            folder_state["completed"] = True
            log.info("  %s: already complete (%d/%d)", folder_name, len(migrated_set), total)
            return state

        log.info(
            "  %s: %d messages (%d already done, %d remaining)",
            folder_name, total, len(migrated_set), len(remaining_files),
        )

        # Ensure label exists
        label_id = self._ensure_label(label_name)
        if not label_id:
            log.error("  Cannot create label %s — skipping folder", label_name)
            return state

        state_lock = threading.Lock()
        quota_hit = threading.Event()

        def upload_one(emlx_path, rfc822, is_read):
            """Upload a single message, return (emlx_path, nbytes, error)."""
            if _shutdown_event.is_set() or quota_hit.is_set():
                return emlx_path, 0, "cancelled"

            try:
                service = self._get_thread_service()
                nbytes, error = self.upload_message(service, label_id, rfc822, is_read)
                return emlx_path, nbytes, error
            except GmailLimitReached:
                quota_hit.set()
                return emlx_path, 0, "quota_exceeded"

        # Process in batches
        for batch_start in range(0, len(remaining_files), UPLOAD_BATCH_SIZE):
            if _shutdown_event.is_set():
                save_state(state)
                raise ShutdownRequested("Shutdown requested")

            if quota_hit.is_set():
                save_state(state)
                raise GmailLimitReached("Gmail API quota exceeded. Resume later.")

            batch_files = remaining_files[batch_start:batch_start + UPLOAD_BATCH_SIZE]

            # Parse all .emlx files in this batch
            parsed = []
            for emlx_path in batch_files:
                result = parse_emlx(emlx_path)
                if result is None:
                    folder_state["errors"].append(
                        {"file": emlx_path.name, "error": "parse failed"}
                    )
                    folder_state["migrated_files"].append(emlx_path.name)
                    continue
                rfc822, is_read, timestamp = result
                parsed.append((emlx_path, rfc822, is_read))

            if not parsed:
                continue

            log.info(
                "  [%d-%d/%d] Uploading %d messages via API…",
                batch_start + len(migrated_set) + 1,
                batch_start + len(migrated_set) + len(parsed),
                total,
                len(parsed),
            )

            # Upload in parallel using thread pool (services reused per thread)
            with ThreadPoolExecutor(max_workers=self._num_workers) as executor:
                futures = []
                for emlx_path, rfc822, is_read in parsed:
                    futures.append(
                        executor.submit(upload_one, emlx_path, rfc822, is_read)
                    )

                for future in as_completed(futures):
                    emlx_path, nbytes, error = future.result()
                    with state_lock:
                        if error and error not in ("cancelled", "quota_exceeded"):
                            log.warning("  Upload failed %s: %s", emlx_path.name, error)
                            folder_state["errors"].append(
                                {"file": emlx_path.name, "error": error}
                            )
                        elif not error:
                            state["bytes_uploaded_today"] += nbytes
                            folder_state["migrated_files"].append(emlx_path.name)
                            folder_state["migrated"] = len(folder_state["migrated_files"])

            # Save state after each batch
            save_state(state)
            log.info(
                "  %.1f MB uploaded today, %d/%d migrated",
                state["bytes_uploaded_today"] / (1024 * 1024),
                folder_state["migrated"], total,
            )

            if quota_hit.is_set():
                raise GmailLimitReached("Gmail API quota exceeded. Resume later.")

        return state

    def close(self):
        """Persist refreshed token if it changed during the session."""
        if self._credentials.token and self._credentials.token != self._original_token:
            for token_path in _gmail_token_paths(GMAIL_USER):
                if token_path.exists():
                    try:
                        with open(token_path) as f:
                            cred_data = json.load(f)
                        cred_data["token"] = self._credentials.token
                        tmp = token_path.with_suffix(".tmp")
                        with open(tmp, "w") as f:
                            json.dump(cred_data, f, indent=2)
                        os.chmod(tmp, 0o600)
                        tmp.replace(token_path)
                        log.info("Persisted refreshed token to %s", token_path)
                    except Exception as e:
                        log.warning("Failed to persist refreshed token: %s", e)
                    break


# ---------------------------------------------------------------------------
# Legacy IMAP uploader (kept for --imap fallback)
# ---------------------------------------------------------------------------


def connect_gmail_imap(password):
    """Connect and authenticate to Gmail IMAP."""
    imap = imaplib.IMAP4_SSL(GMAIL_HOST, GMAIL_PORT)
    imap.login(GMAIL_USER, password)
    log.info("Connected to Gmail IMAP as %s", GMAIL_USER)
    return imap


def ensure_label_imap(imap, label):
    """Create a Gmail label (IMAP folder) if it doesn't exist."""
    parts = label.split("/")
    labels_to_check = ["/".join(parts[:i]) for i in range(1, len(parts) + 1)]

    status, folder_list = imap.list()
    existing = set()
    if status == "OK" and folder_list:
        for folder_info in folder_list:
            if isinstance(folder_info, bytes):
                decoded = folder_info.decode("utf-8", errors="replace")
                if '"/"' in decoded:
                    name = decoded.split('"/" ')[-1].strip().strip('"')
                    existing.add(name)

    for lbl in labels_to_check:
        if lbl not in existing:
            status, response = imap.create(lbl)
            if status == "OK":
                log.info("  Created Gmail label: %s", lbl)
            else:
                log.warning("  Failed to create label '%s': %s", lbl, response)


def date_to_imap(timestamp, eml_content=None):
    """Convert Unix timestamp to IMAP internal date format."""
    if timestamp and timestamp > 0:
        try:
            return imaplib.Time2Internaldate(timestamp)
        except (ValueError, OSError):
            pass

    if eml_content:
        try:
            msg = email.message_from_bytes(eml_content)
            date_header = msg.get("Date", "")
            if date_header:
                dt = parsedate_to_datetime(date_header)
                return imaplib.Time2Internaldate(dt.timestamp())
        except (ValueError, TypeError, OSError):
            pass

    return imaplib.Time2Internaldate(time.time())


def upload_message_imap(imap, label, eml_content, imap_date, is_read):
    """Upload a single message to Gmail via IMAP APPEND."""
    flags = "\\Seen" if is_read else ""
    status, response = imap.append(label, flags, imap_date, eml_content)
    if status != "OK":
        resp_str = str(response)
        if any(kw in resp_str.lower() for kw in [
            "over quota", "quota", "bandwidth", "limit",
            "try again later", "too many",
        ]):
            raise GmailLimitReached(f"Gmail rejected upload (likely daily limit): {response}")
        raise RuntimeError(f"IMAP APPEND failed: {response}")
    return len(eml_content)


class ImapUploadPool:
    """Pool of IMAP connections for parallel uploads (legacy mode)."""

    def __init__(self, password, num_workers=UPLOAD_WORKERS):
        self._password = password
        self._connections = []
        for _ in range(num_workers):
            self._connections.append(connect_gmail_imap(password))

    def _get_conn(self, worker_id):
        return self._connections[worker_id]

    def _reconnect(self, worker_id):
        try:
            self._connections[worker_id].logout()
        except Exception:
            pass
        self._connections[worker_id] = connect_gmail_imap(self._password)
        return self._connections[worker_id]

    def upload(self, worker_id, label, eml_content, imap_date, is_read):
        """Upload with retry."""
        last_error = None
        for attempt in range(MAX_RETRIES):
            try:
                conn = self._get_conn(worker_id)
                nbytes = upload_message_imap(conn, label, eml_content, imap_date, is_read)
                return nbytes, None
            except GmailLimitReached:
                raise
            except Exception as e:
                last_error = e
                log.warning("  Worker %d attempt %d failed: %s", worker_id, attempt + 1, e)
                if attempt == MAX_RETRIES - 1:
                    return 0, str(e)
                try:
                    self._reconnect(worker_id)
                except Exception as reconnect_err:
                    log.error("  Worker %d reconnect failed: %s", worker_id, reconnect_err)
                time.sleep(RETRY_BACKOFF_BASE ** (attempt + 1) + random.uniform(0, 1))
        return 0, str(last_error) if last_error else "max retries exceeded"

    def migrate_folder(self, folder_name, emlx_files, state):
        """Migrate all messages in a folder using IMAP."""
        label = folder_to_label(folder_name)
        folder_state = state["folders"].setdefault(
            folder_name, {"total": 0, "migrated": 0, "migrated_files": [], "errors": []}
        )

        total = len(emlx_files)
        folder_state["total"] = total

        # NOTE: The seed_migrated_files_from_gmail() recovery path is wired
        # into the API uploader only — IMAP path has no cheap Gmail metadata
        # query. State-corruption recovery on the IMAP path can still
        # double-deliver; that's a known limitation. Prefer the API path.

        # Always re-scan: the `completed` flag is informational only.
        # Mac Mail can write new .emlx into any folder (incl. ones marked
        # "done" in a prior run), and we must pick those up.
        migrated_set = set(folder_state.get("migrated_files", []))
        remaining_files = [f for f in emlx_files if f.name not in migrated_set]

        if not remaining_files:
            folder_state["completed"] = True
            log.info("  %s: already complete (%d/%d)", folder_name, len(migrated_set), total)
            return state

        log.info(
            "  %s: %d messages (%d already done, %d remaining)",
            folder_name, total, len(migrated_set), len(remaining_files),
        )

        ensure_label_imap(self._get_conn(0), label)

        state_lock = threading.Lock()
        quota_hit = threading.Event()

        def upload_group(worker_id, messages):
            for emlx_path, rfc822, is_read, timestamp in messages:
                if _shutdown_event.is_set() or quota_hit.is_set():
                    return

                imap_date = date_to_imap(timestamp, rfc822)
                try:
                    nbytes, error = self.upload(worker_id, label, rfc822, imap_date, is_read)
                except GmailLimitReached:
                    quota_hit.set()
                    return

                with state_lock:
                    if error:
                        log.warning("  Upload failed %s: %s", emlx_path.name, error)
                        folder_state["errors"].append(
                            {"file": emlx_path.name, "error": error}
                        )
                    else:
                        state["bytes_uploaded_today"] += nbytes
                        folder_state["migrated"] += 1
                        folder_state["migrated_files"].append(emlx_path.name)

        for batch_start in range(0, len(remaining_files), UPLOAD_BATCH_SIZE):
            if _shutdown_event.is_set():
                save_state(state)
                raise ShutdownRequested("Shutdown requested")

            if quota_hit.is_set():
                save_state(state)
                raise GmailLimitReached("Gmail daily upload limit reached. Resume tomorrow.")

            batch_files = remaining_files[batch_start:batch_start + UPLOAD_BATCH_SIZE]

            parsed = []
            for emlx_path in batch_files:
                result = parse_emlx(emlx_path)
                if result is None:
                    folder_state["errors"].append(
                        {"file": emlx_path.name, "error": "parse failed"}
                    )
                    folder_state["migrated_files"].append(emlx_path.name)
                    continue
                rfc822, is_read, timestamp = result
                parsed.append((emlx_path, rfc822, is_read, timestamp))

            if not parsed:
                continue

            groups = [[] for _ in range(UPLOAD_WORKERS)]
            for i, item in enumerate(parsed):
                groups[i % UPLOAD_WORKERS].append(item)

            log.info(
                "  [%d-%d/%d] Uploading %d messages via IMAP…",
                batch_start + len(migrated_set) + 1,
                batch_start + len(migrated_set) + len(parsed),
                total,
                len(parsed),
            )

            threads = []
            for worker_id, group in enumerate(groups):
                if group:
                    t = threading.Thread(target=upload_group, args=(worker_id, group))
                    threads.append(t)
                    t.start()

            for t in threads:
                t.join()

            save_state(state)
            log.info(
                "  %.1f MB uploaded today, %d/%d migrated",
                state["bytes_uploaded_today"] / (1024 * 1024),
                folder_state["migrated"], total,
            )

            if quota_hit.is_set():
                raise GmailLimitReached("Gmail daily upload limit reached. Resume tomorrow.")

        return state

    def close(self):
        for conn in self._connections:
            try:
                conn.logout()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Credential loading (for IMAP fallback)
# ---------------------------------------------------------------------------


def load_gmail_password():
    """Load Gmail App Password from .env file."""
    if not ENV_FILE.exists():
        log.error("No .env file found at %s", ENV_FILE)
        log.error("Create one with: GMAIL_APP_PASSWORD=your-app-password")
        sys.exit(1)

    with open(ENV_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if line.startswith("#"):
                continue
            if line.startswith("GMAIL_APP_PASSWORD="):
                password = line.split("=", 1)[1].strip().strip("'\"")
                if password and password != "your-gmail-app-password":
                    return password

    log.error("GMAIL_APP_PASSWORD not set in .env")
    log.error("Generate an App Password at https://myaccount.google.com/apppasswords")
    log.error("Then add to .env: GMAIL_APP_PASSWORD=xxxx")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Status display
# ---------------------------------------------------------------------------


def show_status(state):
    """Display migration progress."""
    total_msgs = 0
    total_migrated = 0
    total_errors = 0

    print("\n=== Email Migration Status ===\n")
    print(f"Last run: {state.get('last_run_date', 'never')}")
    print(f"Uploaded today: {state.get('bytes_uploaded_today', 0) / (1024 * 1024):.1f} MB\n")

    folders = state.get("folders", {})
    if not folders:
        print("No folders tracked yet. Run without --status to start.\n")
        return

    print(f"{'Folder':<35} {'Progress':<15} {'Errors':<8}")
    print("-" * 60)

    for folder_name, fstate in sorted(folders.items()):
        total = fstate.get("total", 0)
        migrated = fstate.get("migrated", 0)
        errors = len(fstate.get("errors", []))
        total_msgs += total
        total_migrated += migrated
        total_errors += errors

        pct = (migrated / total * 100) if total > 0 else 0
        status = "done" if migrated >= total and total > 0 else f"{pct:.0f}%"
        print(f"{folder_name:<35} {migrated:>5}/{total:<5} {status:<5}  {errors}")

    print("-" * 60)
    overall_pct = (total_migrated / total_msgs * 100) if total_msgs > 0 else 0
    print(f"{'TOTAL':<35} {total_migrated:>5}/{total_msgs:<5} {overall_pct:.1f}%   {total_errors}")
    print()

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Migrate email from Mac Mail (Exchange) to Gmail"
    )
    parser.add_argument(
        "--status", action="store_true", help="Show migration progress"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Count messages but don't upload"
    )
    parser.add_argument(
        "--folder", type=str, help="Migrate a specific folder only"
    )
    parser.add_argument(
        "--imap", action="store_true", help="Use legacy IMAP mode instead of Gmail API"
    )
    args = parser.parse_args()

    # Validate GMAIL_USER here (not at module level) so --status and --dry-run
    # work without Gmail connectivity.
    if not args.status and not args.dry_run:
        if not GMAIL_USER:
            log.error("GMAIL_MIGRATE_USER not set. Export it or add to .env")
            sys.exit(1)

    state = load_state()
    state = reset_daily_counter(state)
    state = migrate_state_format(state)

    if args.status:
        show_status(state)
        return

    # Discover folders from filesystem
    log.info("Scanning Mac Mail storage at %s…", ACCOUNT_DIR)
    all_folders = discover_folders()

    folders = [
        (name, path, files) for name, path, files in all_folders
        if not any(part in SKIP_FOLDERS for part in name.split("/"))
    ]
    skipped = len(all_folders) - len(folders)
    total_msgs = sum(len(files) for _, _, files in folders)

    log.info(
        "Found %d folders with %d messages (%d folders skipped)",
        len(folders), total_msgs, skipped,
    )

    if args.folder:
        matched = [(n, p, f) for n, p, f in folders if n == args.folder]
        if not matched:
            available = [n for n, _, _ in folders]
            log.error("Folder '%s' not found. Available: %s", args.folder, ", ".join(available))
            sys.exit(1)
        folders = matched

    if args.dry_run:
        log.info("\n=== DRY RUN — No uploads will be performed ===\n")
        for name, _, files in folders:
            label = folder_to_label(name)
            log.info("  %-35s %5d msgs -> %s", name, len(files), label)
            state["folders"].setdefault(
                name, {"total": 0, "migrated": 0, "migrated_files": [], "errors": []}
            )["total"] = len(files)
        log.info("\n  Total: %d messages across %d folders", total_msgs, len(folders))
        save_state(state)
        return

    # Create uploader
    if args.imap:
        log.info("Using legacy IMAP mode")
        password = load_gmail_password()
        log.info("Opening %d parallel IMAP connections…", UPLOAD_WORKERS)
        uploader = ImapUploadPool(password, UPLOAD_WORKERS)
    else:
        log.info("Using Gmail API mode (%d parallel threads)", API_UPLOAD_WORKERS)
        creds = load_gmail_api_credentials()
        uploader = GmailApiUploader(creds, API_UPLOAD_WORKERS)

    # Snapshot pre-loop counters so we can compute session-local deltas
    # for the success marker. Without this, the marker only proves the
    # process exited cleanly — not that it did any work or hit any errors.
    bytes_at_start = state["bytes_uploaded_today"]
    errors_at_start = sum(
        len(f.get("errors", [])) for f in state.get("folders", {}).values()
    )

    try:
        for name, _, files in folders:
            if _shutdown_event.is_set():
                break
            state = uploader.migrate_folder(name, files, state)

    except GmailLimitReached as e:
        log.warning(str(e))
    except ShutdownRequested:
        pass
    finally:
        save_state(state)
        uploader.close()
        log.info(
            "Session complete. Uploaded %.1f MB today. %s",
            state["bytes_uploaded_today"] / (1024 * 1024),
            "Run again to continue." if not _shutdown_event.is_set() else "",
        )

    # Success marker — written only when the try-block completed without an
    # uncaught exception. Quota throttling (GmailLimitReached) and graceful
    # SIGTERM (ShutdownRequested) both count as success: the script behaved
    # correctly. A staleness watchdog can compare this mtime against now to
    # detect silent failures (e.g. cross-repo path break, OAuth revocation).
    write_success_marker(state, bytes_at_start, errors_at_start)


def write_success_marker(state, bytes_at_start, errors_at_start):
    """Write last-success.json atomically with session-local deltas.

    Extracted from main() so unit tests can exercise the marker logic
    without spawning Mac Mail scans or Gmail API calls. Public entry point
    for the test suite at tests/test_email_migrate_marker.py.

    bytes_session and errors_session let freshness checks distinguish
    "ran cleanly and did work" from "ran cleanly but every upload failed
    silently" (e.g. revoked OAuth scope manifests as per-message errors
    that accumulate without aborting the loop).

    Atomic write: temp file + os.replace() so a crashed run leaves either
    the prior intact marker or no marker — never a 0-byte file.
    """
    bytes_session = state["bytes_uploaded_today"] - bytes_at_start
    errors_session = sum(
        len(f.get("errors", [])) for f in state.get("folders", {}).values()
    ) - errors_at_start
    payload = json.dumps({
        "timestamp": time.time(),
        "iso": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "bytes_uploaded_today": state["bytes_uploaded_today"],
        "bytes_session": bytes_session,
        "errors_session": errors_session,
    }, indent=2)
    success_file = STATE_DIR / "last-success.json"
    tmp_file = success_file.with_suffix(".json.tmp")
    tmp_file.write_text(payload)
    os.replace(tmp_file, success_file)


if __name__ == "__main__":
    main()
