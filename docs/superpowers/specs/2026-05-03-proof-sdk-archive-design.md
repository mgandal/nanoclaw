# proof-sdk Archive & Removal — Design

**Status:** Spec only — implementation pending.
**Brainstormed:** 2026-05-03 (single-session brainstorm with risk-#3 framing).

## Goal

Eliminate `groups/telegram_code-claw/proof-sdk/` — a stale vendored proof-sdk clone with a real `.env` containing 4 app keys — without losing recoverability of the secret values.

## Why

Background: a "3 engineering risks" inventory on 2026-05-03 flagged `.env` sprawl across worktrees and group subdirs. Of the 9 `.env*` files found, 8 were templates (`.env.example` — no real values, harmless). One (`groups/telegram_code-claw/proof-sdk/.env`) carried 4 real keys for a vendored proof-sdk app outside the OneCLI vault management path documented in `CLAUDE.md` (`Secrets / Credentials / Proxy (OneCLI)`).

Triage findings (all verified 2026-05-03):

- `proof-sdk/` is a **separate git clone** (its own `.git` dir; not a NanoClaw subdir, not a submodule).
- **Untouched since 2026-03-26** (mtime of both `.env` and the directory itself).
- **Zero references** to `proof-sdk` from NanoClaw's main codebase (`grep -rIn 'proof-sdk\|proof_sdk' --include='*.{ts,py,sh,json}'` returned nothing).
- The 4 keys are app-specific (`PORT`, `PROOF_SHARE_MARKDOWN_AUTH_MODE`, `PROOF_SHARE_MARKDOWN_API_KEY`, `PROOF_PUBLIC_BASE_URL`) — proof-sdk runtime config, not NanoClaw infra.

User decision: stale, delete the whole directory. Archive the 4 secret values first so they're recoverable if proof-sdk is ever picked up again.

## Non-goals

- Migrating proof-sdk to OneCLI vault (decided against; OneCLI is built for runtime credential injection, not cold archival — `secrets list` doesn't return value, and the `host-pattern` requirement doesn't fit inert keys).
- Touching the 6 `.env.example` template files in worktree subdirs (no real values; covered by the deferred risk-#3-B worktree-cleanup pass).
- Adding a `.gitignore` rule for `proof-sdk/` (it's already untracked; the directory will be gone after this).
- Building reusable archive tooling. This is a one-shot operation.
- Rotating the upstream proof-sdk keys. The user kept this on the table earlier (option B from question 4) but chose archival; rotation is the user's call separately if they want defense-in-depth against past leakage.

## Approach

Single host-side bash script `scripts/cleanup/archive-proof-sdk.sh` running 4 sequential steps. The script is self-contained, idempotent on re-run, and committed to the repo as documentation of the cleanup pattern (kept post-execution per user decision).

### Storage primitive: macOS Keychain

Use `security` CLI (Apple-shipped since OS X 10.3) for cold local archival.

- One keychain entry per env key
- Service name: `proof-sdk-archived-2026-05-03` (date-stamped for find-by-date-later)
- Account name: the env var name itself (e.g. `PROOF_SHARE_MARKDOWN_API_KEY`)

This places archived secrets where macOS already encrypts and gates them behind the user's login session — the right primitive for "I might want this back someday" without polluting the active OneCLI secrets list.

### Flow

```
Step 1: PRE-FLIGHT (read-only)
  - Verify proof-sdk/ exists at expected path
  - Verify .env has the 4 expected keys (no extras, no missing)
  - Verify proof-sdk has its own .git (sanity: we're deleting a clone, not a NanoClaw subdir)
  - Re-grep nanoclaw codebase for proof-sdk refs (guards against drift since today's investigation)
  - Confirm `security` CLI is available
  - Snapshot directory size + file count for post-delete confirmation
  - On any failure: abort with the failing condition reported, no side effects

Step 2: ARCHIVE
  - For each of the 4 keys:
      a. security add-generic-password -a $KEY -s proof-sdk-archived-2026-05-03 -w $VALUE -U
      b. Read back: security find-generic-password -gw -a $KEY -s proof-sdk-archived-2026-05-03
      c. byte-compare readback to the value written; abort on mismatch
  - The integrity gate: all 4 must round-trip cleanly before proceeding to Step 3.

Step 3: DELETE
  - rm -rf groups/telegram_code-claw/proof-sdk/
  - Single command; the spec is the confirmation, no interactive prompt

Step 4: POST-VERIFY
  - Confirm directory is gone (test ! -d ...)
  - Confirm all 4 keychain entries still readable
  - Print recovery commands (one per key, copy-pastable) so future-you doesn't need to grep memory
```

### Design properties

- **Atomic in spirit**: the destructive `rm` (Step 3) only runs after archival has been written AND read back. If anything before Step 3 fails, the on-disk state is untouched.
- **Idempotent on re-run before Step 3**: `-U` on `add-generic-password` updates rather than duplicates, so a script aborted mid-archive can be safely re-run. After Step 3 succeeds, re-running aborts in Step 1 (proof-sdk dir not found) — by design; there's nothing left to delete and the keychain entries already exist.
- **No long-lived state**: no daemon, no cron, no follow-up reminder. The keychain entries are self-documenting (timestamp in service name).
- **Recoverable forever**: keychain persists across reboots, OS upgrades, account changes. Recovery is one `security find-generic-password -gw` per key.

### Failure modes

| Failure | Handling |
|---|---|
| `[ "$(uname)" = "Darwin" ]` fails OR `command -v security` returns nothing | Abort in Step 1 with "macOS-only" note |
| `proof-sdk/.env` missing 1+ expected keys | Abort in Step 1 with key list |
| New NanoClaw reference to proof-sdk discovered | Abort in Step 1 — re-investigate, do not delete |
| `security add` fails | Abort, no rm. Surface the keychain error verbatim |
| Read-back returns different value than written | Abort, no rm. Diagnostic: keychain encoding issue (unlikely with ASCII values) |
| `rm -rf` fails partway through | Re-runnable: keychain entries are already in place from this run; Step 1's idempotent grep + `-U` flag handle re-execution |
| User runs script from launchd (TCC may prompt for keychain unlock) | Script prints a "interactive Terminal only" note in Step 1 and exits if keychain unlock prompt fires |

## File structure

| Path | Action | Purpose |
|---|---|---|
| `scripts/cleanup/archive-proof-sdk.sh` | **NEW** | The 4-step cleanup script. ~50-80 lines bash with `set -euo pipefail`. Kept post-execution as reference for future similar cleanups. |
| `groups/telegram_code-claw/proof-sdk/` | **DELETE** (recursive, includes `.git`, `.env`, all source) | Stale vendored clone. |
| Memory: `project_proof_sdk_archived.md` | **NEW (post-execution)** | One-paragraph note pointing future-me at the keychain service name + recovery command. |

No edits to:
- NanoClaw `src/` (no consumer was found for proof-sdk).
- `.gitignore` (proof-sdk wasn't tracked).
- OneCLI vault (deliberately not used; see Non-goals).
- Any test file (one-shot operation, the script's Step 4 readback IS the test).

## Verification (post-execution acceptance criteria)

After running `scripts/cleanup/archive-proof-sdk.sh`:

1. `test ! -d groups/telegram_code-claw/proof-sdk/` succeeds (directory gone).
2. `security find-generic-password -gw -s proof-sdk-archived-2026-05-03 -a PROOF_SHARE_MARKDOWN_API_KEY` returns the original value.
3. `git status` shows no unstaged changes from this work (the deleted dir was untracked).
4. `grep -rIn proof-sdk --include='*.ts' --include='*.py' --include='*.sh' .` still returns nothing (no consumer broke; proof of the pre-flight assumption).
5. New memory file `project_proof_sdk_archived.md` references the keychain service name.

## Risks deliberately accepted

- **Keychain entries persist forever** (no expiry). Future-future-you will see them in `security dump-keychain`. The dated service name (`-2026-05-03`) makes them obviously stale at a glance, and they're 4 entries (signal-to-noise impact: tiny).
- **Keys are not rotated upstream**. If the proof-sdk API key was leaked anywhere over the past 38 days (unlikely but possible), this archival doesn't address it. User can rotate separately if they want.
- **No backup of proof-sdk source code** beyond what's in the user's filesystem snapshots / Time Machine. Source is recoverable from upstream `git clone` if proof-sdk repo still exists; we're losing only local commits/changes (which the 38-day mtime suggests don't exist).

## Out of scope (explicitly deferred)

- Risk #3-A (88 branches → cleanup pass)
- Risk #3-B (5 worktrees → cleanup the 4 non-primary ones, including the moot `feat/cockpit-snapshot-builder`)
- Generalizing this archival pattern into reusable tooling
