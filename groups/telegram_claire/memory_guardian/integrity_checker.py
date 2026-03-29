"""
NanoClaw Memory Integrity Checker

Checks all registered NanoClaw groups for memory health:
  1. CLAUDE.md has required section markers
  2. memory.md exists
  3. memory.md is fresh (modified within max_age_hours)

Usage:
  python3 integrity_checker.py              # check all groups
  python3 integrity_checker.py --group telegram_claire  # check one group

Output: JSON report to stdout
"""

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

GROUPS_DIR = Path(os.environ.get("MEMORY_GUARDIAN_GROUPS_DIR", "/workspace/project/groups"))
GLOBAL_CLAUDE_MD = GROUPS_DIR / "global" / "CLAUDE.md"

DEFAULT_MAX_AGE_HOURS = 96  # 4 days — tolerates quiet weekends

# Directories that are not agent groups
_SKIP_DIRS = {"global", "main"}


def discover_groups() -> list[str]:
    """Auto-discover group folders by scanning GROUPS_DIR for channel-prefixed directories."""
    try:
        return sorted(
            d.name for d in GROUPS_DIR.iterdir()
            if d.is_dir() and "_" in d.name and d.name not in _SKIP_DIRS
        )
    except OSError:
        return []


GROUPS = discover_groups()

REQUIRED_SECTIONS = [
    "Session Start Protocol",
    "Research Before Asking",
]


def _read_global_claude_md() -> str:
    """Return global CLAUDE.md content, or empty string if it does not exist."""
    try:
        if GLOBAL_CLAUDE_MD.exists():
            return GLOBAL_CLAUDE_MD.read_text()
    except OSError:
        pass
    return ""


def check_claude_md_sections(group_folder: str) -> list[str]:
    """
    Check that CLAUDE.md exists and contains all required section markers.

    A marker is satisfied if it appears in the per-group CLAUDE.md OR in the
    global CLAUDE.md at GLOBAL_CLAUDE_MD (which the runtime loads for all groups).
    If the global file does not exist it is treated as empty — the per-group file
    must then supply all required markers on its own.

    Returns list of issue strings, empty if all good.
    """
    issues = []
    claude_md = GROUPS_DIR / group_folder / "CLAUDE.md"

    try:
        if not claude_md.exists():
            issues.append(
                f"{group_folder}: CLAUDE.md not found at {claude_md}"
            )
            return issues

        group_content = claude_md.read_text()
    except OSError as exc:
        issues.append(f"{group_folder}: CLAUDE.md could not be read — {exc}")
        return issues

    global_content = _read_global_claude_md()
    combined_content = group_content + "\n" + global_content

    for marker in REQUIRED_SECTIONS:
        if marker not in combined_content:
            issues.append(
                f"{group_folder}: CLAUDE.md is missing required section: '{marker}' "
                f"(checked per-group file and global CLAUDE.md)"
            )

    return issues


def check_memory_exists(group_folder: str) -> list[str]:
    """
    Check that memory.md exists for the group.
    Returns list of issue strings, empty if all good.
    """
    issues = []
    memory_md = GROUPS_DIR / group_folder / "memory.md"

    try:
        if not memory_md.exists():
            issues.append(
                f"{group_folder}: memory.md not found at {memory_md}"
            )
    except OSError as exc:
        issues.append(f"{group_folder}: memory.md could not be checked — {exc}")

    return issues


def check_memory_freshness(group_folder: str, max_age_hours: int = DEFAULT_MAX_AGE_HOURS) -> list[str]:
    """
    Check that memory.md was modified within max_age_hours.
    Uses UTC throughout to avoid issues with host timezone changes.
    Returns list of issue strings, empty if all good.
    """
    issues = []
    memory_md = GROUPS_DIR / group_folder / "memory.md"

    if not memory_md.exists():
        issues.append(
            f"{group_folder}: memory.md not found — cannot check freshness"
        )
        return issues

    try:
        stat = memory_md.stat()
    except OSError as exc:
        issues.append(f"{group_folder}: memory.md stat failed — {exc}")
        return issues

    mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
    now = datetime.now(tz=timezone.utc)
    age_hours = (now - mtime).total_seconds() / 3600

    if age_hours > max_age_hours:
        issues.append(
            f"{group_folder}: memory.md is stale — last modified {age_hours:.1f}h ago "
            f"(max allowed: {max_age_hours}h)"
        )

    return issues


def run_all_checks(groups: list[str] | None = None) -> dict:
    """
    Run all integrity checks across all (or specified) groups.

    Returns:
    {
      "timestamp": "2026-03-28T17:00:00+00:00",
      "has_failures": bool,
      "groups": {
        "telegram_claire": {"status": "PASS"|"FAIL", "issues": [...]},
        ...
      }
    }
    """
    if groups is None:
        groups = GROUPS

    timestamp = datetime.now(tz=timezone.utc).isoformat(timespec="seconds")
    group_results = {}

    for group in groups:
        all_issues = []
        all_issues.extend(check_claude_md_sections(group))

        memory_issues = check_memory_exists(group)
        all_issues.extend(memory_issues)
        # Only run freshness check if memory.md was found — avoids duplicate
        # "file not found" messages from two separate checks.
        if not memory_issues:
            all_issues.extend(check_memory_freshness(group))

        status = "FAIL" if all_issues else "PASS"
        group_results[group] = {
            "status": status,
            "issues": all_issues,
        }

    has_failures = any(
        g["status"] == "FAIL" for g in group_results.values()
    )

    return {
        "timestamp": timestamp,
        "has_failures": has_failures,
        "groups": group_results,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NanoClaw memory integrity checker")
    parser.add_argument("--group", help="Check a single group instead of all")
    args = parser.parse_args()

    report = run_all_checks(groups=[args.group] if args.group else None)
    print(json.dumps(report, indent=2))
