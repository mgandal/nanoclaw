import subprocess
from pathlib import Path
import pytest
from skill_evolve.deploy import assert_remote_safe, ForbiddenRemote, branch_name, stamp_run_id_into_skill


def test_assert_remote_safe_rejects_qwibitai():
    with pytest.raises(ForbiddenRemote):
        assert_remote_safe("git@github.com:qwibitai/nanoclaw.git")


def test_assert_remote_safe_rejects_qwibitai_skill_forks():
    with pytest.raises(ForbiddenRemote):
        assert_remote_safe("https://github.com/qwibitai/nanoclaw-gmail.git")


def test_assert_remote_safe_allows_mgandal():
    assert_remote_safe("git@github.com:mgandal/nanoclaw.git")  # no raise


def test_assert_remote_safe_allows_arbitrary_other_orgs():
    # Negative constraint: only qwibitai is forbidden
    assert_remote_safe("git@github.com:someone-else/fork.git")


def test_branch_name_format():
    bn = branch_name(skill="wiki", run_id="20260523-1530-deadbeef")
    assert bn == "skill-evolve/wiki-20260523-1530-deadbeef"


def test_stamp_run_id_inserts_skill_version_into_skill_text():
    baseline = (
        "# Wiki\n\n"
        "Stamp every page with `skill_version: production`.\n"
    )
    stamped = stamp_run_id_into_skill(baseline, run_id="20260523-1530-deadbeef")
    assert "skill_version: skill-evolve/wiki-20260523-1530-deadbeef" in stamped
    assert "skill_version: production" not in stamped
