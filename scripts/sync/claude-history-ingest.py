#!/usr/bin/env python3
"""Ingest Claude Code session history into SimpleMem for long-term agent memory.

Reads JSONL conversation files from ~/.claude/projects/, extracts user and
assistant messages, and stores them in SimpleMem via memory_add_batch. Each
session is ingested as a batch of speaker+content dialogues.

State is tracked in claude-history-state.json to avoid re-ingesting sessions.

Usage:
    python3 claude-history-ingest.py [--dry-run] [--max-sessions N] [--project FILTER]
"""

import argparse
import glob
import json
import logging
import os
import sys
import time
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
NANOCLAW_DIR = SCRIPT_DIR.parent.parent
ENV_FILE = NANOCLAW_DIR / ".env"
STATE_FILE = SCRIPT_DIR / "claude-history-state.json"
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

# Max characters per message content to avoid overwhelming SimpleMem's LLM
MAX_CONTENT_LENGTH = 2000
# How many dialogues per memory_add_batch call (LLM processes each ~20-25s)
BATCH_SIZE = 3
# Sleep between batches (seconds) — let SimpleMem's LLM catch up
BATCH_DELAY = 1.0
# HTTP request timeout (seconds) — batch of 3 takes ~2min, can be slower under load
REQUEST_TIMEOUT = 300
# Minimum messages in a session to bother ingesting
MIN_SESSION_MESSAGES = 3

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("claude-history-ingest")


def load_simplemem_config():
    """Parse SIMPLEMEM_URL from nanoclaw .env to get host, port, and token."""
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
    """Initialize MCP session and return session ID + headers."""
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
                "clientInfo": {"name": "claude-history-ingest", "version": "1.0"},
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

    # Parse SSE response
    text = resp.text
    for line in text.split("\n"):
        if line.startswith("data: "):
            try:
                return json.loads(line[6:])
            except json.JSONDecodeError:
                pass

    # Try direct JSON
    try:
        return resp.json()
    except Exception:
        return {"error": text[:200]}


def load_state():
    """Load set of already-ingested session IDs."""
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"ingested_sessions": [], "last_run": None, "total_ingested": 0}


def save_state(state):
    """Persist state to disk."""
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def extract_text_content(content):
    """Extract plain text from a message's content field.

    Content can be a string or a list of content blocks (text, tool_use, etc.).
    We only extract text blocks and skip tool_use/tool_result blocks.
    """
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    texts.append(block.get("text", ""))
                # Skip tool_use, tool_result, image blocks etc.
            elif isinstance(block, str):
                texts.append(block)
        return "\n".join(texts)

    return ""


def parse_session_file(filepath):
    """Parse a JSONL session file and extract user/assistant dialogue pairs.

    Returns:
        list of {speaker, content, timestamp} dicts, or None if too few messages.
    """
    dialogues = []
    project_name = None
    session_id = None

    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = entry.get("type")
            if msg_type not in ("user", "assistant"):
                continue

            message = entry.get("message", {})
            role = message.get("role", "")
            raw_content = message.get("content", "")
            timestamp = entry.get("timestamp", "")

            if not session_id:
                session_id = entry.get("sessionId", "")
            if not project_name:
                cwd = entry.get("cwd", "")
                if cwd:
                    project_name = os.path.basename(cwd)

            text = extract_text_content(raw_content)
            if not text or not text.strip():
                continue

            # Truncate very long messages (code outputs, file reads, etc.)
            if len(text) > MAX_CONTENT_LENGTH:
                text = text[:MAX_CONTENT_LENGTH] + "... [truncated]"

            speaker = "Mike" if role == "user" else "Claude"
            dialogues.append(
                {"speaker": speaker, "content": text, "timestamp": timestamp}
            )

    if len(dialogues) < MIN_SESSION_MESSAGES:
        return None, project_name, session_id

    return dialogues, project_name, session_id


def ingest_session(dialogues, project_name, session_id, base_url, headers, mcp_session_id, dry_run=False):
    """Ingest a single session's dialogues into SimpleMem."""
    if dry_run:
        log.info(
            "  [DRY RUN] Would ingest %d messages from session %s (%s)",
            len(dialogues),
            session_id[:12],
            project_name or "unknown",
        )
        return True

    ingested = 0
    # Batch dialogues
    for i in range(0, len(dialogues), BATCH_SIZE):
        batch = dialogues[i : i + BATCH_SIZE]

        # Add project context to first message of each batch
        batch_with_context = []
        for d in batch:
            entry = {"speaker": d["speaker"], "content": d["content"]}
            if d.get("timestamp"):
                entry["timestamp"] = d["timestamp"]
            batch_with_context.append(entry)

        try:
            result = call_tool(
                base_url,
                headers,
                mcp_session_id,
                "memory_add_batch",
                {"dialogues": batch_with_context},
                call_id=100 + i,
            )

            if result and not result.get("error"):
                ingested += len(batch)
            else:
                log.warning("  SimpleMem batch error: %s", str(result)[:200])
                # Fall back to individual memory_add calls
                for d in batch:
                    try:
                        r = call_tool(
                            base_url,
                            headers,
                            mcp_session_id,
                            "memory_add",
                            {
                                "speaker": d["speaker"],
                                "content": d["content"],
                                **({"timestamp": d["timestamp"]} if d.get("timestamp") else {}),
                            },
                            call_id=200 + ingested,
                        )
                        if r and not r.get("error"):
                            ingested += 1
                    except Exception as e:
                        log.warning("  memory_add failed: %s", e)

        except Exception as e:
            log.warning("  Batch call failed: %s", e)

        # Rate limit between batches
        if i + BATCH_SIZE < len(dialogues):
            time.sleep(BATCH_DELAY)

    log.info(
        "  Ingested %d/%d messages from %s (session %s)",
        ingested,
        len(dialogues),
        project_name or "unknown",
        session_id[:12] if session_id else "?",
    )
    return ingested > 0


def discover_sessions(project_filter=None):
    """Find all JSONL session files across all Claude Code projects.

    Returns list of (filepath, project_dir_name) sorted by modification time (oldest first).
    """
    if not CLAUDE_PROJECTS_DIR.exists():
        log.error("Claude projects dir not found: %s", CLAUDE_PROJECTS_DIR)
        return []

    sessions = []
    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        dir_name = project_dir.name
        if project_filter and project_filter.lower() not in dir_name.lower():
            continue

        for jsonl_file in project_dir.glob("*.jsonl"):
            mtime = jsonl_file.stat().st_mtime
            sessions.append((jsonl_file, dir_name, mtime))

    # Sort oldest first so we ingest chronologically
    sessions.sort(key=lambda x: x[2])
    return [(s[0], s[1]) for s in sessions]


def main():
    parser = argparse.ArgumentParser(
        description="Ingest Claude Code session history into SimpleMem"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and report without ingesting",
    )
    parser.add_argument(
        "--max-sessions",
        type=int,
        default=0,
        help="Max sessions to ingest per run (0 = unlimited)",
    )
    parser.add_argument(
        "--project",
        type=str,
        default=None,
        help="Filter to project dirs containing this string (e.g. 'nanoclaw')",
    )
    args = parser.parse_args()

    state = load_state()
    ingested_set = set(state.get("ingested_sessions", []))

    sessions = discover_sessions(project_filter=args.project)
    log.info("Found %d total session files across all projects", len(sessions))

    # Filter out already-ingested sessions
    pending = []
    for filepath, project_dir in sessions:
        session_filename = filepath.stem  # UUID is the filename
        if session_filename not in ingested_set:
            pending.append((filepath, project_dir, session_filename))

    log.info("%d sessions already ingested, %d pending", len(ingested_set), len(pending))

    if not pending:
        log.info("Nothing to ingest")
        return

    if args.max_sessions > 0:
        pending = pending[: args.max_sessions]
        log.info("Limiting to %d sessions this run", len(pending))

    # Connect to SimpleMem (unless dry run)
    mcp_session_id = None
    headers = None
    base_url = None
    if not args.dry_run:
        base_url, token = load_simplemem_config()
        try:
            mcp_session_id, headers = create_session(base_url, token)
        except Exception as e:
            log.error("Failed to connect to SimpleMem: %s", e)
            sys.exit(1)
        log.info("Connected to SimpleMem")

    sessions_ingested = 0
    total_messages = 0

    for filepath, project_dir, session_filename in pending:
        dialogues, project_name, session_id = parse_session_file(filepath)

        if dialogues is None:
            # Too few messages — mark as ingested to skip in future
            ingested_set.add(session_filename)
            continue

        log.info(
            "Processing: %s — %d messages (%s)",
            session_filename[:12],
            len(dialogues),
            project_name or project_dir,
        )

        success = ingest_session(
            dialogues,
            project_name or project_dir,
            session_id or session_filename,
            base_url,
            headers,
            mcp_session_id,
            dry_run=args.dry_run,
        )

        if success or args.dry_run:
            ingested_set.add(session_filename)
            sessions_ingested += 1
            total_messages += len(dialogues)

        # Save state after each session (resumable)
        state["ingested_sessions"] = sorted(ingested_set)
        state["total_ingested"] = len(ingested_set)
        state["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        save_state(state)

    log.info(
        "Done: %d sessions ingested, %d total messages",
        sessions_ingested,
        total_messages,
    )


if __name__ == "__main__":
    main()
