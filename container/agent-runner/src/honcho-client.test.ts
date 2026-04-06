/**
 * Tests for honcho-client.ts
 * Uses vitest with globalThis.fetch mocking
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHonchoClient } from './honcho-client.js';

const BASE_URL = 'http://honcho.test:8000';

function makeFetchMock(response: { status: number; body: unknown }) {
  return vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.status === 200 ? 'OK' : String(response.status),
    json: vi.fn().mockResolvedValue(response.body),
    text: vi.fn().mockResolvedValue(JSON.stringify(response.body)),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('createHonchoClient', () => {
  it('exposes baseUrl', () => {
    const client = createHonchoClient(BASE_URL);
    expect(client.baseUrl).toBe(BASE_URL);
  });
});

// ─── ensureWorkspace ──────────────────────────────────────────────────────────

describe('ensureWorkspace', () => {
  it('returns true on 200', async () => {
    globalThis.fetch = makeFetchMock({ status: 200, body: { id: 'nanoclaw' } });
    const client = createHonchoClient(BASE_URL);
    expect(await client.ensureWorkspace('nanoclaw')).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces`);
    expect(JSON.parse(opts.body)).toEqual({ id: 'nanoclaw' });
  });

  it('returns true on 409 (already exists)', async () => {
    globalThis.fetch = makeFetchMock({ status: 409, body: {} });
    const client = createHonchoClient(BASE_URL);
    expect(await client.ensureWorkspace('nanoclaw')).toBe(true);
  });

  it('returns false on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const client = createHonchoClient(BASE_URL);
    expect(await client.ensureWorkspace('nanoclaw')).toBe(false);
  });

  it('returns false on 500', async () => {
    globalThis.fetch = makeFetchMock({ status: 500, body: { error: 'internal' } });
    const client = createHonchoClient(BASE_URL);
    expect(await client.ensureWorkspace('nanoclaw')).toBe(false);
  });
});

// ─── ensurePeer ──────────────────────────────────────────────────────────────

describe('ensurePeer', () => {
  it('returns peer id on 200', async () => {
    globalThis.fetch = makeFetchMock({
      status: 200,
      body: { id: 'peer-123', workspace_id: 'ws', created_at: '', metadata: {}, configuration: {} },
    });
    const client = createHonchoClient(BASE_URL);
    const id = await client.ensurePeer('ws', 'alice');
    expect(id).toBe('peer-123');
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces/ws/peers`);
    expect(JSON.parse(opts.body)).toEqual({ name: 'alice' });
  });

  it('returns peer id on 409 (already exists) — fetches peer list to resolve id', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: vi.fn().mockResolvedValue({}),
        text: vi.fn().mockResolvedValue('conflict'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          items: [{ id: 'existing-peer', name: 'alice', workspace_id: 'ws', created_at: '', metadata: {}, configuration: {} }],
          total: 1,
          page: 1,
          size: 50,
          pages: 1,
        }),
        text: vi.fn().mockResolvedValue(''),
      });
    globalThis.fetch = mockFetch;
    const client = createHonchoClient(BASE_URL);
    const id = await client.ensurePeer('ws', 'alice');
    expect(id).toBe('existing-peer');
  });

  it('returns null on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    const client = createHonchoClient(BASE_URL);
    expect(await client.ensurePeer('ws', 'alice')).toBeNull();
  });

  it('returns null on 500', async () => {
    globalThis.fetch = makeFetchMock({ status: 500, body: {} });
    const client = createHonchoClient(BASE_URL);
    expect(await client.ensurePeer('ws', 'alice')).toBeNull();
  });
});

// ─── ensureSession ────────────────────────────────────────────────────────────

describe('ensureSession', () => {
  it('returns true on 200', async () => {
    globalThis.fetch = makeFetchMock({
      status: 200,
      body: { id: 'sess-1', is_active: true, workspace_id: 'ws' },
    });
    const client = createHonchoClient(BASE_URL);
    expect(await client.ensureSession('ws', 'sess-1')).toBe(true);
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces/ws/sessions`);
    expect(JSON.parse(opts.body)).toEqual({ id: 'sess-1' });
  });

  it('returns true on 409', async () => {
    globalThis.fetch = makeFetchMock({ status: 409, body: {} });
    const client = createHonchoClient(BASE_URL);
    expect(await client.ensureSession('ws', 'sess-1')).toBe(true);
  });

  it('returns false on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('net error'));
    const client = createHonchoClient(BASE_URL);
    expect(await client.ensureSession('ws', 'sess-1')).toBe(false);
  });
});

// ─── addMessages ─────────────────────────────────────────────────────────────

describe('addMessages', () => {
  it('posts messages and returns array on success', async () => {
    const responseMessages = [
      { id: 'msg-1', content: 'hello', session_id: 'sess-1', peer_id: 'p1', created_at: '' },
    ];
    globalThis.fetch = makeFetchMock({ status: 200, body: responseMessages });
    const client = createHonchoClient(BASE_URL);
    const result = await client.addMessages('ws', 'sess-1', [{ content: 'hello', peer_id: 'p1' }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('msg-1');
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces/ws/sessions/sess-1/messages`);
    expect(JSON.parse(opts.body)).toEqual({ messages: [{ content: 'hello', peer_id: 'p1' }] });
  });

  it('chunks content >25000 chars', async () => {
    const longContent = 'x'.repeat(60000);
    globalThis.fetch = makeFetchMock({ status: 200, body: [] });
    const client = createHonchoClient(BASE_URL);
    await client.addMessages('ws', 'sess-1', [{ content: longContent, peer_id: 'p1' }]);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    // Should be called multiple times for chunks
    expect(calls.length).toBeGreaterThan(1);
    // First chunk should have [continued 1/N] prefix
    const firstBody = JSON.parse(calls[0][1].body);
    expect(firstBody.messages[0].content).toContain('[continued 1/');
    // Each chunk should be <= 25000 chars
    for (const call of calls) {
      const body = JSON.parse(call[1].body);
      for (const msg of body.messages) {
        expect(msg.content.length).toBeLessThanOrEqual(25000);
      }
    }
  });

  it('returns empty array on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'));
    const client = createHonchoClient(BASE_URL);
    expect(await client.addMessages('ws', 'sess-1', [{ content: 'hi', peer_id: 'p1' }])).toEqual([]);
  });
});

// ─── getPeerContext ───────────────────────────────────────────────────────────

describe('getPeerContext', () => {
  it('returns representation string when available', async () => {
    globalThis.fetch = makeFetchMock({
      status: 200,
      body: { peer_id: 'p1', target_id: 'p2', representation: 'ctx text', peer_card: null },
    });
    const client = createHonchoClient(BASE_URL);
    const ctx = await client.getPeerContext('ws', 'p1');
    expect(ctx).toBe('ctx text');
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces/ws/peers/p1/context`);
  });

  it('combines representation and peer_card when both present', async () => {
    globalThis.fetch = makeFetchMock({
      status: 200,
      body: { peer_id: 'p1', target_id: 'p2', representation: 'rep text', peer_card: 'card text' },
    });
    const client = createHonchoClient(BASE_URL);
    const ctx = await client.getPeerContext('ws', 'p1');
    expect(ctx).toBe('rep text\n\ncard text');
  });

  it('includes session_id query param when provided', async () => {
    globalThis.fetch = makeFetchMock({
      status: 200,
      body: { peer_id: 'p1', target_id: 'p2', representation: 'ctx', peer_card: null },
    });
    const client = createHonchoClient(BASE_URL);
    await client.getPeerContext('ws', 'p1', 'sess-abc');
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces/ws/peers/p1/context?session_id=sess-abc`);
  });

  it('returns empty string on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'));
    const client = createHonchoClient(BASE_URL);
    expect(await client.getPeerContext('ws', 'p1')).toBe('');
  });
});

// ─── getPeerCard ─────────────────────────────────────────────────────────────

describe('getPeerCard', () => {
  it('returns peer_card string', async () => {
    globalThis.fetch = makeFetchMock({ status: 200, body: { peer_card: 'card content' } });
    const client = createHonchoClient(BASE_URL);
    expect(await client.getPeerCard('ws', 'p1')).toBe('card content');
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces/ws/peers/p1/card`);
  });

  it('returns empty string when peer_card is null', async () => {
    globalThis.fetch = makeFetchMock({ status: 200, body: { peer_card: null } });
    const client = createHonchoClient(BASE_URL);
    expect(await client.getPeerCard('ws', 'p1')).toBe('');
  });

  it('returns empty string on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'));
    const client = createHonchoClient(BASE_URL);
    expect(await client.getPeerCard('ws', 'p1')).toBe('');
  });
});

// ─── peerSearch ──────────────────────────────────────────────────────────────

describe('peerSearch', () => {
  it('posts search and returns message array', async () => {
    const messages = [{ id: 'msg-x', content: 'match', session_id: 's', peer_id: 'p1', created_at: '' }];
    globalThis.fetch = makeFetchMock({ status: 200, body: messages });
    const client = createHonchoClient(BASE_URL);
    const result = await client.peerSearch('ws', 'p1', 'my query', 'p2');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('msg-x');
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces/ws/peers/p1/search`);
    expect(JSON.parse(opts.body)).toEqual({ query: 'my query', observed: 'p2' });
  });

  it('returns empty array on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'));
    const client = createHonchoClient(BASE_URL);
    expect(await client.peerSearch('ws', 'p1', 'q', 'p2')).toEqual([]);
  });
});

// ─── peerChat ────────────────────────────────────────────────────────────────

describe('peerChat', () => {
  it('posts chat and returns string response', async () => {
    globalThis.fetch = makeFetchMock({ status: 200, body: 'The dialectic response' });
    const client = createHonchoClient(BASE_URL);
    const result = await client.peerChat('ws', 'p1', 'What do you think?');
    expect(result).toBe('The dialectic response');
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces/ws/peers/p1/chat`);
    expect(JSON.parse(opts.body)).toEqual({ query: 'What do you think?' });
  });

  it('returns empty string on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'));
    const client = createHonchoClient(BASE_URL);
    expect(await client.peerChat('ws', 'p1', 'query')).toBe('');
  });
});

// ─── addConclusions ───────────────────────────────────────────────────────────

describe('addConclusions', () => {
  it('posts conclusions and returns true on success', async () => {
    const conclusions = [
      { content: 'User prefers dark mode', observer_id: 'assistant', observed_id: 'user' },
    ];
    globalThis.fetch = makeFetchMock({
      status: 200,
      body: [{ id: 'c-1', content: 'User prefers dark mode', observer_id: 'assistant', observed_id: 'user' }],
    });
    const client = createHonchoClient(BASE_URL);
    expect(await client.addConclusions('ws', conclusions)).toBe(true);
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v3/workspaces/ws/conclusions`);
    expect(JSON.parse(opts.body)).toEqual({ conclusions });
  });

  it('returns false on error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'));
    const client = createHonchoClient(BASE_URL);
    expect(await client.addConclusions('ws', [])).toBe(false);
  });
});

// ─── timeout behaviour ────────────────────────────────────────────────────────

describe('timeouts', () => {
  it('uses AbortController signal on fetch', async () => {
    let capturedSignal: AbortSignal | null = null;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedSignal = opts.signal as AbortSignal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ id: 'ws' }),
        text: vi.fn().mockResolvedValue(''),
      });
    });
    const client = createHonchoClient(BASE_URL);
    await client.ensureWorkspace('ws');
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
  });
});
