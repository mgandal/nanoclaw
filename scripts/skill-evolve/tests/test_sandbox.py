import os
import stat
from pathlib import Path
from skill_evolve.sandbox import run_sandbox, SandboxResult


def make_fake_claude(tmp_path: Path, behavior: str = "write_paper") -> Path:
    """Create a fake claude binary that writes a fixture file when invoked."""
    shim = tmp_path / "fake_claude"
    if behavior == "write_paper":
        body = (
            '#!/bin/bash\n'
            'cat > "$PWD/wiki/papers/fake.md" <<"EOF"\n'
            '---\n'
            'title: Fake\n'
            'type: summary\n'
            'created: 2026-05-23\n'
            'updated: 2026-05-23\n'
            'tags: [wiki/papers]\n'
            'skill_version: test\n'
            '---\n'
            '## Sources\n'
            '- foo\n'
            'EOF\n'
            'echo "done" >&1\n'
        )
    elif behavior == "no_write":
        body = '#!/bin/bash\necho "nothing to do"\n'
    else:
        body = '#!/bin/bash\nexit 1\n'
    shim.write_text(body)
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return shim


def test_sandbox_writes_files_and_captures_them(tmp_path):
    fake_claude = make_fake_claude(tmp_path, "write_paper")
    result = run_sandbox(
        variant_skill="# variant text",
        prompt="add a paper",
        scratch_vault=tmp_path / "vault",
        run_root=tmp_path / "run",
        claude_bin=fake_claude,
        timeout_s=10,
    )
    assert result.exit_code == 0
    assert len(result.files_written) == 1
    assert "papers/fake.md" in str(result.files_written[0])


def test_sandbox_no_write_returns_empty_files(tmp_path):
    fake_claude = make_fake_claude(tmp_path, "no_write")
    result = run_sandbox(
        variant_skill="# variant",
        prompt="hi",
        scratch_vault=tmp_path / "vault",
        run_root=tmp_path / "run",
        claude_bin=fake_claude,
        timeout_s=10,
    )
    assert result.exit_code == 0
    assert result.files_written == []


def test_sandbox_rejects_variant_with_mcp_reference(tmp_path):
    fake_claude = make_fake_claude(tmp_path, "write_paper")
    import pytest
    with pytest.raises(RuntimeError, match="MCP"):
        run_sandbox(
            variant_skill="use mcp__qmd__query for lookup",
            prompt="x",
            scratch_vault=tmp_path / "vault",
            run_root=tmp_path / "run",
            claude_bin=fake_claude,
            timeout_s=10,
        )


def test_sandbox_subprocess_env_is_allowlist(tmp_path):
    """The subprocess should NOT see arbitrary env vars from the test process."""
    fake = tmp_path / "env_probe"
    fake.write_text(
        '#!/bin/bash\n'
        'mkdir -p "$PWD/wiki/papers"\n'
        'env | grep -E "^(SECRET_PROBE|ANTHROPIC_BASE_URL|HOME|PATH)=" | sort > "$PWD/env.log"\n'
        'cat > "$PWD/wiki/papers/x.md" <<"EOF"\n'
        '---\ntitle: x\ntype: summary\ncreated: 2026-05-23\nupdated: 2026-05-23\ntags: [wiki/papers]\nskill_version: t\n---\n## Sources\n- y\nEOF\n'
    )
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    os.environ["SECRET_PROBE"] = "should_not_leak"
    try:
        result = run_sandbox(
            variant_skill="# v",
            prompt="x",
            scratch_vault=tmp_path / "vault",
            run_root=tmp_path / "run",
            claude_bin=fake,
            timeout_s=10,
        )
    finally:
        del os.environ["SECRET_PROBE"]
    env_log = (tmp_path / "vault" / "env.log").read_text() if (tmp_path / "vault" / "env.log").exists() else ""
    assert "SECRET_PROBE" not in env_log
    assert "HOME=" in env_log
    assert "PATH=" in env_log
