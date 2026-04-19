# B1 Server-Side Bearer Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the other half of B1. The client side shipped 2026-04-19: containers receive `NANOCLAW_BRIDGE_TOKEN` and forward `Authorization: Bearer <token>` on every HTTP call to host-side MCP bridges. This plan makes those bridges reject calls that lack a valid bearer.

**Architecture constraints discovered during plan-writing:**

1. **The bridge "proxies" are not HTTP-aware.** `~/.cache/qmd/proxy-resilient.mjs` is a raw TCP proxy that peeks at the first bytes only to route `/health` GET requests. Everything else is blind byte-piping from `0.0.0.0:8181` → `127.0.0.1:8182`. Same shape for the Apple Notes, Todoist, Calendar proxies (`~/.cache/{apple-notes,todoist,calendar}-mcp/proxy.mjs`). Supergateway itself has **no inbound auth option** (`--oauth2Bearer` is outbound only).

2. **The proxies must become HTTP-aware to enforce bearer.** Cleanest move: rewrite each `proxy.mjs` to parse HTTP requests, verify `Authorization: Bearer <token>` against a shared-secret file, and proxy to upstream on success. For the QMD proxy-resilient.mjs the change is larger because the existing dual-mode (TCP passthrough + HTTP /health) needs to become HTTP-only.

3. **Cross-process token sharing.** nanoclaw mints the token per-process. Bridges launched by launchd are separate processes. The shared source of truth has to live on disk — a 0600 file written by nanoclaw at startup and read by each bridge proxy at startup (with re-read on SIGHUP, or re-read lazily on each request for resilience).

4. **Rollout safety.** If any bridge enforces bearer before nanoclaw is writing the token file correctly, every container call breaks. Two-phase rollout: ship proxies that enforce only when `NANOCLAW_BRIDGE_AUTH=enforce` is set in their environment; default to `warn` (log missing bearer but forward anyway). Flip the flag per-bridge after verifying.

**Spec:** Finding B1 in `docs/superpowers/specs/2026-04-18-hardening-audit-design.md`. Client side shipped in `docs/superpowers/plans/2026-04-19-tier-b-remaining.md` task 7.

---

## File Structure

### New files
- `scripts/bridges/shared-auth.mjs` — ESM helper loaded by each proxy: `loadBridgeToken()`, `isAuthorized(req)`, `sendUnauthorized(res)`. Single source of truth for token-file path and auth logic.
- `scripts/bridges/install-proxy-updates.sh` — idempotent installer that copies the new proxy.mjs files into `~/.cache/{qmd,apple-notes-mcp,todoist-mcp,calendar-mcp}/` and reloads the launchd plists.

### Modified files
| File | Change |
|------|--------|
| `src/bridge-auth.ts` | Add `writeBridgeTokenFile()`; call it at nanoclaw startup. |
| `src/index.ts` | Invoke `writeBridgeTokenFile()` early in startup. |
| `~/.cache/qmd/proxy-resilient.mjs` | HTTP-aware proxy with bearer check. |
| `~/.cache/apple-notes-mcp/proxy.mjs` | Same. |
| `~/.cache/todoist-mcp/proxy.mjs` | Same. |
| `~/.cache/calendar-mcp/proxy.mjs` | Same. |

### Out of scope
- **Honcho** (Docker container, port 8010) — auth lives in its own config; Honcho supports bearer but routing to that is a separate project.
- **Ollama** (port 11434) — no auth today; turning on Ollama auth breaks every local tool that talks to it. Out of scope.
- **Hindsight** — has its own auth-layer project tracked separately.
- **SLACK_MCP_URL, MAIL_BRIDGE_URL** — only active in specific configs; retrofit later if used.

---

## Task 1: Shared-secret token file

**Goal:** nanoclaw writes the token to `~/.cache/nanoclaw/bridge-token` (mode 0600) at startup. Bridges read from the same path.

**Files:**
- Modify: `src/bridge-auth.ts` — add `writeBridgeTokenFile()`.
- Test: `src/bridge-auth.test.ts`.
- Modify: `src/index.ts` — call the writer at startup.

- [ ] **Step 1: Write the failing test.**

Append to `src/bridge-auth.test.ts`:

```typescript
describe('writeBridgeTokenFile', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    _resetBridgeToken();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes the token to ~/.cache/nanoclaw/bridge-token with mode 0600', () => {
    const expectedPath = path.join(tmpHome, '.cache', 'nanoclaw', 'bridge-token');
    writeBridgeTokenFile();
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath, 'utf-8')).toBe(getBridgeToken());
    expect(fs.statSync(expectedPath).mode & 0o777).toBe(0o600);
  });

  it('is idempotent (re-writing keeps the same token)', () => {
    writeBridgeTokenFile();
    const first = fs.readFileSync(
      path.join(tmpHome, '.cache', 'nanoclaw', 'bridge-token'),
      'utf-8',
    );
    writeBridgeTokenFile();
    const second = fs.readFileSync(
      path.join(tmpHome, '.cache', 'nanoclaw', 'bridge-token'),
      'utf-8',
    );
    expect(first).toBe(second);
  });
});
```

Import `fs`, `path`, `os` at the top of the file if not already.

- [ ] **Step 2: Run to verify failure.**

```bash
bun --bun vitest run src/bridge-auth.test.ts -t 'writeBridgeTokenFile'
```

Expected: FAIL — `writeBridgeTokenFile is not exported`.

- [ ] **Step 3: Implement.**

In `src/bridge-auth.ts`:

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';

// ... existing imports/code ...

function bridgeTokenFilePath(): string {
  return path.join(os.homedir(), '.cache', 'nanoclaw', 'bridge-token');
}

/**
 * Write the current bridge token to ~/.cache/nanoclaw/bridge-token with
 * mode 0600. Called at nanoclaw startup so launchd-spawned bridge proxies
 * can read the same token from disk (they don't share nanoclaw's env).
 */
export function writeBridgeTokenFile(): void {
  const filePath = bridgeTokenFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // Use write-then-chmod to be robust against umask filtering the open mode.
  fs.writeFileSync(filePath, getBridgeToken(), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}
```

- [ ] **Step 4: Verify pass.**

```bash
bun --bun vitest run src/bridge-auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Call from nanoclaw startup.**

In `src/index.ts`, near the other startup init calls (after `initDatabase()` but before any container spawn — look for the `'NanoClaw startup complete'` log to find the startup path):

```typescript
import { writeBridgeTokenFile } from './bridge-auth.js';
// ...
// B1: persist bridge token so launchd-spawned bridge proxies can read it.
writeBridgeTokenFile();
```

- [ ] **Step 6: Rebuild + manual smoke test.**

```bash
bun run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 3
ls -la ~/.cache/nanoclaw/bridge-token
# Expected: -rw------- (0600), non-empty
```

- [ ] **Step 7: Commit.**

```bash
git add src/bridge-auth.ts src/bridge-auth.test.ts src/index.ts
git commit -m "feat(security): persist bridge token to ~/.cache/nanoclaw/bridge-token (B1 server prep)"
```

---

## Task 2: Shared proxy auth helper module

**Goal:** one file — `scripts/bridges/shared-auth.mjs` — exports the bearer verify + 401 helpers. Every bridge proxy imports it.

**Files:**
- Create: `scripts/bridges/shared-auth.mjs`.
- Create: `scripts/bridges/tests/test-shared-auth.mjs` (or equivalent; plain Node test if no framework is wired).

**Design:** lazy-read the token file on each request (not cached at start) so bridge proxies don't need SIGHUP / restart when nanoclaw restarts and mints a fresh token. Path resolution: `$HOME/.cache/nanoclaw/bridge-token`. Mode enforcement: reject mode != 0600 (defense in depth).

- [ ] **Step 1: Write a minimal test harness.**

Create `scripts/bridges/tests/test-shared-auth.mjs`:

```javascript
// Minimal node test — no framework. Run with: node scripts/bridges/tests/test-shared-auth.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAuthorized, BRIDGE_AUTH_HEADER_NAME } from '../shared-auth.mjs';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-auth-test-'));
  const tokenFile = path.join(tmp, 'bridge-token');
  fs.writeFileSync(tokenFile, 'test-token-1234567890-abcdef', { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  return { tmp, tokenFile };
}

function fakeReq(headers) {
  return { headers };
}

const { tmp, tokenFile } = setup();
process.env.NANOCLAW_BRIDGE_TOKEN_FILE = tokenFile;

// 1. Accepts a matching Bearer token
assert.strictEqual(
  isAuthorized(fakeReq({ authorization: 'Bearer test-token-1234567890-abcdef' })),
  true,
  'valid bearer should be authorized',
);

// 2. Rejects a mismatched Bearer token
assert.strictEqual(
  isAuthorized(fakeReq({ authorization: 'Bearer wrong' })),
  false,
  'wrong bearer should be rejected',
);

// 3. Rejects no Authorization header
assert.strictEqual(
  isAuthorized(fakeReq({})),
  false,
  'missing header should be rejected',
);

// 4. Case-insensitive header lookup
assert.strictEqual(
  isAuthorized(fakeReq({ Authorization: 'Bearer test-token-1234567890-abcdef' })),
  true,
  'Authorization capitalized should work',
);

// 5. Token file with wrong mode rejects everything (defense in depth)
fs.chmodSync(tokenFile, 0o644);
assert.strictEqual(
  isAuthorized(fakeReq({ authorization: 'Bearer test-token-1234567890-abcdef' })),
  false,
  'wrong-mode token file should reject',
);
fs.chmodSync(tokenFile, 0o600);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[shared-auth] all tests passed');
```

- [ ] **Step 2: Run — expect module-not-found.**

```bash
node scripts/bridges/tests/test-shared-auth.mjs
```

Expected: `Cannot find module '../shared-auth.mjs'`.

- [ ] **Step 3: Implement the helper.**

Create `scripts/bridges/shared-auth.mjs`:

```javascript
// Shared-secret bearer auth for nanoclaw bridge proxies.
//
// Contract:
//   - Token lives at $NANOCLAW_BRIDGE_TOKEN_FILE if set, else
//     ~/.cache/nanoclaw/bridge-token.
//   - File must exist with mode 0600. Any other mode → reject (defense
//     in depth against a token file that accidentally got world-read).
//   - Token is read lazily per request so the proxy stays correct across
//     nanoclaw restarts that mint a fresh token.
//
// Enforcement mode: set NANOCLAW_BRIDGE_AUTH=enforce in the bridge's
// environment to hard-reject. Any other value (default) only logs
// missing/wrong bearers. This is the rollout safety valve — flip to
// enforce per-bridge after verifying clients forward the token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRIDGE_AUTH_HEADER_NAME = 'authorization';

function tokenFilePath() {
  return (
    process.env.NANOCLAW_BRIDGE_TOKEN_FILE ||
    path.join(os.homedir(), '.cache', 'nanoclaw', 'bridge-token')
  );
}

function readExpectedToken() {
  const p = tokenFilePath();
  try {
    const st = fs.statSync(p);
    if ((st.mode & 0o777) !== 0o600) return null;
    return fs.readFileSync(p, 'utf-8').trim();
  } catch {
    return null;
  }
}

function extractBearer(req) {
  const headers = req.headers || {};
  // Node lowercases header names on incoming requests, but tests may
  // construct with any case — normalize here.
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === BRIDGE_AUTH_HEADER_NAME) {
      const v = headers[k];
      if (typeof v !== 'string') return null;
      const m = v.match(/^Bearer\s+(.+)$/i);
      return m ? m[1] : null;
    }
  }
  return null;
}

export function isAuthorized(req) {
  const expected = readExpectedToken();
  if (!expected) return false; // no token on disk or wrong mode → reject
  const got = extractBearer(req);
  if (!got) return false;
  if (got.length !== expected.length) return false;
  // constant-time compare — avoid timing oracle on the bearer.
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function enforcementMode() {
  return process.env.NANOCLAW_BRIDGE_AUTH === 'enforce' ? 'enforce' : 'warn';
}

export function sendUnauthorized(res) {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('WWW-Authenticate', 'Bearer realm="nanoclaw-bridge"');
  res.end(JSON.stringify({ error: 'unauthorized' }));
}
```

- [ ] **Step 4: Run tests.**

```bash
node scripts/bridges/tests/test-shared-auth.mjs
```

Expected: `[shared-auth] all tests passed`.

- [ ] **Step 5: Commit.**

```bash
git add scripts/bridges/shared-auth.mjs scripts/bridges/tests/test-shared-auth.mjs
git commit -m "feat(security): shared bridge-auth helper for bridge proxies (B1 server prep)"
```

---

## Task 3: HTTP-aware Apple Notes / Todoist / Calendar proxy

**Files:**
- Create: `scripts/bridges/proxy-template.mjs` — generic "TCP → HTTP-aware with bearer check" proxy parameterized by listen port + target port.
- Modify: `~/.cache/apple-notes-mcp/proxy.mjs`, `~/.cache/todoist-mcp/proxy.mjs`, `~/.cache/calendar-mcp/proxy.mjs` — replace with the template.

**Design:** the three proxies are structurally identical (TCP passthrough, different port pair). One template with a small config block per bridge. The template accepts POST/GET HTTP requests, verifies bearer, forwards to upstream via `http.request`. Non-HTTP bytes on the socket are rejected (we know these upstreams are Streamable HTTP).

- [ ] **Step 1: Write a node test that exercises the template.**

Create `scripts/bridges/tests/test-proxy-template.mjs`:

```javascript
// Spins up a fake upstream HTTP server, starts the proxy template
// pointing at it, and verifies:
//   - request with valid bearer forwards
//   - request without bearer gets 401 in enforce mode
//   - request without bearer still forwards in warn mode
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBridgeProxy } from '../proxy-template.mjs';

async function startUpstream(port) {
  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

function requestThroughProxy(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ hello: 'world' }));
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-tmpl-test-'));
const tokenFile = path.join(tmp, 'bridge-token');
fs.writeFileSync(tokenFile, 'proxy-test-token-0123456789abcdef', { mode: 0o600 });
fs.chmodSync(tokenFile, 0o600);
process.env.NANOCLAW_BRIDGE_TOKEN_FILE = tokenFile;

const upstreamPort = 18500;
const proxyPort = 18501;
const upstream = await startUpstream(upstreamPort);

// Enforce mode: missing bearer → 401
process.env.NANOCLAW_BRIDGE_AUTH = 'enforce';
const enforceProxy = await createBridgeProxy({
  listenPort: proxyPort,
  targetHost: '127.0.0.1',
  targetPort: upstreamPort,
  serviceName: 'test-enforce',
});
const missing = await requestThroughProxy(proxyPort, {});
assert.strictEqual(missing.status, 401, 'enforce mode missing bearer should 401');
const valid = await requestThroughProxy(proxyPort, {
  Authorization: 'Bearer proxy-test-token-0123456789abcdef',
});
assert.strictEqual(valid.status, 200, 'enforce mode valid bearer should forward');
enforceProxy.close();

// Warn mode: missing bearer still forwards
process.env.NANOCLAW_BRIDGE_AUTH = 'warn';
const warnProxy = await createBridgeProxy({
  listenPort: proxyPort + 1,
  targetHost: '127.0.0.1',
  targetPort: upstreamPort,
  serviceName: 'test-warn',
});
const warnMissing = await requestThroughProxy(proxyPort + 1, {});
assert.strictEqual(warnMissing.status, 200, 'warn mode missing bearer should still forward');
warnProxy.close();

upstream.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('[proxy-template] all tests passed');
```

- [ ] **Step 2: Run — expect module-not-found.**

```bash
node scripts/bridges/tests/test-proxy-template.mjs
```

- [ ] **Step 3: Implement the template.**

Create `scripts/bridges/proxy-template.mjs`:

```javascript
import http from 'node:http';
import { isAuthorized, sendUnauthorized, enforcementMode } from './shared-auth.mjs';

function log(level, serviceName, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, service: serviceName, msg, ...extra };
  console.error(JSON.stringify(entry));
}

/**
 * Start an HTTP proxy on listenPort that forwards to targetHost:targetPort.
 * Bearer enforcement mode:
 *   - 'enforce' → reject with 401 on missing/invalid Bearer
 *   - 'warn'    → log and forward anyway (rollout safety)
 *
 * Returns the Node http.Server so callers can close() it in tests. A real
 * launchd-spawned bridge won't call close — it runs until SIGTERM.
 */
export async function createBridgeProxy({
  listenPort,
  targetHost,
  targetPort,
  serviceName,
}) {
  const server = http.createServer((clientReq, clientRes) => {
    // Health endpoint — no auth required, short-circuits the proxy.
    if (clientReq.url === '/health') {
      clientRes.statusCode = 200;
      clientRes.setHeader('Content-Type', 'application/json');
      clientRes.end(JSON.stringify({ proxy: 'up', service: serviceName }));
      return;
    }

    const mode = enforcementMode();
    const ok = isAuthorized(clientReq);
    if (!ok) {
      if (mode === 'enforce') {
        log('warn', serviceName, 'unauthorized request rejected', {
          url: clientReq.url,
          method: clientReq.method,
        });
        sendUnauthorized(clientRes);
        return;
      }
      // warn mode — forward but log
      log('warn', serviceName, 'unauthorized request (warn mode; forwarding)', {
        url: clientReq.url,
      });
    }

    const upstreamReq = http.request(
      {
        hostname: targetHost,
        port: targetPort,
        path: clientReq.url,
        method: clientReq.method,
        headers: clientReq.headers,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );

    upstreamReq.on('error', (err) => {
      log('error', serviceName, 'upstream error', { error: err.message });
      if (!clientRes.headersSent) {
        clientRes.statusCode = 502;
        clientRes.end(JSON.stringify({ error: 'bad gateway' }));
      }
    });

    clientReq.pipe(upstreamReq);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '0.0.0.0', () => {
      server.off('error', reject);
      log('info', serviceName, 'proxy listening', {
        listen: listenPort,
        target: `${targetHost}:${targetPort}`,
        mode: enforcementMode(),
      });
      resolve();
    });
  });

  return server;
}

// If invoked directly (as the launchd script), read config from env.
// Each bridge's proxy.mjs becomes a thin wrapper:
//   import { createBridgeProxy } from '../../scripts/bridges/proxy-template.mjs';
//   await createBridgeProxy({ listenPort: 8184, targetHost: '127.0.0.1', targetPort: 8183, serviceName: 'apple-notes' });
```

- [ ] **Step 4: Run tests.**

```bash
node scripts/bridges/tests/test-proxy-template.mjs
```

Expected: `[proxy-template] all tests passed`.

- [ ] **Step 5: Commit (template only; no live bridge wired yet).**

```bash
git add scripts/bridges/proxy-template.mjs scripts/bridges/tests/test-proxy-template.mjs
git commit -m "feat(security): bridge proxy template with optional bearer enforcement (B1)"
```

---

## Task 4: Deploy to Apple Notes / Todoist / Calendar bridges (warn mode first)

**Files:**
- Replace: `~/.cache/apple-notes-mcp/proxy.mjs`, `~/.cache/todoist-mcp/proxy.mjs`, `~/.cache/calendar-mcp/proxy.mjs`.
- Create: `scripts/bridges/install-proxy-updates.sh` — installs the new proxies from the repo into the cache dirs.

**Design note on reload:** each bridge's launchd plist runs a `start.sh` that spawns supergateway + `proxy.mjs` as children. The launchd job `KeepAlive=true`s them. To roll out a new proxy.mjs we `kickstart -k` the plist — launchd kills both children and restarts.

- [ ] **Step 1: Write the install script.**

`scripts/bridges/install-proxy-updates.sh`:

```bash
#!/bin/bash
# Install bearer-enforcing proxy.mjs files into each bridge's cache dir,
# then kickstart the launchd job to pick them up. Idempotent — re-running
# overwrites with the same content and restarts the jobs.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/proxy-template.mjs"
SHARED_AUTH="$SCRIPT_DIR/shared-auth.mjs"

if [ ! -f "$TEMPLATE" ] || [ ! -f "$SHARED_AUTH" ]; then
  echo "ERROR: proxy-template.mjs or shared-auth.mjs missing" >&2
  exit 1
fi

# Each bridge: (cache_dir, listen_port, target_port, service_name, launchd_label)
BRIDGES=(
  "$HOME/.cache/apple-notes-mcp|8184|8183|apple-notes|com.apple-notes-mcp"
  "$HOME/.cache/todoist-mcp|8186|8185|todoist|com.todoist-mcp"
  "$HOME/.cache/calendar-mcp|8188|8187|calendar|com.calendar-mcp"
)

for entry in "${BRIDGES[@]}"; do
  IFS='|' read -r cache_dir listen_port target_port service launchd_label <<< "$entry"
  if [ ! -d "$cache_dir" ]; then
    echo "SKIP: $cache_dir does not exist"
    continue
  fi
  echo "== $service =="
  # Copy shared auth + template into the bridge dir so the launchd script
  # doesn't need a project-root path (which could break if the repo moves).
  cp -f "$SHARED_AUTH" "$cache_dir/shared-auth.mjs"
  cp -f "$TEMPLATE" "$cache_dir/proxy-template.mjs"

  # Write the bridge-specific entrypoint.
  cat > "$cache_dir/proxy.mjs" <<EOF
// Auto-installed by scripts/bridges/install-proxy-updates.sh
// Bridge: $service (listen $listen_port → target 127.0.0.1:$target_port)
import { createBridgeProxy } from './proxy-template.mjs';
await createBridgeProxy({
  listenPort: $listen_port,
  targetHost: '127.0.0.1',
  targetPort: $target_port,
  serviceName: '$service',
});
EOF

  # Restart the launchd job so the new proxy binds the port.
  launchctl kickstart -k "gui/$(id -u)/$launchd_label"
  echo "  kickstarted $launchd_label"
done

echo
echo "Installed. Bridges start in WARN mode — missing bearers are logged but forwarded."
echo "To enforce: set NANOCLAW_BRIDGE_AUTH=enforce in each launchd plist and reload."
```

- [ ] **Step 2: Run the installer.**

```bash
bash scripts/bridges/install-proxy-updates.sh
```

Expected output: "== apple-notes ==" / kickstarted / "== todoist ==" / kickstarted / "== calendar ==" / kickstarted.

- [ ] **Step 3: Smoke-test that each bridge still works in warn mode.**

Send a message to any group that uses Apple Notes / Todoist / Calendar tools. Verify the agent can still call them. Check each bridge's stderr log for `"proxy listening"` with `mode: warn`:

```bash
tail ~/.cache/apple-notes-mcp/launchd-stderr.log
tail ~/.cache/todoist-mcp/launchd-stderr.log
tail ~/.cache/calendar-mcp/launchd-stderr.log
```

- [ ] **Step 4: Commit.**

```bash
git add scripts/bridges/install-proxy-updates.sh
git commit -m "feat(security): installer for bridge bearer-auth proxies (B1 rollout, warn mode)"
```

---

## Task 5: QMD proxy — HTTP-aware rewrite

**Files:**
- Modify: `~/.cache/qmd/proxy-resilient.mjs` (or replace with a QMD-flavored variant using the template).

**Why separate:** the existing QMD proxy is dual-mode (TCP passthrough + HTTP /health endpoint). The template is HTTP-only. QMD's upstream is also Streamable HTTP so pure HTTP is fine — but the existing code has resilience features (health-check polling, state file writes for the memory-services monitor) that must be preserved.

**Design:** take the template, add back the health-polling + state-file writes. Keep the same listen port (8181) and target (127.0.0.1:8182). Same enforcement mode semantics.

- [ ] **Step 1: Write a node test for the QMD flavor.**

`scripts/bridges/tests/test-qmd-proxy.mjs`:

```javascript
// Same shape as the template test, but also verifies:
// - /health returns 200 + JSON with upstream status
// - state file at ~/.cache/memory-services/proxy-state.json gets written
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createQmdProxy } from '../qmd-proxy.mjs';

// ... same setup as test-proxy-template.mjs ...
// plus:
// 1. GET /health returns 200 with { upstream: 'up' | 'down' }
// 2. Without a running upstream, /health returns 503
// 3. With running upstream, state file has service=qmd-proxy entry

console.log('[qmd-proxy] all tests passed');
```

(Full test mirrors Task 3's style; stub in the specifics during implementation.)

- [ ] **Step 2: Implement `scripts/bridges/qmd-proxy.mjs`.**

Start from the template + copy the health-check / state-file code from the existing `~/.cache/qmd/proxy-resilient.mjs` (lines ~40-95 in that file). The only substantive change vs. the template is (a) the health endpoint responds with upstream status not just "proxy up", (b) the upstream reachability check runs on a timer and updates a state file.

- [ ] **Step 3: Test + install.**

```bash
node scripts/bridges/tests/test-qmd-proxy.mjs
cp scripts/bridges/qmd-proxy.mjs ~/.cache/qmd/proxy-resilient.mjs
cp scripts/bridges/shared-auth.mjs ~/.cache/qmd/shared-auth.mjs
launchctl kickstart -k gui/$(id -u)/com.qmd-proxy
```

- [ ] **Step 4: Smoke-test QMD.**

Either via the statusbar ("QMD: UP (8181)") or curl:

```bash
curl -s http://localhost:8181/health
# Expected: {"proxy":"up","upstream":"up", ...}
```

- [ ] **Step 5: Commit.**

```bash
git add scripts/bridges/qmd-proxy.mjs scripts/bridges/tests/test-qmd-proxy.mjs
git commit -m "feat(security): QMD proxy with bearer enforcement (B1 rollout, warn mode)"
```

---

## Task 6: Flip each bridge to enforce mode

**Files:**
- Modify: `~/Library/LaunchAgents/com.qmd-proxy.plist`, `~/Library/LaunchAgents/com.apple-notes-mcp.plist`, `~/Library/LaunchAgents/com.todoist-mcp.plist`, `~/Library/LaunchAgents/com.calendar-mcp.plist`.

**Rollout order:** one bridge at a time. After each flip, send a message that uses that bridge's tools and verify agent success. If the agent reports a 401, something's wrong client-side — roll the plist back, debug, re-flip.

- [ ] **Step 1: Add `NANOCLAW_BRIDGE_AUTH=enforce` to Apple Notes plist** (smallest blast radius — if it breaks, agents lose notes lookup but everything else keeps working).

Edit `~/Library/LaunchAgents/com.apple-notes-mcp.plist` to add an `EnvironmentVariables` dict before `</dict>`:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>NANOCLAW_BRIDGE_AUTH</key>
    <string>enforce</string>
</dict>
```

Reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.apple-notes-mcp.plist
launchctl load   ~/Library/LaunchAgents/com.apple-notes-mcp.plist
```

- [ ] **Step 2: Smoke-test.** Send a message asking an agent to search Apple Notes. Verify the query succeeds. Check stderr for `mode: enforce`.

- [ ] **Step 3: Verify the negative case.** From the host (not a container), without a bearer:

```bash
curl -i http://localhost:8184/mcp -X POST -H 'Content-Type: application/json' -d '{}'
# Expected: HTTP/1.1 401 Unauthorized
```

- [ ] **Step 4: Repeat for Todoist, Calendar, QMD.**

One bridge per commit / per verification pass. Rollback is: remove the EnvironmentVariables dict + reload.

- [ ] **Step 5: Commit.**

Each plist edit gets its own commit for clean rollback history:

```bash
git add ~/Library/LaunchAgents/com.apple-notes-mcp.plist
# (or symlink/track under the repo — these live outside the repo today)
```

**Note:** the plists live outside the repo. Track them inline in a documentation file instead, or accept that these changes aren't version-controlled. The plan recommends: add a new file `docs/launchd-plists-snapshot.md` that records the expected plist contents post-B1 so an operator can restore them by hand if lost.

- [ ] **Step 6: Create the snapshot doc.**

`docs/launchd-plists-snapshot.md`:

```markdown
# launchd plist snapshots (bridge services)

These plists live in `~/Library/LaunchAgents/` — outside the repo.
Recorded here so an operator can restore them by hand. Post-B1, each
bridge proxy's plist declares `NANOCLAW_BRIDGE_AUTH=enforce`.

## com.apple-notes-mcp.plist

[content]

## com.todoist-mcp.plist

[content]

## com.calendar-mcp.plist

[content]

## com.qmd-proxy.plist

[content]
```

- [ ] **Step 7: Commit.**

```bash
git add docs/launchd-plists-snapshot.md
git commit -m "docs(security): record plist snapshots post-B1 enforce mode"
```

---

## Task 7: Verify end-to-end

- [ ] **Step 1: Negative test per bridge.**

For each bridge, `curl` the endpoint without a bearer and confirm 401:

```bash
for p in 8181 8184 8186 8188; do
  echo "port $p:"
  curl -s -i "http://localhost:$p/mcp" -X POST -H 'Content-Type: application/json' -d '{}' | head -1
done
```

Expected: each prints `HTTP/1.1 401 Unauthorized`.

- [ ] **Step 2: Positive test per bridge.**

```bash
TOKEN=$(cat ~/.cache/nanoclaw/bridge-token)
for p in 8181 8184 8186 8188; do
  echo "port $p:"
  curl -s -i "http://localhost:$p/health" -H "Authorization: Bearer $TOKEN" | head -1
done
```

Expected: each prints `HTTP/1.1 200 OK`.

- [ ] **Step 3: Agent round-trip.**

Send a message that exercises each bridge (Apple Notes search, Todoist task add, Calendar lookup, QMD query). Verify all succeed.

- [ ] **Step 4: Update audit spec + SECURITY.md.**

Replace B1's "Status: client side resolved" line with "Status: resolved" and cite this plan. Update SECURITY.md bullet.

- [ ] **Step 5: Final commit.**

```bash
git add docs/superpowers/specs/2026-04-18-hardening-audit-design.md docs/SECURITY.md
git commit -m "docs(security): mark B1 fully resolved (client + server side)"
```

---

## Self-Review

**1. Spec coverage.** B1 client side already shipped. This plan ships server side: nanoclaw writes shared-secret file, proxies verify bearer, warn → enforce rollout per bridge.

**2. Placeholder scan.** One: the QMD proxy test in Task 5 Step 1 is sketched, not full. Executor should mirror the template test and add health-polling / state-file assertions. Everything else (paths, ports, plist label names) is concrete.

**3. Risk.** Rolling out `enforce` before every container in flight has picked up the new client-side code breaks those in-flight sessions. Mitigation: the warn mode stays on until each bridge is individually flipped, and the flips come after nanoclaw has been rebuilt + restarted and at least one round of messaging has exercised each bridge successfully in warn mode.

**Known follow-ups (NOT part of this plan):**
- **Honcho, Ollama, Hindsight** enforcement — different architectures, separate plans.
- **Per-group tokens** — would require a mint service; disproportionate for single-user.
- **Token rotation on restart** — today the token changes every nanoclaw restart; bridges re-read it lazily so they follow. A persistent-across-restarts token (stored in keychain) is a nice-to-have but not required.
- **Auditing / rate-limiting** at the proxy layer — future work.
