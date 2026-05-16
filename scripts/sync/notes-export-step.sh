#!/bin/bash
# notes-export-step.sh — Apple Notes re-export step extracted from sync-all.sh.
#
# Replaces the inline Step 5 that pinned Notes.app at 87% CPU and prevented
# the user from quitting it. The original failure mode (2026-05-16):
#   1. sync-all.sh fired via launchd while the user was interactively using Notes
#   2. `osascript ... activate` ripped Notes to the foreground
#   3. export-notes.js iterated every folder via per-folder osascript spawn,
#      pinning Notes for ~30 minutes while the user pressed Cmd-Q in vain
#   4. `osascript ... quit` ran *unconditionally* even when Notes was open
#      before the script started, killing the user's session
#
# This wrapper adds defense-in-depth (four layers) so the same failure cannot
# recur from any code path. See test_notes_export_step.bats for the contract.

set -o pipefail

# ─── Layer 1: Entry-point validation ───────────────────────────────────
NOTES_EXPORT_SCRIPT="${NOTES_EXPORT_SCRIPT:-$HOME/.cache/apple-notes-mcp/export-notes.js}"
NOTES_EXPORT_DIR="${NOTES_EXPORT_DIR:-$HOME/.cache/apple-notes-mcp/exported}"
NOTES_EXPORT_TIMEOUT="${NOTES_EXPORT_TIMEOUT:-1800}"  # 30 min default. Mike's library is ~900 notes across all accounts (iCloud + Gmail + Exchange); legitimate runs measured at 12-15 min under load. Defense-in-depth still has gtimeout's --kill-after=10 to escalate to SIGKILL if SIGTERM is ignored.

if [ ! -f "$NOTES_EXPORT_SCRIPT" ]; then
  echo "[notes-export] SKIP: $NOTES_EXPORT_SCRIPT not found"
  exit 0
fi

# Numeric-only timeout (defense against env injection).
if ! printf '%s' "$NOTES_EXPORT_TIMEOUT" | grep -Eq '^[0-9]+$'; then
  echo "[notes-export] ERROR: invalid NOTES_EXPORT_TIMEOUT='$NOTES_EXPORT_TIMEOUT'"
  exit 2
fi

# ─── Layer 2: Business-logic guard — Notes is in interactive use ───────
# Use System Events (cheap, doesn't open scripting connection to Notes).
# If the user has Notes frontmost, we skip silently — the export can
# wait until the next 4-hour tick.
NOTES_FRONTMOST=$(osascript -e '
  tell application "System Events"
    try
      set frontApp to name of first application process whose frontmost is true
      if frontApp is "Notes" then
        return "true"
      end if
    end try
    return "false"
  end tell
' 2>/dev/null | tail -1)

if [ "$NOTES_FRONTMOST" = "true" ]; then
  echo "[notes-export] SKIP: Notes is in use (frontmost) — deferring to next sync tick"
  exit 0
fi

# Track whether Notes was running *before* we started so we know whether
# to quit it at the end. If the user had Notes open in the background,
# we must NOT quit it.
NOTES_RUNNING_BEFORE=$(osascript -e '
  tell application "System Events"
    if (name of processes) contains "Notes" then
      return "true"
    else
      return "false"
    end if
  end tell
' 2>/dev/null | tail -1)

# ─── Layer 4: Debug instrumentation (before risky operations) ──────────
echo "[notes-export] START: timeout=${NOTES_EXPORT_TIMEOUT}s notes_running_before=$NOTES_RUNNING_BEFORE export_dir=$NOTES_EXPORT_DIR"

# ─── Layer 3: Environment guard — atomic export via tempdir ────────────
# export-notes.js wipes its target dir on startup. If it's killed midway
# (SIGTERM from launchd ExitTimeOut, alarm fire, or the user pkill'ing
# us), the previous good export disappears and downstream QMD index
# loses 411 entries. Mitigation: run the export into a sibling tempdir,
# then atomic-rename only on success.
#
# Build into a sibling on the same filesystem so the final rename is
# POSIX-atomic and consumers never see a partial state.
PARENT=$(dirname "$NOTES_EXPORT_DIR")
mkdir -p "$PARENT"
EXPORT_TMP="$PARENT/.exported-tmp-$$"
trap 'rm -rf "$EXPORT_TMP"' EXIT INT TERM

# Run the export with a process-group-wide timeout. We DON'T use the
# perl-alarm pattern from Step 1 because it leaks orphans: when SIGALRM
# fires, perl-execed-into-node dies, but any osascript subprocesses
# node spawned remain alive (reparented to init), keep their stdout
# write-ends open on the pipe, and the pipeline never EOFs. Worse, the
# orphan osascripts keep their scripting connections to Notes.app open,
# which is the exact lockup we're trying to prevent.
#
# `gtimeout --kill-after=10 T cmd` puts cmd in a new process group,
# sends SIGTERM to the whole group on timeout, then SIGKILL 10s later
# if anything ignored SIGTERM. We deliberately omit --foreground:
# under launchd there's no terminal anyway, and --foreground reduces
# signal delivery to the immediate child only — which would orphan
# any osascript subprocesses spawned by export-notes.js. Orphaned
# osascripts would keep their scripting connection to Notes.app open
# and re-create the 2026-05-16 lockup we're trying to prevent.
#
# The Step 1 TCC concern (re: gtimeout failing for Mail.app FDA reads)
# doesn't apply here — we aren't gating on Mail FDA, we're running
# a normal node script that talks to Notes via AppleEvents.
gtimeout --kill-after=10 "$NOTES_EXPORT_TIMEOUT" \
  node "$NOTES_EXPORT_SCRIPT" "$EXPORT_TMP" 2>&1 | tail -5
EC=${PIPESTATUS[0]}

case "$EC" in
  0)
    # Success — swap tempdir into place. POSIX rename(2) cannot atomically
    # replace a non-empty directory (returns ENOTEMPTY), so we do a two-step:
    #   1. mv NOTES_EXPORT_DIR → BACKUP    (canonical path empty briefly)
    #   2. mv EXPORT_TMP       → NOTES_EXPORT_DIR
    # There's a small non-atomic window between (1) and (2). If a signal
    # lands in that window, the trap MUST restore $BACKUP so the user
    # doesn't lose access to the previous export. Update the trap before
    # the destructive mv to cover both EXPORT_TMP cleanup AND BACKUP
    # restoration. (Reviewer finding 2026-05-16.)
    if [ -d "$NOTES_EXPORT_DIR" ]; then
      BACKUP="$PARENT/.exported-old-$$"
      # Arm the recovery trap BEFORE the destructive mv. If anything
      # below fails or we get SIGTERM, the trap restores $BACKUP to
      # its canonical location and cleans up the tempdir.
      trap 'mv "$BACKUP" "$NOTES_EXPORT_DIR" 2>/dev/null; rm -rf "$EXPORT_TMP"' EXIT INT TERM
      mv "$NOTES_EXPORT_DIR" "$BACKUP"
    fi
    mv "$EXPORT_TMP" "$NOTES_EXPORT_DIR"
    # Both mvs succeeded — disarm the recovery trap and drop the backup.
    trap - EXIT INT TERM
    [ -n "${BACKUP:-}" ] && rm -rf "$BACKUP"
    echo "[notes-export] OK"
    ;;
  124)
    # gtimeout convention: 124 = SIGTERM fired at the timeout.
    echo "[notes-export] WARNING: export timed out after ${NOTES_EXPORT_TIMEOUT}s (previous export preserved)"
    ;;
  137)
    # gtimeout convention: 137 = 128 + SIGKILL (the --kill-after escalation).
    # Means SIGTERM was ignored for 10s and we had to nuke.
    echo "[notes-export] WARNING: export hard-killed after ${NOTES_EXPORT_TIMEOUT}s+10s (previous export preserved)"
    ;;
  143)
    # 128 + SIGTERM. Sent externally (launchd ExitTimeOut or manual kickstart).
    echo "[notes-export] WARNING: export killed (SIGTERM — previous export preserved)"
    ;;
  *)
    echo "[notes-export] WARNING: export had errors (exit $EC — previous export preserved)"
    ;;
esac

# Only quit Notes if WE started it. Never quit a user-launched Notes.
if [ "$NOTES_RUNNING_BEFORE" = "false" ]; then
  # We didn't start Notes in the new design (no `activate`), so it should
  # only be running if export-notes.js's AppleEvents woke it. Quit it.
  osascript -e 'tell application "Notes" to quit' 2>/dev/null || true
fi

exit "$EC"
