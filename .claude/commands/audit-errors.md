---
description: Run the NanoClaw error audit and walk through any bugs interactively. Reads 24h of task_run_logs + nanoclaw.{log,error.log}, classifies, and proposes fixes.
argument-hint: [--fresh]
---

# /audit-errors — NanoClaw Error Audit

Run `scripts/audit-telegram-errors.py` against the current logs/DB, then walk the user through the `bug`-bucket entries interactively. This is the supervised self-correct surface — the script proposes, the human dispatches.

User argument: $ARGUMENTS

## Procedure

### Step 1 — Decide the window

If `$ARGUMENTS` contains `--fresh`, the user wants to re-scan the whole log window (not just the delta since the last run). Back up the state file first so the cron can still pick up from where it was:

```bash
cp scripts/state/error-audit-state.json /tmp/audit-state-backup.json
echo '{}' > scripts/state/error-audit-state.json
```

Otherwise, run incrementally (the default — from the last byte offset).

### Step 2 — Run the audit

```bash
/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3 scripts/audit-telegram-errors.py
```

The script prints a JSON summary and exits 2 if there are actionable issues, 0 otherwise. **If `--fresh` was used, immediately restore the state file** so the daily cron doesn't re-process the same window:

```bash
cp /tmp/audit-state-backup.json scripts/state/error-audit-state.json
```

### Step 3 — Summarize for the user

In one short block, state:
- Window (24h), total records, counts by bucket
- Whether any actionable issues exist

If `actionable_count == 0`, stop here. Tell the user "Clean audit — nothing actionable."

### Step 4 — Walk each bug-bucket entry

For each record in the `actionable` list where `bucket == "bug"`:

1. **Show the message** (first line), `count`, `first_seen`→`last_seen` span, source (`error_log` vs `main_log` vs `task_run_logs`).
2. **Find the suspected file.** Grep the message for path fragments, file references, or module names. If the error mentions a built `dist/` file, the bug is in the matching `src/` file.
3. **Show recent commits touching that file** (last 7 days):
   ```bash
   git log --since='7 days ago' --oneline -- src/suspected-file.ts
   ```
4. **Ask the user** which to do:
   - `[d]` diagnose deeper — grep for related patterns, read the suspected file
   - `[p]` propose a patch — draft a diff, run any targeted tests (respecting the project's testing policy in CLAUDE.md), show the diff, wait for explicit approval before committing
   - `[s]` skip — move on to the next bug
   - `[q]` quit — stop walking

### Step 5 — For `config` / `infra` / `unknown` records

After the bug loop, list these in a compact form (one line per record: bucket, count, message). Do not propose fixes for these — they're either upstream (`infra`), user-side (`config`), or unclassified. The user can manually decide which deserve a second pass.

## Hard rules

- **Never auto-commit.** Propose-diff → show → wait for explicit `yes` → commit. This is the "supervised self-correct" boundary from the plan.
- **Never push.** Local commits only. The user runs `git push` manually if they want.
- **Never skip hooks** (`--no-verify`). If a pre-commit hook fails on a proposed fix, fix the underlying issue; don't bypass.
- **Respect CLAUDE.md's testing policy.** Every proposed fix must pass the relevant targeted test (`bun --bun vitest run <file>`, `pytest <file>`, etc.) before commit. Show the test output to the user.
- **Don't change scope.** If the bug is a two-line fix, commit two lines. Don't refactor adjacent code. The audit found one thing; fix that one thing.

## Context

- Script source: `scripts/audit-telegram-errors.py`
- Design doc: `docs/plan-telegram-error-audit.md` (buckets, threshold logic, rule table)
- Tests: `scripts/tests/test_audit_classifier.py`, `scripts/tests/test_audit_threshold.py`
- State: `scripts/state/error-audit-state.json` (byte offsets per log file + last_run timestamp)
- Daily cron: `ops/com.nanoclaw.error-audit.plist` (9am ET, 1h after task-health-monitor)
