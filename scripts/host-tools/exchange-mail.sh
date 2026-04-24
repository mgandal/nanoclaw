#!/bin/bash
# Exchange Email tool — wraps Mac Mail via osascript
# Called by the NanoClaw host IPC handler
# Usage: exchange-mail.sh <action> [args...]

set -euo pipefail

ACTION="${1:-}"
shift || true

die() { echo "{\"error\": \"$1\"}" >&2; exit 1; }

ACCOUNT_NAME="Exchange"
TMPDIR="${TMPDIR:-/tmp}"

# Run an AppleScript file with args, return result to stdout
run_scpt() {
  local scptfile="$1"; shift
  osascript "$scptfile" "$@" 2>&1 || true
}

# ── search ───────────────────────────────────────────────────────────────────

do_search() {
  local from_filter="" subject_filter="" since_days="7" mailbox="Inbox" limit="20"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --from)    from_filter="$2"; shift 2 ;;
      --subject) subject_filter="$2"; shift 2 ;;
      --since)   since_days="$2"; shift 2 ;;
      --mailbox) mailbox="$2"; shift 2 ;;
      --limit)   limit="$2"; shift 2 ;;
      *) die "Unknown search arg: $1" ;;
    esac
  done

  local scpt="$TMPDIR/exchange-search-$$.scpt"
  cat > "$scpt" <<'APPLESCRIPT'
use AppleScript version "2.4"
use scripting additions

on run argv
    set acct to item 1 of argv
    set mbox to item 2 of argv
    set fromFilter to item 3 of argv
    set subjectFilter to item 4 of argv
    set sinceDays to (item 5 of argv) as integer
    set maxResults to (item 6 of argv) as integer

    set cutoffDate to (current date) - (sinceDays * days)
    set sep to ASCII character 31
    set rowSep to ASCII character 30

    with timeout of 600 seconds
    tell application "Mail"
        set targetMailbox to mailbox mbox of account acct
        set msgs to messages of targetMailbox whose date received > cutoffDate
        set outputRows to {}
        set resultCount to 0

        repeat with m in msgs
            if resultCount ≥ maxResults then exit repeat

            set msgSubject to subject of m
            set msgFrom to extract address from sender of m
            set msgFromName to extract name from sender of m
            set msgId to message id of m
            set msgDate to date received of m
            set isRead to read status of m
            set isFlagged to flagged status of m

            set includeThis to true
            if fromFilter is not "" then
                if msgFrom does not contain fromFilter and msgFromName does not contain fromFilter then
                    set includeThis to false
                end if
            end if
            if subjectFilter is not "" then
                if msgSubject does not contain subjectFilter then
                    set includeThis to false
                end if
            end if

            if includeThis then
                set y to year of msgDate
                set mo to (month of msgDate as integer)
                set d to day of msgDate
                set h to hours of msgDate
                set mi to minutes of msgDate
                set dateStr to (y as text) & "-" & text -2 thru -1 of ("0" & mo) & "-" & text -2 thru -1 of ("0" & d) & "T" & text -2 thru -1 of ("0" & h) & ":" & text -2 thru -1 of ("0" & mi)

                set readStr to "false"
                if isRead then set readStr to "true"
                set flagStr to "false"
                if isFlagged then set flagStr to "true"

                set end of outputRows to msgId & sep & msgSubject & sep & msgFrom & sep & msgFromName & sep & dateStr & sep & readStr & sep & flagStr
                set resultCount to resultCount + 1
            end if
        end repeat

        set AppleScript's text item delimiters to rowSep
        return (outputRows as text)
    end tell
    end timeout
end run
APPLESCRIPT

  local raw_output
  raw_output=$(run_scpt "$scpt" "$ACCOUNT_NAME" "$mailbox" "$from_filter" "$subject_filter" "$since_days" "$limit")
  rm -f "$scpt"

  local pyscpt="$TMPDIR/exchange-search-$$.py"
  cat > "$pyscpt" <<'PYEOF'
import sys, json

raw = sys.stdin.read().strip()
if not raw:
    print("[]")
    sys.exit(0)

sep = chr(31)
row_sep = chr(30)
rows = raw.split(row_sep)
results = []
for row in rows:
    parts = row.split(sep, 6)
    if len(parts) < 7:
        continue
    msg_id, subject, from_addr, from_name, date, read, flagged = parts
    results.append({
        "id": msg_id.strip(),
        "subject": subject.strip(),
        "from": from_addr.strip(),
        "fromName": from_name.strip(),
        "date": date.strip(),
        "read": read.strip() == "true",
        "flagged": flagged.strip() == "true",
    })
print(json.dumps(results))
PYEOF
  echo "$raw_output" | python3 "$pyscpt"
  rm -f "$pyscpt"
}

# ── read ─────────────────────────────────────────────────────────────────────

do_read() {
  local message_id="${1:-}"
  [[ -z "$message_id" ]] && die "Usage: exchange-mail.sh read <message-id>"

  local scpt="$TMPDIR/exchange-read-$$.scpt"
  cat > "$scpt" <<'APPLESCRIPT'
use AppleScript version "2.4"
use scripting additions

on run argv
    set targetId to item 1 of argv
    set acct to item 2 of argv

    with timeout of 600 seconds
    tell application "Mail"
        set allMailboxes to every mailbox of account acct
        set m to missing value
        repeat with mb in allMailboxes
            try
                set matchingMsgs to (messages of mb whose message id is targetId)
                if (count of matchingMsgs) > 0 then
                    set m to item 1 of matchingMsgs
                    exit repeat
                end if
            end try
        end repeat

        if m is missing value then
            return "ERROR:Message not found"
        end if

        set msgSubject to subject of m
        set msgFrom to extract address from sender of m
        set msgFromName to extract name from sender of m
        set msgDate to date received of m
        set msgBody to content of m
        set isRead to read status of m
        set isFlagged to flagged status of m
        set msgId to message id of m

        set toAddrs to {}
        repeat with r in to recipients of m
            set end of toAddrs to address of r
        end repeat

        set ccAddrs to {}
        repeat with r in cc recipients of m
            set end of ccAddrs to address of r
        end repeat

        set y to year of msgDate
        set mo to (month of msgDate as integer)
        set d to day of msgDate
        set h to hours of msgDate
        set mi to minutes of msgDate
        set dateStr to (y as text) & "-" & text -2 thru -1 of ("0" & mo) & "-" & text -2 thru -1 of ("0" & d) & "T" & text -2 thru -1 of ("0" & h) & ":" & text -2 thru -1 of ("0" & mi)

        set readStr to "false"
        if isRead then set readStr to "true"
        set flagStr to "false"
        if isFlagged then set flagStr to "true"

        set sep to ASCII character 31
        set AppleScript's text item delimiters to ","
        set toStr to (toAddrs as text)
        set ccStr to (ccAddrs as text)
        set AppleScript's text item delimiters to ""

        return msgId & sep & msgSubject & sep & msgFrom & sep & msgFromName & sep & dateStr & sep & readStr & sep & flagStr & sep & toStr & sep & ccStr & sep & msgBody
    end tell
    end timeout
end run
APPLESCRIPT

  local raw_output
  raw_output=$(run_scpt "$scpt" "$message_id" "$ACCOUNT_NAME")
  rm -f "$scpt"

  if [[ "$raw_output" == ERROR:* ]]; then
    echo "{\"error\": \"${raw_output#ERROR:}\"}"
    return 1
  fi

  local pyscpt="$TMPDIR/exchange-read-$$.py"
  cat > "$pyscpt" <<'PYEOF'
import sys, json

raw = sys.stdin.read()
sep = chr(31)
parts = raw.split(sep, 9)

if len(parts) < 10:
    print(json.dumps({"error": "Failed to parse email fields", "raw_length": len(raw), "parts": len(parts)}))
    sys.exit(0)

msg_id, subject, from_addr, from_name, date, read, flagged, to_str, cc_str, body = parts

body = body.strip()
if len(body) > 50000:
    body = body[:50000] + "... [truncated]"

result = {
    "id": msg_id.strip(),
    "subject": subject.strip(),
    "from": from_addr.strip(),
    "fromName": from_name.strip(),
    "date": date.strip(),
    "read": read.strip() == "true",
    "flagged": flagged.strip() == "true",
    "to": [a.strip() for a in to_str.split(",") if a.strip()],
    "cc": [a.strip() for a in cc_str.split(",") if a.strip()],
    "body": body,
}
print(json.dumps(result))
PYEOF
  echo "$raw_output" | python3 "$pyscpt"
  rm -f "$pyscpt"
}

# ── list-mailboxes ───────────────────────────────────────────────────────────

do_list_mailboxes() {
  local scpt="$TMPDIR/exchange-listmbox-$$.scpt"
  cat > "$scpt" <<'APPLESCRIPT'
on run argv
    set acct to item 1 of argv
    with timeout of 600 seconds
    tell application "Mail"
        set mboxes to mailboxes of account acct
        set nameList to {}
        repeat with mb in mboxes
            set end of nameList to name of mb
        end repeat
        set AppleScript's text item delimiters to (ASCII character 31)
        return (nameList as text)
    end tell
    end timeout
end run
APPLESCRIPT

  local raw_output
  raw_output=$(run_scpt "$scpt" "$ACCOUNT_NAME")
  rm -f "$scpt"

  local pyscpt="$TMPDIR/exchange-listmbox-$$.py"
  cat > "$pyscpt" <<'PYEOF'
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print("[]")
else:
    names = raw.split(chr(31))
    print(json.dumps(names))
PYEOF
  echo "$raw_output" | python3 "$pyscpt"
  rm -f "$pyscpt"
}

# ── move ─────────────────────────────────────────────────────────────────────

do_move() {
  local message_id="${1:-}"
  local target_mailbox="${2:-}"
  [[ -z "$message_id" ]] && die "Usage: exchange-mail.sh move <message-id> <mailbox>"
  [[ -z "$target_mailbox" ]] && die "Usage: exchange-mail.sh move <message-id> <mailbox>"

  local scpt="$TMPDIR/exchange-move-$$.scpt"
  cat > "$scpt" <<'APPLESCRIPT'
on run argv
    set targetId to item 1 of argv
    set destName to item 2 of argv
    set acct to item 3 of argv
    with timeout of 600 seconds
    tell application "Mail"
        set destMailbox to mailbox destName of account acct
        set m to missing value
        repeat with mb in (every mailbox of account acct)
            try
                set matchingMsgs to (messages of mb whose message id is targetId)
                if (count of matchingMsgs) > 0 then
                    set m to item 1 of matchingMsgs
                    exit repeat
                end if
            end try
        end repeat
        if m is missing value then
            return "{\"error\": \"Message not found\"}"
        end if
        move m to destMailbox
        return "{\"success\": true, \"moved_to\": \"" & destName & "\"}"
    end tell
    end timeout
end run
APPLESCRIPT
  run_scpt "$scpt" "$message_id" "$target_mailbox" "$ACCOUNT_NAME"
  rm -f "$scpt"
}

# ── flag ─────────────────────────────────────────────────────────────────────

do_flag() {
  local message_id="${1:-}"
  local unflag=false
  shift || true

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --unflag) unflag=true; shift ;;
      *) message_id="$1"; shift ;;
    esac
  done

  [[ -z "$message_id" ]] && die "Usage: exchange-mail.sh flag <message-id> [--unflag]"

  local flag_val="true"
  [[ "$unflag" == "true" ]] && flag_val="false"

  local scpt="$TMPDIR/exchange-flag-$$.scpt"
  cat > "$scpt" <<'APPLESCRIPT'
on run argv
    set targetId to item 1 of argv
    set flagVal to (item 2 of argv) is "true"
    set acct to item 3 of argv
    with timeout of 600 seconds
    tell application "Mail"
        set m to missing value
        repeat with mb in (every mailbox of account acct)
            try
                set matchingMsgs to (messages of mb whose message id is targetId)
                if (count of matchingMsgs) > 0 then
                    set m to item 1 of matchingMsgs
                    exit repeat
                end if
            end try
        end repeat
        if m is missing value then
            return "{\"error\": \"Message not found\"}"
        end if
        set flagged status of m to flagVal
        if flagVal then
            return "{\"success\": true, \"flagged\": true}"
        else
            return "{\"success\": true, \"flagged\": false}"
        end if
    end tell
    end timeout
end run
APPLESCRIPT
  run_scpt "$scpt" "$message_id" "$flag_val" "$ACCOUNT_NAME"
  rm -f "$scpt"
}

# ── mark-read / mark-unread ──────────────────────────────────────────────────

do_mark_read() {
  local message_id="${1:-}"
  local read_val="${2:-true}"
  [[ -z "$message_id" ]] && die "Usage: exchange-mail.sh mark-read <message-id>"

  local scpt="$TMPDIR/exchange-markread-$$.scpt"
  cat > "$scpt" <<'APPLESCRIPT'
on run argv
    set targetId to item 1 of argv
    set readVal to (item 2 of argv) is "true"
    set acct to item 3 of argv
    with timeout of 600 seconds
    tell application "Mail"
        set m to missing value
        repeat with mb in (every mailbox of account acct)
            try
                set matchingMsgs to (messages of mb whose message id is targetId)
                if (count of matchingMsgs) > 0 then
                    set m to item 1 of matchingMsgs
                    exit repeat
                end if
            end try
        end repeat
        if m is missing value then
            return "{\"error\": \"Message not found\"}"
        end if
        set read status of m to readVal
        if readVal then
            return "{\"success\": true, \"read\": true}"
        else
            return "{\"success\": true, \"read\": false}"
        end if
    end tell
    end timeout
end run
APPLESCRIPT
  run_scpt "$scpt" "$message_id" "$read_val" "$ACCOUNT_NAME"
  rm -f "$scpt"
}

# ── draft ────────────────────────────────────────────────────────────────────

do_draft() {
  local to_addr="" subject="" body=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to)      to_addr="$2"; shift 2 ;;
      --subject) subject="$2"; shift 2 ;;
      --body)    body="$2"; shift 2 ;;
      *) die "Unknown draft arg: $1" ;;
    esac
  done

  [[ -z "$to_addr" ]] && die "draft requires --to"
  [[ -z "$subject" ]] && die "draft requires --subject"
  [[ -z "$body" ]] && die "draft requires --body"

  local scpt="$TMPDIR/exchange-draft-$$.scpt"
  cat > "$scpt" <<'APPLESCRIPT'
on run argv
    set toAddr to item 1 of argv
    set msgSubject to item 2 of argv
    set msgBody to item 3 of argv
    with timeout of 600 seconds
    tell application "Mail"
        set newMsg to make new outgoing message with properties {subject:msgSubject, content:msgBody, visible:false}
        tell newMsg
            make new to recipient at end of to recipients with properties {address:toAddr}
        end tell
        save newMsg
        return "{\"success\": true, \"action\": \"draft_created\"}"
    end tell
    end timeout
end run
APPLESCRIPT
  run_scpt "$scpt" "$to_addr" "$subject" "$body"
  rm -f "$scpt"
}

# ── dispatch ─────────────────────────────────────────────────────────────────

case "$ACTION" in
  search)         do_search "$@" ;;
  read)           do_read "$@" ;;
  list-mailboxes) do_list_mailboxes ;;
  move)           do_move "$@" ;;
  flag)           do_flag "$@" ;;
  mark-read)      do_mark_read "$@" true ;;
  mark-unread)    do_mark_read "$@" false ;;
  draft)          do_draft "$@" ;;
  *) die "Unknown action: $ACTION. Valid: search, read, list-mailboxes, move, flag, mark-read, mark-unread, draft" ;;
esac
