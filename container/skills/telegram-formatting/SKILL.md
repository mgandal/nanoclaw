---
name: telegram-formatting
description: Format messages for Telegram. NanoClaw preprocesses standard Markdown before sending — write standard Markdown, the host converts to Telegram syntax automatically.
---

# Telegram Message Formatting

## How it works

NanoClaw runs `parseTextStyles(text, 'telegram')` on every outbound message **before** sending. This means:

- Write **standard Markdown** — the host converts it to Telegram syntax
- Do NOT write Telegram native syntax (`*single*` for bold) — you would be double-encoding

### Preprocessor mapping

| You write (standard Markdown) | Host sends to Telegram | Renders as |
|-------------------------------|------------------------|------------|
| `**text**`                    | `*text*`               | **bold**   |
| `_text_` or `*text*`          | `_text_`               | _italic_   |
| `[text](url)`                 | `[text](url)`          | clickable link |
| `## Heading`                  | `*Heading*`            | bold       |
| `` `code` ``                  | `` `code` ``           | inline code |

**Critical:** Single `*asterisks*` → _italic_, not bold. Always use `**double asterisks**` for bold.

## Text styles reference

| Style       | What you write        | Notes                                               |
|-------------|-----------------------|-----------------------------------------------------|
| Bold        | `**text**`            | Double asterisk — preprocessor converts to Telegram bold |
| Italic      | `_text_`              | Single underscore                                   |
| Inline code | `` `text` ``          | Backticks                                           |
| Code block  | ` ```text``` `        | Triple backticks, can include lang                  |
| Link        | `[text](https://url)` | Pass-through — Telegram renders as clickable        |

## Critical rules

### 1. Always include the URL when one exists

GOOD: `[K-Dense scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)`

BAD:  `K-Dense scientific-agent-skills` (no URL)
BAD:  `[1]` followed by a URL on a separate line

### 2. Never emit bare `[N]` citation tokens followed by URLs

The host parser auto-rewraps `[N] Title  https://URL` into `*[N]* [Title](https://URL)` only if the URL is on the same line. If your citation has the URL on a separate line, the parser cannot recover the link.

**Always put the URL on the same line as the `[N]` token.**

### 3. Tight bullets — no blank lines between list items

GOOD:
```
- Story one — [link](https://a.com)
- Story two — [link](https://b.com)
```

BAD:
```
- Story one

- Story two
```

### 4. No `#` / `##` headings

Use `**Section title**` instead. The preprocessor converts `##` to bold, but it is cleaner to write it directly.

### 5. No tables

No table support in Telegram. Use bullets with `**Label:** value` per line instead.

## Example: a digest message

```
**r/LocalLLaMA — 2026-05-19**
• **[Apple M3 Ultra benchmarks](https://reddit.com/r/LocalLLaMA/...)** (↑1234)
  Key finding from comments.
• **[DeepSeek V3 release notes](https://reddit.com/r/LocalLLaMA/...)** (↑987)
  What changed and why it matters.
```

## Quick checklist before sending to Telegram

1. Bold uses `**double asterisks**` — never `*single*`.
2. Every fact with a known URL has `[text](url)` — no orphan `[N]` markers.
3. Bullet lists are tight (no blank lines between items).
4. No `#` headings — `**bold**` instead.
5. No tables — bullets with `**Label:** value`.
6. Code blocks use triple backticks; inline code uses single backticks.

