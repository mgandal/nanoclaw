# cockpit-worker

Access-gated read-only Cloudflare Worker that proxies to R2 for the NanoClaw
web cockpit. This is Plan B of 3 from `docs/superpowers/specs/2026-04-19-web-cockpit-design.md`.

## What it does

- Listens on `/data/*` routes.
- Validates the `Cf-Access-Jwt-Assertion` and `Cf-Access-Authenticated-User-Email` headers
  that Cloudflare Access attaches to authenticated requests.
- Serves four object classes from the private R2 bucket:
  - `snapshot.json` — latest pointer
  - `snapshot-YYYYMMDD-HHMM.json` — history (30-day lifecycle)
  - `heartbeat.txt` — last successful publisher run
  - `pages/<slug>.md` — individual vault pages

Anything else returns `404`. Anything missing headers or with a non-allowlisted
email returns `403`.

## Prerequisites

- Cloudflare account (free tier is sufficient).
- `wrangler` installed (`bun install` inside this directory).
- `wrangler login` completed (stores creds under `~/.config/.wrangler/`).

## Step 1 — Create the R2 bucket

```bash
./node_modules/.bin/wrangler r2 bucket create nanoclaw-cockpit
```

## Step 2 — Apply the 30-day lifecycle rule

```bash
./node_modules/.bin/wrangler r2 bucket lifecycle put nanoclaw-cockpit --file r2-lifecycle.json
```

This expires any object with key prefix `snapshot-` after 2,592,000 seconds
(30 days). The pointer `snapshot.json` and individual `pages/*.md` objects
are unaffected because they don't match the `snapshot-` prefix.

Verify:

```bash
./node_modules/.bin/wrangler r2 bucket lifecycle get nanoclaw-cockpit
```

## Step 3 — Create the Cloudflare Access application

Cloudflare dashboard → Zero Trust → Access → Applications → **Add an application**.

- Type: **Self-hosted**
- Application name: `nanoclaw-cockpit`
- Session duration: whatever fits your risk posture (24h is fine for single-user).
- Application domain: the subdomain you'll serve the cockpit from
  (e.g. `cockpit.example.com`; see Plan C for the Pages site that will live at
  the same host).
- Identity providers: **One-time PIN** (email OTP; no password required).
- Policies: **Allow** include rule → **Emails** → `mgandal@gmail.com`.

Save. The Access application now gates every request to the domain — all reads
funnel through Access before they can reach the Worker.

## Step 4 — Deploy the Worker

```bash
./node_modules/.bin/wrangler deploy
```

On first deploy, wrangler asks you to confirm the R2 binding; accept.

After deploy, attach a route to the Worker in the Cloudflare dashboard or via
`wrangler.toml` so that the Worker handles requests to `cockpit.<your-domain>/data/*`.

## Step 5 — Smoke test

With Access JWT session in a browser:

```
GET https://cockpit.<your-domain>/data/heartbeat.txt
```

Expected: 200 with the most recent publisher heartbeat timestamp (after Plan A
has run at least once against this bucket). Without Access session: the request
is intercepted by Access and never reaches the Worker — 302 to the Access login.

Direct request with no Access session and no headers (curl):

```bash
curl -i https://cockpit.<your-domain>/data/snapshot.json
```

Expected: Access intercepts → 302. If the Worker *does* somehow receive the
request (misconfiguration), it returns 403 because neither
`Cf-Access-Jwt-Assertion` nor `Cf-Access-Authenticated-User-Email` is present.

## Step 6 — Create the R2 `PutObject`-only token for the snapshot builder

This is the token Plan A's `scripts/cockpit/main.ts` uses to upload snapshots.
Cloudflare dashboard → R2 → Manage R2 API Tokens → **Create API Token**.

- Permissions: **Object Read & Write** on the `nanoclaw-cockpit` bucket only.
- (Tighten to **Object Write** only if the dashboard exposes that granularity;
  the builder never reads from R2.)
- TTL: as short as you're willing to rotate (90 days is a reasonable default).

Save the access key ID + secret, then in the NanoClaw root `.env`:

```
COCKPIT_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
COCKPIT_R2_BUCKET=nanoclaw-cockpit
COCKPIT_R2_TOKEN=<access-key-id>:<secret>
```

The builder parses `COCKPIT_R2_TOKEN` on `:` — see `scripts/cockpit/main.ts`.

## Rotating the R2 token

1. Dashboard → R2 → Manage R2 API Tokens → revoke the old token.
2. Create a new one per Step 6.
3. Update `.env` on the host.
4. Wait for the next launchd cockpit run (≤30 min) or trigger manually:
   ```
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw.cockpit
   ```
5. Check `logs/cockpit.log` for a successful upload.

## Rotating Access

Revoke and re-create the policy in Cloudflare dashboard → Zero Trust → Access
→ Applications → `nanoclaw-cockpit` → Policies. No Worker redeploy needed —
Access enforcement happens at the edge, upstream of the Worker.

## Development

Local dev (against a Miniflare stub; no real R2):

```bash
bun run dev
```

Tests:

```bash
bun run test
```

Type check:

```bash
bun run typecheck
```
