"""Count assistant-side wiki writes across session transcripts.

Per spec I8: counts assistant `tool_use` events with file_path under
98-nanoKB/wiki/, NOT user-side mentions (which include scheduled-task
wrappers and inherited routing instructions).
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Iterable

WRITE_TOOL_NAMES = {"Write", "Edit", "NotebookEdit"}
WIKI_PATH_MARKER = "98-nanoKB/wiki"


def count_wiki_writes(jsonl_paths: Iterable[Path]) -> int:
    total = 0
    for path in jsonl_paths:
        if not path.exists():
            continue
        for line in path.read_text(errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
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
                    and WIKI_PATH_MARKER in str(block.get("input", {}).get("file_path", ""))
                ):
                    total += 1
    return total


def liveness_report(sessions_dir: Path) -> dict[str, int]:
    """Per-group write counts. Returns {group_name: count}."""
    report: dict[str, int] = {}
    for group_dir in sessions_dir.iterdir():
        if not group_dir.is_dir():
            continue
        jsonls = list(group_dir.glob(".claude/projects/-workspace-group/*.jsonl"))
        report[group_dir.name] = count_wiki_writes(jsonls)
    return report
