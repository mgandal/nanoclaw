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
