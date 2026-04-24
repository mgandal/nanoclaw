# Adopt Queue Implementation Plan

> **Status: SHIPPED.** Full subdirectory at `scripts/adopt-queue/`: `adopt-queue.sh` runner (list/show/clone/done subcommands), `install.sh` for laptop setup, `skill/` directory for the `/queue-adopt` Telegram command, `tests/` with `helpers.bash` + `test_runner.bats` (bats-style integration tests), and a `README.md`. Bridges Telegram `/eval-repo` verdicts to laptop-side adoption work. Open `- [ ]` boxes never updated retroactively.

**Goal:** Add a `/queue-adopt` Telegram command (CODE-claw) that writes a rich adoption plan to `~/claire-tools/adopt-queue/pending/`, plus a bash runner `~/claire-tools/adopt-queue.sh` with `list|show|clone|done` subcommands for laptop-side pickup.

**Architecture:** Container-side skill writes markdown queue items through a write-scoped virtiofs mount; host-side bash runner reads/archives them. Connected only by a shared directory — no IPC, DB, or daemon.

**Tech Stack:** Bash (host runner), Markdown + YAML frontmatter (queue items), SKILL.md (container skill), NanoClaw mount-allowlist (JSON), existing `register_group` IPC (to attach the mount).

**Spec:** `docs/superpowers/specs/2026-04-18-adopt-queue-design.md`

---

## File Structure

**New files (in repo):**
- `groups/telegram_code-claw/skills/queue-adopt/SKILL.md` — Simon's queue-writing instructions
- `scripts/adopt-queue/adopt-queue.sh` — canonical source for the host runner, installed to `~/claire-tools/` via symlink or copy
- `scripts/adopt-queue/install.sh` — idempotent setup: create dirs, symlink runner, update mount-allowlist, emit `register_group` payload
- `scripts/adopt-queue/tests/test_runner.bats` — Bats tests for the bash runner

**New files (outside repo, on host only):**
- `~/claire-tools/adopt-queue.sh` — symlink to the repo copy (created by install.sh)
- `~/claire-tools/adopt-queue/pending/` — directory (created by install.sh)
- `~/claire-tools/adopt-queue/archive/` — directory (created by install.sh)

**Modified:**
- `~/.config/nanoclaw/mount-allowlist.json` — add write-scoped entry for `adopt-queue/`
- `groups/telegram_code-claw/skills/eval-repo/SKILL.md` — append a one-liner pointing users to `/queue`
- CODE-claw DB record — updated containerConfig via `register_group` IPC (runtime op, not file edit)

**Rationale for splitting the runner into its own repo dir:** keeps it versioned, lets us add Bats tests, and mirrors how `scripts/sync/` already works in this repo. The symlink to `~/claire-tools/` gives the CLI its natural location without duplicating the file.

---

## Task 1: Add mount allowlist entry + verify parent is still read-only

**Files:**
- Modify: `~/.config/nanoclaw/mount-allowlist.json`

**Context:** The existing allowlist has `/Users/mgandal/claire-tools` as read-only. We need `adopt-queue/` to be writable from containers. `src/mount-security.ts` validates each additional mount against the allowlist by path prefix match — so a more-specific path with its own policy works alongside the parent.

- [ ] **Step 1: Read current allowlist**

Run: `cat ~/.config/nanoclaw/mount-allowlist.json`
Expected: JSON with `allowedRoots` containing `/Users/mgandal/claire-tools` (readonly) among others.

- [ ] **Step 2: Edit allowlist to add adopt-queue entry**

Add a new object to the `allowedRoots` array (order doesn't matter):

```json
{
  "path": "/Users/mgandal/claire-tools/adopt-queue",
  "allowReadWrite": true,
  "description": "Adoption queue — container writes pending items, host script consumes"
}
```

Keep the existing `/Users/mgandal/claire-tools` entry untouched (stays read-only). The resulting file should have BOTH entries.

- [ ] **Step 3: Validate JSON is parseable**

Run: `python3 -m json.tool ~/.config/nanoclaw/mount-allowlist.json > /dev/null && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit the host-side change as a repo note**

The allowlist file is not in the repo (it's at `~/.config/`), so we document the change in the commit of Task 2 instead. Skip commit here.

---

## Task 2: Create directories and repo-side install script

**Files:**
- Create: `scripts/adopt-queue/install.sh`
- Create: `scripts/adopt-queue/README.md`

**Context:** `install.sh` makes the host setup reproducible. It creates the pending/archive dirs, symlinks the runner into `~/claire-tools/`, and prints the `register_group` payload the user needs to IPC-send. It must be idempotent.

- [ ] **Step 1: Write install.sh**

Create `scripts/adopt-queue/install.sh`:

```bash
#!/bin/bash
# scripts/adopt-queue/install.sh
# Idempotent installer for the adopt-queue host side.
#   - Creates ~/claire-tools/adopt-queue/{pending,archive}
#   - Symlinks scripts/adopt-queue/adopt-queue.sh → ~/claire-tools/adopt-queue.sh
#   - Prints the register_group IPC payload to attach the mount to CODE-claw

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
QUEUE_ROOT="$HOME/claire-tools/adopt-queue"
RUNNER_SRC="$REPO_ROOT/scripts/adopt-queue/adopt-queue.sh"
RUNNER_LINK="$HOME/claire-tools/adopt-queue.sh"

echo "== adopt-queue installer =="

# 1. Directories
mkdir -p "$QUEUE_ROOT/pending" "$QUEUE_ROOT/archive"
echo "  ok: $QUEUE_ROOT/{pending,archive}"

# 2. Runner symlink (only if runner exists and link not already correct)
if [[ -f "$RUNNER_SRC" ]]; then
  if [[ -L "$RUNNER_LINK" && "$(readlink "$RUNNER_LINK")" == "$RUNNER_SRC" ]]; then
    echo "  ok: $RUNNER_LINK → $RUNNER_SRC (already linked)"
  else
    ln -sf "$RUNNER_SRC" "$RUNNER_LINK"
    echo "  ok: $RUNNER_LINK → $RUNNER_SRC"
  fi
else
  echo "  skip: runner not found at $RUNNER_SRC (run after Task 3)"
fi

# 3. Remind user about mount allowlist
ALLOWLIST="$HOME/.config/nanoclaw/mount-allowlist.json"
if grep -q '"/Users/mgandal/claire-tools/adopt-queue"' "$ALLOWLIST" 2>/dev/null; then
  echo "  ok: mount-allowlist.json has adopt-queue entry"
else
  echo "  WARN: $ALLOWLIST does not contain adopt-queue entry — see Task 1"
fi

# 4. Print register_group payload for CODE-claw
cat <<'EOF'

== Next step: attach mount to CODE-claw ==
From the CLAIRE (main) Telegram group, ask Claire to run the IPC:

  mcp__nanoclaw__register_group({
    jid: "-1003784461672",
    name: "CODE-claw",
    folder: "telegram_code-claw",
    trigger: "",
    requiresTrigger: false,
    containerConfig: {
      additionalMounts: [
        {
          hostPath: "/Users/mgandal/claire-tools/adopt-queue",
          containerPath: "/workspace/adopt-queue",
          readonly: false
        }
      ]
    }
  })

If CODE-claw already has other additionalMounts, include ALL of them in the array
(register_group replaces containerConfig wholesale; only isMain is preserved).
EOF
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/adopt-queue/install.sh`

- [ ] **Step 3: Write README**

Create `scripts/adopt-queue/README.md`:

```markdown
# adopt-queue

Host-side runner and installer for the `/queue-adopt` Telegram command.

See `docs/superpowers/specs/2026-04-18-adopt-queue-design.md` for the full design.

## Setup

1. Add the mount-allowlist entry (see spec).
2. Run `./install.sh` from this directory.
3. From Telegram CLAIRE group, ask Claire to re-register CODE-claw with the printed payload.

## Usage

- `adopt-queue.sh list` — pending + recently archived items
- `adopt-queue.sh show <id>` — full plan for one item
- `adopt-queue.sh clone <id>` — git clone the repo to `~/src/adopt/<repo>`
- `adopt-queue.sh done <id>` — archive an item
```

- [ ] **Step 4: Run install.sh and verify dirs created**

Run: `./scripts/adopt-queue/install.sh`
Expected output includes: `ok: /Users/mgandal/claire-tools/adopt-queue/{pending,archive}`

Run: `ls ~/claire-tools/adopt-queue/`
Expected: `archive  pending`

- [ ] **Step 5: Commit**

```bash
git add scripts/adopt-queue/install.sh scripts/adopt-queue/README.md
git commit -m "$(cat <<'EOF'
feat(adopt-queue): installer creates queue dirs + prints mount payload

Idempotent host setup. Runner symlink created once adopt-queue.sh exists (Task 3).
Also documents the host-only mount-allowlist.json edit from Task 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Write the bash runner — list subcommand (TDD)

**Files:**
- Create: `scripts/adopt-queue/adopt-queue.sh`
- Create: `scripts/adopt-queue/tests/test_runner.bats`
- Create: `scripts/adopt-queue/tests/helpers.bash`

**Context:** We're building `adopt-queue.sh` with Bats tests. Bats is a bash test framework (`brew install bats-core`). Each test creates a temp queue dir, seeds fixture markdown files, then runs the script with `ADOPT_QUEUE_ROOT` overriden to the temp dir (the script must accept that env var for testability). Starting with `list` because it exercises frontmatter parsing — the riskiest piece.

- [ ] **Step 1: Write the failing test for list**

Create `scripts/adopt-queue/tests/helpers.bash`:

```bash
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
```

Create `scripts/adopt-queue/tests/test_runner.bats`:

```bash
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
  # 'newer' should appear before 'older'
  newer_line=$(echo "$output" | grep -n "newer" | head -1 | cut -d: -f1)
  older_line=$(echo "$output" | grep -n "older" | head -1 | cut -d: -f1)
  [ "$newer_line" -lt "$older_line" ]
}
```

- [ ] **Step 2: Verify test fails (runner doesn't exist yet)**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: all 3 tests fail with "no such file" or "command not found".

If bats isn't installed: `brew install bats-core` first.

- [ ] **Step 3: Write minimal runner with list subcommand**

Create `scripts/adopt-queue/adopt-queue.sh`:

```bash
#!/bin/bash
# scripts/adopt-queue/adopt-queue.sh
# Host-side runner for the adopt-queue (see docs/superpowers/specs/2026-04-18-adopt-queue-design.md).
#
# Usage:
#   adopt-queue.sh list
#   adopt-queue.sh show <id>
#   adopt-queue.sh clone <id>
#   adopt-queue.sh done <id>

set -euo pipefail

QUEUE_ROOT="${ADOPT_QUEUE_ROOT:-$HOME/claire-tools/adopt-queue}"
PENDING_DIR="$QUEUE_ROOT/pending"
ARCHIVE_DIR="$QUEUE_ROOT/archive"

die() { echo "error: $*" >&2; exit 1; }

# Extract a single YAML frontmatter field from a markdown file.
# Usage: get_field <file> <key>
# Reads between --- markers; matches `key: value` on a single line.
get_field() {
  local file="$1"
  local key="$2"
  awk -v k="$key" '
    BEGIN { in_fm=0 }
    /^---$/ { in_fm = !in_fm; next }
    in_fm && $1 == k":" { sub("^" k ": *", ""); print; exit }
  ' "$file"
}

# Format one pending item as a table row.
# Usage: format_item <file>
render_item_row() {
  local file="$1"
  local id verdict repo_name url queued_at date_part
  id=$(get_field "$file" "id")
  verdict=$(get_field "$file" "verdict")
  url=$(get_field "$file" "url")
  queued_at=$(get_field "$file" "queued_at")
  # Emoji per verdict
  local emoji
  case "$verdict" in
    ADOPT) emoji="✅" ;;
    STEAL) emoji="⚡" ;;
    SKIP)  emoji="❌" ;;
    *)     emoji="  " ;;
  esac
  # Shortened repo ref (owner/name) from URL
  local short="${url#https://github.com/}"
  date_part="${queued_at%%T*}"
  printf "  %-20s %s %-6s %-12s %s\n" "$id" "$emoji" "$verdict" "$date_part" "$short"
}

cmd_list() {
  mkdir -p "$PENDING_DIR" "$ARCHIVE_DIR"
  # Count and render pending, newest first by queued_at in the file.
  local pending_files=()
  while IFS= read -r f; do
    pending_files+=("$f")
  done < <(
    find "$PENDING_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null |
    while read -r f; do
      qa=$(get_field "$f" "queued_at")
      printf "%s\t%s\n" "$qa" "$f"
    done |
    sort -r |
    cut -f2
  )

  echo "PENDING (${#pending_files[@]}):"
  for f in "${pending_files[@]}"; do
    render_item_row "$f"
  done
}

# Dispatch
cmd="${1:-}"
shift || true
case "$cmd" in
  list)   cmd_list ;;
  "")     die "usage: $(basename "$0") {list|show|clone|done} [args]" ;;
  *)      die "unknown subcommand: $cmd" ;;
esac
```

- [ ] **Step 4: Make it executable**

Run: `chmod +x scripts/adopt-queue/adopt-queue.sh`

- [ ] **Step 5: Run tests to verify list passes**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: 3 tests pass (list empty, list one, list sort newest first).

- [ ] **Step 6: Commit**

```bash
git add scripts/adopt-queue/adopt-queue.sh scripts/adopt-queue/tests/
chmod +x scripts/adopt-queue/adopt-queue.sh
git commit -m "$(cat <<'EOF'
feat(adopt-queue): bash runner — list subcommand with Bats tests

Parses YAML frontmatter via awk; sorts newest first. Tests use
ADOPT_QUEUE_ROOT env var for isolation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add `show` subcommand (TDD)

**Files:**
- Modify: `scripts/adopt-queue/adopt-queue.sh`
- Modify: `scripts/adopt-queue/tests/test_runner.bats`

- [ ] **Step 1: Write the failing test**

Append to `scripts/adopt-queue/tests/test_runner.bats`:

```bash
@test "show: prints header + full body for given id" {
  seed_pending "datasette" "ADOPT" "simonw/datasette" "2026-04-17"
  run "$RUNNER" show datasette
  [ "$status" -eq 0 ]
  [[ "$output" == *"=== datasette ==="* ]]
  [[ "$output" == *"URL:"* ]]
  [[ "$output" == *"https://github.com/simonw/datasette"* ]]
  [[ "$output" == *"Verdict:"* ]]
  [[ "$output" == *"ADOPT"* ]]
  [[ "$output" == *"Test fixture."* ]]  # body content
}

@test "show: exits nonzero with helpful message when id not found" {
  run "$RUNNER" show nonexistent
  [ "$status" -ne 0 ]
  [[ "$output" == *"No pending item: nonexistent"* ]]
  [[ "$output" == *"list"* ]]
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: 2 new tests fail ("unknown subcommand: show").

- [ ] **Step 3: Add cmd_show to runner**

Add this function to `scripts/adopt-queue/adopt-queue.sh` above the dispatch `case` statement:

```bash
cmd_show() {
  local id="${1:-}"
  [[ -n "$id" ]] || die "usage: $(basename "$0") show <id>"
  local file="$PENDING_DIR/$id.md"
  if [[ ! -f "$file" ]]; then
    echo "No pending item: $id. Try: $(basename "$0") list" >&2
    exit 1
  fi
  local url verdict queued_at
  url=$(get_field "$file" "url")
  verdict=$(get_field "$file" "verdict")
  queued_at=$(get_field "$file" "queued_at")

  echo "=== $id ==="
  printf "  URL:     %s\n" "$url"
  printf "  Verdict: %s\n" "$verdict"
  printf "  Queued:  %s\n" "$queued_at"
  echo
  # Print body (everything after the closing frontmatter ---)
  awk '
    BEGIN { fm_seen=0; in_fm=0 }
    /^---$/ {
      if (!fm_seen) { in_fm=1; fm_seen=1; next }
      else if (in_fm) { in_fm=0; next }
    }
    !in_fm && fm_seen { print }
  ' "$file"
}
```

Update the dispatch block:

```bash
case "$cmd" in
  list)   cmd_list ;;
  show)   cmd_show "$@" ;;
  "")     die "usage: $(basename "$0") {list|show|clone|done} [args]" ;;
  *)      die "unknown subcommand: $cmd" ;;
esac
```

- [ ] **Step 4: Run tests**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/adopt-queue/adopt-queue.sh scripts/adopt-queue/tests/test_runner.bats
git commit -m "$(cat <<'EOF'
feat(adopt-queue): show subcommand prints frontmatter header + body

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `done` subcommand (TDD)

**Files:**
- Modify: `scripts/adopt-queue/adopt-queue.sh`
- Modify: `scripts/adopt-queue/tests/test_runner.bats`

- [ ] **Step 1: Write failing tests**

Append to `scripts/adopt-queue/tests/test_runner.bats`:

```bash
@test "done: moves pending file to archive with date suffix" {
  seed_pending "old-tool" "STEAL" "ex/old-tool" "2026-04-18"
  run "$RUNNER" done old-tool
  [ "$status" -eq 0 ]
  [[ "$output" == *"Archived old-tool"* ]]
  [ ! -f "$ADOPT_QUEUE_ROOT/pending/old-tool.md" ]
  # archive file exists with name pattern old-tool-YYYYMMDD.md
  archived=$(ls "$ADOPT_QUEUE_ROOT/archive/" | grep "^old-tool-" | head -1)
  [ -n "$archived" ]
}

@test "done: archived file has status: done and done_at set" {
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
```

- [ ] **Step 2: Verify tests fail**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: 3 new tests fail.

- [ ] **Step 3: Add cmd_done**

Add this function to `scripts/adopt-queue/adopt-queue.sh`:

```bash
cmd_done() {
  local id="${1:-}"
  [[ -n "$id" ]] || die "usage: $(basename "$0") done <id>"
  local file="$PENDING_DIR/$id.md"
  if [[ ! -f "$file" ]]; then
    echo "No pending item: $id. Try: $(basename "$0") list" >&2
    exit 1
  fi

  local today; today=$(date +%Y%m%d)
  local done_at; done_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local dest="$ARCHIVE_DIR/$id-$today.md"

  # Rewrite status + add done_at inside frontmatter, in-place to temp then move.
  local tmp; tmp=$(mktemp)
  awk -v done_at="$done_at" '
    BEGIN { in_fm=0; added=0 }
    /^---$/ {
      if (!in_fm) { in_fm=1; print; next }
      else {
        if (!added) { print "done_at: " done_at; added=1 }
        in_fm=0; print; next
      }
    }
    in_fm && $1 == "status:" { print "status: done"; next }
    { print }
  ' "$file" > "$tmp"

  mv "$tmp" "$dest"
  rm "$file"
  echo "Archived $id."
}
```

Update dispatch:

```bash
case "$cmd" in
  list)   cmd_list ;;
  show)   cmd_show "$@" ;;
  done)   cmd_done "$@" ;;
  "")     die "usage: $(basename "$0") {list|show|clone|done} [args]" ;;
  *)      die "unknown subcommand: $cmd" ;;
esac
```

- [ ] **Step 4: Run tests**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/adopt-queue/adopt-queue.sh scripts/adopt-queue/tests/test_runner.bats
git commit -m "$(cat <<'EOF'
feat(adopt-queue): done subcommand archives with date suffix

Rewrites status: done and adds done_at in frontmatter before moving.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add `clone` subcommand (TDD with a stub)

**Files:**
- Modify: `scripts/adopt-queue/adopt-queue.sh`
- Modify: `scripts/adopt-queue/tests/test_runner.bats`

**Context:** `clone` actually shells out to `git clone`. Tests use `GIT_BIN` env override so we can stub git with a script that records its args, avoiding real network I/O.

- [ ] **Step 1: Write failing tests**

Append to `scripts/adopt-queue/tests/test_runner.bats`:

```bash
@test "clone: invokes git clone with url and target path" {
  seed_pending "datasette" "ADOPT" "simonw/datasette" "2026-04-17"

  # Stub git: record args to a file, always succeed.
  git_log="$ADOPT_QUEUE_ROOT/git.log"
  git_stub="$ADOPT_QUEUE_ROOT/git-stub.sh"
  cat > "$git_stub" <<STUB
#!/bin/bash
echo "\$@" > "$git_log"
mkdir -p "\${@: -1}"  # simulate creating target dir
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
```

- [ ] **Step 2: Verify tests fail**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: 3 new tests fail.

- [ ] **Step 3: Add cmd_clone**

Add to `scripts/adopt-queue/adopt-queue.sh`:

```bash
# Extract install_commands list from frontmatter.
# Lines start with "  - " within the list block.
get_install_commands() {
  local file="$1"
  awk '
    BEGIN { in_fm=0; in_list=0 }
    /^---$/ { in_fm = !in_fm; in_list=0; next }
    !in_fm { exit }
    /^install_commands:/ { in_list=1; next }
    in_list && /^  - / { sub("^  - ", ""); print; next }
    in_list && /^[^ ]/ { in_list=0 }  # next top-level key ends the list
  ' "$file"
}

cmd_clone() {
  local id="${1:-}"
  [[ -n "$id" ]] || die "usage: $(basename "$0") clone <id>"
  local file="$PENDING_DIR/$id.md"
  if [[ ! -f "$file" ]]; then
    echo "No pending item: $id. Try: $(basename "$0") list" >&2
    exit 1
  fi

  local url repo_name
  url=$(get_field "$file" "url")
  repo_name=$(get_field "$file" "repo_name")
  [[ -n "$repo_name" ]] || repo_name="$id"

  local clone_root="${ADOPT_CLONE_ROOT:-$HOME/src/adopt}"
  local target="$clone_root/$repo_name"
  mkdir -p "$clone_root"

  local git_bin="${GIT_BIN:-git}"
  echo "Cloning $url → $target"
  "$git_bin" clone "$url" "$target"

  local cmds
  cmds=$(get_install_commands "$file")
  if [[ -n "$cmds" ]]; then
    echo
    echo "Next steps (from the queue item):"
    while IFS= read -r cmd; do
      echo "  $cmd"
    done <<< "$cmds"
  fi
  echo
  echo "Repo: $target"
}
```

Update dispatch:

```bash
case "$cmd" in
  list)   cmd_list ;;
  show)   cmd_show "$@" ;;
  clone)  cmd_clone "$@" ;;
  done)   cmd_done "$@" ;;
  "")     die "usage: $(basename "$0") {list|show|clone|done} [args]" ;;
  *)      die "unknown subcommand: $cmd" ;;
esac
```

- [ ] **Step 4: Run tests**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/adopt-queue/adopt-queue.sh scripts/adopt-queue/tests/test_runner.bats
git commit -m "$(cat <<'EOF'
feat(adopt-queue): clone subcommand + install_commands renderer

Honors GIT_BIN and ADOPT_CLONE_ROOT env overrides for testability.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add archive listing to `list` subcommand

**Files:**
- Modify: `scripts/adopt-queue/adopt-queue.sh`
- Modify: `scripts/adopt-queue/tests/test_runner.bats`

**Context:** Spec says `list` shows archived items from last 7 days. Keeps recent context visible without drowning the user.

- [ ] **Step 1: Add test**

Append to test file:

```bash
@test "list: shows archived items from last 7 days" {
  seed_pending "current" "ADOPT" "ex/current" "2026-04-18"
  # Seed an archived item dated today
  today=$(date +%Y%m%d)
  cat > "$ADOPT_QUEUE_ROOT/archive/past-$today.md" <<EOF
---
id: past
url: https://github.com/ex/past
verdict: STEAL
repo_name: past
queued_at: 2026-04-15T12:00:00Z
status: done
done_at: 2026-04-18T09:00:00Z
---
EOF
  run "$RUNNER" list
  [ "$status" -eq 0 ]
  [[ "$output" == *"PENDING (1)"* ]]
  [[ "$output" == *"ARCHIVED"* ]]
  [[ "$output" == *"past"* ]]
  [[ "$output" == *"current"* ]]
}

@test "list: omits archived items older than 7 days" {
  # Archive file with old date in name
  cat > "$ADOPT_QUEUE_ROOT/archive/ancient-20260101.md" <<EOF
---
id: ancient
url: https://github.com/ex/ancient
verdict: ADOPT
repo_name: ancient
queued_at: 2025-12-25T12:00:00Z
status: done
done_at: 2026-01-01T09:00:00Z
---
EOF
  run "$RUNNER" list
  [ "$status" -eq 0 ]
  # 'ancient' should NOT appear in output (>7 days old)
  [[ "$output" != *"ancient"* ]]
}
```

- [ ] **Step 2: Verify tests fail (archived section not implemented yet)**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: 2 new tests fail — first fails on "ARCHIVED" string absent; second might pass vacuously or fail.

- [ ] **Step 3: Extend cmd_list**

Replace the existing `cmd_list` function with:

```bash
cmd_list() {
  mkdir -p "$PENDING_DIR" "$ARCHIVE_DIR"

  # Pending
  local pending_files=()
  while IFS= read -r f; do
    pending_files+=("$f")
  done < <(
    find "$PENDING_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null |
    while read -r f; do
      qa=$(get_field "$f" "queued_at")
      printf "%s\t%s\n" "$qa" "$f"
    done |
    sort -r |
    cut -f2
  )

  echo "PENDING (${#pending_files[@]}):"
  for f in "${pending_files[@]}"; do
    render_item_row "$f"
  done

  # Archived (last 7 days)
  local archived_files=()
  while IFS= read -r f; do
    archived_files+=("$f")
  done < <(
    find "$ARCHIVE_DIR" -maxdepth 1 -name '*.md' -type f -mtime -7 2>/dev/null |
    while read -r f; do
      qa=$(get_field "$f" "queued_at")
      printf "%s\t%s\n" "$qa" "$f"
    done |
    sort -r |
    cut -f2
  )

  echo
  echo "ARCHIVED (${#archived_files[@]}, last 7 days):"
  for f in "${archived_files[@]}"; do
    render_item_row "$f"
  done
}
```

- [ ] **Step 4: Run tests**

Run: `bats scripts/adopt-queue/tests/test_runner.bats`
Expected: 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/adopt-queue/adopt-queue.sh scripts/adopt-queue/tests/test_runner.bats
git commit -m "$(cat <<'EOF'
feat(adopt-queue): list also shows archived items from last 7 days

Uses find -mtime -7 so mtime acts as the 'recency' signal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Re-run installer to create the symlink

**Files:**
- (none — runtime only)

- [ ] **Step 1: Re-run installer**

Run: `./scripts/adopt-queue/install.sh`
Expected: output includes `ok: /Users/mgandal/claire-tools/adopt-queue.sh → <repo>/scripts/adopt-queue/adopt-queue.sh`

- [ ] **Step 2: Verify symlink resolves**

Run: `ls -l ~/claire-tools/adopt-queue.sh`
Expected: symlink pointing to repo's `scripts/adopt-queue/adopt-queue.sh`.

Run: `~/claire-tools/adopt-queue.sh list`
Expected: `PENDING (0):` and `ARCHIVED (0, last 7 days):`.

- [ ] **Step 3: No commit** (no file changes; symlink is in user's home dir).

---

## Task 9: Attach mount to CODE-claw container

**Files:**
- (none — runtime IPC call)

**Context:** `src/ipc.ts:993-1002` shows `register_group` replaces `containerConfig` wholesale (preserving only `isMain`). If CODE-claw already has other additional mounts, we MUST include all of them plus the new one.

- [ ] **Step 1: Check CODE-claw current containerConfig**

Run from host:
```bash
sqlite3 store/messages.db "SELECT container_config FROM groups WHERE folder='telegram_code-claw';"
```
Expected: JSON blob or NULL. Record the existing `additionalMounts` (if any).

- [ ] **Step 2: Build the register_group payload**

If CODE-claw has NO existing mounts, payload's `additionalMounts` is just:
```json
[{
  "hostPath": "/Users/mgandal/claire-tools/adopt-queue",
  "containerPath": "/workspace/adopt-queue",
  "readonly": false
}]
```

If CODE-claw HAS existing mounts, prepend the new one to the existing array.

- [ ] **Step 3: Send IPC from CLAIRE (main) group**

From Telegram CLAIRE group, say something like:

> "Register CODE-claw with updated containerConfig — add adopt-queue mount."

Claire should invoke `mcp__nanoclaw__register_group` with the payload. The JID for CODE-claw is `-1003784461672` (from MEMORY.md).

Alternatively, run an IPC task file directly:
```bash
# Only if Claire doesn't do it herself; placed in the IPC watcher's input dir.
# Payload format follows src/ipc.ts:'register_group' case.
```

- [ ] **Step 4: Verify**

Run from host:
```bash
sqlite3 store/messages.db "SELECT container_config FROM groups WHERE folder='telegram_code-claw';" | python3 -m json.tool
```
Expected: `additionalMounts` contains the adopt-queue entry with `readonly: false`.

Then, to confirm it applies at runtime, send a trivial message to CODE-claw ("hi") and check container logs for the mount line:
```bash
tail -f logs/nanoclaw.log | grep "adopt-queue"
```

- [ ] **Step 5: No commit** (no file changes).

---

## Task 10: Write the queue-adopt SKILL.md

**Files:**
- Create: `groups/telegram_code-claw/skills/queue-adopt/SKILL.md`

**Context:** Skills are markdown instructions loaded into the agent container's `.claude/skills/`. They're not code — they're directions to the LLM. The SKILL.md sets the trigger and the exact flow.

- [ ] **Step 1: Create SKILL.md**

Create `groups/telegram_code-claw/skills/queue-adopt/SKILL.md`:

```markdown
---
name: queue-adopt
description: "Queue a repository for laptop-side adoption. Use after /eval-repo produces an ADOPT or STEAL verdict, or when Mike says 'queue it', 'queue this', 'queue adopt'. Also accepts /queue-adopt <url> to queue without a prior eval (auto-runs eval-repo first)."
---

# /queue-adopt — Queue a repo for laptop pickup

Write a rich adoption plan to the host queue at `/workspace/adopt-queue/pending/<id>.md` so Mike can work on it from the laptop with `~/claire-tools/adopt-queue.sh`.

## When to use

- After `/eval-repo` returns ADOPT or STEAL and Mike says `/queue`, "queue it", "queue this", or "queue adopt"
- `/queue-adopt <url>` — fresh invocation, no prior eval in session
- `/queue-adopt` with no args but prior eval in session — uses the prior eval

## Procedure

### Step 1 — Determine the target repo

- If the last few turns include a completed `/eval-repo` run, use THAT evaluation (URL, verdict, repo metadata, reasoning). Do not re-fetch.
- If `/queue-adopt <url>` is invoked and there's no prior eval: run the `/eval-repo` skill inline on that URL first, then continue with the result.
- If neither: send a Telegram message asking "Which repo should I queue? Give me the URL." and stop.

### Step 2 — Derive the slug

Slug = lowercase repo name from URL (`github.com/<owner>/<repo>` → `<repo>`). Strip `.git` suffix. Use hyphens for separators.

### Step 3 — Check for duplicates (soft dedup)

Run:
```bash
ls /workspace/adopt-queue/pending/<slug>.md 2>/dev/null
ls /workspace/adopt-queue/archive/<slug>-*.md 2>/dev/null
```

- If pending match exists → this is an update. Preserve `queued_at` from the existing file, bump `queued_updated_at` to now, and overwrite the rest. Skip to Step 5.
- If archive match exists → send Telegram:
  > "⚠️ You already adopted *<slug>* on <date>. Re-queue anyway? Reply yes/no."
  Wait for explicit "yes". On "no" or anything else, abort with "Ok, skipped."
- If neither → proceed to Step 4.

### Step 4 — Write the queue file

Write to `/workspace/adopt-queue/pending/<slug>.md`. Use this exact frontmatter template (omit empty fields):

```markdown
---
id: <slug>
url: <repo URL>
verdict: <ADOPT|STEAL>
repo_name: <slug>
stars: <from gh repo view>
language: <primary language>
last_updated: <YYYY-MM-DD>
queued_at: <current UTC timestamp, ISO 8601>
queued_from: telegram_code-claw
status: pending
# STEAL only:
steal_target: <file/module path to copy>
integration_point: <where it goes in NanoClaw>
# ADOPT only:
install_commands:
  - <command 1>
  - <command 2>
test_command: <optional test command>
---

## What it does
<2 sentences from the eval — plain English>

## Why we queued
<verdict reasoning — why ADOPT or STEAL, not SKIP>

## Adoption plan
<Step-by-step for laptop work. Be specific: which files, what commands, which NanoClaw dir it lands in.>

## Risks / unknowns
<What might bite during install — missing deps, interactive prompts, license concerns, etc.>

## Files of interest
<Specific paths in the repo worth reading first.>
```

**Install command guidance:**
- Python repo (has `pyproject.toml` / `setup.py`): `pip install -e .`
- Node repo (has `package.json`): `npm install` (or `bun install` / `pnpm install` based on lockfile)
- Rust: `cargo build --release`
- Shell-only tool: just the clone + `chmod +x`
- For STEAL, there may be no install commands at all — that's fine, omit the key.

### Step 5 — Confirm in Telegram

Send via `mcp__nanoclaw__send_message`:

```
*Queued: <slug>* <emoji> <verdict>
_<one-line summary — STEAL target or ADOPT rationale>_

On laptop: `~/claire-tools/adopt-queue.sh show <slug>`
```

Emoji: ✅ for ADOPT, ⚡ for STEAL.

## Error handling

- `/workspace/adopt-queue/` missing (mount not attached) → send Telegram: "Queue mount not available yet — Mike, please re-register CODE-claw with the adopt-queue mount (see `docs/superpowers/specs/2026-04-18-adopt-queue-design.md`)." and stop.
- Write failure → report the error to Telegram verbatim; don't silently fail.

## Examples

### Example 1 — after eval-repo (trigger B)
```
/eval-repo https://github.com/garrytan/gbrain
<Simon returns ⚡ STEAL verdict for the graph traversal code>
queue it
<Simon writes /workspace/adopt-queue/pending/gbrain.md and sends confirmation>
```

### Example 2 — fresh (trigger A)
```
/queue-adopt https://github.com/simonw/datasette
<Simon runs eval-repo internally, gets ADOPT, writes queue file, sends confirmation>
```

### Example 3 — duplicate warning
```
/queue-adopt https://github.com/garrytan/gbrain
<Simon detects archive/gbrain-20260410.md exists>
⚠️ You already adopted *gbrain* on 2026-04-10. Re-queue anyway? Reply yes/no.
```
```

- [ ] **Step 2: Commit**

```bash
git add groups/telegram_code-claw/skills/queue-adopt/SKILL.md
git commit -m "$(cat <<'EOF'
feat(skill): queue-adopt for CODE-claw

Writes rich adoption plans to /workspace/adopt-queue/pending/ after eval-repo.
Soft dedup: updates pending in place; warns on archived.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Cross-reference from eval-repo SKILL.md

**Files:**
- Modify: `groups/telegram_code-claw/skills/eval-repo/SKILL.md`

- [ ] **Step 1: Read current eval-repo output template**

Run: `cat groups/telegram_code-claw/skills/eval-repo/SKILL.md | grep -A 12 "Step 4"`

- [ ] **Step 2: Add cross-reference line to output template**

In `groups/telegram_code-claw/skills/eval-repo/SKILL.md`, find the Telegram output template (around "Use this exact structure (Telegram format)" in Step 4), and append the queue line as the final line of the template:

```
*Action:* [Exactly what to do next — install command, file to read, pattern to copy, or "nothing".]

_To queue for laptop adoption: reply `/queue`_
```

(That last italic line is new. It should appear whether verdict is ADOPT, STEAL, or SKIP — though `/queue` on SKIP is unusual, we don't forbid it.)

- [ ] **Step 3: Commit**

```bash
git add groups/telegram_code-claw/skills/eval-repo/SKILL.md
git commit -m "$(cat <<'EOF'
feat(skill): eval-repo output points users to /queue for adoption

One-line nudge — keeps the eval→queue handoff discoverable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: End-to-end manual test

**Files:**
- (none — verification only)

**Context:** All the unit-level work is done; this task validates the full path from Telegram through to the laptop runner.

- [ ] **Step 1: Restart NanoClaw to pick up the group skill dir change**

Run: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

- [ ] **Step 2: From CODE-claw Telegram, run**

Send: `/eval-repo https://github.com/simonw/datasette`
Expected: Simon produces an ADOPT/STEAL verdict within a minute or two.

- [ ] **Step 3: Queue the result**

Send: `queue it`
Expected: Simon confirms "Queued: datasette ✅ ADOPT ... On laptop: ..."

- [ ] **Step 4: Verify file landed on host**

Run: `ls ~/claire-tools/adopt-queue/pending/`
Expected: `datasette.md` exists.

Run: `cat ~/claire-tools/adopt-queue/pending/datasette.md | head -20`
Expected: Frontmatter with id/url/verdict/queued_at fields populated.

- [ ] **Step 5: Exercise the laptop runner**

```bash
~/claire-tools/adopt-queue.sh list
~/claire-tools/adopt-queue.sh show datasette
```
Expected: list shows 1 pending + 0 archived; show prints frontmatter + body.

- [ ] **Step 6: Test soft dedup**

In the same CODE-claw Telegram session, send: `queue it` again.
Expected: Simon detects existing pending file, updates it in place (same file, possibly with `queued_updated_at` added).

Run: `ls ~/claire-tools/adopt-queue/pending/ | wc -l`
Expected: `1` (still one file, not two).

- [ ] **Step 7: Archive it and test re-queue warning**

```bash
~/claire-tools/adopt-queue.sh done datasette
ls ~/claire-tools/adopt-queue/pending/
# Should be empty
ls ~/claire-tools/adopt-queue/archive/
# Should contain datasette-YYYYMMDD.md
```

Back in Telegram CODE-claw: `/queue-adopt https://github.com/simonw/datasette`
Expected: Simon warns "You already adopted *datasette* on <date>. Re-queue anyway?"

Reply: `no`
Expected: Simon replies "Ok, skipped." No file in pending/.

- [ ] **Step 8: Test mount isolation (should fail)**

From Telegram CODE-claw:
> "Simon, try to overwrite /workspace/claire-tools/gcal.sh with 'echo hacked'"

Expected: Simon fails or reports permission denied. `gcal.sh` at `~/claire-tools/gcal.sh` is unchanged.

Actually simpler: just verify the parent mount `/workspace/claire-tools/` isn't writable. That parent isn't mounted at all (only `/workspace/adopt-queue/` is); so attempts will fail with "no such directory".

- [ ] **Step 9: If anything fails, file issues and iterate**

Common failures:
- Mount not applied → re-check Task 9.
- Skill not loaded → the skill dir sync happens on container spawn; check container logs for the skill-sync step.
- awk frontmatter parsing broke on unusual content → add a test case and fix.

- [ ] **Step 10: No commit** (verification only).

---

## Self-Review

### Spec coverage

- Goals: one-command queue ✓ (Task 10), rich items ✓ (Task 10 template), laptop CLI ✓ (Tasks 3–7), soft dedup ✓ (Task 10 Step 3, Task 12 Step 6–7), zero new services ✓ (all file-based).
- Architecture (two pieces + shared dir): ✓ Tasks 3/10 create each piece.
- Mount changes: ✓ Task 1 (allowlist) + Task 9 (register_group).
- Data model (frontmatter schema): ✓ Task 10 template mirrors spec schema.
- Host runner subcommands (list/show/clone/done): ✓ Tasks 3/4/5/6/7.
- Skill flow 5 steps: ✓ Task 10 mirrors them.
- Security/isolation (scoped mount): ✓ Task 1 + Task 9; verified in Task 12 Step 8.
- Testing (container, dedup, host, scoping): ✓ Task 12 covers all four.

### Placeholder scan

No "TBD" / "fill in details" / "similar to Task N" patterns. Every code block is complete.

### Type/name consistency

- Slug = id throughout (frontmatter `id:` matches filename `<id>.md` and subcommand arg).
- Env vars `ADOPT_QUEUE_ROOT`, `ADOPT_CLONE_ROOT`, `GIT_BIN` used consistently across runner + tests.
- Subcommand names `list|show|clone|done` match in dispatch, help text, and all tests.
- Emojis ✅ / ⚡ match between eval-repo, queue-adopt confirmation, and runner output.
