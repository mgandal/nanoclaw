// Shared-secret bearer auth for nanoclaw bridge proxies.
//
// Contract:
//   - Token lives at $NANOCLAW_BRIDGE_TOKEN_FILE if set, else
//     ~/.cache/nanoclaw/bridge-token.
//   - File must exist with mode 0600. Any other mode → reject
//     (defense in depth against a token that accidentally got world-read).
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
    path.join(
      process.env.HOME || os.homedir(),
      '.cache',
      'nanoclaw',
      'bridge-token',
    )
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
  // Node lowercases header names on incoming requests, but callers /
  // tests may construct with any case — normalize here.
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
  // Constant-time compare — avoid timing oracle on the bearer.
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
