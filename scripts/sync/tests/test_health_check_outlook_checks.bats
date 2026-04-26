#!/usr/bin/env bats
#
# Regression tests for the Outlook→Gmail health checks added in
# commit 38134aba: 7b (script presence), 7c (freshness + parseable),
# and 7d (silent-degrade detection via bytes_session/errors_session).
#
# Strategy: run sync-health-check.sh as a black box with a controlled
# ~/.cache/email-migrate/ state directory (via $HOME override) and
# assert specific check lines appear in output. We don't try to mock
# every check — many depend on real services (QMD, Ollama). We just
# verify that the marker-related checks fire correctly given a
# synthesized marker file.

setup() {
  export TEST_HOME="$BATS_TMPDIR/health-outlook-test-$$"
  mkdir -p "$TEST_HOME/.cache/email-migrate"
  export HEALTH_SCRIPT="$BATS_TEST_DIRNAME/../sync-health-check.sh"
  # The script uses $HOME explicitly in the SUCCESS_FILE path, so
  # overriding HOME redirects it. (It also uses $HOME for the OAuth
  # token check; that test is more involved so we'll grep just the
  # specific check lines we care about.)
}

teardown() {
  rm -rf "$TEST_HOME"
}

# Helper: write a synthetic marker file with given fields
write_marker() {
  local timestamp="$1"
  local bytes_session="$2"
  local errors_session="$3"
  cat > "$TEST_HOME/.cache/email-migrate/last-success.json" <<EOF
{
  "timestamp": $timestamp,
  "iso": "test",
  "bytes_uploaded_today": 1000,
  "bytes_session": $bytes_session,
  "errors_session": $errors_session
}
EOF
}

# Helper: run health check with overridden HOME, return only marker-related lines
run_check() {
  HOME="$TEST_HOME" bash "$HEALTH_SCRIPT" 2>&1 | grep -E "Outlook→Gmail|email-migrate.py present"
}

# ---------------------------------------------------------------------------
# 7c: freshness check
# ---------------------------------------------------------------------------

@test "7c PASSES when marker is fresh (timestamp within 8h)" {
  write_marker "$(date +%s)" 0 0
  run run_check
  [[ "$output" == *"✓ Outlook→Gmail freshness (<8h)"* ]]
}

@test "7c FAILS when marker is stale (>8h old)" {
  # 9 hours ago
  local stale=$(($(date +%s) - 9*3600))
  write_marker "$stale" 0 0
  run run_check
  [[ "$output" == *"✗ Outlook→Gmail freshness (<8h)"* ]]
  [[ "$output" == *"forwarding may be wedged"* ]]
}

@test "7c FAILS when marker is unparseable (0-byte from non-atomic write)" {
  # Empty file simulates the failure mode atomic-write defends against
  : > "$TEST_HOME/.cache/email-migrate/last-success.json"
  run run_check
  [[ "$output" == *"✗ Outlook→Gmail freshness"* ]]
  [[ "$output" == *"unparseable"* ]]
  [[ "$output" == *"atomic write failed?"* ]]
}

# ---------------------------------------------------------------------------
# 7d: silent-degrade detection
# ---------------------------------------------------------------------------

@test "7d PASSES when marker shows no errors (idempotent rerun)" {
  write_marker "$(date +%s)" 0 0
  run run_check
  [[ "$output" == *"✓ Outlook→Gmail last run did work"* ]]
}

@test "7d PASSES when marker shows real upload work" {
  write_marker "$(date +%s)" 1500 0
  run run_check
  [[ "$output" == *"✓ Outlook→Gmail last run did work"* ]]
}

@test "7d FAILS when bytes_session=0 and errors_session>0 (silent degrade)" {
  write_marker "$(date +%s)" 0 47
  run run_check
  [[ "$output" == *"✗ Outlook→Gmail last run did work"* ]]
  [[ "$output" == *"47 errors and 0 bytes uploaded"* ]]
  [[ "$output" == *"silent degrade"* ]]
}

# ---------------------------------------------------------------------------
# 7b: script-presence check (independent of marker)
# ---------------------------------------------------------------------------

@test "7b PASSES when email-migrate.py is present in scripts/sync/" {
  # The check uses $SCRIPT_DIR which the health script computes from its own
  # location, so it should always find the canonical script. This is a
  # smoke check — if the file is ever moved without updating the check,
  # this will catch it.
  write_marker "$(date +%s)" 0 0  # need fresh marker so script doesn't error out
  run run_check
  [[ "$output" == *"✓ email-migrate.py present"* ]]
}
