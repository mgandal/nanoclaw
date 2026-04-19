---
name: liteparse
description: Parse or spatially extract text from PDFs and images locally (no cloud, no LLM). Use for scanned PDFs, multi-column layouts, tables, figures, and PDFs where plain pdftotext drops structure. Falls back on Tesseract.js for OCR when a PDF has no embedded text. Do NOT use for DOCX/PPTX/XLSX — LibreOffice is not installed in this container.
allowed-tools: Bash(lit:*), Bash(lit parse:*), Bash(lit batch-parse:*), Bash(lit screenshot:*), Read, Write
license: MIT
---

# LiteParse — local PDF + image parser

Runs `@llamaindex/liteparse` globally installed in the container. No API keys, no cloud calls.

## When to use

Prefer this over `pdftotext` when:
- The PDF is scanned (image-only pages → pdftotext returns empty)
- Layout matters: multi-column papers, tables, figures with captions
- You need per-token bounding boxes (JSON output) to cite exact regions
- You need page screenshots to pass to Claude's vision model

Keep using `pdftotext` for simple text-only PDFs — it's faster and cheaper.

## Availability check

```bash
lit --version
```

If missing, the container was built without liteparse — tell the user to rebuild via `/rebuild-container`.

## Core commands

```bash
# Plain text (default)
lit parse <file.pdf>

# JSON with bounding boxes — best for tables and structured extraction
lit parse <file.pdf> --format json -o out.json

# Skip OCR when you know the PDF has embedded text (much faster)
lit parse <file.pdf> --no-ocr

# Specific pages (1-indexed)
lit parse <file.pdf> --target-pages "1-3,7,12-15"

# Higher DPI for dense pages or small fonts
lit parse <file.pdf> --dpi 300

# Page screenshots → feed to vision
lit screenshot <file.pdf> --target-pages "1-5" -o ./shots
```

## Supported formats in this container

| Format | Supported | Notes |
|---|---|---|
| `.pdf` | ✅ | Native PDF.js parsing |
| `.jpg`, `.png`, `.tiff`, etc. | ⚠️ | Only if `imagemagick` is installed in the container |
| `.docx`, `.pptx`, `.xlsx` | ❌ | Requires LibreOffice (not installed) — convert on host and hand in a PDF |

## OCR

Tesseract.js is bundled — no setup needed. English by default:

```bash
lit parse scanned.pdf --ocr-language eng
```

For long scanned PDFs, OCR is slow (~5-15s/page). Use `--target-pages` or `--max-pages` to bound cost.

## Workflow patterns

**Triage a new PDF:**
```bash
lit parse paper.pdf --no-ocr --target-pages "1" | head -40   # quick first-page peek
```

**Extract a table with structure:**
```bash
lit parse paper.pdf --format json --target-pages "3" -o table.json
# Then grep / jq the JSON for rows that share a Y-coordinate
```

**Hand figures to vision:**
```bash
lit screenshot paper.pdf --target-pages "2,5" -o /tmp/shots
# Then Read each PNG — Claude's vision will process them
```

## Limits in this container

- No LibreOffice → no Office doc parsing
- No external OCR server → only Tesseract.js
- Files must already be inside `/workspace/` — liteparse cannot fetch URLs itself; use `curl` first, write to `/tmp`, then parse
