---
name: qmd
description: Search past conversations, notes, and documentation. Use when users ask about things mentioned before, past discussions, or need context from history.
allowed-tools: Bash(npx qmd:*), Grep, Glob, Read
---

# QMD - Conversation & Knowledge Search

Search past conversations, notes, and documentation across all indexed collections.

## MCP Tools (Preferred)

QMD MCP server runs on the host. Use these tools when available:

- `mcp__qmd__query` - Search with lex/vec/hyde queries
- `mcp__qmd__get` - Retrieve document by path or docid
- `mcp__qmd__multi_get` - Batch retrieve by glob pattern
- `mcp__qmd__status` - Check index health

### Query examples

```json
{
  "searches": [
    { "type": "lex", "query": "exact keyword" },
    { "type": "vec", "query": "natural language question about the topic" }
  ],
  "intent": "what the answer should look like",
  "collection": "vault",
  "limit": 10
}
```

### Search strategy

- **Quick keyword lookup**: Use `type: "lex"` alone
- **Semantic meaning**: Use `type: "vec"` alone
- **Best results**: Combine both lex + vec queries
- **Always provide `intent`**: Improves snippet relevance

### Key collections

| Collection | Content |
|------------|---------|
| `vault` | Obsidian knowledge base (syntheses, wiki, tools) |
| `apple-notes` | Apple Notes (personal, meetings, projects) |
| `conversations` | Archived agent session transcripts |
| `state` | Shared state files (projects, grants, roster) |
| `franklin` | Lab knowledge base (onboarding, computing, admin) |
| `sessions` | Claude Code session history |
| `nanoclaw-docs` | NanoClaw architecture docs and specs |

## Fallback: Direct File Search

If QMD MCP tools are unavailable:

```bash
# Find conversations containing a term
grep -r "term" /workspace/group/conversations/

# List recent conversations
ls -lt /workspace/group/conversations/ | head -10
```

## When to Use

- User asks "what did we discuss about X"
- User mentions something from a past conversation
- Need context from previous sessions
- Looking up decisions or preferences mentioned before
- Searching notes, lab wiki, or knowledge base
