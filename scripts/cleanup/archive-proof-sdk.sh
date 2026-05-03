#!/bin/bash
# One-shot cleanup: archive proof-sdk/.env values to macOS Keychain, then rm -rf
# the directory. Spec: docs/superpowers/specs/2026-05-03-proof-sdk-archive-design.md
#
# Idempotent on re-run before Phase 3. After Phase 3 succeeds, re-running
# aborts in Phase 1 (proof-sdk dir not found) — by design.
#
# Usage: ./scripts/cleanup/archive-proof-sdk.sh
# (Run from repo root; the script does NOT cd to anywhere.)

set -euo pipefail

REPO_ROOT="/Users/mgandal/Agents/nanoclaw"
PROOF_SDK_DIR="$REPO_ROOT/groups/telegram_code-claw/proof-sdk"
ENV_FILE="$PROOF_SDK_DIR/.env"
SERVICE="proof-sdk-archived-2026-05-03"
EXPECTED_KEYS=(PORT PROOF_SHARE_MARKDOWN_AUTH_MODE PROOF_SHARE_MARKDOWN_API_KEY PROOF_PUBLIC_BASE_URL)

# ----------------------------------------------------------------------------
# Phase 1: Pre-flight (read-only)
# ----------------------------------------------------------------------------

echo "=== Phase 1: pre-flight ==="

# 1a. macOS-only
if [ "$(uname)" != "Darwin" ]; then
  echo "FAIL: this script is macOS-only (uname=$(uname))" >&2
  exit 2
fi

# 1b. security CLI available
if ! command -v security >/dev/null 2>&1; then
  echo "FAIL: 'security' CLI not in PATH" >&2
  exit 2
fi

# 1c. proof-sdk dir exists
if [ ! -d "$PROOF_SDK_DIR" ]; then
  echo "FAIL: $PROOF_SDK_DIR not found (already cleaned up?)" >&2
  exit 2
fi

# 1d. proof-sdk has its own .git (sanity: it's a clone, not NanoClaw subdir)
if [ ! -d "$PROOF_SDK_DIR/.git" ]; then
  echo "FAIL: $PROOF_SDK_DIR has no .git — refusing to delete (not the expected vendored clone)" >&2
  exit 2
fi

# 1e. .env exists
if [ ! -f "$ENV_FILE" ]; then
  echo "FAIL: $ENV_FILE not found — nothing to archive" >&2
  exit 2
fi

# 1f. .env has the 4 expected keys (no extras, no missing)
declare -a found_keys=()
while IFS='=' read -r key _; do
  case "$key" in
    ''|\#*) continue ;;
    *) found_keys+=("$key") ;;
  esac
done < "$ENV_FILE"

# Empty-.env guard — under macOS's bash 3.2, `${found_keys[@]}` on an empty
# array errors with "unbound variable" before reaching the comparison below.
# Surface it cleanly here instead.
if [ ${#found_keys[@]} -eq 0 ]; then
  echo "FAIL: $ENV_FILE has no key=value lines" >&2
  exit 2
fi

# Compare sets
expected_sorted=$(printf '%s\n' "${EXPECTED_KEYS[@]}" | sort)
found_sorted=$(printf '%s\n' "${found_keys[@]}" | sort)
if [ "$expected_sorted" != "$found_sorted" ]; then
  echo "FAIL: .env keys don't match expected set" >&2
  echo "  expected: $(printf '%s ' "${EXPECTED_KEYS[@]}")" >&2
  echo "  found:    $(printf '%s ' "${found_keys[@]}")" >&2
  exit 2
fi

# 1g. No NanoClaw references to proof-sdk (guard against drift since 2026-05-03 investigation)
# `|| true` inside the brace group: under `set -euo pipefail`, an empty
# `grep -v` exits 1 and would abort the script silently. The brace+|| true
# isolates that to the filter chain, leaving wc -l free to count zero
# matches. Do NOT remove the `|| true` — it's load-bearing.
ref_count=$({ grep -rIln 'proof-sdk\|proof_sdk' \
                --include='*.ts' --include='*.py' --include='*.sh' --include='*.json' \
                "$REPO_ROOT/src" "$REPO_ROOT/scripts" "$REPO_ROOT/container" 2>/dev/null \
              | grep -v 'proof-sdk/' \
              | grep -v 'scripts/cleanup/' \
              || true; } | wc -l | tr -d ' ')
if [ "$ref_count" -ne 0 ]; then
  echo "FAIL: $ref_count NanoClaw file(s) reference proof-sdk — refusing to delete" >&2
  echo "  Re-investigate before re-running:" >&2
  { grep -rIln 'proof-sdk\|proof_sdk' \
      --include='*.ts' --include='*.py' --include='*.sh' --include='*.json' \
      "$REPO_ROOT/src" "$REPO_ROOT/scripts" "$REPO_ROOT/container" 2>/dev/null \
    | grep -v 'proof-sdk/' \
    | grep -v 'scripts/cleanup/' \
    || true; } >&2
  exit 2
fi

# 1h. Snapshot directory size for post-delete confirmation
DIR_SIZE_KB=$(du -sk "$PROOF_SDK_DIR" | awk '{print $1}')
DIR_FILE_COUNT=$(find "$PROOF_SDK_DIR" -type f | wc -l | tr -d ' ')
echo "  pre-flight OK: $DIR_FILE_COUNT files, ${DIR_SIZE_KB}K"

# ----------------------------------------------------------------------------
# Phase 2: Archive to keychain with round-trip integrity check
# ----------------------------------------------------------------------------

echo ""
echo "=== Phase 2: archive to keychain ==="

for key in "${EXPECTED_KEYS[@]}"; do
  # Extract the value (everything after the first '='). Handles values
  # that themselves contain '=' (e.g. base64-padded API keys).
  value=$(grep "^${key}=" "$ENV_FILE" | head -1 | cut -d'=' -f2-)
  if [ -z "$value" ]; then
    echo "FAIL: $key has empty value in .env" >&2
    exit 3
  fi

  # Write
  if ! security add-generic-password \
         -a "$key" -s "$SERVICE" -w "$value" -U >/dev/null 2>&1; then
    echo "FAIL: keychain add failed for $key" >&2
    exit 3
  fi

  # Read back
  readback=$(security find-generic-password -gw -a "$key" -s "$SERVICE" 2>/dev/null) || {
    echo "FAIL: keychain readback failed for $key" >&2
    exit 3
  }

  # Byte-compare
  if [ "$readback" != "$value" ]; then
    echo "FAIL: round-trip mismatch for $key (wrote ${#value} bytes, read ${#readback})" >&2
    exit 3
  fi

  echo "  archived: $key (${#value} bytes, round-trip verified)"
done

# ----------------------------------------------------------------------------
# Phase 3: Destructive rm
# ----------------------------------------------------------------------------

echo ""
echo "=== Phase 3: rm -rf $PROOF_SDK_DIR ==="

# Last sanity check immediately before destruction
if [ ! -d "$PROOF_SDK_DIR/.git" ]; then
  echo "FAIL: pre-rm sanity check — .git no longer present, refusing to delete" >&2
  exit 4
fi

rm -rf "$PROOF_SDK_DIR"

# ----------------------------------------------------------------------------
# Phase 4: Post-verify
# ----------------------------------------------------------------------------

echo ""
echo "=== Phase 4: post-verify ==="

# 4a. Directory is gone
if [ -d "$PROOF_SDK_DIR" ]; then
  echo "FAIL: directory still exists after rm — partial deletion?" >&2
  exit 5
fi
echo "  PASS: directory removed"

# 4b. All 4 keychain entries still readable
for key in "${EXPECTED_KEYS[@]}"; do
  if ! security find-generic-password -gw -a "$key" -s "$SERVICE" >/dev/null 2>&1; then
    echo "FAIL: keychain entry $key no longer readable — DATA LOSS" >&2
    exit 5
  fi
done
echo "  PASS: all 4 keychain entries still readable"

# 4c. Print recovery commands
echo ""
echo "=== Recovery (copy-paste if you ever need these values back) ==="
for key in "${EXPECTED_KEYS[@]}"; do
  echo "security find-generic-password -gw -a $key -s $SERVICE"
done

echo ""
echo "Done. proof-sdk removed; secrets archived under keychain service '$SERVICE'."
