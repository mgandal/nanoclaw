# proof-sdk Archive & Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive 4 secret values from `groups/telegram_code-claw/proof-sdk/.env` to macOS Keychain, then `rm -rf` the stale vendored proof-sdk directory.

**Architecture:** Single bash script (`scripts/cleanup/archive-proof-sdk.sh`) runs 4 sequential phases — pre-flight validation → keychain archive with round-trip integrity check → destructive `rm` → post-verify with recovery commands printed. Idempotent on re-run before the destructive step.

**Tech Stack:** macOS `security` CLI for keychain operations, bash with `set -euo pipefail`, plain `rm`/`grep`/`stat` for filesystem operations.

**Spec:** `docs/superpowers/specs/2026-05-03-proof-sdk-archive-design.md` (commit `10d6acf`).

**Worktree note:** Spec was brainstormed on `main`. This plan is also intended to execute on `main` since the change is one new script + one directory deletion (untracked). A dedicated worktree adds ceremony without isolation benefit.

---

## File Structure

| Path | Action | Purpose |
|---|---|---|
| `scripts/cleanup/archive-proof-sdk.sh` | NEW | The 4-phase one-shot script. ~80 lines bash. |
| `groups/telegram_code-claw/proof-sdk/` | DELETE (recursive, untracked) | Stale vendored clone. |
| `~/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/project_proof_sdk_archived.md` | NEW | Memory note pointing future-me at the keychain service name + recovery command. |
| `~/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md` | MODIFY (1 line) | Index entry pointing at the new memory note. |

---

### Task 1: Write the script with pre-flight only (no destructive actions yet)

**Files:**
- Create: `scripts/cleanup/archive-proof-sdk.sh` (initial form: pre-flight phase only, returns success without touching anything)

- [ ] **Step 1: Verify the parent dir exists**

```bash
test -d /Users/mgandal/Agents/nanoclaw/scripts/cleanup
```
Expected: directory exists. If it does, proceed. If not, `mkdir scripts/cleanup` first.

- [ ] **Step 2: Create the script with pre-flight phase + an `exit 0` stub for phases 2-4**

Write this exact file content:

```bash
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

# Phase 2-4 follow in subsequent tasks
echo ""
echo "=== Phases 2-4 stubbed in this task; see tasks 2-4 ==="
exit 0
```

Make it executable:
```bash
chmod +x scripts/cleanup/archive-proof-sdk.sh
```

- [ ] **Step 3: Bash syntax check**

Run: `bash -n scripts/cleanup/archive-proof-sdk.sh`
Expected: no output (silent = valid syntax).

- [ ] **Step 4: Run pre-flight against the real proof-sdk**

Run: `./scripts/cleanup/archive-proof-sdk.sh`
Expected output:
```
=== Phase 1: pre-flight ===
  pre-flight OK: <N> files, <K>K
=== Phases 2-4 stubbed in this task; see tasks 2-4 ===
```
And exit code 0.

If pre-flight FAILs at any subcheck, STOP and resolve the underlying condition before proceeding. Do not edit the script to skip the failing check.

- [ ] **Step 5: Negative test — temporarily corrupt the .env to prove pre-flight fails closed**

Run:
```bash
mv groups/telegram_code-claw/proof-sdk/.env /tmp/proof-sdk-env-backup-$$
echo "PORT=foo" > groups/telegram_code-claw/proof-sdk/.env
./scripts/cleanup/archive-proof-sdk.sh
echo "exit=$?"
```
Expected: prints `FAIL: .env keys don't match expected set`, exit code 2.

Restore:
```bash
mv /tmp/proof-sdk-env-backup-$$ groups/telegram_code-claw/proof-sdk/.env
```

Re-run the script to confirm it now passes again:
```bash
./scripts/cleanup/archive-proof-sdk.sh
echo "exit=$?"
```
Expected: prints `pre-flight OK: ...`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/cleanup/archive-proof-sdk.sh
git commit -m "chore(cleanup): scaffold proof-sdk archive script with pre-flight only

First task of docs/superpowers/plans/2026-05-03-proof-sdk-archive.md.
Phase 1 (read-only validation) implemented and tested via positive
+ negative cases. Phases 2-4 added in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add Phase 2 (keychain archive with round-trip check)

**Files:**
- Modify: `scripts/cleanup/archive-proof-sdk.sh` (replace the `Phases 2-4 stubbed` block with the real Phase 2 logic)

- [ ] **Step 1: Pre-flight a manual keychain round-trip from the shell**

Verify your keychain accepts a write+read for a throwaway key BEFORE editing the script. This proves the underlying primitive works and the user's keychain is unlocked:

```bash
security add-generic-password -a TEST_KEY -s proof-sdk-roundtrip-probe -w 'hello' -U
security find-generic-password -gw -a TEST_KEY -s proof-sdk-roundtrip-probe
security delete-generic-password -a TEST_KEY -s proof-sdk-roundtrip-probe
```
Expected: the second command prints `hello` (possibly preceded by a TouchID prompt on first use). Third deletes silently.

If the second command fails or times out on a TouchID prompt, STOP. Either unlock keychain interactively or address the prompt before proceeding.

- [ ] **Step 2: Replace the Phase 2-4 stub with Phase 2**

In `scripts/cleanup/archive-proof-sdk.sh`, replace this block:
```bash
# Phase 2-4 follow in subsequent tasks
echo ""
echo "=== Phases 2-4 stubbed in this task; see tasks 2-4 ==="
exit 0
```

With this block:
```bash
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

# Phase 3-4 follow in subsequent tasks
echo ""
echo "=== Phases 3-4 stubbed in this task; see tasks 3-4 ==="
exit 0
```

- [ ] **Step 3: Bash syntax check**

Run: `bash -n scripts/cleanup/archive-proof-sdk.sh`
Expected: no output.

- [ ] **Step 4: Run end-to-end (Phases 1+2 only at this point)**

Run: `./scripts/cleanup/archive-proof-sdk.sh`
Expected output (values not shown, only byte counts):
```
=== Phase 1: pre-flight ===
  pre-flight OK: <N> files, <K>K

=== Phase 2: archive to keychain ===
  archived: PORT (<N> bytes, round-trip verified)
  archived: PROOF_SHARE_MARKDOWN_AUTH_MODE (<N> bytes, round-trip verified)
  archived: PROOF_SHARE_MARKDOWN_API_KEY (<N> bytes, round-trip verified)
  archived: PROOF_PUBLIC_BASE_URL (<N> bytes, round-trip verified)

=== Phases 3-4 stubbed in this task; see tasks 3-4 ===
```
Exit code 0.

If keychain prompts for unlock (TouchID), allow it. From the second run onward, no prompt should appear.

- [ ] **Step 5: Independently verify the archive landed in keychain**

Run (one per key):
```bash
security find-generic-password -gw -a PROOF_SHARE_MARKDOWN_API_KEY -s proof-sdk-archived-2026-05-03
```
Expected: prints the value (which should match `grep '^PROOF_SHARE_MARKDOWN_API_KEY=' groups/telegram_code-claw/proof-sdk/.env | cut -d= -f2-`).

- [ ] **Step 6: Re-run the script to confirm idempotence (`-U` flag should update, not duplicate)**

Run: `./scripts/cleanup/archive-proof-sdk.sh`
Expected: same output as Step 4. No errors. No "already exists" warnings (the `-U` flag handles update-or-create).

- [ ] **Step 7: Commit**

```bash
git add scripts/cleanup/archive-proof-sdk.sh
git commit -m "chore(cleanup): add Phase 2 keychain archive with round-trip check

Phase 2 of docs/superpowers/plans/2026-05-03-proof-sdk-archive.md.
Each .env value is written to keychain via security add-generic-password
then read back via find-generic-password and byte-compared. Mismatch
aborts before reaching Phase 3 (the destructive rm).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add Phase 3 (destructive rm) + Phase 4 (post-verify)

**Files:**
- Modify: `scripts/cleanup/archive-proof-sdk.sh` (replace the Phase 3-4 stub with the real implementation)

- [ ] **Step 1: Replace the stub with Phase 3 + Phase 4**

In `scripts/cleanup/archive-proof-sdk.sh`, replace this block:
```bash
# Phase 3-4 follow in subsequent tasks
echo ""
echo "=== Phases 3-4 stubbed in this task; see tasks 3-4 ==="
exit 0
```

With this block:
```bash
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
```

- [ ] **Step 2: Bash syntax check**

Run: `bash -n scripts/cleanup/archive-proof-sdk.sh`
Expected: no output.

- [ ] **Step 3: Stop and confirm before running the destructive script**

This is the only step in this plan that destroys files. Before proceeding:
- Confirm `proof-sdk/.env` mtime is still ~38 days old (`stat -f '%Sm' groups/telegram_code-claw/proof-sdk/.env`) — if it's been touched recently, ASK USER before continuing. Recent edits suggest someone might be working on it.
- Confirm Task 2 archive is in place (`security find-generic-password -gw -a PROOF_SHARE_MARKDOWN_API_KEY -s proof-sdk-archived-2026-05-03` returns the value).

If both confirmed, proceed.

- [ ] **Step 4: Run end-to-end (Phases 1+2+3+4)**

Run: `./scripts/cleanup/archive-proof-sdk.sh`

Expected output:
```
=== Phase 1: pre-flight ===
  pre-flight OK: <N> files, <K>K

=== Phase 2: archive to keychain ===
  archived: PORT (...)
  archived: PROOF_SHARE_MARKDOWN_AUTH_MODE (...)
  archived: PROOF_SHARE_MARKDOWN_API_KEY (...)
  archived: PROOF_PUBLIC_BASE_URL (...)

=== Phase 3: rm -rf /Users/mgandal/Agents/nanoclaw/groups/telegram_code-claw/proof-sdk ===

=== Phase 4: post-verify ===
  PASS: directory removed
  PASS: all 4 keychain entries still readable

=== Recovery (copy-paste if you ever need these values back) ===
security find-generic-password -gw -a PORT -s proof-sdk-archived-2026-05-03
security find-generic-password -gw -a PROOF_SHARE_MARKDOWN_AUTH_MODE -s proof-sdk-archived-2026-05-03
security find-generic-password -gw -a PROOF_SHARE_MARKDOWN_API_KEY -s proof-sdk-archived-2026-05-03
security find-generic-password -gw -a PROOF_PUBLIC_BASE_URL -s proof-sdk-archived-2026-05-03

Done. proof-sdk removed; secrets archived under keychain service 'proof-sdk-archived-2026-05-03'.
```

Exit code 0.

- [ ] **Step 5: Independent verification of all 5 spec acceptance criteria**

Run each check; all must pass:

1. Directory gone:
   ```bash
   test ! -d /Users/mgandal/Agents/nanoclaw/groups/telegram_code-claw/proof-sdk && echo PASS || echo FAIL
   ```
   Expected: `PASS`

2. Keychain readback for the highest-stakes key:
   ```bash
   security find-generic-password -gw -a PROOF_SHARE_MARKDOWN_API_KEY -s proof-sdk-archived-2026-05-03 >/dev/null 2>&1 && echo PASS || echo FAIL
   ```
   Expected: `PASS`

3. `git status` is clean (no dangling untracked changes from this work):
   ```bash
   git status --short | grep proof-sdk && echo "FAIL: residue" || echo "PASS: clean"
   ```
   Expected: `PASS: clean`

4. No NanoClaw consumer broke (re-grep should still return nothing):
   ```bash
   grep -rIln 'proof-sdk\|proof_sdk' --include='*.ts' --include='*.py' --include='*.sh' --include='*.json' src/ scripts/ container/ 2>/dev/null | wc -l
   ```
   Expected: `0`

5. Re-run script to confirm post-execution idempotence (must abort cleanly in Phase 1, not crash):
   ```bash
   ./scripts/cleanup/archive-proof-sdk.sh; echo "exit=$?"
   ```
   Expected: prints `FAIL: .../proof-sdk not found (already cleaned up?)`, `exit=2`. This is the by-design abort.

- [ ] **Step 6: Commit Phase 3+4 implementation**

```bash
git add scripts/cleanup/archive-proof-sdk.sh
git commit -m "chore(cleanup): add destructive rm + post-verify to proof-sdk archive

Final phases of docs/superpowers/plans/2026-05-03-proof-sdk-archive.md.
Phase 3 rm -rf is gated on the keychain archive having succeeded
(Phase 2 exits 3 on any failure, never reaching this point). Phase 4
re-verifies all 4 keychain entries after the destructive operation
and prints copy-pastable recovery commands.

Resolves risk-#3-C from the 2026-05-03 engineering-risk inventory.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Capture in memory + index update

**Files:**
- Create: `~/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/project_proof_sdk_archived.md`
- Modify: `~/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md` (append one line under the existing Key Facts list)

- [ ] **Step 1: Create the memory note**

Write this exact content to `~/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/project_proof_sdk_archived.md`:

```markdown
---
name: proof-sdk archived 2026-05-03
description: Stale vendored proof-sdk clone removed; 4 .env secrets archived to macOS Keychain under service 'proof-sdk-archived-2026-05-03'
type: project
---

**What:** `groups/telegram_code-claw/proof-sdk/` was a stale (38 days untouched) vendored clone of the proof-sdk app with a real `.env` containing 4 keys outside OneCLI vault management. Removed entirely on 2026-05-03; secrets archived to macOS Keychain.

**Why:** Surfaced as risk-#3-C in the 2026-05-03 engineering-risk inventory. Triage confirmed: zero references from NanoClaw codebase, separate git clone (not a NanoClaw subdir), keys are app-specific (`PROOF_SHARE_MARKDOWN_*`, `PROOF_PUBLIC_BASE_URL`, `PORT`) not infra credentials.

**How to apply:** If you ever pick up proof-sdk work again, recover the 4 archived values:

```bash
security find-generic-password -gw -a PORT -s proof-sdk-archived-2026-05-03
security find-generic-password -gw -a PROOF_SHARE_MARKDOWN_AUTH_MODE -s proof-sdk-archived-2026-05-03
security find-generic-password -gw -a PROOF_SHARE_MARKDOWN_API_KEY -s proof-sdk-archived-2026-05-03
security find-generic-password -gw -a PROOF_PUBLIC_BASE_URL -s proof-sdk-archived-2026-05-03
```

The dated service name (`-2026-05-03`) makes this entry obviously archival in `security dump-keychain` output. The cleanup script that landed this is at `scripts/cleanup/archive-proof-sdk.sh` (kept as reference for future similar cleanups).

**Spec/plan:** `docs/superpowers/specs/2026-05-03-proof-sdk-archive-design.md`, `docs/superpowers/plans/2026-05-03-proof-sdk-archive.md`.
```

- [ ] **Step 2: Add an index line to MEMORY.md**

Use the Edit tool with these exact arguments (the `old_string` is the existing TCC memory entry; the `new_string` is that same line + the new proof-sdk entry):

- `file_path`: `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md`
- `old_string`:
  ```
  - [macOS TCC responsible-process rules](feedback_macos_tcc_responsible_process.md) — TCC checks the WRAPPER binary's FDA, not the leaf process. Homebrew `timeout`/`gtimeout` blocks FDA reads; use `/usr/bin/perl -e 'alarm N; exec @ARGV'` instead
  ```
- `new_string`:
  ```
  - [macOS TCC responsible-process rules](feedback_macos_tcc_responsible_process.md) — TCC checks the WRAPPER binary's FDA, not the leaf process. Homebrew `timeout`/`gtimeout` blocks FDA reads; use `/usr/bin/perl -e 'alarm N; exec @ARGV'` instead
  - [proof-sdk archived 2026-05-03](project_proof_sdk_archived.md) — vendored clone removed; 4 .env secrets in macOS Keychain under `proof-sdk-archived-2026-05-03`
  ```

If the `old_string` doesn't match (e.g. another memory entry has been added since this plan was written), find the new last entry under the bulleted pointer-list section and adjust `old_string` accordingly. Do NOT skip this step — the index entry is what makes the memory note discoverable.

- [ ] **Step 3: Verify the memory note resolves**

Run:
```bash
test -f ~/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/project_proof_sdk_archived.md && echo "PASS: note exists" || echo "FAIL"
grep -q 'project_proof_sdk_archived' ~/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md && echo "PASS: index updated" || echo "FAIL"
```
Expected: both `PASS`.

- [ ] **Step 4: Commit (memory files are outside the repo, so this commit is repo-side only)**

The memory directory lives outside the repo (`~/.claude/projects/...`) and is not version-controlled by this repo. No git commit is needed for the memory changes themselves — they're just files on disk.

For the repo, this task touches no tracked files. Confirm:
```bash
git status --short
```
Expected: should show only the working-tree WIP files that were already there before this plan started (`groups/global/state/current.md`, `src/ipc.ts`, `src/text-styles.test.ts`, `src/channels/telegram.test.ts`) — no new entries from Task 4.

If `git status` is unexpectedly dirty, STOP and investigate before declaring the plan done.

---

## Self-Review Checklist (executed at write-time)

**Spec coverage:**

| Spec section | Implementing task |
|---|---|
| Goal (archive 4 keys, delete dir) | Tasks 2 + 3 |
| Pre-flight failure modes (8 listed) | Task 1 (all 8 implemented in Phase 1) |
| Round-trip integrity gate | Task 2, Step 2 (the `[ "$readback" != "$value" ]` check) |
| Destructive rm only after archive succeeds | Enforced by `set -e` + Phase 2's exit 3 on any failure (Tasks 2-3) |
| Post-verify all 5 acceptance criteria | Task 3, Step 5 (each criterion gets its own check) |
| Idempotence on re-run before Phase 3 | Task 2, Step 6 (re-run test) |
| Idempotence on re-run after Phase 3 | Task 3, Step 5, check 5 (re-run aborts cleanly) |
| Memory note for future-me | Task 4 |
| Recovery commands printed | Task 3, Phase 4 (the loop in Step 1's heredoc) |
| Script kept post-execution | No deletion step anywhere; the script is committed in Task 1 and stays |

All 10 spec items covered.

**Placeholder scan:** No "TBD", "TODO", "implement later", "appropriate error handling", or unimplemented references. Every code block is complete and runnable.

**Type/identifier consistency:** Variable names (`SERVICE`, `EXPECTED_KEYS`, `PROOF_SDK_DIR`, `ENV_FILE`) declared once at the top of the script in Task 1 and referenced by name in Tasks 2-3. Keychain service name `proof-sdk-archived-2026-05-03` used consistently across script, memory note, recovery commands, and MEMORY.md index entry.
