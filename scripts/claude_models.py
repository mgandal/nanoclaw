"""Single source of truth for the Claude model IDs used by nanoclaw's Python side-tools.

skill-evolve, pageindex, and paperpile-wiki each import from here instead of
pinning their own literal. Update this file when migrating models so the next
bump is one edit instead of hunting down every copy.
"""

DEFAULT_MODEL = "claude-sonnet-5"
FALLBACK_MODEL = "claude-haiku-4-5-20251001"
