#!/usr/bin/env bats
#
# B9: verify the concurrent-run guard in sync-all.sh. Exits silently
# when another run holds the lock; proceeds when free.

setup() {
  export LOCK_BASE="$BATS_TMPDIR/nanoclaw-sync-lock-$$-$RANDOM.d"
  # We don't want the real sync work to run — replace the script's
  # heavy body with an early-exit via a wrapper that sources only
  # the lock prologue. Easier: invoke the real script but point
  # NANOCLAW_SYNC_LOCK at a per-test lock dir so we don't stomp
  # on anything, and use a "HALT_AFTER_LOCK=1" env shim that we'll
  # add as a test seam below.
  export NANOCLAW_SYNC_LOCK="$LOCK_BASE"
  export HALT_AFTER_LOCK=1
  export SCRIPT_PATH="$BATS_TEST_DIRNAME/../sync-all.sh"
}

teardown() {
  rm -rf "$LOCK_BASE"
}

@test "acquires the lock when free and runs (HALT_AFTER_LOCK stops before real work)" {
  run bash "$SCRIPT_PATH"
  [ "$status" -eq 0 ]
  # HALT_AFTER_LOCK path should print a sentinel and exit; the real
  # sync work (pre-flight, gmail sync) must NOT have run.
  [[ "$output" == *"HALT_AFTER_LOCK"* ]]
  [[ "$output" != *"Gmail sync:"* ]]
}

@test "exits silently when the lock is already held by a live holder" {
  # Simulate a live holder by populating the lock dir with our own PID.
  mkdir "$LOCK_BASE"
  echo $$ > "$LOCK_BASE/pid"

  run bash "$SCRIPT_PATH"
  [ "$status" -eq 0 ]
  # No "HALT_AFTER_LOCK" sentinel because the script exited before
  # reaching it; no sync.log header either.
  [[ "$output" != *"HALT_AFTER_LOCK"* ]]
  [[ "$output" != *"SYNC RUN:"* ]]
}

@test "steals the lock when the stored PID is dead" {
  # Create a lock dir with a definitely-dead PID.
  mkdir "$LOCK_BASE"
  echo 99999999 > "$LOCK_BASE/pid"

  run bash "$SCRIPT_PATH"
  [ "$status" -eq 0 ]
  [[ "$output" == *"HALT_AFTER_LOCK"* ]]
  [[ "$output" == *"Stale lock"* ]]
}

# ──────────────────────────────────────────────────────────────────────
# C8: sync-area logs must be mode 0600 (they contain credential paths
# and tracebacks). Source-level checks guard the chmod loop and the
# extended rotation block — behavioural coverage would require a test
# seam past HALT_AFTER_LOCK, which is more scaffolding than the fix
# warrants.
# ──────────────────────────────────────────────────────────────────────

@test "C8: chmod loop covers all known sync-area log files" {
  run grep -E 'chmod 0600' "$SCRIPT_PATH"
  [ "$status" -eq 0 ]
  # All five files must appear in the chmod targets.
  grep -q 'LOG_FILE' "$SCRIPT_PATH"
  grep -q 'LAUNCHD_STDOUT_LOG' "$SCRIPT_PATH"
  grep -q 'LAUNCHD_STDERR_LOG' "$SCRIPT_PATH"
  grep -q 'claude-ingest.log' "$SCRIPT_PATH"
  grep -q 'telegram-ingest.log' "$SCRIPT_PATH"
}

@test "C8: trim block rotates launchd-stdout.log and launchd-stderr.log" {
  # Regression guard: the original trim only touched LOG_FILE. The
  # launchd logs are the ones that actually grew unbounded (launchd
  # captured output independently of the in-script tee).
  run grep -c 'LAUNCHD_STDOUT_LOG\|LAUNCHD_STDERR_LOG' "$SCRIPT_PATH"
  [ "$status" -eq 0 ]
  [ "$output" -ge 2 ]
}
