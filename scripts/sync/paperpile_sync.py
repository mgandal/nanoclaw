#!/usr/bin/env python3
"""
Paperpile BibTeX Sync — downloads the latest paperpile.bib from Google Drive.

Paperpile auto-exports to Google Drive. This script pulls the latest version
and updates the local copy at ~/.hermes/paperpile.bib.

Usage:
    python3 paperpile_sync.py              # sync if newer
    python3 paperpile_sync.py --force      # force download
    python3 paperpile_sync.py --check      # just check if update available
"""

import argparse
import os
import sys
import json
from datetime import datetime, timezone
from pathlib import Path

# Google Drive file ID for paperpile.bib
DRIVE_FILE_ID = "1UtOxQ8-IxaNU5B-rCEXrLuuq5FHgM-gP"
LOCAL_BIB = os.path.expanduser("~/.hermes/paperpile.bib")
CACHE_PATH = LOCAL_BIB + ".cache.pkl"
TOKEN_PATH = os.path.expanduser("~/.hermes/google_token.json")


def get_drive_service():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    creds = Credentials.from_authorized_user_file(TOKEN_PATH)
    return build('drive', 'v3', credentials=creds)


def get_remote_modified(service):
    """Get the last modified time of the remote file."""
    meta = service.files().get(fileId=DRIVE_FILE_ID, fields="modifiedTime,size").execute()
    mod_time = datetime.fromisoformat(meta["modifiedTime"].replace("Z", "+00:00"))
    size = int(meta.get("size", 0))
    return mod_time, size


def get_local_modified():
    """Get the last modified time of the local file."""
    if not os.path.exists(LOCAL_BIB):
        return None
    mtime = os.path.getmtime(LOCAL_BIB)
    return datetime.fromtimestamp(mtime, tz=timezone.utc)


def download(service):
    """Download the bib file from Drive."""
    from googleapiclient.http import MediaIoBaseDownload
    import io

    request = service.files().get_media(fileId=DRIVE_FILE_ID)
    fh = io.BytesIO()
    downloader = MediaIoBaseDownload(fh, request)

    done = False
    while not done:
        status, done = downloader.next_chunk()

    content = fh.getvalue()
    with open(LOCAL_BIB, "wb") as f:
        f.write(content)

    # Invalidate the search cache
    if os.path.exists(CACHE_PATH):
        os.remove(CACHE_PATH)

    return len(content)


def count_entries(path):
    """Quick count of @ entries."""
    count = 0
    with open(path, "r", errors="replace") as f:
        for line in f:
            if line.startswith("@"):
                count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description="Sync Paperpile BibTeX from Google Drive")
    parser.add_argument("--force", action="store_true", help="Force download even if local is newer")
    parser.add_argument("--check", action="store_true", help="Just check if update available")
    args = parser.parse_args()

    service = get_drive_service()
    remote_time, remote_size = get_remote_modified(service)
    local_time = get_local_modified()

    print(f"Remote: {remote_time.strftime('%Y-%m-%d %H:%M:%S UTC')} ({remote_size:,} bytes)")
    if local_time:
        print(f"Local:  {local_time.strftime('%Y-%m-%d %H:%M:%S UTC')} ({os.path.getsize(LOCAL_BIB):,} bytes)")
    else:
        print("Local:  not found")

    needs_update = local_time is None or remote_time > local_time

    if args.check:
        if needs_update:
            print("STATUS: Update available")
        else:
            print("STATUS: Up to date")
        return

    if not needs_update and not args.force:
        print("Already up to date. Use --force to re-download.")
        return

    print("Downloading...")
    size = download(service)
    entries = count_entries(LOCAL_BIB)
    print(f"Downloaded {size:,} bytes — {entries:,} entries")
    print("Search cache invalidated.")


if __name__ == "__main__":
    main()
