# Memory Layer Improvements

**Date:** 2026-03-26
**Status:** Approved

## Problem

Agents have shallow conversation context (10 messages), stale search vectors (120+ pending embeddings), no automatic re-indexing, no topic-aware context at spawn, and vault knowledge is siloed from conversational memory.

## Changes

### 1. QMD Embedding (immediate)

Run `qmd embed` to process pending documents. One-time action.

### 2. Increase Message History

Change context assembler to inject last 30 messages instead of 10. The `getRecentMessages` DB function already accepts a `limit` parameter.

**File:** `src/context-assembler.ts`
- Change `getRecentMessages(groupFolder)` → `getRecentMessages(groupFolder, 30)`
- Change `.slice(-10)` → `.slice(-30)`

### 3. Auto-Embed in Sync Cron

Add `qmd update` and `qmd embed` to `scripts/sync/sync-all.sh` after SimpleMem ingest. This keeps vault, notes, sessions, and all other QMD collections fresh automatically every 8 hours.

**File:** `scripts/sync/sync-all.sh`
- Add step 5: `qmd update` (re-scans collections for new/changed files)
- Add step 6: `qmd embed` (vectorizes pending docs)

### 4. Topic-Aware Context Injection

At spawn time, search QMD using the latest user message and inject top 3 results into the context packet. This surfaces relevant vault/notes content without the agent needing to search manually.

**File:** `src/context-assembler.ts`
- New section after recent messages
- HTTP POST to `http://localhost:8181/mcp` with `tools/call` for `query`
- Query: semantic search (`type: 'vec'`) using last user message content
- Inject results as `--- Relevant knowledge ---` section
- Each result: title + snippet (truncated to 200 chars)
- Max 3 results, `minScore: 0.5` to filter low-quality matches
- Graceful fallback: if QMD unreachable or no results, skip silently
- Timeout: 3 seconds (don't delay container spawn)

### 5. Vault Summaries → SimpleMem

New script that extracts summaries from vault markdown files and ingests them into SimpleMem as conversational memories. This bridges the structured knowledge (vault) with conversational memory so agents can recall vault knowledge without explicitly searching QMD.

**File:** `scripts/sync/vault-ingest.py`
- Scan `/Volumes/sandisk4TB/marvin-vault` for `*.md` files
- For each file: extract YAML frontmatter title + first 500 chars of body
- Format: `"Knowledge note: {title}. {summary}"`
- Call SimpleMem `memory_add` with `speaker: "vault-sync"`
- State tracking: `scripts/sync/vault-ingest-state.json` keyed by `{path}:{mtime}`
- Only ingest new/changed files (skip if path+mtime matches state)
- Rate limit: max 50 files per sync run, 0.5s delay between calls
- Added to `sync-all.sh` as step 7 (after QMD embed)

**File:** `scripts/sync/sync-all.sh`
- Add vault ingest as final step

## Files

| File | Action |
|------|--------|
| `src/context-assembler.ts` | Modify — increase message limit, add QMD topic search |
| `scripts/sync/sync-all.sh` | Modify — add qmd update/embed + vault ingest steps |
| `scripts/sync/vault-ingest.py` | New — vault summary extraction + SimpleMem ingestion |

## Testing

- Build + existing tests pass after context-assembler changes
- Manual: restart service, send a message, verify context packet includes "Relevant knowledge" section
- Manual: run `scripts/sync/vault-ingest.py` directly, verify SimpleMem has new memories
