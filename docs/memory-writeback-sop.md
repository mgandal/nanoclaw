# Memory Writeback SOP

Rules that govern what goes into `memory.md`, `hot.md`, group `memory.md`, Hindsight, and agent-level state files. Applies whenever an agent writes memory (end-of-session retain, `write_agent_memory`, Hindsight `retain`, group memory patches).

Adapted from `lsdefine/GenericAgent`'s `memory_management_sop.md` — the good ideas, mapped onto NanoClaw's layers.

---

## 0. Four axioms

### A1. Action-Verified Only
Write only what a tool call, file read, or explicit user statement confirmed. No inferences, no "the model knows this," no plans that haven't executed.

**No Execution, No Memory.**

Bad: *"Mike's grant renewal is probably due in May."*
Good: *"dbGAP #37720 renewal due 2026-05-01 (confirmed via grants.md, 2026-04-12)."*

### A2. Sanctity of Verified Facts
Once a verified fact is written, GC/compaction may compress wording or move layers, but **must not drop the fact or alter its substance**. Prefer many small patches over full rewrites. If you can't improve it, leave it.

### A3. No Volatile State
Never persist:
- Timestamps of the current session, PIDs, ephemeral ports
- Paths that are symlinks into a session directory
- Task IDs, message IDs, trace IDs
- "Currently running," "just started," "about to finish"

Volatile facts belong in working memory (the tool-call loop), not written memory.

### A4. Minimum Sufficient Pointer
Each layer holds only enough to **locate** the next. Don't duplicate detail upward. If it belongs in `memory.md`, don't also put it in `hot.md`; just reference it.

---

## 1. Decision tree — "which layer?"

```
Is it an environment fact? (path, credential, config, ID, something the model
can't guess zero-shot)
  ├─ YES → Group memory.md  (e.g., "QMD on port 8181")
  │        → mirror a keyword into hot.md only if it's referenced every session
  │
  └─ NO
       ↓
       Is it a standing preference or user-specific pattern?
       ("Mike prefers X," "always draft, never send")
       ├─ YES → Agent memory.md → "Standing Instructions"
       │
       └─ NO
            ↓
            Is it a cross-session decision, deadline, or active thread?
            ├─ YES → Agent memory.md → "Active Threads" or "Recent Decisions"
            │        (prune Decisions older than 30 days)
            │
            └─ NO
                 ↓
                 Is it conversational context the user would want recalled later?
                 (opinions shared, constraints mentioned, relationships)
                 ├─ YES → Hindsight retain
                 │
                 └─ NO  → Discard. Do not write.
```

---

## 2. Layer responsibilities (NanoClaw-specific)

### `hot.md` — scratchpad injected into context packet (lead agents only)
- **Cap: 3000 chars, ~500 words.**
- Populated at session end by the agent; overwritten, not appended.
- Holds: last session's headline, one-line state of active threads, anything you wish you'd remembered at the *start* of this session.
- Not a log. If it grows past the cap, compress; don't truncate.

### Agent `memory.md` — durable agent state
- **Cap: ~200 lines per file.** If you're about to cross 200, compact first.
- Sections (reference `data/agents/claire/memory.md` as the template):
  - `Standing Instructions` — preferences, rules, don't-do lists
  - `Active Threads` — one bullet per cross-session workstream, with latest state
  - `Recent Decisions` — last 30 days, dated, one line each
  - `Upcoming Deadlines` — date-sorted, drop past
  - `Infrastructure Status` — what's up/down/broken
- **Update via `write_agent_memory` IPC action.** Never direct-write — the file is read-only in container.

### Group `memory.md` — shared domain state
- Infrastructure/config facts the whole group uses.
- Don't put agent-specific preferences here.
- If a fact applies to one agent only, it goes in that agent's `memory.md`.

### Hindsight — conversational memory
- Retain at session end (mandatory). Retain early if you might crash.
- `document_id` should be human-readable: `"claire-2026-04-18-grants"`, not a UUID.
- Retain: personal facts, decisions, opinions, research findings, errors hit, cross-group context.
- Don't retain: code snippets, file contents, anything recoverable by reading a file.

### Honcho (user modeling)
- Auto-injected into `<memory-context>` fence. Agent doesn't write directly.
- Feed it by *talking* — conversation messages are ingested automatically.

---

## 3. Compaction rules

When a memory file hits its cap, compact — don't truncate or overwrite wholesale.

1. **Merge before delete.** Two bullets on the same topic → one tighter bullet.
2. **Move verified details down, keep pointers up.** If `hot.md` has "dbGAP renewal due May 1," `memory.md` already has it — drop from `hot.md`, keep in `memory.md`.
3. **Age out `Recent Decisions` at 30 days.** If the decision still matters, it has already turned into a Standing Instruction or a completed Active Thread.
4. **Close Active Threads when done.** Don't leave "resolved" threads sitting. Move the outcome to Recent Decisions, remove the thread.
5. **Never delete a verified environment fact** (A2). Compress the wording instead.

---

## 4. Writeback triggers

Write memory when **one of these is true**, not every turn:

| Trigger | Layer |
|---|---|
| Session ending | `hot.md` (lead only) + Hindsight retain |
| User corrected you on a standing preference | Agent `memory.md` → Standing Instructions |
| User made a decision that affects future work | Agent `memory.md` → Recent Decisions |
| New cross-session workstream started | Agent `memory.md` → Active Threads |
| Deadline surfaced | Agent `memory.md` → Upcoming Deadlines |
| Environment/config changed (service moved, port changed, new MCP) | Group `memory.md` |
| Bug hit that will bite again | Group `memory.md` + Hindsight retain |

Do **not** write just because a turn happened. No churn.

---

## 5. Anti-patterns (rejected on sight)

- "The user is working on X right now" → volatile (A3)
- "I think Mike would probably prefer Y" → not verified (A1)
- "TODO: remember to check Z later" → not memory, that's a task
- "Session 7d3f started at 14:23..." → volatile IDs (A3)
- Copy-pasting file contents into `memory.md` → wrong layer, wrong axiom (A4)
- "Updating memory.md to clean up old entries" full rewrite → violates A2
- Duplicate facts across `hot.md` and `memory.md` → violates A4

---

## 6. What to tell the LLM at writeback time

When invoking `write_agent_memory` or Hindsight retain, include this directive in the prompt:

> Extract only facts that a tool call, file read, or explicit user statement
> confirmed in this session. For each candidate:
> 1. Apply the decision tree — pick exactly one layer.
> 2. Check if it already exists. If so, patch minimally, don't duplicate.
> 3. If it's volatile, discard.
> 4. If you're rewriting more than three lines at once, stop and compact instead.
>
> No Execution, No Memory.
