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

mkdir -p "$QUEUE_ROOT/pending" "$QUEUE_ROOT/archive"
echo "  ok: $QUEUE_ROOT/{pending,archive}"

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

ALLOWLIST="$HOME/.config/nanoclaw/mount-allowlist.json"
if grep -q '"/Users/mgandal/claire-tools/adopt-queue"' "$ALLOWLIST" 2>/dev/null; then
  echo "  ok: mount-allowlist.json has adopt-queue entry"
else
  echo "  WARN: $ALLOWLIST does not contain adopt-queue entry — see Task 1"
fi

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
