# Memory
Last updated: 2026-02-21

Learned preferences and standing decisions. Updated via `/marvin:remember`.

## Communication Style
- Prefers concise bullet points over paragraphs
- Email tone: professional but warm
- Uses "Best," for colleagues, varies for closer collaborators

## Work Preferences
- Morning focus time (9-11 AM) for deep work
- Prefers in-person meetings when possible
- Likes having prep cards before 1:1 meetings

## Standing Decisions
- Never auto-send emails — draft only
- Always reply from the same account that received the email
- Use iCalBuddy for all calendar operations (not MS365 MCP, not Google Calendar MCP)
- PubMed for literature, Perplexity for web research

### Auto-extracted: 2026-03-19
- [DECISION] Adopted MARVIN's multi-layer memory architecture (files + SimpleMem + QMD + logs + state) over Letta's unified memory-first framework.
- [FACT] QMD integration for NanoClaw/Telegram is offline due to a Streamable HTTP transport mismatch (406 Not Acceptable).
- [FACT] Multi-hop reasoning examples involve chaining facts across sources like BrainGO, Raznahan, and consortium meetings.
- [CORRECTION] Fixed SimpleMem dual-write pipeline by increasing `num_predict` to 2048 and adding `Accept: text/event-stream` header.
- [CORRECTION] Fixed SimpleMem authentication by implementing automatic capture of `Mcp-Session-Id` header from init response.
- [FACT] Using glm-4.7-flash model for memory extraction, which requires `num_predict: 2048` to accommodate its thinking chain.

### Session excerpt: 2026-03-21 08:17 [SimpleMem offline — raw archive]
# Session Log — 2026-03-21

## Session: Late Night (~midnight, carried from 3/20)

**Duration:** ~2h | **Topics:** 2 | **Decisions:** 1

### Topics
- Researched claude-code-best-practice repo (shanraisshan) for MARVIN applicability — identified 10 improvements (skill folders, gotchas, CLAUDE.md splitting, hooks, etc.) — implementation started but interrupted
- GLG Expert Network consulting pitch — Craig Wilen (Yale, MD/PhD virologist) recruiting Mike for AI biosafety consulting group targeting DeepMind, Anthropic, OpenAI. Researched AI company biorisk evaluation frameworks (Anthropic red teaming, dual-use genomic capabilities, genomic privacy). Iteratively drafted and refined one-paragraph expert bio. Final version ready to send to Craig.

### Decisions
- Accepted Craig Wilen's invitation to join GLG AI biosafety consulting group as genomics/clinical medicine expert

### Key Deliverable
- Final GLG expert bio paragraph — covers: large-scale genetics, single-cell/functional genomics, clinical genomic interpretation, drug-target discovery, sensitive data governance, genetic privacy, re-identification risk, AI tool evaluation, translational genetics
