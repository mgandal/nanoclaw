# Calendar MCP Server Implementation Plan

> **Status: SHIPPED 2026-04-06.** Calendar MCP live (commit `c152fc57`). launchd `com.calendar-mcp` running (PID 1171, currently loaded). Server artifacts at `~/.cache/calendar-mcp/` (server.mjs 9.2K, proxy.mjs, start.sh, package.json). Container wiring: `src/container-runner.ts:586-600` rewrites `CALENDAR_URL`; `container/agent-runner/src/index.ts:329` registers calendar MCP server; `mcp__calendar__*` allowlisted at line 809. 4 tools (`calendar_today`, `calendar_range`, `calendar_now`, `calendar_list`) live since 2026-04-06. Wraps icalBuddy CLI for all macOS calendars (Google, Exchange/Outlook, subscriptions). Ports: 8188 (proxy), 8187 (supergateway). Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give container agents real-time, on-demand access to ALL macOS calendars (including Exchange/Outlook) via a Calendar MCP server running on the host.

**Architecture:** A stdio MCP server wrapping icalBuddy → exposed as HTTP via supergateway → TCP proxy for container access. Follows the exact Apple Notes / Todoist MCP pattern (launchd + supergateway + proxy). Container agents connect via `CALENDAR_URL` env var, same as other HTTP MCP servers.

**Tech Stack:** Node.js, `@modelcontextprotocol/sdk`, supergateway, icalBuddy CLI, launchd

**Ports:** supergateway on `127.0.0.1:8187`, TCP proxy on `0.0.0.0:8188` (next available pair after Todoist 8185/8186)

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `~/.cache/calendar-mcp/server.mjs` | Create | Stdio MCP server wrapping icalBuddy |
| `~/.cache/calendar-mcp/proxy.mjs` | Create | TCP proxy (0.0.0.0:8188 → 127.0.0.1:8187) |
| `~/.cache/calendar-mcp/start.sh` | Create | Launcher: supergateway + proxy + signal forwarding |
| `~/Library/LaunchAgents/com.calendar-mcp.plist` | Create | Launchd service definition |
| `.env` | Modify | Add `CALENDAR_URL=http://localhost:8188/mcp` |
| `src/container-runner.ts` | Modify | Add CALENDAR_URL rewriting block |
| `container/agent-runner/src/index.ts` | Modify | Register calendar MCP server |
| `groups/telegram_claire/CLAUDE.md` | Modify | Replace icalbuddy.sh instructions with MCP tool usage |

---

### Task 1: Create the stdio MCP server

**Files:**
- Create: `~/.cache/calendar-mcp/server.mjs`

This is the core — a standalone Node.js MCP server that exposes icalBuddy through 4 tools: `calendar_today`, `calendar_range`, `calendar_now`, `calendar_list`.

- [ ] **Step 1: Create the cache directory**

```bash
mkdir -p ~/.cache/calendar-mcp
```

- [ ] **Step 2: Write the MCP server**

Create `~/.cache/calendar-mcp/server.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Calendar MCP Server — wraps macOS icalBuddy CLI as an MCP stdio server.
 * Exposes all macOS calendars (Google, Exchange/Outlook, subscriptions, etc.)
 * through MCP tools. Designed to be wrapped by supergateway for HTTP access.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const ICALBUDDY = '/opt/homebrew/bin/icalBuddy';

// ── icalBuddy helpers ─────────────────────────────────────────────────────────

/**
 * Run icalBuddy with structured output parsing.
 * Uses bullet/property separators for reliable parsing.
 */
async function runIcalBuddy(args) {
  const baseArgs = [
    '-f',              // format output
    '-ea',             // exclude all-day events from time ranges (override per-tool)
    '-nrd',            // no relative dates
    '-npn',            // no property names
    '-b', '|||',       // bullet = block separator
    '-ps', '| ~~ |',  // property separator
    '-po', 'title,datetime,location,calendarTitle',
    '-iep', 'title,datetime,location,calendarTitle',
    '-df', '%Y-%m-%dT%H:%M:%S',
    '-tf', '%H:%M',
  ];

  const { stdout } = await execFileAsync(ICALBUDDY, [...baseArgs, ...args], {
    timeout: 15_000,
    encoding: 'utf-8',
  });

  // Strip ANSI color codes
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');

  const events = [];
  const blocks = clean.split('|||').filter(b => b.trim());

  for (const block of blocks) {
    const parts = block.split(' ~~ ').map(p => p.trim());
    if (parts.length < 2) continue;

    let rawTitle = parts[0];
    let calendar = '';
    // icalBuddy appends calendar name: "Event Title (CalendarName)"
    const calMatch = rawTitle.match(/\s+\(([^)]+)\)$/);
    if (calMatch) {
      calendar = calMatch[1];
      rawTitle = rawTitle.slice(0, calMatch.index);
    }

    const datetimeStr = parts[1] || '';
    const location = parts[2] || '';

    // Parse datetime — "2026-04-02T10:00:00 at 10:00 - 11:00"
    let dtClean = datetimeStr.replace(/\s+at\s+\d{1,2}:\d{2}/g, '');
    let start = '';
    let end = '';
    let allDay = false;

    if (dtClean.includes(' - ')) {
      const [s, e] = dtClean.split(' - ').map(x => x.trim());
      start = s;
      end = e;
    } else {
      start = dtClean.trim();
    }

    if (start.match(/^\d{4}-\d{2}-\d{2}$/) || !start.includes('T')) {
      allDay = true;
    }

    const event = { title: rawTitle.trim(), start, calendar };
    if (end) event.end = end;
    if (allDay) event.allDay = true;
    if (location) event.location = location;
    events.push(event);
  }

  return events;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'calendar',
  version: '1.0.0',
});

server.tool(
  'calendar_today',
  "Get today's calendar events from ALL macOS calendars (Google, Exchange/Outlook, subscriptions). Returns structured JSON with title, time, location, and calendar source.",
  {
    calendars: z.string().optional().describe(
      'Comma-separated calendar names to filter (e.g. "MJG,Outlook"). Omit for all calendars.'
    ),
    include_all_day: z.boolean().optional().describe(
      'Include all-day events (default: true)'
    ),
  },
  async (args) => {
    const icalArgs = [];
    if (args.calendars) icalArgs.push('-ic', args.calendars);
    if (args.include_all_day !== false) icalArgs.push('-ea'); // remove the -ea from base
    icalArgs.push('eventsToday');

    const events = await runIcalBuddy(icalArgs);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(events, null, 2),
      }],
    };
  },
);

server.tool(
  'calendar_range',
  'Get calendar events for a date range from ALL macOS calendars. Use for checking availability, finding conflicts, or looking ahead.',
  {
    from: z.string().describe('Start date in YYYY-MM-DD format'),
    to: z.string().describe('End date in YYYY-MM-DD format'),
    calendars: z.string().optional().describe(
      'Comma-separated calendar names to filter. Omit for all calendars.'
    ),
  },
  async (args) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Dates must be YYYY-MM-DD format' }) }],
        isError: true,
      };
    }

    const icalArgs = [];
    if (args.calendars) icalArgs.push('-ic', args.calendars);
    icalArgs.push(`eventsFrom:${args.from}`, `to:${args.to}`);

    const events = await runIcalBuddy(icalArgs);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(events, null, 2),
      }],
    };
  },
);

server.tool(
  'calendar_now',
  'Get events happening right now. Useful for checking what meeting is currently active.',
  {
    calendars: z.string().optional().describe(
      'Comma-separated calendar names to filter. Omit for all calendars.'
    ),
  },
  async (args) => {
    const icalArgs = [];
    if (args.calendars) icalArgs.push('-ic', args.calendars);
    icalArgs.push('eventsNow');

    const events = await runIcalBuddy(icalArgs);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(events, null, 2),
      }],
    };
  },
);

server.tool(
  'calendar_list',
  'List all available calendars on this Mac with their types (CalDAV, Exchange, Subscription, Birthday). Use to discover which calendars exist before filtering.',
  {},
  async () => {
    const { stdout } = await execFileAsync(ICALBUDDY, ['calendars'], {
      timeout: 10_000,
      encoding: 'utf-8',
    });

    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const calendars = [];
    let current = null;

    for (const line of clean.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
        if (current) calendars.push(current);
        current = { name: trimmed.replace(/^[•*]\s+/, '') };
      } else if (trimmed.startsWith('type:') && current) {
        current.type = trimmed.slice(5).trim();
      }
    }
    if (current) calendars.push(current);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(calendars, null, 2),
      }],
    };
  },
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 3: Verify the server works in stdio mode**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node ~/.cache/calendar-mcp/server.mjs
```

Expected: JSON response with server capabilities (tools list). May need to install deps first — see Step 4.

- [ ] **Step 4: Install MCP SDK dependency for the server**

The server imports from `@modelcontextprotocol/sdk`. Initialize a minimal package.json and install:

```bash
cd ~/.cache/calendar-mcp
cat > package.json << 'EOF'
{
  "name": "calendar-mcp",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.24.0"
  }
}
EOF
npm install
```

- [ ] **Step 5: Re-test the server with deps installed**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node ~/.cache/calendar-mcp/server.mjs 2>/dev/null | head -5
```

Expected: JSON-RPC response with `result.serverInfo.name: "calendar"`.

- [ ] **Step 6: Test tool invocation manually**

```bash
# Send initialize then tools/list in sequence
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'; echo '{"jsonrpc":"2.0","id":2,"method":"notifications/initialized"}'; echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"calendar_today","arguments":{}}}') | node ~/.cache/calendar-mcp/server.mjs 2>/dev/null
```

Expected: Response containing today's calendar events as JSON.

- [ ] **Step 7: Commit server file**

```bash
# Server lives outside the repo at ~/.cache/calendar-mcp/ — no git commit needed.
# But add a note to the plan tracking that Task 1 is complete.
```

---

### Task 2: Create the TCP proxy and start script

**Files:**
- Create: `~/.cache/calendar-mcp/proxy.mjs`
- Create: `~/.cache/calendar-mcp/start.sh`

- [ ] **Step 1: Create the TCP proxy**

Create `~/.cache/calendar-mcp/proxy.mjs`:

```javascript
// TCP proxy: binds 0.0.0.0:8188 → forwards to 127.0.0.1:8187
// Allows Apple Container VMs to reach calendar-mcp via the host gateway IP
import net from 'net';
const LISTEN_PORT = 8188;
const TARGET_PORT = 8187;
const server = net.createServer(client => {
  const target = net.connect(TARGET_PORT, '127.0.0.1', () => {
    client.pipe(target);
    target.pipe(client);
  });
  target.on('error', () => client.destroy());
  client.on('error', () => target.destroy());
});
server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`Proxy listening on 0.0.0.0:${LISTEN_PORT} → 127.0.0.1:${TARGET_PORT}`);
});
```

- [ ] **Step 2: Create the start script**

Create `~/.cache/calendar-mcp/start.sh`:

```bash
#!/bin/bash
# Start calendar-mcp via supergateway (stdio→HTTP) and a TCP proxy for containers
set -e

NODE="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/node"
SUPERGATEWAY="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/supergateway"
CALENDAR_MCP="$HOME/.cache/calendar-mcp/server.mjs"
PROXY="$HOME/.cache/calendar-mcp/proxy.mjs"

export PATH="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:$PATH"
export NODE_PATH="$HOME/.cache/calendar-mcp/node_modules"

# Start supergateway: wraps calendar-mcp stdio as Streamable HTTP on port 8187 (localhost)
"$SUPERGATEWAY" --stdio "$NODE $CALENDAR_MCP" --outputTransport streamableHttp --port 8187 --streamableHttpPath /mcp --cors &
SG_PID=$!

# Wait for supergateway to be ready
for i in $(seq 1 20); do
  curl -s http://localhost:8187/mcp >/dev/null 2>&1 && break
  sleep 0.5
done

# Start proxy (0.0.0.0:8188 → 127.0.0.1:8187) for Apple Container VMs
"$NODE" "$PROXY" &
PROXY_PID=$!

# Forward signals to both children
trap "kill $SG_PID $PROXY_PID 2>/dev/null; wait" TERM INT

wait
```

```bash
chmod +x ~/.cache/calendar-mcp/start.sh
```

- [ ] **Step 3: Test the full stack manually**

```bash
# Start in foreground to verify
~/.cache/calendar-mcp/start.sh &
START_PID=$!
sleep 3

# Test via the proxy port (same way container will access it)
curl -s -X POST http://localhost:8188/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# Clean up
kill $START_PID 2>/dev/null
```

Expected: JSON-RPC initialize response from the MCP server.

- [ ] **Step 4: Verify tool call through the full HTTP stack**

```bash
~/.cache/calendar-mcp/start.sh &
START_PID=$!
sleep 3

# Initialize session, then call calendar_today
# (Streamable HTTP MCP uses POST with session management)
curl -s -X POST http://localhost:8188/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

kill $START_PID 2>/dev/null
```

Expected: Server responds with capabilities including 4 calendar tools.

---

### Task 3: Create launchd service

**Files:**
- Create: `~/Library/LaunchAgents/com.calendar-mcp.plist`

- [ ] **Step 1: Write the launchd plist**

Create `~/Library/LaunchAgents/com.calendar-mcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.calendar-mcp</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/mgandal/.cache/calendar-mcp/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/mgandal/.cache/calendar-mcp/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/mgandal/.cache/calendar-mcp/launchd-stderr.log</string>
    <key>WorkingDirectory</key>
    <string>/Users/mgandal</string>
</dict>
</plist>
```

- [ ] **Step 2: Load the service**

```bash
launchctl load ~/Library/LaunchAgents/com.calendar-mcp.plist
```

- [ ] **Step 3: Verify the service is running**

```bash
# Check process
lsof -iTCP:8187 -sTCP:LISTEN 2>/dev/null
lsof -iTCP:8188 -sTCP:LISTEN 2>/dev/null

# Check logs for errors
tail -5 ~/.cache/calendar-mcp/launchd-stderr.log
```

Expected: Both ports listening, no errors in logs.

- [ ] **Step 4: Test calendar query via the running service**

```bash
curl -s -X POST http://localhost:8188/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

Expected: Valid MCP initialize response.

---

### Task 4: Wire into NanoClaw container system

**Files:**
- Modify: `.env` (add CALENDAR_URL)
- Modify: `src/container-runner.ts` (add URL rewriting block)
- Modify: `container/agent-runner/src/index.ts` (register MCP server)

- [ ] **Step 1: Add CALENDAR_URL to .env**

Append to `/Users/mgandal/Agents/nanoclaw/.env`:

```
CALENDAR_URL=http://localhost:8188/mcp
```

- [ ] **Step 2: Add URL rewriting in container-runner.ts**

In `src/container-runner.ts`, add the CALENDAR_URL rewriting block after the Hindsight block (around line 369). Follow the exact same pattern as TODOIST_URL:

```typescript
  // Pass Calendar MCP endpoint URL (only if configured in .env)
  const calendarEnv = readEnvFile(['CALENDAR_URL']);
  const calendarUrl = process.env.CALENDAR_URL || calendarEnv.CALENDAR_URL;
  if (calendarUrl) {
    try {
      const parsed = new URL(calendarUrl);
      const hostname =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `CALENDAR_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn({ calendarUrl }, 'Invalid CALENDAR_URL, skipping Calendar');
    }
  }
```

- [ ] **Step 3: Register calendar MCP server in agent runner**

In `container/agent-runner/src/index.ts`, add inside `buildMcpServers()` after the Hindsight block (around line 254):

```typescript
  if (process.env.CALENDAR_URL) {
    servers.calendar = {
      type: 'http',
      url: process.env.CALENDAR_URL,
      headers: { Accept: 'application/json, text/event-stream' },
    };
  }
```

- [ ] **Step 4: Add calendar tools to the allowlist in agent runner**

In `container/agent-runner/src/index.ts`, add to the `allowedTools` array (around line 598):

```typescript
        'mcp__calendar__*',
```

- [ ] **Step 5: Build and verify**

```bash
cd /Users/mgandal/Agents/nanoclaw
bun run build
```

Expected: Clean build with no errors.

- [ ] **Step 6: Commit NanoClaw changes**

```bash
git add src/container-runner.ts container/agent-runner/src/index.ts .env
git commit -m "feat: add Calendar MCP server for container agents

Wire icalBuddy-based Calendar MCP into the container system:
- CALENDAR_URL env var with localhost→gateway rewriting
- Register as HTTP MCP server in agent runner
- Allow mcp__calendar__* tools"
```

---

### Task 5: Update agent instructions

**Files:**
- Modify: `groups/telegram_claire/CLAUDE.md`

- [ ] **Step 1: Read current CLAUDE.md calendar references**

Read `groups/telegram_claire/CLAUDE.md` and find all references to `icalbuddy.sh` and `/workspace/extra/claire-tools/`.

- [ ] **Step 2: Update morning briefing instructions**

Replace the icalbuddy.sh reference at line 325:

Old:
```
1. Today's calendar: run `/workspace/extra/claire-tools/icalbuddy.sh` to get today's events. Detect conflicts (overlapping times).
```

New:
```
1. Today's calendar: use the `calendar_today` MCP tool to get today's events from ALL calendars (Google, Exchange/Outlook, subscriptions). Detect conflicts (overlapping times). Use `calendar_range` for multi-day lookups and `calendar_list` to discover available calendars.
```

- [ ] **Step 3: Verify no other icalbuddy.sh references remain**

```bash
grep -n 'icalbuddy' groups/telegram_claire/CLAUDE.md
```

Expected: No matches.

- [ ] **Step 4: Commit CLAUDE.md update**

```bash
git add groups/telegram_claire/CLAUDE.md
git commit -m "docs: update Claire instructions to use Calendar MCP tools

Replace icalbuddy.sh (can't run macOS binary in Linux container)
with calendar MCP tools (calendar_today, calendar_range, etc.)"
```

---

### Task 6: Rebuild container and end-to-end test

- [ ] **Step 1: Delete cached agent-runner source to pick up changes**

```bash
rm -rf /Users/mgandal/Agents/nanoclaw/data/sessions/telegram_claire/agent-runner-src/
```

- [ ] **Step 2: Rebuild the container**

```bash
cd /Users/mgandal/Agents/nanoclaw
./container/build.sh
```

- [ ] **Step 3: Restart NanoClaw**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 4: Test via Telegram**

Send a message to Claire on Telegram:

> "What's on my calendar today?"

Expected: Claire responds with today's events from ALL calendars (Google, Exchange/Outlook, subscriptions) — not an error about icalBuddy not being installed.

- [ ] **Step 5: Test date range query**

> "What does my calendar look like next week?"

Expected: Claire returns events for the coming week across all calendar sources.

- [ ] **Step 6: Verify Exchange/Outlook events are included**

Check that the response includes events from the Outlook calendar (Exchange type), not just Google calendars.

---

### Task 7: Update memory

- [ ] **Step 1: Update MEMORY.md with Calendar MCP info**

Add entry to `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md`:

```
## Calendar MCP (installed 2026-04-06)
- Launchd: `~/Library/LaunchAgents/com.calendar-mcp.plist`
- supergateway on localhost:8187, TCP proxy on 0.0.0.0:8188
- Config/logs: `~/.cache/calendar-mcp/`
- Wraps icalBuddy CLI — all macOS calendars (Google, Exchange/Outlook, subscriptions)
- Tools: calendar_today, calendar_range, calendar_now, calendar_list
- Container env: CALENDAR_URL → rewritten to host gateway IP
```
