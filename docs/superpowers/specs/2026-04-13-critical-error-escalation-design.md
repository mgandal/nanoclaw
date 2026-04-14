# Critical Error Escalation — Design Spec (v2, peer-reviewed)

**Date:** 2026-04-13
**Status:** Peer-reviewed
**Problem:** Critical errors (supergroup migrations, message delivery failures, container OOM) are silently logged but never escalated. Users discover failures hours later by noticing missing responses.

## Decisions

- Alert fallback: OPS-claw → CLAIRE Telegram DM → CLAIRE Slack DM → file
- Supergroup migration: auto-fix with concurrency guard
- Send failures: immediate for structural, threshold for transient, plus global outage detection
- Container OOM (exit 137, non-timeout): immediate alert via direct `onAlert`

## 1. Alert Fallback Chain

**File:** `src/index.ts` (modify `sendSystemAlert`)

Current `sendSystemAlert` sends to OPS-claw only. If OPS-claw's channel is broken, the alert vanishes via `.catch(() => {})`.

### Change

Replace the single-target send with a fallback chain:

```
1. Try OPS-claw (existing behavior)
2. If send throws → try CLAIRE Telegram DM (tg:8475020901)
3. If that throws → try CLAIRE Slack DM (slack:D0AQ09RSF1B)
4. If all fail → appendFileSync to store/critical-alerts.log
```

**Ordering rationale (from review):** Telegram DM before Slack DM because partial Telegram failures (OPS-claw group migrated, bot kicked) are more common than full Telegram outages. The CLAIRE DM will succeed when OPS-claw specifically fails.

### Fallback JID resolution

The CLAIRE Telegram DM is resolved by finding the first `isMain: true` group on the `tg:` channel. The CLAIRE Slack DM is hardcoded as `slack:D0AQ09RSF1B` — there is no `isMain` Slack group in the registry, so `isMain` lookup does not work for Slack. A config constant `ESCALATION_SLACK_JID` is cleaner than hardcoding inline.

### Re-entrancy guard (from review)

Add a module-level `isSendingAlert` boolean. Set to `true` before the chain starts, `false` after. If `sendSystemAlert` is called while `isSendingAlert` is true, skip directly to the file fallback. This prevents infinite loops if an alert about Telegram failure triggers a send via Telegram.

### Startup safety (from review)

During startup, `channels` may be empty (channels connect after `sendSystemAlert` is wired). Each fallback step must handle `findChannel()` returning null gracefully — skip to the next fallback. The file fallback uses `appendFileSync` (blocking, guaranteed write) and does not depend on `channels`.

## 2. Supergroup Auto-Migration

**Files:** `src/channels/telegram.ts` (modify `sendMessage` and `sendPoolMessage`)

When Telegram returns error 400 with `migrate_to_chat_id` in the response parameters, the group has been upgraded to a supergroup. The old chat ID is permanently invalid.

### Change

In both `sendMessage` and `sendPoolMessage`, catch this specific error:

```typescript
// Grammy wraps Telegram errors as GrammyError with .payload
const params = (err as GrammyError).parameters;
if (errorCode === 400 && params?.migrate_to_chat_id) {
  const newChatId = params.migrate_to_chat_id;
  await onMigrate(oldJid, `tg:${newChatId}`);
  // Retry send with new ID
  await sendTelegramMessage(api, String(newChatId), text);
  return;
}
```

**Grammy error shape (from review):** `migrate_to_chat_id` is in `err.parameters` (GrammyError), not the error message string. Must cast to GrammyError to access it.

### Concurrency guard (from review)

Add a module-level `migratingJids: Set<string>` in `telegram.ts`. Before calling `onMigrate`, check if the old JID is already in the set. If so, wait briefly and retry with the new ID (another concurrent send is already migrating). This prevents double-migration when multiple containers send to the same group simultaneously.

### The `onMigrate` callback

Passed through `TelegramChannelOpts` and wired in `index.ts`. It:
1. Updates `registered_groups` in the DB (change JID, keep everything else)
2. Updates the in-memory `registeredGroups` map
3. Updates `router_state.last_agent_seq` (swap old key for new)
4. Updates `chats` table (delete old if new already exists)
5. Updates `scheduled_tasks.chat_jid` (was missing in v1 — from review)
6. Calls `sendSystemAlert` to notify: "Auto-migrated {groupName} from {old} to {new}"

**Messages table (from review):** Do NOT backfill old message JIDs. Historical messages remain queryable by old JID and are not used for routing. The composite primary key with FK to chats makes bulk updates risky.

### Edge cases

- If retry with new ID fails with 403 (bot kicked from new supergroup): alert and drop, don't loop. The migration DB update is recorded either way.
- Bot is automatically carried over to the supergroup by Telegram — no manual re-add needed.

## 3. Tiered Message Delivery Escalation

**File:** `src/channels/telegram.ts` (modify `sendMessage`)

### Error classification

**Structural (alert immediately):**
- 400 `chat not found` (after migration attempt)
- 400 `bot was blocked by the user`
- 401 `unauthorized` / auth errors
- 403 `bot was kicked from the group chat`
- Any error where the group registration is fundamentally broken

**Transient (alert after threshold):**
- 429 `too many requests` (rate limit)
- 5xx server errors
- Network/timeout errors
- Any unrecognized error code

### Per-group tracker

A `sendFailureTracker` Map keyed by JID, value is `{ count: number, firstSeen: number }`. On each transient failure:
- Increment count for that JID
- If count >= 3 and `firstSeen` within last 10 minutes → alert
- If `firstSeen` older than 10 minutes → reset counter

### Global outage tracker (from review)

A parallel `globalFailureTracker: { jids: Set<string>, firstSeen: number }`. On each transient failure (any group):
- Add JID to the set
- If 3+ distinct JIDs have failed within 10 minutes → alert: "Telegram API outage: {count} groups affected"
- Reset after alert or after 10-minute window expires

This catches Telegram-wide outages where no single group hits the per-group threshold.

### Alert format

```
⚠️ *Telegram*: Failed to send message to {groupName} ({jid})
Error: {errorMessage}
{if structural: "Configuration error — messages will continue failing until fixed."}
{if transient: "{count} failures in {minutes}m — possible Telegram API issue."}
{if global outage: "Telegram API outage: {count} groups affected in {minutes}m."}
```

### Callback

Pass an `onSendFailure` callback through `TelegramChannelOpts`, wired in `index.ts` to call `sendSystemAlert`. This keeps `telegram.ts` decoupled from the alert system.

## 4. Container Failure Recording + OOM Alert

**File:** `src/container-runner.ts` (modify container exit handling)

### Change 1: Add `exitCode` to ContainerOutput (from review)

Add `exitCode?: number` to the `ContainerOutput` interface. Set it in both the streaming and legacy exit handlers. This lets the caller in `index.ts` inspect the exit code after `await runContainerAgent(...)` without callback proliferation — consistent with the existing return-value pattern.

### Change 2: Record non-zero exits in health monitor

In `index.ts`, after `runContainerAgent` returns, check `output.exitCode`. If non-zero, call `healthMonitor.recordError(group.folder)` so failures count toward the group's error rate threshold.

**Health monitor API (from review):** There is no generic `recordEvent`. Use `recordError(group)` for non-OOM exits (feeds the existing excessive_errors threshold). Do not use `recordInfraEvent` (wrong semantics — that's for external services like Hindsight).

### Change 3: Immediate OOM alert

Exit code 137 = SIGKILL (128 + 9). But the container runner itself sends SIGKILL on timeout.

**Timeout guard (from review):** The existing code sets `timedOut = true` before killing. OOM detection must check `!timedOut && exitCode === 137`. Without this guard, normal timeouts would false-alert as OOM.

In `index.ts`, after `runContainerAgent`:

```typescript
if (output.exitCode === 137 && !output.timedOut) {
  sendSystemAlert('Container OOM', `${group.name} killed (exit 137). Task too large for container memory.`);
}
```

Add `timedOut?: boolean` to `ContainerOutput` alongside `exitCode`.

### Not included

- No automatic retry for OOM (it will OOM again)
- No container memory increase (manual config decision)
- Exit 1 and other non-137 codes just feed `recordError` threshold — no individual alert

## File Change Summary

| File | Changes |
|------|---------|
| `src/index.ts` | Modify `sendSystemAlert` fallback chain + re-entrancy guard; wire `onMigrate`, `onSendFailure` callbacks; check `exitCode`/`timedOut` after container runs |
| `src/channels/telegram.ts` | Add migration detection (both sendMessage and sendPoolMessage) + `migratingJids` guard; add error classifier + per-group + global failure trackers; add `onMigrate` and `onSendFailure` to opts |
| `src/container-runner.ts` | Add `exitCode` and `timedOut` to `ContainerOutput`; set in both streaming and legacy exit paths |
| `src/channels/registry.ts` | Add `onMigrate` and `onSendFailure` to `ChannelOpts` interface |
| `src/types.ts` | (if ContainerOutput lives here) Add `exitCode?: number` and `timedOut?: boolean` |

## Testing

- `sendSystemAlert` fallback: mock OPS-claw send to throw, verify CLAIRE Telegram DM is tried
- `sendSystemAlert` re-entrancy: call sendSystemAlert from within a fallback, verify file fallback (no loop)
- `sendSystemAlert` during startup: call before channels connected, verify file fallback
- Supergroup migration: mock Grammy error 400 with `parameters.migrate_to_chat_id`, verify DB update + retry
- Migration concurrency: two concurrent sends trigger migration, verify only one `onMigrate` call
- Migration includes scheduled_tasks: verify `scheduled_tasks.chat_jid` updated
- Structural error alert: mock 403 on sendMessage, verify immediate alert
- Transient threshold: mock 3x 429 errors to same group, verify alert on third
- Global outage: mock 1x failure to 3 different groups, verify outage alert
- OOM alert: mock container exit 137 with `timedOut: false`, verify immediate alert
- Timeout exit 137: mock container exit 137 with `timedOut: true`, verify NO OOM alert
- Health monitor recording: mock container exit 1, verify `recordError` called
