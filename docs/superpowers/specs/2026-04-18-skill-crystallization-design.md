# Skill Crystallization — Design Spec

**Date:** 2026-04-18
**Status:** Draft. Queued behind Tier B hardening.
**Source:** Pattern adapted from [lsdefine/GenericAgent](https://github.com/lsdefine/GenericAgent) (self-evolving agent, ~3K LOC core).
**Related:** Agent architecture redesign (`project_agent_architecture_redesign.md`), agent bus, multi-agent coordination.

## Problem

Today every multi-step task in NanoClaw starts from scratch. Claire can complete a non-trivial workflow (e.g. "find all 2024 lab grants, cross-reference with deadlines in calendar, draft status summary"), and the next time the same task is asked, the LLM re-derives the plan, re-discovers the right tools, and re-assembles the context. Execution paths are not persisted as reusable units.

Skills exist (`data/agents/{name}/skills/`, `container/skills/`, `groups/{folder}/skills/`) but they are hand-authored by the user. There is no path from **"Claire just did X successfully"** to **"Claire has a reusable skill for X."**

## Proposal

Borrow GenericAgent's skill-crystallization pattern: after a successful multi-step task, the agent writes an execution trace — inputs, tool sequence, outputs — as a new skill in its own skill directory. Next time a similar task is requested, the skill is retrieved (via existing Skill tool + description matching) and executed as a one-shot recipe instead of being re-derived turn-by-turn.

## Non-goals

- **Not** implementing GenericAgent's 9 atomic tools (browser, ADB, screen vision). We already have MCP servers and Claude Code's native tools.
- **Not** porting their Python agent loop — the Claude Agent SDK loop inside the container already works.
- **Not** building a remote skill index. GenericAgent's "105K skill cards" service is public but out of scope; skills stay per-agent, on disk.

## Architecture

### Data layer

Each agent has a skills directory already: `data/agents/{name}/skills/`. Add a new subdirectory:

```
data/agents/claire/
├── identity.md
├── memory.md
├── trust.yaml
├── skills/
│   ├── crystallized/             ← new
│   │   ├── deadline-aggregation.md
│   │   ├── paper-summarization.md
│   │   └── ...
│   └── hand-authored/            ← existing skill files move here
```

Each crystallized skill is a `SKILL.md` with frontmatter matching Claude Code's skill convention:

```markdown
---
name: deadline-aggregation
description: |
  Aggregate upcoming grant/paper deadlines across groups/global/state/, calendar,
  and Todoist. Output a prioritized list with OWNER + NEXT annotations matching
  the current.md EA-schema. Crystallized from session 2026-04-20.
crystallized_at: 2026-04-20T14:32:00Z
source_task: "Mike asked for a status dashboard covering grants + deadlines"
confidence: 7
invocation_count: 0
---

## When to use

<one-sentence trigger + example phrasings>

## Steps

1. Read `groups/global/state/grants.md` — extract active grants with due dates.
2. Call `mcp__calendar__calendar_range` for next 60 days, filter for lab-related titles.
3. Call `mcp__todoist__find_tasks` with `due_before: +60d`.
4. Merge by owner, sort by date, format as EA-schema table.

## Context hints

- `groups/global/state/current.md` has the target schema.
- Calendar titles often have noisy prefixes; strip "Re:" and "[LAB]".
```

### Runtime — three steps

**1. Detect a crystallizable moment.** Two paths:

- **Explicit.** User says "save that as a skill" / "remember how you did that" / "crystallize this." Router or slash command.
- **Implicit.** After a successful multi-step task (≥3 tool calls + completion reported), the agent itself asks: "Worth saving as a skill?" Gate behind a confidence check — only offer if the task name isn't already a skill and the trace is clean.

Start with **explicit only** for the MVP. Implicit triggers can accrete slop; better to wait for data.

**2. Write the skill.** Add an IPC action `crystallize_skill`:

```typescript
// src/ipc.ts handler
interface CrystallizeSkillRequest {
  agent: string;                  // "claire", "einstein", ...
  name: string;                   // slug, e.g. "deadline-aggregation"
  description: string;            // one-paragraph, matches Skill tool matching
  source_task: string;            // what the user asked
  trace: {
    steps: Array<{tool: string, args_summary: string, result_summary: string}>;
    session_id?: string;
  };
  confidence: number;             // 1-10, agent self-reports
}
```

Handler writes:
- `data/agents/{agent}/skills/crystallized/{name}/SKILL.md` with the frontmatter + steps.
- Appends to `data/agents/{agent}/skills/crystallized/log.jsonl`: `{ts, name, source_task, confidence}`.

The skill file must be picked up on next container spawn. **Correction (2026-04-19):** verified that agent-skill sync does NOT yet exist. `syncSkillsForGroup` at `src/container-runner.ts:114` only merges `container/skills/` + `groups/{folder}/skills/` into `/home/node/.claude/skills/`. `data/agents/{name}/` is bind-mounted read-only at `/workspace/agent` but that path is not scanned by the Skill tool. Phase 1 must extend `syncSkillsForGroup` to accept `agentName` and sync `data/agents/{agentName}/skills/crystallized/` into `skillsDst`, sandwiched between the group layer (line 128-141) and container layer (line 144-155). Precedence: **container > agent-crystallized > group**. Call site at line 283 threads `agentName` (already in scope nearby).

**3. Retrieve on next invocation.** No new code needed. Claude Code's Skill tool already matches by name + description. The crystallized skill becomes discoverable as soon as it lands in the agent's skills dir and the container is re-spawned (or the dir is remounted).

### Writing quality

The skill's usefulness depends entirely on the quality of the generated `SKILL.md`. The agent must:

- **Generalize, don't replay.** If the task was "grants due in Q2 2026", the skill should be "grants due in any quarter" with quarter as a parameter.
- **Name assumptions.** File paths, env vars, host-gateway IPs — capture them in a `## Context hints` section.
- **Include failure modes.** If the task hit a dead end and backtracked, note it: "do NOT call `mcp__gmail__search` for Todoist-managed tasks — redundant."

Give the agent a **"crystallize" prompt template** (ported from GenericAgent's approach but phrased for Claude):

> You just completed task: `{source_task}`. The tool sequence was:
> `{trace}`.
> Write a reusable skill in `SKILL.md` form that a future instance of yourself could follow for a *similar* task. Generalize the specifics (names, dates, IDs). Include:
> - A one-paragraph `description:` that will match the Skill tool. Think about what phrasings future-you would use to ask.
> - A `## When to use` trigger section.
> - Numbered `## Steps` — concrete tool calls, not prose.
> - A `## Context hints` section for path / env / gateway-IP gotchas.
> - Your self-reported confidence (1-10) that this skill will generalize.
> Return ONLY the SKILL.md content.

### Memory vs skill — the boundary

A skill is a **recipe for doing**. Memory (`data/agents/{name}/memory.md`) is **facts to know**.

Not every successful task deserves a skill. A one-off "search Gmail for Mike's 2024 tax statement" is memory at most. A repeatable "quarterly deadline aggregation" is a skill. The agent's confidence score should reflect this — ≤4 → don't save, 5-6 → ask the user, ≥7 → save automatically (on explicit trigger).

## Rollout

### Phase 1 — MVP (foreground work, ~1 day)

- [ ] IPC action `crystallize_skill` — validate inputs, write to disk.
- [ ] Slash command `/crystallize` inside container — agent gathers its own trace + fires IPC.
- [ ] Path wiring: extend `syncSkillsForGroup(groupDir, sessionsDir, agentName?)` to sync `data/agents/{agentName}/skills/crystallized/` into `skillsDst` between the group and container layers. Precedence: container > agent > group. (Previously assumed existing; verified 2026-04-19 that it does not — this is net-new code, not a verification task.)
- [ ] Tests: round-trip a known task, verify skill file exists, verify Skill tool matches it next session.

### Phase 2 — Observation (~1 week after Phase 1 lands)

- [ ] Log every skill invocation (`invocation_count` in frontmatter).
- [ ] Weekly retro query: which crystallized skills were used ≥3 times? Which were written but never invoked?
- [ ] Manual review at 7 days: promote high-invocation skills to hand-authored (edit/improve), delete dead ones.

### Phase 3 — Implicit trigger (only after Phase 2 data justifies it)

- [ ] Detect multi-step task completion signals.
- [ ] Ask-user AskUserQuestion: "Worth saving as a skill?" — only for ≥3-step traces.
- [ ] Skip if a matching skill already exists (name or embedding match — TBD).

### Phase 4 — (speculative, defer) cross-agent skill sharing

GenericAgent's remote skill service (105K cards) isn't directly applicable — the lab's tasks are too bespoke. But cross-agent sharing within NanoClaw (Claire → Simon, Simon → Einstein) is interesting: if Einstein learns how to pull recent brain-development papers, Claire could invoke it. Would need a namespacing + trust-gate design. Out of scope for v1.

## Risks

- **Context bloat.** Every crystallized skill consumes tokens via Skill tool registration. Cap at ~50 crystallized skills per agent. If exceeded, LRU-evict least-invoked.
- **Skill rot.** A skill that references `/Volumes/sandisk4TB/...` breaks if the drive is renamed. Mitigation: `## Context hints` must include absolute paths, and a periodic lint (similar to `wiki-lint`) should flag skills whose named paths no longer resolve.
- **Wrong-abstraction trap.** Agent crystallizes at the wrong level — too specific (one-shot) or too generic (useless). The confidence gate + human review at Phase 2 catches this.
- **Trust boundary.** Crystallized skills must go through the same container sync path as hand-authored — don't shortcut that path or a malicious trace could smuggle code-paths into `.claude/skills/`.

## Open questions

- **Do we store the skill in the repo or in `data/`?** `data/` is per-machine, not source-controlled; skills stay personal. Repo-committed would be sharable across lab members. **Recommend:** `data/` for Phase 1, revisit if Phase 2 data shows lab-wide utility.
- **Who can trigger `/crystallize`?** Main channel only, or trusted senders? **Recommend:** main channel + trust.yaml trusted list, matching the existing A1-gate pattern.
- **Should `crystallize_skill` trigger a container rebuild, or wait for the next spawn?** Rebuilds are slow. **Recommend:** write to disk, flag the agent's next spawn to re-sync skills. Session-persistent agents see the skill on next `/new`.

## Effort estimate

- Phase 1: 6-8 hours (revised 2026-04-19 — +2h for agent-skill sync, previously mis-estimated as existing). Sync extension + IPC action + slash command + prompt template + two tests (round-trip + sync precedence).
- Phase 2: +2 hours. Logging + weekly retro query.
- Phase 3: +1 day. Detection heuristics are the hard part.

## Alternatives considered

1. **Hand-authored skills only (status quo).** Works, but doesn't scale — every new domain I personally have to describe the workflow for. Rejected: solving the wrong problem.
2. **Full GenericAgent port.** ~3K LOC of Python + 9 atomic tools. Massive overlap with existing Claude Code tools + MCP. Rejected: effort far exceeds payoff.
3. **External skill registry (their remote service).** Our tasks are too lab-specific to benefit from a general registry. Rejected: wrong distribution.

## Recommendation

Do Phase 1 after Tier B hardening (see `2026-04-18-hardening-audit-design.md` §Tier B). It's self-contained, low-risk (writes only under `data/agents/{name}/skills/crystallized/`), and the payoff compounds — every crystallized skill speeds up a future task. Defer Phase 3+ until Phase 2 data shows the pattern is hitting.

## Source attribution

GenericAgent is MIT-licensed. The `SKILL.md` format convention is Claude Code's; the "crystallize execution path into skill" mechanic is the pattern being adopted. No GenericAgent source code is being imported — only the design idea.
