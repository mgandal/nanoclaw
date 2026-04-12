#!/usr/bin/env python3
"""Guard script for inbox-monitor task.

Exit 0 if there are unread emails at mgandal+cc@gmail.com.
Exit 1 if the inbox is empty (no agent needed).
Exit 2 on error (treat as "run the agent" to be safe).

Uses the same credential chain as email_ingest/gmail_adapter.py.
"""

import json
import sys
from pathlib import Path

QUERY = "to:mgandal+cc@gmail.com is:unread"
TOKEN_FILE = Path.home() / ".cache" / "email-ingest" / "gmail-token.json"
CRED_PATHS = [
    Path.home() / ".google_workspace_mcp" / "credentials" / "mgandal@gmail.com.json",
    Path.home() / ".gmail-mcp" / "credentials.json",
]
OAUTH_KEYS = Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"


def load_credentials():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    if TOKEN_FILE.exists():
        data = json.loads(TOKEN_FILE.read_text())
        creds = Credentials(
            token=data.get("token"),
            refresh_token=data.get("refresh_token"),
            token_uri=data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=data.get("client_id"),
            client_secret=data.get("client_secret"),
            scopes=data.get("scopes", []),
        )
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            TOKEN_FILE.write_text(json.dumps({
                "token": creds.token,
                "refresh_token": creds.refresh_token,
                "token_uri": creds.token_uri,
                "client_id": creds.client_id,
                "client_secret": creds.client_secret,
                "scopes": list(creds.scopes or []),
            }))
        return creds

    for cred_path in CRED_PATHS:
        if not cred_path.exists():
            continue
        data = json.loads(cred_path.read_text())
        client_id = data.get("client_id")
        client_secret = data.get("client_secret")
        if not client_id and OAUTH_KEYS.exists():
            oauth = json.loads(OAUTH_KEYS.read_text())
            installed = oauth.get("installed", {})
            client_id = installed.get("client_id")
            client_secret = installed.get("client_secret")
        creds = Credentials(
            token=data.get("token") or data.get("access_token"),
            refresh_token=data.get("refresh_token"),
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
        )
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
        return creds

    return None


def main():
    try:
        creds = load_credentials()
        if not creds:
            print("No Gmail credentials found — running agent as fallback")
            sys.exit(0)

        from googleapiclient.discovery import build
        service = build("gmail", "v1", credentials=creds)
        result = service.users().messages().list(
            userId="me", q=QUERY, maxResults=1
        ).execute()

        count = result.get("resultSizeEstimate", 0)
        if count > 0:
            print(f"Found {count} unread message(s) — agent should run")
            sys.exit(0)
        else:
            print("No unread messages — skipping agent")
            sys.exit(1)

    except Exception as e:
        print(f"Guard error: {e} — running agent as fallback")
        sys.exit(0)


if __name__ == "__main__":
    main()
