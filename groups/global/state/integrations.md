# Integrations Reference

Full integration details for MARVIN. See CLAUDE.md for critical rules.

## Active Integrations

| Integration | Status | Capabilities |
|-------------|--------|--------------|
| **Calendar (iCalBuddy)** | Active | Query MJG, Gandal_Lab_Calendar, and Outlook calendars |
| **Mac Mail** | Active | Search/read from iCloud, Google, Exchange, pennmedicine accounts |
| **Google Workspace** | Active | Gmail (mgandal@gmail.com), Drive, Calendar |
| **Slack** | Active | Lab workspace - channels, messages, search (configured globally) |
| **Apple Notes** | Active | Read and search notes |
| **PubMed** | Active | Search articles, fetch content, citations, research agent |
| **Reflect** | Active | Notes (graph: mjg0818), links, books, daily logs |
| **Parallel Search** | Active | Fast web search (preferred over built-in) |
| **Granola (GranolaMCP)** | Active | Meeting transcripts, summaries, notes |
| **Reference Manager** | Active | Paperpile BibTeX library (5,446 entries), `/reference-manager` skill, 6 citation formats |
| **Gemini** | Disabled | Query, brainstorm, analyze (enable in `.mcp.json`) |
| **NotebookLM** | Disabled | Chat with notebooks (enable in `.mcp.json`) |
| **Perplexity** | Disabled | Web search, deep research, reasoning (enable in `.mcp.json`) |

## Email Search

When searching email archives via AppleScript:
- **Timeout:** Set AppleScript timeout to 120 seconds (not 60) for date/timeline searches
- **Sent mailbox:** Always search Sent in addition to Inbox/Archive — sent emails often contain the best date evidence
- **Parallel search:** Search Inbox, Archive, and Sent mailboxes in parallel to avoid retry loops
- **Exchange accounts:** Use 'Inbox' (capitalized) for mailbox name
- **Script:** `~/.local/bin/search-mail.sh "query"` — parallel search across all accounts, JSON output

## Custom Agents

Specialized subagents in `.claude/agents/`:

| Agent | Purpose | Model |
|-------|---------|-------|
| `kb-search` | Search across the knowledge base | haiku |
| `nih-reporter` | Search/verify NIH grants via RePORTER API | haiku |
| `dossier-agent` | Update promotion dossier documents (FEDS, mentoring, grants) | sonnet |
| `lab-status` | Aggregate lab member status for meetings | haiku |
| `deadline-monitor` | Track deadlines from state, grants, calendar | haiku |
| `followup-tracker` | Track contacts needing follow-up | haiku |
| `note-organizer` | Audit Obsidian vault — broken links, orphan files | sonnet |
| `email-triager` | Categorize/prioritize emails for digest | haiku |

## Promotion Dossier

Files in `$MARVIN_VAULT/30-areas/penn/promotion/` and `~/Dropbox/PENN:CHOP/Psychiatry/COAP/Full_Professor/`. Use `dossier-agent` for updates. Always read-edit-verify; log changes to `~/promotion-dossier/session-log.md`.

## Grant Verification

Use the `nih-reporter` agent for NIH grant lookups. It wraps the NIH RePORTER API:

```bash
curl -X POST 'https://api.reporter.nih.gov/v2/projects/search' \
  -H 'Content-Type: application/json' \
  -d '{"criteria":{"pi_names":[{"last_name":"Gandal"}]}}'
```

Common queries:
- By PI name: `{"criteria":{"pi_names":[{"last_name":"...","first_name":"..."}]}}`
- By project number: `{"criteria":{"project_nums":["R01MH123456"]}}`
- By organization: `{"criteria":{"org_names":["University of Pennsylvania"]}}`

## Integration Notes

- **Email:** Use Mac Mail AppleScript for pennmedicine account; Google Workspace MCP for Gmail
- **Penn SSO/MY.MED:** Cannot be automated via Claude-in-Chrome; ask user to manually authenticate first, then proceed with data extraction
- **Browser automation:** Use `mcp__claude-in-chrome__*` tools (not Playwright MCP, which no longer exists)
- **Calendar:** Always use iCalBuddy (queries all 3 calendars); never use MS365 MCP
- **Research:** PubMed for literature, Perplexity for web research, Gemini for brainstorming
- **Notes:** Apple Notes for reference, Reflect for daily logs and research links
- **Meetings:** Use `granola` CLI for meeting transcripts/summaries. MCP server available after restart.
- **NotebookLM:** Currently disabled in `.mcp.json` (set `"disabled": false` to re-enable)
