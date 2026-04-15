# Ops Routing Guardrails, Slack Resilience, Cross-Group Messaging

**Date:** 2026-04-13
**Status:** Approved
**Scope:** Three independent workstreams consolidated into one spec

---

## Problem Statement

Three related issues with NanoClaw's messaging infrastructure:

1. **Ops noise leaks to working groups.** Operational alerts (health monitor, auth failures, task failures) were hardcoded to route to CODE-claw and the main CLAIRE group. We've already re-routed them to OPS-claw, but there are no guardrails preventing future code from re-introducing the problem.

2. **Slack connection failures crash NanoClaw.** The Slack channel's `app.start()` call has no error handling. A transient Slack API failure during startup crashes the entire process, causing Telegram errors and service restarts.

3. **Groups can't share relevant findings.** The message bus works but VAULT-claw (and other groups) must hardcode recipient groups per message. No routing guidance exists for agents to know where to send cross-group information.

---

## Workstream 1: Ops Alert Guardrails

### Goal

Prevent operational noise from ever leaking back to non-ops groups through three layers of defense.

### Design

#### Layer 1: Constrain `sendSystemAlert()` signature

Remove the `targetFolders` parameter from `sendSystemAlert()`. The function always sends to `OPS_ALERT_FOLDER`. No caller can accidentally route alerts elsewhere.

**Before:**
```typescript
async function sendSystemAlert(
  service: string,
  message: string,
  targetFolders: string[],
  fixInstructions?: string,
): Promise<void>
```

**After:**
```typescript
async function sendSystemAlert(
  service: string,
  message: string,
  fixInstructions?: string,
): Promise<void>
```

The function resolves `OPS_ALERT_FOLDER` internally. All 4 call sites in `index.ts` and the task scheduler's `flushAlerts` are updated.

#### Layer 2: Routing tests

New test file `src/alert-routing.test.ts`:

- Verify `sendSystemAlert` only sends to the OPS-claw group JID
- Verify health monitor `onAlert` callback calls `sendSystemAlert` (not raw `sendMessage` to main)
- Verify task scheduler `flushAlerts` sends to OPS-claw JID
- Negative test: no message sent to main group JID for any system alert type
- Test all alert types: `excessive_spawns`, `excessive_errors`, `infra_error`, `fix_escalation`

#### Layer 3: Pre-commit grep guardrail

Add a check to `.husky/pre-commit` that fails if any staged `.ts` file (excluding `*.test.ts` and `config.ts`) contains a hardcoded `telegram_` group folder string in a `sendMessage` call context. This catches future code that bypasses `sendSystemAlert`.

Pattern: grep for string literals matching `'telegram_[a-z]+-?[a-z]*'` in non-test, non-config `.ts` files. Exclude `container-runner.ts` (has legitimate vault-claw special handling).

### Files Modified

- `src/index.ts` — simplify `sendSystemAlert` signature, update 4 call sites
- `src/task-scheduler.ts` — verify `flushAlerts` uses OPS_ALERT_FOLDER (already done)
- `src/alert-routing.test.ts` — new test file
- `.husky/pre-commit` — add grep guardrail

---

## Workstream 2: Slack Connection Resilience

### Goal

Slack connection failures don't crash NanoClaw. Retry with backoff on startup, then degrade gracefully with background reconnection.

### Design

#### Critical constraint: Bolt SDK requires fresh App instance per retry

Bolt's Socket Mode creates internal WebSocket state that doesn't cleanly reset on failure. Each retry and each background reconnect must create a new `App` instance. The `App` constructor and event handler setup are factored into a private `createApp()` method.

#### Startup: retry then degrade

```
connect():
  for attempt 1..3 (backoff: 2s, 4s, 8s):
    this.app = this.createApp()          // fresh instance each time
    try:
      await this.app.start()
      resolve botUserId, syncMetadata
      this.connected = true
      return
    catch:
      await this.app.stop()              // clean up half-open socket
      if auth error → alert OPS, stop retrying immediately
      log warning, wait backoff

  all retries failed → alert OPS, start background reconnect timer
```

#### Background reconnection

- `setInterval(60_000)` stored as `this.reconnectTimer`
- Guard flag `this.reconnecting` prevents overlapping attempts
- On success: `clearInterval(this.reconnectTimer)`, `connected = true`, flush queue
- On auth error (`invalid_auth`, `token_revoked`): clear timer, alert OPS, stop forever
- Timer cleared in `disconnect()`

#### Queue overflow protection

- `MAX_QUEUE_SIZE = 100` — drop oldest message on overflow with warning log
- Queue is in-memory only (lost on restart — acceptable for personal assistant)

#### Alert routing

- Add optional `onAlert?: (message: string) => void` to `ChannelOpts`
- Wire in `index.ts` to call `sendSystemAlert('Slack', msg)` (uses constrained signature from Workstream 1)
- Slack channel calls `this.opts.onAlert?.(message)` on connection failures

#### Channel initialization in index.ts

Channel init loop wraps `connect()` in try-catch. On failure, channel stays in `channels[]` with `connected = false`. Startup continues with remaining channels.

#### Utility function

Extract retry logic into a reusable `withRetry()` utility:
```typescript
// src/channels/reconnect.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
): Promise<T>
```

Slack channel uses it internally. Available for other channels if needed in future.

### Files Modified

- `src/channels/slack.ts` — `createApp()` method, retry in `connect()`, reconnection timer, queue cap
- `src/channels/reconnect.ts` — new file, `withRetry()` utility
- `src/channels/registry.ts` — add `onAlert?` to `ChannelOpts`
- `src/index.ts` — wire `onAlert` callback, wrap channel init in try-catch

### Files NOT modified

- Channel interface (`Channel` type) stays the same
- `src/channels/telegram.ts` — Grammy has its own internal reconnection; don't double-wrap
- `src/router.ts` — `routeOutbound` is not used for Slack message paths (verified: all Slack outbound goes through `channel.sendMessage()` directly)

---

## Workstream 3: Cross-Group Message Routing

### Goal

Groups can share relevant findings with the right groups without hardcoding recipients. Zero infrastructure changes — routing intelligence lives in agent instructions.

### Design

#### Routing table in group CLAUDE.md files

Add a routing table to `groups/telegram_vault-claw/CLAUDE.md` that tells the agent where to send findings by topic:

```markdown
## Cross-Group Routing

When you discover or curate something relevant, publish it to the bus
with the appropriate `action_needed` group. Use this routing guide:

| Topic | Route to | Examples |
|-------|----------|---------|
| Papers, preprints, genomics, transcriptomics | telegram_science-claw | New GWAS paper, competing lab preprint |
| Pipeline tools, bioinformatics software, code patterns | telegram_code-claw | New single-cell tool, Snakemake pattern |
| Grant deadlines, funding opportunities, collaboration leads | telegram_lab-claw | R01 resubmission reminder, new RFA |
| Infrastructure, service status, NanoClaw changes | telegram_ops-claw | QMD index update, sync pipeline change |
| Urgent or cross-cutting (touches 2+ domains) | telegram_claire | Time-sensitive, needs Mike's judgment |

For items relevant to multiple groups, publish once per group.
```

#### Bus awareness in all groups

Each group's CLAUDE.md gets a brief addition:

- "Check your bus queue (`bus_read`) at the start of each session for messages from other groups"
- The same routing table so any group can forward findings to the right destination
- Instruction to use `bus_publish` with `action_needed` for cross-group sharing

#### Groups receiving the routing table

- `groups/telegram_vault-claw/CLAUDE.md` — full table (primary publisher)
- `groups/telegram_science-claw/CLAUDE.md` — full table + bus_read instruction
- `groups/telegram_code-claw/CLAUDE.md` — full table + bus_read instruction
- `groups/telegram_lab-claw/CLAUDE.md` — full table + bus_read instruction
- `groups/global/CLAUDE.md` — bus_read instruction (Claire already has bus access)

### What this doesn't solve (intentionally deferred)

- No automatic topic subscription/discovery — agents follow routing table manually
- No delivery confirmation — if a group ignores a bus message, nobody knows
- No message search beyond 72h retention in `data/bus/done/`
- No fanout infrastructure — agents must call `bus_publish` once per recipient

These gaps are intentionally deferred. The routing table lets us observe what patterns emerge before building infrastructure.

### Files Modified

- `groups/telegram_vault-claw/CLAUDE.md` — add routing table
- `groups/telegram_science-claw/CLAUDE.md` — add routing table + bus_read
- `groups/telegram_code-claw/CLAUDE.md` — add routing table + bus_read
- `groups/telegram_lab-claw/CLAUDE.md` — add routing table + bus_read
- `groups/global/CLAUDE.md` — add bus_read instruction

---

## Implementation Order

1. **Workstream 1 (Guardrails)** first — constrains `sendSystemAlert`, adds tests. Foundation for Workstream 2's alert routing.
2. **Workstream 2 (Slack)** second — depends on constrained `sendSystemAlert` and `onAlert` callback.
3. **Workstream 3 (Cross-group)** third — independent, instruction-only changes. Can be done in parallel with 1 or 2.

## Testing Strategy

- **Workstream 1:** Unit tests in `alert-routing.test.ts`. Pre-commit hook verified manually.
- **Workstream 2:** Unit tests for `withRetry()`. Manual testing of Slack connect/disconnect/reconnect cycle. Verify OPS-claw receives alerts on failure.
- **Workstream 3:** Manual verification that VAULT-claw publishes correctly and target groups see bus messages in context.
