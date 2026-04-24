# Cockpit PWA Implementation Plan (Plan C)

> **Status: SHIPPED.** All scaffolding, libs, components, and tests are in place; `bun run test` reports 71/71 passing across 17 files. Files match this plan's File Structure section (only delta: entrypoint is `src/main.tsx` rather than `src/main.ts` — correct given JSX usage). Open `- [ ]` boxes below were never updated retroactively. Remaining work is deployment (Cloudflare Pages + Access policy) which is tracked under Plan B's deploy task.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the static PWA that renders the JSON snapshot from Plan A (via the Worker from Plan B) into seven mobile-friendly surfaces plus a vault tree browser and page reader. Enforce the performance budget locally via `vite build` bundle size check.

**Architecture:** `cockpit-pwa/` is a self-contained Preact + vite TypeScript app. Pure-logic modules (`lib/*`) are covered by unit tests. Components (`components/*`) get minimal render tests via `@testing-library/preact` + `happy-dom`. Service worker + manifest are static assets with documented manual install verification. The build output is served by Cloudflare Pages behind the same Cloudflare Access application from Plan B, so the PWA fetches from the Worker (`/data/*`) on the same origin — no CORS.

**Tech stack (fixed by spec §4):** Preact, vite, typescript, markdown-it, highlight.js, `@testing-library/preact`, `happy-dom`, vitest.

**Related:** Implements §4 (static PWA), §5 (vault tree + reader), §Error handling (staleness banners, schema mismatch, missing pages) of `docs/superpowers/specs/2026-04-19-web-cockpit-design.md`. Depends on Plan A (snapshot shape) and Plan B (Worker routes). Follows the same isolated-subpackage pattern Plan B established.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `cockpit-pwa/package.json` | Deps: preact, vite, markdown-it, highlight.js + dev deps. |
| `cockpit-pwa/tsconfig.json` | TS config (ES2022, JSX preact). |
| `cockpit-pwa/vite.config.ts` | Vite + PWA plugin config. |
| `cockpit-pwa/vitest.config.ts` | Vitest config with happy-dom environment. |
| `cockpit-pwa/index.html` | HTML shell + manifest link + service worker registration. |
| `cockpit-pwa/public/manifest.webmanifest` | PWA manifest (name, icons, theme color). |
| `cockpit-pwa/public/icon-192.png` | Icon placeholder (documented; real icon generated manually). |
| `cockpit-pwa/public/icon-512.png` | Icon placeholder. |
| `cockpit-pwa/public/sw.js` | Service worker: snapshot.json stale-while-revalidate, pages session cache. |
| `cockpit-pwa/src/types.ts` | Re-export/mirror the `Snapshot` type from Plan A. |
| `cockpit-pwa/src/lib/staleness.ts` + test | Compute banner state from `generated_at`. |
| `cockpit-pwa/src/lib/schema-guard.ts` + test | Detect schema_version mismatch. |
| `cockpit-pwa/src/lib/slug.ts` + test | Path→slug encoding/decoding; `vault_pages_available` lookup. |
| `cockpit-pwa/src/lib/cron-sort.ts` + test | Sort `tasks[]` per spec §4. |
| `cockpit-pwa/src/lib/wikilink.ts` + test | Resolve `[[target]]` against `vault_tree`. |
| `cockpit-pwa/src/lib/snapshot-fetch.ts` + test | Fetch + validate snapshot.json. |
| `cockpit-pwa/src/lib/render-markdown.ts` + test | markdown-it config + wikilink hook. |
| `cockpit-pwa/src/components/StalenessBanner.tsx` + test | Yellow/red/schema-mismatch banner. |
| `cockpit-pwa/src/components/PrioritiesStrip.tsx` + test | Surface 1. |
| `cockpit-pwa/src/components/GroupsPanel.tsx` + test | Surface 2. |
| `cockpit-pwa/src/components/TasksPanel.tsx` + test | Surface 3, uses cron-sort. |
| `cockpit-pwa/src/components/IngestionPanel.tsx` + test | Surface 4. |
| `cockpit-pwa/src/components/BlogsPanel.tsx` + test | Surface 5, hidden when null. |
| `cockpit-pwa/src/components/WatchlistsPanel.tsx` + test | Surface 6, filter chips. |
| `cockpit-pwa/src/components/VaultFeed.tsx` + test | Surface 7. |
| `cockpit-pwa/src/components/VaultTree.tsx` + test | `/vault` browser. |
| `cockpit-pwa/src/components/VaultPage.tsx` + test | `/vault/:slug` reader. |
| `cockpit-pwa/src/App.tsx` | Top-level router + snapshot load + banner composition. |
| `cockpit-pwa/src/main.ts` | Entry: `render(<App/>, document.body)`. |
| `cockpit-pwa/src/styles.css` | Minimal mobile-first CSS. |
| `cockpit-pwa/scripts/check-bundle-size.mjs` | Reads `dist/` after `vite build`, fails if gzipped JS > 100KB. |
| `cockpit-pwa/README.md` | Deploy guide (Pages) + local dev + budget enforcement. |
| `cockpit-pwa/.gitignore` | `dist/`, `node_modules/`, `.vite/`. |

### Modified files

None. Isolated subpackage like `cockpit-worker/`.

---

## Task 0: Prep — directory, deps, tsconfig, vitest env

- [ ] **Step 1:** `mkdir -p cockpit-pwa/{src/{lib,components},public,scripts}`
- [ ] **Step 2:** Write `package.json` with runtime deps (preact, markdown-it, highlight.js) + dev deps (vite, typescript, vitest, @testing-library/preact, happy-dom, @preact/preset-vite).
- [ ] **Step 3:** Write `tsconfig.json` (jsx: preact, strict, ES2022).
- [ ] **Step 4:** Write `vite.config.ts` (preact preset, outDir dist).
- [ ] **Step 5:** Write `vitest.config.ts` (happy-dom environment, include `src/**/*.test.ts?(x)`).
- [ ] **Step 6:** Write `.gitignore` (dist, node_modules, .vite).
- [ ] **Step 7:** `cd cockpit-pwa && bun install`.
- [ ] **Step 8:** Smoke-check: add a throwaway `src/smoke.test.ts`, run `bun run test`, confirm vitest discovers and passes, delete.
- [ ] **Step 9:** Commit `feat(pwa): scaffold cockpit-pwa with preact + vite + vitest`.

---

## Task 1: Types (mirror Plan A Snapshot shape)

**Files:** `src/types.ts`

Mirror the Snapshot type exactly from `scripts/cockpit/types.ts`. Keep the `SCHEMA_VERSION` constant matching Plan A.

- [ ] **Step 1:** Copy type definitions from `scripts/cockpit/types.ts` into `cockpit-pwa/src/types.ts`.
- [ ] **Step 2:** Typecheck.
- [ ] **Step 3:** Commit `feat(pwa): snapshot type mirror from Plan A`.

---

## Task 2: `lib/staleness.ts` — banner state

**Files:** `src/lib/staleness.ts` + test

- [ ] **Step 1:** Write failing test. Inputs: `(generated_at, now)`. Output: `{ level: "fresh" | "stale-warn" | "stale-crit", ageMin: number }`. Warn at >60 min, crit at >180 min.
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** GREEN.
- [ ] **Step 5:** Commit.

---

## Task 3: `lib/schema-guard.ts`

**Files:** `src/lib/schema-guard.ts` + test

- [ ] **Step 1:** Write test: `checkSchema(snapshot, expected)` returns `{ match: true }` or `{ match: false, got, expected }`.
- [ ] **Step 2–4:** RED → impl → GREEN.
- [ ] **Step 5:** Commit.

---

## Task 4: `lib/slug.ts`

**Files:** `src/lib/slug.ts` + test

Path → URL slug (URL-encoded, .md stripped) and the inverse. Plus `isAvailable(path, vault_pages_available)` for the dimmed-node check.

- [ ] **Step 1–5:** TDD cycle. Cover: roundtrip `99-wiki/tools/polars-bio.md` ↔ `99-wiki%2Ftools%2Fpolars-bio`, `isAvailable` returns true when slug is in array, false otherwise.
- [ ] **Step 5:** Commit.

---

## Task 5: `lib/cron-sort.ts`

**Files:** `src/lib/cron-sort.ts` + test

Implement the spec §4 sort order:

1. `consecutive_failures > 0` descending
2. `last_status === "error"` first
3. `last_status === "skipped"` next
4. `next_run` ascending (nulls last)

- [ ] **Step 1:** Test with an explicit 4-task fixture that forces each rule boundary.
- [ ] **Step 2–4:** RED → impl → GREEN.
- [ ] **Step 5:** Commit.

---

## Task 6: `lib/wikilink.ts`

**Files:** `src/lib/wikilink.ts` + test

Given `vault_tree: VaultNode` and a wikilink target string like `polars-bio`, return the matching slug or `null`. Match rule: basename (without `.md`) equality, prefer the first match (vault is expected to have unique basenames inside `99-wiki/`).

- [ ] **Step 1:** Test resolving against a small fixture tree.
- [ ] **Step 2–4:** RED → impl → GREEN.
- [ ] **Step 5:** Commit.

---

## Task 7: `lib/snapshot-fetch.ts`

**Files:** `src/lib/snapshot-fetch.ts` + test

`fetchSnapshot(origin: string): Promise<Snapshot>`. Fetches `${origin}/data/snapshot.json`, checks shape. Throws descriptive errors on non-200, non-JSON, missing top-level fields. Tests stub `globalThis.fetch` with vi.fn.

- [ ] **Step 1:** Tests: 200 with valid JSON → returns snapshot; 200 with non-JSON → throws; 404 → throws "snapshot not found"; 200 with wrong shape → throws "malformed snapshot".
- [ ] **Step 2–4:** RED → impl → GREEN.
- [ ] **Step 5:** Commit.

---

## Task 8: `lib/render-markdown.ts`

**Files:** `src/lib/render-markdown.ts` + test

Wrap markdown-it. Wikilink plugin hook calls `resolveWikilink` from `lib/wikilink.ts`: match → `<a href="/vault/{slug}">{target}</a>`, no match → `<span class="broken-link">{target}</span>`. Frontmatter (YAML `---…---`) rendered as collapsed `<details>`. Code blocks: let markdown-it's default with highlight.js's `highlight` function handle them (common-languages bundle).

- [ ] **Step 1:** Tests: plain md → HTML; `[[polars-bio]]` with fixture tree → `<a href="/vault/99-wiki%2Ftools%2Fpolars-bio">polars-bio</a>`; `[[missing]]` → broken-link span; frontmatter → `<details>` block; code fence → `<pre><code class="hljs ...">`.
- [ ] **Step 2–4:** RED → impl → GREEN.
- [ ] **Step 5:** Commit.

---

## Task 9: `components/StalenessBanner.tsx` + render test

Thin component reading `useStaleness(snapshot)` (derived from `lib/staleness.ts`) and rendering nothing / yellow / red banner, or a blocking banner on schema mismatch.

- [ ] **Step 1:** Render test: three states render the right class names + text substrings.
- [ ] **Step 2–4:** RED → impl → GREEN.
- [ ] **Step 5:** Commit.

---

## Task 10: Surface components (parallel batch)

Seven components implementing the seven surfaces. Each one gets a minimal render test that asserts the component renders the right data from a fixture snapshot and hides itself correctly when its data is empty/null. Order:

1. `PrioritiesStrip` (surface 1) — renders `priorities[]` or hides if empty.
2. `GroupsPanel` (surface 2) — renders `groups[]` rows with last-active + messages-24h.
3. `TasksPanel` (surface 3) — sorts via `cron-sort`, renders a row with red border + "⚠ N failures" chip when `consecutive_failures ≥ 2`.
4. `IngestionPanel` (surface 4) — three counters: emails, papers, vault.
5. `BlogsPanel` (surface 5) — renders list or hides entirely when `snapshot.blogs === null`.
6. `WatchlistsPanel` (surface 6) — filter chips (All + one per scope_name), click a chip → filter items.
7. `VaultFeed` (surface 7) — renders `ingestion.vault.recent` + "Browse vault" link.

One commit per component (tests first, then impl, then commit).

---

## Task 11: Vault routes — `VaultTree.tsx` + `VaultPage.tsx`

- [ ] **Step 1:** `VaultTree` render test: recursive rendering of `vault_tree`, file nodes linkable only if their path is in `vault_pages_available` (else dimmed with tooltip).
- [ ] **Step 2:** `VaultPage` fetch test: stub fetch for `/data/pages/<slug>.md`, assert markdown rendered + wikilinks resolved via passed-in `vault_tree`.
- [ ] **Step 3–5:** Impl + commit each.

---

## Task 12: App shell + routing + `main.ts`

**Files:** `src/App.tsx`, `src/main.ts`, `src/styles.css`, `index.html`

- [ ] **Step 1:** `App.tsx` — hook that fetches snapshot once on mount, holds it in state, passes down. Simple hash-router for `/`, `/vault`, `/vault/:slug`. Renders StalenessBanner always.
- [ ] **Step 2:** `main.ts` — `render(<App/>, document.body)`.
- [ ] **Step 3:** `styles.css` — mobile-first, grid ≥768px per spec §4.
- [ ] **Step 4:** `index.html` — minimal shell, manifest link, sw registration.
- [ ] **Step 5:** `vite build` — confirm bundle builds.
- [ ] **Step 6:** Commit.

---

## Task 13: Manifest + service worker

**Files:** `public/manifest.webmanifest`, `public/sw.js`, icon placeholders

Service worker caches: (a) `/data/snapshot.json` with 5-min stale-while-revalidate, (b) `/data/pages/*.md` session cache (no TTL — pages are immutable once written by the builder), (c) app shell (JS/CSS/HTML).

- [ ] **Step 1:** Write `manifest.webmanifest` with name, short_name, icons, theme_color, display=standalone.
- [ ] **Step 2:** Write `sw.js` with fetch-event handlers implementing the three caching strategies.
- [ ] **Step 3:** Icon placeholders: 1×1 PNG stubs documented in README as needing real icons before deploy.
- [ ] **Step 4:** Commit.

---

## Task 14: Bundle-size budget enforcement

**Files:** `scripts/check-bundle-size.mjs`

Fails CI if gzipped JS chunk > 100 KB (spec §4). Runs after `vite build`.

- [ ] **Step 1:** Write script: glob `dist/assets/*.js`, gzip-compute-size, compare to budget.
- [ ] **Step 2:** Wire `build:check` npm script that runs `vite build && node scripts/check-bundle-size.mjs`.
- [ ] **Step 3:** Run locally — confirm current bundle under budget. Document actual size in commit message.
- [ ] **Step 4:** Commit.

---

## Task 15: Deploy README + final verify

- [ ] **Step 1:** Write `README.md`: local dev (`bun run dev`), tests, build, bundle-check, Pages deploy via `wrangler pages deploy dist`, first-install icon-generation note, service-worker cache-bust procedure.
- [ ] **Step 2:** Run `bun run test` — all green.
- [ ] **Step 3:** Run `bun run typecheck` — clean.
- [ ] **Step 4:** Run `bun run build:check` — bundle under budget.
- [ ] **Step 5:** Commit.

---

## Spec coverage checklist

| Spec section | Implemented by |
|---|---|
| §4 routes, surfaces, sort order | Tasks 5, 10, 11, 12 |
| §4 staleness + schema mismatch | Tasks 2, 3, 9 |
| §4 PWA manifest + service worker | Task 13 |
| §4 performance budget | Task 14 |
| §5 vault allowlist usage (available check) | Task 4, 11 |
| §5 wikilinks + frontmatter + code blocks | Tasks 6, 8, 11 |
| §5 dimmed node for unavailable page | Task 11 |
| §6 per-agent watchlist rendering | Task 10 (WatchlistsPanel) |

## Out of scope (named)

- **Real iOS / Lighthouse CI** — requires hosted deploy; README documents manual smoke.
- **Service worker offline writes** — PWA is read-only (spec §non-goals).
- **Cost analytics surface** — deferred (spec §Out of scope).
- **Vault search** — QMD runs on host only (spec §Out of scope).
- **Cron parse display cleanup** (the 7-token row) — upstream data fix, not PWA concern.
