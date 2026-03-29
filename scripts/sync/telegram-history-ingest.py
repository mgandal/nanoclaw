#!/usr/bin/env python3
"""Ingest Telegram message history from NanoClaw DB into SimpleMem.

Reads messages from store/messages.db, groups them by chat, and stores
them in SimpleMem via memory_add_batch. Tracks last-ingested rowid
to avoid re-ingesting on subsequent runs.

Usage:
    python3 telegram-history-ingest.py [--dry-run] [--max-messages N]
"""

import argparse
import json
import logging
import os
import sqlite3
import sys
import time
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
NANOCLAW_DIR = SCRIPT_DIR.parent.parent
ENV_FILE = NANOCLAW_DIR / ".env"
DB_FILE = NANOCLAW_DIR / "store" / "messages.db"
STATE_FILE = SCRIPT_DIR / "telegram-history-state.json"

# Group chat JIDs to human-readable names (for context in memories)
CHAT_NAMES = {
    "tg:8475020901": "Claire (personal DM)",
    "tg:-1003784461672": "CODE-claw",
    "tg:-1003892106437": "LAB-claw",
    "tg:-1003835885233": "SCIENCE-claw",
    "tg:-1003751503376": "HOME-claw",
    "tg:-5003377951": "VAULT-claw",
    "tg:-5232801854": "LAB-claw (legacy)",
    "tg:-5120694221": "CODE-claw (legacy)",
    "tg:-1003617335658": "Claire-calendar",
    "tg:-1003402925171": "Claire-inbox",
    "tg:-5135739930": "Claire-scholar",
}

BATCH_SIZE = 3
BATCH_DELAY = 1.0
REQUEST_TIMEOUT = 300

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("telegram-history-ingest")


def load_simplemem_config():
    """Parse SIMPLEMEM_URL from nanoclaw .env."""
    if not ENV_FILE.exists():
        log.error("No .env file at %s", ENV_FILE)
        sys.exit(1)

    simplemem_url = None
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line.startswith("SIMPLEMEM_URL="):
                simplemem_url = line.split("=", 1)[1].strip()
                break

    if not simplemem_url:
        log.error("SIMPLEMEM_URL not found in .env")
        sys.exit(1)

    from urllib.parse import parse_qs, urlparse

    parsed = urlparse(simplemem_url)
    token = parse_qs(parsed.query).get("token", [""])[0]
    base_url = f"{parsed.scheme}://{parsed.hostname}:{parsed.port}/mcp/message"

    return base_url, token


def create_session(base_url, token):
    """Initialize MCP session."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
    }

    resp = requests.post(
        base_url,
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "telegram-history-ingest", "version": "1.0"},
            },
        },
        timeout=30,
    )

    session_id = resp.headers.get("Mcp-Session-Id")
    return session_id or "none", headers


def call_tool(base_url, headers, session_id, tool_name, arguments, call_id=2):
    """Call a SimpleMem MCP tool."""
    hdrs = {**headers}
    if session_id and session_id != "none":
        hdrs["Mcp-Session-Id"] = session_id
    resp = requests.post(
        base_url,
        headers=hdrs,
        json={
            "jsonrpc": "2.0",
            "id": call_id,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        },
        timeout=REQUEST_TIMEOUT,
    )

    text = resp.text
    for line in text.split("\n"):
        if line.startswith("data: "):
            try:
                return json.loads(line[6:])
            except json.JSONDecodeError:
                pass

    try:
        return resp.json()
    except Exception:
        return {"error": text[:200]}


def load_state():
    """Load last-ingested rowid."""
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_rowid": 0, "last_run": None, "total_ingested": 0}


def save_state(state):
    """Persist state."""
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def fetch_messages(last_rowid, max_messages=0):
    """Fetch messages from NanoClaw DB newer than last_rowid.

    Returns list of (rowid, chat_jid, sender_name, content, timestamp, is_from_me) tuples.
    """
    if not DB_FILE.exists():
        log.error("Database not found: %s", DB_FILE)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_FILE))
    conn.execute("PRAGMA journal_mode=WAL")

    query = """
        SELECT rowid, chat_jid, sender_name, content, timestamp, is_from_me
        FROM messages
        WHERE rowid > ?
          AND is_bot_message = 0
          AND content IS NOT NULL
          AND content != ''
        ORDER BY rowid ASC
    """
    if max_messages > 0:
        query += f" LIMIT {max_messages}"

    cursor = conn.execute(query, (last_rowid,))
    rows = cursor.fetchall()
    conn.close()

    return rows


def format_message(chat_jid, sender_name, content, timestamp, is_from_me):
    """Format a Telegram message for SimpleMem ingestion."""
    chat_name = CHAT_NAMES.get(chat_jid, chat_jid)
    speaker = sender_name or ("Mike" if is_from_me else "Unknown")

    # Add chat context to the content
    text = f"[Telegram/{chat_name}] {content}"

    return {"speaker": speaker, "content": text, "timestamp": timestamp}


def main():
    parser = argparse.ArgumentParser(
        description="Ingest Telegram message history into SimpleMem"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Parse and report without ingesting"
    )
    parser.add_argument(
        "--max-messages",
        type=int,
        default=0,
        help="Max messages to ingest per run (0 = unlimited)",
    )
    args = parser.parse_args()

    state = load_state()
    last_rowid = state.get("last_rowid", 0)

    rows = fetch_messages(last_rowid, max_messages=args.max_messages)
    log.info("Found %d new messages since rowid %d", len(rows), last_rowid)

    if not rows:
        log.info("Nothing to ingest")
        return

    if args.dry_run:
        for rowid, chat_jid, sender_name, content, timestamp, is_from_me in rows[:10]:
            chat_name = CHAT_NAMES.get(chat_jid, chat_jid)
            preview = (content or "")[:80].replace("\n", " ")
            log.info(
                "  [DRY RUN] rowid=%d %s %s: %s",
                rowid,
                chat_name,
                sender_name or "?",
                preview,
            )
        if len(rows) > 10:
            log.info("  ... and %d more", len(rows) - 10)
        return

    # Connect to SimpleMem
    base_url, token = load_simplemem_config()
    try:
        mcp_session_id, headers = create_session(base_url, token)
    except Exception as e:
        log.error("Failed to connect to SimpleMem: %s", e)
        sys.exit(1)
    log.info("Connected to SimpleMem")

    ingested = 0
    max_rowid = last_rowid

    # Batch messages
    batch = []
    batch_max_rowid = last_rowid

    for rowid, chat_jid, sender_name, content, timestamp, is_from_me in rows:
        dialogue = format_message(chat_jid, sender_name, content, timestamp, is_from_me)
        batch.append(dialogue)
        batch_max_rowid = rowid

        if len(batch) >= BATCH_SIZE:
            try:
                result = call_tool(
                    base_url,
                    headers,
                    mcp_session_id,
                    "memory_add_batch",
                    {"dialogues": batch},
                    call_id=100 + ingested,
                )
                if result and not result.get("error"):
                    ingested += len(batch)
                    max_rowid = batch_max_rowid
                else:
                    log.warning("Batch error: %s", str(result)[:200])
                    # Fall back to individual adds
                    for d in batch:
                        try:
                            r = call_tool(
                                base_url,
                                headers,
                                mcp_session_id,
                                "memory_add",
                                d,
                                call_id=200 + ingested,
                            )
                            if r and not r.get("error"):
                                ingested += 1
                                max_rowid = batch_max_rowid
                        except Exception as e:
                            log.warning("memory_add failed: %s", e)
            except Exception as e:
                log.warning("Batch failed: %s", e)

            batch = []
            if ingested > 0 and ingested % 50 == 0:
                log.info("  Progress: %d/%d messages ingested", ingested, len(rows))
            time.sleep(BATCH_DELAY)

    # Final partial batch
    if batch:
        try:
            result = call_tool(
                base_url,
                headers,
                mcp_session_id,
                "memory_add_batch",
                {"dialogues": batch},
                call_id=100 + ingested,
            )
            if result and not result.get("error"):
                ingested += len(batch)
                max_rowid = batch_max_rowid
        except Exception as e:
            log.warning("Final batch failed: %s", e)

    # Update state
    if max_rowid > last_rowid:
        state["last_rowid"] = max_rowid
    state["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    state["total_ingested"] = state.get("total_ingested", 0) + ingested
    save_state(state)

    log.info("Done: %d messages ingested, last rowid: %d", ingested, max_rowid)


if __name__ == "__main__":
    main()
