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
