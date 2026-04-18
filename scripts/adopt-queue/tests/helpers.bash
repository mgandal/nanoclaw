# scripts/adopt-queue/tests/helpers.bash
# Shared test setup: create an isolated queue dir for each test.

setup_queue() {
  export ADOPT_QUEUE_ROOT="$(mktemp -d -t adopt-queue.XXXXXX)"
  mkdir -p "$ADOPT_QUEUE_ROOT/pending" "$ADOPT_QUEUE_ROOT/archive"
}

teardown_queue() {
  rm -rf "$ADOPT_QUEUE_ROOT"
}

# Write a fixture pending item with the given id and verdict.
seed_pending() {
  local id="$1"
  local verdict="$2"
  local repo="${3:-example/$id}"
  local date="${4:-2026-04-18}"
  cat > "$ADOPT_QUEUE_ROOT/pending/$id.md" <<EOF
---
id: $id
url: https://github.com/$repo
verdict: $verdict
repo_name: $id
queued_at: ${date}T12:00:00Z
status: pending
---

## What it does
Test fixture.
EOF
}
