import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchSnapshot } from './snapshot-fetch.js';

const validBody = {
  generated_at: '2026-04-21T12:00:00Z',
  schema_version: 1,
  groups: [],
  tasks: [],
  ingestion: {
    emails: { count_24h: 0, last_at: null, recent: [] },
    papers: { count_24h: 0, last_at: null, recent: [] },
    vault: { count_24h: 0, last_at: null, recent: [] },
  },
  watchlists: [],
  blogs: null,
  priorities: [],
  vault_tree: { name: 'vault', path: '', kind: 'dir', children: [] },
  vault_pages_available: [],
};

const origFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('fetchSnapshot', () => {
  it('returns the parsed snapshot on 200 with valid JSON', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(validBody), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const snap = await fetchSnapshot('https://cockpit.example');
    expect(snap.generated_at).toBe('2026-04-21T12:00:00Z');
    expect(snap.schema_version).toBe(1);
  });

  it('calls the correct URL', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(validBody), { status: 200 }),
    );
    globalThis.fetch = mock;
    await fetchSnapshot('https://cockpit.example');
    expect(mock).toHaveBeenCalledWith('https://cockpit.example/data/snapshot.json', expect.any(Object));
  });

  it('throws on non-200', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 404 }),
    );
    await expect(fetchSnapshot('https://cockpit.example')).rejects.toThrow(/404/);
  });

  it('throws on malformed JSON', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('not json at all', { status: 200 }),
    );
    await expect(fetchSnapshot('https://cockpit.example')).rejects.toThrow(/parse/i);
  });

  it('throws when required top-level fields are missing', async () => {
    const partial = { generated_at: '2026-04-21T12:00:00Z' };  // missing most fields
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(partial), { status: 200 }),
    );
    await expect(fetchSnapshot('https://cockpit.example')).rejects.toThrow(/malformed/i);
  });
});
