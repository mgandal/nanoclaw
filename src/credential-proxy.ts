/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Proxy injects the real OAuth Bearer token, the oauth beta
 *             flag, and anthropic-dangerous-direct-browser-access on
 *             every request so the API accepts subscription-based auth.
 */
import { randomUUID } from 'crypto';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { writeFileSync, unlinkSync, chmodSync } from 'fs';
import { resolve as resolvePath } from 'path';

/** Random token for proxy authentication (validated via URL path prefix). */
export const proxyToken = randomUUID();

/**
 * Runtime file that publishes the ephemeral proxy token to host-side helper
 * scripts (e.g. scripts/paperpile-wiki/maintain.sh) so they can route Anthropic
 * calls through this proxy without importing in-process state. In-process
 * children (PageIndex, containers) receive the token directly and do NOT need
 * this file. Written 0600 on listen, removed on close. Lives under store/
 * (gitignored) alongside the DB.
 */
// Path is overridable via NANOCLAW_PROXY_TOKEN_FILE so tests can redirect it to
// a scratch location and never write/delete the real runtime file.
export function proxyTokenFilePath(): string {
  return (
    process.env.NANOCLAW_PROXY_TOKEN_FILE ??
    resolvePath('store/.credential-proxy-token')
  );
}

/** Default path (production). Prefer proxyTokenFilePath() where an override may apply. */
export const PROXY_TOKEN_FILE = resolvePath('store/.credential-proxy-token');

function writeProxyTokenFile(): void {
  const p = proxyTokenFilePath();
  try {
    writeFileSync(p, proxyToken, { mode: 0o600 });
    chmodSync(p, 0o600); // enforce perms even if the file pre-existed
  } catch (err) {
    logger.warn({ err, path: p }, 'Could not write proxy token file');
  }
}

function removeProxyTokenFile(): void {
  try {
    unlinkSync(proxyTokenFilePath());
  } catch {
    // Already gone / never written — fine.
  }
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const UPSTREAM_TIMEOUT = 120_000; // 120 seconds

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * Ensure the anthropic-beta header includes the required OAuth beta flag.
 */
function ensureOAuthBeta(
  headers: Record<string, string | number | string[] | undefined>,
): void {
  const OAUTH_BETA = 'oauth-2025-04-20';
  const CODE_BETA = 'claude-code-20250219';
  const existing = headers['anthropic-beta'];
  const betasToAdd: string[] = [];

  if (!existing) {
    betasToAdd.push(CODE_BETA, OAUTH_BETA);
  } else if (typeof existing === 'string') {
    if (!existing.includes(CODE_BETA)) betasToAdd.push(CODE_BETA);
    if (!existing.includes(OAUTH_BETA)) betasToAdd.push(OAUTH_BETA);
  }

  if (betasToAdd.length > 0) {
    const base = existing && typeof existing === 'string' ? existing : '';
    headers['anthropic-beta'] = [base, ...betasToAdd].filter(Boolean).join(',');
  }

  // Required for OAuth-based access
  headers['anthropic-dangerous-direct-browser-access'] = 'true';
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  onAuthFailure?: (statusCode: number) => void,
): Promise<Server> {
  // Read once at startup for auth mode detection and upstream URL (these rarely change)
  const initialSecrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = initialSecrets.ANTHROPIC_API_KEY
    ? 'api-key'
    : 'oauth';

  const upstreamUrl = new URL(
    initialSecrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  let consecutiveAuthFailures = 0;
  // Edge-triggered: one onAuthFailure per incident. Any non-401/403 upstream
  // response means auth passed (429/5xx are post-auth), ending the incident
  // and re-arming the alert.
  let authAlertedThisIncident = false;
  const AUTH_FAILURE_THRESHOLD = 3;

  // Helper: re-read credentials from .env on each request so token refreshes
  // are picked up without a full restart.
  function freshCredentials() {
    const s = readEnvFile([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
    return {
      apiKey: s.ANTHROPIC_API_KEY,
      oauthToken: s.CLAUDE_CODE_OAUTH_TOKEN || s.ANTHROPIC_AUTH_TOKEN,
    };
  }

  if (authMode === 'oauth') {
    const { oauthToken } = freshCredentials();
    if (!oauthToken) {
      logger.error(
        { tag: 'SYSTEM_ALERT' },
        'Credential proxy: no OAuth token found (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN both missing)',
      );
    }
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Validate proxy token (first path segment)
      const tokenPrefix = `/${proxyToken}/`;
      if (!req.url?.startsWith(tokenPrefix)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      // Strip the token prefix before forwarding
      let upstreamPath = req.url.slice(tokenPrefix.length - 1); // keep leading /

      const chunks: Buffer[] = [];
      let bodySize = 0;
      let aborted = false;

      req.on('data', (c: Buffer) => {
        bodySize += c.length;
        if (bodySize > MAX_BODY_SIZE) {
          aborted = true;
          res.writeHead(413);
          res.end('Request body too large');
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Re-read credentials per request so token refreshes take effect immediately
        const creds = freshCredentials();

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = creds.apiKey;
        } else {
          // OAuth mode: inject real Bearer token on EVERY request
          // and add required beta headers for OAuth access
          delete headers['authorization'];
          delete headers['x-api-key'];
          if (creds.oauthToken) {
            headers['authorization'] = `Bearer ${creds.oauthToken}`;
            ensureOAuthBeta(headers);
          }

          // Ensure ?beta=true query param is present (required by API)
          if (
            upstreamPath.includes('/v1/messages') &&
            !upstreamPath.includes('beta=true')
          ) {
            upstreamPath += upstreamPath.includes('?')
              ? '&beta=true'
              : '?beta=true';
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers,
            timeout: UPSTREAM_TIMEOUT,
          } as RequestOptions,
          (upRes) => {
            const status = upRes.statusCode ?? 0;

            // Track auth failures from upstream API
            if (status === 401 || status === 403) {
              consecutiveAuthFailures++;
              if (
                consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD &&
                !authAlertedThisIncident &&
                onAuthFailure
              ) {
                authAlertedThisIncident = true;
                onAuthFailure(status);
              }
            } else {
              consecutiveAuthFailures = 0;
              authAlertedThisIncident = false;
            }

            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('timeout', () => {
          upstream.destroy();
          if (!res.headersSent) {
            res.writeHead(504);
            res.end('Gateway Timeout');
          }
        });

        upstream.on('error', (err) => {
          logger.error(
            { err, url: upstreamPath },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      writeProxyTokenFile();
      // Remove the token file when the proxy stops so a stale token can't linger.
      server.on('close', removeProxyTokenFile);
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
