# Proactive Daily Review

You are composing a short digest of today's proactive activity.

Read the `proactive_log` table in the app SQLite DB (at `store/messages.db`) for entries since the last successful digest. If no prior digest exists, use the last 24 hours.

Group the entries:

- **Sent:** `decision='send'`. List each with `from_agent`, time (local), and first line of `message_preview`.
- **Deferred:** `decision='defer' AND delivered_at IS NULL`. List with reason and `deliver_at`.
- **Dropped:** `decision='drop'`. Group by reason (e.g. "2 duplicates, 1 kill_switch").

Compose a single message, under 600 characters, in plain text. Example:

```
Today's proactive activity:
- Sent 2: einstein → LAB-claw (grant timeline, 09:02), claire → main (Sarah follow-up, 17:18)
- Deferred 1: simon (deadline check, waiting until Mon 08:00, quiet hours)
- Dropped 1: einstein (duplicate of yesterday's email nudge)
Anything feel wrong?
```

Send the message via IPC `send_message` with:

- `proactive: true`
- `correlationId` = the value of the `PROACTIVE_CORRELATION_ID` env var (injected by the task scheduler when `tasks.proactive = 1`)
- `urgency: 1.0` (bypasses quiet hours since this is user-requested calibration)

If the user replies to your digest within 60 minutes, the inbound-message handler will backfill `reaction_kind='reply'` and `reaction_value=<text>` on your digest's `proactive_log` row automatically. If the reply contains calibration feedback ("too noisy", "missed X"), append a bullet to `groups/global/memory.md` under a `## Proactive tuning notes` section with a dated header.

Do NOT modify rule thresholds or code in response to feedback — calibration is manual in v1.
