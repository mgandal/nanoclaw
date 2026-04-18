"""Gmail API adapter — fetches and normalizes emails."""

import base64
import json
import logging
from pathlib import Path

from email_ingest.secure_write import write_file_secure
from email_ingest.types import (
    NormalizedEmail, BODY_MAX_CHARS, GMAIL_TOKEN_FILE,
)

log = logging.getLogger("email-ingest.gmail")


def _migrate_token_mode() -> None:
    """Ensure existing token file has mode 0o600.

    Runs unconditionally on import; cost is one stat+chmod if the file
    exists. Safe to run repeatedly.
    """
    try:
        if GMAIL_TOKEN_FILE.exists():
            current = GMAIL_TOKEN_FILE.stat().st_mode & 0o777
            if current != 0o600:
                GMAIL_TOKEN_FILE.chmod(0o600)
    except OSError:
        pass


_migrate_token_mode()

# Credential paths (same fallback chain as gmail-sync.py)
SRC_EMAIL = "mgandal@gmail.com"
CRED_PATHS = [
    Path.home() / ".google_workspace_mcp" / "credentials" / f"{SRC_EMAIL}.json",
    Path.home() / ".gmail-mcp" / "credentials.json",
]
OAUTH_KEYS = Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"


def _load_credentials():
    """Load Gmail OAuth credentials. Uses dedicated token file to avoid
    contention with GmailChannel's live polling."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    # Try dedicated token first (has refreshed access token)
    if GMAIL_TOKEN_FILE.exists():
        data = json.loads(GMAIL_TOKEN_FILE.read_text())
        creds = Credentials(
            token=data.get("token"),
            refresh_token=data.get("refresh_token"),
            token_uri=data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=data.get("client_id"),
            client_secret=data.get("client_secret"),
            scopes=data.get("scopes", []),
        )
        try:
            if creds.expired and creds.refresh_token:
                creds.refresh(Request())
                _save_token(creds, data)
            return creds
        except Exception as e:
            log.warning("Dedicated token refresh failed: %s — trying credential files", e)
            GMAIL_TOKEN_FILE.unlink(missing_ok=True)

    # Bootstrap from existing credential files
    for cred_path in CRED_PATHS:
        if not cred_path.exists():
            continue
        data = json.loads(cred_path.read_text())
        token = data.get("token") or data.get("access_token")
        refresh_token = data.get("refresh_token")
        client_id = data.get("client_id")
        client_secret = data.get("client_secret")

        if not client_id and OAUTH_KEYS.exists():
            oauth_data = json.loads(OAUTH_KEYS.read_text())
            installed = oauth_data.get("installed", oauth_data.get("web", {}))
            client_id = installed.get("client_id")
            client_secret = installed.get("client_secret")

        if not (refresh_token and client_id):
            continue

        creds = Credentials(
            token=token,  # May be None — will be refreshed
            refresh_token=refresh_token,
            token_uri=data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=client_id,
            client_secret=client_secret,
            scopes=data.get("scopes", []),
        )
        try:
            # Always force a refresh to verify the token is actually usable.
            # Tokens can report valid=True locally but be revoked server-side.
            if creds.refresh_token:
                creds.refresh(Request())
        except Exception as e:
            log.warning("Credential refresh failed for %s: %s — trying next", cred_path, e)
            continue

        # Save to dedicated token file for future runs
        _save_token(creds, {
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
            "token_uri": data.get("token_uri", "https://oauth2.googleapis.com/token"),
            "scopes": data.get("scopes", []),
        })
        log.info("Bootstrapped Gmail token from %s", cred_path)
        return creds

    return None


def _save_token(creds, base_data):
    """Persist refreshed token to dedicated file (mode 0o600)."""
    GMAIL_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    save_data = {**base_data, "token": creds.token}
    write_file_secure(
        GMAIL_TOKEN_FILE,
        json.dumps(save_data, indent=2),
        mode=0o600,
    )


def _extract_body(payload: dict) -> str:
    """Extract plain text body from Gmail message payload."""
    # Try top-level body
    body_data = payload.get("body", {}).get("data", "")
    if body_data:
        try:
            return base64.urlsafe_b64decode(body_data).decode("utf-8", errors="replace")
        except Exception:
            pass

    # Try parts
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain":
            data = part.get("body", {}).get("data", "")
            if data:
                try:
                    return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
                except Exception:
                    pass
        # Recurse into nested parts
        if "parts" in part:
            result = _extract_body(part)
            if result:
                return result

    return ""


def _get_header(headers: list, name: str, default: str = "") -> str:
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", default)
    return default


def normalize_gmail_message(raw: dict) -> NormalizedEmail:
    """Convert Gmail API message to NormalizedEmail."""
    headers = raw.get("payload", {}).get("headers", [])
    body = _extract_body(raw.get("payload", {}))

    return NormalizedEmail(
        id=raw["id"],
        source="gmail",
        from_addr=_get_header(headers, "From"),
        to=[a.strip() for a in _get_header(headers, "To").split(",") if a.strip()],
        cc=[a.strip() for a in _get_header(headers, "Cc").split(",") if a.strip()],
        subject=_get_header(headers, "Subject") or "(no subject)",
        date=_get_header(headers, "Date"),
        body=body[:BODY_MAX_CHARS],
        labels=raw.get("labelIds", []),
        metadata={
            "threadId": raw.get("threadId", ""),
            "snippet": raw.get("snippet", ""),
        },
    )


class GmailAdapter:
    """Fetches emails from Gmail API since a given epoch."""

    def __init__(self):
        self._service = None

    def connect(self) -> bool:
        """Initialize Gmail API service. Returns False if credentials missing.
        Verifies credentials with a lightweight API call to catch stale tokens early.
        Retries with next credential source if verification fails."""
        from googleapiclient.discovery import build

        for attempt in range(2):
            creds = _load_credentials()
            if not creds:
                log.error("No Gmail credentials found")
                return False
            service = build("gmail", "v1", credentials=creds)
            try:
                service.users().getProfile(userId="me").execute()
                self._service = service
                log.info("Gmail API connected and verified")
                return True
            except Exception as e:
                log.warning("Gmail credential verification failed (attempt %d): %s", attempt + 1, e)
                # Delete stale dedicated token so _load_credentials retries from source creds
                GMAIL_TOKEN_FILE.unlink(missing_ok=True)
        return False

    def fetch_since(self, epoch: int, processed_ids: set[str]) -> list[NormalizedEmail]:
        """Fetch all emails since epoch, skipping already-processed IDs.
        Read-only — does NOT modify labels or mark as read."""
        if not self._service:
            return []

        query = f"after:{epoch}"
        emails = []
        page_token = None

        while True:
            resp = self._service.users().messages().list(
                userId="me", q=query, maxResults=100, pageToken=page_token,
            ).execute()

            for msg_stub in resp.get("messages", []):
                if msg_stub["id"] in processed_ids:
                    continue

                try:
                    full = self._service.users().messages().get(
                        userId="me", id=msg_stub["id"], format="full",
                    ).execute()
                    emails.append(normalize_gmail_message(full))
                except Exception as e:
                    log.warning("Failed to fetch message %s: %s", msg_stub["id"], e)

            page_token = resp.get("nextPageToken")
            if not page_token:
                break

        log.info("Fetched %d Gmail emails since epoch %d", len(emails), epoch)
        return emails

    def fetch_thread_messages(
        self, thread_id: str, since_epoch: int
    ) -> list[NormalizedEmail]:
        """Fetch messages in a Gmail thread with internalDate > since_epoch (ms-resolution).
        Read-only. Returns [] on any failure."""
        if not self._service:
            return []
        try:
            resp = (
                self._service.users()
                .threads()
                .get(userId="me", id=thread_id, format="full")
                .execute()
            )
        except Exception as e:
            log.warning("Gmail thread fetch failed for %s: %s", thread_id, e)
            return []

        since_ms = since_epoch * 1000
        out: list[NormalizedEmail] = []
        for raw in resp.get("messages", []):
            try:
                internal = int(raw.get("internalDate", "0"))
            except (TypeError, ValueError):
                internal = 0
            if internal <= since_ms:
                continue
            try:
                out.append(normalize_gmail_message(raw))
            except Exception as e:
                log.warning("Gmail thread normalize failed: %s", e)
        return out

    def fetch_message(self, msg_id: str) -> NormalizedEmail | None:
        """Fetch a single message by id. Returns None on failure."""
        if not self._service:
            return None
        try:
            raw = (
                self._service.users()
                .messages()
                .get(userId="me", id=msg_id, format="full")
                .execute()
            )
            return normalize_gmail_message(raw)
        except Exception as e:
            log.warning("Gmail message fetch failed for %s: %s", msg_id, e)
            return None
