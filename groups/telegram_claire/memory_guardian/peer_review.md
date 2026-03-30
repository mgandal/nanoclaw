# Peer Review — memory_guardian/integrity_checker.py

**Reviewer:** Senior Software Engineer
**Date:** 2026-03-28
**Files reviewed:**
- `integrity_checker.py`
- `tests/test_integrity_checker.py`

---

## Summary

The checker is well-structured and its unit tests are cleanly written, but it has one critical correctness bug (global CLAUDE.md is ignored, causing false FAIL results on 4 of 6 groups) and one high-severity design flaw (48h staleness threshold will reliably false-positive every Monday morning after any quiet weekend). There are also several medium and low issues around error handling, configurability, and test coverage.

---

## Issue List

---

### CRITICAL-1 — Global CLAUDE.md not considered; 4 of 6 groups falsely FAIL

**Severity:** CRITICAL
**File:** `integrity_checker.py`, `check_claude_md_sections()`

**Description:**
The checker only looks at the per-group CLAUDE.md for required section markers. Required sections ("Session Start Protocol", "Research Before Asking") were added to the global CLAUDE.md at `/workspace/project/groups/global/CLAUDE.md`, which the runtime loads for all groups. A group does not need to repeat those sections in its own CLAUDE.md because they are already injected globally. The current checker does not know this, so any group relying on the global file for those sections will incorrectly fail.

Real-world impact: 4 of 6 groups (telegram_claire, telegram_code-claw, telegram_home-claw, telegram_vault-claw) produce false FAIL results.

**Proposed fix:**
Add a `GLOBAL_CLAUDE_MD` path constant. In `check_claude_md_sections()`, build the combined set of present markers by reading both the per-group file and the global file. A marker is considered satisfied if it appears in either file. If the global file does not exist, treat it as empty (do not error — the per-group file must then contain all markers on its own).

```python
GLOBAL_CLAUDE_MD = GROUPS_DIR / "global" / "CLAUDE.md"


def _read_global_claude_md() -> str:
    """Return global CLAUDE.md content, or empty string if it does not exist."""
    if GLOBAL_CLAUDE_MD.exists():
        return GLOBAL_CLAUDE_MD.read_text()
    return ""


def check_claude_md_sections(group_folder: str) -> list[str]:
    """
    Check that CLAUDE.md exists and contains all required section markers.
    A marker is satisfied if it appears in the per-group CLAUDE.md OR in the
    global CLAUDE.md (which is loaded for all groups at runtime).
    Returns list of issue strings, empty if all good.
    """
    issues = []
    claude_md = GROUPS_DIR / group_folder / "CLAUDE.md"

    if not claude_md.exists():
        issues.append(
            f"{group_folder}: CLAUDE.md not found at {claude_md}"
        )
        return issues

    group_content = claude_md.read_text()
    global_content = _read_global_claude_md()
    combined_content = group_content + "\n" + global_content

    for marker in REQUIRED_SECTIONS:
        if marker not in combined_content:
            issues.append(
                f"{group_folder}: CLAUDE.md is missing required section: '{marker}' "
                f"(checked per-group file and global CLAUDE.md)"
            )

    return issues
```

---

### HIGH-1 — 48h staleness threshold causes guaranteed false positives after weekends

**Severity:** HIGH
**File:** `integrity_checker.py`, `check_memory_freshness()`, default `max_age_hours=48`

**Description:**
Agents are not active on weekends (no messages, no memory writes). A 48-hour window means that any group quiet from Friday evening through Monday morning (roughly 60h) will fire a stale alert on Monday, every week, with no real problem to report. The alert loses credibility through repetition ("cry wolf" problem) and requires manual silencing each time.

The real signal is "has this group had a chance to write memory and simply hasn't?" not "has it been exactly 48 hours?". A more correct threshold is 96h (4 days), which tolerates a quiet weekend plus a buffer, while still catching groups that have genuinely gone silent for most of a working week.

Alternatively, a configurable per-group override would let operators tune thresholds without touching code.

**Proposed fix:**
Change the default from `48` to `96`. Update the constant and default parameter together so they stay in sync:

```python
DEFAULT_MAX_AGE_HOURS = 96  # 4 days — tolerates quiet weekends


def check_memory_freshness(group_folder: str, max_age_hours: int = DEFAULT_MAX_AGE_HOURS) -> list[str]:
    ...
```

This is a single-line-of-truth change. Any caller that passes an explicit `max_age_hours` is unaffected.

---

### MEDIUM-1 — `check_memory_freshness()` silently double-reports a missing file

**Severity:** MEDIUM
**File:** `integrity_checker.py`, `check_memory_freshness()`

**Description:**
`run_all_checks()` calls `check_memory_exists()` and `check_memory_freshness()` independently. When `memory.md` is absent, both functions return a "not found" issue. The final `issues` list for that group will contain two separate messages about the same missing file, making the output confusing.

```
telegram_code-claw: memory.md not found at ...
telegram_code-claw: memory.md not found — cannot check freshness
```

**Proposed fix (option A — preferred):** Have `run_all_checks()` skip the freshness check when the existence check already failed:

```python
memory_issues = check_memory_exists(group)
all_issues.extend(memory_issues)
if not memory_issues:
    all_issues.extend(check_memory_freshness(group))
```

**Proposed fix (option B):** Have `check_memory_freshness()` return an empty list (not an error) when the file is missing, since `check_memory_exists()` already owns that error message. This is cleaner API design — each function reports on exactly its own concern.

Option B keeps each function independently testable; option A keeps the logic centralised. Either works; the important thing is picking one.

---

### MEDIUM-2 — `GROUPS` list is a hardcoded constant, not derived from the filesystem

**Severity:** MEDIUM
**File:** `integrity_checker.py`, lines 19-26

**Description:**
New groups must be manually added to the `GROUPS` list. If a new group folder is created and the list is not updated, the checker will silently skip it. The inverse is also a problem: if a group is removed and the list is not updated, the checker will report spurious missing-file errors against a folder that no longer exists.

**Proposed fix:**
Derive the list dynamically at startup, or at minimum add a validation step that warns when a listed group folder does not exist on disk:

```python
# Dynamic discovery (simplest correct solution):
def discover_groups() -> list[str]:
    """Return all group folders under GROUPS_DIR, excluding 'global'."""
    if not GROUPS_DIR.exists():
        return []
    return sorted(
        d.name for d in GROUPS_DIR.iterdir()
        if d.is_dir() and d.name != "global"
    )
```

If auto-discovery is not desirable (e.g., to avoid checking non-Telegram groups), keep the static list but add an existence check at the top of `run_all_checks()` that logs a warning for any listed group whose folder does not exist, rather than failing silently or generating misleading file-not-found errors.

---

### MEDIUM-3 — No test for the global CLAUDE.md fallback (gap introduced by CRITICAL-1 fix)

**Severity:** MEDIUM
**File:** `tests/test_integrity_checker.py`

**Description:**
Once the global CLAUDE.md fix lands, there are no tests that exercise the fallback path. The following cases need coverage:

1. Section present only in global CLAUDE.md, absent from per-group — should PASS.
2. Section absent from both global and per-group — should FAIL.
3. Global CLAUDE.md does not exist — should fall back gracefully and still check per-group.
4. `run_all_checks()` integration: a group with minimal per-group CLAUDE.md passes because global supplies the missing section.

Proposed test code (to be added to `TestCheckClaudeMdSections`):

```python
def test_section_in_global_file_satisfies_check(self):
    """Section missing from per-group CLAUDE.md but present in global -> PASS"""
    import tempfile
    import integrity_checker

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        # Per-group file: has only one section
        group_dir = tmp_path / "telegram_code-claw"
        group_dir.mkdir(parents=True)
        (group_dir / "CLAUDE.md").write_text(
            "# Group\n\n## Research Before Asking\nSearch.\n"
        )

        # Global file: has the other section
        global_dir = tmp_path / "global"
        global_dir.mkdir(parents=True)
        (global_dir / "CLAUDE.md").write_text(
            "# Global\n\n## Session Start Protocol\nGlobal protocol.\n"
        )

        with patch("integrity_checker.GROUPS_DIR", tmp_path):
            with patch("integrity_checker.GLOBAL_CLAUDE_MD", global_dir / "CLAUDE.md"):
                issues = integrity_checker.check_claude_md_sections("telegram_code-claw")

    self.assertEqual(issues, [], f"Expected no issues, got: {issues}")


def test_section_missing_from_both_files_fails(self):
    """Section absent from both per-group and global CLAUDE.md -> FAIL"""
    import tempfile
    import integrity_checker

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        group_dir = tmp_path / "telegram_code-claw"
        group_dir.mkdir(parents=True)
        (group_dir / "CLAUDE.md").write_text(
            "# Group\n\n## Research Before Asking\nSearch.\n"
        )

        # Global file exists but also lacks Session Start Protocol
        global_dir = tmp_path / "global"
        global_dir.mkdir(parents=True)
        (global_dir / "CLAUDE.md").write_text("# Global\n\nNothing relevant here.\n")

        with patch("integrity_checker.GROUPS_DIR", tmp_path):
            with patch("integrity_checker.GLOBAL_CLAUDE_MD", global_dir / "CLAUDE.md"):
                issues = integrity_checker.check_claude_md_sections("telegram_code-claw")

    self.assertTrue(len(issues) > 0)
    self.assertTrue(any("Session Start Protocol" in i for i in issues))


def test_missing_global_file_does_not_crash(self):
    """Global CLAUDE.md absent -> no exception, per-group file still checked normally"""
    import tempfile
    import integrity_checker

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        group_dir = tmp_path / "telegram_claire"
        group_dir.mkdir(parents=True)
        (group_dir / "CLAUDE.md").write_text(
            "# Group\n\n"
            "## Session Start Protocol\nDo stuff.\n\n"
            "## Research Before Asking\nSearch.\n"
        )

        nonexistent_global = tmp_path / "global" / "CLAUDE.md"

        with patch("integrity_checker.GROUPS_DIR", tmp_path):
            with patch("integrity_checker.GLOBAL_CLAUDE_MD", nonexistent_global):
                issues = integrity_checker.check_claude_md_sections("telegram_claire")

    self.assertEqual(issues, [])


def test_run_all_checks_global_fallback_integration(self):
    """Integration: group passes when required section is only in global CLAUDE.md"""
    import tempfile
    import integrity_checker

    now = datetime(2026, 3, 28, 17, 0, 0)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        # Group has no required sections in its own CLAUDE.md
        group_dir = tmp_path / "telegram_code-claw"
        group_dir.mkdir(parents=True)
        (group_dir / "CLAUDE.md").write_text("# Group\n\nJust a stub.\n")
        memory_md = group_dir / "memory.md"
        memory_md.write_text("# Memory\n")

        # Both required sections are in global
        global_dir = tmp_path / "global"
        global_dir.mkdir(parents=True)
        (global_dir / "CLAUDE.md").write_text(
            "# Global\n\n"
            "## Session Start Protocol\nGlobal.\n\n"
            "## Research Before Asking\nGlobal search rule.\n"
        )

        with patch("integrity_checker.GROUPS_DIR", tmp_path):
            with patch("integrity_checker.GLOBAL_CLAUDE_MD", global_dir / "CLAUDE.md"):
                with patch("integrity_checker.GROUPS", ["telegram_code-claw"]):
                    with patch("integrity_checker.datetime") as mock_dt:
                        mock_dt.now.return_value = now
                        mock_dt.fromtimestamp = datetime.fromtimestamp

                        result = integrity_checker.run_all_checks()

    self.assertEqual(result["groups"]["telegram_code-claw"]["status"], "PASS")
    self.assertFalse(result["has_failures"])
```

---

### LOW-1 — `check_memory_freshness()` uses naive `datetime.now()` — timezone-unaware

**Severity:** LOW
**File:** `integrity_checker.py`, line 89-91

**Description:**
Both `datetime.now()` and `datetime.fromtimestamp()` return naive datetimes. This works correctly as long as the system clock is consistent (both are local time), but it will produce wrong results if the host's timezone changes or if the file was written by a process in a different timezone (e.g., a Docker container with UTC vs. host with America/New_York). Use `datetime.now()` and `datetime.fromtimestamp()` consistently, or prefer UTC throughout.

**Proposed fix:** Use `datetime.utcnow()` and `datetime.utcfromtimestamp()` (or the aware equivalents `datetime.now(timezone.utc)` and `datetime.fromtimestamp(ts, tz=timezone.utc)`) so the comparison is always in the same timezone regardless of host configuration.

---

### LOW-2 — `check_memory_freshness()` will raise `PermissionError` or `OSError` with no handling

**Severity:** LOW
**File:** `integrity_checker.py`, line 88

**Description:**
`memory_md.stat()` can raise `PermissionError` or `OSError` (e.g., broken symlink, NFS timeout). There is no try/except, so a stat failure on one group would crash the entire `run_all_checks()` loop and produce no output at all. Similarly, `claude_md.read_text()` can raise `PermissionError` or `UnicodeDecodeError`.

**Proposed fix:** Wrap filesystem operations in try/except and append a descriptive issue string rather than propagating the exception:

```python
try:
    stat = memory_md.stat()
except OSError as e:
    issues.append(f"{group_folder}: could not stat memory.md — {e}")
    return issues
```

---

### LOW-3 — `test_all_groups_checked` does not freeze time — memory freshness check will fail in CI

**Severity:** LOW
**File:** `tests/test_integrity_checker.py`, `TestRunAllChecks.test_all_groups_checked`

**Description:**
This test creates empty group directories (no CLAUDE.md, no memory.md) and does not patch `datetime`. Because there is no memory.md, the freshness check returns a "not found" issue, so the test still passes (the group is FAIL either way). However, the test also does not assert anything about PASS/FAIL status — it only checks that all 6 keys are present in the output. This is correct but weak: the test would pass even if `run_all_checks()` returned an empty dict for each group.

It's a minor issue — the test achieves its stated goal — but it's worth noting that CI behaviour is correct only by accident (the "not found" issue happens to produce a FAIL consistent with the group having no files).

**Proposed fix:** No code change strictly required, but consider adding a `self.assertIn("status", result["groups"][group])` assertion to verify structure, and add a comment explaining why datetime patching is not needed here.

---

## Proposed New Test Cases

See MEDIUM-3 above for the four complete test functions covering the global CLAUDE.md fallback. They are ready to copy-paste into `TestCheckClaudeMdSections` (the integration test `test_run_all_checks_global_fallback_integration` should go into `TestRunAllChecks`).

---

## Applied Fixes

The following CRITICAL and HIGH issues are fixed directly in the source files:

- **CRITICAL-1**: Global CLAUDE.md fallback added to `check_claude_md_sections()` via `GLOBAL_CLAUDE_MD` constant and `_read_global_claude_md()` helper.
- **HIGH-1**: Default staleness threshold changed from 48h to 96h via `DEFAULT_MAX_AGE_HOURS` constant.
- New tests for the global fallback added to `tests/test_integrity_checker.py`.

MEDIUM-1 (double-reporting missing file) is also fixed in `run_all_checks()` by skipping the freshness check when the existence check already failed.
