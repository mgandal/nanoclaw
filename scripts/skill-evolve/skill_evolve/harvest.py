"""Extract real user prompts from session transcripts.

Per spec C8: filters [SCHEDULED TASK ...] wrappers. Per N5: PII
redaction on output (emails, phone numbers).

A "real prompt" = first user message of a session whose subsequent
assistant turns include a wiki write tool_use. Returns most-recent N.
"""
from __future__ import annotations
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
PHONE_RE = re.compile(r"\b\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
WIKI_PATH_MARKER = "98-nanoKB/wiki"
WRITE_TOOL_NAMES = {"Write", "Edit", "NotebookEdit"}
SCHEDULED_TASK_PREFIX = "[SCHEDULED TASK"


@dataclass
class RealPrompt:
    session_id: str
    prompt: str
    source_path: Path


# TODO(v2): consider redacting `sk-...` API keys and `/Users/<name>/` paths
# (out of v1 spec scope; spec N5 = emails + phones only).
def _redact(text: str) -> str:
    text = EMAIL_RE.sub("[REDACTED_EMAIL]", text)
    text = PHONE_RE.sub("[REDACTED_PHONE]", text)
    return text


def _session_writes_wiki(events: list[dict]) -> bool:
    for event in events:
        if event.get("type") != "assistant":
            continue
        content = event.get("message", {}).get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if (
                isinstance(block, dict)
                and block.get("type") == "tool_use"
                and block.get("name") in WRITE_TOOL_NAMES
                and isinstance(block.get("input"), dict)
                and WIKI_PATH_MARKER in str(block.get("input", {}).get("file_path", ""))
            ):
                return True
    return False


def _first_user_message(events: list[dict]) -> str | None:
    for event in events:
        if event.get("type") != "user":
            continue
        content = event.get("message", {}).get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    return block.get("text", "")
        # Fall through to next user event if this one has no extractable text
        continue
    return None


def harvest_real_prompts(jsonl_paths: Iterable[Path], limit: int) -> list[RealPrompt]:
    paths = sorted(jsonl_paths, key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    out: list[RealPrompt] = []
    for path in paths:
        if len(out) >= limit:
            break
        if not path.exists():
            continue
        events: list[dict] = []
        for line in path.read_text(errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        first = _first_user_message(events)
        if not first or first.lstrip().startswith(SCHEDULED_TASK_PREFIX):
            continue
        if not _session_writes_wiki(events):
            continue
        out.append(RealPrompt(
            session_id=path.stem,
            prompt=_redact(first),
            source_path=path,
        ))
    return out
