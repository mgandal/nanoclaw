// Spins up a fake upstream HTTP server, starts the proxy template
// pointing at it, and verifies:
//   - /health short-circuits without auth
//   - request with valid bearer forwards + response body intact
//   - enforce mode + missing bearer → 401
//   - warn mode + missing bearer → still forwards

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBridgeProxy } from '../proxy-template.mjs';

function startUpstream(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            url: req.url,
            method: req.method,
            echoedBody: body,
          }),
        );
      });
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function requestThroughProxy(port, pathArg, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathArg,
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-tmpl-test-'));
const tokenFile = path.join(tmp, 'bridge-token');
const TOKEN = 'proxy-test-token-0123456789abcdef0123456789abcdef';
fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
fs.chmodSync(tokenFile, 0o600);
process.env.NANOCLAW_BRIDGE_TOKEN_FILE = tokenFile;

const upstreamPort = 18500;
const enforcePort = 18501;
const warnPort = 18502;
const upstream = await startUpstream(upstreamPort);

async function run() {
  // Enforce mode: missing bearer → 401.
  process.env.NANOCLAW_BRIDGE_AUTH = 'enforce';
  const enforceProxy = await createBridgeProxy({
    listenPort: enforcePort,
    targetHost: '127.0.0.1',
    targetPort: upstreamPort,
    serviceName: 'test-enforce',
  });

  // 1. /health is always allowed, no auth required.
  const healthRes = await requestThroughProxy(enforcePort, '/health', {});
  assert.strictEqual(
    healthRes.status,
    200,
    '/health should succeed without auth',
  );
  assert.match(healthRes.body, /test-enforce/);

  // 2. Missing bearer → 401 in enforce mode.
  const missing = await requestThroughProxy(
    enforcePort,
    '/mcp',
    {},
    JSON.stringify({ x: 1 }),
  );
  assert.strictEqual(
    missing.status,
    401,
    'enforce mode missing bearer should 401',
  );
  assert.match(missing.body, /unauthorized/);

  // 3. Wrong bearer → 401 in enforce mode.
  const wrong = await requestThroughProxy(
    enforcePort,
    '/mcp',
    { Authorization: 'Bearer wrong-token' },
    JSON.stringify({ x: 1 }),
  );
  assert.strictEqual(wrong.status, 401, 'enforce mode wrong bearer should 401');

  // 4. Valid bearer → forwards + body echoes through.
  const valid = await requestThroughProxy(
    enforcePort,
    '/mcp',
    { Authorization: `Bearer ${TOKEN}` },
    JSON.stringify({ x: 1 }),
  );
  assert.strictEqual(
    valid.status,
    200,
    'enforce mode valid bearer should forward',
  );
  const parsed = JSON.parse(valid.body);
  assert.strictEqual(parsed.url, '/mcp');
  assert.strictEqual(parsed.echoedBody, '{"x":1}');

  enforceProxy.close();

  // Warn mode: missing bearer still forwards.
  process.env.NANOCLAW_BRIDGE_AUTH = 'warn';
  const warnProxy = await createBridgeProxy({
    listenPort: warnPort,
    targetHost: '127.0.0.1',
    targetPort: upstreamPort,
    serviceName: 'test-warn',
  });
  const warnMissing = await requestThroughProxy(
    warnPort,
    '/mcp',
    {},
    JSON.stringify({ x: 2 }),
  );
  assert.strictEqual(
    warnMissing.status,
    200,
    'warn mode missing bearer should still forward',
  );
  warnProxy.close();
}

try {
  await run();
  console.log('[proxy-template] all tests passed');
} finally {
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
