"""CLI entry. Preflight: gh auth, OneCLI, file lock, history escalation."""
from __future__ import annotations
import fcntl
import json
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

import click

from . import config
from .escalate import check_history, EscalationStop


def preflight_gh_auth() -> None:
    cp = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True)
    if cp.returncode != 0:
        raise RuntimeError(
            "gh CLI not authenticated. Run `gh auth login` before retrying.\n"
            f"stderr: {cp.stderr}"
        )


@contextmanager
def preflight_lock(lock_path: Path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    f = lock_path.open("w")
    try:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("another run in progress (lock held); exiting")
        yield
    finally:
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        f.close()


def append_history_entry(history_path: Path, entry: dict) -> None:
    history_path.parent.mkdir(parents=True, exist_ok=True)
    with history_path.open("a") as f:
        f.write(json.dumps(entry) + "\n")


@click.command()
@click.option("--skill", required=True, help="Skill name to optimize (v1: only 'wiki')")
@click.option("--num-variants", default=5, show_default=True, type=int)
@click.option("--max-budget", default=config.DEFAULT_MAX_BUDGET_USD, show_default=True, type=float)
@click.option("--max-wall-clock-minutes", default=config.DEFAULT_MAX_WALL_CLOCK_MINUTES, show_default=True, type=int)
@click.option("--sandbox-concurrency", default=config.DEFAULT_SANDBOX_CONCURRENCY, show_default=True, type=int)
@click.option("--dry-run", is_flag=True, help="Stop before sandbox; print plan and exit")
def main(skill: str, num_variants: int, max_budget: float,
         max_wall_clock_minutes: int, sandbox_concurrency: int, dry_run: bool) -> None:
    if skill != "wiki":
        click.echo(f"ERROR: v1 only supports --skill wiki (got {skill!r})", err=True)
        sys.exit(2)

    runs_dir = config.runs_dir()
    runs_dir.mkdir(parents=True, exist_ok=True)
    lock = runs_dir / ".lock"
    history = runs_dir / "_history.jsonl"

    try:
        check_history(history)
    except EscalationStop as e:
        click.echo(f"ESCALATION: {e}", err=True)
        sys.exit(3)

    preflight_gh_auth()
    config.load_anthropic_base_url()  # raises if missing

    if dry_run:
        click.echo(f"DRY RUN OK: skill={skill}, num_variants={num_variants}, "
                   f"max_budget=${max_budget}, concurrency={sandbox_concurrency}")
        return

    with preflight_lock(lock):
        from .evolve import run_evolve
        from .report import render_report, ReportInputs
        from .deploy import open_pr, stamp_run_id_into_skill

        run_root = runs_dir / "_scratch_current"
        result = run_evolve(
            skill=skill, num_variants=num_variants, max_budget=max_budget,
            sandbox_concurrency=sandbox_concurrency, run_root=run_root,
        )

        # Always write report + history entry, even on no-improvement
        per_axis_baseline: dict[str, float] = {}
        per_axis_winner: dict[str, float] = {}
        # (Aggregation logic omitted here for brevity — left to subagent to derive from result.variant_scores)
        report_text = render_report(ReportInputs(
            run_id="latest",
            skill=skill,
            baseline_score=result.baseline_score,
            winner_score=result.winner_score,
            noise_floor=result.noise_floor,
            merge_threshold=result.merge_threshold,
            per_axis_baseline=per_axis_baseline,
            per_axis_winner=per_axis_winner,
            sample_diffs=[],
            realism_check=[],
            size_baseline_bytes=config.wiki_skill_path().stat().st_size,
            size_winner_bytes=len(result.winner_text.encode()) if result.winner_text else 0,
            cost_usd=0.0,
            intentional_drops=[],
            rollback_runbook_run_id="latest",
        ))
        click.echo(report_text[:400])

        entry = {"run_id": "latest", "merged": False,
                 "pr_url": None, "cost_usd": 0.0,
                 "winner_score": result.winner_score,
                 "baseline_score": result.baseline_score}
        append_history_entry(history, entry)


if __name__ == "__main__":
    main()
