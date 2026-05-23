#!/usr/bin/env python3
"""Guard script for OPS-claw Hermes-daily-ops-pipeline liveness check.

Hermes' daily ops cron (jobs.json id 42f7b8ee5ecb, schedule '0 7 * * 1-5')
is the canonical writer for /Users/mgandal/Agents/hermes-working/state/current.md
and context.md. If that cron stops firing, downstream consumers (Brain Brief,
receipt filer, daily ops briefing) silently break.

Run this guard Tue-Fri at 10am ET. If current.md or context.md is older than
HARD_STALE_HOURS, wake the agent; otherwise skip.

Exit 0 → wake agent (pipeline appears stuck).
Exit 1 → skip silently (pipeline healthy).
Exit 0 on read error (fail-open).
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

HERMES_STATE = Path("/Users/mgandal/Agents/hermes-working/state")
NANO_STATE = Path("/Users/mgandal/Agents/nanoclaw/groups/global/state")
REPORT_PATH = NANO_STATE / "hermes-pipeline-liveness-report.md"

# Files Hermes' daily ops pipeline actively writes.
TRACKED = ["current.md", "context.md"]

# Threshold: alarm if either file hasn't been touched in this many hours.
# Hermes runs weekdays 7am ET (pipeline takes ~3.5h to complete); this guard
# runs Tue-Fri 10am ET (14:00 UTC), so a healthy fire produces a file
# 23-27h old at check time. A single missed weekday fire makes the previous
# good write ~72h old (Tue check sees Fri's stale write). 30h gives 3-7h
# headroom for Hermes overruns and DST shifts; any 1+ day pipeline failure
# alarms loudly.
HARD_STALE_HOURS = 30


def hours_since(mtime: float) -> float:
    return (datetime.now(timezone.utc).timestamp() - mtime) / 3600


def main():
    try:
        NANO_STATE.mkdir(parents=True, exist_ok=True)
        findings = []
        for name in TRACKED:
            path = HERMES_STATE / name
            if not path.exists():
                findings.append((name, None, "missing"))
                continue
            age_h = hours_since(path.stat().st_mtime)
            findings.append((name, age_h, "stale" if age_h > HARD_STALE_HOURS else "fresh"))

        stale = [f for f in findings if f[2] != "fresh"]

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        lines = [
            f"# Hermes Pipeline Liveness — {now_iso}",
            "",
            f"**Threshold:** alarm if age > {HARD_STALE_HOURS}h",
            "",
        ]
        for name, age_h, status in findings:
            if age_h is None:
                lines.append(f"- `{name}` — MISSING")
            else:
                lines.append(f"- `{name}` — {age_h:.1f}h old ({status})")
        if stale:
            lines += [
                "",
                "## Likely cause",
                "",
                "Hermes' daily ops cron (`~/.hermes/cron/jobs.json` id `42f7b8ee5ecb`,",
                "schedule `0 7 * * 1-5`) failed to fire or completed without writing state.",
                "",
                "Downstream impact: Brain Brief, receipt filer, daily ops briefing",
                "may be silently stale.",
                "",
                "## Triage commands",
                "",
                "- `launchctl list | grep ai.hermes` (gateways alive?)",
                "- `ls -la ~/.hermes/cron/output/42f7b8ee5ecb/ | tail -5` (last successful runs)",
                "- `tail -50 ~/.hermes/logs/cron.log` (most recent cron activity)",
            ]
        REPORT_PATH.write_text("\n".join(lines) + "\n")

        if stale:
            names = ", ".join(f"{n}={a:.0f}h" if a is not None else n for n, a, _ in stale)
            print(f"Hermes pipeline appears stuck: {names} — waking agent")
            sys.exit(0)
        print("Hermes pipeline healthy (current.md/context.md fresh)")
        sys.exit(1)
    except Exception as e:
        print(f"Guard error: {e} — waking agent as fallback", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
