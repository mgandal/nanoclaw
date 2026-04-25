# Cockpit Deploy Runbook — Plan B + Plan C First Production Deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to walk this runbook step-by-step. **This is a hybrid plan**: one TDD code-edit step (Step 10, PWA env-var wiring) plus a sequence of side-effecting Cloudflare deploy steps. Each deploy step has a verification command and a rollback recipe. Do not skip verifications. If a step fails, stop and follow the rollback before retrying.

**Goal:** Deploy the already-built cockpit-worker (Plan B) and cockpit-pwa (Plan C) to a Cloudflare account so Mike can view NanoClaw's snapshot dashboard from any device, gated by Cloudflare Access (email = `mgandal@gmail.com`).

**Architecture:** Already shipped. Plan A (`scripts/cockpit/main.ts`) publishes a JSON snapshot + page bundle every 30 min via `launchd/com.nanoclaw.cockpit.plist`. Plan B (`cockpit-worker/`) is a CF Worker that proxies authenticated requests to a private R2 bucket. Plan C (`cockpit-pwa/`) is a Preact PWA hosted on CF Pages. Both sit behind one Cloudflare Access application that lists two domains: `cockpit.<apex>` (PWA) and `cockpit-api.<apex>` (Worker). The PWA fetches `https://cockpit-api.<apex>/data/...` via a build-time env var (`VITE_API_BASE`).

**Pre-existing artifacts (verified 2026-04-25):**
- `cockpit-worker/` — 20/20 tests pass; deploy README at `cockpit-worker/README.md`.
- `cockpit-pwa/` — 71/71 tests pass; deploy README at `cockpit-pwa/README.md`.
- `cockpit-worker/wrangler.toml` pins `ALLOWED_EMAILS = "mgandal@gmail.com"`, `bucket_name = "nanoclaw-cockpit"`, `compatibility_date = "2026-04-01"`.
- `cockpit-worker/r2-lifecycle.json` — 30-day expiry on `snapshot-` prefix objects.
- `wrangler` 4.84.0 installed locally under `cockpit-worker/node_modules/.bin/wrangler` and `cockpit-pwa/node_modules/.bin/wrangler`.
- `launchctl list` shows `com.nanoclaw.cockpit` is running (StartInterval=1800).
- `wrangler whoami` returns "not authenticated" — Step 1 fixes this.

**Tech Stack:** Cloudflare Workers, Cloudflare Pages, Cloudflare R2, Cloudflare Access (Zero Trust), wrangler 4.x, bun, Vite 5, Preact.

**Spec:** `docs/superpowers/specs/2026-04-19-web-cockpit-design.md`. Source READMEs (already correct, this plan orchestrates them with one extra TDD edit): `cockpit-worker/README.md`, `cockpit-pwa/README.md`.

**Peer-review status (2026-04-25):** Reviewed by independent subagent; revision applied, see `Self-Review` section for the 10 findings addressed.

---

## Decision capture

Before starting, fill in the four blanks below in `~/.nanoclaw/cockpit-deploy.env` (gitignored — this file is for your own reference and resumption if the deploy is interrupted):

```bash
# Apex domain you control + can put a CF zone on (e.g. example.com).
# Cockpit lives at cockpit.<this>; Worker API lives at cockpit-api.<this>.
COCKPIT_APEX_DOMAIN=

# Subdomain pair. Defaults are fine; override only if conflicts exist.
COCKPIT_PWA_SUBDOMAIN=cockpit
COCKPIT_API_SUBDOMAIN=cockpit-api

# Email allowlisted in Cloudflare Access. Already pinned in wrangler.toml; if
# you change it here, also update cockpit-worker/wrangler.toml ALLOWED_EMAILS.
COCKPIT_ACCESS_EMAIL=mgandal@gmail.com

# CF account ID (filled in automatically after Step 1 — leave blank for now).
CF_ACCOUNT_ID=
```

Don't proceed to Step 1 until at least `COCKPIT_APEX_DOMAIN` is filled.

---

## Pre-flight: confirm the codebase is deploy-ready

Before touching Cloudflare, verify the code paths and infrastructure references the deploy will exercise. Note: snapshot-freshness verification has moved to **Step 4.3** because the snapshot builder is R2-coupled by design (`scripts/cockpit/main.ts` lines 39-41 throw if R2 env vars are missing — there's no dry-run mode), so we can't verify upload output until after Step 3 wires up R2 credentials.

- [ ] **Step P1: Confirm cockpit launchd plist exists and points at the right script**

```bash
test -f ~/Library/LaunchAgents/com.nanoclaw.cockpit.plist && echo "loaded plist exists" || echo "MISSING — run: cp /Users/mgandal/Agents/nanoclaw/launchd/com.nanoclaw.cockpit.plist ~/Library/LaunchAgents/"
test -f /Users/mgandal/Agents/nanoclaw/launchd/com.nanoclaw.cockpit.plist && echo "repo plist exists"
test -f /Users/mgandal/Agents/nanoclaw/scripts/cockpit/main.ts && echo "builder source exists"
```

Expected: all three "exists" lines. If `~/Library/LaunchAgents/com.nanoclaw.cockpit.plist` is MISSING, copy from the repo path (per the printed instruction). The job won't be loaded into launchd yet — that happens in Step 3.3 after R2 credentials are wired.

- [ ] **Step P2: Confirm code/tests are green**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-worker && bun run test 2>&1 | tail -3
cd /Users/mgandal/Agents/nanoclaw/cockpit-pwa && bun run test 2>&1 | tail -3
```

Expected: 20/20 worker, 71/71 PWA. If any fail, this plan is blocked — fix tests in a separate session first.

- [ ] **Step P3: Confirm SQLite + vault dependencies the builder reads**

The builder reads `store/messages.db`, `groups/global/state/current.md`, and the vault. Verify these exist:

```bash
test -f /Users/mgandal/Agents/nanoclaw/store/messages.db && echo "DB exists"
test -f /Users/mgandal/Agents/nanoclaw/groups/global/state/current.md && echo "current.md exists"
test -d /Volumes/sandisk4TB/marvin-vault && echo "vault mount available"
```

Expected: all three "exists". If the vault mount is unavailable (external drive unplugged), the builder will fail at scan time — plug it in before continuing.

---

## Step 1: Cloudflare Account Auth

**Files:** None (modifies `~/.config/.wrangler/`).

- [ ] **Step 1.1: Run wrangler login**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-worker
./node_modules/.bin/wrangler login
```

This opens a browser for OAuth. Sign in to your Cloudflare account (create one at `https://dash.cloudflare.com/sign-up` if you don't have one — free tier is sufficient for this plan).

- [ ] **Step 1.2: Verify auth + capture account ID**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-worker
./node_modules/.bin/wrangler whoami
```

Expected output includes a table with at least one account row. **Copy the Account ID** into `~/.nanoclaw/cockpit-deploy.env` as `CF_ACCOUNT_ID`. If multiple accounts, pick the one you want and `export CLOUDFLARE_ACCOUNT_ID=<id>` for subsequent steps.

- [ ] **Step 1.3: Verify the apex domain is on this account**

(Wrangler 4.x has no `zone list` subcommand — use the API directly or the dashboard.)

```bash
source ~/.nanoclaw/cockpit-deploy.env
dig +short NS "${COCKPIT_APEX_DOMAIN}" | head -2
```

Expected: two `*.ns.cloudflare.com` nameservers. If your registrar's NS records appear instead, the zone hasn't been added to Cloudflare yet. Add it at `https://dash.cloudflare.com/?to=/:account/add-site`, change nameservers at the registrar, and wait for propagation (typically <1 hour). Re-run `dig` until you see the CF nameservers. **Do not proceed to Step 2** until this resolves.

**Rollback:** `wrangler logout` clears credentials.

---

## Step 2: Create R2 Bucket + Apply Lifecycle

**Files:** Reads `cockpit-worker/r2-lifecycle.json` (already in repo).

- [ ] **Step 2.1: Create bucket**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-worker
./node_modules/.bin/wrangler r2 bucket create nanoclaw-cockpit
```

Expected: `Created bucket 'nanoclaw-cockpit'`.

- [ ] **Step 2.2: Verify bucket**

```bash
./node_modules/.bin/wrangler r2 bucket list 2>&1 | grep nanoclaw-cockpit
```

Expected: a row containing `nanoclaw-cockpit`.

- [ ] **Step 2.3: Apply lifecycle policy**

```bash
./node_modules/.bin/wrangler r2 bucket lifecycle put nanoclaw-cockpit --file r2-lifecycle.json
./node_modules/.bin/wrangler r2 bucket lifecycle get nanoclaw-cockpit
```

Expected: the `get` output includes a rule named `expire-history-snapshots` with `prefix: snapshot-` and `maxAge: 2592000` (30 days). The pointer `snapshot.json` and `pages/*.md` are NOT subject to this rule (different prefixes), which is correct.

**Rollback:** Apply an empty rules array to remove lifecycle, then delete the bucket. Bucket-delete only works if empty — if data is uploaded later (Step 4.4 onward), you must first list and delete each object via dashboard or `wrangler r2 object delete <bucket>/<key>` per-key. There is no `--recursive` flag in wrangler 4.x:

```bash
echo '{"rules":[]}' > /tmp/empty-lifecycle.json
./node_modules/.bin/wrangler r2 bucket lifecycle put nanoclaw-cockpit --file /tmp/empty-lifecycle.json
# After manually emptying the bucket via dashboard:
./node_modules/.bin/wrangler r2 bucket delete nanoclaw-cockpit
```

---

## Step 3: Create R2 API Token (dashboard-only)

This is what `scripts/cockpit/main.ts` uses to upload snapshots. Wrangler 4.x has no token-creation command — this step is dashboard-only.

**Files:** Adds `COCKPIT_R2_*` to `/Users/mgandal/Agents/nanoclaw/.env`.

- [ ] **Step 3.1: Create token via dashboard**

1. Go to `https://dash.cloudflare.com/?to=/:account/r2/api-tokens`
2. Click **Create API Token**
3. Token name: `nanoclaw-cockpit-publisher`
4. Permissions: **Object Read & Write**
5. Specify bucket: **Apply to specific buckets only** → `nanoclaw-cockpit`
6. TTL: 90 days (rotation cadence — see Step 13.5 reminder)
7. Click **Create API Token**
8. **Copy the Access Key ID and Secret Access Key now** — they're shown only once.

- [ ] **Step 3.2: Add credentials to .env (idempotent)**

```bash
cd /Users/mgandal/Agents/nanoclaw
# Remove any prior block (idempotent re-run safe)
sed -i.bak '/^# Cockpit R2/,/^COCKPIT_R2_TOKEN=/d' .env
# Append fresh block
cat >> .env <<EOF

# Cockpit R2 (Plan B) — added 2026-04-25
COCKPIT_R2_ENDPOINT=https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
COCKPIT_R2_BUCKET=nanoclaw-cockpit
COCKPIT_R2_TOKEN=<ACCESS_KEY_ID>:<SECRET_ACCESS_KEY>
EOF
```

Replace `<ACCESS_KEY_ID>:<SECRET_ACCESS_KEY>` with the values from Step 3.1 (no quotes; the colon is the separator). `${CF_ACCOUNT_ID}` interpolates from your env file. After editing, verify:

```bash
grep -c "^COCKPIT_R2_TOKEN=" /Users/mgandal/Agents/nanoclaw/.env
```

Expected: `1`. If `2+`, the sed didn't clean prior runs — manually deduplicate.

**Rollback:** Revoke the token at `https://dash.cloudflare.com/?to=/:account/r2/api-tokens` and re-run the `sed -i` command above (without the cat append) to remove the block from `.env`.

---

## Step 4: Load launchd job + first publish + verify R2 has objects

The cockpit launchd job has likely never been loaded (verified during pre-flight). With R2 credentials now in `.env`, load and trigger it.

**Files:** None (modifies launchd state).

- [ ] **Step 4.1: Load the launchd job (one-time)**

```bash
launchctl list | grep -q com.nanoclaw.cockpit \
  && echo "already loaded" \
  || launchctl load ~/Library/LaunchAgents/com.nanoclaw.cockpit.plist
launchctl list | grep com.nanoclaw.cockpit
```

Expected: a row like `<PID> 0 com.nanoclaw.cockpit` (PID may be `-` between runs). The plist has `RunAtLoad=true` so loading triggers an immediate execution. If exit code is non-zero, check `logs/cockpit.log`.

- [ ] **Step 4.2: Trigger immediate publish (idempotent)**

```bash
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw.cockpit"
sleep 30
tail -30 /Users/mgandal/Agents/nanoclaw/logs/cockpit.log
```

Expected: log ends with a line like `cockpit: ok, N pages uploaded, heartbeat <ISO timestamp>`. If you see `Missing R2 config`, `.env` wasn't picked up — verify Step 3.2 saved the file correctly. If you see 401/403 in the upload, the token is wrong — re-check `COCKPIT_R2_TOKEN` formatting (must be `<key-id>:<secret>`, no quotes, no spaces).

- [ ] **Step 4.3: Verify local snapshot was written**

```bash
ls -la /Users/mgandal/Agents/nanoclaw/data/cockpit/snapshot.json /Users/mgandal/Agents/nanoclaw/data/cockpit/last-snapshot.json 2>&1
```

Expected: both exist with mtime within the last minute. The local file is written before the upload (line 68 of `main.ts`) — if it exists, the builder ran successfully. The upload happens after.

- [ ] **Step 4.4: List R2 objects to confirm upload**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-worker
./node_modules/.bin/wrangler r2 object list nanoclaw-cockpit 2>&1 | head -10
```

Expected: at least `snapshot.json`, `heartbeat.txt`, and a `snapshot-YYYYMMDD-HHMM.json` historical entry. If empty, the local snapshot was written but upload failed — read `logs/cockpit.log` for the upload error. **Do not proceed to Step 5** until R2 has objects (deploying a Worker against an empty bucket gives 404 on every read).

---

## Step 5: Wire `VITE_API_BASE` env var into the PWA (TDD)

The PWA currently passes `window.location.origin` as the snapshot-fetch origin (`src/App.tsx:35`, `src/App.tsx:74`). Because the PWA will live at `cockpit.<apex>` and the Worker at `cockpit-api.<apex>`, the PWA must fetch from a different origin. Add a single helper that reads `import.meta.env.VITE_API_BASE` (set at build time) and falls back to `window.location.origin` for local dev.

**Files:** Creates `cockpit-pwa/src/lib/api-base.ts`. Modifies `cockpit-pwa/src/App.tsx`. Adds `cockpit-pwa/src/lib/api-base.test.ts`. Optionally updates `cockpit-pwa/src/lib/snapshot-fetch.test.ts` if it asserts the old origin (it does — see Step 5.4).

- [ ] **Step 5.1: Write the failing test first**

Create `cockpit-pwa/src/lib/api-base.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { resolveApiBase } from './api-base.js';

afterEach(() => {
  // Vitest exposes import.meta.env via vite; tests reset between files.
});

describe('resolveApiBase', () => {
  it('returns VITE_API_BASE when defined', () => {
    expect(resolveApiBase('https://cockpit-api.example.com', 'https://other.example')).toBe(
      'https://cockpit-api.example.com',
    );
  });

  it('falls back to fallbackOrigin when env is undefined', () => {
    expect(resolveApiBase(undefined, 'https://cockpit.example')).toBe('https://cockpit.example');
  });

  it('falls back to fallbackOrigin when env is empty string', () => {
    expect(resolveApiBase('', 'https://cockpit.example')).toBe('https://cockpit.example');
  });

  it('strips trailing slash from VITE_API_BASE', () => {
    expect(resolveApiBase('https://cockpit-api.example.com/', 'https://x')).toBe(
      'https://cockpit-api.example.com',
    );
  });
});
```

Run: `cd /Users/mgandal/Agents/nanoclaw/cockpit-pwa && bun run test src/lib/api-base.test.ts 2>&1 | tail -10`

Expected: 4 failing tests with `Cannot find module './api-base.js'`.

- [ ] **Step 5.2: Implement `api-base.ts`**

Create `cockpit-pwa/src/lib/api-base.ts`:

```typescript
/**
 * Resolve the base URL for /data/* fetches.
 * Production: VITE_API_BASE is set at build time to https://cockpit-api.<apex>.
 * Local dev: falls back to window.location.origin (so /data/* → vite dev server,
 * which 404s — the existing UI handles that).
 */
export function resolveApiBase(envValue: string | undefined, fallbackOrigin: string): string {
  if (envValue && envValue.length > 0) {
    return envValue.replace(/\/+$/, '');
  }
  return fallbackOrigin;
}

export function apiBase(): string {
  return resolveApiBase(import.meta.env.VITE_API_BASE as string | undefined, window.location.origin);
}
```

Re-run the test: `bun run test src/lib/api-base.test.ts` → expect 4/4 pass.

- [ ] **Step 5.3: Wire `apiBase()` into `App.tsx`**

Edit `cockpit-pwa/src/App.tsx`. Add an import and replace both `window.location.origin` callsites:

```typescript
// Add to import block (line 14ish):
import { apiBase } from './lib/api-base.js';

// Replace line 35:
fetchSnapshot(apiBase())

// Replace line 74:
<VaultPage slug={route.slug} tree={snap.vault_tree} origin={apiBase()} />
```

- [ ] **Step 5.4: Update existing snapshot-fetch test (defensive)**

The existing test in `cockpit-pwa/src/lib/snapshot-fetch.test.ts` already passes a literal `'https://cockpit.example'` origin to `fetchSnapshot()` (lines 36, 46, 54, 61, 69) — it does NOT exercise the env-var path, so no change needed. Verify by re-reading lines 36 + 46:

```bash
grep -n "cockpit.example" /Users/mgandal/Agents/nanoclaw/cockpit-pwa/src/lib/snapshot-fetch.test.ts
```

Expected: 5 matches (origin literals). No action required — `snapshot-fetch.ts` itself doesn't read env vars; only the call site (`App.tsx`) does.

- [ ] **Step 5.5: Full PWA test suite green**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-pwa
bun run test 2>&1 | tail -3
bun run typecheck 2>&1 | tail -3
```

Expected: 75/75 tests pass (71 prior + 4 new); typecheck clean.

- [ ] **Step 5.6: Commit code change**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add cockpit-pwa/src/lib/api-base.ts cockpit-pwa/src/lib/api-base.test.ts cockpit-pwa/src/App.tsx
git commit -m "feat(cockpit-pwa): VITE_API_BASE env var for prod two-subdomain deploy"
```

**Rollback:** `git revert <commit-sha>` undoes the code change. The deploy plan up to Step 4 is independent — rollback here doesn't affect R2 state.

---

## Step 6: Replace PWA placeholder icons

`cockpit-pwa/public/icon-192.png` and `icon-512.png` are 1×1 transparent stubs. iOS PWA install will work but show a blank icon. Replace before build (Step 7).

**Files:** Modifies `cockpit-pwa/public/icon-192.png` and `cockpit-pwa/public/icon-512.png`.

- [ ] **Step 6.1: Generate icons**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-pwa/public
# Place a square source PNG (≥512px) here as source.png first.
magick source.png -resize 192x192 icon-192.png
magick source.png -resize 512x512 icon-512.png
file icon-192.png icon-512.png
```

Expected: `192 x 192` and `512 x 512`. If you still see `1 x 1`, the source file wasn't found.

**Rollback:** `git checkout cockpit-pwa/public/icon-192.png cockpit-pwa/public/icon-512.png` restores the stubs (no functional impact, just blank icons).

---

## Step 7: Build the PWA

**Files:** Generates `cockpit-pwa/dist/`.

- [ ] **Step 7.1: Build with VITE_API_BASE injected**

```bash
source ~/.nanoclaw/cockpit-deploy.env
cd /Users/mgandal/Agents/nanoclaw/cockpit-pwa
VITE_API_BASE="https://${COCKPIT_API_SUBDOMAIN}.${COCKPIT_APEX_DOMAIN}" bun run build:check 2>&1 | tail -10
```

Expected: `dist/` produced, bundle-size check reports total ≤ 100 KB gzipped.

- [ ] **Step 7.2: Spot-check build output**

```bash
grep -r "cockpit-api" /Users/mgandal/Agents/nanoclaw/cockpit-pwa/dist/assets/ 2>&1 | head -3
```

Expected: at least one match in a JS bundle — proves the env var was inlined at build time. If zero matches, `VITE_API_BASE` wasn't set; re-run Step 7.1.

---

## Step 8: Deploy the Worker

**Files:** Modifies CF state (creates the Worker).

- [ ] **Step 8.1: Deploy**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-worker
./node_modules/.bin/wrangler deploy 2>&1 | tee /tmp/cockpit-worker-deploy.log
```

Expected: output ends with `Published cockpit-worker (...ms)` and a `*.workers.dev` URL. On first deploy, wrangler may prompt to confirm the R2 binding — accept.

- [ ] **Step 8.2: Capture the workers.dev URL**

```bash
WORKER_DEV_URL=$(grep -oE "https://cockpit-worker[^ ]*\.workers\.dev" /tmp/cockpit-worker-deploy.log | head -1)
echo "WORKER_DEV_URL=${WORKER_DEV_URL}"
```

Expected: a URL like `https://cockpit-worker.<account>.workers.dev`. If empty, read `/tmp/cockpit-worker-deploy.log` and copy manually.

- [ ] **Step 8.3: Smoke-test (note: this is NOT an Access test)**

```bash
curl -i "${WORKER_DEV_URL}/data/snapshot.json" 2>&1 | head -5
```

Expected: **403** (the Worker rejects the request because no `Cf-Access-*` headers are present). This proves the Worker's auth-rejection logic works. **It does NOT prove Cloudflare Access is wired** — that happens after Step 9. Don't mistake a 403 here for "Access is working."

If you get **200** here, the Worker is broken (it's serving without auth headers). Stop and investigate `cockpit-worker/src/index.ts` before continuing.

**Rollback:** `./node_modules/.bin/wrangler delete cockpit-worker` (will prompt for confirmation).

---

## Step 9: Create Cloudflare Access Application (with BOTH domains)

This step is dashboard-only. The Access app must list **both** `cockpit.<apex>` and `cockpit-api.<apex>` from the start so that Steps 10 and 11 can attach each domain to its CF resource without re-editing the Access policy.

**Files:** None (modifies CF Access state).

- [ ] **Step 9.1: Create the Access app**

1. Go to `https://one.dash.cloudflare.com/` (Zero Trust dashboard).
2. Navigate: **Access → Applications → Add an application → Self-hosted**.
3. Application name: `nanoclaw-cockpit`.
4. Session duration: **24 hours**.
5. **Application domain (1st):** `<COCKPIT_PWA_SUBDOMAIN>.<COCKPIT_APEX_DOMAIN>` (e.g. `cockpit.example.com`).
6. **Click "Add another domain"** → enter `<COCKPIT_API_SUBDOMAIN>.<COCKPIT_APEX_DOMAIN>` (e.g. `cockpit-api.example.com`).
7. Identity providers: enable **One-time PIN**.
8. Click **Next**.

- [ ] **Step 9.2: Add the allow policy**

1. Policy name: `mike-only`.
2. Action: **Allow**.
3. Configure rules → Include: **Emails** → enter `mgandal@gmail.com`.
4. Click **Next**, then **Add application**.

- [ ] **Step 9.3: Verify in dashboard**

In the Access Applications list, confirm `nanoclaw-cockpit` shows TWO domains. (Wrangler 4.x has no `wrangler access apps list` command — dashboard verification only.)

**Rollback:** Dashboard → Access → Applications → `nanoclaw-cockpit` → Delete.

---

## Step 10: Attach Worker to `cockpit-api.<apex>`

**Files:** None (CF dashboard).

- [ ] **Step 10.1: Add custom domain**

1. CF dashboard → Workers & Pages → `cockpit-worker` → Settings → Triggers → **Add Custom Domain**.
2. Domain: `<COCKPIT_API_SUBDOMAIN>.<COCKPIT_APEX_DOMAIN>` (the API subdomain — NOT the root `cockpit.` one).
3. Click **Add Custom Domain**.

CF auto-creates the DNS record + cert.

- [ ] **Step 10.2: Wait for cert provisioning**

```bash
source ~/.nanoclaw/cockpit-deploy.env
DOMAIN="${COCKPIT_API_SUBDOMAIN}.${COCKPIT_APEX_DOMAIN}"
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/data/heartbeat.txt")
  echo "Attempt $i: HTTP $STATUS"
  if [ "$STATUS" = "302" ] || [ "$STATUS" = "200" ] || [ "$STATUS" = "403" ]; then
    echo "Domain is responding"
    break
  fi
  sleep 15
done
```

Expected within 5 min: `302` (Access redirecting to login — success) or `403` (Worker rejecting unauthenticated). `5xx`/timeout means cert is still provisioning — wait longer.

**Rollback:** Same dashboard path → **Remove Custom Domain**.

---

## Step 11: Deploy the PWA + Attach to `cockpit.<apex>`

**Files:** Modifies CF state (creates a Pages project).

- [ ] **Step 11.1: Create Pages project (first time only)**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-pwa
./node_modules/.bin/wrangler pages project create cockpit --production-branch main 2>&1
```

Expected: confirmation that project `cockpit` was created. If "Project with name cockpit already exists", that's fine — skip to 11.2.

- [ ] **Step 11.2: Deploy**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-pwa
./node_modules/.bin/wrangler pages deploy dist --project-name cockpit 2>&1 | tee /tmp/cockpit-pwa-deploy.log
```

Expected: output ends with a deployment URL like `https://<hash>.cockpit.pages.dev`. Capture it:

```bash
PAGES_DEV_URL=$(grep -oE "https://[^ ]+\.cockpit\.pages\.dev" /tmp/cockpit-pwa-deploy.log | head -1)
echo "PAGES_DEV_URL=${PAGES_DEV_URL}"
```

- [ ] **Step 11.3: Attach `cockpit.<apex>` as custom domain**

1. CF dashboard → Pages → `cockpit` → Custom domains → **Set up a custom domain** → enter `<COCKPIT_PWA_SUBDOMAIN>.<COCKPIT_APEX_DOMAIN>`.
2. Confirm.

- [ ] **Step 11.4: Wait for cert**

```bash
source ~/.nanoclaw/cockpit-deploy.env
DOMAIN="${COCKPIT_PWA_SUBDOMAIN}.${COCKPIT_APEX_DOMAIN}"
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/")
  echo "Attempt $i: HTTP $STATUS"
  if [ "$STATUS" = "302" ] || [ "$STATUS" = "200" ]; then
    echo "PWA domain is responding"
    break
  fi
  sleep 15
done
```

Expected within 5 min: `302` (Access redirecting). Should NOT be `200` directly — that would mean Access is not gating the Pages site. If 200, re-check Step 9.1 (does the Access app list `cockpit.<apex>` as an application domain?).

**Rollback:** Detach the custom domain from Pages, then `wrangler pages project delete cockpit` if you want to remove the whole project.

---

## Step 12: End-to-end verification

**Files:** None.

- [ ] **Step 12.1: Cold-cache browser test**

In a fresh Incognito window, navigate to `https://<COCKPIT_PWA_SUBDOMAIN>.<COCKPIT_APEX_DOMAIN>`. Expected:

1. Cloudflare Access OTP login intercepts.
2. Enter `mgandal@gmail.com`, request the OTP, paste from email.
3. After successful auth, the cockpit dashboard renders with real snapshot data (priorities, tasks, vault tree).
4. DevTools → Network. Confirm requests go to `cockpit-api.<apex>/data/...` (NOT `cockpit.<apex>/data/...`) and return 200.

If you see `cockpit.<apex>/data/...` in Network, the build didn't pick up `VITE_API_BASE` — re-run Step 7.1 and Step 11.2.

- [ ] **Step 12.2: Vault page test**

Click into the vault tree → individual page. Markdown should render. Network panel should show `cockpit-api.<apex>/data/pages/<slug>.md` returning 200.

- [ ] **Step 12.3: Staleness banner test (optional)**

Manually upload a stale snapshot to R2 to test the banner without disabling launchd:

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-worker
# Read current snapshot, mutate generated_at to 2h ago, push back.
TS=$(date -u -v-2H "+%Y-%m-%dT%H:%M:%SZ")
./node_modules/.bin/wrangler r2 object get nanoclaw-cockpit/snapshot.json --file /tmp/snap.json
sed -E "s/(\"generated_at\":\")[^\"]+(\")/\1${TS}\2/" /tmp/snap.json > /tmp/snap-stale.json
./node_modules/.bin/wrangler r2 object put nanoclaw-cockpit/snapshot.json --file /tmp/snap-stale.json
```

Reload the cockpit. Expected: a staleness banner appears. Wait for the next launchd run (≤30 min) or manually kick: `launchctl kickstart -k "gui/$(id -u)/com.nanoclaw.cockpit"`. Reload — banner should clear.

- [ ] **Step 12.4: Mobile install (optional)**

iOS Safari → cockpit URL → Share → Add to Home Screen. Open the home-screen app. Expected: opens standalone, Access OTP works, dashboard renders.

- [ ] **Step 12.5: Negative test — wrong email**

Sign out of CF Access (separate browser profile). Navigate to cockpit URL. Try logging in with an email *other* than `mgandal@gmail.com`. Expected: Access blocks with "You don't have access to this application."

If a wrong email gets through, **stop everything** — the Access policy is misconfigured. Check Step 9.2 + the `ALLOWED_EMAILS` value in `cockpit-worker/wrangler.toml`.

- [ ] **Step 12.6: Tail the worker for one full session**

```bash
cd /Users/mgandal/Agents/nanoclaw/cockpit-worker
./node_modules/.bin/wrangler tail
```

In another terminal, hit a few PWA URLs in the browser. Expected: each request logs `email + path + 200/403/404`. Ctrl-C to stop.

---

## Step 13: Document the deploy + banner the plans

**Files:** Modifies the two existing plan banners + adds a banner to this plan.

- [ ] **Step 13.1: Update the cockpit-worker plan banner**

Edit `docs/superpowers/plans/2026-04-21-cockpit-worker.md` — change the first banner line from `**Status: SHIPPED (code).**` to `**Status: SHIPPED (code + deployed).**`. Append: ` Production URL: https://cockpit-api.<COCKPIT_APEX_DOMAIN>; deployed 2026-04-25 via 2026-04-25-cockpit-deploy.md.`

- [ ] **Step 13.2: Update the cockpit-pwa plan banner**

Edit `docs/superpowers/plans/2026-04-21-cockpit-pwa.md` — change `**Status: SHIPPED.**` to `**Status: SHIPPED + DEPLOYED 2026-04-25.**`. Append: ` Production URL: https://cockpit.<COCKPIT_APEX_DOMAIN>; deployed via 2026-04-25-cockpit-deploy.md.`

- [ ] **Step 13.3: Banner this plan**

Add `> **Status: SHIPPED <date>**` banner with both production URLs to the top of this file.

- [ ] **Step 13.4: Commit**

```bash
cd /Users/mgandal/Agents/nanoclaw
git add docs/superpowers/plans/
git commit -m "docs(cockpit): mark cockpit-worker + cockpit-pwa SHIPPED + DEPLOYED"
```

- [ ] **Step 13.5: Calendar reminder for token rotation**

R2 token created in Step 3.1 has 90-day TTL. Set a calendar reminder for ~80 days from today (rotation procedure: `cockpit-worker/README.md` "Rotating the R2 token").

---

## Self-Review (post peer review)

Peer reviewer (independent subagent, 2026-04-25) flagged 10 issues; all addressed in this revision:

1. **PWA env-var change is now an explicit TDD step** (Step 5: api-base.ts + 4 unit tests + App.tsx wiring + commit). Was previously hand-waved.
2. **Removed non-existent wrangler commands:** `wrangler zone list` → `dig +short NS` (Step 1.3); `wrangler access apps list` → dashboard verification (Step 9.3); `wrangler deployments list | awk` → tee + grep on deploy log (Step 8.2 / 11.2).
3. **Eliminated the mid-plan rewiring.** Worker goes directly to `cockpit-api.<apex>` (Step 10); Pages goes to `cockpit.<apex>` (Step 11). Access app lists both domains from Step 9.1. Old Steps 11.1–11.4 are gone.
4. **R2 bucket-rollback corrected** (no `--recursive` in wrangler 4.x; manual empty + delete documented in Step 2.3 rollback).
5. **`.env` append is now idempotent** via prefatory `sed -i.bak` cleanup (Step 3.2).
6. **Step 8.3 honest about what `*.workers.dev` 403 proves** (Worker auth rejection works) vs. what it doesn't (Access binding — that's verified in Step 12.1's 302).
7. **Pre-flight P1 checks `last exit code`** via `launchctl print`, not just registration.
8. **Step 12.3 staleness test** uses real `wrangler r2 object put` instead of the made-up "edit and reupload via launchd" trick.
9. **Access app lists both domains from the start** (Step 9.1 — eliminates the late-stage domain addition from the prior draft).
10. **Step 6 (icons) precedes Step 7 (build)** — already true; explicit dependency callout added in Step 6 intro.

Other improvements:
- Build-time env-var verification (Step 7.2 greps `dist/assets/` for the API hostname) catches a broken `VITE_API_BASE` *before* deploy.
- Step 12.1 explicitly tells you what to do if Network shows wrong-origin requests (Step 7.1 + 11.2 re-run).
- Test count updated (71 → 75 after Step 5 adds 4 tests for `api-base.ts`).

## Out of scope (defer)

- Workers-Routes single-domain consolidation (combine PWA + Worker behind one URL).
- CI-triggered redeploys.
- Multi-user Access policies (group membership rules for lab members).
- Custom Access identity providers (Google SSO etc.) — One-time PIN is sufficient for single-user.
- Cost monitoring / alerting on R2 spend.
- Cross-region failover.

If any of these become needs, write a follow-up plan rather than retrofitting this one.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-04-25-cockpit-deploy.md`. Suggested execution mode: **inline with executing-plans**, because every step after Step 5 is side-effecting and you'll want to inspect output before proceeding. Step 5 is the only "real" code change and could be a subagent task if desired.

Estimated total time: 60-90 min on the happy path; +30-60 if zone propagation is needed in Step 1.3.
