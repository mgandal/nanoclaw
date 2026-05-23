# Wiki Data Conventions

This file defines the data schema for wiki pages. Procedural instructions for HOW to maintain the wiki live in `SKILL.md`; this file defines WHAT a wiki page looks like and WHERE pages live. Both the live agent (via SKILL.md) and the skill-evolve harness read this file directly.

## Vault layout

The vault is rooted at `/workspace/extra/claire-vault/98-nanoKB/`:

- `sources/` — raw material (PDFs, articles, transcripts). Agents add new files when ingesting; never modify or delete existing ones.
  - `sources/papers/` — academic PDFs
  - `sources/articles/` — webpage downloads
  - `sources/media/` — images
  - `sources/transcripts/` — voice-note transcriptions
  - `sources/books/` — book PDFs/chapters
- `wiki/` — agents create, update, cross-reference markdown pages here.
  - `wiki/papers/` — one page per academic paper
  - `wiki/tools/` — one page per software tool, dataset, instrument
  - `wiki/syntheses/` — cross-cutting analysis spanning multiple sources
  - `wiki/concepts/` — ideas, methods, theories, techniques
  - `wiki/entities/` — people, organizations, genes, brain regions
  - `wiki/comparisons/` — structured comparisons (tools/methods/approaches)
  - `wiki/articles/` — non-academic article summaries (blog posts, news, magazine pieces)
  - `wiki/notes/` — informal observations, open questions, working thoughts
- `10-daily/meetings/` — meeting notes, dated; live OUTSIDE the wiki root

## Two special files

- `wiki/index.md` — content catalog. Every wiki page listed with link, one-line summary, category. Updated on every write.
- `wiki/log.md` — append-only chronological log. Every operation gets an entry: `## [YYYY-MM-DD] operation | Description`

## Page frontmatter (required on every wiki page)

```yaml
---
title: Page Title
type: entity | concept | synthesis | comparison | paper | summary | note
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - sources/papers/YYYY-MM-DD_example.pdf
tags: [wiki/<type>, domain-tag-1, domain-tag-2]
skill_version: production
---
```

**Required keys:** `title`, `type`, `created`, `updated`, `tags`, `skill_version`.
**Optional keys:** `sources` (omit for pure-synthesis pages), `aliases`, `related`.

## Tag conventions

Every page MUST have a `wiki/<type>` tag matching its `type:` field value (e.g., `wiki/paper` for a paper page). Domain tags (`neuroscience`, `genomics`, `single-cell`, etc.) come after.

## Page types → folder routing

| `type:` value | Folder | Notes |
|---|---|---|
| `entity` | `wiki/entities/` | People, organizations, tools (use `tools/` instead for software), genes, brain regions |
| `concept` | `wiki/concepts/` | Ideas, methods, theories, techniques |
| `synthesis` | `wiki/syntheses/` | Cross-cutting analysis spanning multiple sources |
| `comparison` | `wiki/comparisons/` | Structured comparison tables |
| `paper` | `wiki/papers/` | Academic paper page (one per paper) |
| `summary` | `wiki/articles/` | Condensed version of a non-academic source |
| `note` | `wiki/notes/` | Informal observation, open question |

**Special-case routes (not driven by `type:`):**
- Meeting notes (any prompt mentioning a meeting, lab discussion, call) → `10-daily/meetings/YYYY-MM-DD_<topic>.md`, NOT under `wiki/`
- Software/dataset entities → `wiki/tools/` (not `wiki/entities/`)

## Cross-references

Use markdown links: `[Related Page](wiki/related-page.md)`. Build a web of connections. Cross-references are as valuable as content. Paths are relative to the vault root (`/workspace/extra/claire-vault/98-nanoKB/`).

## skill_version

Every page's frontmatter MUST include `skill_version:` indicating which version of the wiki SKILL.md produced it. Values:
- `production` — written by the canonical SKILL.md (hand-maintained or merged via normal review)
- `skill-evolve/wiki-<run-id>` — written by an experimental variant from the skill-evolve harness

This enables vault-blame queries: `rg "skill_version: skill-evolve/wiki-<run-id>" /Volumes/sandisk4TB/marvin-vault/98-nanoKB/` lists every page written by that variant.
