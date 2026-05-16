#!/usr/bin/env bats
#
# Failing test for the Step 5 (Apple Notes re-export) hardening.
#
# The original Step 5 inside sync-all.sh had four problems that caused
# Notes.app to be pinned at 87% CPU and unable to quit while running:
#
#   1. No skip when Notes.app was in interactive use (script foreground-
#      stole the user's session via `osascript ... activate`).
#   2. No timeout: the per-folder JXA loop ran unbounded.
#   3. `osascript ... to quit` ran unconditionally even when Notes was
#      open *before* the script started.
#   4. export-notes.js wiped the previous export dir before the new
#      export was verified, so a mid-run kill destroyed downstream
#      QMD index entries.
#
# This test file covers the new contract of a dedicated
# `notes-export-step.sh` script. Each test is one observable behavior;
# implementations must satisfy them all.

setup() {
  export TEST_SCRATCH="$BATS_TMPDIR/nh-notes-export-$$-$RANDOM"
  mkdir -p "$TEST_SCRATCH/bin" "$TEST_SCRATCH/export"
  export SCRIPT_PATH="$BATS_TEST_DIRNAME/../notes-export-step.sh"
  # Stub `node` and `osascript` so tests run on machines without Notes
  # access. The stubs honour $TEST_SCRATCH/stub-mode for per-test behaviour.
  cat >"$TEST_SCRATCH/bin/osascript" <<'EOF'
#!/bin/bash
# Stub osascript. Records args, returns mode-controlled output.
echo "OSASCRIPT_CALL: $*" >> "$TEST_SCRATCH/osascript.log"
case "${TEST_OSASCRIPT_MODE:-default}" in
  notes-in-use)
    # Simulate a `frontmost of "Notes"` query result. Last echo line
    # is what notes-export-step.sh parses.
    echo "true"
    ;;
  notes-not-frontmost)
    echo "false"
    ;;
  *)
    # Default: silent (mimics `activate` / `quit` which produce nothing).
    ;;
esac
exit 0
EOF
  cat >"$TEST_SCRATCH/bin/node" <<'EOF'
#!/bin/bash
echo "NODE_CALL: $*" >> "$TEST_SCRATCH/node.log"
case "${TEST_NODE_MODE:-success}" in
  hang)
    # Sleep longer than any reasonable timeout the step should impose.
    sleep 3600
    ;;
  fail)
    echo "simulated export failure" >&2
    exit 7
    ;;
  *)
    # Success: emit a marker so the export dir contains "new" content.
    echo "Export complete: 5 notes exported, 0 errors"
    ;;
esac
exit 0
EOF
  chmod +x "$TEST_SCRATCH/bin/osascript" "$TEST_SCRATCH/bin/node"
  # Path shim must come first so stubs win over /usr/bin/osascript and
  # /usr/local/bin/node.
  export PATH="$TEST_SCRATCH/bin:$PATH"
  export NOTES_EXPORT_DIR="$TEST_SCRATCH/export"
  export NOTES_EXPORT_SCRIPT="$TEST_SCRATCH/fake-export-notes.js"
  echo "// stub" > "$NOTES_EXPORT_SCRIPT"
}

teardown() {
  rm -rf "$TEST_SCRATCH"
}

# ──────────────────────────────────────────────────────────────────────
# Contract 1: skip when Notes is in interactive use.
# ──────────────────────────────────────────────────────────────────────

@test "skips export when Notes.app is the frontmost application" {
  export TEST_OSASCRIPT_MODE=notes-in-use
  run bash "$SCRIPT_PATH"
  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP"* ]]
  [[ "$output" == *"Notes is in use"* ]]
  # Crucially: node export must NOT have been invoked.
  [ ! -s "$TEST_SCRATCH/node.log" ] || ! grep -q "fake-export-notes.js" "$TEST_SCRATCH/node.log"
}

# ──────────────────────────────────────────────────────────────────────
# Contract 2: timeout guard prevents unbounded runs.
# ──────────────────────────────────────────────────────────────────────

@test "kills the export after NOTES_EXPORT_TIMEOUT seconds when it hangs" {
  export TEST_OSASCRIPT_MODE=notes-not-frontmost
  export TEST_NODE_MODE=hang
  export NOTES_EXPORT_TIMEOUT=2
  start=$(date +%s)
  run bash "$SCRIPT_PATH"
  end=$(date +%s)
  elapsed=$((end - start))
  # Must complete in well under 30s (timeout=2s + a few seconds slack).
  [ "$elapsed" -lt 30 ]
  # Must report timeout, not generic error.
  [[ "$output" == *"timed out"* ]] || [[ "$output" == *"TIMEOUT"* ]]
}

# ──────────────────────────────────────────────────────────────────────
# Contract 3: no foreground-stealing `activate` when Notes was not open.
# ──────────────────────────────────────────────────────────────────────

@test "does not call 'tell application Notes to activate'" {
  export TEST_OSASCRIPT_MODE=notes-not-frontmost
  export TEST_NODE_MODE=success
  run bash "$SCRIPT_PATH"
  [ "$status" -eq 0 ]
  # The original Step 5 called `osascript -e 'tell application "Notes" to activate'`.
  # The hardened version must NOT do that — it should rely on the MCP /
  # AppleEvents to wake Notes on demand without bringing it to front.
  if [ -f "$TEST_SCRATCH/osascript.log" ]; then
    ! grep -q "to activate" "$TEST_SCRATCH/osascript.log"
  fi
}

# ──────────────────────────────────────────────────────────────────────
# Contract 4: atomic export — old dir preserved if new run fails.
# ──────────────────────────────────────────────────────────────────────

@test "preserves the previous export when the new run fails" {
  export TEST_OSASCRIPT_MODE=notes-not-frontmost
  export TEST_NODE_MODE=fail
  # Seed the export dir with a pretend-previous-export.
  mkdir -p "$NOTES_EXPORT_DIR/Previous"
  echo "old content" > "$NOTES_EXPORT_DIR/Previous/note1.md"
  run bash "$SCRIPT_PATH"
  # Step itself may exit non-zero — that's fine, it's the wrapper's job
  # to log the warning. But the previous export MUST still be present.
  [ -f "$NOTES_EXPORT_DIR/Previous/note1.md" ]
  [ "$(cat "$NOTES_EXPORT_DIR/Previous/note1.md")" = "old content" ]
}

# ──────────────────────────────────────────────────────────────────────
# Contract 5: success-path rename window. If a signal lands between
# `mv NOTES_EXPORT_DIR -> BACKUP` and `mv EXPORT_TMP -> NOTES_EXPORT_DIR`,
# the trap MUST restore $BACKUP to $NOTES_EXPORT_DIR. Source-level guard:
# the trap covering the swap window must reference BACKUP.
# (Behavioral test via signal injection is racy; this regression guard
# catches a future edit that forgets to update the trap before the swap.)
# ──────────────────────────────────────────────────────────────────────

@test "EXIT trap restores BACKUP if swap is interrupted (source-level)" {
  # The trap set just before the destructive mv MUST reference BACKUP
  # restoration. A regression that only cleans up EXPORT_TMP would lose
  # user notes if a signal lands between the two mvs on the success path.
  # We require the literal pattern `mv "$BACKUP"` somewhere in a trap
  # command (recovery action).
  grep -E -q "trap '[^']*mv +\"\\\$BACKUP\"[^']*' +EXIT" "$SCRIPT_PATH"
}
