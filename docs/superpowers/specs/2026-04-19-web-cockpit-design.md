# NanoClaw Web Cockpit — Design Spec

**Date:** 2026-04-19
**Status:** Draft — awaiting review (revised after two audit passes)

## Problem

Mike's NanoClaw system runs across Telegram groups, scheduled tasks, ingestion pipelines, and an Obsidian vault of ~2,500 markdown files. Observability exists in pieces (CLAIRE's daily status message, logs, `current.md`, per-group `memory.md`), but to browse the flow of content passing through the system — papers evaluated, vault entries created, watchlists being built, ingestion pipelines progressing — Mike has to open Telegram, SSH into the Mac, or launch Obsidian. None of this works well on mobile.

The March 23 status-dashboard spec (`docs/superpowers/specs/2026-03-23-status-dashboard-design.md`) solved *alerting* (daily/weekly status messages pushed to CLAIRE). This spec solves *browsing* — a read-only surface that aggregates the content NanoClaw produces into a mobile-first cockpit.

## Builds on

This spec reuses primitives from the March 23 status-dashboard spec:

- `getConsecutiveFailures(taskId, n)` — already defined for the failure alerter
- `task_run_logs.status` (`ok | error | timeout`) — authoritative task pass/fail source
- `dashboard-state.json` snapshot-diff convention — used here for vault delta detection (§1)

Where the existing dashboard queries the DB via an MCP tool (`query_dashboard`), the cockpit builder queries SQLite directly (it runs on the host, not in a container).

## Non-goals

- **No chat UI.** Telegram, Slack, and Emacs already cover conversation.
- **No admin / mutations.** Read-only by construction. No endpoint accepts writes that mutate NanoClaw state. This eliminates most of the threat surface.
- **No live log tailing.** 30-minute snapshot resolution is sufficient; live alerts continue to flow through CLAIRE's Telegram messages.
- **No Tailscale dependency.** Mike wants phone + desktop access without adding Tailscale to the trust chain.

## Preconditions

Fail-fast checks the installer and builder must verify before anything else:

1. **Full Disk Access (FDA) for the builder binary.** The vault lives on `/Volumes/sandisk4TB/` — an external volume. Empirical: `find` from a shell cannot traverse it while `ls -R` can. This is macOS TCC restricting processes spawned without FDA. The launchd-spawned builder will hit the same wall. **Required action:** grant FDA to `/opt/homebrew/bin/bun` (or the compiled binary) via System Settings → Privacy & Security → Full Disk Access. Installer checks by attempting a `readdir` on the configured vault path (see §vault-path) and aborts with a clear remediation message if it returns empty.
2. **`data/cockpit/` directory exists** (builder creates on first run).
3. **Domain for Cloudflare Access (if chosen).** Cloudflare Access Free requires a domain on Cloudflare DNS. If Mike doesn't have one, fall back to a `*.pages.dev` subdomain + Access Email-OTP (supported) — the installer asks.
4. **`COCKPIT_VAULT_PATH`** env var, defaulting to `/Volumes/sandisk4TB/marvin-vault`. Builder exits non-zero with a specific message (*"Vault path not found at {path}; set COCKPIT_VAULT_PATH or attach drive"*) when `readdir` on the path returns `ENOENT`. This handles the "external drive disconnected" case cleanly.

## Solution overview

A **static PWA** that renders a JSON snapshot blob plus a bundle of recently-edited vault pages, pushed from Mike's Mac every 30 minutes by a launchd job.

**Architecture:**

```
┌──────────────────────────────────────────────────────────────────┐
│  Mac (NanoClaw host, launchd job every 30 min)                    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ scripts/cockpit/build-snapshot.ts                          │    │
│  │   reads: SQLite, groups/*, data/agents/*, vault            │    │
│  │   diffs against: /tmp/nanoclaw-last-snapshot.json          │    │
│  │   writes: /tmp/nanoclaw-snapshot.json + delta pages        │    │
│  │   uploads via S3-API to Cloudflare R2 (write-only token)   │    │
│  └──────────────────┬───────────────────────────────────────┘    │
│                     │ PUT snapshot.json, pages/<slug>.md          │
│                     ▼                                              │
├──────────────────────────────────────────────────────────────────┤
│  Cloudflare R2 bucket (static hosting target)                     │
│   snapshot.json, snapshot-YYYYMMDD-HHMM.json (history, 30d TTL)   │
│   pages/<slug>.md                                                  │
├──────────────────────────────────────────────────────────────────┤
│  Cloudflare Pages (static PWA, front by Cloudflare Access)        │
│   index.html + bundled JS/CSS                                     │
│   fetches snapshot.json on load; pages/<slug>.md on demand        │
└──────────────────────────────────────────────────────────────────┘
```

Nothing pulls from the Mac. Mac only pushes outbound. Zero inbound attack surface on the host.

## Components

### 1. `scripts/cockpit/build-snapshot.ts` (new)

Bun script invoked every 30 min by `com.nanoclaw.cockpit.plist`. Produces a single `snapshot.json` (~100–500 KB after capping `recent[]` arrays per §2) plus a bundle of changed vault pages. On first line, ensures `data/cockpit/` exists.

**Reads from:**

- `store/messages.db` — `scheduled_tasks`, `task_run_logs`, `sessions`, `messages`, `chats`, `registered_groups`
  - **Group→message join:** `messages.chat_jid → registered_groups.jid` (verified: no `group_folder` column on `messages`; must join via `registered_groups` keyed by `jid`).
  - **Task pass/fail:** `task_run_logs.status` — actual values are `'success' | 'error' | 'skipped'` (verified against live DB). Not `ok/fail/timeout` — the March 23 spec's prose was imprecise.
  - **Sessions aggregation:** `sessions.group_folder` is a compound key `{group}:{agent}` (e.g. `telegram_claire:jennifer`). Aggregate to get per-group last-active: `SELECT MAX(last_used) FROM sessions WHERE group_folder = '{group}' OR group_folder LIKE '{group}:%'`.
  - **Group display name:** `registered_groups.name` (Telegram group title). Fall back to a prettified `folder` if `name` is null.
  - **Consecutive-failure count:** reuse `getConsecutiveFailures()` from March 23 spec (implemented in `src/db.ts`).
- `groups/*/bookmarks.md`, `groups/*/watchlist.md`, `groups/global/state/watchlist.md`
  - **Scanner rules:** (a) ignore folders ending in `.archived` (e.g. `slack_lab.archived/`); (b) resolve symlinks and skip if target already scanned (e.g. `emacs -> telegram_claire`); (c) skip the accidental nested clone at `telegram_code-claw/nanoclaw/groups/`.
- `data/agents/*/memory.md` — parse a `## Watchlist` section if present (see §6). This is how per-agent watchlist data is surfaced — there is no separate `watchlist.md`.
- `scripts/sync/gmail-sync-state.json` — emails-ingested counter
- `data/cockpit/papers-evaluated.jsonl` — append-only log of paper evaluations. Each line: `{evaluated_at, title, authors, verdict, url?}`. If file missing, `ingestion.papers` surfaces zero counts — not an error.
- `/Volumes/sandisk4TB/marvin-vault/` — recursive read via Bun's `fs.readdir({ recursive: true })`, **not `find`** (FDA pitfall per preconditions). Scoped to the allowlist in §5.
- `groups/global/state/current.md` — top priorities for the header strip
- `data/cockpit/blogs.json` (precondition — see §3) or `null` if file missing
- `/tmp/nanoclaw-last-snapshot.json` — previous snapshot for delta detection

**Does NOT read:**

- `.env`, OneCLI vault, `data/sessions/*/.claude/` (credentials, session state, agent inner memory)
- `data/agents/*/state.md`, `data/agents/*/identity.md`, `data/agents/*/trust.yaml` — agent working memory and policy files, not publishable
- `data/agents/*/memory.md` bodies are **NOT** published — the builder extracts only the `## Watchlist` section (if present) and discards the rest
- Vault bodies outside the explicit allowlist in §5

**Writes:**

- `/tmp/nanoclaw-snapshot.json` + `/tmp/nanoclaw-last-snapshot.json` (copy on success for next-run diff)
- Uploads the blob to R2:
  - `snapshot.json` (latest pointer, overwritten each run)
  - `snapshot-YYYYMMDD-HHMM.json` (history; R2 lifecycle rule expires after 30d)
  - `pages/<slug>.md` for each vault page in the change bundle (see §5)
- On failure: exits non-zero; launchd logs to `logs/cockpit.log`; CLAIRE's real-time failure alerter (March 23 spec) surfaces the error to Telegram.

**Style:** thin data-collector, not a service. No HTTP server, no always-on process. Runs, writes, uploads, exits.

**Dependencies:** `cron-parser` (npm, Bun-compatible) for converting 5-field POSIX crontab to human-readable strings (e.g. `"0 9 * * 1-5"` → `"weekdays at 09:00"`). One row in `scheduled_tasks` has a malformed 7-token `schedule_value` (`"0 0 8,11,14,17,20 * * 1-5"`) — parser must catch exceptions and fall back to rendering the raw string. Data cleanup is flagged as an open question. Also: `markdown-it` + `gray-matter` at build-time (frontmatter extraction for derivation only — bodies are uploaded as raw markdown and rendered client-side); `@aws-sdk/client-s3` for R2 uploads (S3-compatible API).

### 2. Snapshot schema (`snapshot.json`)

```ts
type Snapshot = {
  generated_at: string;          // ISO 8601
  schema_version: number;        // bumped when fields change; UI shows banner if mismatched

  groups: Array<{
    folder: string;              // e.g. "telegram_science-claw"
    display_name: string;        // registered_groups.name ?? prettify(folder)
    last_active_at: string | null; // MAX(sessions.last_used) across all {folder}:* compound keys
    messages_24h: number;        // derived via messages.chat_jid → registered_groups.jid join
  }>;

  tasks: Array<{
    id: string;
    group: string;
    name: string;                // best-effort: first non-blank line of prompt, or agent_name
    schedule_raw: string;        // exact scheduled_tasks.schedule_value (e.g. "0 9 * * 1-5")
    schedule_human: string;      // cron-parser output (e.g. "weekdays at 09:00"); raw string on parse failure
    last_run: string | null;
    last_status: "success" | "error" | "skipped" | null;  // from task_run_logs.status (actual values)
    last_result_excerpt: string | null;              // first 200 chars of scheduled_tasks.last_result (tooltip only)
    next_run: string | null;
    success_7d: [number, number]; // [successful, total] from task_run_logs
    consecutive_failures: number; // from getConsecutiveFailures()
  }>;

  ingestion: {
    emails:  { count_24h: number; last_at: string | null; recent: Array<{ subject: string; from: string; at: string }> };  // recent capped at 20
    papers:  { count_24h: number; last_at: string | null; recent: Array<{ title: string; authors: string; at: string; verdict?: "ADOPT" | "STEAL" | "SKIP"; url?: string }> };  // capped at 20
    vault:   { count_24h: number; last_at: string | null; recent: Array<{ path: string; title: string; at: string; kind: "paper" | "synthesis" | "tool" | "daily" | "wiki" | "inbox" | "other" }> };  // capped at 20
  };

  watchlists: Array<{
    scope: "group" | "agent";
    scope_name: string;          // "telegram_code-claw" or "einstein"
    items: Array<{ title: string; url?: string; note?: string; added_at?: string }>;
  }>;

  // semantics: null = not configured (UI hides surface); [] = configured but no current items (UI shows empty state)
  blogs: Array<{ source: string; title: string; url: string; published_at: string; summary?: string }> | null;

  priorities: string[];          // parsed from current.md "Top 3" section
  vault_tree: VaultNode;         // paths + titles only, no bodies. Scoped to §5 allowlist.
  vault_pages_available: string[]; // slugs present in this snapshot's pages/ bundle (§5)
};

type VaultNode = { name: string; path: string; kind: "dir" | "file"; children?: VaultNode[]; edited_at?: string };
```

**Sizing invariants:** every `recent[]` array is capped at 20 items; `count_*` fields carry the full number for display.

### 3. Blog aggregator (precondition, NOT designed in this spec)

Separate ingestion pipeline that doesn't exist yet. This spec declares the snapshot contract (a `blogs` array populated from `data/cockpit/blogs.json`) and defers the ingester to a separate design round.

**Semantics:** if `data/cockpit/blogs.json` is **absent**, `snapshot.blogs = null` and the UI hides the surface. If the file exists but contains `[]`, `snapshot.blogs = []` and the UI shows an empty state ("Aggregator configured but no recent items").

**Minimum viable ingester (post-spec):** 4h-cron RSS/Atom fetch reading `data/cockpit/feeds.yaml`, dedupes by URL, writes latest 50 to `data/cockpit/blogs.json`. ~50 lines of Bun.

### 4. Static PWA (frontend)

Single-page app. Recommendation: **Preact + vite + markdown-it + highlight.js** — small bundle, no SSR requirement, TypeScript-friendly. Not Next.js. Not Tauri. Not Shiki (Shiki's default theme bundle busts the performance budget below).

"PWA" here means: static site + PWA manifest + service worker + HTTPS (auto via Pages) + Apple touch icons. Served from `/`; no SSR.

**Performance budget:** initial JS bundle ≤ 100 KB gzipped; initial HTML ≤ 20 KB; Lighthouse mobile performance ≥ 90. Enforced by a CI gate on PRs touching the PWA.

**Routes (client-side):**

- `/` — cockpit home (7 surfaces, vertical stack on mobile, grid ≥768px)
- `/vault` — tree browser (uses `snapshot.vault_tree`, filters to paths in `vault_pages_available` for clickability)
- `/vault/:slug` — individual vault page renderer

**Surfaces:**

| # | Surface | Source | Visible when |
|---|---|---|---|
| 1 | Priorities strip (header) | `priorities[]` | always |
| 2 | Groups & sessions | `groups[]` | always |
| 3 | Cron schedules | `tasks[]` — sort priority below | always |
| 4 | Ingestion counters | `ingestion.*` | always |
| 5 | Blog aggregator | `blogs[]` | `blogs !== null` |
| 6 | Watchlists (group × agent filter chips) | `watchlists[]` | always |
| 7 | Vault activity feed + "Browse vault" link | `ingestion.vault.recent` + `/vault` | always |

**Cron surface sort order:** (1) `consecutive_failures > 0` descending, (2) `last_status === "error"` first, (3) `last_status === "skipped"` next, (4) `next_run` ascending (nulls last). Tasks with `consecutive_failures ≥ 2` render with a red border and a "⚠ N failures" chip.

**Staleness:** header compares `Date.now()` to `generated_at`. If >60 min old, yellow banner: *"Snapshot {age} old — cockpit may be behind."* If >180 min old, red banner.

**Schema mismatch:** if `snapshot.schema_version` ≠ the PWA's compiled constant, show a blocking banner: *"Cockpit UI is out of date; please reload."* This catches server-deployed UI vs. in-flight snapshot skew.

**PWA manifest** for "Add to Home Screen" on iOS — opens standalone, fullscreen, icon, theme color.

**Service worker:** caches `snapshot.json` with max-age 5 min + stale-while-revalidate (NOT 1 hour, which would double the effective staleness). Caches vault pages visited this session. No offline writes.

### 5. Vault tree browser & reader

**Allowlist (not denylist).** The builder scans only the paths listed below. Anything else in the vault is absent from `vault_tree` and from the page bundle:

- `99-wiki/` — full subtree, **always included in the page bundle regardless of mtime** (canonical reference layer; sub-1MB total; always-browsable from mobile is worth the bandwidth)
- `80-resources/` — full subtree (general reference)
- `00-inbox/` — included; mtime-filtered to last 7 days for bundling
- `10-daily/` except `10-daily/meetings/` — mtime-filtered to last 7 days
- `70-areas/` — mtime-filtered to last 7 days

**Excluded by allowlist default:** `30-lab/`, `40-projects/`, `50-grants/`, `60-presentations/`, `10-daily/meetings/`, `20-contacts/`, `_media/` (images).

Allowlist lives in `scripts/cockpit/config.ts` and is easy to edit.

**Delta strategy (E1):** on each run, the builder compares the current mtime-scoped file list to `/tmp/nanoclaw-last-snapshot.json`. Only files with `mtime > last_snapshot.generated_at` are uploaded as new `pages/<slug>.md`. Files added to R2 in prior runs remain (R2 is the system of record for the page bundle). A weekly scheduled repack re-uploads the full allowlist to catch edge cases (files with stale mtime but content differences).

**Rendering rules (client-side):**

- Markdown → HTML via `markdown-it`
- Obsidian wikilinks `[[target]]` resolved by matching against `vault_tree` file names. Match → link to `/vault/<slug>`. No match → red strikethrough text.
- Frontmatter rendered as a collapsible header block at top
- Code blocks with syntax highlighting via `highlight.js` (common-languages bundle, ~30 KB; Shiki explicitly rejected per the PWA budget)
- Images: links to `_media/*` render as italicized placeholder "[image: filename]" since `_media/` is excluded from the bundle

**Slug generation:** path-relative-to-vault, URL-encoded. E.g. `99-wiki/tools/polars-bio.md` → `99-wiki%2Ftools%2Fpolars-bio` (percent-encoded slash, extension stripped). URL-encoding avoids slug collisions from filenames containing the separator character (which `/ → __` would have allowed for a hypothetical `foo__bar.md`).

**Page not in bundle:** UI checks `vault_pages_available[]` before offering a click. If the path is present in `vault_tree` but not in `vault_pages_available`, the node is rendered as dimmed text with tooltip *"Full text not in current snapshot (outside recent window)."* No 404 chasing.

### 6. Per-agent watchlists (via `## Watchlist` section in memory.md)

**Revised from audit:** the `write_agent_memory` IPC action hard-codes its write path to `data/agents/{name}/memory.md` (verified in `src/ipc.test.ts:2517`). It does NOT accept a `target_file` parameter. Per-agent watchlists therefore live as a **section inside each agent's existing `memory.md`**, not as a separate file. This is zero code change — agents already call `write_agent_memory` with `section: "Watchlist"` and the section-upsert logic handles updates.

Format inside `memory.md`:

```markdown
## Watchlist

- [Paper: Smith et al 2026 - Isoform dynamics in ASD](https://arxiv.org/abs/...) — added 2026-04-18, followup from SCIENCE-claw
- [Tool: polars-bio](https://github.com/...) — evaluate for single-cell pipelines
- A note without a link — just a reminder to check on X
```

**Parser rules (applied to the `## Watchlist` section only, not the whole file):**

- One item per top-level bullet (`- ` at column 0)
- First `[text](url)` match on a line → `title` + `url`
- If no `[text](url)` on a line → entire line (after `- `) becomes `title`, no `url`
- Everything after the first ` — ` (em-dash surrounded by spaces) → `note`
- Nested bullets, YAML frontmatter, non-bullet lines inside the section: ignored
- If `memory.md` missing OR section absent: agent has zero items in the per-agent filter (not an error)
- All other sections of `memory.md` (Standing Instructions, Session Continuity, etc.) are **not** parsed and never leave the Mac

Agents populate via the existing `write_agent_memory` IPC action: `{type: "write_agent_memory", section: "Watchlist", content: "- …\n- …\n"}`. No new IPC needed.

**Populator rollout (out of scope for this spec, named for planning):** Einstein (literature watchlist), Simon (tools/code), Marvin (admin items). Each agent's identity.md / CLAUDE.md gets a line encouraging `section: "Watchlist"` upserts. Separate change per agent.

### 7. Deployment & snapshot push

**Hosting (recommended):** Cloudflare R2 (object store) + Cloudflare Pages (static hosting) + Cloudflare Access (auth). One account covers all three. Free tier sufficient. R2 has zero egress fees.

**GitHub Pages alternative:** fine if Mike prefers one fewer account. Push becomes `git commit + push` to a private repo; Pages serves from it. Tradeoffs: snapshot history ends up in git (fine for text snapshots, ugly for binary blobs), and Cloudflare Access Email-OTP isn't available — must use GitHub's own auth or a separate layer.

**Push mechanism:** builder uses `@aws-sdk/client-s3` against R2's S3-compatible endpoint. Token scope: `PutObject` only. No `ListBucket`, no `GetObject`, no `DeleteObject`. A leaked token can only overwrite the current `snapshot.json` with garbage — annoying, not catastrophic. Token in `.env` as `COCKPIT_R2_TOKEN` + `COCKPIT_R2_BUCKET` + `COCKPIT_R2_ENDPOINT`.

**Three deployed artifacts, not two:**
1. **R2 bucket** — private (no public URL). Holds `snapshot.json`, `snapshot-*.json` history, `pages/*.md`, `heartbeat.txt`.
2. **Cloudflare Pages site** — static UI bundle. Behind Cloudflare Access.
3. **Cloudflare Worker (`cockpit-worker`)** — ~20 lines of TypeScript. Validates the `CF-Access-Jwt-Assertion` header on each GET, then proxies to R2 via the Worker's R2 binding. This is required because R2's native public-bucket URLs don't natively integrate with Cloudflare Access; the Worker closes the loop.

The Pages site fetches from the Worker's route (e.g. `https://cockpit.{domain}/data/snapshot.json`), not directly from R2.

**Schedule:** `com.nanoclaw.cockpit.plist`, `<key>StartInterval</key><integer>1800</integer>` (matching the `watchdog` plist's `StartInterval` convention; not `StartCalendarInterval` which is for wall-clock times). Runs every 1800 seconds = 30 min. The builder is **NOT** called from `scripts/sync/sync-all.sh` — only via its own plist. This avoids the double-run at 4h boundaries (E3 audit finding).

**Pages deployment:** via `wrangler pages deploy` from the cockpit app directory, invoked manually or via a GitHub Actions workflow. Not in scope for auto-deploy-on-push.

**History retention:** R2 lifecycle rule expires `snapshot-*.json` objects older than 30 days. Latest pointer (`snapshot.json`) never expires. Separate `heartbeat.txt` updated on every successful push — used for stalled-publisher detection (see §Error handling).

## Security

Threat model: **"an attacker finds the PWA URL."** Because the system is static + read-only:

- Mac has **zero inbound exposure.** Worst case is the attacker reads the published snapshot and cached vault pages.
- Snapshot content deliberately excludes secrets, full message bodies, and sensitive vault subfolders. What leaks is: group names, task schedules, ingestion counts, paper titles, watchlist entries, priorities from `current.md`, recent vault file paths + rendered content for allowed folders.
- This is still sensitive — priorities and watchlists contain work context. So the PWA is auth-gated.

**Auth: Cloudflare Access**, configured to allow only `mgandal@gmail.com`. Uses email-OTP (no Cloudflare-managed password), or Google OAuth if Google Workspace is set up. Free tier covers single-user. Cloudflare Access gates both the Pages site and the `cockpit-worker` R2 proxy — neither is reachable without a valid Access JWT.

**Alternative rejected:** HTTP Basic Auth at the edge. Works but one shared password per device, no 2FA, leaked password is permanent.

**Leaked-blob response:** rotate `COCKPIT_R2_TOKEN` via Cloudflare dashboard (builder re-uploads on next cron); revoke and re-issue Cloudflare Access policy; redeploy the Worker if its code or secrets are touched. No data on the Mac is at risk because the Mac has no inbound endpoint.

**R2 token permissions (precise):** `PutObject` on the cockpit bucket. Not `ListBucket`, not `GetObject`, not `DeleteObject`. Even a compromised token cannot enumerate the history objects or delete the latest pointer.

## Error handling

- **Precondition failure** (FDA not granted, vault path unreadable, data dir missing) → exit non-zero with a specific message; installer catches this during first-run setup.
- **Snapshot builder failure** → exit non-zero; launchd logs to `logs/cockpit.log`; CLAIRE's real-time alerter surfaces via Telegram.
- **Upload failure (network or R2 5xx)** → retry once with 30s backoff; if still failing, exit non-zero. Snapshot file remains in `/tmp/nanoclaw-snapshot.json` so next run's delta is still correct.
- **Upload failure (R2 4xx)** → exit non-zero immediately (wrong token, bucket gone, permission denied — retrying won't help).
- **UI: stale snapshot** (`snapshot.generated_at` >60 min) → yellow banner; (>180 min) → red banner. Both include the `generated_at` timestamp.
- **UI: stalled publisher** — UI fetches `heartbeat.txt` on load. If `heartbeat.txt`'s timestamp diverges from `snapshot.json.generated_at` by more than one run cycle, banner: *"Snapshot publisher appears stalled since {time} — last success: {time}."* This catches the case where the builder is crashing *before* the PUT but after SIGKILL'd launchd thinks the run succeeded.
- **UI: schema mismatch** → blocking banner with reload prompt.
- **UI: vault page not in bundle** → dimmed node with tooltip. Never show a broken 404 page.
- **Cron parse failure** (one known row; possibly others) → `schedule_human` falls back to the raw `schedule_value`. Snapshot builder never crashes on parse failure.

## Testing

- **Unit** (builder): fixture `messages.db` + fixture vault dir + fixture `data/agents/` + fixture `data/cockpit/`. Assertions on every field in the schema including null/empty cases. Specifically cover: missing `blogs.json`, missing agent watchlist, missing papers log, task with no run history, group with no messages, vault path with only excluded folders.
- **Unit** (cron parsing): both 5-field and 6-field cron strings from `scheduled_tasks.schedule_value` produce sensible human strings.
- **Unit** (watchlist parser): the four documented cases (title+url+note, title+url, title-only, nested bullets ignored).
- **Integration**: run builder against fixture → upload to a test R2 bucket (or a local MinIO container in CI) → Playwright loads PWA → asserts the 7 surfaces render with expected data.
- **Golden-file**: markdown renderer output for wikilinks (resolved + unresolved), frontmatter, code blocks, images (broken-media placeholder).
- **Manual**: install PWA on iPhone + MacBook, verify offline cache, verify all 7 surfaces, verify auth redirect works, verify schema-mismatch banner fires on deploy skew.

## Out of scope (named, not designed)

- **Blog ingester implementation** — separate spec. This spec declares the snapshot contract only.
- **Cost analytics surface** — deferred pending OneCLI gateway log format + per-agent attribution design.
- **Push notifications** — CLAIRE's Telegram alerts cover urgent events.
- **Search over vault** — QMD handles this on the host; no mobile QMD yet. Future work could surface QMD results via a snapshot field.
- **Agent watchlist populator rollout** — per-agent identity.md edits to encourage watchlist writing. Separate per-agent change.
- **Full vault read-anywhere** — intentional tradeoff per §5. Users who want this should browse Obsidian on the Mac.

## Open questions for review

1. **Hosting final choice** — Cloudflare R2+Pages+Access+Worker vs. GH Pages alternative. Affects installer + auth config. Note the Cloudflare path adds a third artifact (the Worker). If Mike prefers simpler ops, GH Pages trades the Worker for a private-repo Pages deploy, with GitHub auth instead of Cloudflare Access.
2. **Domain availability for Cloudflare Access** — does Mike have a domain he wants to use, or fall back to `*.pages.dev` with Email-OTP?
3. **Vault allowlist refinement** — spec defaults to including `99-wiki/`, `80-resources/`, `00-inbox/`, `10-daily/` (excluding meetings), `70-areas/`. Confirm or list adjustments.
4. **History retention** — 30 days of `snapshot-*.json` stored; is that too much (cost negligible but privacy surface) or too little (looking back 60 days)?
5. **Per-agent state.md surfacing** — `data/agents/{name}/state.md` exists but is not exposed. Expose as a per-agent "current focus" field, or keep excluded?
6. **Malformed scheduled_tasks.schedule_value cleanup** — the row with `"0 0 8,11,14,17,20 * * 1-5"` (7 tokens, invalid) should be fixed to a valid 5-field cron. Separate one-line DB fix; not blocking this spec.

## Success criteria

- Mike can open the PWA on his iPhone at a red light and see: what ran today, what didn't, latest 10 papers evaluated, latest 10 vault edits, any agent's current watchlist. Under 5 seconds of load time over mid-tier LTE (enforced by Lighthouse mobile performance ≥ 90 in CI).
- Zero new inbound network connections to the Mac. Verifiable via `launchctl list | grep com.nanoclaw.cockpit` returning exactly one entry (the builder plist) and nothing in `lsof -iTCP -sTCP:LISTEN -P -n` attributable to the builder.
- Leaking the R2 blob does not leak credentials, full message bodies, agent inner memory, or sensitive vault folders. Leaking `memory.md` contents is explicitly prevented by the section-extractor reading only `## Watchlist`.
- `99-wiki/` is always fully browsable from the PWA regardless of edit recency.
- **Estimated code:** builder 800–1,200 LOC (cron parsing, vault scan, delta logic, R2 upload, retry, memory.md section extractor); PWA 1,500–2,500 LOC (Preact + markdown-it + highlight.js + PWA manifest + service worker + filter chips + tree browser); cockpit-worker ~20 LOC TS. No new always-on services on the Mac.

## Appendix — code reuse from prior specs

| Primitive | Prior spec | Used for |
|---|---|---|
| `getConsecutiveFailures(taskId, n)` in `src/db.ts` | 2026-03-23-status-dashboard | `tasks[].consecutive_failures` |
| `task_run_logs.status` query pattern (values: success/error/skipped) | 2026-03-23-status-dashboard | `tasks[].last_status`, `success_7d` |
| `dashboard-state.json` convention | 2026-03-23-status-dashboard | inspiration for `/tmp/nanoclaw-last-snapshot.json` delta logic |
| `write_agent_memory` IPC (section upsert on `memory.md`) | 2026-04-13-agent-architecture-redesign | populating the `## Watchlist` section in per-agent memory.md |
