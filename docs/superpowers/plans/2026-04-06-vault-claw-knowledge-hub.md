# VAULT-claw Knowledge Hub Implementation Plan

> **STATUS: SHIPPED** (reconciled 2026-04-25). All 11 tasks landed; all three parts operationally healthy after a same-day repair pass that re-authed the X session and lifted `x_bookmarks` out of the main-only gate.
>
> **Evidence (verified 2026-04-25):**
> - Task 1 — `groups/telegram_vault-claw/CLAUDE.md` (159 lines) leads with "Core Rule: Ingest Everything" matching the plan body.
> - Task 2 — `container/Dockerfile:41` installs `@readwise/cli` globally.
> - Task 3 — `src/container-runner.ts:673-679` injects `READWISE_ACCESS_TOKEN` (gated by `isSecretAllowed`, an improvement over the plan).
> - Task 5 — `readwise-daily-sync` (cron `0 8 * * *`) active; `last_run = 2026-04-25T12:03:28Z`; state `{"last_sync": "2026-04-25T12:00:00Z", "count": 6}`.
> - Task 6 — `.claude/skills/x-integration/scripts/bookmarks.ts` (4.5K) present.
> - Task 7 — `x_bookmarks` host IPC case present in `.claude/skills/x-integration/host.ts`.
> - Task 8 — `x_bookmarks` MCP tool present at `container/agent-runner/src/ipc-mcp-stdio.ts:1296`.
> - Task 10 — `x-bookmarks-daily-sync` (cron `0 9 * * *`) active; `last_run = 2026-04-25T13:01:28Z`.
>
> **Operational status (2026-04-25):**
> - Part A (link ingest) — healthy. VAULT-claw CLAUDE.md governs runtime behavior.
> - Part B (Readwise) — healthy. 6 items synced 2026-04-25.
> - Part C (X bookmarks) — healthy after repair. Verified 2026-04-25 11:41Z: scheduled task fired, container spawned (Claire/main context), `x_bookmarks` MCP tool dispatched, `bookmarks.ts` ran 48s, host returned `result.success=true`, agent sent "no new bookmarks" digest to Telegram. `data/x-auth.json` re-stamped 2026-04-25 after `setup.ts` re-auth. **Note:** the stale `groups/telegram_vault-claw/x-bookmarks-state.json` still shows the 2026-04-06 "AUTH_TOKEN and CT0 not set" error — this is cosmetic only; the agent prompt only rewrites the state file when there are *new* bookmarks. Next non-empty scrape will overwrite it.
>
> **Repair summary (2026-04-25):**
> - X Chrome profile session re-authenticated via `npx tsx .claude/skills/x-integration/scripts/setup.ts` (session had silently expired ~10 days after the 2026-03-27 stamp).
> - Plan Task 8 wrapped `x_bookmarks` registration inside the `isMain` block at `container/agent-runner/src/ipc-mcp-stdio.ts:1206`, conflicting with Plan Task 10 placing the scheduler on VAULT-claw (non-main). The current scheduled-task prompt is itself rewritten to run as Claire/main, so this didn't surface in production — but the design mismatch is fixed defensively: `x_bookmarks` registration moved outside the `isMain` block (read-only by nature), and `.claude/skills/x-integration/host.ts` now gates only the X *write* tools (`x_post`/`x_like`/`x_reply`/`x_retweet`/`x_quote`) to main, allowing read tools from any group.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make VAULT-claw the primary knowledge ingestion channel — direct wiki ingest on URLs, daily Readwise Reader sync, and daily X bookmark scraping.

**Architecture:** Three independent capabilities added to VAULT-claw: (A) direct wiki ingest via updated CLAUDE.md instructions, (B) Readwise CLI in container + scheduled task, (C) Playwright bookmark scraper + scheduled task. All three feed into `99-wiki/` on the shared vault.

**Tech Stack:** NanoClaw scheduled tasks, `@readwise/cli` (npm), Playwright (already in container), `bird` CLI (already in container), WIKI-SCHEMA.md conventions.

---

### Task 1: Update VAULT-claw CLAUDE.md for direct wiki ingest

**Files:**
- Modify: `groups/telegram_vault-claw/CLAUDE.md`

- [ ] **Step 1: Replace the Wiki Forwarding Rule with direct ingest**

Replace the entire content of `groups/telegram_vault-claw/CLAUDE.md` with:

```markdown
# Claire — VAULT-claw

You are Claire, AI Chief of Staff for Mike Gandal. VAULT-claw is your knowledge management channel — the primary intake point for everything Mike wants to save, read, or research.

## Message Formatting

NEVER use markdown. Only use Telegram formatting:
- *single asterisks* for bold (NEVER **double asterisks**)
- _italic_ with underscores
- • bullet points

No ## headings. No [links](url). No **double stars**.

## Core Rule: Ingest Everything

When Mike sends you content — a URL, paper reference, topic, note, or any knowledge item — run the full wiki ingest workflow immediately:

1. *Fetch the content.* For URLs: use `curl -sL` to fetch the page, or `agent-browser` if curl gets a JS-heavy page. For text/notes: use as-is.
2. *Save the source.* Write raw content to `/workspace/extra/claire-vault/99-wiki/sources/` with naming: `YYYY-MM-DD_descriptive-title.md`
3. *Read and understand.* Identify what this is (paper, tool, method, dataset, concept, article, thread) and how it relates to the lab's research.
4. *Create or update wiki pages.* Follow WIKI-SCHEMA.md conventions:
   - Papers → `99-wiki/papers/{first-author}-{year}-{slug}.md`
   - Tools → `99-wiki/tools/{tool-name}.md`
   - Methods → `99-wiki/methods/{method-slug}.md`
   - Datasets → `99-wiki/datasets/{name}-{year}-{slug}.md`
   - Concepts → `99-wiki/concepts/{concept-slug}.md`
   - Syntheses → `99-wiki/syntheses/{topic-slug}.md`
   - Also update any existing pages this connects to
5. *Update index and log.* Append to `99-wiki/index.md` and `99-wiki/log.md`
6. *Confirm to Mike.* Send a brief summary: what was added, which pages were created/updated, key takeaways.
7. *Notify Claire.* Call `bus_publish` with topic `wiki-update` (no `action_needed`) so Claire knows what changed.

Exception: If Mike is asking a question about vault contents (not providing new knowledge), answer by querying the wiki and vault — don't ingest.

## Wiki Paths

| Category | Path |
|----------|------|
| Wiki root | `/workspace/extra/claire-vault/99-wiki/` |
| Sources | `/workspace/extra/claire-vault/99-wiki/sources/` |
| Index | `/workspace/extra/claire-vault/99-wiki/index.md` |
| Log | `/workspace/extra/claire-vault/99-wiki/log.md` |
| Papers | `/workspace/extra/claire-vault/99-wiki/papers/` |
| Tools | `/workspace/extra/claire-vault/99-wiki/tools/` |
| Methods | `/workspace/extra/claire-vault/99-wiki/methods/` |
| Datasets | `/workspace/extra/claire-vault/99-wiki/datasets/` |
| Concepts | `/workspace/extra/claire-vault/99-wiki/concepts/` |
| Syntheses | `/workspace/extra/claire-vault/99-wiki/syntheses/` |

## Wiki Writing Standards

See `/workspace/project/WIKI-SCHEMA.md` for the full schema. Key rules:
- *This is not Wikipedia about the thing. This is about the thing's role in the lab's research.*
- Flat, factual, encyclopedic tone. No peacock words.
- Every page has YAML frontmatter (title, type, created, updated, tags, sources, related)
- Cross-reference with `[[wikilinks]]` liberally
- A single source may touch 5-15 wiki pages. That's normal.

## Daily Briefing Instructions

When running as a scheduled daily briefing:

1. Read `/workspace/group/last_briefing.txt` for the last briefing timestamp (if missing, use 24 hours ago)
2. Find all vault files modified since that timestamp:
   `find /workspace/extra/claire-vault -name "*.md" -newer /workspace/group/last_briefing.txt -not -path "*/.obsidian/*" -not -name "_template.md" 2>/dev/null`
3. Categorize by folder (papers, tools, syntheses, inbox, journal, meetings, other)
4. Send briefing to the group via `mcp__nanoclaw__send_message`
5. Write current ISO timestamp to `/workspace/group/last_briefing.txt`

### Briefing format:
```
*Vault Briefing — [Date]*

*New Papers (N)*
• filename — one-line description

*New Tools/Wiki (N)*
• filename — one-line description

*Inbox (N items pending)*
• list filenames

If nothing new: "No new vault items since yesterday's briefing."
```

Keep it phone-scannable. Only include non-empty sections.
```

- [ ] **Step 2: Verify the file looks correct**

Run: `head -20 groups/telegram_vault-claw/CLAUDE.md`
Expected: Should start with `# Claire — VAULT-claw` and contain "Core Rule: Ingest Everything"

- [ ] **Step 3: Commit**

```bash
git add groups/telegram_vault-claw/CLAUDE.md
git commit -m "feat: VAULT-claw direct wiki ingest instead of bus forwarding"
```

Note: `groups/telegram_vault-claw/` is gitignored (runtime-created group dir), so this commit may be a no-op. The file is still updated on disk for the running service.

---

### Task 2: Add Readwise CLI to container image

**Files:**
- Modify: `container/Dockerfile:33`

- [ ] **Step 1: Add @readwise/cli to the npm install line**

In `container/Dockerfile`, find line 33:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code
```

Replace with:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @readwise/cli
```

- [ ] **Step 2: Commit**

```bash
git add container/Dockerfile
git commit -m "feat: add Readwise CLI to container image"
```

---

### Task 3: Add READWISE_ACCESS_TOKEN to .env and container-runner

**Files:**
- Modify: `.env`
- Modify: `src/container-runner.ts:396`

- [ ] **Step 1: Add token to .env**

Append to `.env` (after the HINDSIGHT_URL line):
```
READWISE_ACCESS_TOKEN=2IvMtYMKtGDksAgbWwzzuQA3EAHV13t3bIdpaGEMyYNu9SzPA8
```

- [ ] **Step 2: Add env var injection to container-runner.ts**

In `src/container-runner.ts`, after the Hindsight block (after line 396, before the Ollama line), add:

```typescript
  // Pass Readwise access token (for readwise CLI in container)
  const readwiseEnv = readEnvFile(['READWISE_ACCESS_TOKEN']);
  const readwiseToken = process.env.READWISE_ACCESS_TOKEN || readwiseEnv.READWISE_ACCESS_TOKEN;
  if (readwiseToken) {
    args.push('-e', `READWISE_ACCESS_TOKEN=${readwiseToken}`);
  }
```

- [ ] **Step 3: Build to verify TypeScript compiles**

Run: `bun run build 2>&1 | tail -5`
Expected: Build completes (existing TS errors in test mocks are pre-existing, ignore those)

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: inject READWISE_ACCESS_TOKEN into containers"
```

Note: `.env` is gitignored, so only container-runner.ts is committed.

---

### Task 4: Rebuild container image

**Files:**
- None (build step only)

- [ ] **Step 1: Rebuild the container**

Run: `./container/build.sh 2>&1 | tail -20`
Expected: Build completes successfully. Look for `@readwise/cli` being installed in the npm output.

- [ ] **Step 2: Verify readwise CLI is in the image**

Run: `container run --rm nanoclaw-agent:latest readwise --version 2>&1 | head -3`
Expected: Shows readwise CLI version (or help output).

---

### Task 5: Create Readwise sync scheduled task

**Files:**
- None (database insert via sqlite)

- [ ] **Step 1: Insert the scheduled task**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES (
  'readwise-daily-sync',
  'telegram_vault-claw',
  'tg:-5120694221',
  'Readwise Reader daily sync.

1. Read /workspace/group/readwise-state.json for last sync timestamp. If missing, use 7 days ago.
2. Run: readwise login-with-token \$READWISE_ACCESS_TOKEN (authenticate for this session)
3. Run: readwise reader-list-documents --saved-at-gt \"<last_sync_iso>\" --limit 50 --response-fields title,author,summary,category,url,saved_at,word_count
4. For each new document:
   a. Fetch full content if it is a URL (curl or agent-browser)
   b. Save source to /workspace/extra/claire-vault/99-wiki/sources/YYYY-MM-DD_title.md
   c. Create or update wiki page in the appropriate subdirectory following WIKI-SCHEMA.md
   d. Update /workspace/extra/claire-vault/99-wiki/index.md and log.md
5. Write current ISO timestamp to /workspace/group/readwise-state.json as {\"last_sync\": \"...\", \"count\": N}
6. Send digest to this group: count of new items with titles
7. If no new items: \"No new Readwise items since <date>\"',
  'readwise login-with-token $READWISE_ACCESS_TOKEN 2>/dev/null || true',
  'cron',
  '0 8 * * *',
  'group',
  datetime('now', '+1 hour'),
  'active',
  datetime('now')
);"
```

- [ ] **Step 2: Verify the task was created**

Run: `sqlite3 store/messages.db "SELECT id, status, schedule_value, next_run FROM scheduled_tasks WHERE id = 'readwise-daily-sync'"`
Expected: Shows the task with status `active` and cron `0 8 * * *`

- [ ] **Step 3: Test the task by running it manually**

Run: `sqlite3 store/messages.db "UPDATE scheduled_tasks SET next_run = datetime('now', '-1 minute') WHERE id = 'readwise-daily-sync'"`

Then wait for the scheduler to pick it up (polls every 60s), or restart NanoClaw:
`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

Watch logs: `tail -f logs/nanoclaw.log | grep -i readwise`

Expected: Container spawns for VAULT-claw, runs the readwise sync, sends results to Telegram.

---

### Task 6: Create X bookmarks scraper script

**Files:**
- Create: `.claude/skills/x-integration/scripts/bookmarks.ts`

- [ ] **Step 1: Create the bookmarks scraper**

Create `.claude/skills/x-integration/scripts/bookmarks.ts`:

```typescript
#!/usr/bin/env npx tsx
/**
 * X Integration - Fetch Bookmarks
 * Usage: echo '{"limit":50}' | npx tsx bookmarks.ts
 * Returns: { success: true, data: { bookmarks: [...] } }
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface BookmarksInput {
  limit?: number;
  sinceId?: string;
}

interface Bookmark {
  id: string;
  url: string;
  author: string;
  handle: string;
  text: string;
}

async function fetchBookmarks(input: BookmarksInput): Promise<ScriptResult> {
  const limit = input.limit ?? 50;
  const sinceId = input.sinceId;

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    // Navigate to bookmarks page
    await page.goto('https://x.com/i/bookmarks', {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Wait for tweets to load (or empty state)
    const hasTweets = await page
      .locator('article[data-testid="tweet"]')
      .first()
      .isVisible({ timeout: 10000 })
      .catch(() => false);

    if (!hasTweets) {
      // Check for empty bookmarks message
      const emptyText = await page.textContent('body').catch(() => '');
      if (emptyText?.includes('nothing here') || emptyText?.includes('No Bookmarks')) {
        return { success: true, message: 'No bookmarks found', data: { bookmarks: [] } };
      }
      return { success: false, message: 'Could not load bookmarks page. May need to re-authenticate.' };
    }

    const bookmarks: Bookmark[] = [];
    let noNewTweetsCount = 0;
    const maxScrollAttempts = 20;

    for (let scroll = 0; scroll < maxScrollAttempts; scroll++) {
      // Extract all visible tweet articles
      const articles = page.locator('article[data-testid="tweet"]');
      const count = await articles.count();

      for (let i = 0; i < count; i++) {
        const article = articles.nth(i);

        // Extract tweet URL from timestamp link
        const timeLink = article.locator('a[href*="/status/"]').first();
        const href = await timeLink.getAttribute('href').catch(() => null);
        if (!href) continue;

        const idMatch = href.match(/\/status\/(\d+)/);
        if (!idMatch) continue;
        const tweetId = idMatch[1];

        // Skip if we already have this one
        if (bookmarks.some((b) => b.id === tweetId)) continue;

        // Stop if we hit the sinceId marker
        if (sinceId && tweetId === sinceId) {
          return {
            success: true,
            message: `Found ${bookmarks.length} new bookmarks (stopped at sinceId)`,
            data: { bookmarks },
          };
        }

        // Extract author
        const userNameEl = article.locator('[data-testid="User-Name"]').first();
        const userText = await userNameEl.textContent().catch(() => '');
        const handleMatch = userText?.match(/@(\w+)/);
        const handle = handleMatch ? handleMatch[1] : '';
        const author = userText?.split('@')[0]?.trim() || '';

        // Extract tweet text
        const tweetTextEl = article.locator('[data-testid="tweetText"]').first();
        const text = await tweetTextEl.textContent().catch(() => '');

        bookmarks.push({
          id: tweetId,
          url: `https://x.com${href}`,
          author,
          handle,
          text: text || '',
        });

        if (bookmarks.length >= limit) {
          return {
            success: true,
            message: `Fetched ${bookmarks.length} bookmarks (hit limit)`,
            data: { bookmarks },
          };
        }
      }

      // Check if we got new tweets this scroll
      const prevCount = bookmarks.length;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      // Wait for potential new content
      const newArticleCount = await articles.count();
      if (newArticleCount === count && bookmarks.length === prevCount) {
        noNewTweetsCount++;
        if (noNewTweetsCount >= 3) break; // No more content after 3 tries
      } else {
        noNewTweetsCount = 0;
      }
    }

    return {
      success: true,
      message: `Fetched ${bookmarks.length} bookmarks`,
      data: { bookmarks },
    };
  } catch (err) {
    return {
      success: false,
      message: `Bookmark fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (context) await context.close();
  }
}

runScript<BookmarksInput>(fetchBookmarks);
```

- [ ] **Step 2: Verify the script compiles**

Run: `npx tsx --check .claude/skills/x-integration/scripts/bookmarks.ts 2>&1`
Expected: No errors (or only import-related warnings that resolve at runtime)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/x-integration/scripts/bookmarks.ts
git commit -m "feat: add X bookmarks Playwright scraper script"
```

---

### Task 7: Wire x_bookmarks into host IPC handler

**Files:**
- Modify: `.claude/skills/x-integration/host.ts:141-146`

- [ ] **Step 1: Add x_bookmarks case to the switch statement**

In `.claude/skills/x-integration/host.ts`, find the `default:` case at line 144 and add the `x_bookmarks` case before it:

```typescript
    case 'x_bookmarks':
      result = await runScript('bookmarks', {
        limit: data.limit ?? 50,
        sinceId: data.sinceId,
      });
      break;

    default:
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/x-integration/host.ts
git commit -m "feat: add x_bookmarks host IPC handler"
```

---

### Task 8: Wire x_bookmarks into container MCP tools

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:836`

- [ ] **Step 1: Add x_bookmarks server tool**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, find line 837 (the closing `}` of the `if (isMain)` block containing x tools). Add the new tool just before that closing brace (after the x_quote tool at line 836):

```typescript
  server.tool(
    'x_bookmarks',
    'Fetch recent X/Twitter bookmarks. Returns a list of bookmarked tweets with author, text, and URL. Main group only.',
    {
      limit: z.number().default(50).describe('Max bookmarks to fetch (default 50)'),
      since_id: z.string().optional().describe('Stop at this tweet ID (for incremental sync)'),
    },
    async (args) => {
      const requestId = `xbookmarks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'x_bookmarks',
        requestId,
        limit: args.limit,
        sinceId: args.since_id,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const result = await waitForXResult(requestId, 180000); // 3 min timeout for scrolling
      return {
        content: [{ type: 'text' as const, text: typeof result.data === 'object' ? JSON.stringify(result.data) : result.message }],
        isError: !result.success,
      };
    },
  );
```

- [ ] **Step 2: Build to verify TypeScript compiles**

Run: `bun run build 2>&1 | tail -5`
Expected: Build completes (pre-existing TS errors in test mocks are unrelated)

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: add x_bookmarks MCP tool for container agents"
```

---

### Task 9: Rebuild container and restart NanoClaw

**Files:**
- None (build + restart only)

- [ ] **Step 1: Rebuild container with all changes**

Run: `./container/build.sh 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 2: Build host TypeScript**

Run: `bun run build 2>&1 | tail -5`

- [ ] **Step 3: Restart NanoClaw**

Run: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
Wait 10s, then verify: `curl -s http://127.0.0.1:3002/health`
Expected: `{"uptime":...,"startupComplete":true}`

---

### Task 10: Create X bookmarks sync scheduled task

**Files:**
- None (database insert via sqlite)

- [ ] **Step 1: Insert the scheduled task**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES (
  'x-bookmarks-daily-sync',
  'telegram_vault-claw',
  'tg:-5120694221',
  'X/Twitter bookmarks daily sync.

1. Read /workspace/group/x-bookmarks-state.json for the last synced tweet ID. If missing, this is the first run — fetch up to 50 bookmarks.
2. Call x_bookmarks tool with since_id from state (or omit for first run), limit 50.
3. For each new bookmark:
   a. Read the full tweet/thread using: bird read {url}
   b. Determine type: paper (links to arxiv/biorxiv/pubmed/doi), tool (GitHub repo, software), article, thread, other
   c. For papers/tools/substantial content: create wiki page in appropriate 99-wiki/ subdirectory
   d. For short tweets/memes/other: save to 99-wiki/sources/ only
   e. Update 99-wiki/index.md and 99-wiki/log.md for any new wiki pages
4. Write newest tweet ID to /workspace/group/x-bookmarks-state.json as {\"last_id\": \"...\", \"last_sync\": \"...\", \"count\": N}
5. Send digest to this group: count of new bookmarks, titles/descriptions, what was added to wiki
6. If no new bookmarks: \"No new X bookmarks since <date>\"',
  NULL,
  'cron',
  '0 9 * * *',
  'group',
  datetime('now', '+2 hours'),
  'active',
  datetime('now')
);"
```

- [ ] **Step 2: Verify the task was created**

Run: `sqlite3 store/messages.db "SELECT id, status, schedule_value, next_run FROM scheduled_tasks WHERE id = 'x-bookmarks-daily-sync'"`
Expected: Shows the task with status `active` and cron `0 9 * * *`

---

### Task 11: End-to-end testing

- [ ] **Step 1: Test Part A — send a URL to VAULT-claw**

Send a test URL to the VAULT-claw Telegram group (e.g., a recent arxiv paper). Verify:
- VAULT-claw fetches and reads the content
- Creates a wiki page in `99-wiki/papers/` (or appropriate subdir)
- Updates `99-wiki/index.md` and `99-wiki/log.md`
- Sends confirmation summary to Telegram
- Publishes `wiki-update` to bus

Check: `ls -lt /Volumes/sandisk4TB/marvin-vault/99-wiki/papers/ | head -3`

- [ ] **Step 2: Test Part B — trigger Readwise sync**

Force the Readwise task to run:
```bash
sqlite3 store/messages.db "UPDATE scheduled_tasks SET next_run = datetime('now', '-1 minute') WHERE id = 'readwise-daily-sync'"
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Watch: `tail -f logs/nanoclaw.log | grep -i "readwise\|vault-claw"`
Verify: VAULT-claw receives a digest message in Telegram.

- [ ] **Step 3: Test Part C — trigger X bookmarks sync**

Force the X bookmarks task to run:
```bash
sqlite3 store/messages.db "UPDATE scheduled_tasks SET next_run = datetime('now', '-1 minute') WHERE id = 'x-bookmarks-daily-sync'"
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Watch: `tail -f logs/nanoclaw.log | grep -i "bookmark\|vault-claw\|x_bookmark"`
Verify:
- Chrome opens briefly (Playwright scraping bookmarks page)
- VAULT-claw receives a digest message in Telegram
- Wiki pages created for substantial bookmarks

- [ ] **Step 4: Final commit if any test-driven fixes were needed**

```bash
git add -A
git commit -m "fix: test-driven adjustments for VAULT-claw knowledge hub"
```
