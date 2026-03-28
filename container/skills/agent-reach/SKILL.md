---
name: agent-reach
description: >
  Give your AI agent eyes to see the entire internet.
  Search and read 15+ platforms: Twitter/X, Reddit, YouTube, GitHub, Bilibili,
  XiaoHongShu, Douyin, Weibo, WeChat Articles, Xiaoyuzhou Podcast, LinkedIn,
  V2EX, Xueqiu, RSS, Exa web search, and any web page.
  Zero config for 8 channels. Use when user asks to search, read, or interact
  on any supported platform, shares a URL, or asks to search the web.
  Triggers: search twitter, youtube transcript, search reddit, read this link,
  bilibili, web search, research, GitHub search.
allowed-tools: Bash(curl:*), Bash(yt-dlp:*), Bash(gh:*), Bash(mcporter:*), Bash(python3:*), Bash(agent-reach:*)
---

# Agent Reach — Internet Access for Agents

Run `agent-reach doctor` to check which channels are available.

## ⚠️ Workspace Rules

**Never create files in the agent workspace.** Use `/tmp/` for output and `~/.agent-reach/` for persistent data.

## Web — Any URL

```bash
curl -s "https://r.jina.ai/URL"
```

## Web Search (Exa — free, no key needed)

```bash
mcporter call 'exa.web_search_exa(query: "query", numResults: 5)'
mcporter call 'exa.get_code_context_exa(query: "code question", tokensNum: 3000)'
```

## Twitter/X (bird)

```bash
bird search "query" -n 10
bird read URL_OR_ID
bird user-tweets @username -n 20
bird thread URL_OR_ID
```

## YouTube (yt-dlp)

```bash
yt-dlp --dump-json "URL"                          # metadata
yt-dlp --write-sub --write-auto-sub --sub-lang "en" --skip-download -o "/tmp/%(id)s" "URL"
yt-dlp --dump-json "ytsearch5:query"              # search
```

## Reddit

```bash
curl -s "https://www.reddit.com/r/SUBREDDIT/hot.json?limit=10" -H "User-Agent: agent-reach/1.0"
curl -s "https://www.reddit.com/search.json?q=QUERY&limit=10" -H "User-Agent: agent-reach/1.0"
```

## GitHub (gh CLI)

```bash
gh search repos "query" --sort stars --limit 10
gh repo view owner/repo
gh search code "query" --language python
gh issue list -R owner/repo --state open
```

## Bilibili (yt-dlp)

```bash
yt-dlp --dump-json "https://www.bilibili.com/video/BVxxx"
yt-dlp --write-sub --write-auto-sub --sub-lang "zh-Hans,zh,en" --convert-subs vtt --skip-download -o "/tmp/%(id)s" "URL"
```

## XiaoHongShu (mcporter — requires cookies)

```bash
mcporter call 'xiaohongshu.search_feeds(keyword: "query")'
mcporter call 'xiaohongshu.get_feed_detail(feed_id: "xxx", xsec_token: "yyy")'
```

## Douyin (mcporter — no login needed)

```bash
mcporter call 'douyin.parse_douyin_video_info(share_link: "https://v.douyin.com/xxx/")'
mcporter call 'douyin.get_douyin_download_link(share_link: "https://v.douyin.com/xxx/")'
```

## Weibo (mcporter — no login needed)

```bash
mcporter call 'weibo.get_trendings(limit: 20)'
mcporter call 'weibo.search_content(keyword: "query", limit: 20)'
mcporter call 'weibo.get_feeds(uid: "UID", limit: 20)'
```

## V2EX (public API)

```bash
curl -s "https://www.v2ex.com/api/topics/hot.json" -H "User-Agent: agent-reach/1.0"
curl -s "https://www.v2ex.com/api/topics/show.json?node_name=python&page=1" -H "User-Agent: agent-reach/1.0"
```

## Xueqiu / Stock Quotes (public API)

```python
python3 -c "
from agent_reach.channels.xueqiu import XueqiuChannel
ch = XueqiuChannel()
q = ch.get_stock_quote('AAPL')
print(q['name'], q['current'], q['percent'])
"
```

## RSS (feedparser)

```python
python3 -c "
import feedparser
for e in feedparser.parse('FEED_URL').entries[:5]:
    print(f'{e.title} — {e.link}')
"
```

## LinkedIn (mcporter — requires cookies)

```bash
mcporter call 'linkedin.get_person_profile(linkedin_url: "https://linkedin.com/in/username")'
```

## Troubleshooting

- Run `agent-reach doctor` — shows status and fix instructions for each channel
- Twitter fetch failed? Ensure `undici` installed: `npm install -g undici`
- Channel needing cookies: ask user for Cookie-Editor export

*Added to KB: 2026-03-28 by Claire*
