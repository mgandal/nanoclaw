---
name: skill-creator
description: Create new container skills at runtime. Use when the user says "give yourself the ability to X", "learn how to X", "add a skill for X", or similar requests to extend your capabilities.
---

# /skill-creator — Create New Container Skills

When the user asks you to gain a new ability, create a container skill that teaches future sessions how to do it.

## When to use

- "Give yourself the ability to X"
- "Learn how to do X"
- "Add a skill for X"
- "I want you to be able to X from now on"
- "Create a command for X"

## How container skills work

Skills are directories under `/home/node/.claude/skills/` containing a `SKILL.md` file. Claude Code reads these automatically and uses them when relevant. Skills you create here persist for the current session and across container restarts within the session.

## Step 1: Design the skill

Before creating, think about:
1. **Name**: lowercase, hyphenated (e.g., `summarize-papers`, `track-expenses`)
2. **Trigger**: When should this skill activate? What phrases or patterns?
3. **Instructions**: What should the agent do? Be specific and actionable.
4. **Tools needed**: Which MCP tools, bash commands, or file operations does it use?
5. **Output format**: How should results be presented?

## Step 2: Create the SKILL.md

```bash
SKILL_NAME="your-skill-name"
mkdir -p /home/node/.claude/skills/$SKILL_NAME
```

Then write the SKILL.md file with this structure:

```markdown
---
name: {skill-name}
description: {one-line description — be specific about when this skill should activate}
---

# /{skill-name} — {Title}

{Clear instructions for what the agent should do when this skill activates.}

## When to use
{List trigger phrases or conditions}

## How to do it
{Step-by-step instructions the agent should follow}

## Output format
{How to present results}
```

### SKILL.md rules

- The `description` field in frontmatter is critical — it determines when Claude Code activates the skill. Be specific.
- Instructions should be self-contained. Don't assume the agent has context from the conversation where the skill was created.
- Reference available tools by their full MCP name (e.g., `mcp__qmd__query`, `mcp__simplemem__memory_add`).
- Keep it focused — one skill per capability.

## Step 3: Persist the skill (optional)

Skills created in the container only last for the current session. To make a skill permanent (available to all groups, all sessions), save it via IPC:

```bash
cat > /workspace/ipc/tasks/save-skill-$(date +%s).json << 'TASKEOF'
{
  "type": "save_skill",
  "requestId": "skill-TIMESTAMP",
  "skillName": "your-skill-name",
  "skillContent": "THE FULL SKILL.MD CONTENT HERE"
}
TASKEOF
```

Replace `TIMESTAMP` with `$(date +%s)` and paste the full SKILL.md content as `skillContent`. The host will save it to `container/skills/{name}/SKILL.md` so it's available to all future sessions and groups.

**Important:** Only persist skills the user explicitly wants permanent. Session-only skills are fine for one-off experiments.

## Step 4: Confirm to the user

After creating the skill, tell the user:
- What the skill is called
- When it will activate
- Whether it's session-only or permanent
- How to use it (e.g., "just say /your-skill-name or describe what you want")

## Example

User: "Give yourself the ability to summarize bioRxiv papers"

1. Create `/home/node/.claude/skills/summarize-biorxiv/SKILL.md`:

```markdown
---
name: summarize-biorxiv
description: Summarize a bioRxiv preprint given a DOI or search query. Use when the user asks to summarize a preprint, review a paper from bioRxiv, or says "summarize this preprint".
---

# /summarize-biorxiv — Summarize bioRxiv Preprints

## When to use
- User provides a bioRxiv DOI or URL
- User asks to summarize or review a preprint
- User says "what's this paper about" with a bioRxiv link

## How to do it
1. Extract the DOI from the user's message
2. Use `mcp__claude_ai_bioRxiv__get_preprint` to fetch the preprint metadata and abstract
3. Summarize in this format:
   - *Title and authors*
   - *Key finding* (1-2 sentences)
   - *Methods* (brief)
   - *Relevance* to our lab's work (psychiatric genomics, single-cell, brain development)
   - *Limitations* noted
4. Save to vault if the user asks: `/workspace/extra/claire-vault/99-wiki/papers/`
```

2. Tell the user: "I've added a /summarize-biorxiv skill. From now on, just share a bioRxiv link or DOI and I'll summarize it automatically."
