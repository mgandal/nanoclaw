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

@test "done: moves pending file to archive with date suffix" {
  seed_pending "old-tool" "STEAL" "ex/old-tool" "2026-04-18"
  run "$RUNNER" done old-tool
  [ "$status" -eq 0 ]
  [[ "$output" == *"Archived old-tool"* ]]
  [ ! -f "$ADOPT_QUEUE_ROOT/pending/old-tool.md" ]
  archived=$(ls "$ADOPT_QUEUE_ROOT/archive/" | grep "^old-tool-" | head -1)
  [ -n "$archived" ]
}

@test "done: archived file has status done and done_at set" {
  seed_pending "old-tool" "ADOPT" "ex/old-tool" "2026-04-18"
  run "$RUNNER" done old-tool
  archived=$(ls "$ADOPT_QUEUE_ROOT/archive/" | grep "^old-tool-" | head -1)
  content=$(cat "$ADOPT_QUEUE_ROOT/archive/$archived")
  [[ "$content" == *"status: done"* ]]
  [[ "$content" == *"done_at:"* ]]
}

@test "done: exits nonzero when id not in pending" {
  run "$RUNNER" done nonexistent
  [ "$status" -ne 0 ]
  [[ "$output" == *"No pending item: nonexistent"* ]]
}

@test "clone: invokes git clone with url and target path" {
  seed_pending "datasette" "ADOPT" "simonw/datasette" "2026-04-17"

  git_log="$ADOPT_QUEUE_ROOT/git.log"
  git_stub="$ADOPT_QUEUE_ROOT/git-stub.sh"
  cat > "$git_stub" <<STUB
#!/bin/bash
echo "\$@" > "$git_log"
mkdir -p "\${@: -1}"
STUB
  chmod +x "$git_stub"

  export GIT_BIN="$git_stub"
  export ADOPT_CLONE_ROOT="$ADOPT_QUEUE_ROOT/src-adopt"

  run "$RUNNER" clone datasette
  [ "$status" -eq 0 ]
  [ -f "$git_log" ]
  logged=$(cat "$git_log")
  [[ "$logged" == *"clone"* ]]
  [[ "$logged" == *"https://github.com/simonw/datasette"* ]]
  [[ "$logged" == *"datasette"* ]]
}

@test "clone: prints install commands from frontmatter after cloning" {
  cat > "$ADOPT_QUEUE_ROOT/pending/mylib.md" <<EOF
---
id: mylib
url: https://github.com/ex/mylib
verdict: ADOPT
repo_name: mylib
queued_at: 2026-04-18T12:00:00Z
status: pending
install_commands:
  - pip install -e .
  - pytest tests/
---

body
EOF

  git_stub="$ADOPT_QUEUE_ROOT/git-stub.sh"
  cat > "$git_stub" <<STUB
#!/bin/bash
mkdir -p "\${@: -1}"
STUB
  chmod +x "$git_stub"
  export GIT_BIN="$git_stub"
  export ADOPT_CLONE_ROOT="$ADOPT_QUEUE_ROOT/src-adopt"

  run "$RUNNER" clone mylib
  [ "$status" -eq 0 ]
  [[ "$output" == *"pip install -e ."* ]]
  [[ "$output" == *"pytest tests/"* ]]
}

@test "clone: exits nonzero when id not found" {
  run "$RUNNER" clone nonexistent
  [ "$status" -ne 0 ]
}
