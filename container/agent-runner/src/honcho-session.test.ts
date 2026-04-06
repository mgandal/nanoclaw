/**
 * Tests for honcho-session.ts
 * HonchoSession lifecycle manager: initialize, prefetch, inject, sync, updateSessionId
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HonchoClient, HonchoMessageResponse } from './honcho-client.js';
import { HonchoSession } from './honcho-session.js';
import type { HonchoSessionConfig } from './honcho-session.js';

// ─── Mock factory ─────────────────────────────────────────────────────────────

function makeMockClient(overrides: Partial<HonchoClient> = {}): HonchoClient {
  return {
    baseUrl: 'http://honcho.test:8000',
    ensureWorkspace: vi.fn().mockResolvedValue(true),
    ensurePeer: vi.fn().mockResolvedValue('peer-id-123'),
    ensureSession: vi.fn().mockResolvedValue(true),
    addMessages: vi.fn().mockResolvedValue([] as HonchoMessageResponse[]),
    getPeerContext: vi.fn().mockResolvedValue('recalled memory context'),
    getPeerCard: vi.fn().mockResolvedValue(''),
    peerSearch: vi.fn().mockResolvedValue([]),
    peerChat: vi.fn().mockResolvedValue(''),
    addConclusions: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

const BASE_CONFIG: HonchoSessionConfig = {
  workspace: 'nanoclaw',
  userPeer: 'mgandal',
  aiPeer: 'claire',
  sessionId: 'session-uuid-abc',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── initialize ───────────────────────────────────────────────────────────────

describe('initialize', () => {
  it('creates workspace, both peers, and session on success', async () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);

    await session.initialize();

    expect(client.ensureWorkspace).toHaveBeenCalledWith('nanoclaw');
    expect(client.ensurePeer).toHaveBeenCalledWith('nanoclaw', 'mgandal');
    expect(client.ensurePeer).toHaveBeenCalledWith('nanoclaw', 'claire');
    expect(client.ensureSession).toHaveBeenCalledWith('nanoclaw', 'session-uuid-abc');
    expect(session.isReady()).toBe(true);
  });

  it('sets isReady false when ensureWorkspace fails', async () => {
    const client = makeMockClient({
      ensureWorkspace: vi.fn().mockResolvedValue(false),
    });
    const session = new HonchoSession(client, BASE_CONFIG);

    await session.initialize();

    expect(session.isReady()).toBe(false);
    // Should NOT call ensurePeer or ensureSession if workspace fails
    expect(client.ensurePeer).not.toHaveBeenCalled();
    expect(client.ensureSession).not.toHaveBeenCalled();
  });

  it('sets isReady false when ensurePeer (userPeer) fails', async () => {
    const client = makeMockClient({
      ensurePeer: vi.fn()
        .mockResolvedValueOnce(null)   // userPeer fails
        .mockResolvedValueOnce('ai-peer-id'),
    });
    const session = new HonchoSession(client, BASE_CONFIG);

    await session.initialize();

    expect(session.isReady()).toBe(false);
  });

  it('sets isReady false when ensureSession fails', async () => {
    const client = makeMockClient({
      ensureSession: vi.fn().mockResolvedValue(false),
    });
    const session = new HonchoSession(client, BASE_CONFIG);

    await session.initialize();

    expect(session.isReady()).toBe(false);
  });

  it('starts as not ready before initialize is called', () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    expect(session.isReady()).toBe(false);
  });
});

// ─── prefetchContext ──────────────────────────────────────────────────────────

describe('prefetchContext', () => {
  it('fetches and caches context', async () => {
    const client = makeMockClient({
      getPeerContext: vi.fn().mockResolvedValue('user memory context data'),
    });
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    await session.prefetchContext();

    expect(client.getPeerContext).toHaveBeenCalledWith(
      'nanoclaw',
      'mgandal',
      'session-uuid-abc',
    );
    // consumeContext should return the fetched data
    expect(session.consumeContext()).toBe('user memory context data');
  });

  it('caches empty string on failure (graceful degradation)', async () => {
    const client = makeMockClient({
      getPeerContext: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    await session.prefetchContext();

    expect(session.consumeContext()).toBe('');
  });

  it('returns empty string if getPeerContext returns empty', async () => {
    const client = makeMockClient({
      getPeerContext: vi.fn().mockResolvedValue(''),
    });
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    await session.prefetchContext();

    expect(session.consumeContext()).toBe('');
  });
});

// ─── consumeContext ───────────────────────────────────────────────────────────

describe('consumeContext', () => {
  it('clears the cache after consuming (returns empty on second call)', async () => {
    const client = makeMockClient({
      getPeerContext: vi.fn().mockResolvedValue('context data'),
    });
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();
    await session.prefetchContext();

    const first = session.consumeContext();
    const second = session.consumeContext();

    expect(first).toBe('context data');
    expect(second).toBe('');
  });

  it('returns empty string when no prefetch has been done', () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    expect(session.consumeContext()).toBe('');
  });
});

// ─── injectContext ────────────────────────────────────────────────────────────

describe('injectContext', () => {
  it('wraps prompt in memory-context fence when context is non-empty', async () => {
    const client = makeMockClient({
      getPeerContext: vi.fn().mockResolvedValue('some recalled memory'),
    });
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();
    await session.prefetchContext();

    const result = session.injectContext('Hello world');

    expect(result).toContain('<memory-context>');
    expect(result).toContain('</memory-context>');
    expect(result).toContain('some recalled memory');
    expect(result).toContain('Hello world');
    expect(result).toContain('[System note:');
    // Original prompt should come after the fence
    const fenceEnd = result.indexOf('</memory-context>');
    const promptPos = result.indexOf('Hello world');
    expect(promptPos).toBeGreaterThan(fenceEnd);
  });

  it('returns prompt unchanged when no context is cached', () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    const prompt = 'Tell me about the weather';

    const result = session.injectContext(prompt);

    expect(result).toBe(prompt);
    expect(result).not.toContain('<memory-context>');
  });

  it('consumes context when injecting (so second inject returns unchanged)', async () => {
    const client = makeMockClient({
      getPeerContext: vi.fn().mockResolvedValue('context data'),
    });
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();
    await session.prefetchContext();

    const first = session.injectContext('prompt one');
    const second = session.injectContext('prompt two');

    expect(first).toContain('<memory-context>');
    expect(second).toBe('prompt two');
  });
});

// ─── syncMessages ─────────────────────────────────────────────────────────────

describe('syncMessages', () => {
  it('sends both user and assistant messages', async () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    await session.syncMessages('Hello from user', 'Hello from assistant');

    expect(client.addMessages).toHaveBeenCalledOnce();
    const [workspace, sessionId, messages] = (client.addMessages as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(workspace).toBe('nanoclaw');
    expect(sessionId).toBe('session-uuid-abc');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Hello from user');
    expect(messages[0].peer_id).toBe('mgandal');
    expect(messages[1].content).toBe('Hello from assistant');
    expect(messages[1].peer_id).toBe('claire');
  });

  it('skips addMessages when not initialized', async () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    // Do NOT call initialize()

    await session.syncMessages('user msg', 'assistant msg');

    expect(client.addMessages).not.toHaveBeenCalled();
  });

  it('deduplicates: second call with identical messages is skipped', async () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    // First call — should succeed
    await session.syncMessages('user msg 1', 'assistant msg 1');
    // Second call with the exact same messages — should be deduplicated
    await session.syncMessages('user msg 1', 'assistant msg 1');

    expect(client.addMessages).toHaveBeenCalledOnce();
  });

  it('sends sequential turns (turn 0, turn 1, turn 2)', async () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    await session.syncMessages('user 1', 'assistant 1');
    await session.syncMessages('user 2', 'assistant 2');
    await session.syncMessages('user 3', 'assistant 3');

    expect(client.addMessages).toHaveBeenCalledTimes(3);
  });

  it('never throws even if addMessages rejects', async () => {
    const client = makeMockClient({
      addMessages: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    // Should not throw
    await expect(session.syncMessages('user', 'assistant')).resolves.toBeUndefined();
  });
});

// ─── updateSessionId ──────────────────────────────────────────────────────────

describe('updateSessionId', () => {
  it('creates a new session in Honcho with the new ID', async () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    // Clear call history from initialize
    vi.clearAllMocks();
    // Re-mock to return true
    (client.ensureSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await session.updateSessionId('new-session-uuid-xyz');

    expect(client.ensureSession).toHaveBeenCalledWith('nanoclaw', 'new-session-uuid-xyz');
  });

  it('resets dedup state after updateSessionId (allows re-sending previously seen messages)', async () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    // First sync — succeeds
    await session.syncMessages('user 1', 'assistant 1');
    expect(client.addMessages).toHaveBeenCalledTimes(1);

    // Duplicate — blocked
    await session.syncMessages('user 1', 'assistant 1');
    expect(client.addMessages).toHaveBeenCalledTimes(1);

    await session.updateSessionId('new-session-uuid-xyz');
    (client.addMessages as ReturnType<typeof vi.fn>).mockClear();

    // After reset, same messages are allowed again (dedup state cleared)
    await session.syncMessages('user 1', 'assistant 1');
    expect(client.addMessages).toHaveBeenCalledTimes(1);

    // Duplicate again is blocked in new session
    await session.syncMessages('user 1', 'assistant 1');
    expect(client.addMessages).toHaveBeenCalledTimes(1);
  });

  it('uses new session ID for subsequent syncMessages calls', async () => {
    const client = makeMockClient();
    const session = new HonchoSession(client, BASE_CONFIG);
    await session.initialize();

    await session.updateSessionId('updated-session-id');
    (client.addMessages as ReturnType<typeof vi.fn>).mockClear();

    await session.syncMessages('user after update', 'assistant after update');

    const [, sessionId] = (client.addMessages as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sessionId).toBe('updated-session-id');
  });
});
