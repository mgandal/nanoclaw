---
name: paperpile
description: Search and reference the paperpile academic paper wiki
---

# Paperpile Wiki

A synthesized wiki of ~5,700 academic papers organized by topic. Each page compiles knowledge across multiple papers with inline citations.

## How to Search

Use QMD scoped to the `paperpile` collection:

```
qmd query collection:"paperpile" searches=[{type:"vec", query:"your question"}] intent="find synthesis pages about a topic"
```

## Citation Format

Papers are cited using BibTeX keys: `[AuthorYear-xx]` (e.g. `[Gandal2018-ab]`).

## What You Can Do

- **"What does the literature say about X?"** — Search QMD for synthesis pages, summarize findings
- **"What papers do we have about X?"** — Search QMD, list papers from the matching synthesis page
- **"Help me cite papers about X"** — Search QMD, extract relevant citations with full references
- **"Go deeper on this topic"** — If the synthesis is abstract-only, you can fetch PDFs via PageIndex to enrich the page

## Location

Wiki pages: `/workspace/extra/claire-vault/98-nanoKB/paperpile/`
Index: `/workspace/extra/claire-vault/98-nanoKB/paperpile/INDEX.md`
