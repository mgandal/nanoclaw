#!/usr/bin/env bats
#
# Source-level tests for Steps 3 + 8 timeout hardening.
#
# Steps 3 (email-ingest.py) and 8 (qmd embed) both call Ollama. If
# Ollama hangs (see project_qwen3_ollama_bug memory — qwen3:8b hangs
# after first request on Ollama 0.20.x), these steps hang indefinitely
# under launchd because:
#   - There's no `set -e` for the step
#   - There's no timeout wrapper
#   - The pinning watchdog won't catch it (Ollama hang = python at 0%
#     CPU, not pinned)
#   - launchd ExitTimeOut only fires on shutdown, not mid-run
#
# Same gtimeout-without-foreground pattern that protects Step 5.

setup() {
  export SCRIPT="$BATS_TEST_DIRNAME/../sync-all.sh"
}

# ──────────────────────────────────────────────────────────────────────
# Step 3: email-ingest.py wrapped in gtimeout
# ──────────────────────────────────────────────────────────────────────

# Helper: extract the Step N block from sync-all.sh into a temp file
# so grep -q (which returns proper exit codes bats honors) can run on it.
# Args: start_line_marker end_line_marker (literal strings, not regex)
step_block() {
  local start="$1" end="$2"
  local out="$BATS_TMPDIR/step-block-$$-$RANDOM"
  # Use fixed-string match within awk by anchoring with index() and a flag.
  # This avoids regex-escaping pain with `[N/10]` brackets.
  awk -v s="$start" -v e="$end" '
    index($0, s) { inblock = 1 }
    inblock { print }
    inblock && index($0, e) && !index($0, s) { exit }
  ' "$SCRIPT" > "$out"
  echo "$out"
}

@test "Step 3 invokes email-ingest.py via gtimeout" {
  block=$(step_block '[3/10] Email knowledge ingestion' '[4/10]')
  grep -q "gtimeout" "$block"
  grep -q "email-ingest.py" "$block"
}

@test "Step 3 gtimeout uses --kill-after for escalation" {
  block=$(step_block '[3/10] Email knowledge ingestion' '[4/10]')
  grep -q "\-\-kill-after" "$block"
}

@test "Step 3 does NOT use gtimeout --foreground (would orphan children)" {
  block=$(step_block '[3/10] Email knowledge ingestion' '[4/10]')
  ! grep -q "\-\-foreground" "$block"
}

@test "Step 3 differentiates exit 124 (timeout)" {
  block=$(step_block '[3/10] Email knowledge ingestion' '[4/10]')
  grep -q "124" "$block"
}

# ──────────────────────────────────────────────────────────────────────
# Step 8: qmd embed wrapped in gtimeout
# ──────────────────────────────────────────────────────────────────────

@test "Step 8 invokes qmd embed via gtimeout" {
  block=$(step_block '[8/10] QMD embed' '[9/10]')
  grep -q "gtimeout" "$block"
  grep -q "qmd embed" "$block"
}

@test "Step 8 gtimeout uses --kill-after for escalation" {
  block=$(step_block '[8/10] QMD embed' '[9/10]')
  grep -q "\-\-kill-after" "$block"
}

@test "Step 8 does NOT use gtimeout --foreground" {
  block=$(step_block '[8/10] QMD embed' '[9/10]')
  ! grep -q "\-\-foreground" "$block"
}

@test "Step 8 differentiates exit 124 (timeout)" {
  block=$(step_block '[8/10] QMD embed' '[9/10]')
  grep -q "124" "$block"
}

# ──────────────────────────────────────────────────────────────────────
# Defense-in-depth: outer pre-flight gates Ollama reachability so we
# don't waste the gtimeout budget on a known-unreachable Ollama.
# This already exists in sync-health-check.sh, regression guard only.
# ──────────────────────────────────────────────────────────────────────

@test "sync-health-check.sh still gates Ollama reachability" {
  HEALTH="$BATS_TEST_DIRNAME/../sync-health-check.sh"
  run grep -q "Ollama reachable" "$HEALTH"
  [ "$status" -eq 0 ]
}
