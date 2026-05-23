"""Paths + env loading. OneCLI routing via ANTHROPIC_BASE_URL.

No URL hardcoded; comes from project .env (same key live agent uses).
Never falls through to CLAUDE_CODE_OAUTH_TOKEN for unattended judge
calls (subscription seat ToS — see spec Credentials section).
"""
from __future__ import annotations
import os
from pathlib import Path

# Resolve repo root by walking up from this file until we find container/
def _find_repo_root() -> Path:
    p = Path(__file__).resolve()
    for parent in p.parents:
        if (parent / "container" / "skills").is_dir() and (parent / "src").is_dir():
            return parent
    raise RuntimeError(f"Could not find nanoclaw repo root from {p}")


REPO_ROOT = _find_repo_root()

# Default LLM model + judge model
DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_TEMPERATURE = 0.0

# Budget defaults
DEFAULT_MAX_BUDGET_USD = 40.0
DEFAULT_MAX_WALL_CLOCK_MINUTES = 60
DEFAULT_SANDBOX_CONCURRENCY = 4


def wiki_skill_path() -> Path:
    return REPO_ROOT / "container" / "skills" / "wiki" / "SKILL.md"


def wiki_conventions_path() -> Path:
    return REPO_ROOT / "container" / "skills" / "wiki" / "CONVENTIONS.md"


def sessions_dir() -> Path:
    return REPO_ROOT / "data" / "sessions"


def runs_dir() -> Path:
    return REPO_ROOT / "scripts" / "skill-evolve" / "runs"


def rubrics_dir() -> Path:
    return REPO_ROOT / "scripts" / "skill-evolve" / "rubrics"


def load_anthropic_base_url() -> str:
    """Load ANTHROPIC_BASE_URL from process env or project .env file.

    Hard-fails if missing. Never falls back to a default; the spec requires
    explicit OneCLI routing, not silent fallback to api.anthropic.com.
    """
    url = os.environ.get("ANTHROPIC_BASE_URL")
    if url:
        return url
    env_file = REPO_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("ANTHROPIC_BASE_URL="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError(
        "ANTHROPIC_BASE_URL not set in env or .env. "
        "OneCLI routing is mandatory — see spec Credentials section."
    )
