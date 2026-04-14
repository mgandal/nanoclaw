# Critical Error Escalation — Design Spec

**Date:** 2026-04-13
**Status:** Draft
**Problem:** Critical errors (supergroup migrations, message delivery failures, container OOM) are silently logged but never escalated. Users discover failures hours later by noticing missing responses.

## Decisions

- Alert fallback: OPS-claw → CLAIRE Slack DM → CLAIRE Telegram DM → file
- Supergroup migration: auto-fix (Telegram provides new chat ID in error response)
- Send failures: immediate alert for structural errors, threshold (3 in 10min) for transient
- Container OOM (exit 137): immediate dedicated alert, plus record in health monitor

## 1. Alert Fallback Chain

**File:** `src/index.ts` (modify `sendSystemAlert`)

Current `sendSystemAlert` sends to OPS-claw only. If OPS-claw's channel is broken (supergroup migration, Telegram down), the alert vanishes via `.catch(() => {})`.

### Change

Replace the single-target send with a fallback chain:

```
1. Try OPS-claw (existing behavior)
2. If send throws → try CLAIRE Slack DM (slack:D0AQ09RSF1B)
3. If that throws → try CLAIRE Telegram DM (tg:8475020901)
4. If all fail → append to store/critical-alerts.log
```

The fallback targets are resolved the same way as OPS-claw: look up the JID in `registeredGroups`, find the channel, call `sendMessage`. The file fallback is a plain `fs.appendFileSync` with ISO timestamp + message.

The function signature stays the same. No caller changes needed.

### Fallback JID resolution

The CLAIRE DM JIDs are identified by `isMain: true` in the registered groups. The fallback logic finds the first `isMain` group on each channel type (Slack, then Telegram). This avoids hardcoding JIDs.

## 2. Supergroup Auto-Migration

**File:** `src/channels/telegram.ts` (modify `sendMessage` and `sendPoolMessage`)

When Telegram returns error 400 with `migrate_to_chat_id` in the response parameters, the group has been upgraded to a supergroup. The old chat ID is permanently invalid.

### Change

In `sendMessage` and `sendPoolMessage`, catch this specific error:

```typescript
if (errorCode === 400 && params?.migrate_to_chat_id) {
  const newChatId = params.migrate_to_chat_id;
  // Callback to update host-side state
  await onMigrate(oldJid, `tg:${newChatId}`);
  // Retry send with new ID
  await sendTelegramMessage(api, String(newChatId), text);
  return;
}
```

The `onMigrate` callback is passed through `TelegramChannelOpts` and wired in `index.ts`. It:
1. Updates `registered_groups` in the DB (change JID, keep everything else)
2. Updates the in-memory `registeredGroups` map
3. Updates `router_state.last_agent_seq` (swap old key for new)
4. Updates `chats` table
5. Calls `sendSystemAlert` to notify: "Auto-migrated {groupName} from {old} to {new}"

### Edge case

If the retry with the new ID also fails, don't loop — alert and let it fail. The migration is recorded either way.

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

### Implementation

Add a `sendFailureTracker` — a Map keyed by JID, value is `{ count: number, firstSeen: number }`. On each transient failure:
- Increment count for that JID
- If count >= 3 and `firstSeen` was within the last 10 minutes → alert OPS-claw
- If `firstSeen` is older than 10 minutes → reset counter (the old failures were isolated)

On structural failure: alert immediately regardless of counter.

The tracker lives in module scope in `telegram.ts`. No persistence needed — it resets on restart, which is fine (if the process restarted, the transient issue likely resolved too).

### Alert format

```
⚠️ *Telegram*: Failed to send message to {groupName} ({jid})
Error: {errorMessage}
{if structural: "This is a configuration error — messages will continue failing until fixed."}
{if transient: "3 failures in {minutes}m — possible Telegram API issue."}
```

### Callback

`sendMessage` needs access to `sendSystemAlert`. Pass an `onSendFailure` callback through `TelegramChannelOpts`, wired in `index.ts` to call `sendSystemAlert`. This keeps `telegram.ts` decoupled from the alert system.

## 4. Container Failure Recording + OOM Alert

**File:** `src/container-runner.ts` (modify container exit handling)

### Change 1: Record all non-zero exits in health monitor

After a container exits with code != 0, call the health monitor's `recordEvent` so failures count toward the group's error rate threshold. This requires passing the health monitor (or a callback) into the container runner.

Add an `onContainerError` callback to `runContainerAgent`'s dependencies:

```typescript
onContainerError?: (group: string, exitCode: number, stderr: string) => void;
```

Wired in `index.ts` to call `healthMonitor.recordEvent(group, 'container_error', ...)`.

### Change 2: Immediate OOM alert

Exit code 137 specifically means the kernel OOM-killed the process. This is never transient — the task is structurally too large. On exit 137:

```typescript
if (exitCode === 137) {
  onOomAlert?.(group.name, group.folder);
}
```

Wired to `sendSystemAlert`:

```
⚠️ *Container OOM*: {groupName} task killed (exit 137)
Container exceeded memory limit. This task is too large for the current container config.
```

### Not included

- No automatic retry for OOM (it will OOM again)
- No container memory increase (that's a manual config decision)
- Exit 1 and other codes are just recorded in health monitor, not individually alerted — the threshold system handles repeated failures

## File Change Summary

| File | Changes |
|------|---------|
| `src/index.ts` | Modify `sendSystemAlert` fallback chain; wire `onMigrate`, `onSendFailure`, `onContainerError`, `onOomAlert` callbacks |
| `src/channels/telegram.ts` | Add migration detection + retry; add error classifier + failure tracker; add `onMigrate` and `onSendFailure` to opts |
| `src/container-runner.ts` | Record non-zero exits via callback; immediate alert on exit 137 |
| `src/channels/registry.ts` | Add `onMigrate` and `onSendFailure` to `ChannelOpts` interface |

## Testing

- `sendSystemAlert` fallback: mock OPS-claw send to throw, verify CLAIRE DM is tried
- Supergroup migration: mock Telegram 400 with `migrate_to_chat_id`, verify DB update + retry
- Structural error alert: mock 403 on sendMessage, verify immediate alert
- Transient threshold: mock 3x 429 errors, verify alert on third
- OOM alert: mock container exit 137, verify immediate alert
- Health monitor recording: mock container exit 1, verify `recordEvent` called
