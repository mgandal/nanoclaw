// QMD bridge proxy — HTTP-aware, bearer-auth, with the resilience
// features the original proxy-resilient.mjs had (upstream health
// polling + state-file writes the memory-services monitor reads).
//
// The basic template (proxy-template.mjs) handles auth + forwarding;
// this file wraps it to add the polling loop and a richer /health
// response that includes upstream status.
//
// Structure:
//   - listen on 0.0.0.0:LISTEN_PORT (containers reach via host gateway IP)
//   - forward POSTs to 127.0.0.1:TARGET_PORT (QMD server, localhost-bound)
//   - /health returns JSON with upstream up/down + last transition
//   - background healthCheck() runs every 10s, updates state file

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  isAuthorized,
  sendUnauthorized,
  enforcementMode,
} from './shared-auth.mjs';

const LISTEN_PORT = 8181;
const TARGET_HOST = 'localhost';
const TARGET_PORT = 8182;
const HEALTH_URL = `http://${TARGET_HOST}:${TARGET_PORT}/health`;
const HEALTH_CHECK_INTERVAL = 10_000;
const HOME = process.env.HOME || '';
const STATE_FILE = path.join(HOME, '.cache/memory-services/proxy-state.json');
const LOG_FILE = path.join(HOME, '.cache/qmd/proxy-resilient.log');
const SERVICE_NAME = 'qmd-proxy';

let upstreamUp = false;
let lastStateChange = new Date().toISOString();

function log(level, msg, extra = {}) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    msg,
    ...extra,
  });
  try {
    fs.appendFileSync(LOG_FILE, entry + '\n');
  } catch {
    /* best-effort */
  }
  if (level === 'error' || level === 'warn') console.error(entry);
}

function updateState(newUp) {
  if (newUp === upstreamUp) return;
  upstreamUp = newUp;
  lastStateChange = new Date().toISOString();
  log('info', `upstream transition: ${upstreamUp ? 'up' : 'down'}`);
  try {
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      /* first write */
    }
    state[SERVICE_NAME] = {
      status: upstreamUp ? 'up' : 'down',
      changed: lastStateChange,
    };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log('warn', 'failed to write state file', { error: e.message });
  }
}

function healthCheck() {
  const req = http.get(HEALTH_URL, { timeout: 5000 }, (res) => {
    res.resume();
    updateState(res.statusCode === 200);
  });
  req.on('error', () => updateState(false));
  req.on('timeout', () => {
    req.destroy();
    updateState(false);
  });
}

function sendRichHealth(res) {
  const status = upstreamUp ? 200 : 503;
  const body = JSON.stringify({
    proxy: 'up',
    service: SERVICE_NAME,
    upstream: upstreamUp ? 'up' : 'down',
    upstream_target: `${TARGET_HOST}:${TARGET_PORT}`,
    last_state_change: lastStateChange,
    mode: enforcementMode(),
  });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

const server = http.createServer((clientReq, clientRes) => {
  // /health — no auth, richer response than the template's default.
  if (clientReq.url === '/health') {
    sendRichHealth(clientRes);
    return;
  }

  const mode = enforcementMode();
  const ok = isAuthorized(clientReq);
  if (!ok) {
    if (mode === 'enforce') {
      log('warn', 'unauthorized request rejected', {
        url: clientReq.url,
        method: clientReq.method,
      });
      sendUnauthorized(clientRes);
      return;
    }
    log('warn', 'unauthorized request (warn mode; forwarding)', {
      url: clientReq.url,
    });
  }

  const upstreamReq = http.request(
    {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
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
    log('error', 'upstream error', { error: err.message });
    if (!clientRes.headersSent) {
      clientRes.statusCode = 502;
      clientRes.end(JSON.stringify({ error: 'bad gateway' }));
    }
  });

  clientReq.pipe(upstreamReq);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(
    `QMD resilient proxy on 0.0.0.0:${LISTEN_PORT} → ${TARGET_HOST}:${TARGET_PORT} (mode=${enforcementMode()})`,
  );
  log('info', 'proxy started', {
    listen: LISTEN_PORT,
    target: TARGET_PORT,
    mode: enforcementMode(),
  });
  healthCheck();
  setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
});
