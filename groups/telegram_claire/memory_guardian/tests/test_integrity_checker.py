"""
Tests for memory_guardian/integrity_checker.py
Written FIRST per TDD requirements — all tests will fail until implementation exists.
"""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import integrity_checker


class TestCheckClaudeMdSections(unittest.TestCase):
    """Tests for check_claude_md_sections()"""

    def test_missing_file_returns_error(self):
        """group folder exists but no CLAUDE.md -> issue returned"""
        with patch("integrity_checker.GROUPS_DIR") as mock_dir:
            mock_group_path = MagicMock()
            mock_claude_md = MagicMock()
            mock_claude_md.exists.return_value = False
            mock_group_path.__truediv__ = lambda self, other: mock_claude_md
            mock_dir.__truediv__ = lambda self, other: mock_group_path

            with patch("integrity_checker.GLOBAL_CLAUDE_MD") as mock_global:
                mock_global.exists.return_value = False

                issues = integrity_checker.check_claude_md_sections("telegram_claire")
            self.assertTrue(len(issues) > 0)
            self.assertTrue(any("CLAUDE.md" in issue for issue in issues))

    def test_all_sections_present_passes(self):
        """CLAUDE.md contains both required markers -> no issues"""
        content = (
            "# Group Instructions\n\n"
            "## Session Start Protocol\n"
            "Do things at session start.\n\n"
            "## Research Before Asking\n"
            "Search before asking Mike.\n"
        )

        with patch("integrity_checker.GROUPS_DIR") as mock_dir:
            fake_path = MagicMock()
            fake_path.exists.return_value = True
            fake_path.read_text.return_value = content
            mock_group_path = MagicMock()
            mock_group_path.__truediv__ = lambda self, other: fake_path
            mock_dir.__truediv__ = lambda self, other: mock_group_path

            with patch("integrity_checker.GLOBAL_CLAUDE_MD") as mock_global:
                mock_global.exists.return_value = False

                issues = integrity_checker.check_claude_md_sections("telegram_claire")
            self.assertEqual(issues, [])

    def test_missing_session_start_detected(self):
        """CLAUDE.md has Research Before Asking but not Session Start Protocol -> issue.
        Global CLAUDE.md is patched to empty so it cannot satisfy the missing marker.
        """
        content = (
            "# Group Instructions\n\n"
            "## Research Before Asking\n"
            "Search before asking Mike.\n"
        )

        with patch("integrity_checker.GROUPS_DIR") as mock_dir:
            fake_path = MagicMock()
            fake_path.exists.return_value = True
            fake_path.read_text.return_value = content
            mock_group_path = MagicMock()
            mock_group_path.__truediv__ = lambda self, other: fake_path
            mock_dir.__truediv__ = lambda self, other: mock_group_path

            # Patch global CLAUDE.md to nonexistent path so the fallback is empty.
            with patch("integrity_checker.GLOBAL_CLAUDE_MD") as mock_global:
                mock_global.exists.return_value = False

                issues = integrity_checker.check_claude_md_sections("telegram_claire")
            self.assertTrue(len(issues) > 0)
            self.assertTrue(any("Session Start Protocol" in issue for issue in issues))

    def test_missing_research_protocol_detected(self):
        """CLAUDE.md has Session Start Protocol but not Research Before Asking -> issue.
        Global CLAUDE.md is patched to empty so it cannot satisfy the missing marker.
        """
        content = (
            "# Group Instructions\n\n"
            "## Session Start Protocol\n"
            "Do things at session start.\n"
        )

        with patch("integrity_checker.GROUPS_DIR") as mock_dir:
            fake_path = MagicMock()
            fake_path.exists.return_value = True
            fake_path.read_text.return_value = content
            mock_group_path = MagicMock()
            mock_group_path.__truediv__ = lambda self, other: fake_path
            mock_dir.__truediv__ = lambda self, other: mock_group_path

            # Patch global CLAUDE.md to nonexistent path so the fallback is empty.
            with patch("integrity_checker.GLOBAL_CLAUDE_MD") as mock_global:
                mock_global.exists.return_value = False

                issues = integrity_checker.check_claude_md_sections("telegram_claire")
            self.assertTrue(len(issues) > 0)
            self.assertTrue(any("Research Before Asking" in issue for issue in issues))


class TestCheckClaudeMdSectionsGlobalFallback(unittest.TestCase):
    """Tests for check_claude_md_sections() global CLAUDE.md fallback behaviour."""

    def test_section_in_global_file_satisfies_check(self):
        """Section missing from per-group CLAUDE.md but present in global -> PASS"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)

            # Per-group file: has only Research Before Asking
            group_dir = tmp_path / "telegram_code-claw"
            group_dir.mkdir(parents=True)
            (group_dir / "CLAUDE.md").write_text(
                "# Group\n\n## Research Before Asking\nSearch.\n"
            )

            # Global file: has Session Start Protocol
            global_dir = tmp_path / "global"
            global_dir.mkdir(parents=True)
            (global_dir / "CLAUDE.md").write_text(
                "# Global\n\n## Session Start Protocol\nGlobal protocol.\n"
            )

            with patch("integrity_checker.GROUPS_DIR", tmp_path):
                with patch(
                    "integrity_checker.GLOBAL_CLAUDE_MD", global_dir / "CLAUDE.md"
                ):
                    issues = integrity_checker.check_claude_md_sections(
                        "telegram_code-claw"
                    )

        self.assertEqual(issues, [], f"Expected no issues, got: {issues}")

    def test_section_missing_from_both_files_fails(self):
        """Section absent from both per-group and global CLAUDE.md -> FAIL"""
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
            (global_dir / "CLAUDE.md").write_text(
                "# Global\n\nNothing relevant here.\n"
            )

            with patch("integrity_checker.GROUPS_DIR", tmp_path):
                with patch(
                    "integrity_checker.GLOBAL_CLAUDE_MD", global_dir / "CLAUDE.md"
                ):
                    issues = integrity_checker.check_claude_md_sections(
                        "telegram_code-claw"
                    )

        self.assertTrue(len(issues) > 0)
        self.assertTrue(any("Session Start Protocol" in i for i in issues))

    def test_missing_global_file_does_not_crash(self):
        """Global CLAUDE.md absent -> no exception, per-group file still checked normally"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)

            group_dir = tmp_path / "telegram_claire"
            group_dir.mkdir(parents=True)
            (group_dir / "CLAUDE.md").write_text(
                "# Group\n\n"
                "## Session Start Protocol\nDo stuff.\n\n"
                "## Research Before Asking\nSearch.\n"
            )

            # Global file deliberately does not exist
            nonexistent_global = tmp_path / "global" / "CLAUDE.md"

            with patch("integrity_checker.GROUPS_DIR", tmp_path):
                with patch(
                    "integrity_checker.GLOBAL_CLAUDE_MD", nonexistent_global
                ):
                    issues = integrity_checker.check_claude_md_sections(
                        "telegram_claire"
                    )

        self.assertEqual(issues, [])

    def test_both_sections_only_in_global_file_passes(self):
        """Per-group CLAUDE.md is a stub; both required sections live in global -> PASS"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)

            group_dir = tmp_path / "telegram_vault-claw"
            group_dir.mkdir(parents=True)
            (group_dir / "CLAUDE.md").write_text("# Group\n\nJust a stub.\n")

            global_dir = tmp_path / "global"
            global_dir.mkdir(parents=True)
            (global_dir / "CLAUDE.md").write_text(
                "# Global\n\n"
                "## Session Start Protocol\nGlobal.\n\n"
                "## Research Before Asking\nGlobal search rule.\n"
            )

            with patch("integrity_checker.GROUPS_DIR", tmp_path):
                with patch(
                    "integrity_checker.GLOBAL_CLAUDE_MD", global_dir / "CLAUDE.md"
                ):
                    issues = integrity_checker.check_claude_md_sections(
                        "telegram_vault-claw"
                    )

        self.assertEqual(issues, [], f"Expected no issues, got: {issues}")


class TestCheckMemoryExists(unittest.TestCase):
    """Tests for check_memory_exists()"""

    def test_missing_memory_md_returns_error(self):
        """no memory.md -> issue returned"""
        with patch("integrity_checker.GROUPS_DIR") as mock_dir:
            fake_path = MagicMock()
            fake_path.exists.return_value = False
            mock_group_path = MagicMock()
            mock_group_path.__truediv__ = lambda self, other: fake_path
            mock_dir.__truediv__ = lambda self, other: mock_group_path

            issues = integrity_checker.check_memory_exists("telegram_claire")
            self.assertTrue(len(issues) > 0)
            self.assertTrue(any("memory.md" in issue for issue in issues))

    def test_existing_memory_md_passes(self):
        """memory.md present -> no issues"""
        with patch("integrity_checker.GROUPS_DIR") as mock_dir:
            fake_path = MagicMock()
            fake_path.exists.return_value = True
            mock_group_path = MagicMock()
            mock_group_path.__truediv__ = lambda self, other: fake_path
            mock_dir.__truediv__ = lambda self, other: mock_group_path

            issues = integrity_checker.check_memory_exists("telegram_claire")
            self.assertEqual(issues, [])


class TestCheckMemoryFreshness(unittest.TestCase):
    """Tests for check_memory_freshness()"""

    def test_fresh_memory_passes(self):
        """memory.md mtime = now -> no issues"""
        now = datetime(2026, 3, 28, 17, 0, 0, tzinfo=timezone.utc)

        with patch("integrity_checker.GROUPS_DIR") as mock_dir:
            fake_path = MagicMock()
            fake_path.exists.return_value = True
            stat_result = MagicMock()
            stat_result.st_mtime = now.timestamp()
            fake_path.stat.return_value = stat_result
            mock_group_path = MagicMock()
            mock_group_path.__truediv__ = lambda self, other: fake_path
            mock_dir.__truediv__ = lambda self, other: mock_group_path

            with patch("integrity_checker.datetime") as mock_dt:
                mock_dt.now.return_value = now
                mock_dt.fromtimestamp = datetime.fromtimestamp

                issues = integrity_checker.check_memory_freshness("telegram_claire")
                self.assertEqual(issues, [])

    def test_stale_memory_fails(self):
        """memory.md mtime = 5 days ago -> issue with 'stale' in message.
        Uses 5 days (120h) to exceed the 96h default threshold introduced to
        tolerate quiet weekends.
        """
        now = datetime(2026, 3, 28, 17, 0, 0, tzinfo=timezone.utc)
        five_days_ago = now - timedelta(days=5)

        with patch("integrity_checker.GROUPS_DIR") as mock_dir:
            fake_path = MagicMock()
            fake_path.exists.return_value = True
            stat_result = MagicMock()
            stat_result.st_mtime = five_days_ago.timestamp()
            fake_path.stat.return_value = stat_result
            mock_group_path = MagicMock()
            mock_group_path.__truediv__ = lambda self, other: fake_path
            mock_dir.__truediv__ = lambda self, other: mock_group_path

            with patch("integrity_checker.datetime") as mock_dt:
                mock_dt.now.return_value = now
                mock_dt.fromtimestamp = datetime.fromtimestamp

                issues = integrity_checker.check_memory_freshness("telegram_claire")
                self.assertTrue(len(issues) > 0)
                self.assertTrue(any("stale" in issue.lower() for issue in issues))

    def test_custom_max_age_respected(self):
        """mtime = 25h ago, max_age_hours=24 -> fails; max_age_hours=48 -> passes"""
        now = datetime(2026, 3, 28, 17, 0, 0, tzinfo=timezone.utc)
        twenty_five_hours_ago = now - timedelta(hours=25)

        with patch("integrity_checker.GROUPS_DIR") as mock_dir:
            fake_path = MagicMock()
            fake_path.exists.return_value = True
            stat_result = MagicMock()
            stat_result.st_mtime = twenty_five_hours_ago.timestamp()
            fake_path.stat.return_value = stat_result
            mock_group_path = MagicMock()
            mock_group_path.__truediv__ = lambda self, other: fake_path
            mock_dir.__truediv__ = lambda self, other: mock_group_path

            with patch("integrity_checker.datetime") as mock_dt:
                mock_dt.now.return_value = now
                mock_dt.fromtimestamp = datetime.fromtimestamp

                issues_24 = integrity_checker.check_memory_freshness(
                    "telegram_claire", max_age_hours=24
                )
                self.assertTrue(len(issues_24) > 0, "Should fail with max_age_hours=24")

                issues_48 = integrity_checker.check_memory_freshness(
                    "telegram_claire", max_age_hours=48
                )
                self.assertEqual(issues_48, [], "Should pass with max_age_hours=48")


class TestRunAllChecks(unittest.TestCase):
    """Tests for run_all_checks()"""

    EXPECTED_GROUPS = [
        "telegram_claire",
        "telegram_lab-claw",
        "telegram_code-claw",
        "telegram_science-claw",
        "telegram_home-claw",
        "telegram_vault-claw",
    ]

    def _make_good_group_path(self, tmp_path, group_name):
        """Helper: create a group folder with valid CLAUDE.md and fresh memory.md"""
        group_dir = tmp_path / group_name
        group_dir.mkdir(parents=True, exist_ok=True)

        claude_md = group_dir / "CLAUDE.md"
        claude_md.write_text(
            "# Instructions\n\n"
            "## Session Start Protocol\nDo stuff.\n\n"
            "## Research Before Asking\nSearch first.\n"
        )

        memory_md = group_dir / "memory.md"
        memory_md.write_text("# Memory\nSome notes.\n")

        return group_dir

    def test_healthy_group_shows_pass(self):
        """mock a group with good CLAUDE.md and fresh memory.md -> status PASS"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            self._make_good_group_path(tmp_path, "telegram_claire")

            now = datetime(2026, 3, 28, 17, 0, 0, tzinfo=timezone.utc)

            with patch("integrity_checker.GROUPS_DIR", tmp_path):
                with patch("integrity_checker.GROUPS", ["telegram_claire"]):
                    with patch("integrity_checker.datetime") as mock_dt:
                        mock_dt.now.return_value = now
                        mock_dt.fromtimestamp = datetime.fromtimestamp

                        result = integrity_checker.run_all_checks()

            self.assertIn("telegram_claire", result["groups"])
            self.assertEqual(result["groups"]["telegram_claire"]["status"], "PASS")
            self.assertEqual(result["groups"]["telegram_claire"]["issues"], [])

    def test_unhealthy_group_shows_fail(self):
        """mock a group with issues -> status FAIL, has_failures=True"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            # Create group dir but no CLAUDE.md and no memory.md
            group_dir = tmp_path / "telegram_claire"
            group_dir.mkdir(parents=True)

            with patch("integrity_checker.GROUPS_DIR", tmp_path):
                with patch("integrity_checker.GROUPS", ["telegram_claire"]):
                    result = integrity_checker.run_all_checks()

            self.assertIn("telegram_claire", result["groups"])
            self.assertEqual(result["groups"]["telegram_claire"]["status"], "FAIL")
            self.assertTrue(result["has_failures"])

    def test_all_groups_checked(self):
        """result contains all 6 expected group keys, each with status and issues fields"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            for group in self.EXPECTED_GROUPS:
                self._make_good_group_path(tmp_path, group)

            now = datetime(2026, 3, 28, 17, 0, 0, tzinfo=timezone.utc)

            with patch("integrity_checker.GROUPS_DIR", tmp_path):
                with patch("integrity_checker.datetime") as mock_dt:
                    mock_dt.now.return_value = now
                    mock_dt.fromtimestamp = datetime.fromtimestamp
                    result = integrity_checker.run_all_checks()

        self.assertEqual(set(result["groups"].keys()), set(self.EXPECTED_GROUPS))
        for group in self.EXPECTED_GROUPS:
            entry = result["groups"][group]
            self.assertIn("status", entry, f"{group} missing 'status'")
            self.assertIn("issues", entry, f"{group} missing 'issues'")
            self.assertIn(entry["status"], ("PASS", "FAIL"), f"{group} invalid status")
            self.assertIsInstance(entry["issues"], list, f"{group} issues not a list")
            self.assertEqual(entry["status"], "PASS", f"{group} should PASS: {entry['issues']}")

    def test_run_all_checks_global_fallback_integration(self):
        """Integration: group passes when required sections are only in global CLAUDE.md"""
        now = datetime(2026, 3, 28, 17, 0, 0, tzinfo=timezone.utc)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)

            # Group has a stub CLAUDE.md — no required sections of its own
            group_dir = tmp_path / "telegram_code-claw"
            group_dir.mkdir(parents=True)
            (group_dir / "CLAUDE.md").write_text("# Group\n\nJust a stub.\n")
            (group_dir / "memory.md").write_text("# Memory\n")

            # Both required sections live only in global
            global_dir = tmp_path / "global"
            global_dir.mkdir(parents=True)
            (global_dir / "CLAUDE.md").write_text(
                "# Global\n\n"
                "## Session Start Protocol\nGlobal.\n\n"
                "## Research Before Asking\nGlobal search rule.\n"
            )

            with patch("integrity_checker.GROUPS_DIR", tmp_path):
                with patch(
                    "integrity_checker.GLOBAL_CLAUDE_MD", global_dir / "CLAUDE.md"
                ):
                    with patch("integrity_checker.GROUPS", ["telegram_code-claw"]):
                        with patch("integrity_checker.datetime") as mock_dt:
                            mock_dt.now.return_value = now
                            mock_dt.fromtimestamp = datetime.fromtimestamp

                            result = integrity_checker.run_all_checks()

        self.assertEqual(result["groups"]["telegram_code-claw"]["status"], "PASS")
        self.assertFalse(result["has_failures"])

    def test_output_is_valid_json(self):
        """run_all_checks() produces JSON-serializable output"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            for group in self.EXPECTED_GROUPS:
                (tmp_path / group).mkdir(parents=True)

            with patch("integrity_checker.GROUPS_DIR", tmp_path):
                result = integrity_checker.run_all_checks()

        # Should not raise
        serialized = json.dumps(result)
        parsed = json.loads(serialized)
        self.assertIn("timestamp", parsed)
        self.assertIn("has_failures", parsed)
        self.assertIn("groups", parsed)


if __name__ == "__main__":
    unittest.main()
