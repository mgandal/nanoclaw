#!/usr/bin/env bats
#
# Regression test for commit 38134aba — sync-all.sh must propagate the
# pre-flight sync-health-check.sh exit code into the ERRORS counter.
#
# Pre-fix bug: `bash health-check.sh ... | grep ...` ate the exit code,
# so any FAIL conditions in the health check were invisible to the rest
# of the pipeline. Same class of silent-failure bug we're trying to
# eliminate. Fix uses ${PIPESTATUS[0]} to capture the health-check exit
# specifically, then increments ERRORS on non-zero.
#
# Test strategy: extract the pre-flight block from sync-all.sh into a
# self-contained shell snippet, point it at a fake health-check that
# exits with a controlled code, and verify ERRORS is incremented when
# the fake exits non-zero AND not incremented when it exits 0.

setup() {
  export TEST_TMP="$BATS_TMPDIR/health-prop-test-$$"
  mkdir -p "$TEST_TMP"
}

teardown() {
  rm -rf "$TEST_TMP"
}

# ---------------------------------------------------------------------------
# Helper: extract just the pre-flight block from sync-all.sh and run it
# with a substituted SCRIPT_DIR so we control which "health check" runs.
# ---------------------------------------------------------------------------

run_preflight_block() {
  local fake_health="$1"
  cat > "$TEST_TMP/runner.sh" <<EOF
#!/bin/bash
set -o pipefail
ERRORS=0
SCRIPT_DIR="$TEST_TMP"
EOF
  # Append the actual pre-flight block from sync-all.sh, verbatim
  awk '/^# --- Pre-flight:/,/^# --- Step 1:/' "$BATS_TEST_DIRNAME/../sync-all.sh" \
    | sed '$d' >> "$TEST_TMP/runner.sh"  # drop the trailing "# --- Step 1:" line
  echo 'echo "FINAL_ERRORS=$ERRORS"' >> "$TEST_TMP/runner.sh"

  # Install the fake health-check
  cp "$fake_health" "$TEST_TMP/sync-health-check.sh"
  chmod +x "$TEST_TMP/sync-health-check.sh"

  bash "$TEST_TMP/runner.sh"
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@test "health check exit 0 leaves ERRORS at 0" {
  cat > "$TEST_TMP/fake-pass.sh" <<'FAKE'
#!/bin/bash
echo "  ✓ everything fine"
echo "Results: 1 passed, 0 failed, 0 warnings"
exit 0
FAKE
  chmod +x "$TEST_TMP/fake-pass.sh"

  run run_preflight_block "$TEST_TMP/fake-pass.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"FINAL_ERRORS=0"* ]]
}

@test "health check exit 1 increments ERRORS to 1" {
  cat > "$TEST_TMP/fake-fail.sh" <<'FAKE'
#!/bin/bash
echo "  ✗ something broke"
echo "Results: 0 passed, 1 failed, 0 warnings"
exit 1
FAKE
  chmod +x "$TEST_TMP/fake-fail.sh"

  run run_preflight_block "$TEST_TMP/fake-fail.sh"
  [ "$status" -eq 0 ]   # pre-flight does NOT abort the pipeline
  [[ "$output" == *"FINAL_ERRORS=1"* ]]
  [[ "$output" == *"WARNING: health check reported failures"* ]]
}

@test "health check exit 2 increments ERRORS to 1 (any non-zero counts)" {
  cat > "$TEST_TMP/fake-fail2.sh" <<'FAKE'
#!/bin/bash
echo "  ✗ disaster"
exit 2
FAKE
  chmod +x "$TEST_TMP/fake-fail2.sh"

  run run_preflight_block "$TEST_TMP/fake-fail2.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"FINAL_ERRORS=1"* ]]
  [[ "$output" == *"exit 2"* ]]   # diagnostic message includes the code
}

@test "PIPESTATUS captures health-check exit, not grep exit" {
  # If grep matches nothing (empty output from health check), grep itself
  # exits 1. We must NOT confuse that for a health-check failure.
  # Health check exits 0 with no matchable output → ERRORS must stay 0.
  cat > "$TEST_TMP/fake-silent.sh" <<'FAKE'
#!/bin/bash
# No output at all — grep will exit 1 because no lines match
exit 0
FAKE
  chmod +x "$TEST_TMP/fake-silent.sh"

  run run_preflight_block "$TEST_TMP/fake-silent.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"FINAL_ERRORS=0"* ]]   # grep's exit is irrelevant; only health-check matters
}
