// HTTP-aware bridge proxy template.
//
// Each launchd-spawned bridge (Apple Notes, Todoist, Calendar, ...)
// uses this to wrap its supergateway-on-localhost with a
// bearer-auth-checking proxy that listens on 0.0.0.0 (reachable from
// Apple Container VMs via the host gateway IP).
//
// Rollout modes (controlled by NANOCLAW_BRIDGE_AUTH):
//   - 'enforce' → reject with 401 on missing/invalid Bearer
//   - default / anything else → log and forward anyway (warn mode)
//
// /health short-circuits without auth so monitoring keeps working.

import http from 'node:http';
import {
  isAuthorized,
  sendUnauthorized,
  enforcementMode,
} from './shared-auth.mjs';

function log(level, serviceName, msg, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: serviceName,
    msg,
    ...extra,
  };
  console.error(JSON.stringify(entry));
}

/**
 * Start an HTTP proxy on listenPort that forwards to
 * targetHost:targetPort. Returns the Node http.Server so callers can
 * close() it in tests. A real launchd-spawned bridge won't call
 * close — it runs until SIGTERM.
 */
export function createBridgeProxy({
  listenPort,
  targetHost,
  targetPort,
  serviceName,
}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((clientReq, clientRes) => {
      // Health endpoint — no auth required. Short-circuits the proxy
      // so launchd / monitoring can check the proxy is up without
      // forwarding the request upstream.
      if (clientReq.url === '/health') {
        clientRes.statusCode = 200;
        clientRes.setHeader('Content-Type', 'application/json');
        clientRes.end(
          JSON.stringify({
            proxy: 'up',
            service: serviceName,
            mode: enforcementMode(),
          }),
        );
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
        // warn mode — forward but log. This is the rollout-safety
        // path: once all clients are sending the bearer, flip the
        // plist env to NANOCLAW_BRIDGE_AUTH=enforce and these calls
        // will 401 instead.
        log(
          'warn',
          serviceName,
          'unauthorized request (warn mode; forwarding)',
          { url: clientReq.url },
        );
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
          clientRes.writeHead(
            upstreamRes.statusCode || 502,
            upstreamRes.headers,
          );
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

    server.once('error', reject);
    server.listen(listenPort, '0.0.0.0', () => {
      server.off('error', reject);
      log('info', serviceName, 'proxy listening', {
        listen: listenPort,
        target: `${targetHost}:${targetPort}`,
        mode: enforcementMode(),
      });
      resolve(server);
    });
  });
}
