---
name: memory-status
description: Run a comprehensive diagnostic of all NanoClaw memory layers — health, stats, test queries, and actionable recommendations. Use when you want a status report on QMD, SimpleMem, Hindsight, Apple Notes, Todoist, SQLite, group memory, and the Obsidian vault.
---

# Memory Layer Status Report

Run all checks below and compile into a single report. Execute health checks and stat queries in parallel where possible.

## Phase 1: MCP Service Health Checks

For each MCP service, run a curl health check and record: status (up/down), HTTP status code, and response time.

Run these **in parallel**. For bridge services (Apple Notes / Todoist / Calendar) the public port is a *proxy* in front of a *supergateway* upstream — probe **both** so a dead upstream can't hide behind a healthy proxy-level 401.

```bash
# QMD (port 8181, proxied from 8182)
time curl -s -o /dev/null -w "%{http_code} %{time_total}" http://localhost:8181/health

# SimpleMem (port 8200) — expected DOWN, replaced by Honcho 2026-04-06
time curl -s -o /dev/null -w "%{http_code} %{time_total}" http://localhost:8200/api/health

# Honcho (Docker, port 8010). /openapi.json is a reliable 200 endpoint; /v1/workspaces returns 404 and /health doesn't exist.
time curl -s -o /dev/null -w "%{http_code} %{time_total}" http://localhost:8010/openapi.json

# Hindsight (proxy on 8889 → worker on 8888). 200 on /mcp/hermes/ only proves the proxy is up.
time curl -s -o /dev/null -w "%{http_code} %{time_total}" http://127.0.0.1:8889/mcp/hermes/
lsof -ti -sTCP:LISTEN -i :8888 >/dev/null && echo "Hindsight worker 8888: UP" || echo "Hindsight worker 8888: DEAD"

# Apple Notes — proxy 8184, supergateway upstream 8183
time curl -s -o /dev/null -w "%{http_code} %{time_total}" http://localhost:8184/mcp
lsof -ti -sTCP:LISTEN -i :8183 >/dev/null && echo "Apple Notes upstream 8183: UP" || echo "Apple Notes upstream 8183: DEAD"

# Todoist — proxy 8186, supergateway upstream 8185
time curl -s -o /dev/null -w "%{http_code} %{time_total}" http://localhost:8186/mcp
lsof -ti -sTCP:LISTEN -i :8185 >/dev/null && echo "Todoist upstream 8185: UP" || echo "Todoist upstream 8185: DEAD"

# Calendar — proxy 8188, supergateway upstream 8187
time curl -s -o /dev/null -w "%{http_code} %{time_total}" http://localhost:8188/mcp
lsof -ti -sTCP:LISTEN -i :8187 >/dev/null && echo "Calendar upstream 8187: UP" || echo "Calendar upstream 8187: DEAD"
```

A 401 from a bridge proxy is **healthy** (bearer-auth enforced per the B1 bridge enforcement work) — but only when paired with an `UP` on its upstream port. If upstream is DEAD, kickstart the launchd service (see Recommendations).

Also check Docker containers and launchd services:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>&1
launchctl print gui/$(id -u)/com.qmd-server 2>&1 | head -6
launchctl print gui/$(id -u)/com.qmd-proxy 2>&1 | head -6
launchctl print gui/$(id -u)/com.apple-notes-mcp 2>&1 | head -6
launchctl print gui/$(id -u)/com.todoist-mcp 2>&1 | head -6
launchctl print gui/$(id -u)/com.calendar-mcp 2>&1 | head -6
```

## Phase 2: MCP Service Stats

### QMD
Use the `mcp__plugin_qmd_qmd__status` tool to get:
- Total documents, documents needing embedding
- Collection breakdown (name, doc count)
- Vector index status

### SimpleMem
```bash
# Get health details (includes memory count if available)
curl -s http://localhost:8200/api/health
```
Also try listing memories via MCP if reachable — check Docker logs for recent activity:
```bash
docker logs simplemem --tail 20 2>&1
```

### Hindsight
```bash
docker logs hindsight --tail 20 2>&1
```
Note: Hindsight uses bank "hermes" at `/mcp/hermes/`.

### Apple Notes
```bash
# Check recent logs
tail -10 ~/.cache/apple-notes-mcp/launchd-stderr.log 2>&1
```

### Todoist
```bash
# Check recent logs
tail -10 ~/.cache/todoist-mcp/launchd-stderr.log 2>&1
```

## Phase 3: Local Storage Checks

### SQLite (store/messages.db)
Reference schema from `src/db.ts`. Run these queries:
```bash
sqlite3 store/messages.db "
  SELECT 'db_size_bytes', page_count * page_size FROM pragma_page_count, pragma_page_size;
  SELECT 'messages', COUNT(*) FROM messages;
  SELECT 'chats', COUNT(*) FROM chats;
  SELECT 'sessions_total', COUNT(*) FROM sessions;
  SELECT 'sessions_active', COUNT(*) FROM sessions WHERE last_used > datetime('now', '-2 hours');
  SELECT 'scheduled_tasks', COUNT(*) FROM scheduled_tasks WHERE status = 'active';
  SELECT 'registered_groups', COUNT(*) FROM registered_groups;
  SELECT 'last_message', MAX(timestamp) FROM messages;
  SELECT 'oldest_message', MIN(timestamp) FROM messages;
"
```

### Per-Group Memory
```bash
# Count memory files per group
for dir in groups/telegram_*/; do
  group=$(basename "$dir")
  files=$(find "$dir" -name "*.md" -o -name "*.json" 2>/dev/null | wc -l)
  size=$(du -sh "$dir" 2>/dev/null | cut -f1)
  echo "$group: $files files, $size"
done

# Also check global state files
ls -la groups/global/state/ 2>/dev/null
```

### Obsidian Vault
```bash
# Check mount (resolve symlink — marvin-vault is a symlink to Dropbox path)
VAULT_LINK="/Volumes/sandisk4TB/marvin-vault"
VAULT="$(readlink "$VAULT_LINK" 2>/dev/null || echo "$VAULT_LINK")"
if [ -d "$VAULT" ]; then
  echo "Mounted (resolved: $VAULT)"
  find "$VAULT" -name "*.md" 2>/dev/null | wc -l
  find "$VAULT" -name "*.md" -mmin -60 2>/dev/null | wc -l
  ls -la "$VAULT/.pageindex/" 2>/dev/null | head -5
  du -sh "$VAULT" 2>/dev/null
else
  echo "NOT MOUNTED"
fi
```

## Phase 4: Test Queries

Fire a real query at each reachable MCP service and measure latency. Use simple, fast queries.

### QMD
Use `mcp__plugin_qmd_qmd__query` with:
- searches: `[{type: "lex", query: "nanoclaw"}]`
- intent: "test query for status check"
- limit: 3

Record: number of results, response time.

### SimpleMem
If reachable, test via curl (MCP JSON-RPC over SSE is complex; use Docker logs to confirm recent successful queries instead):
```bash
# Check last successful MCP interaction in logs
docker logs simplemem --tail 50 2>&1 | grep -i "tools/call\|memory\|recall" | tail -5
```

### Hindsight
```bash
docker logs hindsight --tail 50 2>&1 | grep -i "tools/call\|memory\|recall\|remember" | tail -5
```

### Apple Notes
```bash
tail -20 ~/.cache/apple-notes-mcp/launchd-stderr.log 2>&1 | grep -i "tools/call\|search\|list" | tail -5
```

### Todoist
```bash
tail -20 ~/.cache/todoist-mcp/launchd-stderr.log 2>&1 | grep -i "tools/call\|task\|project" | tail -5
```

## Phase 5: Compile Report

Present a single formatted report. Use this exact structure:

```markdown
## Memory Layer Status Report

### MCP Services
| Layer | Status | Latency | Key Stats | Issues |
|---|---|---|---|---|
| QMD | ... | ... | ... | ... |
| SimpleMem | ... | ... | ... | ... |
| Hindsight | ... | ... | ... | ... |
| Apple Notes | ... | ... | ... | ... |
| Todoist | ... | ... | ... | ... |

### Local Storage
| Layer | Status | Key Stats |
|---|---|---|
| SQLite | ... | ... |
| Group Memory | ... | ... |
| Obsidian Vault | ... | ... |

### Test Queries
| Layer | Last Activity | Result |
|---|---|---|
| QMD | (test query result + latency) | ... |
| SimpleMem | (from logs) | ... |
| Hindsight | (from logs) | ... |
| Apple Notes | (from logs) | ... |
| Todoist | (from logs) | ... |

### Recommendations
List any issues found with actionable fix commands. Examples:
- Service down: suggest restart command
- QMD embedding gap: suggest `node $QMD_DIR/dist/cli/qmd.js embed`
- Vault not mounted: warn about missing data
- Stale sessions: note last activity time
- Docker container unhealthy: suggest `docker logs <name> --tail 50`
- JWT token expiry approaching: warn with date

**Calibration — don't chase transient ECONNREFUSED.** The bridge proxies (8184/8186/8188) log `upstream error: connect ECONNREFUSED` whenever a forwarded request arrives during the ~50-200ms window when the supergateway child restarts. Steady-state rate is **~4-10 events/hour per bridge** — this is NOT a service outage; it's a race between the proxy and the restarting child. Only recommend kickstart when the rate spikes sharply (e.g. 50+/hour for many hours) OR when `lsof -ti -sTCP:LISTEN -i :<upstream-port>` returns empty (the upstream is genuinely dead, not just momentarily unreachable). Recommending `launchctl kickstart -k` on a low-rate baseline is a placebo — 2026-04-20 diagnostic session confirmed the supergateways had never crashed despite ~120 ECONNREFUSED events over 28h.

If everything is healthy, say so:
> All 8 memory layers operational. No issues detected.
```

## Reference: Known Quirks

- **QMD proxy**: port 8181 is a TCP proxy to 8182. If proxy fails but QMD is up, check `~/.cache/qmd/proxy.mjs`
- **Bridge proxy / upstream split (Apple Notes / Todoist / Calendar)**: the public port (8184/8186/8188) is a proxy that enforces bearer-auth, with a supergateway upstream on a separate port (8183/8185/8187). A bare `curl` returns **401** from the proxy *even when the upstream is dead* — so the proxy-level check is a necessary-but-not-sufficient signal. Always pair it with `lsof -ti :<upstream>` to confirm the upstream is listening. Seen 2026-04-20: Todoist + Calendar upstreams had died; proxies still returned 401; `launchctl kickstart -k gui/$(id -u)/com.{todoist,calendar}-mcp` brought them back.
- **SimpleMem health**: use `/api/health` not the MCP SSE URL (SSE hangs on GET). NOTE: SimpleMem was replaced by Honcho on 2026-04-06 — expect DOWN.
- **SimpleMem JWT**: token in SIMPLEMEM_URL has an expiry — check `exp` claim (moot post-Honcho)
- **Honcho health endpoint**: no `/health` route; `/v1/workspaces` returns 404 and `/v3/workspaces/list` returns 405. Use `/openapi.json` (reliable 200) or trust `docker ps` `(healthy)` which comes from Honcho's own internal probe
- **QMD embed under Bun**: `$BUN_INSTALL` env var causes `qmd embed` to run under Bun, which lacks sqlite-vec. Run under Node instead: `node /Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/lib/node_modules/@tobilu/qmd/dist/cli/qmd.js embed`
- **Hindsight not in health monitor**: it is NOT in the `mcpEndpoints` array in `src/index.ts` — only checked by this skill
- **Apple Container**: containers are ephemeral, spun up per-message. `container list` showing nothing is normal when idle
- **Vault `.pageindex/`**: created lazily per-directory when PDFs are indexed via Telegram auto-trigger or IPC. Absence is normal — only flag if a specific PDF was expected to be indexed
- **Hindsight**: Python worker (`hindsight-api --host 127.0.0.1 --port 8888`, logs to `/tmp/hindsight.log`) fronted by a resilient Node proxy (`~/.cache/hindsight-proxy/proxy-resilient.mjs` on 0.0.0.0:8889). `lsof -i :8889` returns the **proxy** PID, not the worker. For the worker use `lsof -i :8888` or `pgrep -fl hindsight-api`. A 200 on the proxy URL does not prove the worker is alive — send a JSON-RPC `initialize` to confirm end-to-end reachability.
