---
name: ipc-tool-design
description: Apply the what/when/inputs/returns rubric when adding or editing nanoclaw.* MCP tools in container/agent-runner/src/ipc-mcp-stdio.ts or src/ipc/handlers/*.ts. Loads docs/context-engineering/tool-design.md as background context.
installed: true
install_command: "/ipc-tool-design"
---


# IPC Tool Design

Activate whenever a change touches:
- `container/agent-runner/src/ipc-mcp-stdio.ts` — the file that exposes every `nanoclaw.*` MCP tool the in-container agent can call
- `src/ipc/handlers/*.ts` — host-side handlers that back those MCP tools
- `src/ipc.ts` — the dispatcher

The full rubric lives in `docs/context-engineering/tool-design.md`. Read it before editing tool descriptions or adding new tools — its sections you most often need are:

- **The Tool-Agent Interface** (line 28) — how the agent perceives a tool from its description alone
- **The Consolidation Principle** (line 39) — when to merge two tools versus split one
- **Tool Description Engineering** (line 65) — the what / when / inputs / returns rubric
- **Response Format Optimization** (line 78) — what to return so the agent can act, not parse
- **Error Message Design** (line 82) — errors should teach the agent how to retry
- **MCP Tool Naming Requirements** (line 94) — server prefix + tool name constraints
- **Gotchas** (line 229) — known traps in this codebase

## Core checklist (apply before merging any change to these files)

A tool description must answer four questions, in order:

1. **What** — one-sentence purpose. The agent decides whether to use the tool from this alone.
2. **When** — when to call it AND when NOT to. Negatives prevent misuse more than positives.
3. **Inputs** — every parameter, with the constraint that makes it valid (e.g. "ISO-8601 UTC", "must be one of: …").
4. **Returns** — shape of success and shape of failure. If the agent has to inspect the return to know which it got, the design is wrong.

## House rules specific to NanoClaw

- **Trust gating before side effects.** Every IPC handler that mutates state (sends a message, writes memory, schedules a task) must call `checkTrust()` and emit an audit row via `insertAgentAction()` BEFORE the side effect, never after. Symmetric audit on success and failure paths.
- **Group folder validation.** Any handler that takes a group identifier must run it through `isValidGroupFolder()` before using it in a filesystem path. No exceptions — silent path traversal has bitten this codebase before.
- **Returns must be agent-actionable.** Don't return raw SQL rows. Return the fields the agent needs to take its next action, named the way the agent thinks about them.
- **Errors are training data.** When a handler rejects a call, the error string should tell the agent what it could have done differently — not just "invalid input".
- **Tool name = capability, not implementation.** `nanoclaw.task_close` is good. `nanoclaw.update_tasks_table_set_done` is not.

## When you're adding a NEW tool

Before writing code, write the description first. If the description is awkward to write, the tool's responsibility is wrong — split or merge before continuing. The Consolidation Principle section in the rubric explains how to decide.
