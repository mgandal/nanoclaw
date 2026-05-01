#!/usr/bin/env bash
# verify-bug-fixes.sh
#
# Counts the post-merge occurrence of the three bug signatures from the
# 2026-04-30 triage (clusters A/B/C) and appends a verified/regressed note
# per cluster to groups/global/state/bugs.md.
#
# Self-uninstalls its launchd plist at the end so the run is effectively
# one-shot — see ops/com.nanoclaw.bug-fix-verify.plist.

set -euo pipefail

REPO=/Users/mgandal/Agents/nanoclaw
LOG="$REPO/logs/nanoclaw.log"
DB="$REPO/store/messages.db"
BUGS="$REPO/groups/global/state/bugs.md"
PLIST=~/Library/LaunchAgents/com.nanoclaw.bug-fix-verify.plist
LABEL=com.nanoclaw.bug-fix-verify

# Anchor: clusters merged ~09:18-09:21 ET on 2026-04-30. Count the 24h
# window starting 1h after merge so startup noise is excluded.
SINCE_ISO="2026-05-01T14:23:00Z"   # +24h from anchor + 1h slack
SINCE_LOG="2026-05-01"             # log timestamps are HH:MM:SS only — date floor

cd "$REPO"

# ----- counts ---------------------------------------------------------------

# Use absolute paths to bypass any shell aliases/proxies (e.g. rtk) that
# would return structured output instead of raw integers from grep -c.
GREP=/usr/bin/grep
SQLITE3=/usr/bin/sqlite3

# Cluster B: setMyName 429 warnings
count_b=$($GREP -c "Failed to pre-rename pinned pool bot" "$LOG" 2>/dev/null || echo 0)
count_b_429=$($GREP -c "setMyName.*429" "$LOG" 2>/dev/null || echo 0)

# Cluster C: ENFILE file-descriptor leak
count_c=$($GREP -c "ENFILE: file table overflow" "$LOG" 2>/dev/null || echo 0)
count_c_emfile=$($GREP -c "EMFILE" "$LOG" 2>/dev/null || echo 0)

# Cluster A: user formatting complaints in Telegram (last 24h)
count_a=$($SQLITE3 "$DB" "SELECT COUNT(*) FROM messages WHERE is_from_me=0 AND timestamp > '$SINCE_ISO' AND (lower(content) LIKE '%not formatted%' OR lower(content) LIKE '%proper telegram%' OR lower(content) LIKE '%appropriate for telegram%' OR lower(content) LIKE '%formating%' OR lower(content) LIKE '%link when available%');" 2>/dev/null || echo "?")

# ----- verdict --------------------------------------------------------------

verdict_a=$([ "$count_a" = "0" ] && echo "VERIFIED" || echo "REGRESSED")
verdict_b=$([ "$count_b" -lt 5 ] && echo "VERIFIED" || echo "REGRESSED")
verdict_c=$([ "$count_c" = "0" ] && echo "VERIFIED" || echo "REGRESSED")

# ----- append to bugs.md ----------------------------------------------------

cat >> "$BUGS" <<EOF

---

# Verification 2026-05-01 (+36h post-merge, automated)

Window: 24h ending $(date -u +%Y-%m-%dT%H:%M:%SZ) UTC.

| Cluster | Pre-merge (7d) | Post-merge (24h) | Verdict |
|---|---|---|---|
| A — Telegram formatting complaints | 5+ | $count_a | $verdict_a |
| B — setMyName 429 retry-loop warnings | 24 (48 raw 429s) | $count_b ($count_b_429 raw) | $verdict_b |
| C — IPC ENFILE / EMFILE | 12 | $count_c (+ $count_c_emfile EMFILE) | $verdict_c |

EOF

# If all three verified, propose recurring triage cadence
if [ "$verdict_a" = "VERIFIED" ] && [ "$verdict_b" = "VERIFIED" ] && [ "$verdict_c" = "VERIFIED" ]; then
  cat >> "$BUGS" <<EOF
**All three clusters verified.** Recommended next step: promote this triage
into a weekly cadence. Suggested cron: every Monday 9am ET, scan logs+DB for
the previous 7 days, cluster by subsystem, append findings to this file. See
\`scripts/audit-telegram-errors.py\` for an existing pattern.

EOF
fi

echo "[$(date)] verify-bug-fixes.sh: A=$count_a B=$count_b C=$count_c"

# ----- self-uninstall (one-shot) --------------------------------------------

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "[$(date)] verify-bug-fixes.sh: self-uninstalled $LABEL"
fi
