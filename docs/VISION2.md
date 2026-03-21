# The Optimal Executive AI: A Complete Description

## What It Is

An ambient intelligence that wraps around your entire professional and personal life. It never sleeps, never polls, never waits for you to open a terminal. It perceives everything happening across your digital surfaces in real-time, maintains a deep structured understanding of your world, acts autonomously within calibrated trust boundaries, coordinates a team of specialized agents without you as the router, and learns from every interaction to get better every day.

It is not a chatbot. It is not an assistant you summon. It is an extension of your executive function — the part of your brain that tracks, prioritizes, remembers, follows up, connects dots, and catches things before they fall. You focus on what only you can do: the scientific thinking, the mentoring, the clinical judgment, the creative leaps. Everything else just happens.

---

## Two-Tier Intelligence

The system operates under a hard constraint: **no hosted API calls for background work.** Every token of Claude reasoning is precious — used for judgment, synthesis, and creativity. Everything else runs locally at zero marginal cost.

### Tier 1: Local Models (Always Running, Zero Cost)

Small local models (Llama 3.1 8B, Phi-3, Mistral 7B via Ollama) handle the continuous background work that constitutes 80% of system activity:

- **Classification**: Is this email urgent / routine / ignorable? Is this Slack message for me or just noise?
- **Entity extraction**: Who / what / when from this message, this transcript, this paper abstract
- **Routing**: Which agent domain does this belong to? Does it need Claude or can Ollama handle it?
- **Simple drafting**: Meeting confirmations, acknowledgments, routine scheduling responses
- **Memory tagging**: Classifying and indexing new information into the knowledge graph
- **Event detection**: Did something change that matters? New email, calendar update, file change, Slack mention
- **Summarization**: Condensing low-stakes content into structured JSON for upstream consumption

These run continuously. They consume local GPU/CPU but zero API tokens. They're wrong sometimes — and that's fine, because they're triaging and extracting, not deciding. Everything above their confidence threshold gets queued for Claude.

### Tier 2: Claude (Invoked When Needed, Token-Conscious)

Claude handles everything that requires genuine reasoning:

- Nuanced judgment (the NIH program officer response, the tenure committee email)
- Complex synthesis (the Monday briefing, cross-project status reports)
- Multi-step reasoning (grant strategy, paper analysis, debugging a student's stalled project)
- Creative work (drafting emails in your voice, writing grant sections, composing meeting briefs)
- Cross-domain connection (linking a new paper to three grants and a student's project)
- Social calibration (knowing that "I'll circle back" from a program officer means something different than from a grad student)

**Critical insight: Claude sessions don't have to be interactive.** NanoClaw already spawns headless agent containers from scheduled tasks. The morning briefing, the paper review queue, the email draft batch — these all run as scheduled Claude sessions with pre-assembled context, writing outputs to the IPC bus. You see results in Telegram, not in a terminal.

### The Handoff

The boundary between tiers is the system's most important optimization surface. Ollama processes raw events into structured data — JSON with confidence scores, entity tags, urgency ratings. Claude never reads raw emails or raw paper abstracts for routine work. It reads Ollama's structured output and makes decisions on pre-digested information.

```
Raw event (email arrives)
  → Ollama: classify, extract, route → structured JSON
    → Below confidence threshold? → Queue for Claude
    → Above threshold + routine? → Handle autonomously
    → Above threshold + needs judgment? → Queue for next Claude batch
```

This means a Claude session processing 7 queued items costs the same as processing 1, because the context assembly is done by deterministic scripts reading Ollama's structured outputs.

---

## Always-On Perception

Every information source streams into a unified perception layer. Not batched hourly. Event-driven: the moment something changes, it's detected, classified, and routed.

### Email

Every message across all accounts (Penn, Gmail, CHOP) is read the instant it arrives via push notifications (Gmail API webhooks, Exchange push subscriptions, IMAP IDLE). Each email is understood not just by its content but by its full relational context: every prior conversation with that person, every project they're involved in, every deadline that's active, the social dynamics of the relationship, and the urgency implied by the sender's communication patterns.

Ollama handles the initial classification — sender importance, topic extraction, urgency rating, suggested routing. Only emails that require judgment, drafting, or complex responses escalate to Claude. The rest are filed, acknowledged, or flagged automatically.

A message from an NIH program officer hits differently than a message from a postdoc asking about lab meeting. The system knows this — not because of a rule, but because it has observed hundreds of your email interactions and modeled how you prioritize.

### Calendar

Not just "what's next" but continuous temporal reasoning. It knows that your 2pm was moved to 3pm, that this creates a conflict with the seminar you wanted to attend, that the person you were meeting is flying out tomorrow so rescheduling to next week won't work, and that there's a 45-minute window at 4:15 if you skip the optional committee meeting — and it knows which committee meetings you actually skip vs. which ones have political cost.

Calendar changes propagate instantly through the system. When a meeting moves, every downstream dependency is re-evaluated: prep time, travel buffers, deep work blocks, the relative priority of what's being displaced. The system doesn't just show you conflicts — it resolves them, presenting you only with the genuine trade-offs that require your judgment.

### Slack and Messaging

Every channel, every DM, every thread across lab Slack, department channels, and consortium groups. It sees the lab Slack message where a student mentions their pipeline is failing on a dataset before you do, cross-references it with known issues in the analysis environment, and either answers directly (if authorized) or drafts you a message with the fix.

It distinguishes signal from noise. Most Slack messages don't need your attention. The system filters ruthlessly, surfacing only: things that require your decision, things that affect your deadlines, things where your input would meaningfully change the outcome, and things you'd want to know for relationship or awareness reasons.

### Literature

Not waiting for you to say "check bioRxiv." It monitors bioRxiv daily, PubMed alerts, researcher feeds on Twitter/Bluesky, preprint servers, and journal tables of contents. When a competing group posts a revision of a paper in your area, it reads the full text, diffs it against the previous version in your knowledge base, identifies what's new, assesses relevance to your active projects and grants, and surfaces it during your next natural break — not as an interruption, but as a queued item ranked by importance.

Ollama handles the first pass — abstract classification, relevance scoring, keyword extraction. Only papers scoring above the relevance threshold get full-text analysis by Claude. This means monitoring 50 preprints overnight costs a few minutes of Ollama time and zero Claude tokens for the 45 that aren't relevant.

It also monitors methods papers, tool releases, and dataset announcements. When a new single-cell integration method outperforms existing approaches on benchmarks relevant to your data, it notes it. When a Seurat update breaks backward compatibility, it flags it before anyone in your lab hits the error.

### Grants and Funding

It knows every deadline, every progress report due date, every budget period, every no-cost extension window. It watches NIH RePORTER for competing awards in your space. When a new R01 gets funded that overlaps with your SFARI aims, it tells you — with an assessment of whether this is a competitor, a potential collaborator, or irrelevant.

It tracks funding agency strategic plans, study section compositions, and RFA patterns. It can estimate when an RFA relevant to your work is likely to appear based on NIMH funding cycles and congressional appropriation timelines. When a relevant RFA drops, it has already drafted a preliminary concept note based on your current projects and capabilities.

---

## Deep Institutional Memory

Not flat files. Not markdown with frontmatter. A rich knowledge graph where every entity — every person, paper, dataset, grant, meeting, decision, conversation — is a node with typed relationships that update continuously.

The foundation already exists: the Obsidian vault (800+ documents), SimpleMem (semantic long-term memory), QMD (vector search over the vault), and per-group conversation archives. The evolution is from flat search to graph traversal — from "find files mentioning X" to "traverse the relationship between X and everything it touches."

### Relational Understanding

When you ask "what's the status of the XRN2 project?", it doesn't search files. It traverses: the grant that funds it → the specific aim it supports → the people assigned to that aim → their recent commits, Slack messages, and 1:1 notes → the datasets they're working with → the papers those datasets came from → the methods they're using → known issues with those methods → upcoming deadlines that depend on this work. It gives you a synthesized status that incorporates information you haven't even seen yet.

When a new postdoc candidate sends their CV, it reads every paper they've published, maps their methods expertise against your lab's current gaps, checks if they've cited your work (and in what context), identifies if any of their co-authors are in your network, compares their training trajectory to your most successful hires, and drafts a preliminary assessment — all before you've finished reading the cover letter.

### Self-Correcting Memory

When the system learns that something it believed was wrong — a date it recorded, a relationship it inferred, a priority it assumed — it propagates the correction everywhere, not just in one file. If it discovers that a collaborator changed institutions, every reference to that person updates: their email, their affiliation in grant documents, the institution listed in shared IRB protocols, the address for their letter of support.

Memory also decays appropriately. A preference you expressed two years ago carries less weight than one from last week. A priority from a grant that ended is archived, not active. The system distinguishes between facts (Rachel Smith's email address), preferences (you prefer morning meetings), and context (this week is unusually busy) — and weights them differently.

### Cross-Domain Connections

The most valuable insights come from connecting information across domains that you keep in separate mental buckets. The system sees all domains simultaneously:

- A clinical observation about a patient's presentation + a new genetics paper + a gap in your R01 aims = a potential new research direction
- A vendor discount on sequencing reagents + a dataset that needs reprocessing + a postdoc who needs a thesis chapter = an opportunity to propose a new analysis
- A seminar speaker's work + a collaboration you've been meaning to start + an upcoming site visit = a natural conversation to have

These connections surface naturally in briefings and conversations, not as forced "did you know?" alerts but as contextualized suggestions when they're relevant to what you're currently thinking about.

---

## The Agent Team

Five specialized agents with distinct roles, domain expertise, and autonomous communication with each other. They run in isolated containers with persistent session state — not truly always-on processes, but containers that spin up on events and resume their prior context.

### Claire — Chief of Staff

The orchestrator. She synthesizes information from all sources, composes briefings, manages the other agents, and serves as your primary interface. She has the broadest context and the highest judgment requirements. She decides what rises to your attention and what gets handled silently.

Claire's unique capability is **prioritization under ambiguity**. When three things are urgent, she knows which one you'd want to handle first based on your patterns, the relative stakes, and the time sensitivity. She doesn't just rank by deadline — she models your actual decision-making: "Mike will want to deal with the student crisis before the grant review because he always prioritizes people, even when the grant deadline is closer."

Claire is also the **editor**. She doesn't just aggregate outputs from other agents — she composes them into a single coherent briefing, deciding what level of detail each item needs, what order to present them in, and what to leave out entirely.

### Jennifer — Executive Assistant

Handles the operational fabric of your professional and personal life: email triage and response, scheduling, travel, expenses, reimbursements, letters of recommendation, personal errands, family coordination. She manages two personas — professional (pennmedicine.upenn.edu, Outlook calendar) and personal (mgandal@gmail.com, family calendar) — and never mixes them.

Jennifer's unique capability is **social calibration**. She knows that emails to the department chair require a different tone than emails to a postdoc. She knows that "I'll circle back next week" from a program officer means something different than the same phrase from a grad student. She drafts correspondence that sounds like you — not generic, not overly formal, but in your actual voice, adjusted for the recipient and context.

### Einstein — Research Scientist

Monitors the scientific landscape and produces research intelligence. Reads papers, tracks competitors, synthesizes literature, identifies opportunities, writes grant sections, and maintains the research knowledge base. His domain is the science itself — the ideas, the methods, the data, the field.

Einstein's unique capability is **scientific synthesis**. He doesn't just summarize papers — he places them in the context of your research program. "This paper challenges Assumption 3 in your R01 Aim 2, but their sample size is small (N=47) and they used an older reference panel. Worth monitoring but not worth pivoting for yet." He thinks about your science the way a senior collaborator would.

### Sep — Data Scientist

The computational engine. Analyzes datasets, builds pipelines, tracks tools and methods, writes code, monitors the lab's computational infrastructure. He knows every dataset your lab has access to, what's been analyzed, what hasn't, and what analyses would be possible but haven't been attempted.

Sep's unique capability is **proactive analysis**. "You have the Velmeshev data and the Wamsley data on the CHOP cluster. No one has compared their astrocyte signatures using the same pipeline. That analysis would directly support Aim 2 of the SFARI grant and would take approximately 4 hours of compute time." He doesn't wait to be asked — he identifies analytical opportunities and proposes them.

### Franklin — Lab Manager

Handles lab operations: purchasing, vendor coordination, equipment maintenance, space management, onboarding, compliance, safety training schedules, animal protocol renewals. He knows the lab's physical and administrative reality.

Franklin's unique capability is **operational foresight**. He tracks inventory consumption rates and reorders before things run out. He knows that new students starting in September need accounts provisioned in August. He remembers that the last time the sequencer was serviced was 6 months ago and the manufacturer recommends annual maintenance. He handles the hundred small things that, if dropped, would slow the lab down.

### How They Coordinate

The agents communicate through a typed message bus, not through you. Each agent publishes findings, requests, and status updates tagged with topics. Other agents subscribe to topics they care about.

The bus is filesystem-based — JSON messages in topic directories, with atomic moves for claiming and completing work. No Redis, no RabbitMQ. Just the filesystem, which is debuggable (`ls` tells you the system state), survives reboots, and costs zero tokens.

```
data/bus/
├── inbox/              # New events, timestamped JSON
├── processing/         # Claimed by an agent (moved atomically)
├── done/               # Completed (retained 72h for undo)
├── topics/
│   ├── email/          # Symlinks to messages tagged with this topic
│   ├── research/
│   ├── scheduling/
│   ├── lab-ops/
│   └── personal/
└── agents/
    ├── einstein/
    │   ├── queue.json  # Items waiting for this agent
    │   └── output.json # Recent outputs for Claire to synthesize
    ├── jennifer/
    ├── franklin/
    ├── claire/
    └── sep/
```

When Einstein finds a paper relevant to a grant, Jennifer sees the event and updates the citation database. When Franklin notices a supply shortage that affects an ongoing experiment, Sep sees it and adjusts the analysis timeline. When Jennifer schedules a meeting with a collaborator, Claire assembles a prep brief that includes Einstein's latest analysis of that collaborator's recent work.

You see the outcomes in your Telegram groups, but you don't direct the coordination. The agents figure out who needs to know what. You're the executive reviewer, not the message router.

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
> **Needs your decision:**
> - NIH program officer replied about the R01 resubmission. Jennifer has 3 draft responses ready — the short version is they're open to a revision if you address Reviewer 2's power analysis concern. I'd suggest the middle option (firm but collaborative). Say "send option B" or "show me all three."
> - Franklin needs approval for RNA extraction kits ($2,400, bulk discount expires Wednesday). Say "approve" or "hold."
>
> **FYI:**
> - Geschwind lab posted a fetal cortex MERFISH paper overnight. Einstein wrote a comparison — it's in the vault. Three things they did differently that matter for our pipeline. Sep is already reviewing.
> - Rishi's rotation ends Friday. No exit meeting scheduled. Want me to handle it?
>
> Your 2-3 PM gap is still protected for the APA review.

You reply "send option B, approve, yes handle Rishi" while brushing your teeth. Eleven words. That triggers:

- Jennifer finalizes response option B, sends it from your pennmedicine.upenn.edu account (she has earned auto-trust for NIH correspondence you've pre-approved)
- Franklin submits the purchase order through CHOP's procurement system
- Claire schedules a 30-minute exit meeting with Rishi on Thursday, adds you and Rishi, sends Rishi a warm note about his rotation contribution

By the time you walk into clinic at 9 AM, all three are done. You didn't draft anything, schedule anything, or approve anything through a web interface. You just said yes.

### How It Handles the Unexpected

At 10:15 AM during clinic, your phone buzzes. Claire knows you're in clinic (she can see the calendar) so she only interrupts for things that meet the interruption threshold:

> Quick one — Cooper's thesis committee meeting just got moved to tomorrow 2 PM. That was your APA review block. I moved the review to Wednesday's 3-4 PM gap. If that doesn't work, reply with a better time.

You don't reply. Silence is consent for scheduling changes below a certain priority level. Claire logs it and moves on.

At 11:45 AM between meetings, you forward a photo of a whiteboard from a collaborator's office. No caption. The system:
1. OCRs the whiteboard (Ollama vision model)
2. Recognizes it's a study design diagram for a multi-site ASD genetics project
3. Routes it to Einstein (research content) and Jennifer (potential collaboration follow-up)
4. Einstein identifies it as related to the SPARK consortium and drafts a vault note
5. Jennifer recognizes the handwriting mentions "budget call Thursday" and adds a prep note to your Thursday calendar

You get no message about this. It just happens. It'll surface in tomorrow's briefing if relevant.

### How the Agents Coordinate

At 2:00 PM, Einstein finishes reading the Geschwind MERFISH paper in detail. He posts to the bus:

```json
{
  "topic": "spatial-transcriptomics",
  "from": "einstein",
  "finding": "Hierarchical clustering approach outperforms our Leiden-based method on sparse data",
  "action_needed": "sep",
  "priority": "medium",
  "context": "geschwind-2026-fetal-merfish"
}
```

Sep's next scheduled run picks this up. He pulls the Geschwind paper's supplementary methods, adapts their clustering approach to your pipeline, runs it on the pilot data, and posts results back:

```json
{
  "topic": "spatial-transcriptomics",
  "from": "sep",
  "in_reply_to": "einstein-20260323-140012",
  "finding": "Hierarchical clustering improves cell type resolution by ~15% on sparse regions but adds 3 hours to runtime",
  "recommendation": "Adopt for production pipeline, keep Leiden as fast-mode option",
  "files": ["vault/99-wiki/tools/merfish-clustering-comparison.md"]
}
```

You see none of this in real-time. At 5 PM, Claire's daily digest says:

> Einstein and Sep evaluated a new clustering method from the Geschwind lab's MERFISH paper. 15% improvement in cell type resolution for deep cortical layers, 3-hour runtime cost. Sep recommends adopting it. Comparison report in the vault. Want to discuss or approve the pipeline change?

You say "approve, nice work." Sep updates the pipeline config. Einstein adds the Geschwind paper to the vault with cross-references. Done.

---

## Genuine Anticipation

The difference between reactive and proactive is the difference between a secretary and a chief of staff. The optimal system anticipates.

### The Monday Morning Briefing

Before you've opened anything, the system has composed your week. Not a list of meetings — a narrative:

> This week's pressure point is the SFARI progress report (due Friday). You have drafts from the spatial team but nothing from the clinical arm. I'd suggest moving your Wednesday afternoon free block to writing time and sending a nudge to the clinical team today.
>
> The Flint seminar on Thursday overlaps with your CHOP meeting. The Flint talk will be recorded; the CHOP meeting won't. Flint is presenting work adjacent to the Cameron eQTL paper you just added to the KB, so you'll want to watch the recording eventually.
>
> Three things need your decision today: the NIH program officer response (Jennifer has options ready), the RNA kit purchase (Franklin is holding it for your approval), and Rishi's exit meeting (Claire can handle if you approve).
>
> Your protected deep-work blocks are Tuesday 1-3pm and Thursday 9-11am. Current deep-work queue: APA review (90 min), two paper reviews (45 min each), and the SFARI progress report intro (60 min). That's 4 hours of work for 4 hours of blocks — tight but possible if nothing else comes in.

### Meeting Intelligence

Before each meeting, the system assembles a brief — not a calendar entry, but actual context:

- Who you're meeting and your relationship history
- What you last discussed and what's changed since then
- What they might want to talk about (inferred from their recent emails, papers, Slack activity)
- What you should raise (pending decisions, follow-ups from last time)
- Relevant deadlines or commitments that intersect
- A suggested opening if the meeting is with someone you haven't spoken to in a while

After a meeting, the system processes the transcript (via Granola or similar). It extracts action items — but not naively. It knows which "I'll send that over" promises are real commitments vs. social pleasantries, based on your patterns and the speaker's patterns. It creates tasks for the real ones, assigns them to the right agents, sets follow-up reminders, and updates the relevant project pages. If someone mentioned a paper or dataset, it's already been looked up.

### Sensing Drift

When a project hasn't had a commit in two weeks, when a collaborator hasn't responded to three emails, when a grant aim is falling behind its milestone timeline, when a student's Slack activity drops off — the system detects drift before it becomes a crisis.

Not as alerts. As contextualized assessments: "The spatial transcriptomics integration has stalled — last activity was March 4. This may be finals-related (spring semester ends April 28). Suggest a check-in at your next 1:1, which is... not scheduled. Want me to propose a time?"

### The Overcommitment Guard

The most valuable anticipatory function: protecting you from yourself.

> You agreed to three new collaborations this month. Your current commitments already exceed your available research hours by approximately 15%, based on your calendar, active grants, and writing obligations. The two lower-priority collaborations could be deferred 6-8 weeks without relationship cost. Want me to draft polite timeline emails?

This requires modeling your actual capacity — not just calendar hours but productive hours. It knows that clinical weeks cut your research time in half, that you write slowly on Mondays after the weekend context switch, that grant deadline weeks consume everything, and that you chronically underestimate how long paper reviews take.

---

## Fluid Interaction Tiers

The system meets you where you are, in the mode appropriate to the moment.

### Push Notifications (Telegram)

The lightest touch. A morning summary. An urgent flag when something truly needs immediate attention. A "heads up, your 3pm cancelled" ping. These are ruthlessly filtered — the system knows the difference between urgent-for-you and urgent-for-someone-else, between genuinely time-sensitive and merely marked as urgent by the sender.

Most days, you get 3-5 push notifications. Not 30.

### Quick Exchanges (Telegram)

Voice or text, phone or laptop. "What's the status of the Wamsley reanalysis?" gets a 30-second answer synthesized from Sep's latest work, the dataset status, and the grant timeline. "Draft a reply to Sarah's email about the consortium meeting" gets a draft in your inbox in under a minute. No session overhead, no context loading.

The system also handles quick decisions via structured responses: "approve," "hold," "send option B," "yes handle it." One-word answers that trigger complex multi-step actions because the system already has the context.

### Deep Sessions (MARVIN / Claude Code)

When you need to think through a grant strategy, plan a paper, debug a pipeline, or do a deep research dive. The difference from today: all context is already loaded. You never start cold. The first message of a deep session can be "let's work on the SFARI progress report" and the system has already assembled: the grant aims, the milestone timeline, drafts from each team member, the current status of each experiment, relevant new results since the last report, and the program officer's feedback from the last review.

**MARVIN and NanoClaw are complementary interfaces.** MARVIN is the deep-session tool — long, rich, interactive conversations with full Claude reasoning, file editing, code execution, and complex multi-step work. NanoClaw is the always-on layer — event-driven, continuous, push-based. They share the vault, the state files, the knowledge base, and the contact database. What NanoClaw's agents discover enriches MARVIN's context. What you build in MARVIN sessions feeds back into NanoClaw's knowledge.

### Autonomous Execution

The things the system just does, within boundaries you've set and adjusted over time. Scheduling meetings with known collaborators. Filing expense reports from receipts you photographed. Updating the lab website with new publications. Processing routine emails. Keeping the knowledge base current. Reordering lab supplies. Tracking paper revision deadlines.

You review a daily log of autonomous actions. You can veto anything. The boundaries self-adjust based on your approval patterns.

---

## Trust Calibration

The deepest architectural feature: a nuanced, learned model of trust boundaries that isn't binary allow/deny.

### The Trust Matrix

Every combination of `(agent, action type, context)` maps to an autonomy level:

- **Autonomous**: Do it, log it, include in daily digest. Jennifer confirming meetings with known collaborators. Franklin ordering supplies under $200. Einstein saving paper summaries to the vault. Sep updating pipeline configurations.
- **Notify**: Do it and tell me immediately. Jennifer rescheduling a meeting. Einstein flagging a competing preprint. Franklin reporting an equipment failure. Any calendar change during clinic hours.
- **Draft**: Prepare it, show me, wait for approval. Jennifer drafting emails to external collaborators, department chairs, or program officers. Einstein drafting grant sections. Any communication with someone outside your immediate circle.
- **Ask**: Don't even prepare it — ask me first. Anything involving money over $500. Personnel decisions. Communications with institutional leadership. Anything that creates a commitment extending beyond 3 months.

### Learned, Not Configured

The trust matrix starts conservative — almost everything is "draft" or "ask." Over time, as the system observes your approval patterns, it proposes promotions:

> Jennifer's meeting confirmations have been approved 47/47 times over the past month. Suggest promoting to autonomous?

> You've accepted Einstein's paper summaries without edits for the last 30 entries. Suggest he write directly to the vault without showing you first?

> Franklin's supply orders under $100 have been approved every time. Suggest raising his autonomous spending limit to $200?

You say yes, no, or "not yet." The system respects boundaries and never promotes without asking. But it notices patterns you might not — including patterns of *over*-caution: "You've been reviewing Jennifer's routine scheduling emails for 3 months and have never changed one. This review step costs you approximately 15 minutes per day."

### Context-Sensitive Trust

Trust isn't just per-agent — it's contextual. Jennifer can send routine emails autonomously to lab members, but the same email to an external collaborator requires a draft. The context matters: who the recipient is, what the stakes are, whether the topic is sensitive, whether you've communicated with this person recently.

The system also models **reputational risk**. An email that's slightly suboptimal to a lab member has low cost. The same quality email to a study section member has high cost. Trust boundaries are tighter where the consequences of a mistake are larger.

---

## Research Partnership

Beyond administration, the system is a genuine intellectual collaborator.

### Living Literature Reviews

Not just adding papers to a knowledge base. Constructing and maintaining a continuously updated literature review for each of your research areas. When you're writing a grant, it doesn't just find relevant citations — it constructs the argument, identifies the gaps your work fills, knows which reviewers will care about which framing, and has pre-assembled the bibliography with proper formatting for the target agency.

The literature reviews aren't static documents — they're living structures that update as new papers are published. When a new finding confirms or challenges a claim in your review, the relevant section is flagged and updated.

### Data Awareness

Sep maintains a complete inventory of every dataset your lab has access to: what's been downloaded, what's been analyzed, what pipelines were used, what results were produced, what analyses would be possible but haven't been attempted. This isn't a spreadsheet — it's a queryable knowledge structure.

"You have the Velmeshev data and the Wamsley data on the CHOP cluster. No one has compared their astrocyte signatures using the same pipeline. That analysis would directly support Aim 2 of the SFARI grant and would take approximately 4 hours of compute time."

"The new BrainSpan release includes temporal cortex samples you've been waiting for. The download will take 6 hours on the cluster. Want me to start it tonight?"

### Methods Intelligence

The system tracks methodological advances with the same rigor it tracks papers. When a new integration method outperforms scVI on benchmarks relevant to your data types, it notes it — and Sep evaluates whether migrating is worth the effort. When a tool your lab depends on releases a breaking change, the system flags it before anyone encounters the error in production.

It also tracks methods across competitor labs. "Geschwind's group switched from Seurat to Scanpy for their latest spatial paper. Their clustering approach outperforms yours on sparse data by ~15%. Sep has already evaluated it on your pilot dataset — adoption recommended for deep cortical layers, keep existing method as fast-mode option."

### Grant Strategy

The system models the funding landscape. It knows which NIH institutes fund your type of work, which study sections review it, who serves on those sections, what they've funded recently, and what their stated priorities are. It monitors RFA announcements, tracks funding trends, and estimates when opportunities relevant to your work might appear based on strategic plan cycles.

When you're considering whether to submit an R01 vs. an R21, or NIMH vs. NICHD, or which specific study section to request, the system has data-driven recommendations based on success rates, reviewer expertise matches, and the competitive landscape for your specific aims.

### Journal-Aware Writing

When drafting manuscripts or grant sections, the system adapts its style to the target. It knows that Molecular Psychiatry reviewers push back harder on methods sections than Nature Neuroscience reviewers. It knows that Cell Genomics expects extensive supplementary data descriptions. It knows your writing tics — the phrases you overuse, the places where you tend to be too terse or too verbose — and compensates.

This is learned from your publication history: every submitted manuscript, every set of reviewer comments, every revision. The system has internalized not just what you write but how different audiences respond to it.

---

## Multi-Modal Awareness

The system processes information in whatever form it arrives.

### Visual Input

You forward a photo of a whiteboard from a collaborator's office. No caption. Ollama's vision model OCRs the content, recognizes it as a study design diagram for a multi-site genetics project, and routes it to the appropriate agents. Einstein identifies connections to existing projects. Jennifer notices a mentioned "budget call Thursday" and adds prep to your calendar.

You photograph a receipt from a conference dinner. Franklin processes the expense: identifies the vendor, the amount, the grant to charge it to (based on the conference and your travel authorization), and files the reimbursement request. You never open the expense system.

### Voice Input

You voice-memo a thought while driving: "I wonder if the XRN2 knockdown would show a different phenotype in cortical organoids vs. monolayer cultures." Local Whisper transcribes it. Ollama classifies it as a research idea and routes to Einstein, who writes a brief assessment: relevant literature on XRN2 in organoids, what your lab's current organoid capacity is (checks with Franklin), and whether this could fit into an existing grant aim or needs new funding.

### Meeting Transcripts

After every meeting (via Granola, Otter, Zoom transcription, or similar), the system processes the transcript with understanding of:

- Who spoke and their role/relationship to you
- Which statements are action items vs. discussion vs. social pleasantries
- Which commitments are directed at you vs. others
- What decisions were made (explicitly or implicitly)
- What was mentioned but not resolved (future agenda items)

Action items become tasks assigned to the right agents. Decisions update the relevant project status. Unresolved items get added to future meeting agendas. If someone mentioned a paper, dataset, or tool, it's already been looked up by the time the meeting summary reaches you.

---

## Token Conservation

The system is engineered to maximize intelligence per token.

### Ollama Does 80% of the Volume

Most events are routine. Email classification, calendar parsing, entity extraction, simple responses — Ollama handles all of this at zero token cost. Only genuinely complex items escalate to Claude. The ratio of Ollama-processed to Claude-processed events should be at least 4:1 for steady-state operation.

### Precomputed Context, Not Retrieval

Instead of Claude reading 50 files each session, deterministic scripts assemble a context packet: today's schedule, pending items from each agent queue, recent state changes, relevant memories. Claude gets a dense, pre-assembled briefing — not raw files to wade through. This cuts session startup from thousands of tokens to hundreds.

### Batch, Don't Stream

Instead of invoking Claude for each email, batch all pending items into one session. "Here are 7 items that need your judgment" is far cheaper than 7 separate invocations. The scheduler's natural cadence (morning briefing, midday check, evening digest) creates natural batch windows.

### Structured Outputs from Ollama

Ollama extracts structured data (JSON) that Claude can consume without re-parsing. When Einstein's Ollama tier reads a paper abstract, it outputs `{"relevance": "high", "domains": ["spatial-transcriptomics", "asd"], "related_grants": ["SFARI"], "summary": "..."}`. Claude doesn't re-read the abstract — it reads the structured output and makes a judgment call.

### Incremental Context

Each Claude session starts with a compact state summary, not the full history. The vault is the source of truth; Claude reads only what's changed since the last session. The IPC bus naturally provides this — each agent's `output.json` contains only recent work.

---

## System Self-Awareness

The system monitors its own health and performance with the same rigor it monitors your professional life.

### Anomaly Detection

A lightweight monitoring daemon (not an LLM — deterministic code) continuously watches:

- Container spawn rates per group (detects runaway tasks)
- Token usage estimates (detects cost anomalies)
- Error rates by agent and action type (detects degraded performance)
- MCP endpoint health (detects infrastructure failures)
- Message queue depth and latency (detects bottlenecks)
- Memory system coherence (detects conflicting or stale information)
- Ollama response times (detects when local inference is degraded)

When any metric exceeds its threshold, the daemon pauses the offending component, notifies you through a dedicated channel with a clear explanation of what happened, and logs a detailed incident report.

### Graceful Degradation

No single component failure brings down the whole system.

When SimpleMem goes down, agents lose long-term memory but keep working with local context and the vault. When Gmail auth expires, Jennifer switches to read-only mode and queues outbound drafts. When Ollama is slow, agents skip local model calls and queue items for the next Claude batch. When the vault is unreachable (Dropbox sync issue), agents work from cached versions and queue writes.

Each degraded state is communicated clearly: "SimpleMem has been unreachable for 2 hours. Agents are running with local memory only. Long-term recall may be incomplete. I'll restore automatically when the service recovers."

### Self-Improvement

The system runs its own retrospectives:

- What did I predict that was wrong? (Meeting prep that missed the actual agenda, priority assessments that turned out to be miscalibrated)
- What did I miss? (Information I had access to but didn't surface, connections I should have made)
- What did I surface that wasn't useful? (Alerts the user ignored, briefing items that weren't actionable)
- Where did agents disagree? (Einstein recommended one approach, Sep recommended another — what happened?)

These retrospectives feed back into the system's models: priority scoring adjusts, alert thresholds shift, agent coordination improves. Not through retraining — through calibration of the parameters that govern attention, urgency, and trust.

---

## What Makes This Different

Most AI assistant visions describe a better chatbot — one that's faster, knows more, makes fewer mistakes. This is architecturally different in four ways:

**It's event-driven, not request-response.** You don't ask it to check your email. Email arrives and is processed. You don't ask it to monitor preprints. New papers are read and assessed. You don't ask it to track deadlines. Deadlines are anticipated and managed. The system is always working, not waiting.

**It's multi-agent with genuine coordination.** The agents aren't just different prompt personas. They have different tools, different memory, different trust levels, different autonomy boundaries, and — critically — they communicate with each other without you in the loop. The system exhibits emergent coordination: Einstein's finding triggers Sep's evaluation triggers Claire's briefing, and you see the result, not the process.

**It's token-conscious by design.** The two-tier architecture isn't a compromise — it's the right design. Local models handle perception and classification. Claude handles judgment and creation. The system gets smarter not by using more tokens but by using them more precisely: better context assembly, better routing, better batching.

**It learns from observation, not instruction.** You don't configure it by writing rules. You live your life, and it adapts. Your approval patterns become trust boundaries. Your scheduling preferences become constraints. Your writing style becomes its voice. Your priority intuitions become its ranking model. Over months, the gap between what it does autonomously and what you would have done narrows toward zero for routine decisions — freeing your attention for the genuinely novel, complex, and human.

---

## What Already Exists

NanoClaw has already built the foundation:

| Component | Status | Description |
|-----------|--------|-------------|
| Container isolation | Built | Apple Container runtime, crash recovery, session resume |
| Multi-agent teams | Built | Claire, Jennifer, Franklin, Einstein, Sep as named personas |
| Bot pool identities | Built | Each agent sends as their own Telegram bot |
| Filesystem IPC | Built | JSON-based inter-process communication |
| Task scheduler | Built | Cron, interval, and one-time scheduled tasks |
| Credential proxy | Built | Containers never see real API keys |
| Session continuity | Built | `.claude/` session state persists across container restarts |
| Group-scoped memory | Built | Per-group CLAUDE.md, memory files, conversation archives |
| SimpleMem integration | Built | Long-term semantic memory across sessions |
| QMD search | Built | Vector search over 800+ vault documents |
| Vault access | Built | Agents read/write to Obsidian vault |
| PageIndex | Built | LLM-powered PDF indexing for large documents |
| Remote control | Built | Spawn Claude Code session, share URL via Telegram |
| MARVIN (deep sessions) | Built | Interactive Claude Code for complex multi-step work |

---

## The Remaining Gap

The gap between current state and the full vision:

**Event-driven perception.** Replace polling with push: Gmail webhooks, IMAP IDLE, calendar push notifications, Slack event subscriptions, filesystem watchers. Each event typed and routed through the bus. *This is plumbing — no research needed.*

**The Ollama tier.** Continuous local inference for classification, extraction, and routing. Structured JSON outputs that feed into agent queues. Confidence-based escalation to Claude. *The models exist. The integration pipeline needs building.*

**The inter-agent message bus.** The filesystem-based pub/sub described above, with topic routing and subscription configs. Agents post findings, requests, and status updates. Other agents subscribe to topics they care about. *Straightforward engineering on top of existing IPC.*

**The trust/autonomy framework.** The learned matrix of (agent, action, context) → autonomy level. Approval tracking, promotion suggestions, context-sensitive boundaries. *The most novel component — requires careful safety engineering and thoughtful defaults.*

**Precomputed context injection.** Scripts that assemble each agent's context packet before the session starts, drawing from vault state, bus outputs, and Ollama's structured extractions. Eliminates cold-start retrieval and reduces token consumption. *Deterministic scripts — the hardest part is deciding what to include.*

**Judgment under ambiguity.** Knowing that a cold email thread means they're busy (wait) vs. losing interest (follow up now) vs. didn't see it (resend). Knowing that a student's quiet week is exam-related (normal) vs. disengagement (intervene). This requires social modeling that current models can approximate but not reliably nail. The trust calibration system handles the consequences of getting it wrong, but the aspiration is genuine situational judgment.

**Coherent identity across time.** A human chief of staff who's been with you for 10 years has a continuous identity — they remember not just facts but the feeling of past interactions, the evolution of relationships, the way priorities shifted over seasons. Current agents have session-bounded identity stitched together with memory systems. The optimal version has something closer to genuine continuity — not consciousness, but a consistent perspective that deepens over months and years rather than resetting every few hours.

None of these are impossible. The foundation is built. The vision is clear. The path is incremental — each phase delivers standalone value while moving toward the complete system.
