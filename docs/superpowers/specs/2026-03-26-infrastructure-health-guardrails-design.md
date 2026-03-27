# Infrastructure Health Guardrails

**Date:** 2026-03-26
**Status:** Approved

## Problem

Infrastructure failures (expired OAuth tokens, unreachable MCP services, auth proxy issues) fail silently — spamming logs without alerting the user or backing off. The user discovered the Gmail watcher had been failing every 60s for weeks.

## Solution

Tests to verify fixes, runtime guardrails for proactive detection, and alert delivery to CODE-claw + CLAIRE digests.

## Architecture

### System Alert Utility (`src/system-alerts.ts`)

Central module for infrastructure alerts. Handles:
- Sending immediate Telegram alerts to specified groups via `channel.sendMessage`
- Logging at `logger.error` with `tag: 'SYSTEM_ALERT'`
- Persisting alerts to `data/system-alerts.json` for digest consumption
- 24h auto-expiry on cleanup

```typescript
interface SystemAlert {
  id: string;
  timestamp: string;
  service: string;       // 'gmail', 'mcp:QMD', 'credential-proxy'
  message: string;
  fixInstructions?: string;
  resolved?: boolean;
}

// Called from index.ts (has closure over channels + registeredGroups)
function sendSystemAlert(message: string, targetFolders: string[]): Promise<void>

// Durable persistence for digest integration
function appendAlert(alert: Omit<SystemAlert, 'id'>): void
function getUnresolvedAlerts(): SystemAlert[]
function resolveAlert(id: string): void
function cleanupAlerts(): void  // removes alerts older than 24h
```

### MCP Health Check (`src/health-check.ts`)

Extracted from `checkMcpEndpoints()` in index.ts. Pure function that:
- Makes HTTP GET with `Accept: application/json, text/event-stream` header
- Calls `res.resume()` to drain response
- Returns `{reachable: boolean, statusCode?: number}` on any HTTP response
- Returns `{reachable: false}` on connection error or timeout

Moved from startup-time (race condition with channels) into HealthMonitor's periodic sweep.

### Gmail Watcher Backoff

Add to `GmailWatcherConfig`:
```typescript
onAuthFailure?: (error: string) => void;
```

In poll() catch block:
- Detect `invalid_grant` specifically (check error message or code)
- Increment `authFailureCount`
- Backoff schedule: 1min, 5min, 30min, then stop polling
- First failure: call `onAuthFailure` with fix instructions
- Log at ERROR with SYSTEM_ALERT tag

### Credential Proxy Failure Tracking

Add to `startCredentialProxy` signature:
```typescript
onAuthFailure?: (statusCode: number) => void;
```

- Track consecutive 401/403 responses from upstream
- After 3 consecutive: call `onAuthFailure`
- Reset counter on any successful response
- Validate `oauthToken` at startup, log error if undefined

### HealthMonitor Extension

Add `'infra_error'` to `HealthAlert.type` union. Add:
```typescript
recordInfraEvent(service: string, message: string): void
```

Uses existing dedup Map and 10-minute cooldown. MCP checks run in the periodic `checkThresholds()` sweep.

### Digest Integration

- Alerts persisted to `data/system-alerts.json` (append-only, 24h expiry)
- CLAIRE's CLAUDE.md updated: "When composing digests, check `/workspace/project/data/system-alerts.json` for unresolved infrastructure alerts"

## Tests

| File | Coverage |
|------|----------|
| `src/health-check.test.ts` | Accept header, res.resume, any status = reachable, connection error = unreachable |
| `src/watchers/gmail-watcher.test.ts` | Bare token + gcp-oauth.keys.json loading, standard format, missing both = error, backoff + callback on invalid_grant |
| `src/watchers/calendar-watcher.test.ts` | detectConflicts: missing start/end filtered, normal conflicts detected |
| `src/db.test.ts` | registered_groups round-trip: insert, read, all columns match |
| `src/system-alerts.test.ts` | appendAlert, getUnresolved, resolveAlert, cleanupAlerts (24h expiry) |

## Files

| File | Action |
|------|--------|
| `src/system-alerts.ts` | New |
| `src/system-alerts.test.ts` | New |
| `src/health-check.ts` | New (extracted from index.ts) |
| `src/health-check.test.ts` | New |
| `src/watchers/gmail-watcher.ts` | Modify — onAuthFailure callback, backoff |
| `src/watchers/gmail-watcher.test.ts` | New |
| `src/watchers/calendar-watcher.test.ts` | New |
| `src/db.test.ts` | New |
| `src/credential-proxy.ts` | Modify — onAuthFailure callback, failure tracking, startup validation |
| `src/index.ts` | Modify — wire callbacks, replace checkMcpEndpoints, move to HealthMonitor |
| `src/health-monitor.ts` | Modify — add infra_error type + recordInfraEvent |
| `groups/telegram_claire/CLAUDE.md` | Modify — digest instruction |
