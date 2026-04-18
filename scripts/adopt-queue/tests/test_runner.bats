#!/usr/bin/env bats
# scripts/adopt-queue/tests/test_runner.bats

load helpers

RUNNER="${BATS_TEST_DIRNAME}/../adopt-queue.sh"

setup() { setup_queue; }
teardown() { teardown_queue; }

@test "list: empty queue shows no pending items" {
  run "$RUNNER" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"PENDING (0)"* ]]
}

@test "list: shows one pending item with verdict" {
  seed_pending "gbrain" "STEAL" "garrytan/gbrain" "2026-04-18"
  run "$RUNNER" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"PENDING (1)"* ]]
  [[ "$output" == *"gbrain"* ]]
  [[ "$output" == *"STEAL"* ]]
  [[ "$output" == *"garrytan/gbrain"* ]]
}

@test "list: sorts pending items newest first by queued_at" {
  seed_pending "older" "ADOPT" "ex/older" "2026-04-10"
  seed_pending "newer" "STEAL" "ex/newer" "2026-04-18"
  run "$RUNNER" list
  [ "$status" -eq 0 ]
  newer_line=$(echo "$output" | grep -n "newer" | head -1 | cut -d: -f1)
  older_line=$(echo "$output" | grep -n "older" | head -1 | cut -d: -f1)
  [ "$newer_line" -lt "$older_line" ]
}

@test "show: prints header + full body for given id" {
  seed_pending "datasette" "ADOPT" "simonw/datasette" "2026-04-17"
  run "$RUNNER" show datasette
  [ "$status" -eq 0 ]
  [[ "$output" == *"=== datasette ==="* ]]
  [[ "$output" == *"URL:"* ]]
  [[ "$output" == *"https://github.com/simonw/datasette"* ]]
  [[ "$output" == *"Verdict:"* ]]
  [[ "$output" == *"ADOPT"* ]]
  [[ "$output" == *"Test fixture."* ]]
}

@test "show: exits nonzero with helpful message when id not found" {
  run "$RUNNER" show nonexistent
  [ "$status" -ne 0 ]
  [[ "$output" == *"No pending item: nonexistent"* ]]
  [[ "$output" == *"list"* ]]
}
