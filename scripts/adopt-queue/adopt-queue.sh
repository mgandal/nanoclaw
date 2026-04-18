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

cmd_list() {
  mkdir -p "$PENDING_DIR" "$ARCHIVE_DIR"
  local pending_files=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && pending_files+=("$f")
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
  if [[ ${#pending_files[@]} -gt 0 ]]; then
    for f in "${pending_files[@]}"; do
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

cmd="${1:-}"
shift || true
case "$cmd" in
  list)   cmd_list ;;
  show)   cmd_show "$@" ;;
  "")     die "usage: $(basename "$0") {list|show|clone|done} [args]" ;;
  *)      die "unknown subcommand: $cmd" ;;
esac
