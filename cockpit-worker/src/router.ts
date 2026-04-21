export interface Route {
  key: string;
  contentType: string;
}

const PREFIX = '/data/';

export function routeRequest(pathname: string): Route | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const tail = pathname.slice(PREFIX.length);

  // Reject path traversal. Even though R2 keys are flat, a ".." in the
  // input is a clear bad-faith signal — refuse rather than normalize.
  if (tail.includes('..')) return null;
  if (tail.length === 0) return null;

  // Allowed shapes:
  //   snapshot.json                        → application/json
  //   snapshot-YYYYMMDD-HHMM.json          → application/json
  //   heartbeat.txt                        → text/plain
  //   pages/<slug>.md                      → text/markdown
  if (tail === 'snapshot.json' || /^snapshot-\d{8}-\d{4}\.json$/.test(tail)) {
    return { key: tail, contentType: 'application/json' };
  }
  if (tail === 'heartbeat.txt') {
    return { key: tail, contentType: 'text/plain; charset=utf-8' };
  }
  if (tail.startsWith('pages/') && tail.endsWith('.md')) {
    return { key: tail, contentType: 'text/markdown; charset=utf-8' };
  }
  return null;
}
