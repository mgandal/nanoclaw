# Cockpit Worker + R2 + Access Implementation Plan (Plan B)

> **Status: SHIPPED (code).** All worker code, tests, wrangler config, R2 lifecycle JSON, and deploy README are present. `bun run test` reports 20/20 passing; `tsc --noEmit` clean. Open `- [ ]` boxes were never updated retroactively. **REMAINING WORK: deploy steps that require Cloudflare account access** — `wrangler r2 bucket create nanoclaw-cockpit`, `wrangler r2 bucket lifecycle put`, the Access policy in the CF dashboard, and `wrangler deploy`. These are documented in `cockpit-worker/README.md` and must be run interactively by the user.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the read-only Cloudflare Worker that validates Cloudflare Access JWTs and proxies `GET` requests to the private R2 bucket populated by Plan A's snapshot builder. Also ship the R2 lifecycle rule for history expiry and a deployment README for the Access policy + R2 bucket + Worker.

**Architecture:** Standalone Cloudflare Worker at `cockpit-worker/` with `src/index.ts` (request handler), `src/access.ts` (JWT header validation), `src/router.ts` (path→R2 key mapping + content-type). Uses a native R2 binding (`env.COCKPIT_BUCKET.get(key)`) to stream objects without ever holding them in memory. No third-party deps beyond `wrangler` (dev) and `itty-router` (optional, kept out to minimize attack surface). Tests run under vitest with stub `env` objects — no wrangler dev server needed for unit tests.

**Related:** Implements §7 Worker and §Security (Access JWT validation) of `docs/superpowers/specs/2026-04-19-web-cockpit-design.md`. Excluded: Pages/PWA (Plan C), the snapshot builder itself (Plan A — already shipped).

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `cockpit-worker/package.json` | Dev deps: `wrangler`, `@cloudflare/workers-types`, `vitest`, `typescript`. |
| `cockpit-worker/tsconfig.json` | TS config targeting ES2022 + workers types. |
| `cockpit-worker/wrangler.toml` | Worker config + R2 binding (`COCKPIT_BUCKET`). |
| `cockpit-worker/src/index.ts` | `fetch` entrypoint — dispatches to router. |
| `cockpit-worker/src/router.ts` | Maps URL path to R2 key + content-type. |
| `cockpit-worker/src/router.test.ts` | Unit tests for path→key + content-type + 404. |
| `cockpit-worker/src/access.ts` | Extract + validate `Cf-Access-Jwt-Assertion` / `Cf-Access-Authenticated-User-Email` headers. |
| `cockpit-worker/src/access.test.ts` | Unit tests for header validation + email allowlist. |
| `cockpit-worker/src/handler.ts` | Compose access + router + R2 fetch into a single handler. |
| `cockpit-worker/src/handler.test.ts` | Integration test with stubbed R2 binding. |
| `cockpit-worker/vitest.config.ts` | Vitest config scoping to cockpit-worker tests. |
| `cockpit-worker/README.md` | Deploy instructions (Access policy + R2 bucket + lifecycle + Worker secrets). |
| `cockpit-worker/r2-lifecycle.json` | R2 lifecycle rule JSON (30-day expiry on `snapshot-*.json`). |

### Modified files

None. The Worker is a self-contained subdirectory; no edits to the main repo's `src/` or `package.json`.

### Out of this plan (deployed artifacts, not code)

- **Cloudflare Access application** — configured in CF dashboard. README documents exact steps.
- **R2 bucket creation** — `wrangler r2 bucket create nanoclaw-cockpit`. README documents it.
- **R2 lifecycle rule** — applied via `wrangler r2 bucket lifecycle put nanoclaw-cockpit --file r2-lifecycle.json`. README documents it.
- **PWA (Pages site)** — Plan C.

---

## Task 0: Prep — directory scaffolding + dev deps

**Files:**
- Create: `cockpit-worker/` (empty dir)
- Create: `cockpit-worker/package.json`
- Create: `cockpit-worker/tsconfig.json`
- Create: `cockpit-worker/vitest.config.ts`

- [ ] **Step 1: Create worker directory**

```bash
mkdir -p cockpit-worker/src
```

- [ ] **Step 2: Write `cockpit-worker/package.json`**

```json
{
  "name": "cockpit-worker",
  "version": "0.1.0",
  "private": true,
  "description": "Cloudflare Worker: Access-gated read-only proxy to R2 for NanoClaw cockpit",
  "type": "module",
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.6.0",
    "vitest": "^4.0.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 3: Write `cockpit-worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Write `cockpit-worker/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Install dev deps**

```bash
cd cockpit-worker && bun install
```

Note: we use `bun install` as the package manager but the Worker runtime will be Cloudflare's, not Bun. Tests run under vitest directly.

- [ ] **Step 6: Commit**

```bash
git add cockpit-worker/package.json cockpit-worker/tsconfig.json cockpit-worker/vitest.config.ts cockpit-worker/bun.lock
git commit -m "feat(worker): scaffold cockpit-worker directory with deps"
```

---

## Task 1: Router — path → R2 key + content-type mapping

**Files:**
- Create: `cockpit-worker/src/router.ts`
- Create: `cockpit-worker/src/router.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// cockpit-worker/src/router.test.ts
import { describe, it, expect } from 'vitest';
import { routeRequest } from './router.js';

describe('routeRequest', () => {
  it('maps /data/snapshot.json to snapshot.json with application/json', () => {
    const r = routeRequest('/data/snapshot.json');
    expect(r).toEqual({ key: 'snapshot.json', contentType: 'application/json' });
  });

  it('maps /data/heartbeat.txt to heartbeat.txt with text/plain', () => {
    const r = routeRequest('/data/heartbeat.txt');
    expect(r).toEqual({ key: 'heartbeat.txt', contentType: 'text/plain; charset=utf-8' });
  });

  it('maps /data/pages/<slug>.md to pages/<slug>.md with text/markdown', () => {
    const r = routeRequest('/data/pages/99-wiki%2Ftools%2Fpolars-bio.md');
    expect(r).toEqual({
      key: 'pages/99-wiki%2Ftools%2Fpolars-bio.md',
      contentType: 'text/markdown; charset=utf-8',
    });
  });

  it('maps /data/snapshot-YYYYMMDD-HHMM.json to the history object', () => {
    const r = routeRequest('/data/snapshot-20260419-1200.json');
    expect(r).toEqual({
      key: 'snapshot-20260419-1200.json',
      contentType: 'application/json',
    });
  });

  it('returns null for paths outside /data/', () => {
    expect(routeRequest('/')).toBeNull();
    expect(routeRequest('/other/snapshot.json')).toBeNull();
  });

  it('returns null for path traversal attempts', () => {
    expect(routeRequest('/data/../etc/passwd')).toBeNull();
    expect(routeRequest('/data/pages/../../etc')).toBeNull();
  });

  it('returns null for unknown extensions under /data/', () => {
    expect(routeRequest('/data/evil.sh')).toBeNull();
    expect(routeRequest('/data/config.yaml')).toBeNull();
  });
});
```

- [ ] **Step 2: Run; confirm RED**

```bash
cd cockpit-worker && bun --bun vitest run src/router.test.ts
```

- [ ] **Step 3: Implement `router.ts`**

```typescript
// cockpit-worker/src/router.ts
export interface Route {
  key: string;
  contentType: string;
}

const PREFIX = '/data/';

export function routeRequest(pathname: string): Route | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const tail = pathname.slice(PREFIX.length);

  // Reject path traversal. Even though R2 keys are flat, a ".." in the
  // input is a clear bad-faith signal — refuse rather than normalize.
  if (tail.includes('..')) return null;
  if (tail.length === 0) return null;

  // Allowed shapes:
  //   snapshot.json                        → application/json
  //   snapshot-YYYYMMDD-HHMM.json          → application/json
  //   heartbeat.txt                        → text/plain
  //   pages/<slug>.md                      → text/markdown
  if (tail === 'snapshot.json' || /^snapshot-\d{8}-\d{4}\.json$/.test(tail)) {
    return { key: tail, contentType: 'application/json' };
  }
  if (tail === 'heartbeat.txt') {
    return { key: tail, contentType: 'text/plain; charset=utf-8' };
  }
  if (tail.startsWith('pages/') && tail.endsWith('.md')) {
    return { key: tail, contentType: 'text/markdown; charset=utf-8' };
  }
  return null;
}
```

- [ ] **Step 4: Run; GREEN**

- [ ] **Step 5: Commit**

```bash
git add cockpit-worker/src/router.ts cockpit-worker/src/router.test.ts
git commit -m "feat(worker): path router with allowlist + traversal guard"
```

---

## Task 2: Access JWT header validator

**Files:**
- Create: `cockpit-worker/src/access.ts`
- Create: `cockpit-worker/src/access.test.ts`

Cloudflare Access attaches two headers to authenticated requests: `Cf-Access-Jwt-Assertion` (the full JWT) and `Cf-Access-Authenticated-User-Email` (the email it resolved to). The Worker's minimum guard is: reject requests missing either header. Full JWT-signature validation is a hardening extension the deploy README describes; the first-ship version trusts that only Access can reach the Worker (configured in CF dashboard — see README).

- [ ] **Step 1: Write the failing test**

```typescript
// cockpit-worker/src/access.test.ts
import { describe, it, expect } from 'vitest';
import { checkAccess } from './access.js';

describe('checkAccess', () => {
  const ALLOWED = ['mgandal@gmail.com'];

  it('accepts request with both headers and allowlisted email', () => {
    const headers = new Headers({
      'Cf-Access-Jwt-Assertion': 'eyJ...',
      'Cf-Access-Authenticated-User-Email': 'mgandal@gmail.com',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(true);
    expect(r.email).toBe('mgandal@gmail.com');
  });

  it('rejects request missing the JWT header', () => {
    const headers = new Headers({
      'Cf-Access-Authenticated-User-Email': 'mgandal@gmail.com',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/jwt/i);
  });

  it('rejects request missing the email header', () => {
    const headers = new Headers({
      'Cf-Access-Jwt-Assertion': 'eyJ...',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/email/i);
  });

  it('rejects request with non-allowlisted email', () => {
    const headers = new Headers({
      'Cf-Access-Jwt-Assertion': 'eyJ...',
      'Cf-Access-Authenticated-User-Email': 'stranger@example.com',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not.*allow/i);
  });

  it('is case-insensitive on email comparison', () => {
    const headers = new Headers({
      'Cf-Access-Jwt-Assertion': 'eyJ...',
      'Cf-Access-Authenticated-User-Email': 'MGandal@Gmail.com',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(true);
  });
});
```

- [ ] **Step 2: RED**

- [ ] **Step 3: Implement `access.ts`**

```typescript
// cockpit-worker/src/access.ts
export type AccessResult =
  | { allowed: true; email: string }
  | { allowed: false; reason: string };

export function checkAccess(headers: Headers, allowedEmails: string[]): AccessResult {
  const jwt = headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return { allowed: false, reason: 'missing Cf-Access-Jwt-Assertion header' };

  const email = headers.get('Cf-Access-Authenticated-User-Email');
  if (!email) return { allowed: false, reason: 'missing Cf-Access-Authenticated-User-Email header' };

  const normalized = email.toLowerCase();
  const match = allowedEmails.some(a => a.toLowerCase() === normalized);
  if (!match) return { allowed: false, reason: `email not in allowlist: ${email}` };

  return { allowed: true, email: normalized };
}
```

- [ ] **Step 4: GREEN**

- [ ] **Step 5: Commit**

```bash
git add cockpit-worker/src/access.ts cockpit-worker/src/access.test.ts
git commit -m "feat(worker): Cloudflare Access header validator"
```

---

## Task 3: Handler — compose access + router + R2 fetch

**Files:**
- Create: `cockpit-worker/src/handler.ts`
- Create: `cockpit-worker/src/handler.test.ts`

- [ ] **Step 1: Integration test with stubbed R2 bucket**

```typescript
// cockpit-worker/src/handler.test.ts
import { describe, it, expect } from 'vitest';
import { handleRequest, type Env } from './handler.js';

function makeEnv(objects: Record<string, string | null>): Env {
  return {
    COCKPIT_BUCKET: {
      get: async (key: string) => {
        const body = objects[key];
        if (body === undefined || body === null) return null;
        return {
          body: new Response(body).body,
          httpEtag: '"stub"',
          writeHttpMetadata: (h: Headers) => h.set('etag', '"stub"'),
        } as unknown as R2ObjectBody;
      },
    } as unknown as R2Bucket,
    ALLOWED_EMAILS: 'mgandal@gmail.com',
  };
}

function authedRequest(url: string): Request {
  return new Request(url, {
    headers: {
      'Cf-Access-Jwt-Assertion': 'eyJ...',
      'Cf-Access-Authenticated-User-Email': 'mgandal@gmail.com',
    },
  });
}

describe('handleRequest', () => {
  it('returns 200 with R2 body for an authed snapshot request', async () => {
    const env = makeEnv({ 'snapshot.json': '{"ok":true}' });
    const res = await handleRequest(authedRequest('https://cockpit.example/data/snapshot.json'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('returns 404 when R2 object is missing', async () => {
    const env = makeEnv({});
    const res = await handleRequest(authedRequest('https://cockpit.example/data/snapshot.json'), env);
    expect(res.status).toBe(404);
  });

  it('returns 403 when Cf-Access headers are missing', async () => {
    const env = makeEnv({ 'snapshot.json': '{}' });
    const req = new Request('https://cockpit.example/data/snapshot.json');
    const res = await handleRequest(req, env);
    expect(res.status).toBe(403);
  });

  it('returns 403 when email is not allowlisted', async () => {
    const env = makeEnv({ 'snapshot.json': '{}' });
    const req = new Request('https://cockpit.example/data/snapshot.json', {
      headers: {
        'Cf-Access-Jwt-Assertion': 'x',
        'Cf-Access-Authenticated-User-Email': 'stranger@example.com',
      },
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(403);
  });

  it('returns 404 for paths outside /data/', async () => {
    const env = makeEnv({});
    const res = await handleRequest(authedRequest('https://cockpit.example/'), env);
    expect(res.status).toBe(404);
  });

  it('returns 405 for non-GET methods', async () => {
    const env = makeEnv({ 'snapshot.json': '{}' });
    const req = new Request('https://cockpit.example/data/snapshot.json', {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': 'x',
        'Cf-Access-Authenticated-User-Email': 'mgandal@gmail.com',
      },
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(405);
  });

  it('adds cache-control: no-store on snapshot.json (freshness-critical)', async () => {
    const env = makeEnv({ 'snapshot.json': '{}' });
    const res = await handleRequest(authedRequest('https://cockpit.example/data/snapshot.json'), env);
    expect(res.headers.get('cache-control')).toMatch(/no-store|no-cache/);
  });

  it('adds cache-control: immutable-style on history snapshot (never changes)', async () => {
    const env = makeEnv({ 'snapshot-20260419-1200.json': '{}' });
    const res = await handleRequest(authedRequest('https://cockpit.example/data/snapshot-20260419-1200.json'), env);
    expect(res.headers.get('cache-control')).toMatch(/max-age|immutable/);
  });
});
```

- [ ] **Step 2: RED**

- [ ] **Step 3: Implement `handler.ts`**

```typescript
// cockpit-worker/src/handler.ts
import { routeRequest } from './router.js';
import { checkAccess } from './access.js';

export interface Env {
  COCKPIT_BUCKET: R2Bucket;
  ALLOWED_EMAILS: string;  // comma-separated
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }

  const allowed = env.ALLOWED_EMAILS.split(',').map(s => s.trim()).filter(Boolean);
  const access = checkAccess(req.headers, allowed);
  if (!access.allowed) {
    return new Response('forbidden', { status: 403 });
  }

  const url = new URL(req.url);
  const route = routeRequest(url.pathname);
  if (!route) {
    return new Response('not found', { status: 404 });
  }

  const obj = await env.COCKPIT_BUCKET.get(route.key);
  if (obj === null) {
    return new Response('not found', { status: 404 });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('content-type', route.contentType);
  headers.set('cache-control', cacheControlFor(route.key));

  return new Response(obj.body, { status: 200, headers });
}

function cacheControlFor(key: string): string {
  // snapshot.json and heartbeat.txt must always be fresh.
  if (key === 'snapshot.json' || key === 'heartbeat.txt') {
    return 'no-store';
  }
  // Dated history snapshots and individual pages are immutable once written.
  return 'public, max-age=300, immutable';
}
```

- [ ] **Step 4: GREEN**

- [ ] **Step 5: Commit**

```bash
git add cockpit-worker/src/handler.ts cockpit-worker/src/handler.test.ts
git commit -m "feat(worker): request handler composing access + router + R2 fetch"
```

---

## Task 4: Worker entrypoint

**Files:**
- Create: `cockpit-worker/src/index.ts`

Thin glue: ~5 lines exporting a `fetch` handler that delegates to `handleRequest`. No dedicated tests — Task 3's handler.test.ts covers behavior.

- [ ] **Step 1: Write `index.ts`**

```typescript
// cockpit-worker/src/index.ts
import { handleRequest, type Env } from './handler.js';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Typecheck**

```bash
cd cockpit-worker && bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add cockpit-worker/src/index.ts
git commit -m "feat(worker): fetch entrypoint"
```

---

## Task 5: wrangler.toml + R2 lifecycle rule

**Files:**
- Create: `cockpit-worker/wrangler.toml`
- Create: `cockpit-worker/r2-lifecycle.json`

- [ ] **Step 1: Write `wrangler.toml`**

```toml
name = "cockpit-worker"
main = "src/index.ts"
compatibility_date = "2026-04-01"

[[r2_buckets]]
binding = "COCKPIT_BUCKET"
bucket_name = "nanoclaw-cockpit"

[vars]
ALLOWED_EMAILS = "mgandal@gmail.com"
```

- [ ] **Step 2: Write `r2-lifecycle.json`**

```json
{
  "rules": [
    {
      "id": "expire-history-snapshots",
      "enabled": true,
      "conditions": {
        "prefix": "snapshot-"
      },
      "deleteObjectsTransition": {
        "condition": {
          "type": "Age",
          "maxAge": 2592000
        }
      }
    }
  ]
}
```

(30 days = 2592000 seconds.)

- [ ] **Step 3: Validate wrangler.toml parses**

```bash
cd cockpit-worker && npx wrangler deploy --dry-run --outdir=/tmp/wrangler-dryrun 2>&1 | head -20
```

Expected: completes without syntax errors. Will fail on missing auth — that's fine (not blocking this plan).

- [ ] **Step 4: Commit**

```bash
git add cockpit-worker/wrangler.toml cockpit-worker/r2-lifecycle.json
git commit -m "feat(worker): wrangler config + R2 30-day lifecycle rule"
```

---

## Task 6: Deploy README

**Files:**
- Create: `cockpit-worker/README.md`

Documents manual deploy steps (can't automate — needs the user's Cloudflare account).

- [ ] **Step 1: Write README**

Sections: Prerequisites, Step 1 (R2 bucket), Step 2 (lifecycle rule), Step 3 (Access application), Step 4 (Worker deploy), Step 5 (smoke test), Step 6 (rotating R2 token).

- [ ] **Step 2: Commit**

```bash
git add cockpit-worker/README.md
git commit -m "docs(worker): deploy guide for R2 + Access + Worker"
```

---

## Task 7: Self-review + verify

- [ ] **Step 1: Full test run**

```bash
cd cockpit-worker && bun run test
```

Expected: all tests pass.

- [ ] **Step 2: Typecheck**

```bash
cd cockpit-worker && bun run typecheck
```

- [ ] **Step 3: Verify deliverable**

- `cockpit-worker/` contains `src/index.ts`, `src/handler.ts`, `src/router.ts`, `src/access.ts` + their tests.
- `cockpit-worker/wrangler.toml` declares the R2 binding + ALLOWED_EMAILS.
- `cockpit-worker/r2-lifecycle.json` has the 30-day rule.
- `cockpit-worker/README.md` documents deploy.
- All tests pass. Typecheck clean.

Plan B complete. Plan C (PWA) can proceed independently.

---

## Spec coverage checklist

| Spec section | Implemented by |
|---|---|
| §7 Worker (JWT validation + R2 proxy) | Tasks 2, 3, 4 |
| §7 R2 lifecycle 30d | Task 5 |
| §Security (Access email allowlist, PutObject-only token) | Tasks 2, 3, 6 (README) |
| §Error handling (404 on missing, 403 on auth) | Task 3 |
| §Testing (unit + integration) | Tasks 1–3 |

## Out of scope (Plan C)

- Cloudflare Pages site / PWA UI
- Playwright E2E
- Service worker / offline cache
