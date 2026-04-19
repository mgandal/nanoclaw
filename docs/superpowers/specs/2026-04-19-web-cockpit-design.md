# NanoClaw Web Cockpit — Design Spec

**Date:** 2026-04-19
**Status:** Draft — awaiting review

## Problem

Mike's NanoClaw system runs across Telegram groups, scheduled tasks, ingestion pipelines, and a ~2,500-file Obsidian vault. Observability exists in pieces (CLAIRE's daily status message, logs, `current.md`, per-group `memory.md`), but to browse the flow of content passing through the system — papers evaluated, vault entries created, watchlists being built, ingestion pipelines progressing — Mike has to open Telegram, SSH into the Mac, or launch Obsidian. None of this works well on mobile.

The March 23 status-dashboard spec solved *alerting* (daily/weekly status messages pushed to CLAIRE). This spec solves *browsing* — a read-only surface that aggregates the content NanoClaw produces into a mobile-first cockpit.

## Non-goals

- **No chat UI.** Telegram, Slack, and Emacs already cover conversation. A web chat is not the driver.
- **No admin / mutations.** Read-only by construction. No endpoint accepts writes that mutate NanoClaw state. This eliminates most of the threat surface.
- **No live log tailing.** 30-minute snapshot resolution is sufficient; live alerts continue to flow through CLAIRE's Telegram messages.
- **No Tailscale dependency.** Mike wants phone + desktop access without adding Tailscale to the trust chain.

## Solution overview

A **static PWA** (Cloudflare Pages or GitHub Pages — hosting undecided, doesn't affect design) that renders a single JSON snapshot blob pushed from Mike's Mac every 30 minutes by a scheduled task.

**Architecture:**

```
┌──────────────────────────────────────────────────────────────────┐
│  Mac (NanoClaw host)                                              │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ scripts/cockpit/build-snapshot.ts  (every 30 min)         │    │
│  │   reads: SQLite, groups/*, data/agents/*, vault           │    │
│  │   writes: /tmp/nanoclaw-snapshot.json                     │    │
│  └──────────────────┬───────────────────────────────────────┘    │
│                     │ uploads via API                             │
│                     ▼                                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌──────────────────────────────────────┐                         │
│  │ Cloud blob store (R2 / KV / git repo) │                         │
│  │   snapshot.json                       │                         │
│  │   vault-pages/*.md  (read-on-demand)  │                         │
│  └──────────────────┬───────────────────┘                         │
│                     │                                              │
│                     ▼                                              │
│  ┌──────────────────────────────────────┐                         │
│  │ Static PWA (Cloudflare Pages / GH P.) │                         │
│  │   index.html + bundled JS/CSS         │                         │
│  │   fetches snapshot.json on load       │                         │
│  │   auth-gated (see Security section)   │                         │
│  └──────────────────────────────────────┘                         │
└──────────────────────────────────────────────────────────────────┘
```

Nothing pulls from the Mac. The Mac only pushes outbound. Zero inbound attack surface.

## Components

### 1. `scripts/cockpit/build-snapshot.ts` (new)

A Bun script run every 30 min via a new `launchd` plist (or added as a step in `scripts/sync/sync-all.sh`). Produces a single `snapshot.json` (~100–500 KB) plus optional `vault-pages/<slug>.md` files for the on-demand vault reader.

**Reads from:**

- `store/messages.db` — `scheduled_tasks`, `task_run_logs`, `sessions`, `messages`, `registered_groups`
- `groups/*/bookmarks.md`, `groups/*/watchlist.md`, `groups/global/state/watchlist.md` (skip the accidental `telegram_code-claw/nanoclaw/groups/...` clone)
- `data/agents/*/watchlist.md` (new file convention — see §6)
- `scripts/sync/gmail-sync-state.json` — "last N emails ingested" counter
- `data/cockpit/papers-evaluated.jsonl` — append-only log of paper evaluations. Each line: `{evaluated_at, title, authors, verdict, url?}`. Whichever task evaluates papers is responsible for appending. If the file doesn't exist, `ingestion.papers` surfaces zero — not an error.
- `/Volumes/sandisk4TB/marvin-vault/` — mtime scan of all `.md` under `10-daily/`, `70-areas/`, `99-wiki/`, `00-inbox/` for the activity feed; full tree listing for the browser
- `groups/global/state/current.md` — top priorities for the header strip
- Blog aggregator state file (new, precondition — see §3) or `null` if not yet populated

**Does not read:**

- `.env`, OneCLI vault, `data/sessions/*/.claude/` (credentials, session state, agent inner memory)
- Vault bodies of sensitive folders — `30-lab/`, `50-grants/`, `20-contacts/` are **excluded** from the activity feed and tree browser by default. Configurable via an allowlist/denylist in `scripts/cockpit/config.ts`.

**Writes:**

- `/tmp/nanoclaw-snapshot.json`
- Uploads the blob to the chosen hosting target via its API (or git commit + push for GH Pages)
- For vault pages requested by the UI: a per-page `.md` upload. Strategy (on-demand vs. bulk) decided below.

**Looks like a thin data-collector, not a service.** No HTTP server, no always-on process. Runs, writes, uploads, exits.

### 2. Snapshot schema (`snapshot.json`)

```ts
type Snapshot = {
  generated_at: string;          // ISO 8601
  groups: Array<{
    folder: string;              // e.g. "telegram_science-claw"
    display_name: string;
    active_sessions: number;
    messages_24h: number;
  }>;
  tasks: Array<{
    id: string;
    group: string;
    name: string;                // derived from prompt first line or agent_name
    schedule: string;            // human-readable: "every 4h", "weekdays 7am"
    last_run: string | null;
    last_result: "pass" | "fail" | null;
    next_run: string | null;
    success_7d: [number, number]; // [passed, total]
  }>;
  ingestion: {
    emails: { count_24h: number; last_ingested_at: string | null; recent: Array<{ subject: string; from: string; ingested_at: string }> };
    papers: { count_24h: number; last_evaluated_at: string | null; recent: Array<{ title: string; authors: string; evaluated_at: string; verdict?: "ADOPT" | "STEAL" | "SKIP" }> };
    vault: { count_24h: number; last_edited_at: string | null; recent: Array<{ path: string; title: string; edited_at: string; kind: "paper" | "synthesis" | "tool" | "daily" | "other" }> };
  };
  watchlists: Array<{
    scope: "group" | "agent";
    scope_name: string;          // "telegram_code-claw" or "einstein"
    items: Array<{ title: string; url?: string; note?: string; added_at?: string }>;
  }>;
  blogs: Array<{                  // may be empty if aggregator not yet populated
    source: string;               // e.g. "Anthropic", "Pasaniuc lab"
    title: string;
    url: string;
    published_at: string;
    summary?: string;
  }> | null;
  priorities: string[];           // parsed from current.md "Top 3"
  vault_tree: VaultNode;          // tree of paths for the browser (titles + paths, no bodies)
};

type VaultNode = { name: string; path: string; kind: "dir" | "file"; children?: VaultNode[]; edited_at?: string };
```

Everything in the snapshot is derived data, not raw. No vault bodies, no full message contents, no secrets. The tree carries paths and titles; bodies are fetched on click from `vault-pages/<slug>.md`.

### 3. Blog aggregator (precondition, NOT designed in this spec)

The "blog aggregator" surface requires a new ingestion pipeline that doesn't exist. This spec declares the snapshot contract (a `blogs` array populated from a file like `data/cockpit/blogs.json`) and defers building the ingester to a separate design round. If the file doesn't exist, the `blogs` field is `null` and the UI hides the surface.

**Minimum viable blog ingester (post-spec):** an RSS/Atom fetch script on a 4h cron that reads `data/cockpit/feeds.yaml`, fetches each feed, dedupes by URL, and writes the latest N items to `data/cockpit/blogs.json`. ~50 lines of Bun.

### 4. Static PWA (frontend)

Single-page app, no framework bigger than necessary. Recommendation: **vanilla TS + a small component library or Svelte/Preact** — *not Next.js*, because there's no SSR requirement and the bundle is tiny. Bundled with Bun or esbuild.

**Routes (client-side):**

- `/` — cockpit home (7 surfaces laid out as a vertical stack on mobile, grid on desktop)
- `/vault` — tree browser
- `/vault/*` — individual vault page renderer (markdown-it or similar, with Obsidian `[[wikilink]]` support)

**Surfaces rendered from `snapshot.json`:**

| # | Surface | Source |
|---|---|---|
| 1 | Priorities strip (header) | `priorities[]` |
| 2 | Groups & sessions | `groups[]` |
| 3 | Cron schedules | `tasks[]` |
| 4 | Ingestion counters (emails/papers/vault) | `ingestion.*` |
| 5 | Blog aggregator | `blogs[]` (hidden if null) |
| 6 | Watchlists (group × agent filter chips) | `watchlists[]` |
| 7 | Vault activity feed + "Browse vault" link | `ingestion.vault.recent` + `/vault` |

**PWA manifest** for "Add to Home Screen" on iOS — opens standalone, fullscreen, icon, theme color.

**Offline behavior:** service worker caches `snapshot.json` (stale-while-revalidate, max-age 1 hr) and vault pages visited this session. No offline writes because there are no writes.

### 5. Vault tree browser & reader

Two modes, same data:

- **Activity feed** (on `/`): flat chronological list of last 20 vault edits with title, path breadcrumb, mtime, kind tag.
- **Tree browser** (on `/vault`): collapsible tree rendered from `snapshot.vault_tree`. Click a file → fetch `vault-pages/<slug>.md` → render.

**Rendering rules:**

- Markdown → HTML via markdown-it
- Obsidian wikilinks `[[target]]` resolved by matching the vault tree by filename; unresolved links render as red text
- Frontmatter shown as a collapsible header block at the top
- Code blocks with syntax highlighting
- Images: linked `_media/*` resources, lazy-loaded

**Bulk vs. on-demand page upload:** bulk upload of all ~2,500 files every 30 min is wasteful. On-demand (UI requests a page → static host returns 404 → UI posts a request back to the Mac → Mac uploads the specific page) requires an inbound endpoint, which violates the "no inbound" rule. **Decision: bulk-upload only the files with mtime in the last 7 days (~100–200 files).** Older files return 404 in the UI, which renders a "not in recent snapshot" message with the path. Lives with the trade-off because the activity feed covers the recency case, and you can browse the tree and see all paths regardless.

**Alternative considered**: commit the entire vault to a private git repo and serve via GH Pages. Rejected because (a) the vault has sensitive subfolders (grants, contacts) that need filtering and (b) 2,500-file commits every 30 min pollute git history.

### 6. Per-agent watchlists (new file convention)

Introduces `data/agents/{name}/watchlist.md` as a new file the snapshot reader looks for. Format:

```markdown
# {Agent} watchlist

- [Paper: Smith et al 2026 - Isoform dynamics in ASD](https://arxiv.org/abs/...) — added 2026-04-18, followup from SCIENCE-claw
- [Tool: polars-bio](https://github.com/...) — evaluate for single-cell pipelines
```

Simple flat list — one item per top-level bullet. Parser rules: the first `[text](url)` match on a line becomes `title` + `url`. Everything after the first ` — ` (em-dash with surrounding spaces) becomes `note`. Missing URL → item has a title but no URL field. Missing note → item with no note. Nested bullets, YAML frontmatter, and non-bullet lines are ignored. Agents populate via their existing `write_agent_memory` IPC action (`target_file: "watchlist.md"`).

If `data/agents/{name}/watchlist.md` doesn't exist for a given agent, that agent has zero items in the per-agent filter — no error.

### 7. Deployment & snapshot push

**Hosting:** Cloudflare Pages + Cloudflare R2 for the blob (recommended). Rationale: free tier covers this easily, R2 has no egress fees, Pages gives you custom domain + TLS + CDN, one account. GH Pages is a fine alternative if already-logged-into-GitHub beats a new Cloudflare account.

**Push mechanism:** the snapshot script calls R2's S3-compatible API with a scoped token stored in `.env` as `COCKPIT_R2_TOKEN`. Token has write-only access to a single bucket; no read, no bucket list.

**Schedule:** new `launchd` plist `com.nanoclaw.cockpit.plist` every 30 min. Add a step to `scripts/sync/sync-all.sh` calls the same script opportunistically so the snapshot is also fresh right after each 4-hourly sync.

## Security

The threat model is **"an attacker finds the PWA URL"**. Because it's static + read-only:

- The Mac has **zero inbound exposure**. Worst case is the attacker reads your `snapshot.json` and cached vault pages.
- Snapshot contents deliberately exclude secrets, full message bodies, and sensitive vault subfolders. What leaks is: group names, task schedules, ingestion counts, paper titles, watchlist entries, priorities from `current.md`, recent vault file paths + rendered content for non-sensitive folders.
- This is **not nothing** — priorities and watchlists contain work context you'd prefer not to publish. So the PWA must be auth-gated.

**Auth: Cloudflare Access** (email-OTP or Google OAuth), configured to allow only `mgandal@gmail.com`. Free tier covers single-user. No passwords, no session management code, no CSRF. Cloudflare handles the auth wall in front of the static site.

**Alternative rejected:** HTTP Basic Auth configured at the edge. Works but shares credentials across all devices, no 2FA, and a leaked password is permanent. Cloudflare Access is barely more effort.

**What to do if the blob leaks:** rotate the R2 token (Mac re-uploads on next cron), configure R2 bucket URL to require a signed URL, and/or change the Cloudflare Access policy. No data on the Mac is at risk.

## Error handling

- Snapshot-builder failure → exit 1, launchd logs to `logs/cockpit.log`, CLAIRE's real-time failure alerter (already wired per the March 23 spec) surfaces it to Telegram
- Upload failure → retry once with backoff; if still failing, write to `logs/cockpit.log` and exit 1
- UI gets a stale snapshot (>2 hr old) → render a banner: "Snapshot {age} old — cockpit may be behind"
- UI fetches a vault page that's not in the recent upload → render "This page isn't in the current snapshot. It exists at `{path}`." with a note about the 7-day recency window

## Testing

- Unit test the snapshot builder against a fixture DB + fixture vault dir. Every field in the schema has an assertion.
- Integration test: run builder → upload to a test R2 bucket → load in a headless browser → assert the 7 surfaces render.
- Golden-file test on the markdown renderer for wikilinks, frontmatter, and code blocks.
- Manual: install the PWA on iPhone + MacBook, verify offline cache works, verify all 7 surfaces.

## Out of scope (named, not designed)

- **Blog ingester implementation** — separate design. This spec declares the snapshot field; the ingester comes later.
- **Cost analytics (surface 7)** — deferred. OneCLI gateway log format + per-agent attribution is its own design.
- **Push notifications** — CLAIRE's Telegram alerts already cover urgent events. Adding web push is future work.
- **Search over vault** — QMD handles this on the host; no mobile QMD yet.

## Open questions for review

1. **Hosting choice** — Cloudflare Pages + R2 vs. GH Pages. Impacts only the upload script and the auth config; no architectural changes either way.
2. **Per-agent watchlist populators** — this spec defines the file convention; which agents (Einstein, Simon, Marvin) actually start writing to them is a separate change to each agent's CLAUDE.md / identity.md.
3. **Vault folder allowlist** — spec currently excludes `30-lab/`, `50-grants/`, `20-contacts/` from the activity feed + tree. Confirm this is the right default, or list adjustments.

## Success criteria

- Mike can open the PWA on his iPhone at a red light and see: what ran today, what didn't, latest 10 papers evaluated, latest 10 vault edits, any agent's current watchlist. In under 5 seconds of load time.
- Zero inbound network connections to the Mac.
- Leaking the R2 blob does not leak credentials, full message bodies, or sensitive vault folders.
- Total Mac-side code added: one snapshot builder script (~400 LOC), one launchd plist, and additions to `scripts/sync/sync-all.sh`. No new services, no new long-running processes.
