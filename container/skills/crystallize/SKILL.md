---
name: crystallize
description: Save a reusable skill (a "recipe for doing") from a task you just completed successfully. Use when the user says "save that as a skill", "remember how you did that", "crystallize this", "make this reusable", or "add this to your skills". Only works from the main channel.
---

# /crystallize — Save a reusable skill from a completed task

When the user asks you to crystallize a task you just did, distill the execution path into a `SKILL.md` that a future session of yourself can retrieve and follow. This is how NanoClaw agents accumulate reusable recipes instead of re-deriving plans every time.

## When to use

- "Save that as a skill"
- "Remember how you did that"
- "Crystallize this workflow"
- "Make this reusable"
- "Add this to your skills"

You may *also* offer to crystallize on your own initiative if:
- You just completed a task with ≥3 meaningful tool calls.
- The task name isn't already a skill.
- The trace is clean (no dead ends, no backtracks that would confuse a future reader).

Gate: **main channel only.** If the user is in a non-main group, tell them they need to run this from the main channel.

## How to do it

### Step 1: Pick a name and description

- `name` — kebab-case, 2-64 chars, starts/ends with a letter or digit. Examples: `deadline-aggregation`, `summarize-biorxiv`, `paper-into-wiki`.
- `description` — one sentence starting with "Use when..." or describing the *trigger*. Matters for Skill-tool matching — future-you needs to recognize when to invoke it. Be specific about phrasings.

### Step 2: Write the SKILL.md body (NOT the frontmatter)

The host's IPC handler stamps the frontmatter (`name`, `description`, `crystallized_at`, `source_task`, `confidence`, `invocation_count`). You write only the body.

Required sections, in this order:

```markdown
## When to use

<2-4 bullet points: the phrasings or situations that should invoke this skill>

## Steps

1. <concrete tool call or action — name the MCP tool if applicable>
2. <...>
3. <...>

## Context hints

- <paths, env vars, gotchas future-you would trip on>
- <gateway IP if relevant — 192.168.64.1 from containers>
- <schema hints: "groups/global/state/current.md uses the EA schema with OWNER + NEXT">
```

### Step 3: Self-report confidence (1-10)

- **1-4**: don't save. This is a one-off, not a recipe. Tell the user "I don't think this generalizes — consider saving the finding to memory instead."
- **5-6**: tell the user the confidence is middling and ask whether they really want it saved.
- **7-10**: save.

### Step 4: Fire the IPC

```bash
cat > /workspace/ipc/tasks/crystallize-$(date +%s).json << 'TASKEOF'
{
  "type": "crystallize_skill",
  "requestId": "crys-$(date +%s)",
  "agent": "AGENT_NAME_HERE",
  "name": "skill-slug-here",
  "description": "One-sentence description that future-you will recognize.",
  "source_task": "What the user asked that produced this skill.",
  "confidence": 7,
  "body": "## When to use\n\n<body here>\n\n## Steps\n\n1. ...\n\n## Context hints\n\n- ..."
}
TASKEOF
```

Substitute values before writing. `AGENT_NAME_HERE` is your own agent name (`claire`, `einstein`, `simon`, `marvin`, etc.) — check `data/agents/` if uncertain. Use single-quoted heredoc (`'TASKEOF'`) so `$(...)` inside `body` won't expand.

### Step 5: Confirm to the user

Tell them:
- The skill name.
- One sentence on when it will activate.
- The confidence score.
- That the skill shows up on the **next** container spawn (current session won't see it).

## Generalize, don't replay

The skill's value comes from abstraction. If the task was "find grants due in Q2 2026", the skill is "aggregate grants due in a given quarter" — the quarter is a parameter you'll pass at invocation time.

Bad: `Step 1: Read grants.md and find grants due between 2026-04-01 and 2026-06-30.`
Good: `Step 1: Read groups/global/state/grants.md. Filter by due_date falling in the user-specified window.`

Name assumptions explicitly in `## Context hints`:
- Full paths, not relatives.
- Host gateway IP is `192.168.64.1` from inside containers.
- "Calendar titles often carry a `[LAB]` prefix — strip before matching."

## Failure modes to capture

If the task hit a dead end and backtracked, note it as a negative rule:
- "Do NOT call `mcp__gmail__search` for Todoist-managed tasks — redundant and slow."
- "`mcp__calendar__calendar_range` hangs on ranges >90 days; chunk into 60-day slices."

## The memory-vs-skill boundary

Before crystallizing, ask: is this a **recipe for doing** (save as skill) or a **fact to know** (write to memory)?

| Save as skill | Save as memory (agent memory.md) |
|---|---|
| Quarterly deadline aggregation | "Mike's 2024 tax statement is in Gmail under label/tax/2024" |
| Paper-into-wiki ingestion | "Lab has 12 active grants as of 2026-04" |
| Status dashboard assembly | "Claire Doe's email is claire@example.edu" |

If the answer is "memory", stop, explain the distinction to the user, and offer to update `data/agents/{you}/memory.md` instead.

## Bundled example: crystallize prompt template

If you have a trace captured and want to generate the body in one LLM turn, use this prompt shape:

> You just completed task: `{source_task}`.
> The tool sequence was: `{trace — tool names + 1-line arg summaries + 1-line result summaries}`.
>
> Write a reusable skill's SKILL.md body (no frontmatter) that a future instance of yourself could follow for a *similar* task. Generalize specifics (names, dates, IDs). Include:
> - A `## When to use` section with 2-4 trigger phrasings.
> - Numbered `## Steps` — concrete tool calls, not prose.
> - A `## Context hints` section with paths / env / gateway-IP gotchas.
> - Any failure modes you hit as negative rules.
>
> Return ONLY the body markdown (no frontmatter, no code fences around the whole response).

## Related

- [skill-creator](../skill-creator/SKILL.md) — creates *container* skills (live under `container/skills/`, shared across all groups and agents). `crystallize` is per-agent; `skill-creator` is global.
