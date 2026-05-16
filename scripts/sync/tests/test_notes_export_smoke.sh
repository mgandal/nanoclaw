#!/bin/bash
# Smoke test for notes-export-step.sh — runs against the REAL system to
# verify the four defense-in-depth layers are present and working.
# Safe to run any time; uses a scratch export dir so it cannot damage
# the production /Users/$USER/.cache/apple-notes-mcp/exported.
#
# Run as: bash test_notes_export_smoke.sh
# Exits 0 if all checks pass, 1 otherwise.

set -u
PASS=0
FAIL=0
SCRIPT="/Users/mgandal/Agents/nanoclaw/scripts/sync/notes-export-step.sh"

check() {
  local name="$1"; shift
  if bash -c "$*" >/dev/null 2>&1; then
    echo "✓ $name"
    PASS=$((PASS + 1))
  else
    echo "✗ $name"
    FAIL=$((FAIL + 1))
  fi
}

# Layer 1: Entry-point validation
check "L1: script exists and is executable" "[ -x '$SCRIPT' ]"
check "L1: script validates NOTES_EXPORT_TIMEOUT is numeric" "grep -q 'invalid NOTES_EXPORT_TIMEOUT' '$SCRIPT'"
check "L1: script skips if export-notes.js missing" "grep -q 'NOTES_EXPORT_SCRIPT not found' '$SCRIPT'"

# Layer 2: Business-logic guard
check "L2: detects Notes is frontmost via System Events" "grep -q 'frontmost is true' '$SCRIPT'"
check "L2: skips when Notes is in use" "grep -q 'Notes is in use' '$SCRIPT'"
check "L2: tracks notes_running_before so it doesn't kill user session" "grep -q 'NOTES_RUNNING_BEFORE' '$SCRIPT'"

# Layer 3: Environment guard
check "L3: uses gtimeout for timeout (no perl-alarm orphans)" "grep -q 'gtimeout --kill-after' '$SCRIPT'"
check "L3: NO --foreground (would orphan osascript children)" "! grep -q 'gtimeout.*--foreground' '$SCRIPT'"
check "L3: atomic-rename via tempdir" "grep -q 'EXPORT_TMP' '$SCRIPT' && grep -q 'mv.*NOTES_EXPORT_DIR' '$SCRIPT'"
check "L3: EXIT trap cleans up tempdir on failure" "grep -q 'rm -rf \"\$EXPORT_TMP\"' '$SCRIPT' && grep -q 'EXIT INT TERM' '$SCRIPT'"

# Layer 4: Debug instrumentation
check "L4: logs START with timeout and notes_running_before" "grep -q 'notes-export\\] START:' '$SCRIPT'"
check "L4: differentiates exit codes 124/137/143 in logs" "grep -q '124)' '$SCRIPT' && grep -q '137)' '$SCRIPT' && grep -q '143)' '$SCRIPT'"

# Regression guards
check "REG: NO unconditional 'activate' Notes" "! grep -q 'tell application \"Notes\" to activate' '$SCRIPT'"
check "REG: NO unconditional 'quit' Notes (must be wrapped in NOTES_RUNNING_BEFORE check)" \
  "awk '/tell application \"Notes\" to quit/{found=1; if (prev !~ /NOTES_RUNNING_BEFORE.*false/) exit 1} {prev=\$0} END{exit !found}' '$SCRIPT' \
  || awk '/NOTES_RUNNING_BEFORE.*false/{guard=1} /tell application \"Notes\" to quit/{if (!guard) exit 1; exit 0}' '$SCRIPT'"

# sync-all.sh wiring
check "WIRE: sync-all.sh calls notes-export-step.sh" "grep -q 'notes-export-step.sh' /Users/mgandal/Agents/nanoclaw/scripts/sync/sync-all.sh"
check "WIRE: sync-all.sh handles 124/137/143 exits from the step" "grep -q '124|137|143' /Users/mgandal/Agents/nanoclaw/scripts/sync/sync-all.sh"

# Bats tests
echo ""
echo "Running bats tests..."
if bats /Users/mgandal/Agents/nanoclaw/scripts/sync/tests/test_notes_export_step.bats >/tmp/bats-notes-smoke.log 2>&1; then
  echo "✓ BATS: all 4 contract tests pass"
  PASS=$((PASS + 1))
else
  echo "✗ BATS: contract tests failed — see /tmp/bats-notes-smoke.log"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "─────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
