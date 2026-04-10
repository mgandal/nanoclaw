# Hermes → NanoClaw Workflow Migration

**Date:** 2026-04-10
**Status:** Draft (v2, revised after peer review)
**Scope:** Transfer Hermes' non-redundant recurring workflows to NanoClaw, sync state files, add paperpile-sync launchd job. Hermes stays running but deprioritized.

## Context

Hermes (`~/.hermes/`) is an AI Chief of Staff agent running recurring cron jobs, email triage, Slack scanning, and admin workflows. NanoClaw is the primary agent with sandboxed container execution, MCP tool access, and 23 existing scheduled tasks. The goal is to make NanoClaw self-sufficient for all daily operations so Hermes can be deprioritized without loss of functionality.

### Overlap Analysis

NanoClaw already covers:
- Morning briefing (7:30 AM weekdays) — covers Hermes' daily-ops-pipeline
- Inbox-convert pipeline (every 30 min) — covers Hermes' inbox-monitor
- Weekly deadline reports + follow-up audits — covers Hermes' week-ahead partially
- 8-hour context refresh across all groups
- X bookmarks, Readwise sync, wiki lint, memory integrity
- Health monitoring (built into NanoClaw core, not a cron)

Hermes has 5 non-redundant workflows that NanoClaw lacks:
1. Slack context scanner
2. Weekly week-ahead preview
3. AI morning brief / builders digest
4. Blogwatcher RSS scan
5. Paperpile bibliography sync

## Design

### Approach

- **Scheduled tasks + MCP tools** for workflow 2 (week-ahead). Container agents use existing MCP servers (Calendar, Todoist, Gmail, QMD, Hindsight).
- **Infrastructure additions** for workflows 1, 3, and 4 — these require capabilities not currently in NanoClaw containers:
  - Slack context scanner: Add Slack MCP to container agent-runner
  - AI morning brief: Port `follow-builders` preprocessing into container, add Supadata API key
  - Blogwatcher: Install `blogwatcher-cli` in container Dockerfile, mount persistent SQLite state
- **Host-side launchd job** for paperpile-sync (needs Google Drive API, can't run in container).
- **Dual-run verification** before pausing each Hermes cron: both agents run in parallel for 24-48h to confirm NanoClaw's output is equivalent or better.
- **No cross-agent delegation.** NanoClaw handles everything end-to-end. Hermes does not execute work on NanoClaw's behalf.

### Anti-Spam Guardrail

Both agents listen on the same Telegram groups. To prevent duplicate responses:
- NanoClaw takes priority on all shared channels (it already has `requires_trigger=0` on all groups).
- Hermes responds only when directly addressed by name ("Hermes") or when NanoClaw is down.
- After migration, Hermes' cron delivery targets are paused, not deleted — enabling instant rollback.

### Rollback Procedure

If a migrated workflow fails on NanoClaw:
1. Re-enable the corresponding Hermes cron job.
2. Disable the NanoClaw scheduled task.
3. No code changes needed — both systems are independent.

## Workflow Specifications

### 1. Slack Context Scanner

- **Group:** LAB-claw
- **Schedule:** `0 6 * * 1-5` (6 AM weekdays)
- **Prerequisites:**
  - Add Slack MCP server to `container/agent-runner/src/index.ts` `buildMcpServers()`, conditional on `SLACK_MCP_URL` env var
  - Add `SLACK_MCP_URL` injection to `src/container-runner.ts` `buildContainerArgs()` (same pattern as Calendar, Todoist, etc.)
  - Add `mcp__slack__*` to `allowedTools` in agent-runner
  - Verify Slack bot is a member of target channels (#papers, #bioinformatics, #group-meetings, #general)
- **What it does:**
  - Uses Slack MCP tools (`mcp__slack__conversations_history`, `mcp__slack__conversations_search_messages`) to scan key channels
  - Looks for: deadlines, decisions, action items, meeting changes, requests directed at Mike
  - Classifies findings as HIGH or MEDIUM priority
  - Stores important context in Hindsight via `mcp__hindsight__retain`
  - Sends summary to LAB-claw Telegram. If nothing notable, sends a one-line "all clear"
- **Replaces:** Hermes `slack-context-scanner` (cron `e31e1430687d`)

### 2. Weekly Week-Ahead Preview

- **Group:** CLAIRE
- **Schedule:** `0 10 * * 6` (Saturday 10 AM)
- **Prerequisites:** None — all MCP tools already available (Calendar, Todoist, Gmail)
- **What it does:**
  - Reads next week's calendar via Calendar MCP (`calendar_range` for Mon-Fri)
  - Checks Todoist for overdue and upcoming tasks via Todoist MCP
  - Scans recent email via Gmail MCP for pending threads that need replies
  - Reads `/workspace/global/state/current.md` for active priorities and escalations
  - Identifies: scheduling conflicts, meeting prep needs, approaching deadlines, stale follow-ups
  - Includes family calendar events (Eli, Sophie) for conflict detection
  - Flags events before 9:30 AM or after 6 PM
  - Sends a structured week preview to CLAIRE Telegram
- **Replaces:** Hermes `weekly-week-ahead` (cron `054d0a9da127`)

### 3. AI Morning Brief + Builders Digest

- **Group:** CODE-claw
- **Schedule:** `5 8 * * *` (8:05 AM daily — offset to avoid collision with readwise-daily-sync at 8:00)
- **Prerequisites:**
  - Port `~/.hermes/skills/follow-builders/` into a NanoClaw container skill at `container/skills/follow-builders/`
  - Copy `prepare-digest.js` preprocessing script into the container skill directory
  - Add `SUPADATA_API_KEY` to `readEnvFile()` in `src/container-runner.ts` and pass as env var
  - The container already has Node.js — `prepare-digest.js` can run via `node` in Bash
- **What it does:**
  - Runs `prepare-digest.js` to fetch and preprocess builder activity from X/Twitter feeds and podcast episodes
  - LLM remixes the preprocessed JSON into a curated 3-5 item digest
  - Focuses on: Claude/Anthropic, OpenAI, open-source models, AI for science, bioinformatics tools
  - Sends digest to CODE-claw Telegram
- **Replaces:** Hermes `AI Morning Brief + Builders Digest` (cron `8fd92b52c460`) and paused `follow-builders` (cron `bfd2662f64e8`)

### 4. Blogwatcher / RSS Scan

- **Group:** VAULT-claw
- **Schedule:** `5 9 */2 * *` (9:05 AM every other day — offset to avoid collision with VAULT daily briefing and x-bookmarks at 9:00)
- **Prerequisites:**
  - Install `blogwatcher-cli` in container Dockerfile (Go binary or pre-compiled)
  - Mount persistent storage for blogwatcher SQLite state DB. Options:
    - Per-group persistent volume at `data/sessions/telegram_vault-claw/blogwatcher/` mounted to `/home/node/.blogwatcher-cli/` in container
    - This preserves read/unread state across container runs
  - Copy Hermes' blogwatcher config (feed list, categories) from `~/.blogwatcher-cli/` to the mounted directory
- **What it does:**
  - Runs `blogwatcher articles --unread` to check for new RSS feed entries
  - Feed categories: genomics, psychiatric genetics, single-cell, long-read sequencing, AI for biology
  - If new articles found: summarizes, stores in Hindsight via `mcp__hindsight__retain`, reports to VAULT-claw
  - If no new articles: returns `NO_OUTPUT` (silent — no Telegram message)
  - Marks articles as read after processing to prevent re-reporting
- **Replaces:** Hermes `blogwatcher-scan` (cron `228956dd492f`)

### 5. Paperpile Sync (Host-Side)

- **Type:** Launchd job (NOT a NanoClaw scheduled task)
- **Schedule:** `0 6 * * *` (6 AM daily)
- **Plist:** `~/Library/LaunchAgents/com.nanoclaw.paperpile-sync.plist`
- **What it does:**
  - Runs a copy of `~/.hermes/scripts/paperpile_sync.py` placed at `scripts/sync/paperpile_sync.py`
  - Downloads `paperpile.bib` from Google Drive (file ID: `1UtOxQ8-IxaNU5B-rCEXrLuuq5FHgM-gP`)
  - OAuth token: `~/.hermes/google_token.json` (reuses Hermes' existing credential)
  - Destination: `~/.hermes/paperpile.bib` (existing location, accessible by both agents)
  - Logs: `logs/paperpile-sync.log`
- **Replaces:** Hermes `paperpile-sync` (cron `f3b4af40b480`)
- **Why host-side:** Google Drive file download requires OAuth + filesystem write outside container sandbox

## State File Sync

One-time sync from `~/Agents/hermes-working/state/` to `groups/global/state/`. After this, NanoClaw is the canonical source for all state files.

### Files to copy from Hermes (missing in NanoClaw)

| File | Source | Content |
|------|--------|---------|
| `decisions.md` | state/ | 8 standing architectural/operational decisions |
| `data-access-requests.md` | state/ | dbGAP renewal tracking (critical: May 1 deadline) |
| `cv-current.md` | state/ | CV metadata snapshot |
| `lessons.md` | tasks/ | 17 operational lessons learned |

### Files to update (Hermes is newer)

| File | Hermes Date | NanoClaw Date | Action |
|------|-------------|---------------|--------|
| `context.md` | Apr 6 (8.2K) | Mar 26 (6.0K) | Overwrite with Hermes version |
| `grants.md` | Apr 8 (6.3K) | Mar 26 (4.3K) | Overwrite with Hermes version |
| `memory.md` | Apr 6 (2.8K) | Mar 31 (1.3K) | Overwrite with Hermes version |

### Files to keep as-is in NanoClaw (NanoClaw is canonical)

| File | Why |
|------|-----|
| `current.md` | NanoClaw version is Apr 10, 10.4KB — much more detailed than Hermes' 2.3KB |
| `knowledge-graph.md` | NanoClaw-generated (346KB), not from Hermes |
| `integrations.md` | NanoClaw-specific integration reference |
| `USER.md` | NanoClaw identity reference |
| `todo.md` | NanoClaw task tracking |

### Files to inspect manually before deciding

| File | Issue |
|------|-------|
| `goals.md` | NanoClaw is 2.4KB (Mar 26), Hermes is 1.1KB (Apr 6). NanoClaw is larger despite being older — inspect content to determine which is more complete |

### Files with identical content (no action)

`lab-roster.md`, `lab-todos.md`, `papers.md`, `projects.md`, `watchlist.md` — same size in both locations. Keep NanoClaw's copies.

## Implementation Order

1. **State file sync** — prerequisite, gives NanoClaw agents the context they need
2. **Weekly week-ahead** (Saturday 10 AM) — no infrastructure needed, tests Calendar + Todoist + Gmail MCP
3. **Slack context scanner** (6 AM weekdays) — requires adding Slack MCP to containers
4. **AI morning brief** (8:05 AM daily) — requires porting follow-builders skill + Supadata API key
5. **Blogwatcher** (9:05 AM every other day) — requires Dockerfile change + persistent volume
6. **Paperpile sync** (6 AM daily) — host-side, independent of the others

Each workflow: create task → wait for first fire → verify output → dual-run 24-48h → pause Hermes cron.

## Infrastructure Changes Required

### Container Agent-Runner (`container/agent-runner/src/index.ts`)

1. Add Slack MCP server to `buildMcpServers()`:
   ```
   if (process.env.SLACK_MCP_URL) servers.slack = { url: process.env.SLACK_MCP_URL, transport: 'http' }
   ```
2. Add `mcp__slack__*` to `allowedTools` array

### Container Runner (`src/container-runner.ts`)

1. Add `SLACK_MCP_URL` env var injection in `buildContainerArgs()` (same pattern as CALENDAR_URL)
2. Add `SUPADATA_API_KEY` env var injection for follow-builders preprocessing
3. Add both to `readEnvFile()` calls and log redaction

### Dockerfile (`container/Dockerfile`)

1. Install `blogwatcher-cli` (pre-compiled binary or build from source)
2. Ensure Node.js available for `prepare-digest.js` (already present)

### Volume Mounts (`src/container-runner.ts` `buildVolumeMounts()`)

1. Add persistent blogwatcher state mount for VAULT-claw group:
   - Host: `data/sessions/telegram_vault-claw/blogwatcher/`
   - Container: `/home/node/.blogwatcher-cli/`

### Container Skills (`container/skills/`)

1. Add `follow-builders/` skill with `SKILL.md` and `prepare-digest.js`

### Launchd

1. Create `~/Library/LaunchAgents/com.nanoclaw.paperpile-sync.plist`

## Non-Goals

- No cross-agent delegation protocol (NanoClaw → Hermes)
- No CLINIC-claw group migration (can add later)
- No Hermes skill porting beyond follow-builders (chatgpt-hermes, imessage, ontology, dogfood)
- No changes to Hermes' code or architecture
- No Hermes shutdown — it stays running as fallback

## Success Criteria

- All 5 workflows running on NanoClaw with equivalent or better output
- Corresponding Hermes crons paused
- State files synced and current in `groups/global/state/`
- No duplicate messages in Telegram groups
- Blogwatcher maintains read/unread state across container runs
- Follow-builders preprocessing produces same quality digest as Hermes
- Hermes can resume full operations within minutes if needed (re-enable crons)
