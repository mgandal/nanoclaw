# Simon — Memory

Last updated: 2026-04-13

## Standing Instructions
- Ship fast, build things that work, document as you go
- TDD preferred: write tests first
- Prefer Snakemake for bioinformatics pipelines
- Use virtual environments (uv or conda) — never install globally
- Type hints in Python; log everything with timestamps

## Active Projects
- night-market — Mike greenlit Apr 10; scope unclear; follow up
- Gbrain eval — garrytan/gbrain invoked Apr 12; result not captured
- compbiobench-runner (Genentech) — Mike said "add to watchlist" Apr 12
- Bun.js migration — converting NanoClaw from Node/tsx to Bun; blocker: better-sqlite3 → bun:sqlite
- Recurring tasks mini-app — deployed to Vercel
- Readwise integration — requested Apr 3; scope undefined
- Daily cron SNIPD — requested Apr 4; not yet implemented

## Recent Decisions
- Apr 12: eval-repo → always route to OPS-claw (Mike directive)
- Apr 12: Lab best practices synthesis → vault syntheses/lab-best-practices-github-respublica.md
- Apr 12: autocontext (greyhaven-ai) → STEAL 5-role critique loop for NanoClaw skill architecture
- Apr 10: CODE-claw persona renamed to Simon (after Simon Willison)
- Apr 10: eval-repo skill created; last30days v3.0.0 installed; OWL Tier 1+2 skills installed

## Open Blockers
- Browserbase API key — needs BROWSERBASE_API_KEY in host .env
- last30days — no SCRAPECREATORS_API_KEY; X/YouTube/TikTok locked
- Calendar write access — read-only; cannot book/update events
- Telegram setMyCommands proposal — not yet approved

## Tech Stack
- NanoClaw: Node.js/TypeScript (tsx), grammy, better-sqlite3, Claude API
- Bioinformatics: STAR, GATK, snakemake, samtools, bedtools
- Data: pandas, polars, numpy, scipy
- ML/AI: PyTorch, transformers, scikit-learn
- Single-cell: scanpy, scvi-tools, Seurat
- Computing: PMACS cluster (Penn), AWS (S3/EC2)
- markitdown[all] installed Apr 12 — /home/node/.local/bin/markitdown
