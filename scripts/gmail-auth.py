#!/usr/bin/env python3
"""Gmail OAuth re-authorization tool.

Mints (or re-mints) an OAuth2 token for a Gmail account and writes it in the
JSON shape that scripts/sync/email-migrate.py's load_gmail_api_credentials()
expects: keys token, refresh_token, token_uri, client_id, client_secret,
scopes.

WHY THIS EXISTS
---------------
The mikejg1838@gmail.com backup-account token was minted with only
`gmail.modify` + `gmail.settings.basic`. `gmail.modify` can trash a message
but NOT permanently delete it — `users.messages.delete` requires the broad
`https://mail.google.com/` scope and returns 403 "insufficient scopes"
without it. The attachment backfill (scripts/sync/backfill-attachments.py)
needs permanent-delete: Gmail's `messages.import` deduplicates by RFC822
Message-ID even against Trash, so the only way to replace a body-only
message with an attachment-bearing one is to hard-delete the old copy first.

A refresh token's scopes are FIXED at consent time — you cannot widen the
scope of an existing token. This tool re-runs the consent flow with the
wider scope set, producing a NEW refresh token.

PREREQUISITE (check this FIRST)
-------------------------------
The GCP OAuth client (the client_id in ~/.gmail-mcp/gcp-oauth.keys.json)
must allow `https://mail.google.com/` on its consent screen. That scope is
"restricted" — for a testing-mode app with you as a registered test user it
works (with an "unverified app" warning); a published app may need Google
verification. If the consent screen does not offer the scope, the flow
fails at Google's end regardless of this tool. Check the GCP console
(OAuth consent screen → Scopes) before running.

USAGE
-----
    python3 scripts/gmail-auth.py --user mikejg1838@gmail.com
    python3 scripts/gmail-auth.py --user mikejg1838@gmail.com --scopes modify,settings,full
    python3 scripts/gmail-auth.py --user mikejg1838@gmail.com --dry-run

The flow opens a browser for Google consent. On success the token is written
to ~/.google_workspace_mcp/credentials/<user>.json (the path
email-migrate.py reads). The previous token file, if any, is backed up
alongside with a .bak-<timestamp> suffix first.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

# OAuth client (installed-app) keys — shared with the Gmail MCP setup.
OAUTH_CLIENT_FILE = Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"

# Where load_gmail_api_credentials() looks (second of the two candidate
# paths in email-migrate.py's _gmail_token_paths; the live token is here).
CREDENTIALS_DIR = Path.home() / ".google_workspace_mcp" / "credentials"

# Named scope sets. The backfill's delete-then-import needs `full`.
SCOPE_SETS = {
    "modify": "https://www.googleapis.com/auth/gmail.modify",
    "settings": "https://www.googleapis.com/auth/gmail.settings.basic",
    "full": "https://mail.google.com/",
}

# Default: the three scopes the backfill needs — keep the two the existing
# token already had, plus full-access for permanent-delete.
DEFAULT_SCOPES = ("modify", "settings", "full")


def _resolve_scopes(scope_arg: str | None) -> list[str]:
    """Map a comma-separated scope-name list to full scope URLs."""
    names = (
        [s.strip() for s in scope_arg.split(",") if s.strip()]
        if scope_arg
        else list(DEFAULT_SCOPES)
    )
    urls = []
    for name in names:
        if name not in SCOPE_SETS:
            raise SystemExit(
                f"Unknown scope {name!r}. Known: {', '.join(SCOPE_SETS)}"
            )
        urls.append(SCOPE_SETS[name])
    return urls


def _load_oauth_client() -> dict:
    """Load the installed-app OAuth client keys."""
    if not OAUTH_CLIENT_FILE.exists():
        raise SystemExit(
            f"OAuth client file not found: {OAUTH_CLIENT_FILE}\n"
            "This is the GCP OAuth client (client_id/client_secret) shared "
            "with the Gmail MCP setup. Cannot run the consent flow without it."
        )
    data = json.loads(OAUTH_CLIENT_FILE.read_text())
    # The file is the standard Google client-secrets shape: a single
    # top-level key, "installed" or "web", wrapping the client fields.
    client_type = next(iter(data))
    return data[client_type]


def _backup_existing(token_path: Path) -> None:
    """Back up an existing token file before overwriting it."""
    if token_path.exists():
        backup = token_path.with_suffix(
            f".json.bak-{time.strftime('%Y%m%d-%H%M%S')}"
        )
        shutil.copy2(token_path, backup)
        print(f"Backed up existing token -> {backup}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Re-authorize a Gmail OAuth token with chosen scopes."
    )
    parser.add_argument(
        "--user", required=True,
        help="Gmail address to authorize (e.g. mikejg1838@gmail.com)",
    )
    parser.add_argument(
        "--scopes", default=None,
        help=f"Comma-separated scope names (default: "
             f"{','.join(DEFAULT_SCOPES)}). Known: {','.join(SCOPE_SETS)}",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would happen (scopes, output path) without "
             "running the consent flow.",
    )
    args = parser.parse_args()

    scopes = _resolve_scopes(args.scopes)
    token_path = CREDENTIALS_DIR / f"{args.user}.json"

    print(f"User:        {args.user}")
    print(f"Scopes:      {scopes}")
    print(f"Token path:  {token_path}")
    print(f"OAuth client: {OAUTH_CLIENT_FILE}")

    if args.dry_run:
        print("\n[dry-run] No consent flow run, no files written.")
        if "https://mail.google.com/" in scopes:
            print("[dry-run] NOTE: the full-access scope requires the GCP "
                  "OAuth consent screen to permit it — verify in the GCP "
                  "console before a real run.")
        return 0

    # Imported lazily so --dry-run / --help work without the dependency.
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        raise SystemExit(
            "google-auth-oauthlib is not installed. Install it with:\n"
            "  pip install google-auth-oauthlib"
        )

    client_config = {"installed": _load_oauth_client()}
    flow = InstalledAppFlow.from_client_config(client_config, scopes)

    print("\nOpening a browser for Google consent...")
    print("(If the app is unverified you will see a warning — proceed if "
          "you trust this app; you are the owner.)")
    creds = flow.run_local_server(port=0)

    # Write the token in the exact 6-key shape load_gmail_api_credentials()
    # reads. creds.scopes reflects what Google actually granted.
    token_data = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes or scopes),
    }

    if not token_data["refresh_token"]:
        raise SystemExit(
            "Google did not return a refresh_token. This usually means the "
            "account previously consented — revoke the app's access at "
            "https://myaccount.google.com/permissions and re-run, or the "
            "flow needs access_type=offline + prompt=consent."
        )

    CREDENTIALS_DIR.mkdir(parents=True, exist_ok=True)
    _backup_existing(token_path)

    tmp = token_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(token_data, indent=2))
    tmp.replace(token_path)

    print(f"\nToken written: {token_path}")
    print(f"Granted scopes: {token_data['scopes']}")
    if "https://mail.google.com/" in token_data["scopes"]:
        print("Full-access scope granted — messages.delete (permanent "
              "delete) is now available for this account.")
    else:
        print("WARNING: the full-access scope was NOT granted. "
              "messages.delete will still return 403.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
