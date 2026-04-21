import { describe, it, expect } from 'vitest';
import { routeRequest } from './router.js';

describe('routeRequest', () => {
  it('maps /data/snapshot.json to snapshot.json with application/json', () => {
    const r = routeRequest('/data/snapshot.json');
    expect(r).toEqual({ key: 'snapshot.json', contentType: 'application/json' });
  });

  it('maps /data/heartbeat.txt to heartbeat.txt with text/plain', () => {
    const r = routeRequest('/data/heartbeat.txt');
    expect(r).toEqual({ key: 'heartbeat.txt', contentType: 'text/plain; charset=utf-8' });
  });

  it('maps /data/pages/<slug>.md to pages/<slug>.md with text/markdown', () => {
    const r = routeRequest('/data/pages/99-wiki%2Ftools%2Fpolars-bio.md');
    expect(r).toEqual({
      key: 'pages/99-wiki%2Ftools%2Fpolars-bio.md',
      contentType: 'text/markdown; charset=utf-8',
    });
  });

  it('maps /data/snapshot-YYYYMMDD-HHMM.json to the history object', () => {
    const r = routeRequest('/data/snapshot-20260419-1200.json');
    expect(r).toEqual({
      key: 'snapshot-20260419-1200.json',
      contentType: 'application/json',
    });
  });

  it('returns null for paths outside /data/', () => {
    expect(routeRequest('/')).toBeNull();
    expect(routeRequest('/other/snapshot.json')).toBeNull();
  });

  it('returns null for path traversal attempts', () => {
    expect(routeRequest('/data/../etc/passwd')).toBeNull();
    expect(routeRequest('/data/pages/../../etc')).toBeNull();
  });

  it('returns null for unknown extensions under /data/', () => {
    expect(routeRequest('/data/evil.sh')).toBeNull();
    expect(routeRequest('/data/config.yaml')).toBeNull();
  });
});
