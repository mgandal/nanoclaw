# Claire — Memory

Last updated: 2026-04-13

## Standing Instructions
- Timezone: America/New_York (EST/EDT)
- Mike prefers concise bullet points over paragraphs
- Draft emails only — never auto-send
- Reply from same account that received the email
- Sign-off: "Best," for formal, varies for closer contacts
- Mike has difficulty saying no — Claire should draft declines and surface tradeoffs
- Evenings after 6 PM and weekends are sacred (family time) unless Mike initiates
- Always brainstorm and plan before implementing large projects
- TDD preferred: write tests first
- Every repeatable task → skill on a cron (concept→prototype→evaluate→codify→cron→monitor)
- If Mike has to ask for something twice, it should already be a skill
- State file writable at `/workspace/global/state/current.md` (symlink); `/workspace/project/groups/global/state/current.md` is read-only
- perplexity-web-mcp: headless patch at `/workspace/group/node_modules/perplexity-web-mcp/dist/browser.js` — re-apply if npm updates

## Active Threads (cross-group)
- **Staff scientist hiring** — Miao Tang; Stacy Moore (HR) next steps. Miao 1:1 Apr 16 3pm
- **Google.org AI for Science** — scRBP application with Yunlong Ma, CRITICAL deadline Apr 17 ($500K–$3M)
- **Aaron Alexander-Bloch** — TOPMed data reply (35+ days stale); meeting Apr 17 12:30 PM
- **LAI genomics sequencing** — coordinate with Hakon, Ingo, Bogdan, Jim (ASAP)
- **Amtrak jacket** — follow-up sent Apr 9; hard deadline Apr 17
- **Clinic-claw fix** — mandated send_message in CLAUDE.md; verify task ran
- **dbGAP #37720 renewal** — due 2026-05-01 (~3 weeks)
- **Vanshika graduation** — lab celebration event ~May 15
- **Scheduling reply to Michael** — draft approved, pending send; May 4 4PM or May 5 2PM preferred

## Recent Decisions (last 30 days)
- 2026-04-13: Agent architecture Phase 2 merged — portable agents + unified memory infra
- 2026-04-12: CLINIC-claw root cause — text-output path doesn't deliver to Telegram in persistent sessions; fix: mandate send_message
- 2026-04-12: Self-update task approach — schedule in target group's own context (writable)
- 2026-04-12: eval-repo always routes to OPS-claw (not CODE-claw)
- 2026-04-12: Vault contact template → compiled_truth + timeline format
- 2026-04-11: CLAUDE.md agent names updated: Jennifer→Marvin, Franklin→COO
- 2026-04-10: Bioinformatics curriculum (@tangming2005) = official Gandal Lab tutorial
- 2026-04-10: CODE-claw persona → Simon (after Simon Willison)
- 2026-04-10: Multi-agent orchestration live — Claire/Einstein/Jennifer with compound keys
- 2026-04-09: notebooklm-py rejected for NanoClaw integration; personal install via Hermes
- 2026-04-08: Harold Pimentel email declined — Mike out of town
- 2026-04-06: SimpleMem phased out; Honcho + Hindsight replace it
- 2026-04-04: Token reduction plan approved
- 2026-04-03: Vanshika graduating May 15 — Mike wants lab celebration
- 2026-03-31: Switzerland trip cancelled; Google.org confirmed pursuing; scheduling reply to Michael drafted

## Upcoming Deadlines
- **Apr 15**: Tax Day; Zhuoran Xu thesis committee
- **Apr 17**: Google.org AI for Science deadline — CRITICAL
- **Apr 17**: Prem/Gandal/Alexander-Bloch TOPMed meeting 12:30 PM
- **Apr 17**: Amtrak lost jacket claim hard deadline
- **May 1**: dbGAP Project #37720 renewal
- **May 7**: LAI Symposium — Mike talk
- **May 15**: Vanshika graduation — lab event
- **Jun 14–19**: GRC Fragile X conference, Jordan Hotel at Sunday River, Maine (Mike speaking)
- **Q2 2026**: ARIA Frontier Science Hubs RFA expected

## Infrastructure Status
- SimpleMem: DECOMMISSIONED (replaced by Honcho + Hindsight Apr 6)
- Hindsight: intermittent availability (last healthy Apr 10)
- QMD: healthy (port 8181)
- Honcho: running (port 8010, shared with Hermes)
- Ollama: running (phi4-mini, nomic-embed-text)
