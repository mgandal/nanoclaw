#!/usr/bin/env python3
"""Slack message ingest — pulls last N hours via MCP, exports to QMD.

Architecture: the bot's OAuth scopes don't expose channels.list/conversations.history
to enumerate, but conversations_search_messages works workspace-wide. So we sweep
by date window. Output groups by channel into ~/.cache/slack-ingest/exported/{channel}/{date}.md.

Usage:
    python3 slack-ingest.py                   # Incremental since last run
    python3 slack-ingest.py --hours 24        # Force-window override
    python3 slack-ingest.py --backfill 7      # Seed last 7 days
    python3 slack-ingest.py --status          # Show state + counts
"""

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

CACHE_DIR = Path(os.environ.get("SLACK_INGEST_DIR", "~/.cache/slack-ingest")).expanduser()
EXPORT_DIR = CACHE_DIR / "exported"
STATE_FILE = CACHE_DIR / "state.json"
LOG_FILE = CACHE_DIR / "ingest.log"

# Slack MCP endpoint — same value the containers see, but we run on host
SLACK_MCP_URL = os.environ.get("SLACK_MCP_URL", "http://localhost:8190/mcp")

# Per-call result cap. Search API tops out around 1000.
PAGE_SIZE = 100
MAX_PAGES = 20  # 2,000 messages per run is plenty for daily

DEFAULT_LOOKBACK_HOURS = 26  # 24h + slop, idempotent via msg dedup

# Filename safety
_SAFE = re.compile(r"[^a-zA-Z0-9_.-]+")


def safe_name(s: str) -> str:
    s = s.lstrip("#@")
    return _SAFE.sub("-", s).strip("-").lower() or "unknown"


def setup_logging():
    CACHE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    handlers = [logging.StreamHandler(), logging.FileHandler(LOG_FILE, mode="a")]
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )


log = logging.getLogger("slack-ingest")


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            log.warning("Corrupt state file, starting fresh")
    return {"last_run": None, "seen_ts": []}


def save_state(state: dict):
    # Trim seen_ts so it doesn't grow forever — keep ~30 days worth
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).timestamp()
    state["seen_ts"] = [ts for ts in state.get("seen_ts", []) if float(ts) > cutoff]
    STATE_FILE.write_text(json.dumps(state, indent=2))


# Transient HTTP errors we retry. Slack MCP 1.1.28 hangs and closes sockets
# mid-response under concurrent cache rebuild — see Apr 20 incident.
_RETRYABLE = (
    requests.exceptions.ConnectionError,
    requests.exceptions.ChunkedEncodingError,
    requests.exceptions.Timeout,
    requests.exceptions.ReadTimeout,
)

MAX_RETRIES = 4  # 4 tries across ~15s before bouncing the MCP server
MCP_LAUNCHD_LABEL = os.environ.get("SLACK_MCP_LAUNCHD_LABEL", "com.slack-mcp")


def _bounce_mcp_server() -> bool:
    """Restart Slack MCP via launchd. Returns True on success.

    Only called after retries are exhausted — recovers from a fully wedged
    server (Apr 20 failure mode: HTTP handler stuck, TCP accept still works).
    """
    uid = os.getuid()
    cmd = ["launchctl", "kickstart", "-k", f"gui/{uid}/{MCP_LAUNCHD_LABEL}"]
    try:
        log.warning("Bouncing Slack MCP via: %s", " ".join(cmd))
        subprocess.run(cmd, check=True, capture_output=True, timeout=10)
        # Give the server a few seconds to rebind and warm caches
        time.sleep(5)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        log.error("Failed to bounce Slack MCP: %s", e)
        return False


def _single_mcp_call(method: str, params: dict, timeout: int) -> dict:
    body = {"jsonrpc": "2.0", "method": method, "params": params, "id": int(time.time() * 1000)}
    r = requests.post(
        SLACK_MCP_URL,
        json=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        timeout=timeout,
    )
    r.raise_for_status()
    # Response is "event: message\ndata: {json}\n"
    text = r.text
    m = re.search(r"data:\s*(\{.+\})", text, re.DOTALL)
    if not m:
        raise RuntimeError(f"Unexpected MCP response: {text[:200]}")
    return json.loads(m.group(1))


def mcp_call(method: str, params: dict, timeout: int = 30) -> dict:
    """Invoke an MCP method with retry + server-bounce self-healing.

    Retry schedule: 1s, 2s, 4s (exponential). After MAX_RETRIES consecutive
    transient failures, bounce the MCP server via launchd and try once more.
    """
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            return _single_mcp_call(method, params, timeout)
        except _RETRYABLE as e:
            last_err = e
            if attempt < MAX_RETRIES - 1:
                backoff = 2**attempt  # 1, 2, 4s
                log.warning("MCP %s failed (attempt %d/%d): %s — retrying in %ds",
                            method, attempt + 1, MAX_RETRIES, type(e).__name__, backoff)
                time.sleep(backoff)

    # All retries exhausted — try a server bounce + one final attempt
    log.error("MCP %s exhausted %d retries; attempting server bounce", method, MAX_RETRIES)
    if _bounce_mcp_server():
        try:
            return _single_mcp_call(method, params, timeout)
        except _RETRYABLE as e:
            last_err = e
            log.error("MCP %s still failing after server bounce: %s", method, type(e).__name__)

    raise last_err if last_err else RuntimeError(f"MCP {method} failed with unknown error")


def parse_csv_result(result: dict) -> list[dict]:
    """The Slack MCP returns CSV in result.content[0].text. Parse to dicts."""
    content = result.get("result", {}).get("content", [])
    if not content:
        return []
    csv_text = content[0].get("text", "")
    lines = csv_text.strip().split("\n")
    if len(lines) < 2:
        return []
    # Naive CSV parse — Slack MCP doesn't quote-escape commas inside text fields cleanly,
    # but the field count is fixed. Use first line as schema, take first N-1 commas as
    # field separators, lump the rest as the message text.
    import csv
    from io import StringIO

    rows = list(csv.DictReader(StringIO(csv_text)))
    return rows


_USER_BY_ID: dict[str, str] = {}
_CACHE_LOADED = False
SLACK_CACHE_DIR = Path("~/Library/Caches/slack-mcp-server").expanduser()


def _load_user_cache():
    """Load Slack user ID→name mapping from the slack-mcp-server cache file.

    The MCP's users_search rejects raw IDs as queries, so we read the cache
    file directly. This is faster, doesn't burn rate limit, and works even
    when the MCP server is in cache-warmup state.
    """
    global _CACHE_LOADED
    if _CACHE_LOADED:
        return
    _CACHE_LOADED = True
    cache_file = SLACK_CACHE_DIR / "users_cache.json"
    if not cache_file.exists():
        log.warning("Slack user cache not found at %s — DM channel names will stay as IDs", cache_file)
        return
    try:
        users = json.loads(cache_file.read_text())
        for u in users:
            uid = u.get("id")
            name = u.get("name") or u.get("real_name") or uid
            if uid:
                _USER_BY_ID[uid] = name
        log.info("Loaded %d Slack users from cache", len(_USER_BY_ID))
    except Exception as e:
        log.warning("Failed to load user cache: %s", e)


def normalize_channel(channel: str) -> str:
    """Convert '#U0677M0R3KQ' (a DM as user ID) into 'dm-username'."""
    if not channel:
        return "unknown"
    _load_user_cache()
    bare = channel.lstrip("#@")
    # DMs come back as "#<UserID>" — start with U/W, ~9-11 alnum chars, all upper
    if bare and bare[0] in "UW" and bare.isalnum() and bare.isupper() and 9 <= len(bare) <= 12:
        username = _USER_BY_ID.get(bare)
        if username:
            return f"dm-{username}"
    return channel


def search_messages(query: str, count: int, cursor: str | None = None) -> tuple[list[dict], str | None]:
    """Run conversations_search_messages, return (rows, next_cursor)."""
    args = {"search_query": query, "count": count}
    if cursor:
        args["cursor"] = cursor
    resp = mcp_call("tools/call", {"name": "conversations_search_messages", "arguments": args})
    if resp.get("result", {}).get("isError"):
        log.error("Search error: %s", resp)
        return [], None
    rows = parse_csv_result(resp)
    # Cursor is the last column of the last row (per the CSV header)
    next_cursor = rows[-1].get("Cursor") if rows and rows[-1].get("Cursor") else None
    return rows, next_cursor


def fetch_window(start_dt: datetime, end_dt: datetime) -> list[dict]:
    """Pull all messages between start_dt and end_dt via search.

    The Slack MCP exposes conversations_search_messages but not a clean
    history enumerator. After probing query operators against slack-mcp-server
    1.1.28, only `"*"` returned the full message stream — `after:`/`before:`
    operators silently filter incorrectly or return zero. So we pull the
    "everything" stream and post-filter by timestamp.
    """
    query = "*"
    log.info("Searching: %s (window: %s → %s)", query, start_dt.isoformat(), end_dt.isoformat())

    all_rows: list[dict] = []
    cursor = None
    for page in range(MAX_PAGES):
        rows, cursor = search_messages(query, PAGE_SIZE, cursor)
        if not rows:
            break
        all_rows.extend(rows)
        log.info("Page %d: +%d rows (total %d, cursor=%s)", page + 1, len(rows), len(all_rows), bool(cursor))
        if not cursor:
            break
        time.sleep(0.5)  # gentle on rate limit

    # Filter to actual window (search returns full days)
    start_ts = start_dt.timestamp()
    end_ts = end_dt.timestamp()
    filtered = []
    for row in all_rows:
        try:
            # Time field is ISO 8601
            t = row.get("Time", "")
            if not t:
                continue
            msg_dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
            if start_ts <= msg_dt.timestamp() <= end_ts:
                filtered.append(row)
        except (ValueError, TypeError):
            continue

    log.info("After window filter: %d → %d", len(all_rows), len(filtered))
    return filtered


def export_messages(rows: list[dict], state: dict) -> int:
    """Group by (channel, date) and append to per-day markdown files. Dedup on MsgID."""
    seen = set(state.get("seen_ts", []))
    by_bucket: dict[tuple[str, str], list[dict]] = {}
    skipped = 0

    for row in rows:
        msg_id = row.get("MsgID", "")
        if msg_id in seen:
            skipped += 1
            continue
        channel = normalize_channel(row.get("Channel", "unknown") or "unknown")
        time_str = row.get("Time", "")
        if not time_str:
            continue
        date_str = time_str.split("T")[0]
        key = (channel, date_str)
        by_bucket.setdefault(key, []).append(row)
        seen.add(msg_id)

    written = 0
    for (channel, date_str), msgs in by_bucket.items():
        chan_dir = EXPORT_DIR / safe_name(channel)
        chan_dir.mkdir(parents=True, exist_ok=True)
        out = chan_dir / f"{date_str}.md"

        # Append mode: prepend frontmatter only if file is new
        is_new = not out.exists()
        with out.open("a") as f:
            if is_new:
                f.write("---\n")
                f.write(f'channel: "{channel}"\n')
                f.write(f"date: {date_str}\n")
                f.write("source: slack\n")
                f.write(f"tags: [slack, {safe_name(channel)}]\n")
                f.write("---\n\n")
                f.write(f"# {channel} — {date_str}\n\n")

            # Sort by time
            msgs_sorted = sorted(msgs, key=lambda m: m.get("Time", ""))
            for msg in msgs_sorted:
                user = msg.get("UserName") or msg.get("RealName") or msg.get("UserID") or "unknown"
                t = msg.get("Time", "")[11:16]  # HH:MM
                text = msg.get("Text", "").replace("\n", " ").strip()
                if not text:
                    continue
                f.write(f"**{t} {user}:** {text}\n\n")
                written += 1

    state["seen_ts"] = list(seen)
    log.info("Wrote %d messages to %d files (%d dedup-skipped)", written, len(by_bucket), skipped)
    return written


def cmd_status(state: dict):
    print(f"State: {STATE_FILE}")
    print(f"  last_run: {state.get('last_run', 'never')}")
    print(f"  seen_ts:  {len(state.get('seen_ts', []))} message IDs cached")
    print(f"\nExports: {EXPORT_DIR}")
    if EXPORT_DIR.exists():
        chans = sorted(EXPORT_DIR.iterdir())
        print(f"  {len(chans)} channels indexed")
        for ch in chans[:20]:
            files = list(ch.glob("*.md"))
            if files:
                latest = max(f.stat().st_mtime for f in files)
                print(f"    {ch.name}: {len(files)} days, latest {datetime.fromtimestamp(latest):%Y-%m-%d %H:%M}")
        if len(chans) > 20:
            print(f"    ... +{len(chans) - 20} more")


def main():
    parser = argparse.ArgumentParser(description="Slack message ingest")
    parser.add_argument("--hours", type=int, default=None, help="Look back N hours")
    parser.add_argument("--backfill", type=int, default=None, help="Backfill N days")
    parser.add_argument("--status", action="store_true", help="Show state + exit")
    args = parser.parse_args()

    setup_logging()
    state = load_state()

    if args.status:
        cmd_status(state)
        return 0

    now = datetime.now(timezone.utc)

    if args.backfill:
        start = now - timedelta(days=args.backfill)
    elif args.hours:
        start = now - timedelta(hours=args.hours)
    elif state.get("last_run"):
        last = datetime.fromisoformat(state["last_run"])
        # Slop: re-fetch last 2h to catch late edits + reactions
        start = last - timedelta(hours=2)
    else:
        start = now - timedelta(hours=DEFAULT_LOOKBACK_HOURS)

    log.info("Window: %s → %s (%.1f hours)", start.isoformat(), now.isoformat(), (now - start).total_seconds() / 3600)

    try:
        rows = fetch_window(start, now)
    except Exception as e:
        log.exception("Fetch failed: %s", e)
        return 1

    if rows:
        export_messages(rows, state)
    else:
        log.info("No messages in window")

    state["last_run"] = now.isoformat()
    save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
