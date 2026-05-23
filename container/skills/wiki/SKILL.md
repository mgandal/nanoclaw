# Wiki Maintainer

You maintain a persistent, compounding wiki knowledge base. The wiki sits between the user and raw sources — you read sources, extract knowledge, and integrate it into structured, interlinked markdown pages.

**Data schema reference:** See `@CONVENTIONS.md` (in this skill directory) for vault layout, folder routing, frontmatter requirements, and tag conventions. This file defines the WHAT; SKILL.md below defines the HOW.

## Operations

### Ingest

When the user provides a new source (URL, PDF, file, image, voice note, text):

1. **Save the source** to the appropriate `sources/` subfolder per CONVENTIONS.md vault layout. Name: `YYYY-MM-DD_descriptive-title.ext`
   - URLs: use `curl -sLo` to download full content (not WebFetch, which summarizes)
   - Webpages: use `agent-browser` to extract full text if curl gets blocked
   - PDFs: save to `sources/papers/`
   - Images: save to `sources/media/`
2. **Read and understand** the source thoroughly
3. **Discuss takeaways** with the user — what's interesting, what's new, what contradicts existing knowledge
4. **Update the wiki:**
   - Create or update entity pages for people, tools, concepts mentioned (route per CONVENTIONS.md page-types table)
   - Create a summary page for the source itself
   - Update existing concept/synthesis pages that this source informs
   - Add cross-references between new and existing pages
   - Flag contradictions with existing wiki content
5. **Stamp every page you write with `skill_version: production`** in its frontmatter (per CONVENTIONS.md). NEVER omit this key; it is required for vault-blame queries during rollback.
6. **Update `wiki/index.md`** — add new pages, update summaries
7. **Append to `wiki/log.md`** — record what was ingested and what changed

A single source may touch 5-15 wiki pages. That's normal and expected.

### Query

When the user asks a question:

1. Read `wiki/index.md` to locate relevant pages
2. Read relevant wiki pages (not raw sources — the wiki has the synthesized knowledge)
3. Synthesize an answer with citations to wiki pages
4. If the answer is substantial and reusable, offer to file it as a new wiki page (and stamp `skill_version: production`)

### Lint

Periodic health check of the wiki:

1. **Contradictions** — claims in one page that conflict with another
2. **Stale claims** — information superseded by newer sources
3. **Orphan pages** — pages with no inbound links from other pages
4. **Missing pages** — important concepts mentioned but lacking dedicated pages
5. **Missing cross-references** — pages that should link to each other but don't
6. **Data gaps** — topics with thin coverage that need more sources

Report findings and suggest: sources to seek, pages to create, connections to make.

## Source Type Handling

| Source Type | How to Handle |
|-------------|---------------|
| URL (article) | `curl -sLo sources/articles/YYYY-MM-DD_title.md` or `agent-browser` for JS-heavy sites |
| URL (PDF) | `curl -sLo sources/papers/YYYY-MM-DD_title.pdf` |
| PDF attachment | Save to `sources/papers/`, extract text with `pdftotext` |
| Image | Save to `sources/media/`, describe content using vision |
| Voice note | Transcription arrives as text, save transcript to `sources/transcripts/` |
| Book/chapter | Save to `sources/books/` |
| Raw text | Save to appropriate subfolder based on content |

## Principles

- Knowledge compiles once and stays current — don't re-derive on every query
- Cross-references are as valuable as the content itself
- Prefer updating existing pages over creating new ones when the topic overlaps
- Flag contradictions explicitly rather than silently overwriting
- The user curates sources and asks questions; you handle all the bookkeeping
- Every page write includes `skill_version:` frontmatter (per CONVENTIONS.md) — no exceptions
