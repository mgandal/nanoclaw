import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy, proxyToken } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/api/oauth/claude_cli/create_api_key`,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode replaces x-api-key with OAuth token even when container omits Authorization', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // OAuth mode always injects real OAuth token, even when container only sends x-api-key
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  // --- Regression tests: TDD hardening pass ---

  it('rejects requests without valid proxy token (returns 403)', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/invalid-token/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('Forbidden');
  });

  it('rejects requests with no path at all (returns 403)', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/',
      headers: {},
    });

    expect(res.statusCode).toBe(403);
  });

  it('credential isolation: container-sent authorization header never reaches upstream in OAuth mode', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer container-leaked-secret',
        },
      },
      '{}',
    );

    // The proxy MUST replace the container's auth header with the real token
    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
    expect(lastUpstreamHeaders['authorization']).not.toContain(
      'container-leaked-secret',
    );
  });

  it('credential isolation: container-sent x-api-key never reaches upstream in API-key mode', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-LEAKED-container-key',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
    expect(lastUpstreamHeaders['x-api-key']).not.toContain('LEAKED');
  });

  it('per-request credential refresh: picks up new token without restart', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'token-v1',
    });

    // First request uses token-v1
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer token-v1');

    // Simulate token refresh in .env
    mockEnv['CLAUDE_CODE_OAUTH_TOKEN'] = 'token-v2';

    // Second request should pick up the new token
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer token-v2');
  });

  it('OAuth mode appends beta=true to /v1/messages path', async () => {
    let lastUpstreamPath = '';
    // Replace upstream to capture the path
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const newPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(lastUpstreamPath).toContain('beta=true');
  });

  it('OAuth mode does not duplicate beta=true if already present', async () => {
    let lastUpstreamPath = '';
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const newPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages?beta=true`,
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    // Should contain exactly one beta=true, not two
    const matches = lastUpstreamPath.match(/beta=true/g);
    expect(matches).toHaveLength(1);
  });

  it('fires onAuthFailure callback after consecutive 401s reach threshold', async () => {
    // Set up upstream that always returns 401
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const newPort = (upstreamServer.address() as AddressInfo).port;

    const authFailureCodes: number[] = [];
    Object.assign(mockEnv, {
      CLAUDE_CODE_OAUTH_TOKEN: 'expired-token',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', (code) => {
      authFailureCodes.push(code);
    });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    // Send 3 requests (threshold is 3)
    for (let i = 0; i < 3; i++) {
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: `/${proxyToken}/v1/messages`,
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );
    }

    expect(authFailureCodes).toHaveLength(1);
    expect(authFailureCodes[0]).toBe(401);
  });

  it('resets auth failure counter on a successful response', async () => {
    let requestCount = 0;
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((req, res) => {
      requestCount++;
      // First 2 requests fail, third succeeds, then 2 more fail
      if (requestCount <= 2 || (requestCount >= 4 && requestCount <= 5)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const newPort = (upstreamServer.address() as AddressInfo).port;

    const authFailureCodes: number[] = [];
    Object.assign(mockEnv, {
      CLAUDE_CODE_OAUTH_TOKEN: 'some-token',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', (code) => {
      authFailureCodes.push(code);
    });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    // 2 failures, then success (resets counter), then 2 more failures
    for (let i = 0; i < 5; i++) {
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: `/${proxyToken}/v1/messages`,
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );
    }

    // Should NOT have fired — counter was reset by the success after request 3
    expect(authFailureCodes).toHaveLength(0);
  });

  it('returns 413 for oversized request bodies', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    // 11 MB body exceeds the 10 MB limit
    const bigBody = 'x'.repeat(11 * 1024 * 1024);
    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: { 'content-type': 'application/json' },
      },
      bigBody,
    );

    expect(res.statusCode).toBe(413);
    expect(res.body).toBe('Request body too large');
  });

  it('concurrent requests each get fresh credentials', async () => {
    let callCount = 0;
    const { readEnvFile } = await import('./env.js');
    const mockReadEnvFile = readEnvFile as ReturnType<typeof vi.fn>;
    // Override the mock to track calls and return incrementing tokens
    mockReadEnvFile.mockImplementation(() => {
      callCount++;
      return {
        ...mockEnv,
        CLAUDE_CODE_OAUTH_TOKEN: `token-call-${callCount}`,
      };
    });

    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'initial-token',
    });

    // Reset call count after proxy startup (which calls readEnvFile too)
    callCount = 0;

    // Fire 3 concurrent requests
    const requests = Array.from({ length: 3 }, () =>
      makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: `/${proxyToken}/v1/messages`,
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      ),
    );

    await Promise.all(requests);

    // Each request should have triggered at least one freshCredentials() call
    // (readEnvFile is called per request for credential refresh)
    expect(callCount).toBeGreaterThanOrEqual(3);

    // Restore default mock behavior
    mockReadEnvFile.mockImplementation(() => ({ ...mockEnv }));
  });

  it('ensureOAuthBeta adds both beta flags to empty headers', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: `/${proxyToken}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          // no anthropic-beta header
        },
      },
      '{}',
    );

    const beta = lastUpstreamHeaders['anthropic-beta'] as string;
    expect(beta).toContain('oauth-2025-04-20');
    expect(beta).toContain('claude-code-20250219');
    expect(
      lastUpstreamHeaders['anthropic-dangerous-direct-browser-access'],
    ).toBe('true');
  });
});
