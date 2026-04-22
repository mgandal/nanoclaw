# Hermes → NanoClaw Migration Manifest

**Date:** 2026-04-21
**Scope:** Retire Hermes cron jobs that duplicate or are ported into NanoClaw. **Hermes itself stays installed** — this manifest documents what moved, not what was deleted.
**Status:** 10 of 11 Hermes jobs retired (enabled=false). 1 remains enabled pending cron verification.

## Why this exists

Traces every retired Hermes job to its NanoClaw equivalent so future-me can answer "what is this Hermes config doing / can I delete it?" without re-deriving the migration.

## Nothing was deleted

- `~/.hermes/` is untouched on disk (2.3 GB)
- `~/.hermes/honcho/` bind-mounts into the running Docker Honcho stack — **do not move or delete**
- `~/.hermes/cron/jobs.json` — jobs are `enabled: false` with `paused_reason` explaining each retirement; structure preserved
- `~/.hermes/skills/` — source of truth for the Hermes versions; referenced from the manifest below

Backups taken before every edit: `~/.hermes/cron/jobs.json.bak-*`, `~/.hermes/channel_directory.json.bak-*`.

## Retired Hermes jobs

### Phase 1 — duplicates (NanoClaw already covered)

| Hermes job | Retired state | NanoClaw equivalent |
|---|---|---|
| `AI Morning Brief + Builders Digest` | enabled=false | `hermes-ai-brief` (CODE-claw, `5 8 * * *`) |
| `slack-context-scanner` | enabled=false | `hermes-slack-scanner` (OPS-claw, `0 6 * * 1-5`) |
| `weekly-week-ahead` | enabled=false (was off) | `hermes-week-ahead` (CLAIRE, `0 10 * * 6`) |
| `blogwatcher-scan` | enabled=false (was off) | `hermes-blogwatcher` (VAULT-claw, `5 9 */2 * *`) |
| `paperpile-sync` | enabled=false (was off) | Dropped entirely — low recent use |
| `AI Builders Digest` | enabled=false (was off) | Rolled into `AI Morning Brief` → `hermes-ai-brief` |
| `Daily 7AM Priority Briefing` | enabled=false (was off) | Superseded by `claire-morning-briefing` (CLAIRE, `30 7 * * 1-5`) |

Regression test: `test_phase1_retirement.py` — asserts each NanoClaw equivalent ran in last 14d.

### Phase 2 — ported

| Hermes job | Retired state | NanoClaw port |
|---|---|---|
| `hermes-inbox-monitor` | **enabled=true** (pending verification) | `mgandal-cc-inbox` scheduled_task (OPS-claw, `30,0 9-17 * * 1-5`) |

Port artifacts:
- Skill: `container/skills/mgandal-cc-inbox/SKILL.md`
- Python pre-classifier: `scripts/lib/mgandal_cc_classify.py`
- Schedule row: `scheduled_tasks.id = 'mgandal-cc-inbox'`
- Tests: `test_phase2_mgandal_cc_inbox.py` (9 tests covering skill file, frontmatter, OPS-claw routing, DB registration, classifier labels)

**Retirement gate:** do NOT set `hermes-inbox-monitor.enabled = false` until at least one natural cron tick of `mgandal-cc-inbox` has landed successfully in OPS-claw (or posted an `❗ INBOX-CC auth failure:` marker, which proves the wire-up works). Gate lives in task #5 of the original TodoWrite list.

### Phase 3 — retired with coverage equivalence

| Hermes job | Retired state | NanoClaw coverage |
|---|---|---|
| `honcho-health-check` | enabled=false | Existing OPS-claw 11am task `task-1776026695750-3ayk1i`; extended with dialectic-latency probe to match Hermes depth |
| `Memory Stack Health Check` | enabled=false | Existing OPS-claw `task-1776026695765-w23mk8` — **partial coverage**, see "Known gaps" below |
| `daily-ops-pipeline` | enabled=false | Decomposed — each of 5 stages maps to a separate NanoClaw cron. See decomposition table below. |

Regression tests: `test_phase3_honcho_health.py` + `test_phase3_memory_daily_ops.py`.

### `daily-ops-pipeline` stage decomposition

| Stage | Hermes did | NanoClaw equivalent |
|---|---|---|
| 1. Health & recovery | Docker/Ollama/Hindsight/QMD probes + auto-restart | `task-1776026695750-3ayk1i` (OPS-claw, daily 11am — probe only, no auto-restart) |
| 2a. Slack ingest | Pull recent monitored channels | `slack-morning-digest-1776622600` (CLAIRE, `30 7 * * 1-5`) |
| 2b. Email ingest | `mgandal+hermes@gmail.com` → calendar/tasks | `mgandal-cc-inbox` (OPS-claw, every 30 min 9:30-17:30 wkdy) — address changed to `mgandal+cc@gmail.com` |
| 2c. External sources | Paperpile, Twitter bookmarks, Apple Notes | Sync launchd `com.nanoclaw.sync` every 4h (`scripts/sync/sync-all.sh`) |
| 3. Memory sync | SimpleMem + Cognee ingest | `task-1776026695765-w23mk8` — stale SimpleMem references, see gaps |
| 4. Task management | Todoist sync, close completed, flag overdue | `task-1776735101092-u2lq23` daily task-health check (OPS-claw, noon) |
| 5. Briefing generation | Compile stage outputs into morning brief | `claire-morning-briefing` (CLAIRE, 7:30 wkdy) |

## Known gaps — not blocking migration but tracked

1. **Memory integrity task references decommissioned SimpleMem.** `task-1776026695765-w23mk8` calls `mcp__simplemem__memory_query` for 6 group canaries, but SimpleMem was replaced by Honcho+Hindsight on 2026-04-06. The task silently never alerts because SimpleMem queries fail silently. Hermes's version was also broken. **Outcome:** zero working memory-canary coverage. Not a regression vs. pre-migration state — but worth fixing separately.

2. **daily-ops-pipeline Stage 1 auto-recovery is not ported.** Hermes attempted to restart Docker / Ollama / Hindsight on failure. NanoClaw only probes — it alerts, doesn't fix. Deliberate trade-off: auto-recovery on shared infra is risky and Hermes's specific restart patterns didn't always work.

3. **`mgandal+cc@gmail.com` vs `mgandal+hermes@gmail.com`.** Hermes's skill targets `+cc`, but the `daily-ops-pipeline` docs reference `+hermes`. The NanoClaw port follows the skill (`+cc`). If you also send BCCs to `+hermes` they'll be unprocessed — verify your BCC habit.

## Hermes state that stays active

- **`~/.hermes/honcho/` Docker bind-mounts** — Honcho API container (`honcho-api-1`) reads `~/.hermes/honcho/config.toml` and `~/.hermes/honcho/docker/` as read-only bind-mounts. Do not delete this subtree without first migrating the Docker stack to a new config path.
- **`ai.hermes.gateway` + `ai.hermes.gateway-franklin` launchd services** — still running. `hermes-inbox-monitor` is the last cron using the gateway; retire after its replacement verifies green.
- **`~/.hermes/memories/`, `~/.hermes/sessions/`** — Hermes session history. No NanoClaw dependency on these. Archive worthy eventually; ignored for now.

## Also updated this session (not retirements)

- `groups/telegram_claire/CLAUDE.md` — added "Alert Routing" section → security/auth/infra alerts go to OPS-claw, not CLAIRE
- `data/agents/claire/memory.md` — recorded 2026-04-21 routing decision + "rclone OAuth grants are expected" note
- `~/.hermes/channel_directory.json` — added OPS-claw entry (backup `.bak-*` taken)
- `~/.hermes/skills/email/hermes-inbox-monitor/SKILL.md` — Step 3 rewritten to route reports/errors to OPS-claw (belt-and-suspenders while job is still enabled)

## If you need to roll back

1. **Re-enable Hermes jobs:** `python3 -c "import json; p='~/.hermes/cron/jobs.json'; ..."` to flip `enabled` back to `true` for any named job. Backups at `~/.hermes/cron/jobs.json.bak-*`.
2. **Restore Hermes channel_directory:** `cp ~/.hermes/channel_directory.json.bak-20260421-* ~/.hermes/channel_directory.json`
3. **Disable NanoClaw port:** `sqlite3 ~/Agents/nanoclaw/store/messages.db "UPDATE scheduled_tasks SET status='disabled' WHERE id='mgandal-cc-inbox';"`
4. **Remove added CLAUDE.md / memory.md text** — both changes are in `git diff` if this session's edits aren't committed; otherwise check `groups/telegram_claire/CLAUDE.md` for the "Alert Routing" section and `data/agents/claire/memory.md` for the 2026-04-21 entry.

## Test inventory

All migration tests are in `scripts/tests/migration/` and run with `pytest`:

```
test_phase1_retirement.py            4 tests — NanoClaw dupes ran recently
test_phase2_mgandal_cc_inbox.py      9 tests — skill + schedule + classifier
test_phase3_honcho_health.py         4 tests — NanoClaw covers Honcho + dialectic
test_phase3_memory_daily_ops.py      6 tests — daily-ops decomposition coverage
                                    ─────
                                    23 tests (all green as of 2026-04-21)
```

Run everything: `cd ~/Agents/nanoclaw && python3 -m pytest scripts/tests/migration/ -v`

**Disposable:** these tests exist to gate the migration. Once `hermes-inbox-monitor` is retired and 1-2 weeks have passed with no regressions, the entire `scripts/tests/migration/` directory can be deleted.
