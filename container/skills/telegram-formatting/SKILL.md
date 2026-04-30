---
name: telegram-formatting
description: Format messages for Telegram using Markdown v1 syntax. Use when responding to Telegram channels (folder starts with "telegram_" or JID begins with "tg:"). Critical for digests, link-heavy replies, and any output that includes URLs or citations.
---

# Telegram Message Formatting (Markdown v1)

Telegram renders messages with `parse_mode: 'Markdown'` (v1, not MarkdownV2).
Get this wrong and the user sees raw asterisks, broken citations, or bare `[N]`
tokens with no clickable URL — every one of those has been a real complaint.

## How to detect Telegram context

Check your group folder name or workspace path:
- Folder starts with `telegram_` (e.g. `telegram_claire`, `telegram_lab-claw`)
- Or JID begins with `tg:` (e.g. `tg:-1003892106437`)

## Formatting reference

### Text styles

| Style       | Syntax                | Notes                              |
|-------------|-----------------------|------------------------------------|
| Bold        | `*text*`              | Single asterisk, not double        |
| Italic      | `_text_`              | Single underscore                  |
| Inline code | `` `text` ``          | Backticks                          |
| Code block  | ` ```text``` `        | Triple backticks, can include lang |
| Link        | `[text](https://url)` | Native — Telegram makes it clickable |

### Lists

Plain Markdown bullets render fine. Telegram does not have rich list semantics,
so use `-` or `*` and keep them tight (see "Tight bullets" below).

### Quotes

Telegram Markdown v1 has no native blockquote — `>` lines render as literal
`>` text. Use `_italic_` for emphasis on quoted material instead.

## Critical rules (these are the bugs the user has flagged)

### 1. Always include the URL when one exists

If you have a URL for a fact, citation, story, or link target, render it as a
clickable Markdown link:

GOOD: `[K-Dense scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)`

BAD:  `K-Dense scientific-agent-skills` (no URL — user has to search)
BAD:  `[1]` followed by a URL on a separate line — looks like a stray bracket

This applies to digest items, news summaries, paper references, and any tool/repo mention.

### 2. Never emit bare `[N]` citation tokens followed by URLs

Perplexity-style citations like:

```
[1] Project Title https://github.com/foo/bar
[2] Other Title https://example.com
```

…must be rewritten as inline links before sending. The host parser will
auto-rewrap a line of the form `[N] Title  https://URL` into
`*[N]* [Title](https://URL)` for you, but only if the entire line follows that
exact shape (digit-bracket → text → whitespace → URL → end-of-line). If your
citation has the URL on a separate line, the parser cannot recover the link,
and the user sees a useless `[1]` orphan. **Always put the URL on the same
line as the `[N]` token.**

### 3. Tight bullets — no blank lines between list items

Digests and news summaries should render as a tight block:

GOOD:
```
- Story one — [link](https://a.com)
- Story two — [link](https://b.com)
- Story three — [link](https://c.com)
```

BAD:
```
- Story one

- Story two

- Story three
```

The host parser will collapse the blank lines for you, but it is still simpler
and more reliable to emit a tight list in the first place.

### 4. No `#` / `##` headings

Telegram does not render Markdown headings. The host parser converts them to
`*bold*` for you, but it is cleaner to skip the `#` entirely and just use
`*Section title*` for headers.

### 5. No tables

Telegram has no table support. The host parser folds GFM tables into a
fixed-width fenced code block, but tables read poorly in chat. Prefer a
bullet list with `*Label:* value` per line.

### 6. Bold and italic use single markers (not double)

Use `*bold*` and `_italic_`. Never `**double-asterisk bold**` — that survives
the parser as a literal `**` if anything trips up the regex.

## Example: a digest message

```
*r/LocalLLaMA Daily Digest*

- *Apple M3 Ultra benchmarks* — [thread](https://reddit.com/r/LocalLLaMA/...)
- *DeepSeek V3 release notes* — [thread](https://reddit.com/r/LocalLLaMA/...)
- *llama.cpp Metal speedups* — [thread](https://reddit.com/r/LocalLLaMA/...)

*Sources*
*[1]* [r/LocalLLaMA frontpage](https://reddit.com/r/LocalLLaMA)
*[2]* [Hacker News thread](https://news.ycombinator.com/item?id=12345)
```

## Quick checklist before sending to Telegram

1. Every fact with a known URL has `[text](url)` — no orphan `[N]` markers.
2. Bullet lists are tight (no blank lines between items).
3. No `#` headings — `*bold*` instead.
4. No tables — bullets with `*Label:* value`.
5. Bold uses single `*`, italic uses single `_`.
6. Code blocks use triple backticks; inline code uses single backticks.

## Notes for model-driven behavior (not enforced by the parser)

These are habits the parser cannot fix automatically — the model has to do
the right thing:

- Pulling URLs from tool output and weaving them into prose with `[text](url)`.
- Choosing concise link text (use the headline or repo name, not "click here").
- Putting each Perplexity citation's URL on the same line as the `[N]` token.
- For digests: prioritize the topics the user has asked about (e.g., MacBook
  Pro ARM threads in r/LocalLLaMA digests).
