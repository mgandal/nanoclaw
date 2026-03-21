# The Optimal Executive AI

## What It Is

An ambient intelligence that wraps around your entire professional and personal life. It never sleeps, never polls, never waits for you to open a terminal. It perceives everything happening across your digital surfaces in real-time, maintains a deep structured understanding of your world, acts autonomously within calibrated trust boundaries, coordinates a team of specialized agents without you as the router, and learns from every interaction to get better every day.

It is not a chatbot. It is not an assistant you summon. It is an extension of your executive function — the part of your brain that tracks, prioritizes, remembers, follows up, connects dots, and catches things before they fall. You focus on what only you can do: the scientific thinking, the mentoring, the clinical judgment, the creative leaps. Everything else just happens.

---

## Lineage

This system is the convergence of three existing implementations, each contributing a critical layer:

**Marvin** (`~/Agents/marvin2`) is the spiritual ancestor — the original AI Chief of Staff. It contributes: the session-based workflow (`/marvin`, `/marvin:end`, `/marvin:update`), the daily digest pipeline (`/marvin:digest`), the email triage system (8 categories, 3 priority levels, Mac Mail AppleScript + Gmail API), the heartbeat auto-save pattern, the contact tracking framework (`content/collaborators/`), the self-improvement loop (`tasks/lessons.md`), the custom subagent architecture (NIH Reporter, dossier agent, deadline monitor, email triager, kb-search), the Granola meeting transcript integration, the promotion dossier workflow, and the deep Obsidian vault conventions with YAML frontmatter, templates, and `AGENTS.md` governance. Marvin understands the *content* of Mike's professional life better than anything else.

**NanoClaw** (`~/Agents/nanoclaw`) contributes the runtime architecture — the part that makes agents always-on rather than summoned. It provides: container isolation (Apple Container Linux VMs), the credential proxy (API keys never enter containers), the Telegram channel system with agent swarm (pool bots for subagent identities), the IPC system (container → host message passing and task scheduling), the session management system (SQLite-backed session IDs with SDK resume, idle/max-age expiry), the scheduled task framework (cron/interval/once with 30-minute minimum safety net on cron), the MCP server integration layer (QMD, SimpleMem, Apple Notes, Todoist, Ollama, Gmail, bioRxiv, PubMed, Open Targets, Clinical Trials), the mount security allowlist, and the group-based isolation model where each team has its own filesystem, memory, and session.

**OpenClaw** (`~/Agents/openclaw`) is the upstream open-source agent platform that NanoClaw forks from. It contributes: the sandbox execution model, the gateway/channel abstraction layer (Telegram, WhatsApp, Slack, Discord), the plugin architecture for extending capabilities, the session and memory subsystems, the delivery queue for reliable message routing, and the cron subsystem. OpenClaw is a large, actively maintained project published to npm — it provides the platform primitives that NanoClaw customizes for this specific use case.

The optimal system takes all three and merges them into something none of them can be alone.

---

## Where It Runs

Locally on a Mac. Not in the cloud. The host machine is the orchestrator, the credential vault, the connection point to macOS-native services (Calendar via EventKit, Mail via AppleScript, Apple Notes, iCalBuddy), and the bridge to containerized agents. Local execution means: low latency for real-time perception, direct access to macOS APIs without cloud proxying, full control over data residency, and no dependency on external infrastructure beyond the LLM API itself.

The primary interface is **Telegram** — groups for each domain (LAB-claw, SCIENCE-claw, HOME-claw, CODE-claw), with the main DM for direct communication. Telegram provides: cross-device access (phone, desktop, tablet), push notifications with per-group control, bot identities for subagents via the swarm pool, media support (photos, voice memos, documents), and low-friction interaction from anywhere.

Deep interactive sessions happen via **MARVIN** (Claude Code on the terminal) for complex multi-step work — grant writing, paper analysis, pipeline debugging, strategic planning. MARVIN and NanoClaw are complementary interfaces: MARVIN is the deep-session tool with full reasoning and file editing; NanoClaw is the always-on layer with event-driven push. They share the vault, the state files, the knowledge base, and the contact database. What NanoClaw's agents discover enriches MARVIN's context. What you build in MARVIN sessions feeds back into NanoClaw's knowledge.

---

## Two-Tier Intelligence

The system operates under a hard constraint: **no hosted API calls for background work.** Every token of Claude reasoning is precious — used for judgment, synthesis, and creativity. Everything else runs locally at zero marginal cost.

### Tier 1: Local Models (Always Running, Zero Cost)

Small local models (via Ollama — Llama 3.1 8B, Phi-3, Mistral 7B, glm-4.7-flash, qwen3) handle the continuous background work that constitutes 80% of system activity:

- **Classification**: Is this email urgent / routine / ignorable? Is this Slack message for me or just noise?
- **Entity extraction**: Who / what / when from emails, transcripts, paper abstracts
- **Routing**: Which agent domain does this belong to? Does it need Claude or can Ollama handle it?
- **Simple drafting**: Meeting confirmations, acknowledgments, routine scheduling responses
- **Memory tagging**: Classifying and indexing new information into the knowledge graph
- **Event detection**: Did something change that matters? New email, calendar update, file change, Slack mention
- **Summarization**: Condensing low-stakes content into structured JSON for upstream consumption
- **Embedding**: Vector embeddings for QMD and SimpleMem (already running via qwen3-embedding)

These run continuously. They consume local GPU/CPU but zero API tokens. They're wrong sometimes — and that's fine, because they're triaging and extracting, not deciding. Everything below their confidence threshold gets queued for Claude.

**Implementation reality check:** Ollama is already running locally and provides embeddings for QMD and SimpleMem. The gap is a structured pipeline that routes events through Ollama classification before they reach agents. Currently, all classification happens inside Claude sessions, which is wasteful for routine items. The Ollama tier needs: (1) a classification prompt template per event type, (2) a confidence threshold config, (3) a structured JSON output schema, and (4) a routing script that reads Ollama output and decides whether to handle locally or queue for Claude.

### Tier 2: Claude (Invoked When Needed, Token-Conscious)

Claude handles everything that requires genuine reasoning:

- Nuanced judgment (the NIH program officer response, the tenure committee email)
- Complex synthesis (the Monday briefing, cross-project status reports)
- Multi-step reasoning (grant strategy, paper analysis, debugging a student's stalled project)
- Creative work (drafting emails in your voice, writing grant sections, composing meeting briefs)
- Cross-domain connection (linking a new paper to three grants and a student's project)
- Social calibration (knowing that "I'll circle back" from a program officer means something different than from a grad student)

Claude sessions don't have to be interactive. NanoClaw already spawns headless agent containers from scheduled tasks. The morning briefing, the paper review queue, the email draft batch — these all run as scheduled Claude sessions with pre-assembled context, writing outputs via IPC. You see results in Telegram, not in a terminal.

### The Handoff

The boundary between tiers is the system's most important optimization surface. Ollama processes raw events into structured data — JSON with confidence scores, entity tags, urgency ratings. Claude never reads raw emails or raw paper abstracts for routine work. It reads Ollama's structured output and makes decisions on pre-digested information.

```
Raw event (email arrives)
  → Ollama: classify, extract, route → structured JSON
    → Below confidence threshold? → Queue for Claude
    → Above threshold + routine? → Handle autonomously (Ollama + scripts)
    → Above threshold + needs judgment? → Queue for next Claude batch
```

This means a Claude session processing 7 queued items costs roughly the same as processing 1, because the context assembly is done by deterministic scripts reading Ollama's structured outputs.

**Critical design question: where does the handoff logic live?** It cannot live inside a container (that would require spinning up Claude to decide whether to spin up Claude). It must be a host-side process: a lightweight Node.js or Python script that (a) receives events from watchers, (b) calls Ollama's HTTP API for classification, (c) either handles the event directly or writes it to the appropriate agent's queue for the next Claude session. This is the **event router** — a new host-side component that doesn't exist yet.

### Token Conservation

The system is engineered to maximize intelligence per token:

- **Ollama does 80% of the volume.** Most events are routine. Classification, calendar parsing, entity extraction, simple responses — all zero token cost. The ratio of Ollama-processed to Claude-processed events should be at least 4:1.
- **Precomputed context, not retrieval.** Instead of Claude reading 50 files each session, deterministic scripts assemble a context packet: today's schedule, pending items from each agent queue, recent state changes, relevant memories. Claude gets a dense, pre-assembled briefing — not raw files to wade through.
- **Batch, don't stream.** Instead of invoking Claude for each email, batch all pending items into one session. "Here are 7 items that need your judgment" is far cheaper than 7 separate invocations. The scheduler's natural cadence (morning briefing, midday check, evening digest) creates natural batch windows.
- **Structured outputs from Ollama.** Ollama extracts structured data (JSON) that Claude can consume without re-parsing. When Einstein's Ollama tier reads a paper abstract, it outputs `{"relevance": "high", "domains": ["spatial-transcriptomics", "asd"], "related_grants": ["SFARI"], "summary": "..."}`. Claude doesn't re-read the abstract — it reads the structured output and makes a judgment call.
- **Incremental context.** Each Claude session starts with a compact state summary, not the full history. The vault is the source of truth; Claude reads only what's changed since the last session.

**Honest assessment of token cost:** Each NanoClaw container invocation currently runs a full Claude session with tool access. A single agent response can cost 10-50K tokens depending on tool use. The morning briefing — if it reads calendar, email, Slack, vault state — could easily be 100K+ tokens. At 5 scheduled tasks per day across 3 groups, that's 15 container invocations × ~30K average = **~450K tokens/day for background work alone.** The Ollama tier isn't just nice-to-have — it's essential for sustainable operation. Every event that Ollama handles instead of Claude saves 10-50K tokens.

---

## The Knowledge Base

The core knowledge base is an **Obsidian-compatible vault** at `/Volumes/sandisk4TB/Dropbox/AGENTS/marvin-vault/`. Dropbox syncs it across machines. Obsidian provides the human interface for browsing, editing, and graph visualization. Agents read and write to it directly.

```
marvin-vault/
├── inbox/            Unsorted captures (triage queue)
├── daily/            Time-stamped notes
│   ├── journal/      Daily session summaries (YYYY-MM-DD.md)
│   ├── meetings/     Meeting notes (with 1v1/ for recurring)
│   └── talks/        Seminar and conference notes
├── projects/         Active research projects and grants
│   ├── active/
│   └── grants/
├── areas/            Ongoing responsibilities
│   └── people/
│       ├── collaborators/  External collaborator profiles
│       └── lab/            Lab member profiles
├── lab/              Lab operations (admin, protocols, letters)
├── resources/        Reference material
│   ├── bookmarks/    Saved web pages
│   ├── paperpile/    Paperpile exports, .bib files
│   ├── twitter/      Saved tweets and threads
│   ├── email-digests/  Weekly email digest summaries
│   └── media/        Images, PDFs, attachments
├── wiki/             Curated research knowledge base
│   ├── papers/       Structured paper entries (kb-paper)
│   ├── tools/        Bioinformatics tools (kb-tool)
│   ├── datasets/     Genomic datasets (kb-dataset)
│   ├── methods/      Analytical methods (kb-method)
│   └── syntheses/    Cross-cutting review notes
└── archive/          Completed or inactive material
```

All files in `wiki/` and `areas/people/` carry YAML frontmatter with typed fields (type, status, added, last_updated). Templates enforce consistency. `AGENTS.md` at the vault root governs all agent behavior — naming conventions, wikilink conventions, the inbox-first principle, and the decision flowchart for file routing. Every agent that reads or writes to this vault must follow `AGENTS.md`.

---

## Memory Architecture

The system maintains memory at five levels of abstraction, each optimized for different access patterns. Together they create the illusion of continuous, coherent memory across sessions, agents, and time.

### Layer 1: The Vault (Structured Long-Term Knowledge)

The Obsidian vault is the canonical store of curated knowledge. Papers with structured frontmatter and cross-references. Collaborator profiles with interaction history and `last_contact` / `next_action` fields. Meeting notes with action items. Grant tracking with budget periods and milestones. This is the knowledge that *has structure* — typed, linked, searchable by metadata.

Agents write to the vault when producing documents meant for human review or long-term reference. The vault is the shared output layer — anything worth reading later lives here, filed according to `AGENTS.md` conventions.

### Layer 2: QMD (Semantic Search Across Everything)

QMD is the search layer — a hybrid BM25 + vector embedding + LLM reranking engine that indexes the entire vault (800+ documents), Apple Notes (864+ notes), session transcripts, group memories, research docs, state files, and conversation archives. When an agent needs to *find* something but doesn't know where it is, QMD is the first query.

QMD runs locally as an HTTP daemon (port 8181), accessed by agents via MCP. Collections are continuously re-indexed as content changes. Embeddings are generated locally via Ollama (qwen3-embedding), keeping everything on-device.

In the optimal version, QMD evolves beyond document search into **entity-aware retrieval**. A query for "Rachel Smith BrainGO" doesn't just find documents containing those words — it traverses the entity graph to also surface: Rachel's collaborator profile, the BrainGO grant aims, the LDSC results Sep ran last month, and the meeting note from January where the project direction was decided.

**Implementation note:** Entity-aware retrieval requires Layer 5 (the knowledge graph) to exist. Without it, QMD remains a powerful but document-centric search tool. The bridge is straightforward: QMD queries hit the graph first for entity resolution, then expand the search to include related entities' documents.

### Layer 3: SimpleMem (Conversational Long-Term Memory)

SimpleMem is the *experiential* memory — facts extracted from conversations, compressed with coreference resolution and temporal anchoring. When an agent learns that "Mike prefers bullet points over paragraphs" or "the postdoc candidate from Yale is starting in September," these facts are stored in SimpleMem and retrievable by any agent across any session.

SimpleMem runs as a Docker container (port 8200), backed by LanceDB vectors on the Dropbox-synced vault (`marvin-vault/areas/simplemem-data/`). It uses local Ollama models for embedding and LLM processing. The memory database is shared between NanoClaw and Marvin — a joint memory pool that compounds across all interactions regardless of which system handled them.

In the optimal version, SimpleMem becomes more than a fact store. It maintains a **temporal model** of the world: what was true last month vs. what's true now, how priorities have shifted, which relationships have strengthened or cooled. Agents can query not just "what do I know about X?" but "how has X changed over the last quarter?"

**Limitation:** SimpleMem currently stores facts as flat text entries with vector embeddings. It has no temporal dimension — a fact stored 6 months ago has the same retrieval weight as one stored yesterday. The temporal model requires either (a) timestamp-weighted retrieval scoring, or (b) a separate temporal index that SimpleMem queries don't yet support. This is a meaningful gap for the "coherent identity across time" goal.

### Layer 4: Per-Group Working Memory

Each agent group (LAB-claw, SCIENCE-claw, HOME-claw) maintains its own `memory.md` and working files in its isolated filesystem. This is the *active context* — the team roster, current focus areas, active threads, and group-specific configuration. It's smaller and more focused than the vault, designed for fast loading at session start.

**How it actually works:** Each group's filesystem is mounted into the container at `/workspace/group/`. The `memory.md` file persists across sessions because it lives on the host filesystem, not inside the ephemeral container. The `.claude/` directory (session state) is mounted separately at `/home/node/.claude/`, providing Claude Code SDK session resume. Session IDs are tracked in SQLite with idle timeout (2h) and max age (4h) — after expiry, a fresh session starts. This means working memory has a natural decay boundary: anything not persisted to `memory.md` or the vault is lost after 4 hours of inactivity.

### Layer 5: The Knowledge Graph (Not Yet Built)

The capstone layer. A continuously maintained graph of entities (people, papers, datasets, grants, meetings, decisions, conversations) and their typed relationships. Not a separate database — a lightweight SQLite index that cross-references entities across all other layers, maintained by Ollama's entity extraction running against every new piece of information.

When you ask "what's the status of the XRN2 project?", the graph traverses: the grant → its aims → the people assigned to each aim → their recent commits and Slack messages → the datasets they're working with → the papers those datasets came from → known issues with those methods. It synthesizes a status that incorporates information you haven't even seen yet.

The graph is self-correcting. When it learns that a collaborator changed institutions, every reference updates. When a grant ends, related entities shift from active to archived. The graph maintains temporal versioning — what was true when, and what changed.

**Implementation approach:** The vault's YAML frontmatter already contains typed relationships — `related_papers`, `relevant_grants`, `relevant_projects`, `authors`, `disorders`, `methods`. These are the graph edges, currently stored as flat arrays in markdown files. The knowledge graph is essentially an index that materializes these relationships into queryable form. A nightly Ollama-powered script could: (1) scan all frontmatter, (2) extract entities and relationships, (3) write them to SQLite with `entity_id, entity_type, relationship, target_id, confidence, timestamp` rows. The hardest part isn't the graph structure — it's entity resolution (is "M Gandal" the same as "Michael Gandal" the same as "Gandal MJ"?). Ollama can handle this with a simple prompt, but the error rate matters because it compounds.

---

## Always-On Perception

Every information source streams into a unified perception layer. Not batched hourly. Event-driven: the moment something changes, it's detected, classified by Ollama, and routed.

### Email

Every message across all accounts (Penn Exchange, mgandal@gmail.com, mikejg1838@gmail.com, CHOP) is read the instant it arrives via push notifications (Gmail API webhooks, Exchange push subscriptions, IMAP IDLE). Each email is understood not just by its content but by its full relational context: every prior conversation with that person, every project they're involved in, every deadline that's active, the social dynamics of the relationship, and the urgency implied by the sender's communication patterns.

Ollama handles the initial classification — sender importance, topic extraction, urgency rating, suggested routing. Only emails that require judgment, drafting, or complex responses escalate to Claude. Meeting confirmations and seminar announcements are handled autonomously.

Email processing inherits Marvin's triage system: 8 categories, 3 priority levels, draft-first policy for all outbound, and the rule that replies always come from the account that received the original.

**Implementation reality:** Push-based email is the single biggest gap in the perception layer. Gmail supports push notifications via the [Pub/Sub API](https://developers.google.com/gmail/api/guides/push), which sends a notification to a webhook when the mailbox changes. Exchange supports [push subscriptions](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/notification-subscriptions-mailbox-events-and-ews-in-exchange) or the [Graph API change notifications](https://learn.microsoft.com/en-us/graph/webhooks). Both require an HTTPS endpoint, which means either a local tunnel (ngrok, Cloudflare Tunnel) or a lightweight cloud relay that forwards to localhost. The simpler alternative: IMAP IDLE, which maintains a persistent connection and gets notified of new messages with ~1 second latency. This works for Gmail (imap.gmail.com) and Exchange (if IMAP is enabled). A Python `imaplib` script with IDLE is 50 lines and runs as a daemon. This is the pragmatic starting point.

### Calendar

Not just "what's next" but continuous temporal reasoning. It knows that your 2pm was moved to 3pm, that this creates a conflict with the seminar you wanted to attend, that the person you were meeting is flying out tomorrow so rescheduling to next week won't work, and that there's a 45-minute window at 4:15 if you skip the optional committee meeting — and it knows which committee meetings you actually skip vs. which ones have political cost.

Calendar awareness spans all source calendars (MJG, Outlook, Gandal_Lab_Meetings) accessed via iCalBuddy on macOS. Calendar changes are detected by polling (iCalBuddy doesn't support push), but a 60-second poll interval is sufficient for calendar events which change infrequently.

**Implementation note:** The VISION3 mentioned "scheduleSync" for Outlook → MJG calendar deduplication. This is a separate Python tool (`~/Documents/claude/scheduleSync/`) that is **currently broken** (Python import errors). Either fix it or replace it with a simpler approach: iCalBuddy already reads all three calendars natively, so deduplication can happen at query time rather than sync time.

### Slack and Messaging

Every channel, every DM, every thread across the lab Slack workspace. It sees a student mentioning their pipeline is failing before you do, cross-references it with known issues in the analysis environment, and either answers directly (if authorized) or drafts you a message with the fix. It distinguishes signal from noise — most Slack messages don't need your attention.

**Implementation note:** Slack offers the [Events API](https://api.slack.com/events-api) and [Socket Mode](https://api.slack.com/apis/connections/socket) for push-based message delivery. Socket Mode is ideal for local deployments — it doesn't require a public URL. It opens a WebSocket connection and receives events in real-time. This is the correct approach for Slack perception: a Socket Mode listener that routes events to the Ollama classification tier.

### Literature

Continuous monitoring of bioRxiv, medRxiv, PubMed, researcher feeds on Twitter/Bluesky, and journal tables of contents. When a competing group posts a revision of a paper in your area, it reads the full text, diffs it against the previous version in the vault, identifies what's new, assesses relevance to active projects and grants, and surfaces it during your next natural break.

Ollama handles the first pass — abstract classification, relevance scoring, keyword extraction. Only papers scoring above the relevance threshold get full-text analysis by Claude. Monitoring 50 overnight preprints costs minutes of Ollama time and zero Claude tokens for the 45 that aren't relevant.

It also monitors methods papers, tool releases, and dataset announcements. The vault's `wiki/tools/` and `wiki/methods/` sections stay current not because someone manually updates them but because the system detects relevant changes in the field and proposes updates.

**Implementation approach:** bioRxiv has an RSS feed and a REST API (`api.biorxiv.org`). PubMed has E-utilities with saved searches that can generate RSS. A daily cron job fetches new entries, Ollama classifies each abstract against a relevance prompt trained on the vault's existing paper tags, and high-relevance papers get queued for Einstein's next Claude session. This is one of the easiest perception channels to build because the data sources are well-structured and the classification task is well-defined.

### Grants and Funding

Every deadline, every progress report due date, every budget period, every no-cost extension window. NIH RePORTER monitoring for competing and complementary awards. RFA tracking based on NIH strategic plan cycles and institute priorities. When a relevant RFA drops, the system has already drafted a preliminary concept note based on current projects and capabilities.

**Implementation note:** NIH RePORTER has a [REST API](https://api.reporter.nih.gov/) for searching funded projects. NIH Guide (grants.nih.gov) has an RSS feed for new funding opportunities. Both can be polled daily. The Marvin NIH Reporter agent already queries this API — the gap is continuous monitoring rather than on-demand queries.

### Meeting Transcripts

After every meeting (via Granola, Otter, or Zoom transcription), the system processes the transcript with understanding of who spoke, which statements are action items vs. social pleasantries, which commitments are real, what decisions were made, and what was mentioned but not resolved. Action items become tasks assigned to the right agents. Decisions update project status. If someone mentioned a paper or dataset, it's already been looked up.

**Implementation note:** Granola stores transcripts locally and has a CLI (`granola`) for retrieval. The Marvin pipeline already processes these via `/marvin:meeting-process`. The gap is automatic detection of new transcripts (filesystem watcher on Granola's data directory) rather than manual invocation.

---

## The Agent Team

Five specialized agents with distinct roles, domain expertise, and autonomous communication with each other. They run in isolated containers with persistent session state — containers that spin up on events and resume their prior context, with Ollama handling continuous background processing between Claude invocations.

### Claire — Chief of Staff

The orchestrator. She synthesizes information from all sources, composes briefings, manages the other agents, and serves as the primary interface. She has the broadest context and the highest judgment requirements. She decides what rises to your attention and what gets handled silently.

Claire's unique capability is **prioritization under ambiguity**. When three things are urgent, she knows which one you'd want to handle first based on your patterns, the relative stakes, and the time sensitivity. She doesn't just rank by deadline — she models your actual decision-making: "Mike will want to deal with the student crisis before the grant review because he always prioritizes people, even when the grant deadline is closer."

Claire is also the **editor**. She doesn't just aggregate outputs from other agents — she composes them into a single coherent briefing, deciding what level of detail each item needs, what order to present them in, and what to leave out entirely.

Claire inherits Marvin's session flow: the morning briefing, the continuous checkpoint cycle, the end-of-session summary, and the heartbeat auto-save. But unlike Marvin, Claire doesn't wait for you to start a session — she's always on, composing and delivering information as events arrive.

### Jennifer — Executive Assistant

Handles the operational fabric of both professional and personal life. In LAB-claw: email triage, scheduling, travel, expenses, letters of recommendation (via michael.gandal@pennmedicine.upenn.edu and Outlook). In HOME-claw: personal errands, family coordination, personal calendar management (via mgandal@gmail.com and the MJG/family calendars). She manages two personas and never mixes them.

Jennifer's unique capability is **social calibration**. She knows that emails to the department chair require a different tone than emails to a postdoc. She knows that "I'll circle back next week" from a program officer means something different than from a grad student. She drafts correspondence that sounds like you — not generic, not overly formal, but in your actual voice, adjusted for the recipient and context.

Jennifer inherits Marvin's contact tracking system — every email interaction updates the relevant collaborator profile in `areas/people/collaborators/`, keeping `last_contact`, `next_action`, and interaction history current for every person in the network. She also inherits the expense report system (CNAC-ORG-BC-FUND codes, CREF numbers).

### Einstein — Research Scientist

Monitors the scientific landscape and produces research intelligence. Reads papers, tracks competitors, synthesizes literature, identifies opportunities, writes grant sections, and maintains the vault's `wiki/` section. His domain is the science itself — the ideas, the methods, the data, the field.

Einstein's unique capability is **scientific synthesis**. He doesn't just summarize papers — he places them in the context of your research program. "This paper challenges Assumption 3 in your R01 Aim 2, but their sample size is small (N=47) and they used an older reference panel. Worth monitoring but not worth pivoting for yet." He thinks about your science the way a senior collaborator would.

Einstein inherits Marvin's knowledge base processing pipeline and the vault's structured paper/tool/dataset/method templates with full frontmatter. He maintains living literature reviews that update as new papers are published.

### Sep — Data Scientist

The computational engine. Analyzes datasets, builds pipelines, tracks tools and methods, writes code, monitors the lab's computational infrastructure. He knows every dataset the lab has access to, what's been analyzed, what hasn't, and what analyses would be possible but haven't been attempted.

Sep's unique capability is **proactive analysis**. "You have the Velmeshev data and the Wamsley data on the CHOP cluster. No one has compared their astrocyte signatures using the same pipeline. That analysis would directly support Aim 2 of the SFARI grant and would take approximately 4 hours of compute time." He doesn't wait to be asked — he identifies analytical opportunities and proposes them.

### Franklin — Lab Manager

Handles lab operations: purchasing, vendor coordination, equipment maintenance, space management, onboarding, compliance, safety training schedules, animal protocol renewals. He knows the lab's physical and administrative reality from the vault's `lab/` section.

Franklin's unique capability is **operational foresight**. He tracks inventory consumption rates and reorders before things run out. He knows that new students starting in September need accounts provisioned in August. He remembers that the last time the sequencer was serviced was 6 months ago and the manufacturer recommends annual maintenance. He handles the hundred small things that, if dropped, would slow the lab down.

### How They Coordinate

**Current state:** Agents within a group coordinate via the Claude Code SDK's native multi-agent system — `TeamCreate` spawns subagents within a session, and `SendMessage` allows them to communicate. Each subagent sends messages to Telegram with a distinct bot identity via the `sender` parameter in `mcp__nanoclaw__send_message`. This is intra-group coordination.

**What doesn't exist yet: inter-group coordination.** Einstein (SCIENCE-claw) cannot currently send a message to Jennifer (LAB-claw). The IPC system is container → host only; there is no agent → agent pipe. The main group has elevated privileges (can send to any registered JID and schedule tasks for any group), but this is administrative access, not a pub/sub bus.

**The gap: the inter-agent message bus.** The vision describes a filesystem-based pub/sub system:

```
data/bus/
├── inbox/              New events, timestamped JSON
├── processing/         Claimed by an agent (moved atomically)
├── done/               Completed (retained 72h for undo)
├── topics/
│   ├── email/
│   ├── research/
│   ├── scheduling/
│   ├── lab-ops/
│   └── personal/
└── agents/
    ├── einstein/
    │   ├── queue.json  Items waiting for this agent
    │   └── output.json Recent outputs for Claire to synthesize
    ├── jennifer/
    ├── franklin/
    ├── claire/
    └── sep/
```

**Implementation approach:** This doesn't require changes to the container runtime. It requires:

1. **A bus directory** mounted read-write into all containers (or per-agent subdirectories mounted selectively for isolation).
2. **A new IPC task type** (`bus_publish`) that agents use to post messages to the bus. The host's IPC watcher writes the JSON file to the appropriate topic directory.
3. **A bus subscription config** (`bus-subscriptions.yaml`) mapping topics to agent queues. When a message arrives for topic `research`, the host copies/symlinks it to Einstein's and Sep's queues.
4. **Queue injection into context:** When a scheduled task fires for an agent, the host reads their queue and includes pending messages in the container's context (via the existing IPC input mechanism — files written to `/workspace/ipc/input/`).

This is engineering, not research. The hardest design decision is **how much bus state to inject into context** — too much and you burn tokens, too little and agents miss cross-domain signals. A good starting point: inject only the last 24h of queue messages, summarized by Ollama into a compact JSON digest.

---

## A Day in the Life

Monday morning, 6:47 AM. You haven't opened your phone yet. The system has already been working for two hours.

At 4:30 AM, Einstein's scheduled task processed 11 new bioRxiv preprints posted overnight. Ollama classified them — 6 irrelevant, 3 low-relevance (filed), 2 high-relevance. A Claude session spun up for the two that mattered. One is from the Geschwind lab — a spatial transcriptomics analysis of human fetal cortex using the same MERFISH platform your lab just acquired. Einstein read the full text, compared their analytical approach to Sep's current pipeline, identified three methodological differences that matter, and wrote a two-page technical comparison to the vault. He flagged it for your attention but didn't wake you.

At 5:15 AM, Jennifer's email watcher detected three overnight emails. Ollama classified them — two routine, one high-priority. The routine ones (meeting confirmation, seminar announcement) were handled by Ollama directly: confirmed the meeting, added the seminar to your calendar with a note about a conflict. The third email is from an NIH program officer responding to your R01 resubmission inquiry. A Claude session spun up for Jennifer — she drafted three possible response strategies (ranging from cautious to assertive) and queued it for your morning briefing.

At 6:00 AM, Franklin's scheduled inventory check ran. Ollama scanned the procurement records — RNA extraction kits are running low and there's a bulk discount expiring Wednesday. Franklin prepared a purchase order but held it because it's over the auto-approve threshold. He also noticed that a rotation student's end date is Friday and no exit meeting is scheduled.

At 6:30 AM, Claire's morning briefing task fired. She read the output files from Einstein, Jennifer, and Franklin. She knows your calendar today: clinic from 9-11, then meetings at 11:30, 1:00, and 3:00, with a gap from 2-3 that she's been protecting all week because the APA review is overdue. She knows your energy patterns — you do your best writing before 11 AM, but Mondays you're in clinic. She composed the briefing.

Your phone buzzes once at 6:47 AM. One Telegram message from Claire. Not five agents talking over each other — one composed message that reads like a note from a human chief of staff who has been in the office since dawn:

> Monday March 23. Clinic this morning, 3 meetings after.
>
> *Needs your decision:*
> • NIH program officer replied about the R01 resubmission. Jennifer has 3 draft responses ready — the short version is they're open to a revision if you address Reviewer 2's power analysis concern. I'd suggest the middle option (firm but collaborative). Say "send option B" or "show me all three."
> • Franklin needs approval for RNA extraction kits ($2,400, bulk discount expires Wednesday). Say "approve" or "hold."
>
> *FYI:*
> • Geschwind lab posted a fetal cortex MERFISH paper overnight. Einstein wrote a comparison — it's in the vault. Three things they did differently that matter for our pipeline. Sep is already reviewing.
> • Rishi's rotation ends Friday. No exit meeting scheduled. Want me to handle it?
>
> Your 2-3 PM gap is still protected for the APA review.

You reply "send option B, approve, yes handle Rishi" while brushing your teeth. Eleven words. That triggers:

- Jennifer finalizes response option B, sends it from your pennmedicine.upenn.edu account (she has earned auto-trust for NIH correspondence you've pre-approved)
- Franklin submits the purchase order
- Claire schedules a 30-minute exit meeting with Rishi on Thursday, sends him a warm note about his rotation contribution

By the time you walk into clinic at 9 AM, all three are done.

At 10:15 AM during clinic, your phone buzzes. Claire knows you're in clinic so she only interrupts for things that meet the interruption threshold:

> Quick one — Cooper's thesis committee meeting just got moved to tomorrow 2 PM. That was your APA review block. I moved the review to Wednesday's 3-4 PM gap. If that doesn't work, reply with a better time.

You don't reply. Silence is consent for scheduling changes below a certain priority level. Claire logs it and moves on.

At 11:45 AM between meetings, you forward a photo of a whiteboard from a collaborator's office. No caption. Ollama's vision model OCRs the content, recognizes it as a study design diagram, routes it to Einstein and Jennifer. Einstein identifies connections to the SPARK consortium. Jennifer notices a mentioned "budget call Thursday" and adds prep to your calendar. You get no message about this. It'll surface in tomorrow's briefing if relevant.

At 2:00 PM, Einstein finishes the Geschwind MERFISH paper analysis. He posts to the bus:

```json
{
  "topic": "spatial-transcriptomics",
  "from": "einstein",
  "finding": "Hierarchical clustering outperforms our Leiden-based method on sparse data",
  "action_needed": "sep",
  "priority": "medium"
}
```

Sep's next run picks this up, evaluates the method on your pilot data, and posts back: 15% improvement, 3-hour runtime cost, recommends adoption. At 5 PM, Claire's daily digest synthesizes it:

> Einstein and Sep evaluated a new clustering method from the Geschwind lab's MERFISH paper. 15% improvement for deep cortical layers, 3-hour runtime cost. Sep recommends adopting it. Comparison report in the vault. Want to discuss or approve the pipeline change?

You say "approve, nice work." Sep updates the pipeline. Einstein adds the paper to the vault with cross-references. Done.

**Honest note on the day-in-the-life narrative:** This scenario assumes all five gap components are built (event-driven perception, Ollama tier, inter-agent bus, trust framework, precomputed context). Today, the same day would look like: you open Telegram, type a message asking Claire for a briefing, wait for a container to spin up (5-15 seconds), and get a response that required Claude to read your calendar, email, and vault state from scratch (~50K tokens). The narrative is achievable but requires building the infrastructure described in this document.

---

## Genuine Anticipation

The difference between reactive and proactive is the difference between a secretary and a chief of staff.

### The Monday Morning Briefing

Not a list of meetings — a narrative of the week:

> This week's pressure point is the SFARI progress report (due Friday). You have drafts from the spatial team but nothing from the clinical arm. I'd suggest moving your Wednesday afternoon free block to writing time and sending a nudge to the clinical team today.
>
> The Flint seminar on Thursday overlaps with your CHOP meeting. The Flint talk will be recorded; the CHOP meeting won't. Flint is presenting work adjacent to the Cameron eQTL paper Einstein just added to the KB, so you'll want to watch the recording eventually.
>
> Your protected deep-work blocks are Tuesday 1-3pm and Thursday 9-11am. Deep-work queue: APA review (90 min), two paper reviews (45 min each), SFARI intro (60 min). That's 4 hours of work for 4 hours of blocks — tight but possible if nothing else comes in.

### Meeting Intelligence

Before each meeting: a prep brief — not a calendar entry, but actual context. Who you're meeting, your relationship history, what you last discussed, what's changed since then, what they might raise (inferred from their recent emails, papers, Slack activity), what you should raise, relevant deadlines. A suggested opening if it's been a while.

After each meeting: the system processes the Granola transcript. It extracts action items — but not naively. It knows which "I'll send that over" promises are real commitments vs. social pleasantries. Real ones become tasks assigned to the right agents. Decisions update project status. If someone mentioned a paper, it's already been looked up.

### Sensing Drift

When a project hasn't had a commit in two weeks, when a collaborator hasn't responded to three emails, when a grant aim is falling behind its milestone timeline, when a student's Slack activity drops off:

"The spatial transcriptomics integration has stalled — last activity was March 4. This may be finals-related (spring semester ends April 28). Suggest a check-in at your next 1:1, which is... not scheduled. Want me to propose a time?"

### The Overcommitment Guard

> You agreed to three new collaborations this month. Your current commitments already exceed your available research hours by ~15%, based on your calendar, active grants, and writing obligations. The two lower-priority collaborations could be deferred 6-8 weeks without relationship cost. Want me to draft polite timeline emails?

This requires modeling actual capacity — not just calendar hours but productive hours. Clinical weeks cut research time in half. Grant deadline weeks consume everything. Monday mornings are protected focus time. You chronically underestimate how long paper reviews take. The system knows all of this.

---

## Fluid Interaction Tiers

### Push Notifications (Telegram)

The lightest touch. A morning summary. An urgent flag. A "3pm cancelled" ping. Ruthlessly filtered — 3-5 per day, not 30. The system knows urgent-for-you vs. urgent-for-someone-else.

### Quick Exchanges (Telegram)

"What's the status of the Wamsley reanalysis?" → 30-second answer. "Draft a reply to Sarah's email" → draft in under a minute. "Approve" → complex multi-step action because the system already has context.

### Deep Sessions (MARVIN / Claude Code)

Grant strategy, paper writing, pipeline debugging, research deep dives. All context pre-loaded — you never start cold. The first message can be "let's work on the SFARI progress report" and everything is already assembled: aims, timeline, drafts, status, new results, program officer feedback.

### Autonomous Execution

Scheduling meetings. Filing expenses. Processing routine emails. Updating the knowledge base. Reordering supplies. Tracking deadlines. You review a daily log and veto anything wrong. Boundaries self-adjust based on approval patterns.

---

## Trust Calibration

Every combination of `(agent, action type, context)` maps to an autonomy level:

- **Autonomous**: Do it, log it, daily digest. Jennifer confirming meetings. Franklin ordering supplies < $200. Einstein saving paper summaries.
- **Notify**: Do it, tell me now. Jennifer rescheduling. Einstein flagging a competitor preprint. Calendar changes during clinic.
- **Draft**: Prepare it, wait for approval. Emails to external people. Grant sections. Communications outside immediate circle.
- **Ask**: Don't even prepare — ask first. Money > $500. Personnel decisions. Institutional leadership. Commitments > 3 months.

### Learned, Not Configured

The matrix starts conservative. Over time, it proposes promotions based on observed approval patterns:

> Jennifer's meeting confirmations: approved 47/47 times. Suggest promoting to autonomous?

> You've been reviewing Jennifer's scheduling emails for 3 months, never changed one. This review costs ~15 min/day.

Trust is context-sensitive. The same email type gets different trust levels depending on recipient (lab member vs. study section member). The system models reputational risk — boundaries are tighter where mistakes cost more.

**Implementation approach:** The trust matrix is a YAML file on the host, read by the event router when deciding how to handle Ollama-classified events:

```yaml
# data/trust.yaml
jennifer:
  email:
    meeting_confirmations:
      level: autonomous    # promoted 2026-04-15 (47/47 approvals)
      promoted_from: draft
      approval_count: 47
      rejection_count: 0
    lab_scheduling: autonomous
    external_collaborators: draft
    nih_correspondence: draft
    department_admin: draft
  calendar:
    internal_reschedule:
      level: notify       # promoted 2026-05-01
      context: "except during clinic hours → draft"
    external_meetings: draft

einstein:
  research:
    add_paper_to_vault: autonomous
    flag_for_attention: autonomous
    update_pipeline: draft  # Sep can recommend, you approve

franklin:
  procurement:
    under_200: autonomous
    200_to_2500: draft
    over_2500: ask
```

The event router reads this file, matches the current event against the matrix, and either (a) handles it via Ollama + scripts (autonomous), (b) handles it and sends a Telegram notification (notify), (c) prepares a draft and queues it for approval (draft), or (d) sends a question to Telegram (ask).

**Approval tracking:** A SQLite table records every trust-relevant action: `(timestamp, agent, action_type, context, autonomy_level, approved, edited, rejected)`. A weekly cron job analyzes this table and proposes promotions where the approval rate exceeds 95% over 30+ instances. Promotions are proposed via Telegram message and require explicit "yes" to update `trust.yaml`.

**Why this works without an API:** The trust matrix is evaluated by the event router (a host-side script), not by Claude. Ollama classifies the event, the router checks the matrix, and only events at "draft" or "ask" level require a Claude session. This means the trust system itself consumes zero API tokens — it's pure configuration + deterministic logic.

---

## Research Partnership

Beyond administration, the system is a genuine intellectual collaborator.

### Living Literature Reviews

Continuously updated reviews for each research area. When writing a grant, the system constructs the argument, identifies gaps, knows which reviewers care about which framing — because it's been tracking study section compositions and recent awards. Reviews update automatically as new papers are published.

### Data Awareness

Sep maintains a complete dataset inventory. "You have the Velmeshev data and the Wamsley data on the CHOP cluster. No one has compared their astrocyte signatures. That analysis would directly support Aim 2." "The new BrainSpan release includes temporal cortex samples you've been waiting for. Download will take 6 hours. Want me to start it tonight?"

### Methods Intelligence

When a new method outperforms scVI on your benchmarks, Sep evaluates migration cost. When Seurat releases a breaking change, it's flagged before anyone hits the error. "Geschwind's group switched from Seurat to Scanpy. Their clustering outperforms yours by ~15% on sparse data. Sep has already evaluated on your pilot dataset."

### Grant Strategy

Which institutes fund your work, which study sections review it, who serves on those sections, what they've funded recently, what their priorities are. R01 vs. R21, NIMH vs. NICHD, which study section to request — data-driven recommendations based on success rates and competitive landscape.

### Journal-Aware Writing

Style adapts to target journal. Molecular Psychiatry reviewers push back harder on methods than Nature Neuroscience. Cell Genomics expects extensive supplementary descriptions. The system knows your writing tics. Learned from your publication history, reviewer comments, and revision patterns.

---

## Multi-Modal Awareness

- **Photo of whiteboard** → Ollama vision OCR → route to relevant agents → file in project folder
- **Receipt photo** → Franklin processes expense: vendor, amount, grant to charge, reimbursement filed
- **Voice memo** → local Whisper transcription → Ollama classifies → route by content (research idea → Einstein, errand → Jennifer)
- **Meeting transcript** → Granola → action items extracted, decisions logged, unresolved items queued, papers/datasets mentioned already looked up
- **Forwarded PDF** → PageIndex hierarchical indexing → summary to vault → full text searchable via QMD

**Implementation note on vision/voice:** Ollama supports multimodal models (LLaVA, Bakllava) for image understanding, and Whisper runs locally via `whisper.cpp` or the `faster-whisper` Python package. NanoClaw already has skills for `add-image-vision` and `use-local-whisper`, though their current implementation routes through Claude containers rather than local-only processing. The Tier 1 optimization is to run vision OCR and voice transcription entirely locally before deciding whether the content needs Claude.

---

## System Self-Awareness

### Anomaly Detection

A lightweight deterministic daemon (not an LLM) continuously watches: container spawn rates (runaway tasks), token usage estimates (cost anomalies), error rates by agent (degraded performance), MCP endpoint health (infrastructure failures), message queue depth (bottlenecks), Ollama response times (local inference degradation), memory system coherence (stale/conflicting information).

When any metric exceeds its threshold: pause the offending component, notify via dedicated "System" Telegram channel, log detailed incident report.

**Implementation note:** NanoClaw already has run logging in SQLite (`run_log` table with group, message hash, success/failure, timing). The anomaly detector is a cron job that queries this table: container spawns per hour, failure rate over last 24h, average response time trend. Thresholds can be simple static values initially (>10 spawns/hour = alarm, >30% failure rate = pause group, response time 3x baseline = warning). A 30-line script, not a service.

### Graceful Degradation

No single failure brings down the system. SimpleMem down → local memory only. Gmail auth expired → read-only mode, queue drafts. Ollama slow → skip local calls, queue for Claude batch. Vault unreachable → cached versions, queue writes. Each degraded state communicated clearly with automatic recovery when the service returns.

### Self-Improvement

The system runs its own retrospectives:

- What did I predict that was wrong? (Meeting prep that missed the actual agenda)
- What did I miss? (Information I had but didn't surface)
- What did I surface that wasn't useful? (Alerts ignored, briefing items not actionable)
- Where did agents disagree? (What happened after?)

These feed back into priority scoring, alert thresholds, and agent coordination. Not retraining — calibration of attention, urgency, and trust.

The loop inherits Marvin's `tasks/lessons.md` pattern — every correction generates a rule that prevents the same mistake. At scale, patterns across hundreds of interactions reveal calibration drift, coverage gaps, and emerging needs before they're reported.

---

## What Already Exists

| Component | Status | Source | Notes |
|-----------|--------|--------|-------|
| Container isolation + crash recovery | Built | NanoClaw | Apple Container runtime |
| Multi-agent teams (5 named personas) | Built | NanoClaw | Via Claude Code SDK TeamCreate/SendMessage |
| Bot pool identities (Telegram swarm) | Built | NanoClaw | 4 pool bots + main bot |
| Filesystem IPC (container → host) | Built | NanoClaw | JSON files, host polls, one-way |
| Task scheduler (cron, interval, once) | Built | NanoClaw | 30-min minimum safety net on cron |
| Credential proxy | Built | NanoClaw | API key + OAuth modes |
| Session continuity (SQLite + SDK resume) | Built | NanoClaw | 2h idle / 4h max-age expiry |
| MCP integrations (11 servers) | Built | NanoClaw | QMD, SimpleMem, Ollama, Gmail, PubMed, etc. |
| Group-scoped memory | Built | NanoClaw | Per-group CLAUDE.md + memory.md |
| SimpleMem (shared long-term memory) | Built | NanoClaw + Marvin | LanceDB, Dropbox-synced |
| QMD search (1700+ docs indexed) | Built | NanoClaw | BM25 + vector + reranking |
| Obsidian vault with AGENTS.md | Built | Marvin | 800+ documents, YAML frontmatter |
| Contact tracking (collaborator profiles) | Built | Marvin | 32+ collaborator files |
| Email triage (8 categories, 3 priorities) | Built | Marvin | Mac Mail + Gmail API |
| Meeting transcript processing (Granola) | Built | Marvin | `/marvin:meeting-process` |
| Custom subagents (8 specialized) | Built | Marvin | NIH Reporter, dossier, deadline, etc. |
| Session workflow (/marvin, /end, /update) | Built | Marvin | Session logs, state tracking |
| Self-improvement loop (lessons.md) | Built | Marvin | Correction → rule pattern |
| PageIndex (PDF hierarchical indexing) | Built | NanoClaw | LLM-powered TOC detection |
| Remote control (Claude Code via Telegram) | Built | NanoClaw | Spawn session, share URL |
| Ollama (local inference + embeddings) | Running | Infrastructure | qwen3-embedding active |
| Apple Notes MCP | Built | NanoClaw | Search + read |
| Todoist MCP | Built | NanoClaw | Bidirectional task sync |

---

## What Makes This Different

**It's event-driven, not request-response.** You don't ask it to check your email. Email arrives and is processed. You don't ask it to monitor preprints. New papers are read and assessed. The system is always working, not waiting.

**It's multi-agent with genuine coordination.** The agents have different tools, different memory, different trust levels, different autonomy boundaries, and they communicate with each other without you in the loop. Einstein's finding triggers Sep's evaluation triggers Claire's briefing, and you see the result, not the process.

**It's token-conscious by design.** The two-tier architecture isn't a compromise — it's the right design. Local models handle perception and classification. Claude handles judgment and creation. The system gets smarter not by using more tokens but by using them more precisely.

**It learns from observation, not instruction.** Your approval patterns become trust boundaries. Your scheduling preferences become constraints. Your writing style becomes its voice. Your priority intuitions become its ranking model. Over months, the gap between what it does autonomously and what you would have done narrows toward zero for routine decisions.

**It's built on local infrastructure, synced via Dropbox.** The vault, the memory systems, the agent processes — all local. Dropbox syncs across machines. The only external dependency is the LLM API. Everything else is yours.

---

## The Remaining Gap

The foundation is built. Here is what's needed, in order of implementation priority and with honest complexity assessments:

### 1. The Event Router (New Host-Side Component)

**What:** A lightweight process (Node.js or Python) that receives events from watchers, calls Ollama for classification, checks the trust matrix, and either handles the event directly or queues it for the appropriate agent's next Claude session.

**Why first:** This is the backbone of both the Ollama tier and the trust framework. Without it, every event still requires a full Claude container invocation. With it, 80% of events are handled at zero token cost.

**Complexity:** Medium. The router itself is ~500 lines. The hard parts are: (a) defining the Ollama classification prompt templates per event type (email, calendar, paper, Slack) with structured JSON output schemas, (b) calibrating confidence thresholds (too low = Claude gets overwhelmed, too high = important things get mishandled), and (c) building the "handle autonomously" action library (confirm meeting, add to calendar, file paper, send acknowledgment).

**Depends on:** Ollama (already running), trust.yaml (simple to bootstrap with conservative defaults).

### 2. Event-Driven Perception

**What:** Replace polling with push for the three highest-value channels: email (IMAP IDLE), Slack (Socket Mode), and filesystem (fswatch/chokidar for vault changes and Granola transcripts).

**Why second:** Without event-driven perception, the system can only react on a schedule (cron). With it, the morning briefing is assembled from events that were processed in real-time overnight, not from a batch scan at 6:30 AM.

**Complexity:** Low-Medium per channel.
- **IMAP IDLE:** ~100 lines of Python. Maintains persistent connections to Gmail and Exchange IMAP servers. On new message, emits an event to the router. Well-understood protocol, many libraries.
- **Slack Socket Mode:** ~150 lines of Node.js using `@slack/socket-mode`. Opens WebSocket, receives events, emits to router. No public URL needed.
- **Filesystem watcher:** ~50 lines. Watch Granola's data dir, vault inbox, and the bus directory. Node.js `chokidar` or macOS `fswatch`.
- **Calendar:** Keep polling via iCalBuddy at 60s intervals — calendar events change infrequently enough that push isn't worth the complexity.

**Depends on:** The event router (component 1).

### 3. The Inter-Agent Message Bus

**What:** The filesystem-based pub/sub system that enables cross-group agent coordination.

**Why third:** Without the bus, Einstein can't tell Sep about a paper, and Claire can't synthesize outputs from all agents. The agents work in isolation, which defeats the team metaphor.

**Complexity:** Medium.
- The bus directory structure and JSON message format: straightforward.
- The subscription config and routing logic: straightforward.
- A new IPC task type (`bus_publish`): ~50 lines added to `ipc.ts`.
- **The hard part:** deciding how much bus context to inject into each agent's session. Too much = token waste. Too little = agents miss signals. Start with: inject only messages tagged `action_needed: <this_agent>` from the last 24h, plus a 3-line Ollama summary of all other activity.

**Depends on:** Nothing new — builds on existing IPC infrastructure.

### 4. Precomputed Context Injection

**What:** Scripts that assemble each agent's context packet before a scheduled task fires, drawing from vault state, bus outputs, calendar, and Ollama's structured extractions.

**Why fourth:** This is the token conservation lever. A well-assembled context packet means Claude starts with everything it needs in ~2K tokens instead of spending 20K tokens reading files.

**Complexity:** Medium. The challenge isn't technical — it's editorial. What goes in the packet? For Claire's morning briefing:
- Today's calendar (from iCalBuddy) — 20 lines
- Pending items from each agent's output.json — variable
- New bus messages since last briefing — variable
- State changes from `state/current.md` diff — 5-10 lines
- Top 3 deadlines from vault — 5 lines

A template-based approach: each agent type has a context template that specifies which data sources to pull and how to format them. The assembler script fills the template and writes it to the agent's mount point as `context-packet.md`.

**Depends on:** The bus (component 3) for agent outputs; event router (component 1) for structured event data.

### 5. The Trust/Autonomy Framework

**What:** The `trust.yaml` config, the approval tracking table in SQLite, the promotion proposal system, and the event router logic that uses the matrix.

**Why fifth:** The trust framework is most valuable *after* the event router and bus exist, because those are the systems that generate trust-relevant actions. Building trust first would mean configuring it for a system that doesn't yet produce the events it's meant to govern.

**Complexity:** Medium-High. The technical implementation is straightforward (YAML config, SQLite table, cron analysis script). The hard part is **getting the defaults right.** Too conservative and the system is useless (everything requires approval). Too permissive and you get a "sorry I sent that email to the wrong person" incident that destroys trust permanently. The right approach: start with everything at "draft" except the most trivially safe actions (file a paper summary, add a calendar event without inviting anyone), and let the promotion system gradually open up.

**Safety engineering:** The trust matrix must have hard-coded floors that cannot be promoted past — actions like "send email to external person" should never reach "autonomous" without a manual config edit, regardless of approval rate. The promotion system only operates within defined ceilings.

**Depends on:** Event router (component 1) for action classification; SQLite (already exists in NanoClaw).

### 6. The Knowledge Graph (Layer 5)

**What:** SQLite index of entities and relationships extracted from vault frontmatter and Ollama entity extraction.

**Why sixth:** The graph makes everything else better — search, context assembly, drift detection, cross-domain connections — but the system works without it. It's an amplifier, not a prerequisite.

**Complexity:** High. Not because graphs are hard, but because **entity resolution at scale is hard.** Is "Geschwind D" the same as "Daniel Geschwind" the same as "D.H. Geschwind"? Ollama can resolve most cases, but errors compound — a mismerged entity poisons every traversal that touches it. The graph needs: (a) conservative merging (require high confidence before merging entities), (b) a human review queue for ambiguous merges, and (c) the ability to split entities that were incorrectly merged.

**Depends on:** Ollama (for entity extraction), vault (for frontmatter relationships).

### The Remaining Hard Problems

These are not engineering tasks — they're unsolved (or partially solved) challenges:

**Judgment under ambiguity.** Knowing that a cold email thread means they're busy (wait) vs. losing interest (follow up now) vs. didn't see it (resend). Knowing that a student's quiet week is exam-related (normal) vs. disengagement (intervene). Current models can approximate this. The trust calibration system handles consequences of getting it wrong. The aspiration is genuine situational judgment that improves with every observed outcome. This gets better as the knowledge graph and SimpleMem temporal model mature — more context enables better judgment.

**Coherent identity across time.** A human chief of staff who's been with you for 10 years has a continuous identity — they remember not just facts but the *feeling* of past interactions, the evolution of relationships, the way priorities shifted over seasons. Current agents have session-bounded identity stitched together with memory systems. The five-layer memory architecture is the foundation for continuity. What remains is making the stitching seamless enough that no session boundary is perceptible. This improves incrementally as SimpleMem gains temporal awareness and the knowledge graph captures relationship evolution.

**Ollama accuracy ceiling.** The 80/20 split assumes Ollama handles routine classification accurately enough. In practice, small models make mistakes — misclassifying an urgent email as routine, missing an entity, routing to the wrong agent. The system needs a feedback loop: when Claude processes a batch and discovers Ollama misclassified something, that correction should adjust the classification prompt or confidence threshold. Without this feedback, Ollama's error rate stays constant even as the system matures.

None of these are blockers. The system delivers value from component 1 onward. Each subsequent component amplifies the value of everything before it. The path is incremental — start with the event router, add perception channels, build the bus, inject context, layer on trust, and let the knowledge graph emerge as the capstone.
