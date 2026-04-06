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

## Part C: X/Twitter Bookmarks Sync

No API key. Uses Playwright browser automation via the existing X integration skill infrastructure.

### Architecture

The X integration skill (`.claude/skills/x-integration/`) already has:
- Playwright with persistent Chrome profile (`data/x-browser-profile/`)
- Host-side IPC handler (`host.ts` → spawns script subprocesses)
- Container-side MCP tool definitions (`agent.ts`)
- Authentication via `setup.ts` (user logs into X once, session persists)

The bookmark scraper adds one new script (`scripts/bookmarks.ts`) and one new IPC handler (`x_bookmarks`), following the identical pattern as `like.ts`, `post.ts`, etc.

### New script: `scripts/bookmarks.ts`

```
Input: { limit?: number, sinceId?: string }
Output: { success: true, data: { bookmarks: [{ id, url, author, text, timestamp }] } }
```

Steps:
1. `getBrowserContext()` — reuse authenticated Chrome profile
2. Navigate to `https://x.com/i/bookmarks`
3. Wait for `article[data-testid="tweet"]` elements to load
4. For each visible tweet card, extract:
   - Tweet URL (from the timestamp link `a[href*="/status/"]`)
   - Author (`[data-testid="User-Name"]`)
   - Text content (`[data-testid="tweetText"]`)
   - Tweet ID (from URL)
5. If `sinceId` provided, stop scraping when we hit that ID (incremental)
6. If `limit` provided, stop after N bookmarks
7. Scroll down and repeat until limit/sinceId reached or no more content
8. Return structured array

### Scrolling strategy
X bookmarks page uses infinite scroll. The script:
1. Scrapes visible tweets
2. Scrolls to bottom (`window.scrollTo(0, document.body.scrollHeight)`)
3. Waits 2s for new content
4. Repeats until: limit reached, sinceId found, or no new tweets after 3 scroll attempts

Default limit: 50 bookmarks per sync (keeps runtime under 2 minutes).

### Host-side IPC handler

Add `x_bookmarks` case to `host.ts`:
```typescript
case 'x_bookmarks':
  result = await runScript('bookmarks', {
    limit: data.limit ?? 50,
    sinceId: data.sinceId
  });
  break;
```

### Container-side MCP tool

Add to `agent.ts`:
```typescript
{
  name: 'x_bookmarks',
  description: 'Fetch recent X/Twitter bookmarks',
  parameters: {
    limit: { type: 'number', description: 'Max bookmarks to fetch (default 50)' },
    sinceId: { type: 'string', description: 'Stop at this tweet ID (for incremental sync)' }
  }
}
```

### Scheduled task

A VAULT-claw scheduled task (cron: `0 9 * * *`, 9am daily, staggered 1h after Readwise):

```
X Bookmarks daily sync. Fetch new bookmarks since last check.

1. Read /workspace/group/x-bookmarks-state.json for last synced tweet ID
2. Call x_bookmarks tool with sinceId from state (or no sinceId if first run, limit 50)
3. For each new bookmark:
   a. Read the full tweet/thread using bird CLI: bird read {url}
   b. Determine category (paper, tool, article, thread, other)
   c. Create/update wiki page if substantial (papers, tools, threads)
   d. Save to 99-wiki/sources/ as raw capture
   e. Update 99-wiki/index.md and log.md
4. Write newest tweet ID to state file
5. Send digest to this group
```

### Prerequisites

1. **X integration must be set up first** — run `setup.ts` to authenticate Chrome profile
2. **X integration must be integrated into NanoClaw** — the skill's SKILL.md documents the 4 integration points (ipc.ts, ipc-mcp-stdio.ts, Dockerfile, build.sh) that need wiring up
3. **Is it already integrated?** If not, this is a dependency.

### Risk: X UI changes

X frequently updates their DOM. Selectors may break. Mitigation:
- Use `data-testid` attributes (X's own test IDs, more stable than classes)
- The script should gracefully return an error with the selector that failed, making fixes quick
- Same risk already accepted for post/like/reply/retweet scripts

### Risk: Rate limiting / detection

Scraping bookmarks once daily (50 items, <2 min session) is minimal activity on a real Chrome profile with a real user session. Low risk of detection, same as the existing post/like scripts.

## Implementation Order

1. Update VAULT-claw CLAUDE.md (Part A — link ingest)
2. Add Readwise CLI to Dockerfile + rebuild container
3. Add READWISE_ACCESS_TOKEN to .env and container-runner.ts
4. Create scheduled task for Readwise sync (Part B)
5. Wire up X integration into NanoClaw (if not already done)
6. Create `scripts/bookmarks.ts` + add `x_bookmarks` to host.ts and agent.ts
7. Create scheduled task for X bookmarks sync (Part C)
8. Test: paste a URL to VAULT-claw, verify wiki ingest
9. Test: trigger Readwise sync manually, verify wiki ingest
10. Test: trigger X bookmarks sync manually, verify scraping + wiki ingest

## Files to modify

| File | Change |
|------|--------|
| `groups/telegram_vault-claw/CLAUDE.md` | Replace forwarding with direct ingest |
| `container/Dockerfile` | Add `@readwise/cli` to npm install |
| `.env` | Add `READWISE_ACCESS_TOKEN` |
| `src/container-runner.ts` | Inject `READWISE_ACCESS_TOKEN` into containers |
| `.claude/skills/x-integration/scripts/bookmarks.ts` | **NEW** — Playwright bookmark scraper |
| `.claude/skills/x-integration/host.ts` | Add `x_bookmarks` case |
| `.claude/skills/x-integration/agent.ts` | Add `x_bookmarks` MCP tool definition |
| `src/ipc.ts` | Wire up X IPC handler (if not already done) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Wire up X MCP tools (if not already done) |
| `container/Dockerfile` | COPY x-integration skill (if not already done) |

## Not in scope

- Readwise highlight sync (only Reader documents for now)
- Two-way sync (we don't write back to Readwise or X)
- SimpleMem tool name fix (separate task)
- X API approach (requires $100/month paid tier)
