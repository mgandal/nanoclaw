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
get_field() {
  local file="$1"
  local key="$2"
  awk -v k="$key" '
    BEGIN { in_fm=0 }
    /^---$/ { in_fm = !in_fm; next }
    in_fm && $1 == k":" { sub("^" k ": *", ""); print; exit }
  ' "$file"
}

render_item_row() {
  local file="$1"
  local id verdict url queued_at date_part
  id=$(get_field "$file" "id")
  verdict=$(get_field "$file" "verdict")
  url=$(get_field "$file" "url")
  queued_at=$(get_field "$file" "queued_at")
  local emoji
  case "$verdict" in
    ADOPT) emoji="✅" ;;
    STEAL) emoji="⚡" ;;
    SKIP)  emoji="❌" ;;
    *)     emoji="  " ;;
  esac
  local short="${url#https://github.com/}"
  date_part="${queued_at%%T*}"
  printf "  %-20s %s %-6s %-12s %s\n" "$id" "$emoji" "$verdict" "$date_part" "$short"
}

_collect_sorted() {
  local dir="$1"
  local max_days="${2:-}"
  local find_args=(-maxdepth 1 -name '*.md' -type f)
  [[ -n "$max_days" ]] && find_args+=(-mtime "-$max_days")
  find "$dir" "${find_args[@]}" 2>/dev/null |
    while read -r f; do
      qa=$(get_field "$f" "queued_at")
      printf "%s\t%s\n" "$qa" "$f"
    done |
    sort -r |
    cut -f2
}

cmd_list() {
  mkdir -p "$PENDING_DIR" "$ARCHIVE_DIR"

  local pending_files=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && pending_files+=("$f")
  done < <(_collect_sorted "$PENDING_DIR")

  echo "PENDING (${#pending_files[@]}):"
  if [[ ${#pending_files[@]} -gt 0 ]]; then
    for f in "${pending_files[@]}"; do
      render_item_row "$f"
    done
  fi

  local archived_files=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && archived_files+=("$f")
  done < <(_collect_sorted "$ARCHIVE_DIR" 7)

  echo
  echo "ARCHIVED (${#archived_files[@]}, last 7 days):"
  if [[ ${#archived_files[@]} -gt 0 ]]; then
    for f in "${archived_files[@]}"; do
      render_item_row "$f"
    done
  fi
}

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
  awk '
    BEGIN { fm_seen=0; in_fm=0 }
    /^---$/ {
      if (!fm_seen) { in_fm=1; fm_seen=1; next }
      else if (in_fm) { in_fm=0; next }
    }
    !in_fm && fm_seen { print }
  ' "$file"
}

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

  mkdir -p "$ARCHIVE_DIR"
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

get_install_commands() {
  local file="$1"
  awk '
    BEGIN { in_fm=0; in_list=0 }
    /^---$/ { in_fm = !in_fm; in_list=0; next }
    !in_fm { exit }
    /^install_commands:/ { in_list=1; next }
    in_list && /^  - / { sub("^  - ", ""); print; next }
    in_list && /^[^ ]/ { in_list=0 }
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

cmd="${1:-}"
shift || true
case "$cmd" in
  list)   cmd_list ;;
  show)   cmd_show "$@" ;;
  clone)  cmd_clone "$@" ;;
  done)   cmd_done "$@" ;;
  "")     die "usage: $(basename "$0") {list|show|clone|done} [args]" ;;
  *)      die "unknown subcommand: $cmd" ;;
esac
