# MCP Tool Consolidation Candidates

**Date:** 2026-04-19
**Status:** EXPLORATORY — design notes, not an executable plan. (Reconciled 2026-04-25.) No `- [ ]` checkboxes, no test files, no commit signals expected. Verified live state 2026-04-25: all 4 candidate tools still present in `container/agent-runner/src/ipc-mcp-stdio.ts` (`publish_to_bus` line 119, `write_agent_state` line 169, `bus_publish` line 1595, `knowledge_search` line 1800) — exactly matching this doc's "later/no action" verdicts. Items 2 and 5 self-classify as no-action (correct as-is); item 3 is bundled with the agent-architecture-redesign Phase 2 cleanup; items 1 and 4 are "later" with no scheduled work. Future plan-reconciliation sweeps: skip this file. Recommend relocating to `docs/notes/` or `docs/context-engineering/` so it stops appearing in `docs/superpowers/plans/` audits.

**Original status note:** Follow-up notes (not a plan to execute yet)
**Scope:** `container/agent-runner/src/ipc-mcp-stdio.ts`
**Triggered by:** Tool-description audit against `docs/context-engineering/tool-design.md` rubric

During the description audit, three cases surfaced where the tool-design skill's consolidation principle applies ("if a human engineer cannot definitively say which tool, the agent cannot do better"). Descriptions were clarified as a short-term fix; real consolidation would change behavior and belongs to a separate change.

## 1. `publish_to_bus` vs `bus_publish` — the primary ambiguity

**What they do:**
- `publish_to_bus` — directed message to a specific `to_agent`; writes type `publish_to_bus` to TASKS_DIR.
- `bus_publish` — broadcast to a `topic`; writes type `bus_publish` to TASKS_DIR.

Both exist today and the descriptions were updated to make the choice explicit (one-named-recipient vs topic-broadcast). But a principled design would merge them into a single `bus_send` tool with `to_agent?` as an optional field — a `to_agent` means directed, no `to_agent` means topic-broadcast. That matches the consolidation pattern the skill endorses (Vercel 17→2).

**Risk if consolidated:** the host-side handlers are different code paths (`ipc.ts` dispatches on `type`). Consolidating requires a migration in the host handler plus updates to any agent `trust.yaml` entries that gate these actions separately. Worth doing; not under this scope.

## 2. `send_message` vs `send_file` vs `send_webapp_button`

**Current:** three send paths; each writes to `MESSAGES_DIR` with a different `type`.

**Verdict:** KEEP SEPARATE. This falls under the skill's "when not to consolidate" guidance — fundamentally different payloads (text / binary / interactive button) mean a unified tool would need too many mode parameters to be usable.

The descriptions now cross-reference each other ("use send_file for files, use send_webapp_button for tappable buttons") so selection is unambiguous. No further work needed.

## 3. `write_agent_state` vs `write_agent_memory`

**What they do:**
- `write_agent_state` — replace/append the group-scoped `state.md` file.
- `write_agent_memory` — patch one section of the agent-scoped `memory.md` file.

The agent-architecture-redesign spec (`docs/superpowers/specs/2026-04-13-agent-architecture-redesign.md` §4.4) already plans to merge `state.md` into `memory.md` as a `## Current Session` section. Once that ships, `write_agent_state` becomes redundant and can be removed.

**Action:** do this as part of the redesign's Phase 2 cleanup — not a standalone change.

## 4. `knowledge_search` is a no-op wrapper

The implementation returns advice telling the agent to call `qmd` with specific arguments. The description was updated to be honest about this ("does NOT perform the search itself"), but the tool itself has no reason to exist — the agent could call `qmd` directly and get the same result.

**Verdict:** DELETE in a future cleanup pass. It burns context on every session for no capability.

## 5. Main-only tools

Tools gated behind `if (isMain)` (browser_*, x_*, imessage_*) advertise themselves only in the main group. That's correct — they should not appear in non-main groups where they would 100% error. Descriptions now say "Main group only" explicitly so agents in main know the constraint exists.

## Summary — what's actionable

| # | Item | Do now? | Notes |
|---|------|---------|-------|
| 1 | Merge `publish_to_bus` + `bus_publish` | Later | Needs host-handler migration + trust.yaml sweep |
| 2 | Keep three-way send split | — | Correct per rubric |
| 3 | Remove `write_agent_state` | Bundled with redesign Phase 2 | Redundant once state.md merges into memory.md |
| 4 | Delete `knowledge_search` | Later | No-op wrapper; telling agents to use `qmd` directly is simpler |
| 5 | Main-gated tool advertising | — | Already correct |

**Total surface today:** 35 `server.tool()` registrations. If items 1+4 ship, drops to 33. If item 3 ships, drops to 32. The skill's "limit to 10-20 tools" rule doesn't fit because many are main-only — effective per-group surfaces are typically 15-20.
