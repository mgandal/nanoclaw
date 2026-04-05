# Health Watchdog — Design Spec

**Date:** 2026-04-04
**Status:** Approved
**Approach:** Extend existing health-monitor.ts + external heartbeat script

## Problem

NanoClaw has 5 health/monitoring modules that detect failures but cannot fix them. When services go down (SimpleMem, QMD, Apple Notes, etc.), the system alerts but requires manual intervention. Historical failures include OAuth 401 cascades, orphaned processes holding SQLite locks, port conflicts, and stale launchd jobs.

## Goals

1. Auto-fix known failure patterns with a check-fix-verify cycle
2. Escalate to Telegram after 2 failed fix attempts
3. Detect and recover from NanoClaw process stalls (event loop freeze)
4. Log all actions as structured state-change events
5. Prevent self-healing from making things worse (kill loops, restart storms)

## Non-Goals

- Replacing the existing health infrastructure (layer on top)
- Monitoring services outside NanoClaw's control (e.g., Ollama — alert only, never kill)
- Building a general-purpose monitoring framework

## Architecture

Two-layer system:

### Layer 1: In-Process Auto-Fix (extend `src/health-monitor.ts`)

Add ~80 lines to the existing `HealthMonitor` class:

- `FixHandler` interface: `{ id, match, fixScript, verify, cooldownMs, maxAttempts }`
- `addFixHandler(handler: FixHandler)` — registers a handler
- `attemptFix(service: string, alert: HealthAlert)` — generic executor:
  1. Check cooldown (skip if recently attempted)
  2. Acquire filesystem lock (`~/.nanoclaw/watchdog.lock` with PID + action + timestamp)
  3. Execute fix script via `execFileNoThrow` from `src/utils/execFileNoThrow.ts` (safe, no shell injection)
  4. Run verification check (HTTP endpoint, process check, or command)
  5. If verify passes: log success, clear failure counter, release lock
  6. If verify fails and attempts < maxAttempts: schedule retry
  7. If verify fails and attempts >= maxAttempts: escalate to CODE-claw via existing `onAlert` callback, release lock

Fix handlers are wired in `src/index.ts` after all services initialize, gated by a `startupComplete` flag. Initial health sweep runs with a 60-second grace period for MCP services.

### Layer 2: External Heartbeat (`scripts/watchdog-heartbeat.sh`)

Minimal bash script, run by launchd every 2 minutes:

1. `curl --max-time 5` to NanoClaw health endpoint (piggyback on credential proxy server)
2. If no response (process alive but event loop stalled, or process dead):
   - Check filesystem lock — if Layer 1 is mid-fix, skip this cycle
   - Capture diagnostics: last 50 log lines, port usage, process list
   - Restart via `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
   - Send plain-text Telegram alert via Bot API curl
3. Circuit breaker: 3 restarts in 30 min = stop restarting, send critical alert

Bot token read from `~/.config/nanoclaw/watchdog-bot-token` (not `.env`).

## Fix Pattern Registry

Declarative table wired in `index.ts`:

| ID | Trigger | Fix Script | Verify | Cooldown | Max Attempts |
|---|---|---|---|---|---|
| `oauth-401` | `onAuthFailure` callback from credential-proxy.ts | `refresh-oauth.sh` (existing, add `flock`) | HTTP to credential proxy loopback | 5 min | 2 |
| `mcp-simplemem` | 3 consecutive health check failures | `scripts/fixes/restart-simplemem.sh` | HTTP `:8200/api/health` -> 200 | 2 min | 2 |
| `mcp-qmd` | 3 consecutive failures on `:8181` | `scripts/fixes/restart-qmd.sh` | HTTP `:8181/health` -> 200 | 2 min | 2 |
| `mcp-apple-notes` | 3 consecutive failures on `:8184` | `scripts/fixes/restart-apple-notes.sh` | HTTP `:8184/mcp` -> 405 | 2 min | 2 |
| `mcp-todoist` | 3 consecutive failures on `:8186` | `scripts/fixes/restart-todoist.sh` | HTTP `:8186/mcp` -> 405 | 2 min | 2 |
| `port-conflict` | Service expected on port but wrong process holds it | `scripts/fixes/kill-port-squatter.sh` | Port held by correct process | 5 min | 2 |
| `sqlite-lock` | `SQLITE_BUSY` errors exceeding threshold | `scripts/fixes/kill-sqlite-orphans.sh` | DB write succeeds | 1 min | 2 |
| `container-runtime` | `container system status` fails | `scripts/fixes/restart-container-runtime.sh` | Status check passes | 2 min | 2 |
| `credential-proxy` | Loopback HTTP to proxy returns connection refused | Escalate immediately (cannot self-repair in-process) | N/A | 10 min | 0 |

### Pattern Rules

- **OAuth**: defer to existing `credential-proxy.ts` `onAuthFailure` detection — do NOT independently sniff for 401s
- **Ollama**: NEVER kill — alert only. It serves multiple applications (NanoClaw, Marvin2, direct usage)
- **Docker services** (SimpleMem): use `docker restart`, not process kill
- **launchd services** (QMD, Apple Notes, Todoist): use `launchctl kickstart`, not process kill
- **Port squatters**: MUST verify process identity before killing — match against expected binary name for that port
- **Credential proxy death**: escalate immediately — this is an in-process server that cannot be restarted without restarting NanoClaw itself

## Safety Mechanisms

### Filesystem Lock

Before any fix attempt, Layer 1 writes `~/.nanoclaw/watchdog.lock`:
```json
{"pid": 12345, "action": "restart-simplemem", "started": "2026-04-04T14:32:00Z"}
```
Layer 2 checks this lock before restarting NanoClaw. If lock exists, PID is alive, and lock age < 5 minutes, Layer 2 skips the cycle.

### Circuit Breaker (Layer 2)

State tracked in `~/.nanoclaw/heartbeat-state`:
```json
{"restarts": [{"ts": "2026-04-04T14:30:00Z"}, ...]}
```
If 3+ entries within last 30 minutes: stop restarting, send critical alert "NanoClaw crash-looping, manual intervention required."

### OAuth Race Prevention

`refresh-oauth.sh` gets `flock /tmp/nanoclaw-oauth.lock` added. Both the existing 4-hour launchd job and watchdog-triggered invocations use the same script and therefore the same lock.

### Port Kill Identity Verification

`kill-port-squatter.sh` maintains a port-to-expected-process mapping:
```bash
declare -A EXPECTED=(
  [8181]="qmd"
  [8184]="node"  # supergateway for Apple Notes
  [8186]="node"  # supergateway for Todoist
  [8200]="docker-proxy"
  [8889]="node"  # hindsight
  [8191]="node"  # cognee proxy
)
```
Only kills if the process on the port does NOT match the expected pattern. Logs full command line, PID, and owning user before any kill.

### Recently-Killed Guard

If the watchdog killed a PID on a port and a new PID appears on the same port within 60 seconds, do NOT kill again. Escalate to Telegram instead. Prevents kill-relaunch loops.

## Logging

- **No separate log file.** Use existing pino logger with tag `watchdog`.
- **State-change-only logging.** Log when a service goes DOWN or comes UP, when a fix is attempted, when a fix succeeds or fails, when an escalation is sent. Do NOT log every healthy check result.
- **Expected volume:** 5-20 entries/day under normal operation.
- **Heartbeat script** logs to `logs/watchdog-heartbeat.log` (separate, since it runs outside the process). Simple append, rotate at 1MB.

## Health Endpoint

Add to the existing credential proxy HTTP server in `index.ts` (~10 lines):

```
GET /health -> 200 {"uptime": <seconds>, "startupComplete": <bool>}
```

Layer 2 hits this endpoint. No response within 5 seconds = stalled or dead.

## In-Process Liveness Self-Check

~5 lines in `index.ts`:
```typescript
let lastTick = Date.now();
setInterval(() => { lastTick = Date.now(); }, 5000);
setInterval(() => {
  if (Date.now() - lastTick > 30_000) process.exit(1);
}, 10_000);
```

If the event loop is blocked for >30 seconds, the process exits and launchd `KeepAlive` restarts it. This catches stalls that Layer 2's 2-minute cycle would miss.

## Startup Sequencing

1. Steps 1-8 of existing `main()` unchanged
2. Wire fix handlers to `healthMonitor.addFixHandler(...)` for each pattern
3. Set `startupComplete = true`
4. Run initial health sweep (60-second grace period: only check credential proxy, DB, Telegram connectivity)
5. After grace period: begin full check cycle on existing 60-second interval, now with auto-fix

## Escalation

- Uses existing `onAlert` callback mechanism (already wired to CODE-claw in `index.ts`)
- Alert message includes: service name, failure description, fix attempts made, last error
- No new Telegram group needed — CODE-claw already receives infra alerts

## Files Changed

| File | Change | Est. Lines |
|---|---|---|
| `src/health-monitor.ts` | Add FixHandler registry, attemptFix executor, lock management | +80 |
| `src/health-monitor.test.ts` | Tests for fix handler logic (injectable actions, mock scripts) | +120 |
| `src/index.ts` | Wire fix handlers, health endpoint, liveness check, startupComplete flag | +30 |
| `scripts/fixes/restart-simplemem.sh` | `docker restart simplemem` | +8 |
| `scripts/fixes/restart-qmd.sh` | `launchctl kickstart` QMD server + proxy | +10 |
| `scripts/fixes/restart-apple-notes.sh` | `launchctl kickstart` Apple Notes MCP | +8 |
| `scripts/fixes/restart-todoist.sh` | `launchctl kickstart` Todoist MCP | +8 |
| `scripts/fixes/kill-port-squatter.sh` | Identity-verified port squatter removal | +20 |
| `scripts/fixes/kill-sqlite-orphans.sh` | Kill orphaned `nanoclaw-*` container processes | +15 |
| `scripts/fixes/restart-container-runtime.sh` | `container system start` | +8 |
| `scripts/refresh-oauth.sh` | Add `flock` for race prevention | +2 |
| `scripts/watchdog-heartbeat.sh` | External heartbeat with diagnostics + circuit breaker | +45 |
| `launchd/com.nanoclaw.watchdog.plist` | Heartbeat launchd plist | +25 |
| **Total** | | **~379** |

## Implementation Notes

### Security

- Fix scripts executed via `execFileNoThrow` from `src/utils/execFileNoThrow.ts` — no shell injection risk
- All external actions (kill, restart, alert) injected via an `actions` interface for testability and auditability
- Port squatter kills require process identity verification before execution
- Lock files use atomic write (write to `.tmp`, then `rename`)

### Process Execution

All subprocess calls from TypeScript MUST use `execFileNoThrow` (or `execFile`), never `exec`. This prevents shell injection and is consistent with codebase conventions. Fix scripts are invoked as `execFileNoThrow('/path/to/script.sh', ['--arg'])`.

## Testing Strategy (TDD)

All tests written BEFORE implementation code.

### Unit Tests (`src/health-monitor.test.ts`)

1. **Fix handler registration:** register handler, verify it's stored
2. **Cooldown enforcement:** attempt fix, verify second attempt within cooldown is skipped
3. **Max attempts:** verify escalation fires after maxAttempts failures
4. **Lock management:** verify lock created before fix, released after
5. **Verify step:** mock verify passing -> success logged; mock verify failing -> retry scheduled
6. **State-change logging:** verify log entries only on transitions (up->down, down->up), not on every check
7. **Recently-killed guard:** kill a port squatter, same port reoccupied within 60s -> no second kill, escalation instead

All external actions (`execFileNoThrow`, `fetch`, filesystem ops) injected via an `actions` interface for testability.

### Fix Script Tests

Each script supports `--dry-run` flag that logs what it WOULD do without executing. Integration test:
1. Run script with `--dry-run`
2. Verify output describes correct action
3. Verify no side effects

### Integration Test

1. Mock an MCP endpoint to return connection refused
2. Verify health monitor detects failure after 3 consecutive checks
3. Verify fix handler invoked
4. Mock fix script success -> verify service marked healthy
5. Mock fix script failure x2 -> verify escalation sent to CODE-claw

### Heartbeat Test

1. Start a dummy HTTP server
2. Run heartbeat script against it -> verify no restart
3. Kill the dummy server
4. Run heartbeat script -> verify restart attempted + diagnostics captured
5. Run heartbeat 3 more times -> verify circuit breaker activates

## Review Findings Incorporated

From design critic (P0 items):
- [x] Event loop stall detection via HTTP health endpoint + in-process liveness check
- [x] Race prevention via filesystem lock between Layer 1 and Layer 2
- [x] Restart storm circuit breaker (3 in 30 min)

From token analyst:
- [x] Extend health-monitor.ts instead of new module (68% code reduction)
- [x] State-change-only logging (98% log volume reduction)
- [x] Data-driven pattern registry
- [x] Fix scripts as standalone shell (independently testable)
- [x] No new Telegram group (use CODE-claw)
