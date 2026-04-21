# Plan: Daily Telegram / NanoClaw Error Audit

**Status:** draft, not yet implemented
**Author:** Claude (with mgandal)
**Created:** 2026-04-20
**Related:** `scripts/check-task-health.py` (template), `scripts/sync/sync-health-check.sh`, `feedback_verify_before_claiming_fixed.md`

---

## Problem

NanoClaw emits errors across three surfaces — `logs/nanoclaw.log` (pino stdout), `logs/nanoclaw.error.log` (launchd stderr), and `store/messages.db` (`task_run_logs`, `scheduled_tasks.last_result`). There is no single daily pass that:

1. Pulls the last 24 hours of errors/warnings
2. Separates real bugs from transient/expected noise
3. Highlights **sustained** problems (same bug recurring ≥10 minutes) rather than one-offs
4. Produces a report actionable from the command line

Today, bugs like `SyntaxError: Export named 'OPS_ALERT_FOLDER' not found` sit in `nanoclaw.error.log` for days unnoticed because no one greps it.

## Goals

- Daily cron job that runs on the host, reads the last rolling-24h window, writes a structured audit report.
- Wake CLAIRE (or ops-claw) **only** when something actionable appears — no audit fatigue.
- Actionable = a bug-bucket entry that has recurred continuously or intermittently for ≥10 minutes, OR any new entry in `nanoclaw.error.log` (launchd-visible crash = always actionable).
- A `/audit-errors` slash command that runs the same audit on-demand and walks the user through proposed fixes interactively.

## Non-goals (explicitly out of scope for v1)

- **Auto-patching.** The audit proposes; the human dispatches. Justified by prior feedback on verify-before-claiming-fixed and trace-all-code-paths.
- **Realtime / streaming detection.** Daily window is enough for current failure rates (~5 errors / 142 tasks per day). If rates climb, revisit.
- **Cross-service correlation** beyond NanoClaw itself. Honcho/QMD/Ollama are checked via existing `sync-health-check.sh`; don't duplicate.

## Data sources (verified 2026-04-20)

| Source | Shape | How to window to 24h |
|---|---|---|
| `task_run_logs` (SQLite) | `{task_id, run_at, status, result, error}`; `status ∈ {success, error, skipped}` | `WHERE run_at >= datetime('now','-1 day')` — reliable |
| `scheduled_tasks.last_result` | one row per task, free-text result | Cross-ref with `last_run` timestamp |
| `logs/nanoclaw.error.log` | raw stderr lines, launchd captures. 186 lines total → every line matters | File mtime + tail since last-audit byte offset (state file) |
| `logs/nanoclaw.log` | pino pretty output, line-prefixed `[HH:MM:SS.sss]` — **no date**. ~150k lines, rotates via launchd | Tail since last-audit byte offset; sanity-check via process-start lines |

**Critical gotcha:** `nanoclaw.log` lacks date stamps, only time. We cannot reliably grep "last 24h" from it alone. Strategy: persist a **byte offset** in `scripts/state/error-audit-state.json` and tail from there each run. On first run, tail the last N MB as a safe bootstrap.

## Architecture

```
Host cron (launchd, daily 9am ET)
    │
    └─> scripts/audit-telegram-errors.py
          │
          ├─ collect()   ─┬─ SQLite task_run_logs (24h)
          │               ├─ nanoclaw.error.log (since offset)
          │               └─ nanoclaw.log       (since offset, grep WARN|ERROR)
          │
          ├─ normalize() → canonical record {source, first_seen, last_seen, count, type, message, context}
          │                   dedup key = (type, message[:120])
          │
          ├─ classify()  ─┬─ rule-based pre-pass (transient / config / bug / infra / unknown)
          │               └─ Ollama phi4-mini LLM pass, ONLY for "unknown" bucket
          │
          ├─ threshold() → sustained? (first_seen..last_seen span ≥10 min AND count ≥3)
          │                OR any entry in nanoclaw.error.log (always actionable)
          │
          └─ report()    ─┬─ write audit-YYYY-MM-DD.md to vault 00-inbox/
                          └─ if actionable: insert scheduled_tasks one-shot that wakes
                             CLAIRE with the report path (matches check-task-health pattern)
```

### Data contract: canonical error record

```python
{
  "source": "task_run_logs" | "error_log" | "main_log",
  "first_seen": "2026-04-19T14:38:05Z",
  "last_seen":  "2026-04-19T16:05:50Z",
  "count": 12,
  "type": "GrammyError" | "SyntaxError" | "ContainerTimeout" | "OllamaAbort" | ...,
  "message": "Call to 'setMyName' failed! (429: Too Many Requests)",
  "representative_stack": "…",     # one example stack, not all of them
  "context": {
    "group": "telegram_claire" | None,
    "task_id": "task-1776290962534-widv4w" | None,
    "suspected_file": "src/config.ts" | None,   # best-effort grep of stack frames
  }
}
```

### Classification rules (rule-based pre-pass)

Encoded as a list of `(regex, bucket, notes)` triples in the script. First match wins. Anything with no match goes to the LLM pass.

| Pattern | Bucket | Rationale |
|---|---|---|
| `GrammyError.*(setMyName|setMyDescription).*429` | transient | Rate-limited cosmetics, fallback works |
| `Failed to pre-rename pinned pool bot` | transient | Pin-kept fallback operates |
| `Ollama classification failed — using fallback` | transient | Fallback path covers |
| `Container timed out` | infra | Upstream; tag `causal_parent=true` so children suppressed |
| `\[Errno 2\] No such file or directory` (in guard script) | config | Missing file, not code bug |
| `SyntaxError\|Export named .* not found\|"await" .* async` (in error_log) | bug | Build drift / source error — always |
| `401.*"type":"error"` (Anthropic auth) | infra | Upstream |
| any line from `nanoclaw.error.log` not matched above | bug | Anything launchd sees as stderr is worth looking at |
| (no match) | unknown | Send to LLM |

### Threshold logic — the "sustained for 10 min" definition

For each normalized record `r`:
- `sustained = (r.last_seen - r.first_seen) >= 10 min AND r.count >= 3`
- `actionable = sustained OR r.source == "error_log" OR r.bucket == "bug"`

A single-shot bug that only fires once won't trip the threshold by time — but if its bucket is `bug`, we surface it anyway. The 10-min rule is specifically for things that *might* be transient but have been happening steadily (e.g. a flapping 429 over hours is louder than a 10-minute spike).

### Report format (`audit-YYYY-MM-DD.md` in vault `00-inbox/`)

```markdown
---
title: Error audit — 2026-04-20
type: audit
tags: [nanoclaw, errors, auto]
---

## Summary
- Window: 2026-04-19 09:00 ET → 2026-04-20 09:00 ET
- Tasks: 142 total, 136 success, 2 error, 4 skipped (95.8% success, baseline 96±2%)
- Actionable issues: 2 (1 bug, 1 infra)
- Suppressed as transient: 47 events collapsed into 3 records

## Bugs (review & fix)
### 1. SyntaxError: `OPS_ALERT_FOLDER not found in dist/config.js` — **12 occurrences**
- First seen 14:38, last seen 16:05 (87 min span)
- Source: `logs/nanoclaw.error.log`
- Suspected file: `src/config.ts`, `dist/config.js` (build drift)
- Likely cause: `dist/` out of sync with `src/`. Run `bun run build`.
- Git log since last good run: `70fbab32, ec5af501, baca34c4`

### 2. …

## Config
### 1. Guard script missing: `gmail-plus-monitor.py` …

## Infra (upstream, no code fix)
### 1. Container timeout on vault-inbox-ingest — root cause, 4 downstream Ollama aborts suppressed

## Transient (suppressed)
- 12× Grammy 429 setMyName
- 8× pool-bot pre-rename fallback
- 4× Ollama AbortError (caused by above container timeout)
```

### Alert wakeup

Matches the existing `task-health-monitor-1776624301` pattern: the script does NOT send a Telegram message directly. It writes the report, then **inserts a one-shot `scheduled_tasks` row** pointing the CLAIRE (or ops-claw) group at the report path with a short prompt like "Read `$path` and send a 1-line summary if there are bugs; silent otherwise." This keeps routing logic centralized in the NanoClaw orchestrator and reuses its Telegram plumbing.

Route to **`telegram_ops-claw`** by default (matches `OPS_ALERT_FOLDER`), CLAIRE as fallback if ops isn't live. Configurable via env var.

## Script skeleton: `scripts/audit-telegram-errors.py`

- Mirrors `check-task-health.py` exactly: shebang, path resolution for host/container, JSON-to-stdout, exit 2 on actionable issues else 0.
- State file at `scripts/state/error-audit-state.json`:
  ```json
  { "last_run": "2026-04-20T09:00:00-04:00",
    "log_offsets": { "nanoclaw.log": 12345678, "nanoclaw.error.log": 18234 } }
  ```
- Ollama call uses the same HTTP client shape as `scripts/sync/email-ingest/` (phi4-mini, 10-item batches, 30s timeout, graceful fallback to "unknown" if unreachable).

## launchd wiring: `com.nanoclaw.error-audit.plist`

```xml
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nanoclaw.error-audit</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3</string>
    <string>/Users/mgandal/Agents/nanoclaw/scripts/audit-telegram-errors.py</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>/Users/mgandal/Agents/nanoclaw/logs/error-audit.log</string>
  <key>StandardErrorPath</key><string>/Users/mgandal/Agents/nanoclaw/logs/error-audit.error.log</string>
</dict>
</plist>
```

Runs at 9am ET, 1h after `check-task-health` (8am) so CLAIRE's inbox isn't double-pinged.

## Slash command: `/audit-errors`

Lives at `.claude/commands/audit-errors.md`. When invoked:
1. Runs `audit-telegram-errors.py` in dry-run mode (no alert insertion) and prints the JSON.
2. For each bug-bucket entry, opens an interactive loop:
   - Shows message, stack, suspected file, recent commits touching that file.
   - Offers: `[d] diagnose deeper`, `[p] propose patch`, `[s] skip`, `[q] quit`.
   - `propose patch` drafts a diff, runs it through relevant tests (respecting CLAUDE.md testing policy), shows output, waits for user approval before `git add / commit`.
3. Fully manual commit — no auto-push.

This is the "self-correct" surface, but it's **supervised**. Consistent with the prior-conversation conclusion that auto-patching is out of scope for v1.

## Edge cases handled explicitly

- **First-ever run:** no state file → bootstrap by reading last 5 MB of each log and last 26h of `task_run_logs`. Log a note in the report.
- **Log rotation during the window:** detect via inode change on the log file; if inode changed, read both old and new. Stretch goal — first version can just re-bootstrap and note "log rotated, partial window."
- **Ollama down:** all `unknown` entries labeled `unknown (LLM unreachable)`. No crash.
- **DB locked:** open read-only with `PRAGMA busy_timeout=5000`, retry once. Exit 1 on persistent failure (launchd will re-run tomorrow).
- **Causal chains:** when a `Container timed out` is detected, suppress children within the same group within 2 minutes. One-liner in the transient section: "N follow-on errors collapsed under timeout at HH:MM."
- **Baseline drift:** store rolling 7-day success-rate in the state file so "95.8%" can be diffed against history rather than asserted statically.

## Testing plan (per CLAUDE.md testing policy)

Before shipping:
1. Unit-test the classifier with a fixtures file (`scripts/tests/test_audit_classifier.py`) — feed canned log lines, assert bucket.
2. Unit-test threshold logic (sustained vs one-off).
3. Integration test: run against today's real logs/DB, confirm the two known bugs (`OPS_ALERT_FOLDER`, `await in non-async`) show up in the `bug` bucket with correct representative messages.
4. Dry-run the launchd plist via `launchctl start com.nanoclaw.error-audit` before enabling the calendar schedule.

## Rollout order

1. Write `audit-telegram-errors.py` + classifier table + state-file logic.
2. Write the unit tests (classifier, threshold). Confirm passing.
3. Manual invocation against current logs. Inspect report by eye; confirm it catches the two known build-drift bugs and suppresses the 429s.
4. Write `.claude/commands/audit-errors.md` slash command.
5. Install launchd plist, enable, monitor for 3 days.
6. If report stays useful and wake-noise is low: update `MEMORY.md` with a `project_error_audit.md` linked entry.

## Open questions for user review

1. **Alert routing:** ops-claw vs CLAIRE vs both? Plan defaults to ops-claw with env-var override.
2. **Sustained threshold — exact definition:** `≥10 min span AND ≥3 occurrences`. Tighter (5 min / 5 occ)? Looser?
3. **Baseline diff:** should the report always fire when error-rate > 2× 7-day baseline, even if no single issue is sustained? Plan currently says yes — conservative.
4. **Error-log policy:** plan treats any line in `nanoclaw.error.log` as a bug. Anything there we should explicitly whitelist? (The credential-proxy warning spam is in `nanoclaw.log`, not the error log, so it's already excluded.)
