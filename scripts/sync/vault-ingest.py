#!/usr/bin/env python3
"""Ingest vault markdown summaries into SimpleMem for conversational recall.

Scans the Obsidian vault, extracts title + first 500 chars from each .md file,
and stores them as SimpleMem memories. Tracks ingested files by path+mtime
to avoid re-processing unchanged files.

Usage:
    python3 vault-ingest.py
"""

import json
import logging
import os
import re
import sys
import time
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
NANOCLAW_DIR = SCRIPT_DIR.parent.parent
ENV_FILE = NANOCLAW_DIR / ".env"
STATE_FILE = SCRIPT_DIR / "vault-ingest-state.json"
VAULT_PATH = Path("/Volumes/sandisk4TB/marvin-vault")

MAX_FILES_PER_RUN = 50
DELAY_BETWEEN_CALLS = 0.5  # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("vault-ingest")


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
    # Note: SimpleMem uses SSE MCP transport. GET /mcp/sse for stream, POST /mcp/message for calls.

    return base_url, token


def create_session(base_url, token):
    """Initialize MCP session and return session ID."""
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
                "clientInfo": {"name": "vault-ingest", "version": "1.0"},
            },
        },
    )

    session_id = resp.headers.get("Mcp-Session-Id", "none")
    return session_id, headers


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
    """Load ingestion state: {path: mtime} of previously ingested files."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_state(state):
    """Persist ingestion state."""
    STATE_FILE.write_text(json.dumps(state, indent=2))


def extract_title(content, filepath):
    """Extract title from YAML frontmatter or first heading, fallback to filename."""
    # Try YAML frontmatter
    if content.startswith("---"):
        end = content.find("---", 3)
        if end > 0:
            frontmatter = content[3:end]
            for line in frontmatter.split("\n"):
                if line.strip().startswith("title:"):
                    title = line.split(":", 1)[1].strip().strip("\"'")
                    if title:
                        return title

    # Try first markdown heading
    for line in content.split("\n")[:10]:
        if line.startswith("# "):
            return line[2:].strip()

    # Fallback to filename
    return filepath.stem.replace("-", " ").replace("_", " ")


def extract_body(content):
    """Extract body text, stripping YAML frontmatter."""
    body = content
    if body.startswith("---"):
        end = body.find("---", 3)
        if end > 0:
            body = body[end + 3 :]

    # Strip markdown links, images, and excessive whitespace
    body = re.sub(r"!\[.*?\]\(.*?\)", "", body)
    body = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", body)
    body = re.sub(r"\n{3,}", "\n\n", body)

    return body.strip()[:500]


def scan_vault():
    """Find all .md files in the vault, return list of (path, mtime)."""
    if not VAULT_PATH.exists():
        log.warning("Vault not found at %s", VAULT_PATH)
        return []

    files = []
    for md in VAULT_PATH.rglob("*.md"):
        # Skip hidden dirs, .obsidian, .pageindex, .trash
        parts = md.relative_to(VAULT_PATH).parts
        if any(p.startswith(".") for p in parts):
            continue
        try:
            mtime = md.stat().st_mtime
            files.append((md, mtime))
        except OSError:
            continue

    return files


def main():
    if not VAULT_PATH.exists():
        log.info("Vault path %s not found, skipping", VAULT_PATH)
        return

    base_url, token = load_simplemem_config()
    state = load_state()

    # Find files that need ingestion (new or modified)
    all_files = scan_vault()
    to_ingest = []
    for filepath, mtime in all_files:
        key = str(filepath)
        if key in state and abs(state[key] - mtime) < 1.0:
            continue  # Already ingested and unchanged
        to_ingest.append((filepath, mtime))

    if not to_ingest:
        log.info("No new/changed vault files to ingest (%d total indexed)", len(state))
        return

    log.info(
        "Found %d new/changed vault files (max %d per run)",
        len(to_ingest),
        MAX_FILES_PER_RUN,
    )
    to_ingest = to_ingest[:MAX_FILES_PER_RUN]

    # Create SimpleMem session
    session_id, headers = create_session(base_url, token)
    log.info("Connected to SimpleMem (session: %s)", session_id)

    ingested = 0
    for i, (filepath, mtime) in enumerate(to_ingest):
        try:
            content = filepath.read_text(encoding="utf-8", errors="replace")
            if len(content.strip()) < 50:
                # Skip near-empty files
                state[str(filepath)] = mtime
                continue

            title = extract_title(content, filepath)
            body = extract_body(content)

            # Format as a natural-language summary
            rel_path = filepath.relative_to(VAULT_PATH)
            memory_text = f"Knowledge note ({rel_path}): {title}. {body}"

            result = call_tool(
                base_url,
                headers,
                session_id,
                "memory_add",
                {"speaker": "vault-sync", "content": memory_text},
                call_id=100 + i,
            )

            if result and not result.get("error"):
                state[str(filepath)] = mtime
                ingested += 1
            else:
                log.warning("SimpleMem error for %s: %s", filepath.name, result)

            if ingested % 10 == 0 and ingested > 0:
                log.info("  Ingested %d/%d files", ingested, len(to_ingest))
                save_state(state)  # Checkpoint

            time.sleep(DELAY_BETWEEN_CALLS)

        except Exception as e:
            log.warning("Failed to process %s: %s", filepath.name, e)

    save_state(state)
    log.info(
        "Vault ingest complete: %d new files ingested, %d total tracked",
        ingested,
        len(state),
    )


if __name__ == "__main__":
    main()
