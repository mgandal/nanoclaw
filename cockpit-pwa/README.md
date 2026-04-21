# cockpit-pwa

Read-only static PWA for the NanoClaw web cockpit. This is Plan C of 3 from
`docs/superpowers/specs/2026-04-19-web-cockpit-design.md`. Consumes snapshots
produced by Plan A and proxied by Plan B.

## What it does

Renders seven dashboard surfaces at `/`, a vault tree browser at `/#/vault`,
and an individual vault page at `/#/vault/:slug`. Styled mobile-first; 2-col
grid at 768px+.

## Performance budget

- Initial JS: **≤ 100 KB gzipped** (currently 8.73 KB).
- Heavy deps (markdown-it + highlight.js, ~100 KB gzip combined) are
  **lazy-loaded** via dynamic `import()` from `VaultPage.tsx`. Users who stay
  on the home route never download them.
- Enforced by `bun run build:check`. Add any new dynamic-import chunks to
  `scripts/check-bundle-size.mjs` → `LAZY_PREFIXES`.

## Local development

```bash
bun install
bun run dev       # vite dev server at http://localhost:5173
bun run test      # vitest with happy-dom + @testing-library/preact
bun run typecheck
bun run build     # production bundle → dist/
bun run build:check   # build + enforce bundle-size budget
```

Note: `bun run dev` will fail to fetch `snapshot.json` in local dev because
there's no Worker running. Expected behavior — the snapshot-fetch error
message is part of the UI contract. To test against a real snapshot, either
build + preview after deploying Plans A+B, or seed
`dist/data/snapshot.json` manually and use `bun run preview`.

## Deploy — Cloudflare Pages

### Prereqs

- Plan A (snapshot builder) running + publishing to R2.
- Plan B (cockpit-worker) deployed with R2 binding.
- Cloudflare Access application from Plan B configured with your email.

### Step 1 — Replace placeholder icons

The committed `public/icon-192.png` and `public/icon-512.png` are 1×1 transparent
PNG stubs. Generate real icons (any tool, e.g. `https://realfavicongenerator.net/`
or ImageMagick + a source SVG) and replace before deploy.

### Step 2 — First deploy

```bash
bun run build
./node_modules/.bin/wrangler pages deploy dist --project-name cockpit
```

(Or use `wrangler pages project create cockpit` first if the project doesn't
exist yet.) Subsequent deploys just re-run `deploy`.

### Step 3 — Wire to the same Access application

Cloudflare dashboard → Pages → `cockpit` → Custom domains → add the same domain
used by the cockpit-worker (e.g. `cockpit.<your-domain>`). Make sure the
Access application from Plan B covers both the Worker route and the Pages site.

### Step 4 — Verify

- Open the domain in a browser signed in to the Access email.
- Confirm the dashboard renders with real snapshot data.
- Confirm the staleness banner fires when the snapshot is old (simulate by
  temporarily stopping the launchd cockpit job on the Mac).
- Install to iOS home screen: Safari → Share → Add to Home Screen. Confirm
  the app opens standalone (no Safari chrome).

## Service worker cache-bust

When shipping a new UI version, the hashed filenames (vite asset hashes) ensure
browsers pick up the new bundle on reload. For a clean slate:

```js
// Paste in DevTools console while viewing the cockpit:
navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
location.reload();
```

## Schema version coordination

`src/types.ts` mirrors `scripts/cockpit/types.ts` in the main repo.
When Plan A bumps `SCHEMA_VERSION`:

1. Update both files to the new number.
2. Ship Plan A first (new snapshots start carrying the new version).
3. Ship Plan C next; the schema-mismatch banner in `StalenessBanner.tsx` will
   fire for users who haven't yet reloaded, prompting them to refresh.

Shipping Plan C before Plan A breaks the banner (new UI sees old snapshot →
banner shows "out of date" on every load).

## Test layout

```
src/lib/          pure-logic modules + unit tests (vitest)
src/components/   Preact components + render tests (@testing-library/preact)
src/test-setup.ts global afterEach(cleanup) for component tests
```

71 tests cover: staleness + schema + slug + cron-sort + wikilink +
snapshot-fetch + markdown rendering + every component's happy path, empty
state, and edge cases (wrong email, missing chunks, broken wikilinks, etc.).

## Spec coverage

See Plan C doc (`docs/superpowers/plans/2026-04-21-cockpit-pwa.md`, §Spec
coverage checklist) for the field-by-field mapping.
