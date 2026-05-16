#!/usr/bin/env bats
#
# sync-exit-triage 2026-05-16: verify the sync exit-code classifier.
#
# sync-all.sh used to `exit $ERRORS` where ERRORS was a raw count of
# warnings. That blew up to exit 3 on a normal day because three chronic
# external-dep flakes (Ollama daemon bounce, Apple Notes deadlock,
# slack-mcp 404) each bump the same counter. Downstream consumers
# (com.nanoclaw.launchd-health-monitor) cannot tell "1 transient flake"
# from "3 hard internal regressions".
#
# Replaced with a two-counter classifier:
#   bump_soft <msg>   → SOFT_ERRORS+=1 (transient external-dep flake)
#   bump_hard <msg>   → HARD_ERRORS+=1 (unexpected internal failure)
#   compute_exit_code echoes the semantic exit code:
#     0  = clean run
#     75 = EX_TEMPFAIL (sysexits.h) — only transient flakes
#     1  = at least one hard failure (real regression)

setup() {
  CLASSIFIER="$BATS_TEST_DIRNAME/../sync-exit-classifier.sh"
  # No `skip` guard: tests must FAIL if the classifier is missing, so a
  # silent revert/delete trips CI. Each test runs in its own subshell so
  # counters reset between cases.
}

# ── compute_exit_code semantics ─────────────────────────────────────

@test "clean run (no bumps) returns exit code 0" {
  run bash -c "source '$CLASSIFIER'; compute_exit_code"
  [ "$status" -eq 0 ]
  [ "$output" = "0" ]
}

@test "only soft errors returns exit code 75 (EX_TEMPFAIL)" {
  run bash -c "source '$CLASSIFIER'; bump_soft 'Ollama unreachable' >/dev/null; bump_soft 'Notes timeout' >/dev/null; compute_exit_code"
  [ "$status" -eq 0 ]
  [ "$output" = "75" ]
}

@test "any hard error returns exit code 1 (even if soft errors also present)" {
  run bash -c "source '$CLASSIFIER'; bump_soft 'slack-mcp 404' >/dev/null; bump_hard 'gmail-sync.py crashed' >/dev/null; compute_exit_code"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

@test "only hard errors returns exit code 1" {
  run bash -c "source '$CLASSIFIER'; bump_hard 'unexpected' >/dev/null; compute_exit_code"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

# ── counters are visible (loudness preserved) ───────────────────────

@test "bump_soft prints WARNING line to stderr so launchd captures it" {
  run bash -c "source '$CLASSIFIER'; bump_soft 'transient: Ollama hung'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARNING"* ]]
  [[ "$output" == *"SOFT"* ]]
  [[ "$output" == *"transient: Ollama hung"* ]]
}

@test "bump_hard prints WARNING line to stderr so launchd captures it" {
  run bash -c "source '$CLASSIFIER'; bump_hard 'hard: missing script'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARNING"* ]]
  [[ "$output" == *"HARD"* ]]
  [[ "$output" == *"hard: missing script"* ]]
}

@test "summary line includes both counters" {
  run bash -c "source '$CLASSIFIER'; bump_soft 's1' >/dev/null; bump_soft 's2' >/dev/null; bump_hard 'h1' >/dev/null; classifier_summary"
  [ "$status" -eq 0 ]
  [[ "$output" == *"soft=2"* ]]
  [[ "$output" == *"hard=1"* ]]
}

# ── sync-all.sh integration: regression guard against `exit \$ERRORS` ──

@test "sync-all.sh sources the classifier and uses compute_exit_code" {
  SYNC_ALL="$BATS_TEST_DIRNAME/../sync-all.sh"
  run grep -E 'source.*sync-exit-classifier\.sh|\. .*sync-exit-classifier\.sh' "$SYNC_ALL"
  [ "$status" -eq 0 ]

  # The legacy `exit $ERRORS` pattern must be gone — it's the root cause
  # of exit codes being a raw warning count.
  run grep -E '^exit \$ERRORS$' "$SYNC_ALL"
  [ "$status" -ne 0 ]

  # The new exit must derive from compute_exit_code (either directly or
  # via SYNC_EXIT_CODE assignment).
  run grep -E 'compute_exit_code' "$SYNC_ALL"
  [ "$status" -eq 0 ]
  run grep -E 'exit "?\$SYNC_EXIT_CODE"?|exit "?\$\(compute_exit_code\)"?' "$SYNC_ALL"
  [ "$status" -eq 0 ]
}

@test "sync-all.sh categorizes all step warnings (no orphan ERRORS+=1)" {
  SYNC_ALL="$BATS_TEST_DIRNAME/../sync-all.sh"
  # No bare `ERRORS=$((ERRORS + 1))` should remain — every increment
  # must go through bump_soft or bump_hard so the category is recorded.
  # grep -v '^[[:space:]]*#' filters comment lines (the doc block at
  # the top of the file references the old pattern verbatim).
  run bash -c "grep -vE '^[[:space:]]*#' '$SYNC_ALL' | grep -E 'ERRORS=\\\$\\(\\(ERRORS \\+ 1\\)\\)'"
  [ "$status" -ne 0 ]
}
