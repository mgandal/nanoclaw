# Audit-Remaining Items — Resumable Handoff

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (recommended) or `superpowers:subagent-driven-development` to implement these tasks. Each item is independent — pick one to execute end-to-end before moving to the next.

**Status:** PENDING — three items remaining from the 2026-05-03 audit pass. Items 1–5 from that audit shipped today (commits `68b64ac`, `9d3a9c5`, `6028250`, `dde6d3d`, `41adc98`); the proof-sdk cleanup arc landed in parallel (`868c49a` and predecessors).

**Repo HEAD at handoff:** `41adc98` (`fix(security): close A2/A4 multi-line YAML bypass + scheduler heal-on-tick`).

**Test baseline at handoff:** 96 files / 2055 tests pass / 12 skipped / 0 fail. `tsc --noEmit` clean. Format clean.

**Live system at handoff:** NanoClaw PID 42144, scheduler running, all six monitors firing on cadence, launchd-health-guard now active for 8:05 AM ET tomorrow (2026-05-04T16:05:00Z).

---

## How this doc is structured

Three independent items. Each section contains:

1. **Problem** — what's broken or missing, with concrete file:line evidence
2. **Why now** — what surfaced this in the audit
3. **Approach** — recommended TDD or step-by-step path
4. **Files to touch** — specific paths
5. **Verification** — how to know it worked
6. **Estimated effort** — rough time + complexity
7. **Risk** — what could go wrong + how to roll back
8. **Open questions** — things to decide before/during execution

Pick any one. Do not bundle items into a single commit — each has independent review surface and a different rollback shape.

---

## Item #6 — Slack-MCP v1.2.3 SSE migration

### Problem

`com.slack-mcp` (launchd plist at `~/Library/LaunchAgents/com.slack-mcp.plist`) currently runs `slack-mcp-server@1.1.28` wrapped by `supergateway` (stdio→Streamable HTTP on 8189) wrapped by a TCP proxy on `0.0.0.0:8190`. Every container request opens a new HTTP session; supergateway respawns a fresh `slack-mcp-server` child per session; that child rebuilds its Slack cache cold and fails inside the warmup window. The auto-memory entry `[Slack intraday monitor]` flags this as the source of the wedge.

Today's symptom: `sync-all.sh: errors: 1` every cycle, the only remaining error after today's other fixes. From `scripts/sync/sync.log`:

```
02:36:22 [ERROR] MCP tools/call exhausted 4 retries; attempting server bounce
02:36:57 [ERROR] MCP tools/call still failing after server bounce: ConnectionError
```

The `com.slack-mcp` launchd job has been in a SIGTERM-loop today (last_exit 143, supergateway respawning the Go binary endlessly with `"context canceled"`).

### Why now

Item #6 from the audit's unified top-10 recommendations. The plan exists at `docs/superpowers/plans/2026-04-25-slack-mcp-c-full-sse.md` (24.5 KB, peer-reviewed, never executed). Memory file `[Slack intraday monitor]` says "Fix C-full (native SSE, v1.2.3) is plan-worthy."

### Approach

Execute the existing plan verbatim. Summary of its prescription:

1. **Bump `slack-mcp-server`** from 1.1.28 → 1.2.3 (the version that supports `--transport sse`).
2. **Replace the supergateway wrapper** in `~/.cache/slack-mcp/start.sh` with a direct `slack-mcp-server@1.2.3 --transport sse` invocation binding to `127.0.0.1:13080`.
3. **Update `proxy.mjs`** so it forwards `0.0.0.0:8190 → 127.0.0.1:13080` (same port externally, just a different upstream).
4. **Flip the URL** in `.env` from `…:8190/mcp` → `…:8190/sse`. Verify the env var is `SLACK_MCP_URL` and confirm `src/container-runner.ts:604-621` injects it.
5. **In-container client** — `container/agent-runner/src/index.ts:337-343` constructs the MCP client. Confirm SSE transport is supported by `@modelcontextprotocol/sdk` at the version used; if not, bump.
6. **Validate end-to-end:** unload + reload the launchd job, send a test Slack DM, confirm a container session can read it via `mcp__slack__conversations_history` (or whatever read tool the agent uses today).

### Files to touch

| File | Change |
|---|---|
| `~/.cache/slack-mcp/start.sh` | swap supergateway for `slack-mcp-server --transport sse` |
| `~/.cache/slack-mcp/proxy.mjs` | upstream port flip 8189 → 13080 |
| `~/Library/LaunchAgents/com.slack-mcp.plist` | likely no change; verify `Program` path still valid |
| `.env` | `SLACK_MCP_URL` path component `/mcp` → `/sse` |
| `src/container-runner.ts:604-621` | verify env wiring; no change expected |
| `container/agent-runner/src/index.ts:337-343` | confirm SDK SSE support; rebuild Docker image if MCP-sdk bumped |
| `scripts/sync/sync-all.sh` | no change; validates by exit code |

### Verification

1. After the launchd reload: `nc -z localhost 8190` succeeds, `curl -s http://localhost:8190/sse` returns SSE event-stream headers (not 404).
2. `sqlite3 store/messages.db "SELECT last_run, last_result FROM scheduled_tasks WHERE id LIKE 'slack-morning-digest%' OR id LIKE '%slack-intraday%'"` — both should fire on next cron and `last_result` should not contain "ConnectionError" or "exhausted retries".
3. **Critical**: send a real Slack DM to yourself, wait 30 min, confirm the intraday monitor surfaces it. The plan should specify the exact verification message.
4. Watch `~/.cache/slack-mcp/launchd-stderr.log` for one hour after the change — should NOT show "context canceled" or repeated SIGTERM exit.
5. After 4h, `sync-all.sh: errors: 0` (down from 1).

### Estimated effort

**2–4 hours.** The plan is detailed but multi-step, involves npm/launchd/Docker, and the verification window for "did Slack ingest actually work?" is ~30 min per round. Plan to budget for one re-attempt if anything goes sideways.

### Risk

**MEDIUM.** Slack ingest is the only remaining sync-error today; this fixes a real user-facing gap. But:
- Slack-mcp is a moving target; v1.2.3 may have its own bugs.
- The supergateway wrapper has been in production for weeks; ripping it out changes the failure modes.
- Container-side MCP-sdk version mismatch could cause silent transport failures.

**Rollback:** revert `start.sh` + `proxy.mjs` + `.env` from git, `launchctl unload + load` the plist, restart NanoClaw. The current state is wedged-but-known; the new state is unwedged-but-untested. If this breaks, revert immediately and file an issue against the plan.

### Open questions

1. **Does `slack-mcp-server@1.2.3` actually exist?** Plan says yes but always verify on npm before committing to a version pin.
2. **Does the MCP SDK in-container support SSE?** If not, this becomes a multi-PR effort (sdk bump + Dockerfile rebuild + agent-runner code change). Inspect `container/agent-runner/package.json` first.
3. **Is `slack-mcp-server` still maintained by the same author the plan was written against?** Check the npm registry; if ownership changed, security review the new publisher first.

---

## Item #7 — Garbage-collect stale group dirs

### Problem

Stale agent working-clones inside group directories accumulate ~700 MB of unused content:

| Path | Size | What it is |
|---|---|---|
| `groups/telegram_code-claw/nanoclaw/` | **433 MB** | Stale `git clone` of the parent repo done by an agent session |
| `groups/telegram_claire/nodelib/` | **116 MB** | Unknown — needs inspection, likely an agent's `npm install` artifact |
| `groups/telegram_claire/node_modules/` | **54 MB** | Top-level `node_modules` from an agent's npm install |
| `groups/telegram_claire/nanoclaw-clone/` | **33 MB** | Another stale repo clone |
| **Total** | **~636 MB** | All recoverable |

(`groups/telegram_code-claw/proof-sdk/` was 248 MB but was already cleaned up today via the `868c49a` arc — confirmed deleted.)

### Why now

Item #7 from the audit's unified top-10 recommendations. The host disk reports **94% full** (per the operational audit agent earlier today: `/dev/disk3s5  1.8Ti  Used 1.7Ti  Avail 116Gi`). 636 MB recoverable is meaningful in that context but not urgent. More importantly, these clones are **a class of bug** the audit flagged: agents writing into their own group dir create durable artifacts that never get garbage-collected, so a single `npm install` inside an agent session leaves behind 100MB+ permanently.

### Approach

This is **destructive — confirm with the user before running**. Two phases:

**Phase 1: Inspect, don't delete.** For each candidate:
1. `ls -la <path>` — confirm shape matches expectation.
2. `find <path> -name ".git" -maxdepth 2` — does it have its own git? (Suggests a clone, safer to delete.)
3. `find <path> -newer /Users/mgandal/Agents/nanoclaw/CLAUDE.md` — any files modified more recently than the parent CLAUDE.md? (Suggests active in-progress work; do NOT delete.)
4. For each path's `.git/`, check `git log --oneline -5` to see if there are unpushed commits worth preserving. If yes, archive the bundle to `~/.cache/nanoclaw-archived-clones/<path-name>.bundle` via `git bundle create` before delete.

**Phase 2: Delete.** Only after Phase 1 confirms each path is genuinely abandoned:
```bash
rm -rf groups/telegram_code-claw/nanoclaw
rm -rf groups/telegram_claire/{nodelib,node_modules,nanoclaw-clone}
```

**Optional Phase 3: Prevention.** Add a `.gitignore` rule (or hook) that warns when an agent attempts a `git clone` or `npm install` inside `groups/`. The right place is probably in the per-group CLAUDE.md (instruct agents not to create persistent artifacts in their workspace), or a hook that diff-counts file size before allowing the operation. Defer if the prevention design is non-obvious.

### Files to touch

| File | Change |
|---|---|
| `groups/telegram_code-claw/nanoclaw/` | DELETE |
| `groups/telegram_claire/nodelib/` | DELETE |
| `groups/telegram_claire/node_modules/` | DELETE |
| `groups/telegram_claire/nanoclaw-clone/` | DELETE |
| `groups/{name}/CLAUDE.md` (optional) | add warning re: persistent artifacts |
| `.gitignore` (optional) | exclude `groups/*/nanoclaw*` and `groups/*/node_modules` |

### Verification

1. `du -sh /Users/mgandal/Agents/nanoclaw` before and after — expect ~636 MB drop.
2. `df -h /Users/mgandal/Agents/nanoclaw` — host disk free space should rise.
3. `git status` — should show only the deletions if any of these were tracked. (They probably weren't, but verify.)
4. Restart NanoClaw and let the affected groups (CODE-claw, CLAIRE) handle a few messages each — confirm nothing broke (sessions, skill sync, IPC).
5. After 24h, no logs reference the deleted paths in `logs/nanoclaw.log`.

### Estimated effort

**15–30 minutes.** The deletions are fast; the inspection is the bulk of the time. If you find unpushed commits worth archiving, add 15 min for the bundle step.

### Risk

**LOW–MEDIUM** (depends on Phase 1 inspection):
- **LOW** if all four are confirmed abandoned (no recent mtime, no unpushed commits, no active references in logs).
- **MEDIUM** if any contains in-progress work that wasn't bundled before delete. The agent that created them may have been doing real work; deleting cancels that work permanently.

**Rollback:** None for `rm -rf`. This is exactly the class of action that warrants user confirmation per `CLAUDE.md` ("only take risky actions carefully, and when in doubt, ask before acting"). The Phase 1 inspection step is the rollback insurance — do not skip it.

### Open questions

1. **Should this be one commit or four?** Four narrow commits give finer-grained rollback (`git revert` on a single dir), but each "commit" is just a `rm -rf` so the diff value is low. Recommended: one commit.
2. **Should the prevention rule (Phase 3) be in this PR or separate?** Recommended: separate, after the cleanup is verified stable for a week. Ship the easy win first.
3. **What about future stale clones?** A weekly cron that scans `groups/*/` for dirs > 50MB not modified in 30 days could surface these proactively. Out of scope for this item; consider as a future improvement.

---

## Item #8 — Wire post-hoc trust notify

### Problem

The only `TODO` comment in `src/`:

```
src/ipc.ts:1080:          // TODO: wire post-hoc notify when trustDecision.notify is true.
src/ipc.ts:1081:          // schedule_task isn't the highest-priority action for notify; most
src/ipc.ts:1082:          // agents will carry 'draft' or 'autonomous' by default.
```

The `checkTrustAndStage` helper returns `decision.notify = true` when `trust.yaml` declares the action's level as `notify` — meaning "execute, then ping main with a receipt." `send_message` (`ipc.ts:609-665`) is the only IPC action that actually fires the post-hoc notify. The other 14 trust-gated actions silently drop the `decision.notify` signal.

This means a future operator who edits `trust.yaml` to `schedule_task: notify` (or any of: `pause_task`, `resume_task`, `cancel_task`, `update_task`, `publish_to_bus`, `knowledge_publish`, `write_agent_memory`, `write_agent_state`, `deploy_mini_app`, `kg_query`, `dashboard_query`, `imessage_search`, `imessage_read`, `imessage_send`, `imessage_list_contacts`) will see the action execute but **never receive the post-hoc receipt**. The trust system promises three behaviors (autonomous / notify / draft); only two work for most actions.

### Why now

Item #8 from the audit's unified top-10 recommendations. The audit explicitly flagged this as the C13 trust-enforcement loose end. It's a soft gap, not a security hole — the action still happens or doesn't based on `decision.allowed`. But the user-facing semantics are broken for `notify`-level policies.

### Approach

TDD with a small, sharp scope. Follow the precedent at `ipc.ts:609-665`:

1. **Extract a `firePostHocNotify` helper** into a new file `src/trust-notify.ts` (or as a method on `trust-enforcement.ts`). Signature roughly:
   ```ts
   firePostHocNotify({
     agentName,
     actionType,
     summary,           // short human-readable description
     target,            // e.g. taskId, chatJid
     registeredGroups,
     deps,              // for deps.sendMessage
   })
   ```
   Composes the message from a small template:
   `ℹ️ {agentName} → {actionType}: {summary} (target: {target})`. Best-effort — wrap in try/catch and log on failure.

2. **Write failing tests** in a new `src/trust-notify.test.ts`:
   - Returns silently when `notify=false`.
   - Sends to main when `notify=true && agentName != null`.
   - Truncates `summary` to 200 chars (matching the `send_message` precedent at `:656`).
   - No-ops if no main group is registered (defensive).
   - Logs a warn but does not throw on `sendMessage` failure.

3. **Retrofit the 14 call sites** in `src/ipc.ts`. Each follows the same shape:
   ```ts
   const decision = checkTrustAndStage({ ... });
   if (!decision.allowed) break; // or return
   // ... do the actual work ...
   if (decision.notify && agentName) {
     await firePostHocNotify({ agentName, actionType: '...', summary: '...', target: '...', registeredGroups, deps });
   }
   ```

4. **Refactor `send_message`** to call the same helper rather than its inline implementation. Net diff: one helper, 14 + 1 = 15 call sites, 1 deleted inline block. Test coverage uniform across all 15.

5. **Update each agent's `trust.yaml`** — optional cleanup. Most agents currently have a mix of trust levels declared but only `send_message` actually obeys `notify`. Now that all 15 obey, an operator may want to revisit policies (e.g. `schedule_task: autonomous → notify` for non-trusted agents).

### Files to touch

| File | Change |
|---|---|
| `src/trust-notify.ts` (new) | export `firePostHocNotify` helper |
| `src/trust-notify.test.ts` (new) | 5+ unit tests |
| `src/ipc.ts:609-665` | refactor `send_message` to use helper (delete inline block) |
| `src/ipc.ts` (14 other sites) | add `firePostHocNotify` call after each successful execution path. Lines: 1107, 1146, 1209, 1248, 1368, 1392, 1430, 1520, 1574, 1689, 2113, 2127, 2145, 2159 (per audit's grep) |
| `src/trust-enforcement.ts` | likely no change; the helper composes on the existing `decision` shape |
| Existing trust enforcement tests in `src/ipc.test.ts` | may need a new `vi.fn()` mock for `firePostHocNotify` if tests assert on call shape |

### Verification

1. **Tests first.** `bun --bun vitest run src/trust-notify.test.ts` should be the first thing green.
2. **Full suite.** Confirm 2055 → 2055+N pass, 0 regressions in existing trust tests.
3. **Live test.** Edit `data/agents/claire/trust.yaml` (or any agent) to set `schedule_task: notify`. Trigger a `schedule_task` from that agent. Confirm:
   - The task is created in the DB (action allowed).
   - The main group receives a post-hoc message: `ℹ️ claire → schedule_task: ...`.
4. Restore the original `trust.yaml` after testing.

### Estimated effort

**45–60 minutes** for the full TDD cycle. The helper itself is ~30 lines; the bulk of the time is the 14-site retrofit and the new test file. The refactor of `send_message` to use the helper is a natural correctness check (its existing behavior must be preserved).

### Risk

**LOW.** Failure modes:
- A bug in the helper that throws → existing behavior degrades (no notification sent), original execution still happens. Caught by `try/catch` per the `send_message` precedent.
- A regression in `send_message` after refactor → caught by the existing send_message tests.
- Operator confusion if they don't expect notifications for actions that previously didn't notify → mitigated by leaving `trust.yaml` defaults unchanged; the new code only fires if the operator explicitly sets `notify`.

**Rollback:** `git revert` the commit. The helper is additive; reverting removes the call sites and restores the silent behavior. Zero data risk.

### Open questions

1. **Should the helper batch?** If an agent fires 10 trust-gated actions in a tick, we'd send 10 notifications. The `send_message` precedent doesn't batch. Recommended: don't batch in this commit; if it's noisy in practice, add coalescing later.
2. **What's the right summary format per action type?** `send_message` uses `{agentName} → {chatJid}: {text.slice(0,200)}`. Other actions don't have a `text` field. Recommended: per-action summary builder, e.g. `schedule_task → "added cron task '{prompt.slice(0,80)}'"`. Worth one round of design before writing code.
3. **Should `kg_query` and `dashboard_query` notify?** They're read-only; an operator who policy'd them as `notify` may not actually want a Telegram ping for every search. Recommended: include them anyway (operator's policy is the source of truth) but flag this as a future "notify-level read-only actions are noisy" caveat in the docstring.

---

## Cross-cutting notes for the next session

1. **The repo's commit-evidence pattern.** Every commit on this branch follows: imperative-mood subject, blank line, prose body explaining the *why* and *how*, `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer. Match the style.

2. **Build + restart cycle.** Any change to `src/*.ts` requires `bun run build` (compiles to `dist/`) followed by `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (the documented restart command per `CLAUDE.md`). Items #6 and #8 both touch `src/`; item #7 doesn't.

3. **Test/format/typecheck gate.** Before every commit: `bun --bun vitest run` (full suite), `bun --bun tsc --noEmit`, `bun run format:check`. The CI added today (commit `6028250`) also runs Python pytest in parallel — items above don't touch Python, but if any did, `python -m pytest scripts/sync/tests/ -q` and `python -m pytest scripts/tests/ scripts/kg/tests/ -q --ignore=scripts/tests/migration --ignore=scripts/tests/test_check_restart_burst.py` should be run locally before pushing.

4. **Code review skill.** After 3+ commits or before merging, dispatch `superpowers:code-reviewer` via the Task tool. The session prior to this handoff caught a real critical issue (multi-line YAML bypass) that would otherwise have been a silent regression. Don't skip it.

5. **Memory file at `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md`** is the canonical reference for project state. Update it with any new project-level facts learned during execution. Recent entries point at the audit + remediation pattern this handoff continues.

6. **Don't bundle items.** Items #6, #7, #8 are independent. Each should be its own commit (or set of commits). Don't combine them into a single PR — they have distinct review surface, distinct risk profiles, and distinct rollback shapes.

7. **Recommended order if doing all three:** **#7 → #8 → #6.** Item #7 is fastest and unblocks disk space. Item #8 is pure code, no service-affecting infrastructure changes. Item #6 is the riskiest and benefits from going last when the rest of the system is already in a known-good state.
