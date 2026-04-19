---
name: cost-report
description: >
  Weekly NanoClaw LLM cost breakdown by model / group / scheduled-task. Adapted from
  Terp's hermes-optimization-guide cost-report pattern. Uses Claude subscription +
  Ollama counters; reports cache hit rate and anomaly days. Triggers: "/cost-report",
  "weekly cost", "how much am I spending", "model spend".
allowed-tools: Read Bash Glob Grep
---

# cost-report — NanoClaw Cost Breakdown

Generate a human-readable weekly cost and usage report. NanoClaw uses a Claude
subscription (OAuth token, no per-token billing) plus local Ollama, so this is primarily
a **usage and efficiency** report rather than a dollar report. Still useful for:

- Spotting runaway scheduled tasks
- Detecting cache-hit-rate drops (expensive tokens reprocessed)
- Deciding when a task should be moved to local Ollama
- Flagging groups that suddenly blew past their typical volume

## Procedure

1. **Pull session logs** from the last `window` (default 7 days):
   ```bash
   # NanoClaw logs go to logs/nanoclaw.log via launchd plist
   awk -v since="$(date -u -v-7d +%Y-%m-%dT%H:%M:%S)" \
       '$1 > since' /Users/mgandal/Agents/nanoclaw/logs/nanoclaw.log \
       > /tmp/nanoclaw-week.log
   ```

2. **Extract per-message token counts** from the SDK output. Look for lines matching
   the SDK usage report format (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
   `cache_creation_input_tokens`). If the format is not stable, fall back to counting
   agent invocations per group from `store/messages.db`:
   ```bash
   sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
     "SELECT group_folder, COUNT(*) AS msgs FROM messages
      WHERE created_at > datetime('now','-7 days')
      GROUP BY 1 ORDER BY 2 DESC;"
   ```

3. **Aggregate Ollama usage.** Ollama doesn't bill but does log per-request. Check
   `~/.ollama/logs/` (or `journalctl --user -u ollama` on Linux) for request counts per
   model. The sync pipeline (`scripts/sync/email-ingest.py`) is the heaviest Ollama
   consumer — count its runs from `scripts/sync/sync.log`.

4. **Produce four tables:**

   **A. By group** (Telegram group folder)
   ```
   Group                   Messages  Sessions  Avg turns/session
   telegram_code-claw      84        21        4.0
   telegram_claire         142       31        4.6
   telegram_science-claw   47        12        3.9
   telegram_lab-claw       22        8         2.8
   …
   ```

   **B. By scheduled task**
   ```
   Task                        Runs  Avg duration (min)
   morning_inbox_sweep         7     2.3
   weekly_status_report        1     8.1
   email-ingest sync (cron)    42    4.7
   ```

   **C. By Ollama model** (local, free, but infra-bounded)
   ```
   Model              Requests  Hours busy
   phi4-mini          412       1.2
   nomic-embed-text   1,820     0.4
   ```

   **D. Daily trend** (ASCII sparkline of total NanoClaw message volume)
   ```
   Mon ▂
   Tue ▃
   Wed ▅█  ← inbox-triage caught up on backlog
   Thu ▃
   Fri ▄
   Sat ▂
   Sun ▁
   Total messages: 297 | Total sessions: 72
   ```

5. **Cache-hit rate.** When the SDK logs `cache_read_input_tokens` vs
   `cache_creation_input_tokens`, compute:
   ```
   cache_hit_rate = cache_read / (cache_read + cache_creation + regular_input)
   ```
   Report per group. **If any group is below 40% and runs >20 sessions/week, flag it**
   — something about the prompt or tool list is invalidating the cache (e.g. dynamic
   timestamp in the system prompt, or a hot.md that mutates every turn).

6. **Flag anomalies.** 3× median-absolute-deviation rule on daily volume. Example:
   > ⚠ Wed spent 4.5× typical volume. Driven by `morning_inbox_sweep` looping.

7. **Recommend optimizations.** Pattern-match:
   - Any single group > 50% of weekly volume and repetitive task structure → consider
     moving prompt chunks to the system/hot.md section to benefit from prompt caching
   - Ollama model requests > 10× other models → that model is load-bearing; pin it with
     `keep_alive: -1m` so it doesn't cold-start
   - Scheduled task with steadily rising duration → runaway loop; check its code

8. **Deliver.** Post to CODE-claw (or OPS-claw) as a Telegram message. Keep under 40
   lines. Attach raw JSON if `--format json`.

## Cron wiring

To run weekly, add a scheduled task via NanoClaw's task scheduler (not launchd, so it
runs inside the agent container with context):

```
/schedule weekly-cost-report "0 9 * * 1" "/cost-report window=7d"
```

## What this is *not*

- **Not a billing report** — the Claude subscription is flat-rate.
- **Not a replacement for Langfuse / Phoenix.** For production-grade observability,
  wire a Langfuse proxy in front of the credential proxy (see the hermes-optimization
  guide, Part 20). This skill is the zero-dependency alternative.

## Sources

Structure adapted from `skills/ops/cost-report/SKILL.md` in
[OnlyTerp/hermes-optimization-guide](https://github.com/OnlyTerp/hermes-optimization-guide).
Hermes-specific `hermes logs` command replaced with NanoClaw's launchd log + SQLite
store. Dollar-cost tables dropped (Claude subscription is flat); emphasis shifted to
cache-hit rate and anomaly detection, which matter more under a subscription.
