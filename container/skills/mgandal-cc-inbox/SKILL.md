---
name: mgandal-cc-inbox
description: Process BCC'd emails from mgandal+cc@gmail.com. Ported from Hermes hermes-inbox-monitor. Classifies into Calendar / Action / Knowledge / Unclear and drafts downstream work. Reports go to OPS-claw (never CLAIRE).
allowed-tools: Bash(python3:*), Read, mcp__gmail__search_emails, mcp__gmail__read_email, mcp__gmail__modify_email, mcp__google-workspace__manage_event, mcp__hindsight__retain, mcp__nanoclaw__send_message
---

# mgandal-cc-inbox

Mike BCCs emails from his Penn Outlook to **mgandal+cc@gmail.com** so NanoClaw can process them (Penn Outlook blocks auto-forwarding rules — BCC is the only path).

**Routing rule (hard):** report output and any error/auth-failure message goes to OPS-claw (`tg:-1003829244894`), never the DM or CLAIRE. Operational noise belongs in OPS-claw per Claire's group CLAUDE.md.

## When

Scheduled task runs every 30 min, 9:30 AM–5:30 PM weekdays (`30,0 9-17 * * 1-5`). Can also run manually: "Load mgandal-cc-inbox and process the inbox."

## Step 1 — Fetch unread

Use the Gmail MCP:

```
mcp__gmail__search_emails(query="to:mgandal+cc@gmail.com is:unread", maxResults=20)
```

If no unread emails, stop silently — do NOT send a message.

## Step 2 — Pre-classify with Python helper

For each email, call the deterministic classifier before LLM reasoning. The helper covers obvious cases and saves tokens:

```bash
python3 -c '
import json, sys
sys.path.insert(0, "/workspace/project/scripts/lib")
from mgandal_cc_classify import classify
email = json.loads(sys.stdin.read())
print(classify(email))
' <<EOF
{"subject": "...", "from": "...", "body": "..."}
EOF
```

Returns `A` / `B` / `C` / `D`. Use the label as the starting point; override only if you have strong evidence the pre-pass got it wrong.

## Step 3 — Process by type

### Type A — Calendar event
Extract title, start/end, location, attendees. Create on MJG calendar:

```
mcp__google-workspace__manage_event(
  action="create",
  calendar_id="mgandal@gmail.com",
  summary="...",
  start="2026-04-22T15:00:00-04:00",
  end="2026-04-22T16:00:00-04:00",
  location="...",
  attendees=[...]
)
```

Then mark the email read via `mcp__gmail__modify_email(remove_labels=["UNREAD"])`.

### Type B — Action instruction
Mike's directive is always the first non-header line. Map to action:
- `draft reply` / `draft response` → draft email (NEVER auto-send)
- `draft decline` → polite decline draft
- `schedule follow-up` → calendar event or reminder
- `add to tasks` → Todoist via MCP
- `fyi` → `mcp__hindsight__retain(...)` and mark read
- `save` / `save to` → persist to QMD or vault

Draft sender defaults:
- Work (Penn threads) → `michael.gandal@pennmedicine.upenn.edu`
- Personal → `mgandal@gmail.com`

Mark read after the action completes.

### Type C — Knowledge
- PDFs → parse with pdftotext or liteparse, route to QMD vault or Obsidian
- Facts worth remembering → `mcp__hindsight__retain`
- Structured references → vault markdown

Mark read after save.

### Type D — Unclear
Flag as "NEEDS REVIEW" in the OPS-claw report. **Do NOT mark read** — Mike will see it's still unread.

## Step 4 — Report to OPS-claw

Only if at least one email was processed or flagged for review:

```
mcp__nanoclaw__send_message(
  target_group_jid="tg:-1003829244894",
  text="...report..."
)
```

Format:

```
📧 INBOX-CC — [N] processed

✅ Calendar: "Meeting with Raquel" added Mon 3pm
✅ Draft: Decline to seminar invite (saved as draft)
✅ Knowledge: PDF "GWAS methods review" → QMD
⚠️ NEEDS REVIEW: Fwd from Lucinda — unclear instruction
```

## Error handling

Any Gmail / Calendar auth failure, 401, or revoked-token message → send to OPS-claw with `❗ INBOX-CC auth failure:` prefix. Do NOT fall back to the DM / CLAIRE. If `send_message` itself fails, suppress rather than retry on a different target.

## Pitfalls (inherited from Hermes version)

- **Unread ≠ needs response** — check sent mail first; an unread email may be a reply to a thread Mike already handled.
- **Never auto-send** — all outgoing email is draft-only, always.
- **BCC means no `FW:` prefix** — the email arrives as a direct recipient, not a forward. Parse accordingly.
- **Directives are at the top** — above any forwarded content, usually one short line.
- **Attachments** — use Gmail `format=full` and walk `parts` to access them.
- **Always mark read after processing** to avoid re-processing on the next cron run.
