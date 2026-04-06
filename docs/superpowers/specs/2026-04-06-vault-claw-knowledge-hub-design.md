# VAULT-claw Knowledge Hub — Design Spec

> Date: 2026-04-06
> Status: DRAFT

## Goal

Make VAULT-claw the primary knowledge ingestion channel. Three capabilities:

1. **Link ingest** — Mike pastes a URL, VAULT-claw immediately ingests it into the wiki
2. **Readwise Reader sync** — Every 24h, fetch new Reader documents and ingest them
3. **X/Twitter bookmarks sync** — Every 24h, fetch new bookmarks and ingest them (deferred — needs Playwright scraper)

## Part A: Direct Link Ingest

### Current behavior
VAULT-claw publishes to message bus (`wiki-ingest` topic, `action_needed: telegram_claire`). Claire picks it up on next spawn — could be hours.

### New behavior
VAULT-claw does the wiki ingest itself, immediately. It has the vault mount (`/workspace/extra/claire-vault/`) and the wiki skill (`container/skills/wiki/SKILL.md`). After ingesting, it notifies Claire via bus publish (informational, not action-needed).

### Changes required
- **`groups/telegram_vault-claw/CLAUDE.md`** — Replace "Wiki Forwarding Rule" section with direct ingest instructions. VAULT-claw should:
  1. Fetch the URL content (curl or agent-browser)
  2. Save source to `99-wiki/sources/`
  3. Create/update wiki pages following WIKI-SCHEMA.md
  4. Update `99-wiki/index.md` and `99-wiki/log.md`
  5. Confirm to Mike in chat with a brief summary of what was added
  6. Publish to bus (topic: `wiki-update`, no `action_needed`) so Claire knows

### Risk
VAULT-claw is a non-main group with the vault mounted read-write. The wiki skill is already designed for this. Low risk.

## Part B: Readwise Reader Sync

### Architecture
A NanoClaw scheduled task on VAULT-claw that runs every 24 hours. The task prompt instructs the agent to:
1. Run `readwise reader-list-documents` to fetch new documents since last sync
2. For each new document: read details, create wiki page, update index
3. Send a digest summary to VAULT-claw Telegram
4. Track last sync timestamp in a state file

### Prerequisites
1. **Readwise CLI in container** — Add `@readwise/cli` to Dockerfile global npm install
2. **Readwise token** — Pass as env var `READWISE_ACCESS_TOKEN` to containers with vault mount
3. **Container rebuild** — Required for the CLI installation

### Container changes
- **`container/Dockerfile`** — Add `@readwise/cli` to the `npm install -g` line
- **`src/container-runner.ts`** — Add `READWISE_ACCESS_TOKEN` env var injection (same pattern as TODOIST_API_TOKEN)
- **`.env`** — Add `READWISE_ACCESS_TOKEN=2IvMtYMKtGDksAgbWwzzuQA3EAHV13t3bIdpaGEMyYNu9SzPA8`

### Scheduled task setup
Created via IPC from VAULT-claw or manually via sqlite. Cron: `0 8 * * *` (8am daily).

Prompt for the scheduled task:
```
Readwise Reader daily sync. Fetch new Reader documents since last sync.

1. Read /workspace/group/readwise-state.json for last sync timestamp (if missing, use 7 days ago)
2. Run: readwise reader-list-documents --saved-at-gt "{last_sync}" --limit 50 --response-fields title,author,summary,category,url,saved_at,word_count
3. For each new document:
   a. Save source details to 99-wiki/sources/ following wiki conventions
   b. Create or update wiki page in appropriate subdirectory (papers/ for articles, tools/ for tools, etc.)
   c. Update 99-wiki/index.md and 99-wiki/log.md
4. Write updated timestamp to /workspace/group/readwise-state.json
5. Send digest to this group: count of new items, titles, categories
6. If no new items: send brief "No new Readwise items since {date}"
```

Context mode: `group` (persistent session for state tracking).

### Authentication flow
The `readwise` CLI needs a one-time login:
```bash
readwise login-with-token <token>
```
This stores credentials in `~/.config/readwise/` inside the container. Since containers are ephemeral, we need to either:
- (a) Run the login as part of the task prompt (simple, uses the env var each time)
- (b) Mount a persistent config directory

Option (a) is simpler: add `readwise login-with-token $READWISE_ACCESS_TOKEN` to the task's `script` field (pre-task bash).

## Part C: X/Twitter Bookmarks Sync (DEFERRED)

No API key available. Options:
1. **Playwright scraper** — Navigate to x.com/i/bookmarks, extract bookmark URLs. Requires persistent X session cookies.
2. **RSS bridge** — Third-party services that expose X bookmarks as RSS. Unreliable.
3. **Manual** — Mike copies bookmark URLs to VAULT-claw. Already works via Part A.

Recommend deferring to a separate implementation. The `bird` CLI (already in container) can read tweets by URL but has no bookmark-listing capability.

## Implementation Order

1. Update VAULT-claw CLAUDE.md (Part A — link ingest)
2. Add Readwise CLI to Dockerfile + rebuild container
3. Add READWISE_ACCESS_TOKEN to .env and container-runner.ts
4. Create scheduled task for Readwise sync (Part B)
5. Test: paste a URL to VAULT-claw, verify wiki ingest
6. Test: trigger Readwise sync manually, verify wiki ingest
7. (Future) Implement X bookmark scraper (Part C)

## Files to modify

| File | Change |
|------|--------|
| `groups/telegram_vault-claw/CLAUDE.md` | Replace forwarding with direct ingest |
| `container/Dockerfile` | Add `@readwise/cli` to npm install |
| `.env` | Add `READWISE_ACCESS_TOKEN` |
| `src/container-runner.ts` | Inject `READWISE_ACCESS_TOKEN` into containers |
| `container/build.sh` | No change (rebuilds automatically) |

## Not in scope

- X bookmark sync (deferred — Part C)
- Readwise highlight sync (only Reader documents for now)
- Two-way sync (we don't write back to Readwise)
- SimpleMem tool name fix (separate task)
