#!/usr/bin/env python3
"""Ingest Apple Notes into SimpleMem for long-term agent memory.

Reads exported markdown files from ~/.cache/apple-notes-mcp/exported/,
formats them as memories, and batch-adds to SimpleMem via its MCP API.
Tracks ingested files via a state file to avoid re-ingesting on each run.

Usage:
    python3 apple-notes-ingest.py
"""

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
STATE_FILE = SCRIPT_DIR / "apple-notes-ingest-state.json"
NOTES_DIR = Path.home() / ".cache" / "apple-notes-mcp" / "exported"

# Limits
MAX_NOTE_CHARS = 2000  # Truncate long notes for memory storage
BATCH_PAUSE_SECS = 1  # Rate limit between batches (Ollama is slow)
MAX_PER_RUN = 50  # Max notes to ingest per run (SimpleMem LLM is slow)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("apple-notes-ingest")


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

    from urllib.parse import urlparse, parse_qs
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
    resp = requests.post(base_url, headers=headers, json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "apple-notes-ingest", "version": "1.0"},
        },
    }, timeout=10)
    session_id = resp.headers.get("Mcp-Session-Id", "none")
    return session_id, headers


def call_tool(base_url, headers, session_id, tool_name, arguments, call_id=2):
    """Call a SimpleMem MCP tool."""
    hdrs = {**headers}
    if session_id and session_id != "none":
        hdrs["Mcp-Session-Id"] = session_id
    resp = requests.post(base_url, headers=hdrs, json={
        "jsonrpc": "2.0",
        "id": call_id,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }, timeout=180)  # Ollama extraction can take 60-120s per note

    # Try direct JSON
    try:
        return resp.json()
    except Exception:
        # Parse SSE response
        for line in resp.text.split("\n"):
            if line.startswith("data: "):
                try:
                    return json.loads(line[6:])
                except json.JSONDecodeError:
                    pass
        return {"error": resp.text[:200]}


def load_state():
    """Load set of already-ingested file paths."""
    if STATE_FILE.exists():
        try:
            data = json.loads(STATE_FILE.read_text())
            return set(data.get("ingested_files", []))
        except Exception:
            pass
    return set()


def save_state(ingested_files):
    """Save set of ingested file paths."""
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "ingested_files": sorted(ingested_files),
        "last_run": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "count": len(ingested_files),
    }, indent=2))
    tmp.rename(STATE_FILE)


def format_note_for_memory(note_path, content):
    """Format a note as a memory entry for SimpleMem."""
    # Extract folder and filename for context
    rel_path = note_path.relative_to(NOTES_DIR)
    folder = rel_path.parent.name if rel_path.parent.name != "." else "Unfiled"

    # Extract title from first heading or filename
    title = rel_path.stem
    for line in content.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            title = line[2:].strip()
            break

    # Truncate content
    truncated = content[:MAX_NOTE_CHARS]
    if len(content) > MAX_NOTE_CHARS:
        truncated += f"\n... (truncated, {len(content)} chars total)"

    return f"[Apple Note] Folder: {folder} | Title: {title}\n{truncated}"


def main():
    if not NOTES_DIR.exists():
        log.error("Apple Notes export directory not found: %s", NOTES_DIR)
        log.error("Run the export script first: node ~/.cache/apple-notes-mcp/export-notes.js")
        sys.exit(1)

    # Find all markdown files
    all_notes = sorted(NOTES_DIR.rglob("*.md"))
    if not all_notes:
        log.info("No markdown files found in %s", NOTES_DIR)
        return

    # Load state to skip already-ingested notes
    ingested = load_state()
    new_notes = [n for n in all_notes if str(n) not in ingested]

    if not new_notes:
        log.info("All %d notes already ingested, nothing to do", len(all_notes))
        return

    if len(new_notes) > MAX_PER_RUN:
        log.info("Found %d total notes, %d new — limiting to %d this run",
                 len(all_notes), len(new_notes), MAX_PER_RUN)
        new_notes = new_notes[:MAX_PER_RUN]
    else:
        log.info("Found %d total notes, %d new to ingest", len(all_notes), len(new_notes))

    # Connect to SimpleMem
    base_url, token = load_simplemem_config()
    try:
        session_id, headers = create_session(base_url, token)
    except Exception as e:
        log.error("Failed to connect to SimpleMem: %s", e)
        sys.exit(1)

    log.info("Connected to SimpleMem (session: %s)", session_id[:8])

    # Ingest notes
    added = 0
    errors = 0
    for i, note_path in enumerate(new_notes):
        try:
            content = note_path.read_text(errors="replace")
            if not content.strip():
                ingested.add(str(note_path))
                continue

            memory_text = format_note_for_memory(note_path, content)

            result = call_tool(
                base_url, headers, session_id,
                "memory_add",
                {"speaker": "apple-notes-sync", "content": memory_text},
                call_id=100 + i,
            )

            if result and not result.get("error"):
                added += 1
                ingested.add(str(note_path))
            else:
                errors += 1
                log.warning("SimpleMem error for %s: %s",
                            note_path.name, str(result)[:200])

        except Exception as e:
            errors += 1
            log.warning("Failed to ingest %s: %s", note_path.name, e)

        # Progress and rate limiting
        if (i + 1) % 20 == 0:
            log.info("  Progress: %d/%d (added: %d, errors: %d)",
                      i + 1, len(new_notes), added, errors)
            save_state(ingested)  # Checkpoint
            time.sleep(BATCH_PAUSE_SECS)

    # Final save
    save_state(ingested)
    log.info("Done. Added: %d, Errors: %d, Total tracked: %d",
             added, errors, len(ingested))


if __name__ == "__main__":
    main()
