---
name: nanokb-wiki
description: Look up Gandal Lab science, papers, tools, concepts, and the user's broader AI-tooling context in the 98-nanoKB wiki. Use when you need context that is not already in this repo's files or the current conversation.
---

# NanoKB Wiki Knowledge Base

Path: `/Volumes/sandisk4TB/marvin-vault/98-nanoKB` (host) — main-channel agents access it at `/workspace/extra/claire-vault/98-nanoKB/` via the conditional Apple Container mount

Persistent, cross-referenced wiki covering Gandal Lab science, AI tooling, papers, tools, concepts, and syntheses. Feeds NanoClaw agents as the canonical reference when their local memory isn't enough.

## Read order

When you need context not already in this project's files/conversation:

1. Read `wiki/hot.md` first (~500 words of recent context)
2. If not enough, read `wiki/overview.md` (executive summary, folder shape)
3. If you need a domain drill-down, read `wiki/<folder>/_index.md` for concepts/papers/tools/syntheses/methods/datasets
4. Only then read individual pages under `wiki/<folder>/`

## Do NOT read the wiki for

- General TypeScript/Node/Bun questions, language syntax, or framework docs
- Anything already in nanoclaw/ files or the current conversation
- Tasks unrelated to Gandal Lab science or the user's broader AI-tooling context

## Write restrictions

Never modify `wiki/log.md` past entries or anything under `98-nanoKB/sources/`.
