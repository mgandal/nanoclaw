# Context
Last updated: 2026-04-05

## Open Threads

- **qwen3:8b Ollama inference bug** — model hangs after first request on Ollama 0.20.0 and 0.20.2; affects SimpleMem, may need alternative small LLM (phi4-mini, gemma3:4b); check Ollama GitHub issues (2026-04-04)
- **Letta/LettaBot** — evaluated, verdict WAIT. LettaBot saved to watchlist (inbox/bookmarks/tools/lettabot-2026-04-04.md) (2026-04-05)
- **SimpleMem query latency** — switched from qwen3:8b to phi4-mini (Apr 6); write pipeline needs backfill (only 103 MARVIN entries, stopped Mar 22) (2026-04-06)
- **Franklin lab manager bot** — deployed to gandallab Slack; needs KB path consolidation and QMD search quality testing post-scoping fix (2026-04-02)
- **LAI Director of Genomics** — appointed Mar 19; sequencing recommendation urgent (Hakon, Ingo, Bogdan, Jim) (2026-03-19)
- **Emma ABCD manuscript** — review/edit discussion+results sections (2026-03-19)
- **NanoClaw calendar watcher** — enabled but poll failing due to pre-existing icalbuddy command bug in calendar-watcher.ts (2026-03-31)
- **Agentic memory research** — weekly remote trigger set up (Sat 9am ET); first scan Apr 4; review report and merge findings into vault master doc (2026-03-29)
- **Varun Warrier** — follow up re: autism subtyping work from SFARI (2026-03-17)
- **Joe Buxbaum** — Latin American GWAS collaboration from SFARI (2026-03-17)
- **Mike Talkowski** — ASC paper from SFARI (2026-03-17)
- **Aaron Alexander-Bloch** — TOPMed-imputed SNP data at CHOP; reply urgently or he'll offer to others (2026-03-25)
- **ChangHui Pak** — ASD NRXN1 deletion paper (attachment to review); Zoom for Matt's analysis draft ready (2026-03-25)
- **Sylvanus Toikumo** — K99/R00 migraine GWAS mapping; draft ready to send (2026-03-25)
- PsychENCODE: provide target journal and submission timeline for PEC manuscripts — [[yan-xia|Yan Xia]] (2026-01-29)
- Write F31 letter of recommendation for Emma Kumagai — submit via eRA Commons by Apr 8 (eRA: mekumagai, FOA: PA-25-422) — [[emma-kumagai|Emma Kumagai]] (2026-02-09)
- ASD rare variant annotation manuscript: Bernie Devlin to reorganize, then meet with Rachel, Yundan, Matt MacDonald, Genia — [[bernie-devlin|Bernie Devlin]] (2026-02-09)
- Contact Scott Museles (healthcare IP attorney) re: startup/company plans — [[scott-museles|Scott Museles]] (2026-02-24)
- Genotype data transfer from Michael Ziller — DTA from Uni Sydney, guest contract for Miao — [[michael-ziller|Michael Ziller]] (2026-02-24)
- BrainGO: consortium meeting end of March, update Raznahan/Shafee on next steps — [[armin-raznahan|Armin Raznahan]] (2026-03-09)
- Daniel Vo — WGCNA CD5/light cyan module overlap; testing pamStage=false

## Lab Team (active)
- Staff:
  - Liqing Jin: wet lab senior staff scientist, spatial transcriptomics
  - Yunlong Ma: staff scientist, scRBP, genomics methods
  - Connor Jops: staff bioinformatician, isoseq, quarto, cloud computing
- Postdocs:
  - Eleanor Zhang: co-mentored (Brielin/Bogdan), scRNA methods
  - Miao Tang: APA project, weekly 1:1 Thu
  - Jade England: Rett, psychosis-wgs, scz-sc-lrseq, weekly 1:1 Thu
  - Yundan Liao: asd-rarevar-anno, sv-gwas
  - Jingjing Li: co-mentored (Bogdan), 17q21 project
  - Rachel Smith: asd-rarevar-anno, asd-lcl-rnaseq
- Students:
  - Daniel Vo: WGCNA network analysis, GCB PhD
  - Shridhar Parthasarathy: Iso-Seq/long-read transcriptomics, GCB PhD/MSTP
  - Gunjan Jetley: joint with Ophir Shalem, wet lab iPSC-derived neuron, CRISPR

## MTA/dbGAP Data Access (Doc ID: 97433/00)
- **Status:** In negotiation (assigned Dec 2025)
- **Outside Party:** DBGAP (NLM/NCBI)
- **Negotiator:** Lauren Miller (laurenmi@upenn.edu, 215-573-8929)
- **Research Security:** Jessica Buchanan (jessib@upenn.edu) — Sr. Director, Export Compliance
- **Admin liaison:** Stacia Levy (stacial@upenn.edu)
- **IT Director (for agreement):** James Renfro (ISC) — NOT Jessica Buchanan
- **Approved for SRE access:** Mike Gandal, Connor Jops
- **Removed from request:** Yundan Liao, Miao Tang, Daniel Vo (not approved for SRE)
- **Track:** https://researchinventory.apps.upenn.edu

## System / Ops Notes
- 2026-03-03: Gmail re-auth completed (token had expired); lesson added re: sent-mail verification in digest
- 2026-03-03: Vault audit + quick wins (earlier session); 253 orphan files remain for KB processing
- 2026-03-08: Path consolidation — all hooks/scripts use relative paths; setup.sh created; Dropbox ghost removed
- 2026-03-12: Portability refactor — 259 vault paths → $MARVIN_VAULT env var; settings consolidated locally; setup.sh created
- 2026-03-12: Memory evaluation — mem0/Letta researched; not needed yet; auto-capture is the priority
- 2026-03-22: content/ → $MARVIN_VAULT symlink migration complete; SimpleMem volume mount fixed (343 memories)
- 2026-03-22: Agentic memory frameworks report published — SimpleMem validated as primary memory layer
- 2026-03-15: Disabled Playwright plugin (Chrome popup on startup); installed Proof + frontend-slides skills
- 2026-03-15: MARVIN_VAULT resolved — exported in ~/.bash_profile → content/ in repo (Dropbox path stale)
- 2026-03-15: Capture subagents (haiku) used excessive tokens — need tighter prompts for bookmark tasks
- 2026-03-16: Disabled x-twitter MCP (blank Chrome windows); removed stale Playwright permissions
- 2026-03-16: Perplexity API key expired; Google Workspace MCP needs re-auth for Gmail
- 2026-03-25: Telegram bot: `/install` command added — install Claude Code skills from GitHub repos via Telegram
- 2026-03-25: Gmail MCP still needs re-auth (mgandal@gmail.com) — digest skipped Gmail
- 2026-03-26: Todoist-primary task management deployed — all tasks migrated, current.md is context-only
- 2026-03-27: Gmail MCP OAuth still broken — state parameter expires before callback; port 8000 listener confirmed running
- 2026-03-28: Added hostname check to /marvin startup command; saved test→prove→guard feedback memory
- 2026-03-29: Deleted llama3.1:8b from Ollama (56.7GB VRAM, broken structured output)
- 2026-03-29: SimpleMem Docker stopped (restart needed)
- 2026-03-31: NanoClaw infra fixes deployed — bridge BrokenPipeError, credential proxy per-request token refresh, graceful bootout+bootstrap restart, calendar watcher enabled. health-check.sh guardrail added.
- 2026-04-02: Franklin bot deployed — Hermes profile "franklin", Slack Socket Mode, native process + Docker terminal, QMD franklin-lab collection (15 docs), Claude Code OAuth
- 2026-04-05: Cognee removed — local LLM KG extraction unreliable (qwen3 hang bugs, structured output failures across all tested models). SimpleMem + QMD is the memory layer.
- 2026-03-31: SimpleMem rebuilt (103 rows recovered from corrupt LanceDB), LLM switched to llama3.1:latest
- 2026-03-17: SimpleMem integrated — reusing nanoclaw Docker (port 8200), 23 memories seeded, dual-write in memory-extractor
- 2026-03-17: KG bootstrap — 203 emails processed (Jan 15 – Mar 16), 33 entities extracted to vault
- 2026-03-19: QMD sqlite-vec fixed — wrapper at `~/.bun/bin/qmd` forces Node.js (Bun lacks loadExtension)
- 2026-03-19: MARVIN_VAULT → `/Users/mgandal/Dropbox/AGENTS/marvin-vault`; QMD vault collection updated
- 2026-03-19: Research KB: 5 tools + 5 papers migrated from `content/99_knowledge/` to `$MARVIN_VAULT/wiki/`
- 2026-03-19: Added 3 papers + 2 datasets to Dropbox vault KB (Aivazidis, Kim, Siletti) with cross-refs
- 2026-03-19: Cleared KB needs_review queue (3 entries)
- 2026-03-19: Knowledge consolidation report generated (Jan 27–Mar 19, 52 days)
- 2026-04-04: Token optimization — CLAUDE.md trimmed 27%, integrations.md 34%, 4 connectors disconnected, deprecated command deleted. Heartbeat launchd plist created. GranolaMCP path bug fixed. Hindsight-memory plugin installed.
- 2026-03-19: Granola cache fix: cache-v3 → cache-v6; Python parser for transcript extraction
- 2026-03-19: 8 meeting transcripts processed via parallel haiku agents
- 2026-03-19: Perplexity API still expired (401)
- 2026-02-21: MARVIN v2 complete — EA-first architecture, 7 commits, 18 tasks
- 2026-02-21: Mail AppleScript timeout fix — all calls wrapped with timeout protection
