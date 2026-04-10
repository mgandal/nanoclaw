---
name: follow-builders
description: Generate AI industry digest by tracking top builders on X/Twitter and podcast feeds. Use for the daily AI morning brief.
allowed-tools: Bash(node:*), WebSearch, WebFetch, Read
---

# Follow Builders -- AI Industry Digest

## How It Works

1. Run `prepare-digest.js` to fetch and preprocess builder activity
2. The script outputs a JSON digest to stdout
3. You remix the JSON into a curated 3-5 item summary for Mike

## Running the Digest

```bash
cd /home/node/.claude/skills/follow-builders
node prepare-digest.js
```

The script:
- Fetches latest tweets from tracked AI builders (feed-x.json)
- Fetches latest podcast episodes (feed-podcasts.json)
- Downloads prompt templates from the follow-builders repo
- Outputs structured JSON ready for remix

## Remixing

After running the script, take the JSON output and create a digest:
- Pick the 3-5 most relevant items for Mike (psychiatric genomics PI who builds with AI)
- Focus: Claude/Anthropic, OpenAI, open-source LLMs, AI for science, bioinformatics tools
- One-sentence summary per item with source link
- Skip generic tech news -- only items relevant to research or AI tooling

## Environment

- `SUPADATA_API_KEY` -- required for fetching podcast transcripts (set in container env)
- Node.js available in container (v22)

## Fallback

If prepare-digest.js fails or produces no output, fall back to web search:
- Search for top 3-5 AI news items from the last 24 hours
- Same focus areas as above
- Include source links

## Output Format

```
AI Builders Digest -- [DATE]

1. **[Title]** -- [1-sentence summary] [Link]
2. **[Title]** -- [1-sentence summary] [Link]
3. **[Title]** -- [1-sentence summary] [Link]
```
