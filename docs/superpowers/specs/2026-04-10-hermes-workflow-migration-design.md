# Hermes → NanoClaw Workflow Migration

**Date:** 2026-04-10
**Status:** Draft
**Scope:** Transfer Hermes' non-redundant recurring workflows to NanoClaw, sync state files, add paperpile-sync launchd job. Hermes stays running but deprioritized.

## Context

Hermes (`~/.hermes/`) is an AI Chief of Staff agent running recurring cron jobs, email triage, Slack scanning, and admin workflows. NanoClaw is the primary agent with sandboxed container execution, MCP tool access, and 23 existing scheduled tasks. The goal is to make NanoClaw self-sufficient for all daily operations so Hermes can be deprioritized without loss of functionality.

### Overlap Analysis

NanoClaw already covers:
- Morning briefing (7:30 AM weekdays) — covers Hermes' daily-ops-pipeline partially
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

- **Scheduled tasks + MCP tools** for workflows 1-4. Container agents use existing MCP servers (Slack, Gmail, Calendar, Todoist, QMD, Hindsight) to replicate what Hermes does with host-side Python scripts.
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
- **What it does:**
  - Uses Slack MCP tools (`mcp__slack__conversations_history`, `mcp__slack__conversations_search_messages`) to scan key channels: #papers, #bioinformatics, #group-meetings, #general, and any active project channels.
  - Looks for: deadlines, decisions, action items, meeting changes, requests directed at Mike.
  - Classifies findings as HIGH or MEDIUM priority.
  - Stores important context in Hindsight via `hindsight_retain`.
  - Sends summary to LAB-claw Telegram. If nothing notable, sends a one-line "all clear."
- **Replaces:** Hermes `slack-context-scanner` (cron `e31e1430687d`)

### 2. Weekly Week-Ahead Preview

- **Group:** CLAIRE
- **Schedule:** `0 10 * * 6` (Saturday 10 AM)
- **What it does:**
  - Reads next week's calendar via Calendar MCP (`calendar_range` for Mon-Fri).
  - Checks Todoist for overdue and upcoming tasks via Todoist MCP.
  - Scans recent email via Gmail MCP for pending threads that need replies.
  - Reads `groups/global/state/current.md` for active priorities and escalations.
  - Identifies: scheduling conflicts, meeting prep needs, approaching deadlines, stale follow-ups.
  - Sends a structured week preview to CLAIRE Telegram.
- **Replaces:** Hermes `weekly-week-ahead` (cron `054d0a9da127`)

### 3. AI Morning Brief + Builders Digest

- **Group:** CODE-claw
- **Schedule:** `0 8 * * *` (8 AM daily)
- **What it does:**
  - Uses web search to find latest AI news: model releases, research papers, industry announcements, open-source developments.
  - Focuses on items relevant to a psychiatric genomics PI who builds with AI: Claude/Anthropic, OpenAI, open-source models, AI for science, bioinformatics tools.
  - Curates 3-5 most relevant items with one-sentence summaries and links.
  - Sends digest to CODE-claw Telegram.
- **Replaces:** Hermes `AI Morning Brief + Builders Digest` (cron `8fd92b52c460`) and paused `follow-builders` (cron `bfd2662f64e8`)

### 4. Blogwatcher / RSS Scan

- **Group:** VAULT-claw
- **Schedule:** `0 9 */2 * *` (9 AM every other day)
- **What it does:**
  - Uses web search to check key research blogs and feeds: genomics, psychiatric genetics, single-cell, long-read sequencing, AI for biology.
  - Checks the watchlist in `groups/global/state/watchlist.md` for monitored labs, researchers, and topics.
  - If noteworthy posts found: summarizes, stores in Hindsight, reports to VAULT-claw.
  - If nothing notable: silent (no message).
- **Replaces:** Hermes `blogwatcher-scan` (cron `228956dd492f`)

### 5. Paperpile Sync (Host-Side)

- **Type:** Launchd job (NOT a NanoClaw scheduled task)
- **Schedule:** `0 6 * * *` (6 AM daily)
- **Plist:** `~/Library/LaunchAgents/com.nanoclaw.paperpile-sync.plist`
- **What it does:**
  - Runs Hermes' existing `~/.hermes/scripts/paperpile_sync.py` (or a copy of it).
  - Downloads `paperpile.bib` from Google Drive to a location accessible by NanoClaw containers.
  - Uses existing Google OAuth credentials at `~/.gmail-mcp/`.
  - Destination: `/Volumes/sandisk4TB/Dropbox/AGENTS/marvin-vault/paperpile.bib` (already in the mounted vault).
- **Replaces:** Hermes `paperpile-sync` (cron `f3b4af40b480`)
- **Why host-side:** Google Drive file download requires OAuth + filesystem write outside container sandbox.

## State File Sync

Compare `~/Agents/hermes-working/state/` against `groups/global/state/` and copy files that are missing or have newer content in Hermes.

**Expected files to sync:**
- `decisions.md` — standing architectural/operational decisions (8 entries)
- `data-access-requests.md` — dbGAP renewal tracking (critical: May 1 deadline)

**From `~/Agents/hermes-working/tasks/`:**
- `lessons.md` — 17 operational lessons learned → copy to `groups/global/state/lessons.md`

**Already present in both (verify currency):**
- `current.md`, `context.md`, `grants.md`, `projects.md`, `lab-roster.md`, `papers.md`, `goals.md`, `memory.md`, `watchlist.md`

For files present in both: compare timestamps and content. If Hermes' version is newer or has content NanoClaw's lacks, merge the updates.

## Implementation Order

1. **State file sync** — prerequisite, gives NanoClaw agents the context they need
2. **Slack context scanner** — highest daily value, tests Slack MCP integration
3. **Weekly week-ahead** — high value, tests Calendar + Todoist + Gmail MCP together
4. **AI morning brief** — straightforward web search task
5. **Blogwatcher** — lowest urgency, tests watchlist-driven search
6. **Paperpile sync** — host-side, independent of the others

Each workflow: create task → wait for first fire → verify output → dual-run 24-48h → pause Hermes cron.

## Non-Goals

- No cross-agent delegation protocol (NanoClaw → Hermes)
- No CLINIC-claw group migration (can add later)
- No Hermes skill porting (chatgpt-hermes, imessage, ontology, dogfood)
- No changes to Hermes' code or architecture
- No Hermes shutdown — it stays running as fallback

## Success Criteria

- All 5 workflows running on NanoClaw with equivalent or better output
- Corresponding Hermes crons paused
- State files synced and current in `groups/global/state/`
- No duplicate messages in Telegram groups
- Hermes can resume full operations within minutes if needed (re-enable crons)
