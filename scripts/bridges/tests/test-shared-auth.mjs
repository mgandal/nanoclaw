// Minimal node test — no framework. Run with:
//   node scripts/bridges/tests/test-shared-auth.mjs
//
// Exit code 0 on success, non-zero on failure.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isAuthorized,
  enforcementMode,
  sendUnauthorized,
  BRIDGE_AUTH_HEADER_NAME,
} from '../shared-auth.mjs';

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

function fakeRes() {
  const calls = { statusCode: null, headers: {}, body: '' };
  return {
    calls,
    set statusCode(v) {
      calls.statusCode = v;
    },
    get statusCode() {
      return calls.statusCode;
    },
    setHeader(name, value) {
      calls.headers[name] = value;
    },
    end(body) {
      calls.body = body;
    },
  };
}

const { tmp, tokenFile } = setup();
process.env.NANOCLAW_BRIDGE_TOKEN_FILE = tokenFile;

// 1. Accepts a matching Bearer token.
assert.strictEqual(
  isAuthorized(
    fakeReq({ authorization: 'Bearer test-token-1234567890-abcdef' }),
  ),
  true,
  'valid bearer should be authorized',
);

// 2. Rejects a mismatched Bearer token.
assert.strictEqual(
  isAuthorized(fakeReq({ authorization: 'Bearer wrong' })),
  false,
  'wrong bearer should be rejected',
);

// 3. Rejects no Authorization header.
assert.strictEqual(
  isAuthorized(fakeReq({})),
  false,
  'missing header should be rejected',
);

// 4. Case-insensitive header lookup (real-world proxies may pass
// headers with any capitalization).
assert.strictEqual(
  isAuthorized(
    fakeReq({ Authorization: 'Bearer test-token-1234567890-abcdef' }),
  ),
  true,
  'Authorization capitalized should work',
);

// 5. Token file with wrong mode rejects everything (defense in depth).
fs.chmodSync(tokenFile, 0o644);
assert.strictEqual(
  isAuthorized(
    fakeReq({ authorization: 'Bearer test-token-1234567890-abcdef' }),
  ),
  false,
  'wrong-mode token file should reject',
);
fs.chmodSync(tokenFile, 0o600);

// 6. Token file missing rejects everything.
const savedToken = fs.readFileSync(tokenFile);
fs.unlinkSync(tokenFile);
assert.strictEqual(
  isAuthorized(
    fakeReq({ authorization: 'Bearer test-token-1234567890-abcdef' }),
  ),
  false,
  'missing token file should reject',
);
fs.writeFileSync(tokenFile, savedToken, { mode: 0o600 });
fs.chmodSync(tokenFile, 0o600);

// 7. enforcementMode reads env var.
delete process.env.NANOCLAW_BRIDGE_AUTH;
assert.strictEqual(enforcementMode(), 'warn', 'default should be warn');
process.env.NANOCLAW_BRIDGE_AUTH = 'enforce';
assert.strictEqual(
  enforcementMode(),
  'enforce',
  'enforce env should switch mode',
);
delete process.env.NANOCLAW_BRIDGE_AUTH;

// 8. sendUnauthorized writes 401 + WWW-Authenticate.
const res = fakeRes();
sendUnauthorized(res);
assert.strictEqual(res.calls.statusCode, 401);
assert.strictEqual(
  res.calls.headers['WWW-Authenticate'],
  'Bearer realm="nanoclaw-bridge"',
);
assert.match(res.calls.body, /unauthorized/);

// 9. Header name export is lowercase.
assert.strictEqual(BRIDGE_AUTH_HEADER_NAME, 'authorization');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[shared-auth] all 9 tests passed');
