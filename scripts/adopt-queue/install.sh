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

SKILL_SRC="$REPO_ROOT/scripts/adopt-queue/skill/SKILL.md"
SKILL_DST_DIR="$REPO_ROOT/groups/telegram_code-claw/skills/queue-adopt"
if [[ -f "$SKILL_SRC" ]]; then
  mkdir -p "$SKILL_DST_DIR"
  if [[ -f "$SKILL_DST_DIR/SKILL.md" ]] && cmp -s "$SKILL_SRC" "$SKILL_DST_DIR/SKILL.md"; then
    echo "  ok: skill up-to-date at $SKILL_DST_DIR/SKILL.md"
  else
    cp "$SKILL_SRC" "$SKILL_DST_DIR/SKILL.md"
    echo "  ok: skill installed at $SKILL_DST_DIR/SKILL.md"
  fi
fi

EVAL_REPO_SKILL="$REPO_ROOT/groups/telegram_code-claw/skills/eval-repo/SKILL.md"
EVAL_REPO_NUDGE='_To queue for laptop adoption: reply `/queue`_'
if [[ -f "$EVAL_REPO_SKILL" ]]; then
  if grep -qF "$EVAL_REPO_NUDGE" "$EVAL_REPO_SKILL"; then
    echo "  ok: eval-repo SKILL.md already cross-references /queue"
  else
    echo "  WARN: eval-repo SKILL.md does not mention /queue"
    echo "        Add this line inside the Telegram output template (Step 4):"
    echo "        $EVAL_REPO_NUDGE"
  fi
else
  echo "  skip: eval-repo SKILL.md not found at $EVAL_REPO_SKILL"
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
