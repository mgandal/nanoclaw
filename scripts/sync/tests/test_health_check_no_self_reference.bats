#!/usr/bin/env bats
#
# Regression test: sync-health-check.sh must NOT contain a check that reads
# the prior cycle's error count from sync.log.
#
# Self-referential checks of the form "did the last run end clean?" create
# a permanent self-perpetuating wedge: any cycle that records errors>0
# causes every subsequent cycle's pre-flight to fail this check, which
# causes sync-all.sh to record errors>0 again, ad infinitum. From the
# moment the loop entered (~2026-05-09), every one of 51+ cycles ended
# `errors >= 1` even when all 10 sync steps succeeded.
#
# This test pins the fix by asserting the wedge-shaped check is gone.
# It does NOT depend on live sync.log state.

setup() {
  export HEALTH_SCRIPT="$BATS_TEST_DIRNAME/../sync-health-check.sh"
}

@test "health-check script source does NOT include 'Last sync error-free' check" {
  # Direct source-level assertion: the wedge-shaped check string is gone.
  # This is a stronger guard than a behavioral test because someone could
  # reintroduce the pattern under a different name; this test would fail
  # only if the exact removed string returns, which is a clear signal.
  run grep -F "Last sync error-free" "$HEALTH_SCRIPT"
  [ "$status" -ne 0 ]
}

@test "health-check script does NOT grep prior errors from its own sync.log" {
  # Defends against the broader anti-pattern: any check that reads
  # "errors: N" from sync.log would re-create the wedge under a new name.
  run grep -E "errors: \[0-9\]\+|LAST_ERRORS" "$HEALTH_SCRIPT"
  [ "$status" -ne 0 ]
}
