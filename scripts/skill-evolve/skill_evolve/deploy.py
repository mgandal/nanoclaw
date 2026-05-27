"""Deploy: branch + draft PR to mgandal/nanoclaw.

Per spec N9: negative-constraint remote check (refuse 'qwibitai'),
not positive allowlist. Per spec C4: stamps the variant SKILL.md with
skill_version: skill-evolve/wiki-<run-id> for vault-blame.
"""
from __future__ import annotations
import subprocess
from pathlib import Path

from . import config


FORBIDDEN_REMOTE_SUBSTRINGS = ("qwibitai",)
TARGET_REPO = "mgandal/nanoclaw"
TARGET_BRANCH = "main"


class ForbiddenRemote(RuntimeError):
    pass


def assert_remote_safe(remote_url: str) -> None:
    for sub in FORBIDDEN_REMOTE_SUBSTRINGS:
        if sub in remote_url:
            raise ForbiddenRemote(
                f"Refused: remote {remote_url!r} matches forbidden substring {sub!r}. "
                "skill-evolve only pushes to mgandal/nanoclaw (the user's fork)."
            )


def branch_name(skill: str, run_id: str) -> str:
    return f"skill-evolve/{skill}-{run_id}"


def stamp_run_id_into_skill(baseline_skill_text: str, run_id: str) -> str:
    """Replace 'skill_version: production' references with the run-specific tag.

    This is what ensures vault-blame can find pages written by THIS variant.
    """
    stamp = f"skill_version: skill-evolve/wiki-{run_id}"
    return baseline_skill_text.replace("skill_version: production", stamp)


def open_pr(
    skill_name: str,
    run_id: str,
    repo_root: Path,
    variant_text: str,
    target_skill_path: Path,
    report_path: Path,
    pr_body: str,
) -> str:
    # 1) Remote safety check
    cp = subprocess.run(["git", "-C", str(repo_root), "remote", "get-url", "origin"],
                        capture_output=True, text=True, check=True)
    assert_remote_safe(cp.stdout.strip())

    # 2) Create branch
    branch = branch_name(skill_name, run_id)
    subprocess.run(["git", "-C", str(repo_root), "checkout", "-b", branch], check=True)

    # 3) Write variant + report
    target_skill_path.write_text(variant_text)
    runs_dir = config.runs_dir() / run_id
    runs_dir.mkdir(parents=True, exist_ok=True)
    persistent_report = runs_dir / "report.md"
    persistent_report.write_text(report_path.read_text())

    # 4) Commit
    subprocess.run(["git", "-C", str(repo_root), "add", str(target_skill_path), str(persistent_report)], check=True)
    subprocess.run(["git", "-C", str(repo_root), "commit", "-m",
                    f"feat(skill-evolve): wiki variant from run {run_id}"], check=True)

    # 5) Push
    subprocess.run(["git", "-C", str(repo_root), "push", "-u", "origin", branch], check=True)

    # 6) Open draft PR
    pr = subprocess.run(
        ["gh", "pr", "create", "--draft", "--repo", TARGET_REPO,
         "--base", TARGET_BRANCH, "--head", branch,
         "--title", f"skill-evolve: wiki variant {run_id}",
         "--body", pr_body],
        capture_output=True, text=True, check=True,
    )
    return pr.stdout.strip()
