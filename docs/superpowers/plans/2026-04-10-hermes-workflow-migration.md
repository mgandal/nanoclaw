# Hermes → NanoClaw Workflow Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfer 5 non-redundant Hermes recurring workflows to NanoClaw, sync state files, and add a paperpile-sync launchd job — making NanoClaw self-sufficient for all daily operations.

**Architecture:** Each workflow becomes a NanoClaw scheduled task running in sandboxed containers. Three workflows (Slack scanner, AI brief, blogwatcher) require infrastructure additions: Slack MCP supergateway, follow-builders container skill, blogwatcher-cli in Dockerfile + persistent volume. One workflow (paperpile) runs host-side via launchd. State files sync one-way from Hermes to NanoClaw.

**Tech Stack:** TypeScript (NanoClaw host), Node.js (container agent-runner), supergateway (stdio→HTTP bridge), launchd (paperpile cron), SQLite (task scheduler + blogwatcher state)

**Spec:** `docs/superpowers/specs/2026-04-10-hermes-workflow-migration-design.md`

---

## File Map

### Files to Create

| File | Purpose |
|------|---------|
| `container/skills/follow-builders/SKILL.md` | Agent-facing skill doc for AI builders digest |
| `container/skills/follow-builders/prepare-digest.js` | Digest preprocessing script (ported from Hermes) |
| `container/skills/follow-builders/feed-x.json` | X/Twitter builders source list |
| `container/skills/follow-builders/feed-podcasts.json` | Podcast feed list |
| `scripts/sync/paperpile_sync.py` | Paperpile bibliography sync (copy from Hermes) |
| `launchd/com.nanoclaw.paperpile-sync.plist` | Launchd job for daily paperpile sync |
| `launchd/com.slack-mcp.plist` | Launchd job for Slack MCP supergateway |

### Files to Modify

| File | Changes |
|------|---------|
| `container/agent-runner/src/index.ts:193-273` | Add Slack MCP server to `buildMcpServers()` |
| `container/agent-runner/src/index.ts:581-610` | Add `mcp__slack__*` to `allowedTools` |
| `src/container-runner.ts:54-64` | Add `SLACK_MCP_XOXP_TOKEN|SUPADATA_API_KEY` to redact regex |
| `src/container-runner.ts:391-435` | Add `SLACK_MCP_URL` and `SUPADATA_API_KEY` env var injection |
| `container/Dockerfile:33` | Install `blogwatcher` npm package |
| `src/container-runner.ts:91-284` | Add blogwatcher persistent volume mount for VAULT-claw |
| `groups/global/state/` | Sync state files from Hermes |

---

## Task 1: State File Sync

**Files:**
- Copy to: `groups/global/state/decisions.md`
- Copy to: `groups/global/state/data-access-requests.md`
- Copy to: `groups/global/state/cv-current.md`
- Copy to: `groups/global/state/lessons.md`
- Update: `groups/global/state/context.md`
- Update: `groups/global/state/grants.md`
- Update: `groups/global/state/memory.md`
- Inspect: `groups/global/state/goals.md`

- [ ] **Step 1: Copy missing files from Hermes**

```bash
cp ~/Agents/hermes-working/state/decisions.md groups/global/state/decisions.md
cp ~/Agents/hermes-working/state/data-access-requests.md groups/global/state/data-access-requests.md
cp ~/Agents/hermes-working/state/cv-current.md groups/global/state/cv-current.md
cp ~/Agents/hermes-working/tasks/lessons.md groups/global/state/lessons.md
```

- [ ] **Step 2: Update stale files (Hermes is newer)**

```bash
cp ~/Agents/hermes-working/state/context.md groups/global/state/context.md
cp ~/Agents/hermes-working/state/grants.md groups/global/state/grants.md
cp ~/Agents/hermes-working/state/memory.md groups/global/state/memory.md
```

- [ ] **Step 3: Inspect goals.md before deciding**

NanoClaw's `goals.md` is 2.4KB (Mar 26) while Hermes' is 1.1KB (Apr 6). NanoClaw's is larger despite being older. Read both, determine which has more complete content, and keep the more complete version:

```bash
diff ~/Agents/hermes-working/state/goals.md groups/global/state/goals.md
```

If NanoClaw's is more complete, keep it. If Hermes has content NanoClaw lacks, merge manually.

- [ ] **Step 4: Verify all state files**

```bash
ls -la groups/global/state/
```

Expected: `context.md`, `current.md`, `cv-current.md`, `data-access-requests.md`, `decisions.md`, `goals.md`, `grants.md`, `integrations.md`, `knowledge-graph.md`, `lab-roster.md`, `lab-todos.md`, `lessons.md`, `memory.md`, `papers.md`, `projects.md`, `todo.md`, `USER.md`, `watchlist.md`

- [ ] **Step 5: Commit**

```bash
git add groups/global/state/
git commit -m "chore: sync state files from Hermes — add decisions, data-access-requests, cv, lessons; update context, grants, memory"
```

---

## Task 2: Weekly Week-Ahead Scheduled Task

No infrastructure changes needed — all MCP tools (Calendar, Todoist, Gmail) are already available in containers.

**Files:**
- Modify: `store/messages.db` (via sqlite3 INSERT)

- [ ] **Step 1: Create the scheduled task**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES (
  'hermes-week-ahead',
  'telegram_claire',
  'tg:8475020901',
  'You are Claire, Mike Gandal''s AI Chief of Staff. Generate a structured week-ahead preview for next week (Mon-Fri).

Steps:
1. Read next week''s calendar (Mon-Fri) via Calendar MCP (calendar_range tool). Include ALL calendars.
2. Check Todoist for overdue and upcoming tasks via Todoist MCP.
3. Scan recent Gmail for unresolved threads that need Mike''s reply.
4. Read /workspace/global/state/current.md for active priorities and escalations.
5. Read /workspace/global/state/grants.md for upcoming grant deadlines.

Include family calendar events (Eli, Sophie) for conflict detection. Flag events before 9:30 AM or after 6 PM.

Output format — structured Telegram message:
## Week of [DATE]
### Monday
- [time] [event] [prep needed?]
### Tuesday
...
### Conflicts & Prep Needed
- [list]
### Approaching Deadlines
- [list]
### Stale Follow-ups (3+ days no response)
- [list]',
  'cron',
  '0 10 * * 6',
  'isolated',
  datetime('now'),
  'active',
  datetime('now')
);"
```

- [ ] **Step 2: Verify task was created**

```bash
sqlite3 store/messages.db "SELECT id, group_folder, schedule_value, status FROM scheduled_tasks WHERE id='hermes-week-ahead';"
```

Expected: `hermes-week-ahead|telegram_claire|0 10 * * 6|active`

- [ ] **Step 3: Restart NanoClaw to pick up the new task**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 4: Verify in logs**

```bash
tail -20 logs/nanoclaw.log | grep -i "scheduled\|task"
```

---

## Task 3: Slack MCP Supergateway Setup

Set up `slack-mcp-server` as an HTTP MCP server (via supergateway) so containers can access Slack tools.

**Files:**
- Create: `launchd/com.slack-mcp.plist`
- Modify: `container/agent-runner/src/index.ts:256-262` (add Slack MCP server block)
- Modify: `container/agent-runner/src/index.ts:609` (add `mcp__slack__*` to allowedTools)
- Modify: `src/container-runner.ts:391-435` (add SLACK_MCP_URL env var injection)

- [ ] **Step 1: Create launchd plist for Slack MCP supergateway**

Create `launchd/com.slack-mcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.slack-mcp</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/npx</string>
        <string>-y</string>
        <string>supergateway@latest</string>
        <string>--stdio</string>
        <string>npx -y slack-mcp-server@latest --transport stdio</string>
        <string>--port</string>
        <string>8189</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/mgandal</string>
        <key>SLACK_MCP_XOXP_TOKEN</key>
        <string>PLACEHOLDER_REPLACE_WITH_REAL_TOKEN</string>
        <key>SLACK_MCP_ADD_MESSAGE_TOOL</key>
        <string>C0ABVNZLA0L</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/mgandal/.cache/slack-mcp/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/mgandal/.cache/slack-mcp/stderr.log</string>
</dict>
</plist>
```

**IMPORTANT:** Read the actual `SLACK_MCP_XOXP_TOKEN` value from `~/.claude.json` (the `mcpServers.slack.env.SLACK_MCP_XOXP_TOKEN` field) and substitute it into the plist. Do NOT commit the token to git.

- [ ] **Step 2: Create cache directory and install the plist**

```bash
mkdir -p ~/.cache/slack-mcp
cp launchd/com.slack-mcp.plist ~/Library/LaunchAgents/com.slack-mcp.plist
```

Then edit `~/Library/LaunchAgents/com.slack-mcp.plist` to replace the PLACEHOLDER with the real token from `~/.claude.json`.

- [ ] **Step 3: Start the Slack MCP service**

```bash
launchctl load ~/Library/LaunchAgents/com.slack-mcp.plist
```

- [ ] **Step 4: Verify Slack MCP is listening**

```bash
sleep 3 && lsof -i :8189 | head -5
```

Expected: node process listening on port 8189.

- [ ] **Step 5: Add TCP proxy for container access**

The supergateway listens on localhost. Containers need to reach it via `host.containers.internal`. Add a socat/TCP proxy binding to 0.0.0.0 (same pattern as other MCP servers), or adjust the supergateway to bind to 0.0.0.0 directly by adding `--host 0.0.0.0` to the supergateway args in the plist.

Alternatively, if supergateway supports `--host`, update the plist args to include `--host` `0.0.0.0`. Then no TCP proxy is needed.

- [ ] **Step 6: Add SLACK_MCP_URL to .env**

```bash
echo 'SLACK_MCP_URL=http://localhost:8189/mcp' >> .env
```

- [ ] **Step 7: Add Slack MCP to container agent-runner**

In `container/agent-runner/src/index.ts`, add after the `calendar` block (line 262):

```typescript
  if (process.env.SLACK_MCP_URL) {
    servers.slack = {
      type: 'http',
      url: process.env.SLACK_MCP_URL,
      headers: { Accept: 'application/json, text/event-stream' },
    };
  }
```

- [ ] **Step 8: Add `mcp__slack__*` to allowedTools**

In `container/agent-runner/src/index.ts`, add after `'mcp__calendar__*',` (line 609):

```typescript
        'mcp__slack__*',
```

- [ ] **Step 9: Add SLACK_MCP_URL env var injection to container-runner**

In `src/container-runner.ts`, add after the Calendar URL block (after line 408):

```typescript
  // Pass Slack MCP endpoint URL (only if configured in .env)
  const slackMcpEnv = readEnvFile(['SLACK_MCP_URL']);
  const slackMcpUrl = process.env.SLACK_MCP_URL || slackMcpEnv.SLACK_MCP_URL;
  if (slackMcpUrl) {
    try {
      const parsed = new URL(slackMcpUrl);
      const hostname =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `SLACK_MCP_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn({ slackMcpUrl }, 'Invalid SLACK_MCP_URL, skipping Slack MCP');
    }
  }
```

- [ ] **Step 10: Build and verify**

```bash
bun run build 2>&1 | grep -v '\.test\.ts'
```

Expected: no non-test errors.

- [ ] **Step 11: Clear agent-runner cache and restart**

```bash
rm -rf data/sessions/*/agent-runner-src
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 12: Commit**

```bash
git add container/agent-runner/src/index.ts src/container-runner.ts launchd/com.slack-mcp.plist
git commit -m "feat: add Slack MCP to container agents via supergateway on port 8189"
```

---

## Task 4: Slack Context Scanner Scheduled Task

Depends on: Task 3 (Slack MCP must be running)

**Files:**
- Modify: `store/messages.db` (via sqlite3 INSERT)

- [ ] **Step 1: Create the scheduled task**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES (
  'hermes-slack-scanner',
  'telegram_lab-claw',
  'tg:-1003892106437',
  'You are Claire, running the LAB-claw daily Slack context scan for Mike Gandal''s lab.

Scan these Slack channels for the last 24 hours using Slack MCP tools (mcp__slack__conversations_history, mcp__slack__conversations_search_messages):
- #papers
- #bioinformatics
- #group-meetings
- #general
- Any project-specific channels you can find

For each channel, look for:
- DEADLINES: Dates, due dates, submission deadlines
- DECISIONS: Team decisions, approvals, go/no-go calls
- ACTION ITEMS: Tasks assigned to Mike or requiring his input
- MEETING CHANGES: Rescheduled, cancelled, or new meetings
- RESEARCH UPDATES: Paper submissions, data availability, results

Classify each finding as HIGH (requires Mike''s action within 24h) or MEDIUM (awareness item).

After scanning, store any HIGH priority findings in Hindsight via mcp__hindsight__retain for future reference.

Output format:
If findings exist, send a structured summary to this Telegram group.
If nothing notable in any channel, send: \"Slack scan complete — all clear.\"',
  'cron',
  '0 6 * * 1-5',
  'isolated',
  datetime('now'),
  'active',
  datetime('now')
);"
```

- [ ] **Step 2: Verify task was created**

```bash
sqlite3 store/messages.db "SELECT id, group_folder, schedule_value, status FROM scheduled_tasks WHERE id='hermes-slack-scanner';"
```

Expected: `hermes-slack-scanner|telegram_lab-claw|0 6 * * 1-5|active`

- [ ] **Step 3: Restart NanoClaw**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Task 5: Follow-Builders Container Skill + AI Morning Brief

Port the follow-builders preprocessing from Hermes into a NanoClaw container skill, then create the scheduled task.

**Files:**
- Create: `container/skills/follow-builders/SKILL.md`
- Create: `container/skills/follow-builders/prepare-digest.js`
- Create: `container/skills/follow-builders/feed-x.json`
- Create: `container/skills/follow-builders/feed-podcasts.json`
- Modify: `src/container-runner.ts:429-435` (add SUPADATA_API_KEY env var)
- Modify: `src/container-runner.ts:54-64` (add SUPADATA_API_KEY to redact regex)
- Modify: `store/messages.db` (new scheduled task)

- [ ] **Step 1: Copy follow-builders source files from Hermes**

```bash
mkdir -p container/skills/follow-builders
cp ~/.hermes/skills/follow-builders/scripts/prepare-digest.js container/skills/follow-builders/prepare-digest.js
cp ~/.hermes/skills/follow-builders/feed-x.json container/skills/follow-builders/feed-x.json
cp ~/.hermes/skills/follow-builders/feed-podcasts.json container/skills/follow-builders/feed-podcasts.json
```

- [ ] **Step 2: Create SKILL.md for container agents**

Create `container/skills/follow-builders/SKILL.md`:

```markdown
---
name: follow-builders
description: Generate AI industry digest by tracking top builders on X/Twitter and podcast feeds. Use for the daily AI morning brief.
allowed-tools: Bash(node:*), WebSearch, WebFetch, Read
---

# Follow Builders — AI Industry Digest

## How It Works

1. Run `prepare-digest.js` to fetch and preprocess builder activity
2. The script outputs a JSON digest to stdout
3. You remix the JSON into a curated 3-5 item summary for Mike

## Running the Digest

```bash
cd /home/node/.claude/skills/follow-builders
node prepare-digest.js
```

The script:
- Fetches latest tweets from tracked AI builders (feed-x.json)
- Fetches latest podcast episodes (feed-podcasts.json)
- Downloads prompt templates from the follow-builders repo
- Outputs structured JSON ready for remix

## Remixing

After running the script, take the JSON output and create a digest:
- Pick the 3-5 most relevant items for Mike (psychiatric genomics PI who builds with AI)
- Focus: Claude/Anthropic, OpenAI, open-source LLMs, AI for science, bioinformatics tools
- One-sentence summary per item with source link
- Skip generic tech news — only items relevant to research or AI tooling

## Environment

- `SUPADATA_API_KEY` — required for fetching podcast transcripts (set in container env)
- Node.js available in container (v22)

## Output Format

```
🤖 AI Builders Digest — [DATE]

1. **[Title]** — [1-sentence summary] [Link]
2. **[Title]** — [1-sentence summary] [Link]
3. **[Title]** — [1-sentence summary] [Link]
```
```

- [ ] **Step 3: Add SUPADATA_API_KEY to container-runner**

In `src/container-runner.ts`, add after the GitHub credentials block (after line 446):

```typescript
  // Pass Supadata API key (for follow-builders podcast transcripts)
  const supadataEnv = readEnvFile(['SUPADATA_API_KEY']);
  const supadataKey =
    process.env.SUPADATA_API_KEY || supadataEnv.SUPADATA_API_KEY;
  if (supadataKey) {
    args.push('-e', `SUPADATA_API_KEY=${supadataKey}`);
  }
```

- [ ] **Step 4: Add SUPADATA_API_KEY to log redaction**

In `src/container-runner.ts`, update the `sensitiveKeys` regex (line 56):

```typescript
  const sensitiveKeys =
    /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|CREDENTIAL_PROXY_TOKEN|GITHUB_TOKEN|SUPADATA_API_KEY)=/i;
```

- [ ] **Step 5: Add SUPADATA_API_KEY to .env**

Read the Supadata API key from Hermes' environment:

```bash
grep SUPADATA ~/.hermes/.env 2>/dev/null
```

If found, add to NanoClaw's `.env`:

```bash
echo 'SUPADATA_API_KEY=<value>' >> .env
```

- [ ] **Step 6: Build and verify**

```bash
bun run build 2>&1 | grep -v '\.test\.ts'
```

Expected: no non-test errors.

- [ ] **Step 7: Commit skill + infrastructure**

```bash
git add container/skills/follow-builders/ src/container-runner.ts
git commit -m "feat: add follow-builders container skill and SUPADATA_API_KEY injection"
```

- [ ] **Step 8: Create the AI morning brief scheduled task**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES (
  'hermes-ai-brief',
  'telegram_code-claw',
  'tg:-5120694221',
  'You are Claire, running the CODE-claw daily AI builders digest for Mike Gandal.

Mike is a psychiatric genomics PI who builds with AI tools daily.

Steps:
1. Run the follow-builders skill: read /home/node/.claude/skills/follow-builders/SKILL.md for instructions
2. Execute prepare-digest.js to fetch and preprocess builder activity
3. Remix the output into a curated 3-5 item digest
4. Focus on: Claude/Anthropic, OpenAI, open-source LLMs, AI for science, bioinformatics tools
5. Skip generic tech news — only items relevant to research or AI tooling

If prepare-digest.js fails or produces no output, fall back to web search for the top 3-5 AI news items from the last 24 hours.

Send the digest to this Telegram group.',
  'cron',
  '5 8 * * *',
  'isolated',
  datetime('now'),
  'active',
  datetime('now')
);"
```

- [ ] **Step 9: Restart NanoClaw**

```bash
rm -rf data/sessions/*/agent-runner-src
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Task 6: Blogwatcher in Container + Scheduled Task

Install blogwatcher-cli in the container Dockerfile and add persistent volume for VAULT-claw's blogwatcher SQLite state.

**Files:**
- Modify: `container/Dockerfile:33` (add blogwatcher)
- Modify: `src/container-runner.ts:91-284` (add blogwatcher volume mount)
- Modify: `store/messages.db` (new scheduled task)

- [ ] **Step 1: Check blogwatcher npm package name**

```bash
npm info blogwatcher-cli 2>/dev/null || npm info @tobilu/blogwatcher-cli 2>/dev/null || echo "check npm registry manually"
```

If not on npm, check if the host binary is a Go binary:

```bash
file /opt/homebrew/bin/blogwatcher
```

- [ ] **Step 2: Add blogwatcher to container Dockerfile**

In `container/Dockerfile`, add after the existing global npm install line (line 33):

```dockerfile
# Install blogwatcher for RSS feed monitoring
RUN npm install -g blogwatcher-cli
```

If the package name is different (from Step 1), adjust accordingly. If it's a Go binary and not on npm, we'll need to download the pre-compiled binary:

```dockerfile
# Install blogwatcher for RSS feed monitoring (pre-compiled binary)
RUN curl -fsSL https://github.com/<owner>/blogwatcher-cli/releases/latest/download/blogwatcher-linux-amd64 \
      -o /usr/local/bin/blogwatcher && chmod +x /usr/local/bin/blogwatcher
```

- [ ] **Step 3: Add blogwatcher persistent volume mount**

In `src/container-runner.ts`, add inside `buildVolumeMounts()` after the Gmail credentials block (after line 210):

```typescript
  // Blogwatcher persistent state directory (for RSS read/unread tracking)
  // Only mounted for groups that use blogwatcher (VAULT-claw)
  if (group.folder === 'telegram_vault-claw') {
    const blogwatcherDir = path.join(DATA_DIR, 'blogwatcher', group.folder);
    fs.mkdirSync(blogwatcherDir, { recursive: true });
    mounts.push({
      hostPath: blogwatcherDir,
      containerPath: '/home/node/.blogwatcher-cli',
      readonly: false,
    });
  }
```

- [ ] **Step 4: Copy Hermes blogwatcher config (if it exists)**

```bash
mkdir -p data/blogwatcher/telegram_vault-claw
ls ~/.blogwatcher-cli/ 2>/dev/null && cp -r ~/.blogwatcher-cli/* data/blogwatcher/telegram_vault-claw/ || echo "No existing blogwatcher config — will be created on first run"
```

If no config exists, the agent will need to configure blogwatcher on first run. Add feeds for: genomics, psychiatric genetics, single-cell, long-read sequencing, AI for biology.

- [ ] **Step 5: Build TypeScript**

```bash
bun run build 2>&1 | grep -v '\.test\.ts'
```

Expected: no non-test errors.

- [ ] **Step 6: Rebuild container image**

```bash
./container/build.sh
```

This is required because we changed the Dockerfile. Build may take several minutes.

- [ ] **Step 7: Commit**

```bash
git add container/Dockerfile src/container-runner.ts
git commit -m "feat: add blogwatcher-cli to container image + persistent volume for VAULT-claw"
```

- [ ] **Step 8: Create the blogwatcher scheduled task**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES (
  'hermes-blogwatcher',
  'telegram_vault-claw',
  'tg:-1003751503376',
  'You are Claire, running the VAULT-claw blogwatcher RSS scan.

Mike follows research in: psychiatric genetics, single-cell genomics, long-read sequencing, AI for biology.

Steps:
1. Run: blogwatcher articles --unread
2. If new articles are found:
   - Summarize each (key finding, why it matters for Mike''s research)
   - Store notable findings in Hindsight via mcp__hindsight__retain
   - Send summary to this Telegram group
   - Mark articles as read: blogwatcher articles --mark-read
3. If no new articles: do NOT send any message (silent)

If blogwatcher is not configured yet, run blogwatcher init first, then add feeds for:
- Genomics/genetics research blogs
- Single-cell sequencing news
- Long-read sequencing updates
- AI for biology/science
- Psychiatric genetics journals

Check /workspace/global/state/watchlist.md for specific labs and researchers to monitor.',
  'cron',
  '5 9 */2 * *',
  'isolated',
  datetime('now'),
  'active',
  datetime('now')
);"
```

- [ ] **Step 9: Restart NanoClaw**

```bash
rm -rf data/sessions/*/agent-runner-src
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Task 7: Paperpile Sync Launchd Job

Host-side only — no container involvement.

**Files:**
- Create: `scripts/sync/paperpile_sync.py`
- Create: `launchd/com.nanoclaw.paperpile-sync.plist`

- [ ] **Step 1: Copy paperpile_sync.py from Hermes**

```bash
cp ~/.hermes/scripts/paperpile_sync.py scripts/sync/paperpile_sync.py
```

- [ ] **Step 2: Verify the script works**

```bash
python3 scripts/sync/paperpile_sync.py --check
```

Expected: shows current local file info and whether an update is available. If it fails with an auth error, the Google token at `~/.hermes/google_token.json` may need refresh.

- [ ] **Step 3: Create launchd plist**

Create `launchd/com.nanoclaw.paperpile-sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.paperpile-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/Users/mgandal/Agents/nanoclaw/scripts/sync/paperpile_sync.py</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>6</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/mgandal/Agents/nanoclaw/logs/paperpile-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/mgandal/Agents/nanoclaw/logs/paperpile-sync.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/mgandal</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 4: Install and load the plist**

```bash
cp launchd/com.nanoclaw.paperpile-sync.plist ~/Library/LaunchAgents/com.nanoclaw.paperpile-sync.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.paperpile-sync.plist
```

- [ ] **Step 5: Test a manual sync**

```bash
python3 scripts/sync/paperpile_sync.py --force
```

Expected: downloads paperpile.bib, reports entry count.

- [ ] **Step 6: Commit**

```bash
git add scripts/sync/paperpile_sync.py launchd/com.nanoclaw.paperpile-sync.plist
git commit -m "feat: add paperpile-sync launchd job (daily 6 AM)"
```

---

## Task 8: Verification + Hermes Cron Pause

After all tasks are created and running, verify each workflow fires correctly, then pause the corresponding Hermes cron.

- [ ] **Step 1: List all new NanoClaw tasks**

```bash
sqlite3 store/messages.db "SELECT id, group_folder, schedule_value, status FROM scheduled_tasks WHERE id LIKE 'hermes-%';"
```

Expected:
```
hermes-week-ahead|telegram_claire|0 10 * * 6|active
hermes-slack-scanner|telegram_lab-claw|0 6 * * 1-5|active
hermes-ai-brief|telegram_code-claw|5 8 * * *|active
hermes-blogwatcher|telegram_vault-claw|5 9 */2 * *|active
```

- [ ] **Step 2: Wait for first fire of each task**

Monitor logs over 24-48h:

```bash
sqlite3 store/messages.db "SELECT task_id, started_at, status, substr(error,1,100) FROM task_run_logs WHERE task_id LIKE 'hermes-%' ORDER BY started_at DESC LIMIT 10;"
```

Each task should show at least one successful run (`status='success'`).

- [ ] **Step 3: Verify output in Telegram**

Check each group for the expected message format:
- CLAIRE: Week-ahead preview (Saturday 10 AM)
- LAB-claw: Slack scan summary (weekday 6 AM)
- CODE-claw: AI builders digest (8:05 AM)
- VAULT-claw: Blogwatcher summary or silence (9:05 AM every other day)

- [ ] **Step 4: Pause corresponding Hermes crons**

After verifying NanoClaw's output is equivalent:

In Hermes, pause these cron jobs (via Hermes CLI or by editing `~/.hermes/cron/jobs.json`):
- `054d0a9da127` (weekly-week-ahead)
- `e31e1430687d` (slack-context-scanner)
- `8fd92b52c460` (AI Morning Brief + Builders Digest)
- `228956dd492f` (blogwatcher-scan)
- `f3b4af40b480` (paperpile-sync)

Do NOT delete — pause only, enabling instant rollback.

- [ ] **Step 5: Final verification**

Run for another 24h with Hermes crons paused. Confirm NanoClaw handles all workflows independently.

```bash
sqlite3 store/messages.db "SELECT task_id, COUNT(*) as runs, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successes FROM task_run_logs WHERE task_id LIKE 'hermes-%' GROUP BY task_id;"
```

All tasks should have runs > 0 and successes == runs.
