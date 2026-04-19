# claude-obsidian — Skill Diff vs NanoClaw's Wiki Stack

**Upstream:** https://github.com/AgriciDaniel/claude-obsidian (1,889 ⭐, 2026-04-18)
**Verdict:** STEAL selectively — **defuddle** is worth adding; rest is superset by our stack.
**Date:** 2026-04-19

claude-obsidian ships 10 skills implementing Karpathy's LLM Wiki pattern over Obsidian.
We already have `add-karpathy-llm-wiki` (installs the pattern) and `wiki-lint` plus hot
cache, vault routing, autoresearch, etc. This doc is a side-by-side diff to decide
what's worth porting.

## Skill-by-skill comparison

| claude-obsidian | NanoClaw equivalent | Gap? |
|---|---|---|
| `autoresearch` | `telegram_science-claw/skills/autoresearch` + `0-autoresearch-skill` | **No** — ours is more sophisticated (two-loop, research-state.yaml, continuity) |
| `wiki-lint` | `.claude/skills/wiki-lint` (structural + semantic) | **No** — ours already has both structural (broken links, orphans) and semantic (contradictions, gaps, stale) passes |
| `wiki-ingest` | vault routing in `groups/global/CLAUDE.md` | Partial — theirs has a `.raw/.manifest.json` delta-tracking pattern we don't use; worth considering (see below) |
| `wiki-query` | QMD search + standard Claude reads | **No** — QMD (BM25 + vector + rerank) strictly dominates their read-hot-cache-then-index-then-pages flow |
| `wiki` (master cmd) | not needed — NanoClaw dispatches naturally | **No** |
| `canvas` | Obsidian canvas in vault | **No** (not a Claude skill concern) |
| `defuddle` | **None** | **YES — worth porting** |
| `obsidian-bases` | None | Skip — Obsidian Bases is a UI-layer feature, not a skill |
| `obsidian-markdown` | Existing markdown conventions | Skip — we already write Obsidian-flavored MD |
| `save` | Hot-cache writeback at session end | **No** — ours is already automated via hot.md convention |

## Worth porting

### 1. `defuddle` — web page cleaner *(high value, 10 min install)*

**Why:** When the vault ingests URLs (articles, blog posts, docs), raw fetched HTML
includes ads/nav/footer clutter. `defuddle` strips it and typically saves 40-60%
tokens. We already fetch URLs via WebFetch / curl during ingestion but don't clean
clutter. This is the one genuine gap.

**How:**

```bash
npm install -g defuddle-cli
defuddle --version
```

Then wire into `scripts/sync/email-ingest.py`'s URL-enrichment path (if any) and into
the vault routing guidance in `groups/global/CLAUDE.md`. Agent guidance: "Before
reading a URL fetched for ingestion, if `defuddle` is installed, pipe through it."

Keep it host-side (not container-side) because container already has WebFetch via SDK.

**Acceptance test:** run on a Pitchfork article or similar heavy-UI page — output
should drop from ~15KB to ~3KB without losing article text.

### 2. Delta-tracking via `.raw/.manifest.json` — *(optional, later)*

Their `wiki-ingest` keeps a manifest: `{path: {hash, ingested_at, pages_created}}`
so re-ingesting unchanged sources is a no-op. Our `scripts/sync/gmail-sync-state.json`
and `email-ingest-state.json` already cover email. For **vault-side re-ingestion** of
PDFs / URLs via the agent (not the sync pipeline), we don't currently track idempotency.

Low priority — the vault is mostly append-only, so re-ingestion is rare. Revisit only
if we find we're re-processing duplicates.

## Not worth porting

### Their `wiki-query` vs our QMD

Their query flow:
1. Read hot.md
2. Read index.md
3. Read 3-5 pages
4. Synthesize + cite

Ours (via QMD):
1. Hybrid BM25 + vec search over the full vault (1946 docs)
2. Optional LLM rerank
3. Read specific paths returned by QMD

QMD is strictly better for recall — their flow assumes index.md is well-maintained,
which requires manual curation. QMD finds content that wasn't indexed. **No port.**

### Their `autoresearch` vs ours

Their autoresearch: 3 rounds, max 15 pages per session, filed to wiki.
Ours: two-loop architecture (inner = experiments with clear optimization targets,
outer = synthesis), maintains `research-state.yaml`, supports continuous operation via
`/loop`.

Ours is a research program manager; theirs is a deep-search workflow. Different beasts.
**No port.**

### Their `wiki-lint`

Our `.claude/skills/wiki-lint` already does:
- Structural: broken links, orphans, index drift, frontmatter gaps
- Semantic: contradictions, gaps, stale claims, concept gaps

Their skill is narrower (structural focus). We're ahead. **No port.**

## Tone observations worth noting

Their skills have good discipline around:
- **Token budget rules** inside every skill (hot.md first, then index, then pages,
  cap at 3-5 pages). We assume the agent does this; worth a 1-liner reminder in
  `groups/global/CLAUDE.md` for new agents.
- **Delta tracking before ingest** — the `.manifest.json` pattern. Cheap insurance.
- **"Batch ingest" explicit mode** — when the user drops N files, defer
  cross-referencing to the end. We don't have this distinction explicit; could help.

These are polish items, not gaps. File under "nice to steal eventually."

## Action

1. **Install `defuddle`** on the mac:
   ```bash
   npm install -g defuddle-cli
   defuddle --version
   ```
   Then update `groups/global/CLAUDE.md`'s URL-ingestion guidance: "If
   `defuddle` is available (`which defuddle 2>/dev/null`), pipe fetched URLs through
   it before saving to the vault."

2. **Skip everything else.** Our stack is a superset, except for that one gap.

## Sources

- claude-obsidian skill READMEs fetched 2026-04-19
- Our existing skills: `.claude/skills/wiki-lint/`, `.claude/skills/add-karpathy-llm-wiki/`,
  `groups/telegram_science-claw/skills/autoresearch/`
- QMD collection stats from `memory/MEMORY.md`
