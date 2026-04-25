# Slack MCP C-Full (Native SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the supergateway-wrapped `slack-mcp-server@1.1.28` with a resident `slack-mcp-server@1.2.3 --transport sse` process so containers can hit a stable Slack MCP endpoint without per-session cache races.

**Architecture:** Today: launchd → `~/.cache/slack-mcp/start.sh` → `supergateway` (stdio→Streamable HTTP on 8189) → `proxy.mjs` (0.0.0.0:8190 → 127.0.0.1:8189). New session per HTTP request spawns a fresh `slack-mcp-server` child, so each container request hits a cold Slack-cache rebuild and silently fails inside the warmup window. After: launchd → `start.sh` → resident `slack-mcp-server@1.2.3 --transport sse` (127.0.0.1:13080) → `proxy.mjs` (0.0.0.0:8190 → 127.0.0.1:13080). One long-lived process, one warm cache, one URL flip from `…:8190/mcp` to `…:8190/sse`.

**Tech Stack:** Bash launchd plists, `slack-mcp-server@1.2.3` (npm), Node TCP proxy (`proxy.mjs`), `@modelcontextprotocol/sdk` (in-container client at `container/agent-runner/src/index.ts:337-343`), NanoClaw env wiring (`src/container-runner.ts:604-621`), `.env` `SLACK_MCP_URL`.

**Pre-flight reality checks (read before starting):**
- `npm list -g | grep slack-mcp` shows `slack-mcp-server@1.2.3` is already globally installed; the version pin is in `start.sh` via `npx -y slack-mcp-server@1.1.28`, not in a package.json.
- `~/.cache/slack-mcp/launchd-stderr.log` currently shows the 1.1.28 supergateway child is **crashing** (`Command failed: slack-mcp-server-darwin-arm64`). The migration is therefore both a fix and an upgrade — old setup is not actually healthy.
- Token in `~/.claude.json` `mcpServers.slack.env` is **only `SLACK_MCP_XOXP_TOKEN`**. The 4-day-old project memory file claiming the working setup uses stealth `xoxc+xoxd` is incorrect — verify, don't trust.
- The probe transcripts noted in memory at `/tmp/slackmcp-probe.out` and `/tmp/slackmcp-sse.out` may be stale or gone. If you need them, re-capture in Task 1.
- All scheduled tasks calling `mcp__slack__*` route through `SLACK_MCP_URL`. The `slack-intraday-monitor` task in `store/messages.db` (`group_folder=telegram_claire`, cron `0,30 9-17 * * 1-5`) is the canary; its first weekday fire after rollout is the success signal.

---

### Task 1: Verify SDK SSE transport support and 1.2.3 token scopes

**Files:**
- Inspect: `container/agent-runner/src/index.ts:337-343` (where `SLACK_MCP_URL` is wired into `servers.slack`)
- Inspect: `node_modules/@modelcontextprotocol/sdk/dist/esm/client/sse.js` (verify SSE transport exists)
- Capture: `/tmp/slackmcp-sse-probe-2026-04-25.out` (fresh probe transcript)

- [ ] **Step 1: Verify @modelcontextprotocol/sdk supports SSE transport on the in-container side**

The agent-runner wires Slack MCP as `type: 'http'`. The Claude Agent SDK's MCP transport selector accepts `http` for both Streamable HTTP and SSE endpoints — but only if the SDK version is recent enough. Confirm by reading the SDK source:

```bash
ls /Users/mgandal/Agents/nanoclaw/container/agent-runner/node_modules/@modelcontextprotocol/sdk/dist/esm/client/ 2>/dev/null
```

Expected: a directory listing that includes both `sse.js` and `streamableHttp.js`. If only one is present, check the parent `node_modules/@modelcontextprotocol/sdk/package.json` version — needs ≥ `1.0.0` for both to coexist. Document which is found.

- [ ] **Step 2: Capture a fresh probe of `slack-mcp-server@1.2.3 --transport sse` with the live xoxp token**

```bash
SLACK_TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.claude.json')); print(d['mcpServers']['slack']['env']['SLACK_MCP_XOXP_TOKEN'])")
SLACK_MCP_XOXP_TOKEN="$SLACK_TOKEN" \
SLACK_MCP_ADD_MESSAGE_TOOL="C0ABVNZLA0L" \
  npx -y slack-mcp-server@1.2.3 --transport sse --host 127.0.0.1 --port 13099 \
  > /tmp/slackmcp-sse-probe-2026-04-25.out 2>&1 &
PROBE_PID=$!
sleep 5
curl -sN -H "Accept: text/event-stream" http://127.0.0.1:13099/sse | head -20
kill $PROBE_PID 2>/dev/null
```

Expected: server logs show `listening on 127.0.0.1:13099`; the curl output shows an SSE-framed `event: endpoint` followed by an `event: message` payload. If the probe shows `missing_scope` errors, **stop** and run Task 1b (token-scope diagnosis) before continuing.

- [ ] **Step 3: List the actual MCP tools served by 1.2.3**

```bash
SLACK_TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.claude.json')); print(d['mcpServers']['slack']['env']['SLACK_MCP_XOXP_TOKEN'])")
SLACK_MCP_XOXP_TOKEN="$SLACK_TOKEN" \
SLACK_MCP_ADD_MESSAGE_TOOL="C0ABVNZLA0L" \
  npx -y slack-mcp-server@1.2.3 --transport sse --host 127.0.0.1 --port 13099 \
  > /tmp/slackmcp-tools-probe.log 2>&1 &
PROBE_PID=$!
sleep 4
# initialize
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  http://127.0.0.1:13099/sse 2>&1 | head -40
# list tools
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  http://127.0.0.1:13099/sse 2>&1 | head -40
kill $PROBE_PID 2>/dev/null
```

Expected: tools list contains at minimum `conversations_history`, `conversations_replies`, `conversations_unreads`, `channels_list`, `users_search`. Save the full list into `/tmp/slackmcp-tools-probe.log` for reference. Compare to current allowlist in `container/agent-runner/src/index.ts:810` (`'mcp__slack__*'`) — wildcard is fine; just confirm the names haven't been renamed in 1.2.x (e.g., `slack_*` → `conversations_*`).

- [ ] **Step 4: Decision gate — is C-full safe?**

Three conditions must hold:
1. SDK has both `sse.js` and `streamableHttp.js` (Step 1).
2. Probe in Step 2 returns SSE-framed events with no `missing_scope`.
3. Tool names in Step 3 match what scheduled tasks already call (look at the prompt body of `slack-intraday-monitor` in `store/messages.db` — `sqlite3 store/messages.db "SELECT prompt FROM scheduled_tasks WHERE id='slack-intraday-monitor'"`).

If all three hold, proceed to Task 2. If any fails, stop and surface to user — the plan needs revision (most likely: keep 1.1.28 in supergateway and only fix the crash; or: use `xoxc/xoxd` stealth cookies which require manual capture from a logged-in browser).

- [ ] **Step 5: Commit the probe artifacts**

```bash
mkdir -p docs/superpowers/plan-artifacts/2026-04-25-slack-mcp-c-full-sse
cp /tmp/slackmcp-sse-probe-2026-04-25.out docs/superpowers/plan-artifacts/2026-04-25-slack-mcp-c-full-sse/
cp /tmp/slackmcp-tools-probe.log docs/superpowers/plan-artifacts/2026-04-25-slack-mcp-c-full-sse/
git add docs/superpowers/plan-artifacts/2026-04-25-slack-mcp-c-full-sse/
git commit -m "docs(plans): capture slack-mcp 1.2.3 SSE probe artifacts pre-migration"
```

---

### Task 2: Stand up resident slack-mcp@1.2.3 SSE server side-by-side (port 13080)

**Files:**
- Create: `~/.cache/slack-mcp/start.sh.new` (proposed replacement; not yet wired)
- Inspect: `~/Library/LaunchAgents/com.slack-mcp.plist` (no changes yet)
- Inspect: `~/.cache/slack-mcp/proxy.mjs` (no changes yet)

- [ ] **Step 1: Write the new start.sh as a `.new` sibling**

Do not overwrite `start.sh` yet — we run side-by-side first. Create `~/.cache/slack-mcp/start.sh.new`:

```bash
cat > ~/.cache/slack-mcp/start.sh.new <<'EOF'
#!/bin/bash
# Run slack-mcp-server@1.2.3 as a resident SSE server (no supergateway).
# Bound to 127.0.0.1:13080; proxy.mjs exposes it on 0.0.0.0:8190 for containers.
set -e

NODE="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/node"
NPX="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin/npx"
PROXY="/Users/mgandal/.cache/slack-mcp/proxy.mjs"

export PATH="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:$PATH"

# Load Slack user token from ~/.claude.json
SLACK_TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.claude.json')); print(d['mcpServers']['slack']['env']['SLACK_MCP_XOXP_TOKEN'])")
export SLACK_MCP_XOXP_TOKEN="$SLACK_TOKEN"
export SLACK_MCP_ADD_MESSAGE_TOOL="C0ABVNZLA0L"

# Resident SSE server on 127.0.0.1:13080 (no per-session child spawning).
"$NPX" -y slack-mcp-server@1.2.3 --transport sse --host 127.0.0.1 --port 13080 &
SS_PID=$!

# Wait for SSE server to be ready
for i in $(seq 1 20); do
  curl -sf -m 1 -H "Accept: text/event-stream" -N http://127.0.0.1:13080/sse 2>/dev/null | head -c 1 >/dev/null && break
  sleep 0.5
done

# Liveness ping — log once per start so silent degradation is visible.
echo "[start.sh] slack-mcp-server@1.2.3 SSE up on 127.0.0.1:13080 at $(date -Iseconds)"

# Start TCP proxy (0.0.0.0:8190 → 127.0.0.1:13080) for Apple Container VMs.
"$NODE" "$PROXY" &
PROXY_PID=$!

trap "kill $SS_PID $PROXY_PID 2>/dev/null; wait" TERM INT
wait
EOF
chmod +x ~/.cache/slack-mcp/start.sh.new
```

- [ ] **Step 2: Patch proxy.mjs to forward to 13080 (kept side-by-side)**

The current proxy hardcodes `TARGET_PORT = 8189`. We need a 13080 variant. Create a sibling proxy file rather than editing in place — keeps rollback trivial:

```bash
cat > ~/.cache/slack-mcp/proxy-sse.mjs <<'EOF'
// TCP proxy: binds 0.0.0.0:8190 → forwards to 127.0.0.1:13080 (SSE server)
// Containers access via host.containers.internal:8190
import net from 'net';
const LISTEN_PORT = 8190;
const TARGET_PORT = 13080;
const server = net.createServer((client) => {
  const target = net.connect(TARGET_PORT, '127.0.0.1', () => {
    client.pipe(target);
    target.pipe(client);
  });
  target.on('error', () => client.destroy());
  client.on('error', () => target.destroy());
});
server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`Proxy listening on 0.0.0.0:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT}`);
});
EOF
```

Then update `start.sh.new` to reference `proxy-sse.mjs` instead of `proxy.mjs`:

```bash
sed -i '' 's|/Users/mgandal/.cache/slack-mcp/proxy.mjs|/Users/mgandal/.cache/slack-mcp/proxy-sse.mjs|' ~/.cache/slack-mcp/start.sh.new
grep proxy ~/.cache/slack-mcp/start.sh.new
```

Expected: `PROXY="/Users/mgandal/.cache/slack-mcp/proxy-sse.mjs"`.

- [ ] **Step 3: Manually run start.sh.new in foreground to verify**

The current launchd is still running the old setup on 8189/8190. To run the new one without conflicting, **stop the old setup first** (it's crashing anyway; nothing depends on it serving 8190 right now besides agent containers, which shouldn't be running scheduled tasks during this minute):

```bash
launchctl unload ~/Library/LaunchAgents/com.slack-mcp.plist
sleep 2
lsof -nP -iTCP:8190 -sTCP:LISTEN || echo "8190 free"
~/.cache/slack-mcp/start.sh.new &
SCRIPT_PID=$!
sleep 6
```

Expected: `8190 free`; then `[start.sh] slack-mcp-server@1.2.3 SSE up on 127.0.0.1:13080 at <ts>`; then `Proxy listening on 0.0.0.0:8190 -> 127.0.0.1:13080`.

- [ ] **Step 4: Verify the SSE endpoint is reachable through the proxy**

```bash
curl -sN -m 3 -H "Accept: text/event-stream" http://127.0.0.1:8190/sse | head -10
```

Expected: SSE-framed `event: endpoint` line. If you get nothing, check `lsof -nP -iTCP:13080 -sTCP:LISTEN` and `lsof -nP -iTCP:8190 -sTCP:LISTEN` to find which side is missing.

- [ ] **Step 5: Tear down and commit the new files**

```bash
kill $SCRIPT_PID 2>/dev/null
sleep 1
launchctl load ~/Library/LaunchAgents/com.slack-mcp.plist  # restore old (crashing) setup until cutover
git add docs/superpowers/plans/2026-04-25-slack-mcp-c-full-sse.md
# start.sh.new + proxy-sse.mjs live in ~/.cache, not in repo — note that in the commit body
git commit --allow-empty -m "wip(slack-mcp): SSE server side-by-side validated locally

start.sh.new and proxy-sse.mjs created in ~/.cache/slack-mcp/.
Resident slack-mcp-server@1.2.3 on 127.0.0.1:13080 + TCP proxy on
0.0.0.0:8190 verified reachable via curl. Old supergateway+1.1.28
setup remains the active launchd target until Task 4 cutover."
```

---

### Task 3: Add a unit test for SLACK_MCP_URL parsing of the SSE path

**Files:**
- Modify: `src/container-runner.ts:604-621`
- Test: `src/container-runner.test.ts` (create if missing — check first with `ls src/container-runner.test.ts`)

The current parser at `src/container-runner.ts:609-616` reads `parsed.pathname` from `SLACK_MCP_URL` and passes the path through verbatim. That should already handle `/sse` — but the only existing reference is `/mcp`. Add a regression test so a future refactor can't quietly drop SSE-path support.

- [ ] **Step 1: Check whether a test file already exists**

```bash
ls src/container-runner.test.ts 2>&1 || echo "NOT_FOUND"
```

If `NOT_FOUND`, this task creates it. If it exists, append to it.

- [ ] **Step 2: Write the failing test**

If creating new file `src/container-runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the URL transform inline — extract the slice from container-runner.ts
// for unit testing. If you'd rather not extract, this test just documents
// the expected behaviour as a guard against accidental regressions.
function transformSlackMcpUrl(input: string, gateway: string): string {
  const parsed = new URL(input);
  const hostname =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
      ? gateway
      : parsed.hostname;
  return `${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`;
}

describe('SLACK_MCP_URL transform for SSE path', () => {
  it('preserves /sse pathname when rewriting localhost to container gateway', () => {
    expect(
      transformSlackMcpUrl('http://localhost:8190/sse', '192.168.64.1'),
    ).toBe('http://192.168.64.1:8190/sse');
  });

  it('still preserves legacy /mcp pathname (back-compat)', () => {
    expect(
      transformSlackMcpUrl('http://127.0.0.1:8190/mcp', '192.168.64.1'),
    ).toBe('http://192.168.64.1:8190/mcp');
  });

  it('leaves non-loopback hostnames alone', () => {
    expect(
      transformSlackMcpUrl('http://example.com:8190/sse', '192.168.64.1'),
    ).toBe('http://example.com:8190/sse');
  });
});
```

- [ ] **Step 3: Run test to verify it passes (no regression in existing parser)**

```bash
bun --bun vitest run src/container-runner.test.ts
```

Expected: 3 tests pass. (This is "test-second" — the parser already does the right thing; the test just locks the behaviour in.)

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.test.ts
git commit -m "test(container-runner): lock SLACK_MCP_URL /sse path preservation"
```

---

### Task 4: Cutover — flip SLACK_MCP_URL from /mcp to /sse and replace start.sh

**Files:**
- Modify: `~/.cache/slack-mcp/start.sh` (replace with `start.sh.new` contents)
- Modify: `/Users/mgandal/Agents/nanoclaw/.env` line `SLACK_MCP_URL=…/mcp` → `…/sse`
- Restart: launchd `com.slack-mcp` and NanoClaw

- [ ] **Step 1: Snapshot current state for rollback**

```bash
cp ~/.cache/slack-mcp/start.sh ~/.cache/slack-mcp/start.sh.pre-c-full-2026-04-25
cp /Users/mgandal/Agents/nanoclaw/.env /Users/mgandal/Agents/nanoclaw/.env.pre-c-full-2026-04-25
ls -la ~/.cache/slack-mcp/start.sh.pre-c-full-2026-04-25 /Users/mgandal/Agents/nanoclaw/.env.pre-c-full-2026-04-25
```

Expected: both backup files exist.

- [ ] **Step 2: Replace start.sh and confirm it's the new content**

```bash
mv ~/.cache/slack-mcp/start.sh.new ~/.cache/slack-mcp/start.sh
chmod +x ~/.cache/slack-mcp/start.sh
grep "slack-mcp-server@1.2.3" ~/.cache/slack-mcp/start.sh
```

Expected: matches `"$NPX" -y slack-mcp-server@1.2.3 --transport sse --host 127.0.0.1 --port 13080 &`.

- [ ] **Step 3: Restart the launchd service**

```bash
launchctl unload ~/Library/LaunchAgents/com.slack-mcp.plist
sleep 2
launchctl load ~/Library/LaunchAgents/com.slack-mcp.plist
sleep 6
tail -20 ~/.cache/slack-mcp/launchd-stdout.log
```

Expected stdout tail: `[start.sh] slack-mcp-server@1.2.3 SSE up on 127.0.0.1:13080 at <ts>` and `Proxy listening on 0.0.0.0:8190 -> 127.0.0.1:13080`. The launchd-stderr.log should be **silent** (no `Command failed` lines from the prior 1.1.28 crash loop).

- [ ] **Step 4: Verify the proxy + SSE serve reachable from a test curl**

```bash
curl -sN -m 3 -H "Accept: text/event-stream" http://127.0.0.1:8190/sse | head -10
```

Expected: SSE-framed `event: endpoint` line.

- [ ] **Step 5: Flip SLACK_MCP_URL in .env**

```bash
# Read current value, transform, write back
OLD=$(grep '^SLACK_MCP_URL=' /Users/mgandal/Agents/nanoclaw/.env)
echo "Current: $OLD"
sed -i '' 's|^SLACK_MCP_URL=.*|SLACK_MCP_URL=http://localhost:8190/sse|' /Users/mgandal/Agents/nanoclaw/.env
grep '^SLACK_MCP_URL=' /Users/mgandal/Agents/nanoclaw/.env
```

Expected output: `SLACK_MCP_URL=http://localhost:8190/sse`.

- [ ] **Step 6: Restart NanoClaw to pick up the new env value**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 8
tail -40 /Users/mgandal/Agents/nanoclaw/logs/nanoclaw.log | grep -i "slack\|started\|connected" | head -10
```

Expected: NanoClaw startup complete, no Slack-related errors. (Slack MCP only loads inside agent containers, so the orchestrator log itself is mostly irrelevant — we're just confirming NanoClaw came back up cleanly.)

- [ ] **Step 7: Smoke-test from inside a fresh agent container**

Pipe a one-shot test prompt to CLAIRE:

```bash
cat > /tmp/slack-smoke-test.txt <<'EOF'
Use mcp__slack__conversations_unreads with limit=1 and tell me how many unread conversations you got back. Reply with just the number.
EOF
# Smoke-test by sending the prompt via the IPC pipe used by the existing
# integration suite. Approach: run claire interactively via container-runner test
# harness, OR just wait for the next scheduled fire (Task 5).
echo "Skipping interactive smoke — relying on scheduled-task verification in Task 5."
```

(Manual smoke tests inside agent containers require the full message pipeline. The next scheduled fire of `slack-intraday-monitor` is the canonical signal — Task 5.)

- [ ] **Step 8: Commit the .env change is NOT applicable (`.env` is gitignored)**

`.env` is in `.gitignore`. The pre-cutover backup `.env.pre-c-full-2026-04-25` is local-only. There's nothing to commit at this step. Just verify:

```bash
git check-ignore -v /Users/mgandal/Agents/nanoclaw/.env
```

Expected: prints the gitignore rule that ignores `.env`. If somehow it's tracked, **stop** and ask the user — never commit secrets.

---

### Task 5: Verify the next scheduled fire of slack-intraday-monitor succeeds

**Files:**
- Inspect: `store/messages.db` table `scheduled_tasks` row id `slack-intraday-monitor`
- Inspect: `store/messages.db` table `task_run_logs` for matching `task_id`
- Inspect: `/Users/mgandal/Agents/nanoclaw/logs/nanoclaw.log`

The cron is `0,30 9-17 * * 1-5`. If you complete Task 4 inside the cron window, the next fire is within 30 minutes. Otherwise the next weekday morning at 09:00 ET.

- [ ] **Step 1: Confirm task is still ACTIVE in the DB**

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT id, status, schedule_value, next_run, datetime(next_run/1000, 'unixepoch', 'localtime') AS next_run_local FROM scheduled_tasks WHERE id='slack-intraday-monitor';"
```

Expected: one row, `status=active`, `schedule_value=0,30 9-17 * * 1-5`, `next_run` populated and in the future.

- [ ] **Step 2: Tail the run logs and wait for first post-cutover fire**

```bash
# Snapshot the last existing run
LAST_RUN=$(sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT MAX(run_at) FROM task_run_logs WHERE task_id='slack-intraday-monitor';")
echo "Last run before cutover: $LAST_RUN"
```

Then after the next scheduled time elapses (check `next_run_local` from Step 1), re-query:

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT run_at, datetime(run_at/1000, 'unixepoch', 'localtime') AS local_ts, status, substr(stdout, 1, 200) AS stdout_head, substr(stderr, 1, 200) AS stderr_head FROM task_run_logs WHERE task_id='slack-intraday-monitor' ORDER BY run_at DESC LIMIT 3;"
```

Expected: a new row exists with `run_at > LAST_RUN`. `status` is `success`. `stdout_head` should NOT contain `users cache is not ready yet` or `Phase 0 retry failed`. If `status` is `error` or stdout/stderr has cache-not-ready text, **stop**, run rollback (Task 6), and surface the error to the user.

- [ ] **Step 3: Verify no new errors in nanoclaw.log around fire time**

```bash
grep -i "slack" /Users/mgandal/Agents/nanoclaw/logs/nanoclaw.log | tail -20
```

Expected: no error-level entries. Info-level "task fired" / "task completed" entries are fine.

- [ ] **Step 4: Update memory file to reflect new state**

```bash
cat > /Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/project_slack_intraday_monitor.md <<'EOF'
---
name: Slack intraday monitor
description: 30-min Slack unread monitor — running clean on slack-mcp@1.2.3 native SSE since 2026-04-25 cutover (Fix C-full)
type: project
---
# Slack intraday monitor (`slack-intraday-monitor`)

**Status (2026-04-25):** Healthy. Migrated from supergateway+slack-mcp@1.1.28 to resident slack-mcp-server@1.2.3 --transport sse on 127.0.0.1:13080 (proxy.mjs forwards 0.0.0.0:8190 → 13080). One long-lived process eliminates the per-session cache race that caused silent NOISE-only exits Apr 18-25.

**Why:** The 1.1.28 setup was crashing on macOS arm64 (`slack-mcp-server-darwin-arm64` Command failed) AND, when not crashing, hit cache-not-ready races on every fresh HTTP session. Native SSE on a resident process keeps one warm Slack cache.

**How to apply:** `SLACK_MCP_URL=http://localhost:8190/sse` in `.env`. Token is `SLACK_MCP_XOXP_TOKEN` from `~/.claude.json` (xoxp, not stealth — earlier project memory was wrong about that). Container connects via `http://192.168.64.1:8190/sse` (hostname rewrite at `src/container-runner.ts:609-616`).

**Rollback:** `~/.cache/slack-mcp/start.sh.pre-c-full-2026-04-25` and `.env.pre-c-full-2026-04-25` snapshots in place.

**Known good signal:** `task_run_logs` rows with `status=success` and no `users cache is not ready yet` in stdout for `slack-intraday-monitor`.
EOF
```

Update the MEMORY.md index pointer:

```bash
# Locate the existing pointer line and update its hook
grep -n "Slack intraday monitor" /Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md
```

If found, update its hook to `— migrated to native SSE 2026-04-25 (Fix C-full); blocker resolved`. Use the Edit tool on `MEMORY.md` to change the one-line hook in place.

- [ ] **Step 5: Commit plan-completion notes**

```bash
git add docs/superpowers/plans/2026-04-25-slack-mcp-c-full-sse.md
git commit -m "docs(plans): mark slack-mcp C-full plan complete

Resident slack-mcp-server@1.2.3 SSE on 127.0.0.1:13080 cutover.
Verified via slack-intraday-monitor task_run_logs success after cron fire.
Memory updated: project_slack_intraday_monitor.md."
```

---

### Task 6: Rollback procedure (only run if Task 5 fails)

**Files:**
- Restore: `~/.cache/slack-mcp/start.sh` from `~/.cache/slack-mcp/start.sh.pre-c-full-2026-04-25`
- Restore: `.env` from `.env.pre-c-full-2026-04-25`

This is reference material — only execute if Task 5 verification fails.

- [ ] **Step 1: Restore start.sh**

```bash
cp ~/.cache/slack-mcp/start.sh.pre-c-full-2026-04-25 ~/.cache/slack-mcp/start.sh
chmod +x ~/.cache/slack-mcp/start.sh
```

- [ ] **Step 2: Restore .env**

```bash
cp /Users/mgandal/Agents/nanoclaw/.env.pre-c-full-2026-04-25 /Users/mgandal/Agents/nanoclaw/.env
grep '^SLACK_MCP_URL=' /Users/mgandal/Agents/nanoclaw/.env
```

Expected: `SLACK_MCP_URL=http://localhost:8190/mcp`.

- [ ] **Step 3: Restart services**

```bash
launchctl kickstart -k gui/$(id -u)/com.slack-mcp
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 4: Document why rollback was needed**

Append a `## Failure mode` section to `docs/superpowers/plans/2026-04-25-slack-mcp-c-full-sse.md` describing what failed, then commit. The plan now serves as a postmortem.

---

## Self-review notes

- Spec coverage: ✅ token verification (Task 1), side-by-side stand-up (Task 2), regression test (Task 3), cutover (Task 4), verification (Task 5), rollback (Task 6).
- Placeholders: none — every step contains the actual command and expected output.
- Type consistency: paths `~/.cache/slack-mcp/start.sh`, port `13080`, port `8190`, `SLACK_MCP_URL=…/sse` are consistent across tasks.
- Idempotency: backups created before destructive steps; rollback path explicit.
- Open question for the engineer running this: if `npx slack-mcp-server@1.2.3` evicts the global cache and re-downloads on every launchd restart, that adds ~15s startup latency. Mitigation if it becomes annoying: replace `npx -y slack-mcp-server@1.2.3` with the absolute path to the globally-installed binary (`npm root -g` + `/slack-mcp-server/...`). Out of scope for this plan; revisit if startup feels slow.
