"""Sandbox executor: spawn `claude --print` against a scratch vault.

Per spec C1: passes --permission-mode bypassPermissions + --allowedTools
"Write Edit Bash Read". Per spec C2: writes variant SKILL.md to a tempfile
and reads it back into the --append-system-prompt flag value (no bash
process substitution; no shell=True). Per spec I11: rejects variants
containing mcp__ references pre-flight.

Restricted env per src/pageindex.ts:332-341 pattern.
"""
from __future__ import annotations
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from . import config


@dataclass
class SandboxResult:
    exit_code: int
    stderr: str
    files_written: list[Path] = field(default_factory=list)
    timed_out: bool = False


VAULT_DIRS = [
    "wiki/papers", "wiki/syntheses", "wiki/tools", "wiki/concepts",
    "wiki/entities", "wiki/comparisons", "wiki/notes", "wiki/articles",
    "sources/papers", "sources/articles", "sources/media",
    "sources/transcripts", "sources/books",
    "10-daily/meetings",
]


def _build_scratch_vault(scratch_vault: Path, conventions: Path | None = None,
                          index_md: Path | None = None) -> None:
    scratch_vault.mkdir(parents=True, exist_ok=True)
    for d in VAULT_DIRS:
        (scratch_vault / d).mkdir(parents=True, exist_ok=True)
    if conventions and conventions.exists():
        shutil.copy(conventions, scratch_vault / "CONVENTIONS.md")
    if index_md and index_md.exists():
        shutil.copy(index_md, scratch_vault / "wiki" / "index.md")


def run_sandbox(
    variant_skill: str,
    prompt: str,
    scratch_vault: Path,
    run_root: Path,
    claude_bin: Path = Path("claude"),
    timeout_s: int = 90,
    conventions_source: Path | None = None,
    index_md_source: Path | None = None,
) -> SandboxResult:
    if "mcp__" in variant_skill:
        raise RuntimeError(
            "Variant references an MCP tool (mcp__...). v1 sandbox does not support MCPs; "
            "either drop the MCP reference from the variant or defer to v2 with mock-MCP. "
            "(spec I11)"
        )
    _build_scratch_vault(scratch_vault, conventions_source, index_md_source)

    run_root.mkdir(parents=True, exist_ok=True)
    home = run_root / "home"
    home.mkdir(parents=True, exist_ok=True)
    variant_tmp = run_root / "variant.md"
    variant_tmp.write_text(variant_skill)

    base_url = config.load_anthropic_base_url()
    env = {
        "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
        "HOME": str(home),
        "ANTHROPIC_BASE_URL": base_url,
        "ANTHROPIC_API_KEY": "placeholder",
    }

    # Per spec C2: read variant into the flag value; no bash process substitution.
    variant_text = variant_tmp.read_text()
    cmd = [
        str(claude_bin),
        "--print",
        "--permission-mode", "bypassPermissions",
        "--allowedTools", "Write Edit Bash Read",
        "--append-system-prompt", variant_text,
    ]
    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            cwd=scratch_vault,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
        files_written = _list_files_written(scratch_vault)
        return SandboxResult(exit_code=proc.returncode, stderr=proc.stderr, files_written=files_written)
    except subprocess.TimeoutExpired as e:
        files_written = _list_files_written(scratch_vault)
        return SandboxResult(exit_code=-1, stderr=f"TIMEOUT after {timeout_s}s",
                             files_written=files_written, timed_out=True)


_SKIP_FILES = {"CONVENTIONS.md"}


def _list_files_written(scratch_vault: Path) -> list[Path]:
    out = []
    for p in scratch_vault.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(scratch_vault)
        if rel.name in _SKIP_FILES:
            continue
        if rel.parts[0] not in {"wiki", "10-daily", "sources"}:
            continue
        if str(rel) == "wiki/index.md":
            continue
        out.append(p)
    return sorted(out)
