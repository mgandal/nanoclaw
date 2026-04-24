# SimpleMem Phase-Out Implementation Plan

> **Status: SHIPPED 2026-04-06.** SimpleMem removed; Honcho stack running in Docker (api-1, deriver-1, database-1, redis-1) shared with Hermes at `~/.hermes/honcho/`. Workspace "nanoclaw", Ollama phi4-mini + nomic-embed-text, 4 MCP tools (`honcho_profile`, `honcho_search`, `honcho_context`, `honcho_conclude`) wired into the agent runner. No `simplemem*` files remain in `src/`. Open `- [ ]` boxes never updated retroactively.

**Goal:** Remove SimpleMem, add Honcho user-modeling layer, keep Hindsight + QMD unchanged.

**Architecture:** Three new TypeScript files inside the container agent-runner (`honcho-client.ts`, `honcho-session.ts`, `honcho-mcp-stdio.ts`) implement the Honcho integration. The host-side `container-runner.ts` injects `HONCHO_URL` into containers. Five SimpleMem ingest scripts are deleted and `sync-all.sh` is simplified. All changes are additive first (phases 1-3), then subtractive (phases 4-6).

**Tech Stack:** TypeScript, Node.js native `fetch()`, `@modelcontextprotocol/sdk` (already in package.json), Honcho v3 REST API on `localhost:8010`.

**Spec:** `docs/superpowers/specs/2026-04-06-simplemem-phaseout-design-v2.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `container/agent-runner/src/honcho-client.ts` | HTTP client wrapping Honcho v3 REST API — workspace/peer/session CRUD, messages, context, chat, search, conclusions |
| `container/agent-runner/src/honcho-session.ts` | Session lifecycle — prefetch cache, message buffer, async sync, scheduled-task guard, context injection |
| `container/agent-runner/src/honcho-mcp-stdio.ts` | MCP stdio server exposing 4 tools (`honcho_profile`, `honcho_search`, `honcho_context`, `honcho_conclude`) |
| `container/agent-runner/src/honcho-client.test.ts` | Unit tests for honcho-client (mocked fetch) |
| `container/agent-runner/src/honcho-session.test.ts` | Unit tests for honcho-session lifecycle |

### Modified Files
| File | What Changes |
|------|-------------|
| `src/container-runner.ts` | Add HONCHO_URL env var injection; remove SIMPLEMEM_URL injection + redaction |
| `src/container-runner.test.ts` | Replace SIMPLEMEM_URL tests with HONCHO_URL tests |
| `src/index.ts` | Add Honcho workspace bootstrap + health check; remove SimpleMem health/fix handlers |
| `src/health-monitor.test.ts` | Remove SimpleMem fix handler test references |
| `container/agent-runner/src/index.ts` | Remove simplemem MCP server; add honcho MCP server + session integration |
| `scripts/sync/sync-all.sh` | Remove SimpleMem ingest steps (4, 5, 6, 9, 11); renumber |
| `.env` | Remove SIMPLEMEM_URL; add HONCHO_URL |

### Deleted Files
| File | Reason |
|------|--------|
| `scripts/sync/simplemem-ingest.py` | QMD already indexes emails |
| `scripts/sync/vault-ingest.py` | QMD vault collection covers this |
| `scripts/sync/claude-history-ingest.py` | QMD sessions collection covers this |
| `scripts/sync/telegram-history-ingest.py` | QMD indexes conversation transcripts |
| `scripts/sync/apple-notes-ingest.py` | QMD apple-notes collection covers this |
| `scripts/fixes/restart-simplemem.sh` | No longer needed |

---

## Honcho v3 API Reference (verified against localhost:8010)

These are the exact request/response shapes, confirmed by live testing:

```
POST /v3/workspaces                              → { id, metadata, configuration, created_at }
  body: { "id": "nanoclaw" }

POST /v3/workspaces/{ws}/peers                   → { id, workspace_id, created_at, metadata, configuration }
  body: { "name": "mgandal" }

POST /v3/workspaces/{ws}/peers/list              → { items: Peer[], total, page, size, pages }
  body: {}

GET  /v3/workspaces/{ws}/peers/{pid}/card        → { peer_card: string | null }

POST /v3/workspaces/{ws}/peers/{pid}/search      → Message[]
  body: { "query": "...", "observed": "peer-id" }

POST /v3/workspaces/{ws}/peers/{pid}/chat        → string (can be slow — 60-150s with Ollama)
  body: { "query": "..." }

GET  /v3/workspaces/{ws}/peers/{pid}/context      → { peer_id, target_id, representation, peer_card }
  query: ?session_id=xxx

POST /v3/workspaces/{ws}/sessions                → { id, is_active, workspace_id, metadata, configuration, created_at }
  body: { "id": "session-uuid" }

POST /v3/workspaces/{ws}/sessions/list           → { items: Session[], total, page, size, pages }
  body: {}

POST /v3/workspaces/{ws}/sessions/{sid}/messages → Message[]
  body: { "messages": [{ "content": "...", "peer_id": "..." }] }

POST /v3/workspaces/{ws}/conclusions             → Conclusion[]
  body: { "conclusions": [{ "content": "...", "observer_id": "...", "observed_id": "..." }] }

POST /v3/workspaces/{ws}/conclusions/list        → { items: Conclusion[], total, page, size, pages }
  body: {}
```

---

## Task 1: Honcho HTTP Client

**Files:**
- Create: `container/agent-runner/src/honcho-client.ts`
- Create: `container/agent-runner/src/honcho-client.test.ts`

This is the foundation — a typed HTTP client for every Honcho v3 endpoint we need.

- [ ] **Step 1: Write the failing test for `honchoFetch` wrapper**

Create `container/agent-runner/src/honcho-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We'll test the exported functions after implementation
describe('HonchoClient', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('createHonchoClient', () => {
    it('creates client with base URL', async () => {
      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      expect(client).toBeDefined();
      expect(client.baseUrl).toBe('http://localhost:8010');
    });
  });

  describe('ensureWorkspace', () => {
    it('creates workspace and returns true', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'nanoclaw', metadata: {}, created_at: '2026-01-01' }),
      });

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      const result = await client.ensureWorkspace('nanoclaw');
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8010/v3/workspaces',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'nanoclaw' }),
        }),
      );
    });

    it('returns true when workspace already exists (409)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ detail: 'already exists' }),
      });

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      const result = await client.ensureWorkspace('nanoclaw');
      expect(result).toBe(true);
    });

    it('returns false on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      const result = await client.ensureWorkspace('nanoclaw');
      expect(result).toBe(false);
    });
  });

  describe('ensurePeer', () => {
    it('creates peer and returns peer ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'mgandal', workspace_id: 'nanoclaw' }),
      });

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      const id = await client.ensurePeer('nanoclaw', 'mgandal');
      expect(id).toBe('mgandal');
    });

    it('returns peer ID when already exists (409)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ detail: 'already exists' }),
      });

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      const id = await client.ensurePeer('nanoclaw', 'mgandal');
      expect(id).toBe('mgandal');
    });
  });

  describe('addMessages', () => {
    it('sends messages with correct shape', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ([{ id: 'msg1', content: 'hello', peer_id: 'mgandal' }]),
      });

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      const result = await client.addMessages('nanoclaw', 'session-1', [
        { content: 'hello', peer_id: 'mgandal' },
      ]);
      expect(result).toHaveLength(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:8010/v3/workspaces/nanoclaw/sessions/session-1/messages');
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ messages: [{ content: 'hello', peer_id: 'mgandal' }] });
    });

    it('chunks messages longer than 25000 chars', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ([{ id: 'msg1', content: 'chunk', peer_id: 'mgandal' }]),
      });

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      const longContent = 'x'.repeat(60000);
      await client.addMessages('nanoclaw', 'session-1', [
        { content: longContent, peer_id: 'mgandal' },
      ]);

      // Should have been called 3 times (60000 / 25000 = 3 chunks)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('getPeerContext', () => {
    it('returns context string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          peer_id: 'mgandal',
          representation: 'User likes concise responses',
          peer_card: null,
        }),
      });

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      const ctx = await client.getPeerContext('nanoclaw', 'mgandal', 'session-1');
      expect(ctx).toContain('User likes concise responses');
    });

    it('returns empty string on timeout', async () => {
      mockFetch.mockImplementationOnce(() =>
        new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 100)),
      );

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      const ctx = await client.getPeerContext('nanoclaw', 'mgandal', 'session-1');
      expect(ctx).toBe('');
    });
  });

  describe('timeout handling', () => {
    it('aborts requests that exceed timeout', async () => {
      mockFetch.mockImplementationOnce((_url: string, opts: RequestInit) => {
        return new Promise((resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          // Never resolves naturally — timeout should fire
        });
      });

      const { createHonchoClient } = await import('./honcho-client.js');
      const client = createHonchoClient('http://localhost:8010');
      // ensureWorkspace has a 5s timeout — but we mock fetch to hang
      const result = await client.ensureWorkspace('nanoclaw');
      expect(result).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && npx vitest run src/honcho-client.test.ts --reporter verbose 2>&1 | tail -20`
Expected: FAIL — `honcho-client.js` module not found

- [ ] **Step 3: Implement honcho-client.ts**

Create `container/agent-runner/src/honcho-client.ts`:

```typescript
/**
 * Honcho v3 REST API client for NanoClaw agent containers.
 * Uses native fetch() with AbortController timeouts.
 * All methods return null/empty on failure (graceful degradation).
 */

const MESSAGE_CHUNK_SIZE = 25_000;

// Timeout constants (ms)
const TIMEOUT_CRUD = 5_000;
const TIMEOUT_READ = 10_000;
const TIMEOUT_DIALECTIC = 60_000;
const TIMEOUT_CONTEXT = 30_000;

function log(msg: string): void {
  console.error(`[honcho] ${msg}`);
}

interface HonchoMessage {
  content: string;
  peer_id: string;
}

interface HonchoMessageResponse {
  id: string;
  content: string;
  peer_id: string;
  session_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
  workspace_id: string;
  token_count: number;
}

interface HonchoContextResponse {
  peer_id: string;
  target_id: string;
  representation: string;
  peer_card: string | null;
}

interface HonchoConclusion {
  content: string;
  observer_id: string;
  observed_id: string;
}

export interface HonchoClient {
  baseUrl: string;
  ensureWorkspace(workspaceId: string): Promise<boolean>;
  ensurePeer(workspaceId: string, peerId: string): Promise<string | null>;
  ensureSession(workspaceId: string, sessionId: string): Promise<boolean>;
  addMessages(
    workspaceId: string,
    sessionId: string,
    messages: HonchoMessage[],
  ): Promise<HonchoMessageResponse[]>;
  getPeerContext(
    workspaceId: string,
    peerId: string,
    sessionId?: string,
  ): Promise<string>;
  getPeerCard(workspaceId: string, peerId: string): Promise<string>;
  peerSearch(
    workspaceId: string,
    peerId: string,
    query: string,
    observedId: string,
  ): Promise<HonchoMessageResponse[]>;
  peerChat(
    workspaceId: string,
    peerId: string,
    query: string,
  ): Promise<string>;
  addConclusions(
    workspaceId: string,
    conclusions: HonchoConclusion[],
  ): Promise<boolean>;
}

async function honchoFetch(
  baseUrl: string,
  path: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    return res;
  } catch (err) {
    log(`${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function chunkContent(content: string): string[] {
  if (content.length <= MESSAGE_CHUNK_SIZE) return [content];
  const chunks: string[] = [];
  const totalChunks = Math.ceil(content.length / MESSAGE_CHUNK_SIZE);
  for (let i = 0; i < totalChunks; i++) {
    const slice = content.slice(i * MESSAGE_CHUNK_SIZE, (i + 1) * MESSAGE_CHUNK_SIZE);
    chunks.push(`[continued ${i + 1}/${totalChunks}] ${slice}`);
  }
  return chunks;
}

export function createHonchoClient(baseUrl: string): HonchoClient {
  return {
    baseUrl,

    async ensureWorkspace(workspaceId: string): Promise<boolean> {
      const res = await honchoFetch(
        baseUrl,
        '/v3/workspaces',
        { method: 'POST', body: JSON.stringify({ id: workspaceId }) },
        TIMEOUT_CRUD,
      );
      if (!res) return false;
      // 409 = already exists, which is fine
      return res.ok || res.status === 409;
    },

    async ensurePeer(workspaceId: string, peerId: string): Promise<string | null> {
      const res = await honchoFetch(
        baseUrl,
        `/v3/workspaces/${workspaceId}/peers`,
        { method: 'POST', body: JSON.stringify({ name: peerId }) },
        TIMEOUT_CRUD,
      );
      if (!res) return null;
      if (res.ok || res.status === 409) return peerId;
      log(`ensurePeer ${peerId} got ${res.status}`);
      return null;
    },

    async ensureSession(workspaceId: string, sessionId: string): Promise<boolean> {
      const res = await honchoFetch(
        baseUrl,
        `/v3/workspaces/${workspaceId}/sessions`,
        { method: 'POST', body: JSON.stringify({ id: sessionId }) },
        TIMEOUT_CRUD,
      );
      if (!res) return false;
      return res.ok || res.status === 409;
    },

    async addMessages(
      workspaceId: string,
      sessionId: string,
      messages: HonchoMessage[],
    ): Promise<HonchoMessageResponse[]> {
      const allResults: HonchoMessageResponse[] = [];

      for (const msg of messages) {
        const chunks = chunkContent(msg.content);
        for (const chunk of chunks) {
          const res = await honchoFetch(
            baseUrl,
            `/v3/workspaces/${workspaceId}/sessions/${sessionId}/messages`,
            {
              method: 'POST',
              body: JSON.stringify({
                messages: [{ content: chunk, peer_id: msg.peer_id }],
              }),
            },
            TIMEOUT_READ,
          );
          if (res?.ok) {
            try {
              const data = await res.json();
              allResults.push(...(Array.isArray(data) ? data : [data]));
            } catch { /* parse error, continue */ }
          }
        }
      }

      return allResults;
    },

    async getPeerContext(
      workspaceId: string,
      peerId: string,
      sessionId?: string,
    ): Promise<string> {
      const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
      const res = await honchoFetch(
        baseUrl,
        `/v3/workspaces/${workspaceId}/peers/${peerId}/context${qs}`,
        { method: 'GET' },
        TIMEOUT_CONTEXT,
      );
      if (!res?.ok) return '';
      try {
        const data: HonchoContextResponse = await res.json();
        const parts: string[] = [];
        if (data.representation) parts.push(data.representation);
        if (data.peer_card) parts.push(data.peer_card);
        return parts.join('\n\n');
      } catch {
        return '';
      }
    },

    async getPeerCard(workspaceId: string, peerId: string): Promise<string> {
      const res = await honchoFetch(
        baseUrl,
        `/v3/workspaces/${workspaceId}/peers/${peerId}/card`,
        { method: 'GET' },
        TIMEOUT_READ,
      );
      if (!res?.ok) return '';
      try {
        const data = await res.json();
        return data.peer_card || '';
      } catch {
        return '';
      }
    },

    async peerSearch(
      workspaceId: string,
      peerId: string,
      query: string,
      observedId: string,
    ): Promise<HonchoMessageResponse[]> {
      const res = await honchoFetch(
        baseUrl,
        `/v3/workspaces/${workspaceId}/peers/${peerId}/search`,
        {
          method: 'POST',
          body: JSON.stringify({ query, observed: observedId }),
        },
        TIMEOUT_READ,
      );
      if (!res?.ok) return [];
      try {
        return await res.json();
      } catch {
        return [];
      }
    },

    async peerChat(
      workspaceId: string,
      peerId: string,
      query: string,
    ): Promise<string> {
      const res = await honchoFetch(
        baseUrl,
        `/v3/workspaces/${workspaceId}/peers/${peerId}/chat`,
        { method: 'POST', body: JSON.stringify({ query }) },
        TIMEOUT_DIALECTIC,
      );
      if (!res?.ok) return '';
      try {
        const text = await res.text();
        return text;
      } catch {
        return '';
      }
    },

    async addConclusions(
      workspaceId: string,
      conclusions: HonchoConclusion[],
    ): Promise<boolean> {
      const res = await honchoFetch(
        baseUrl,
        `/v3/workspaces/${workspaceId}/conclusions`,
        {
          method: 'POST',
          body: JSON.stringify({ conclusions }),
        },
        TIMEOUT_READ,
      );
      return res?.ok ?? false;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd container/agent-runner && npx vitest run src/honcho-client.test.ts --reporter verbose 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/honcho-client.ts container/agent-runner/src/honcho-client.test.ts
git commit -m "feat: add Honcho v3 HTTP client for agent containers"
```

---

## Task 2: Honcho Session Manager

**Files:**
- Create: `container/agent-runner/src/honcho-session.ts`
- Create: `container/agent-runner/src/honcho-session.test.ts`

Session lifecycle: prefetch, inject, sync, scheduled-task guard.

- [ ] **Step 1: Write failing tests for HonchoSession**

Create `container/agent-runner/src/honcho-session.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HonchoClient } from './honcho-client.js';

function mockClient(overrides?: Partial<HonchoClient>): HonchoClient {
  return {
    baseUrl: 'http://localhost:8010',
    ensureWorkspace: vi.fn().mockResolvedValue(true),
    ensurePeer: vi.fn().mockResolvedValue('mgandal'),
    ensureSession: vi.fn().mockResolvedValue(true),
    addMessages: vi.fn().mockResolvedValue([]),
    getPeerContext: vi.fn().mockResolvedValue('User prefers concise responses'),
    getPeerCard: vi.fn().mockResolvedValue(''),
    peerSearch: vi.fn().mockResolvedValue([]),
    peerChat: vi.fn().mockResolvedValue('The user is a neuroscientist'),
    addConclusions: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('HonchoSession', () => {
  let client: HonchoClient;

  beforeEach(() => {
    client = mockClient();
  });

  describe('initialize', () => {
    it('creates workspace, peers, and session', async () => {
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();

      expect(client.ensureWorkspace).toHaveBeenCalledWith('nanoclaw');
      expect(client.ensurePeer).toHaveBeenCalledWith('nanoclaw', 'mgandal');
      expect(client.ensurePeer).toHaveBeenCalledWith('nanoclaw', 'claire');
      expect(client.ensureSession).toHaveBeenCalledWith('nanoclaw', 'session-1');
    });

    it('sets initialized=false if workspace creation fails', async () => {
      client = mockClient({ ensureWorkspace: vi.fn().mockResolvedValue(false) });
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();
      expect(session.isReady()).toBe(false);
    });
  });

  describe('prefetchContext', () => {
    it('caches context from getPeerContext', async () => {
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();
      await session.prefetchContext();
      const ctx = session.consumeContext();
      expect(ctx).toBe('User prefers concise responses');
    });

    it('returns empty string on failure', async () => {
      client = mockClient({ getPeerContext: vi.fn().mockResolvedValue('') });
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();
      await session.prefetchContext();
      expect(session.consumeContext()).toBe('');
    });
  });

  describe('injectContext', () => {
    it('wraps context in memory-context fence', async () => {
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();
      await session.prefetchContext();
      const result = session.injectContext('What is the weather?');
      expect(result).toContain('<memory-context>');
      expect(result).toContain('User prefers concise responses');
      expect(result).toContain('What is the weather?');
      expect(result).toContain('</memory-context>');
    });

    it('returns prompt unchanged when context is empty', async () => {
      client = mockClient({ getPeerContext: vi.fn().mockResolvedValue('') });
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();
      await session.prefetchContext();
      const result = session.injectContext('What is the weather?');
      expect(result).toBe('What is the weather?');
      expect(result).not.toContain('<memory-context>');
    });
  });

  describe('syncMessages', () => {
    it('sends user and assistant messages', async () => {
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();
      await session.syncMessages('Hello', 'Hi there!');

      expect(client.addMessages).toHaveBeenCalledWith('nanoclaw', 'session-1', [
        { content: 'Hello', peer_id: 'mgandal' },
        { content: 'Hi there!', peer_id: 'claire' },
      ]);
    });

    it('skips sync when not initialized', async () => {
      client = mockClient({ ensureWorkspace: vi.fn().mockResolvedValue(false) });
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();
      await session.syncMessages('Hello', 'Hi');
      expect(client.addMessages).not.toHaveBeenCalled();
    });

    it('deduplicates messages by turn index', async () => {
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();
      await session.syncMessages('Hello', 'Hi');
      await session.syncMessages('Hello', 'Hi'); // duplicate
      // addMessages should only be called once
      expect(client.addMessages).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateSessionId', () => {
    it('creates new session and resets state', async () => {
      const { HonchoSession } = await import('./honcho-session.js');
      const session = new HonchoSession(client, {
        workspace: 'nanoclaw',
        userPeer: 'mgandal',
        aiPeer: 'claire',
        sessionId: 'session-1',
      });
      await session.initialize();
      await session.syncMessages('Hello', 'Hi');

      await session.updateSessionId('session-2');
      expect(client.ensureSession).toHaveBeenCalledWith('nanoclaw', 'session-2');

      // Should be able to sync again (dedup state reset)
      await session.syncMessages('Hello', 'Hi');
      expect(client.addMessages).toHaveBeenCalledTimes(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && npx vitest run src/honcho-session.test.ts --reporter verbose 2>&1 | tail -20`
Expected: FAIL — `honcho-session.js` module not found

- [ ] **Step 3: Implement honcho-session.ts**

Create `container/agent-runner/src/honcho-session.ts`:

```typescript
/**
 * Honcho session lifecycle manager for NanoClaw agent containers.
 * Handles: prefetch (background), inject (at query time), sync (async after turn).
 * Mirrors Hermes Agent's session.py pattern.
 */

import type { HonchoClient } from './honcho-client.js';

function log(msg: string): void {
  console.error(`[honcho-session] ${msg}`);
}

export interface HonchoSessionConfig {
  workspace: string;
  userPeer: string;
  aiPeer: string;
  sessionId: string;
}

export class HonchoSession {
  private client: HonchoClient;
  private config: HonchoSessionConfig;
  private initialized = false;
  private cachedContext = '';
  private syncedTurns = new Set<number>();
  private turnCounter = 0;

  constructor(client: HonchoClient, config: HonchoSessionConfig) {
    this.client = client;
    this.config = config;
  }

  async initialize(): Promise<void> {
    const ok = await this.client.ensureWorkspace(this.config.workspace);
    if (!ok) {
      log('Failed to ensure workspace, Honcho disabled for this session');
      return;
    }

    const [userOk, aiOk] = await Promise.all([
      this.client.ensurePeer(this.config.workspace, this.config.userPeer),
      this.client.ensurePeer(this.config.workspace, this.config.aiPeer),
    ]);
    if (!userOk || !aiOk) {
      log('Failed to ensure peers, Honcho disabled for this session');
      return;
    }

    const sessionOk = await this.client.ensureSession(
      this.config.workspace,
      this.config.sessionId,
    );
    if (!sessionOk) {
      log('Failed to ensure session, Honcho disabled for this session');
      return;
    }

    this.initialized = true;
    log(`Initialized: workspace=${this.config.workspace} session=${this.config.sessionId} user=${this.config.userPeer} ai=${this.config.aiPeer}`);
  }

  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Prefetch context from Honcho. Call this in the background
   * (e.g., during IPC wait) so it's ready for the next turn.
   */
  async prefetchContext(): Promise<void> {
    if (!this.initialized) return;
    try {
      this.cachedContext = await this.client.getPeerContext(
        this.config.workspace,
        this.config.userPeer,
        this.config.sessionId,
      );
      if (this.cachedContext) {
        log(`Prefetched context (${this.cachedContext.length} chars)`);
      }
    } catch (err) {
      log(`Prefetch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.cachedContext = '';
    }
  }

  /**
   * Consume the cached context (clears it so it's not injected twice).
   */
  consumeContext(): string {
    const ctx = this.cachedContext;
    this.cachedContext = '';
    return ctx;
  }

  /**
   * Wrap a user prompt with cached Honcho context in a fenced block.
   * Returns the original prompt unchanged if no context is available.
   */
  injectContext(prompt: string): string {
    const ctx = this.consumeContext();
    if (!ctx || ctx.trim().length === 0) return prompt;

    return (
      '<memory-context>\n' +
      '[System note: The following is recalled memory context, ' +
      'NOT new user input. Treat as informational background data.]\n\n' +
      ctx +
      '\n</memory-context>\n\n' +
      prompt
    );
  }

  /**
   * Sync user + assistant messages to Honcho. Fire-and-forget safe.
   * Deduplicates by turn index to handle container crash recovery.
   */
  async syncMessages(
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    if (!this.initialized) return;

    const turn = this.turnCounter++;
    if (this.syncedTurns.has(turn)) {
      log(`Turn ${turn} already synced, skipping`);
      return;
    }

    try {
      await this.client.addMessages(this.config.workspace, this.config.sessionId, [
        { content: userMessage, peer_id: this.config.userPeer },
        { content: assistantMessage, peer_id: this.config.aiPeer },
      ]);
      this.syncedTurns.add(turn);
    } catch (err) {
      log(`Sync failed for turn ${turn}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update the session ID (e.g., after SDK compaction creates a new session).
   * Creates the new session in Honcho and resets dedup state.
   */
  async updateSessionId(newSessionId: string): Promise<void> {
    this.config.sessionId = newSessionId;
    this.syncedTurns.clear();
    this.turnCounter = 0;
    if (this.initialized) {
      await this.client.ensureSession(this.config.workspace, newSessionId);
      log(`Session updated to ${newSessionId}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd container/agent-runner && npx vitest run src/honcho-session.test.ts --reporter verbose 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/honcho-session.ts container/agent-runner/src/honcho-session.test.ts
git commit -m "feat: add Honcho session manager with prefetch/inject/sync lifecycle"
```

---

## Task 3: Honcho MCP Stdio Server

**Files:**
- Create: `container/agent-runner/src/honcho-mcp-stdio.ts`

Four tools matching Hermes: `honcho_profile`, `honcho_search`, `honcho_context`, `honcho_conclude`.

- [ ] **Step 1: Implement honcho-mcp-stdio.ts**

Create `container/agent-runner/src/honcho-mcp-stdio.ts`:

```typescript
/**
 * Honcho MCP Server for NanoClaw agent containers.
 * Exposes 4 tools for explicit user-context queries.
 * Runs as a stdio subprocess launched by the agent runner.
 *
 * Environment variables (set by agent-runner):
 *   HONCHO_URL          — Honcho API base URL (e.g., http://host.containers.internal:8010)
 *   HONCHO_WORKSPACE    — Workspace ID (default: "nanoclaw")
 *   HONCHO_USER_PEER    — User peer ID (default: "mgandal")
 *   HONCHO_AI_PEER      — AI peer ID (derived from group folder)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHonchoClient } from './honcho-client.js';

const HONCHO_URL = process.env.HONCHO_URL!;
const WORKSPACE = process.env.HONCHO_WORKSPACE || 'nanoclaw';
const USER_PEER = process.env.HONCHO_USER_PEER || 'mgandal';
const AI_PEER = process.env.HONCHO_AI_PEER || 'assistant';

function log(msg: string): void {
  console.error(`[HONCHO-MCP] ${msg}`);
}

const client = createHonchoClient(HONCHO_URL);

const server = new McpServer({
  name: 'honcho',
  version: '1.0.0',
});

server.tool(
  'honcho_profile',
  'Get the user\'s profile card — a summary of known preferences, traits, and patterns. Fast (no LLM call). Returns empty string if no profile exists yet.',
  {},
  async () => {
    log('honcho_profile called');
    const card = await client.getPeerCard(WORKSPACE, USER_PEER);
    return {
      content: [{ type: 'text' as const, text: card || 'No profile card available yet.' }],
    };
  },
);

server.tool(
  'honcho_search',
  'Search the user\'s conversation history semantically. Returns relevant message excerpts.',
  {
    query: z.string().describe('What to search for in the user\'s history'),
  },
  async (args) => {
    log(`honcho_search: ${args.query}`);
    const results = await client.peerSearch(WORKSPACE, USER_PEER, args.query, USER_PEER);
    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matching messages found.' }] };
    }
    const text = results
      .map((r) => `[${r.created_at}] ${r.content.slice(0, 500)}`)
      .join('\n\n');
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'honcho_context',
  'Ask Honcho a question about the user using dialectic reasoning. This calls an LLM and may take 30-60 seconds. Use for deeper questions about user preferences, patterns, or history.',
  {
    query: z.string().describe('Question about the user (e.g., "What topics does the user care about?")'),
  },
  async (args) => {
    log(`honcho_context: ${args.query}`);
    const answer = await client.peerChat(WORKSPACE, USER_PEER, args.query);
    return {
      content: [{ type: 'text' as const, text: answer || 'Honcho could not generate a response.' }],
    };
  },
);

server.tool(
  'honcho_conclude',
  'Save a conclusion or fact about the user to Honcho\'s long-term memory. Use when you learn something important about the user that should persist across sessions.',
  {
    content: z.string().describe('The conclusion to save (e.g., "User prefers dark mode")'),
  },
  async (args) => {
    log(`honcho_conclude: ${args.content}`);
    const ok = await client.addConclusions(WORKSPACE, [
      { content: args.content, observer_id: AI_PEER, observed_id: USER_PEER },
    ]);
    return {
      content: [{ type: 'text' as const, text: ok ? 'Conclusion saved.' : 'Failed to save conclusion.' }],
    };
  },
);

async function main(): Promise<void> {
  log(`Starting Honcho MCP server (URL: ${HONCHO_URL}, workspace: ${WORKSPACE})`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the MCP server compiles**

Run: `cd container/agent-runner && npx tsc --noEmit src/honcho-mcp-stdio.ts 2>&1 | head -20`
Expected: No errors (or only import resolution warnings that are fine at compile time)

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/honcho-mcp-stdio.ts
git commit -m "feat: add Honcho MCP stdio server with 4 user-context tools"
```

---

## Task 4: Add HONCHO_URL to Container Runner (Host Side)

**Files:**
- Modify: `src/container-runner.ts:55,307-332`
- Modify: `src/container-runner.test.ts:493-601`

Add HONCHO_URL env var injection following the Hindsight pattern. Remove SIMPLEMEM_URL.

- [ ] **Step 1: Write failing test for HONCHO_URL injection**

In `src/container-runner.test.ts`, find the `afterEach` block (around line 494) and add `HONCHO_URL` to cleanup. Then add a new test after the existing SIMPLEMEM tests:

Add to the `afterEach` at line ~494:
```typescript
    delete process.env.HONCHO_URL;
```

Add new test (after the Hindsight tests, around line 650):
```typescript
  it('rewrites localhost to host gateway in HONCHO_URL', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      HONCHO_URL: 'http://localhost:8010',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const honchoVar = envVars.find((a) => a.startsWith('HONCHO_URL='));
    expect(honchoVar).toBeDefined();
    expect(honchoVar).toContain('host.docker.internal');
    expect(honchoVar).not.toContain('localhost');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    vi.mocked(readEnvFile).mockReturnValue({});
  });

  it('skips HONCHO_URL when URL is malformed', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      HONCHO_URL: 'not-a-valid-url',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const honchoVar = envVars.find((a) => a.startsWith('HONCHO_URL='));
    expect(honchoVar).toBeUndefined();

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    vi.mocked(readEnvFile).mockReturnValue({});
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw && bun test src/container-runner.test.ts 2>&1 | tail -20`
Expected: New tests FAIL (HONCHO_URL not injected yet)

- [ ] **Step 3: Add HONCHO_URL injection to container-runner.ts**

In `src/container-runner.ts`, after the Hindsight block (line ~396), add:

```typescript
  // Pass Honcho user-modeling API URL (for session context and peer tools)
  const honchoEnv = readEnvFile(['HONCHO_URL']);
  const honchoUrl = process.env.HONCHO_URL || honchoEnv.HONCHO_URL;
  if (honchoUrl) {
    try {
      const parsed = new URL(honchoUrl);
      const hostname =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `HONCHO_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn(
        { honchoUrl },
        'Invalid HONCHO_URL, skipping Honcho',
      );
    }
  }
```

- [ ] **Step 4: Remove SIMPLEMEM_URL injection from container-runner.ts**

Delete lines 307-332 (the entire SIMPLEMEM_URL block starting with `// Pass SimpleMem memory URL`).

Also update the redaction regex at line 55 — remove `SIMPLEMEM_URL`:
```typescript
  const sensitiveKeys =
    /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|CREDENTIAL_PROXY_TOKEN)=/i;
```

- [ ] **Step 5: Remove SIMPLEMEM_URL tests from container-runner.test.ts**

Delete the two SimpleMem tests (lines 553-601):
- `it('rewrites localhost to host gateway in SIMPLEMEM_URL', ...)`
- `it('skips SIMPLEMEM_URL when URL is malformed', ...)`

Remove `SIMPLEMEM_URL` from the `afterEach` cleanup (line 497).

- [ ] **Step 6: Run all container-runner tests**

Run: `cd /Users/mgandal/Agents/nanoclaw && bun test src/container-runner.test.ts 2>&1 | tail -30`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: inject HONCHO_URL into containers, remove SIMPLEMEM_URL"
```

---

## Task 5: Integrate Honcho into Agent Runner

**Files:**
- Modify: `container/agent-runner/src/index.ts:191-265,559-600,726-957`

This is the core integration — wire HonchoSession into the query loop.

- [ ] **Step 1: Add imports at top of agent-runner index.ts**

After the existing imports (line ~5), add:

```typescript
import { createHonchoClient } from './honcho-client.js';
import { HonchoSession } from './honcho-session.js';
```

- [ ] **Step 2: Remove simplemem from buildMcpServers and add honcho**

In `buildMcpServers()` (line 216-230), replace the simplemem block:

Remove:
```typescript
  if (process.env.SIMPLEMEM_URL) {
    try {
      const smUrl = new URL(process.env.SIMPLEMEM_URL);
      const smToken = smUrl.searchParams.get('token');
      smUrl.searchParams.delete('token');
      servers.simplemem = {
        type: 'http',
        url: smUrl.toString(),
        headers: {
          Accept: 'application/json, text/event-stream',
          ...(smToken ? { Authorization: `Bearer ${smToken}` } : {}),
        },
      };
    } catch { /* invalid URL, skip */ }
  }
```

Add in its place:
```typescript
  if (process.env.HONCHO_URL) {
    const honchoMcpPath = path.join(path.dirname(mcpServerPath), 'honcho-mcp-stdio.js');
    servers.honcho = {
      command: 'node',
      args: [honchoMcpPath],
      env: {
        HONCHO_URL: process.env.HONCHO_URL,
        HONCHO_WORKSPACE: 'nanoclaw',
        HONCHO_USER_PEER: 'mgandal',
        HONCHO_AI_PEER: containerInput.groupFolder.replace(/^telegram_/, ''),
      },
    };
  }
```

- [ ] **Step 3: Update allowedTools list**

In the `allowedTools` array (around line 594), replace `'mcp__simplemem__*'` with `'mcp__honcho__*'`:

Replace:
```typescript
        'mcp__simplemem__*',
```
With:
```typescript
        'mcp__honcho__*',
```

- [ ] **Step 4: Initialize HonchoSession in main()**

In `main()` (around line 726), after `const mcpServerPath = ...` (line 755) and before the query loop, add Honcho initialization:

```typescript
  // Initialize Honcho session (skip for scheduled tasks — don't pollute user models)
  let honchoSession: HonchoSession | null = null;
  if (process.env.HONCHO_URL && !containerInput.isScheduledTask) {
    const honchoClient = createHonchoClient(process.env.HONCHO_URL);
    const aiPeer = containerInput.groupFolder.replace(/^telegram_/, '');
    honchoSession = new HonchoSession(honchoClient, {
      workspace: 'nanoclaw',
      userPeer: 'mgandal',
      aiPeer,
      sessionId: containerInput.sessionId || `new-${Date.now()}`,
    });
    await honchoSession.initialize();

    // Initial prefetch (blocking on first turn — no cached context yet)
    if (honchoSession.isReady()) {
      await honchoSession.prefetchContext();
    }
  }
```

- [ ] **Step 5: Inject context before query, sync + prefetch after**

In the query loop (around line 903), modify the `while (true)` loop body.

Before `runQuery()` is called, inject context into the prompt:
```typescript
      // Inject Honcho context into prompt (if available)
      if (honchoSession?.isReady()) {
        prompt = honchoSession.injectContext(prompt);
      }
```

After `runQuery()` returns and before `waitForIpcMessage()`, add sync and prefetch:
```typescript
      // Sync messages to Honcho (fire-and-forget)
      if (honchoSession?.isReady() && queryResult.newSessionId) {
        // Update session ID if it changed (compaction)
        if (queryResult.newSessionId !== containerInput.sessionId) {
          honchoSession.updateSessionId(queryResult.newSessionId).catch((err) => {
            log(`Honcho session update failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }

      // Background prefetch for next turn
      const prefetchPromise = honchoSession?.isReady()
        ? honchoSession.prefetchContext()
        : Promise.resolve();
```

Then where `waitForIpcMessage()` is called, race it with the prefetch:
```typescript
      // Wait for prefetch to complete (with 3s timeout) before next turn
      await Promise.race([
        prefetchPromise,
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
```

- [ ] **Step 6: Add sync on close sentinel**

Near the close sentinel handlers (line ~928 and ~940), before the `break`, add:

```typescript
        // Flush pending Honcho messages before exit
        // (syncMessages is a no-op if nothing pending)
```

Note: The current architecture syncs after each `runQuery`, so there's nothing pending at close time. This is a safety comment — no additional code needed.

- [ ] **Step 7: Verify agent-runner compiles**

Run: `cd container/agent-runner && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: integrate Honcho session into agent-runner query loop"
```

---

## Task 6: Host-Side Bootstrap and Health Checks

**Files:**
- Modify: `src/index.ts:836-847,914-938`
- Modify: `src/health-monitor.test.ts:471-473,521-537`

Add Honcho workspace bootstrap at startup. Replace SimpleMem health check with Honcho.

- [ ] **Step 1: Add Honcho workspace bootstrap to src/index.ts**

Near the top of the main startup function (after the health monitor setup around line 910), add:

```typescript
  // Bootstrap Honcho workspace (create if not exists)
  const honchoBootstrapEnv = readEnvFile(['HONCHO_URL']);
  const honchoBootstrapUrl = process.env.HONCHO_URL || honchoBootstrapEnv.HONCHO_URL;
  if (honchoBootstrapUrl) {
    try {
      const res = await fetch(`${honchoBootstrapUrl}/v3/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'nanoclaw' }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        logger.info('Honcho workspace "nanoclaw" created');
      } else if (res.status === 409) {
        logger.debug('Honcho workspace "nanoclaw" already exists');
      } else {
        logger.warn({ status: res.status }, 'Honcho workspace bootstrap unexpected status');
      }
    } catch (err) {
      logger.warn({ err }, 'Honcho workspace bootstrap failed (Honcho may be down)');
    }
  }
```

- [ ] **Step 2: Remove SimpleMem fix handler**

Delete lines 836-847 (the `mcp-simplemem` fix handler block):

```typescript
  healthMonitor.addFixHandler({
    id: 'mcp-simplemem',
    service: 'mcp:SimpleMem',
    fixScript: path.join(fixScriptsDir, 'restart-simplemem.sh'),
    verify: {
      type: 'http',
      url: 'http://localhost:8200/api/health',
      expectStatus: 200,
    },
    cooldownMs: 120_000,
    maxAttempts: 2,
  });
```

- [ ] **Step 3: Replace SimpleMem health check endpoint with Honcho**

In the `mcpEndpoints` array (line ~918), replace the SimpleMem entry:

Replace:
```typescript
    {
      name: 'SimpleMem',
      url: process.env.SIMPLEMEM_URL,
      healthUrl: 'http://localhost:8200/api/health',
    },
```
With:
```typescript
    {
      name: 'Honcho',
      url: honchoBootstrapUrl ? `${honchoBootstrapUrl}/v3/workspaces/list` : undefined,
    },
```

Also update the env fallback block (line ~930-938). Remove `SIMPLEMEM_URL` from the `readEnvFile` call and the index-based assignment. Add `HONCHO_URL`:

Replace:
```typescript
    const envUrls = readEnvFile([
      'SIMPLEMEM_URL',
      'APPLE_NOTES_URL',
      'TODOIST_URL',
    ]);
    if (!mcpEndpoints[1].url) mcpEndpoints[1].url = envUrls.SIMPLEMEM_URL;
    if (!mcpEndpoints[2].url) mcpEndpoints[2].url = envUrls.APPLE_NOTES_URL;
    if (!mcpEndpoints[3].url) mcpEndpoints[3].url = envUrls.TODOIST_URL;
```
With:
```typescript
    const envUrls = readEnvFile([
      'HONCHO_URL',
      'APPLE_NOTES_URL',
      'TODOIST_URL',
    ]);
    if (!mcpEndpoints[1].url && envUrls.HONCHO_URL) {
      mcpEndpoints[1].url = `${envUrls.HONCHO_URL}/v3/workspaces/list`;
    }
    if (!mcpEndpoints[2].url) mcpEndpoints[2].url = envUrls.APPLE_NOTES_URL;
    if (!mcpEndpoints[3].url) mcpEndpoints[3].url = envUrls.TODOIST_URL;
```

- [ ] **Step 4: Update health-monitor.test.ts**

In `src/health-monitor.test.ts`, find the SimpleMem fix handler test references (around lines 471-473, 521-537) and remove them. Replace with equivalent Honcho references if the tests check fix handler IDs.

Search for `mcp-simplemem` and `restart-simplemem.sh` — remove those test blocks entirely.

- [ ] **Step 5: Run tests**

Run: `cd /Users/mgandal/Agents/nanoclaw && bun test src/health-monitor.test.ts 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/health-monitor.test.ts
git commit -m "feat: add Honcho bootstrap and health check, remove SimpleMem health/fix handlers"
```

---

## Task 7: Update .env

**Files:**
- Modify: `.env`

- [ ] **Step 1: Remove SIMPLEMEM_URL, add HONCHO_URL**

In `.env`, find the `SIMPLEMEM_URL=...` line and replace it:

Remove:
```
SIMPLEMEM_URL=http://localhost:8200/mcp/sse?token=eyJ...
```

Add:
```
HONCHO_URL=http://localhost:8010
```

- [ ] **Step 2: Commit**

```bash
git add .env
git commit -m "chore: replace SIMPLEMEM_URL with HONCHO_URL in .env"
```

---

## Task 8: Delete SimpleMem Ingest Scripts

**Files:**
- Delete: `scripts/sync/simplemem-ingest.py`
- Delete: `scripts/sync/vault-ingest.py`
- Delete: `scripts/sync/claude-history-ingest.py`
- Delete: `scripts/sync/telegram-history-ingest.py`
- Delete: `scripts/sync/apple-notes-ingest.py`
- Delete: `scripts/fixes/restart-simplemem.sh`

- [ ] **Step 1: Delete the files**

```bash
git rm scripts/sync/simplemem-ingest.py
git rm scripts/sync/vault-ingest.py
git rm scripts/sync/claude-history-ingest.py
git rm scripts/sync/telegram-history-ingest.py
git rm scripts/sync/apple-notes-ingest.py
git rm scripts/fixes/restart-simplemem.sh
```

- [ ] **Step 2: Delete ingest state files (untracked)**

```bash
rm -f scripts/sync/vault-ingest-state.json
rm -f scripts/sync/claude-history-state.json
rm -f scripts/sync/telegram-history-state.json
rm -f scripts/sync/apple-notes-ingest-state.json
```

- [ ] **Step 3: Commit**

```bash
git add -A scripts/sync/ scripts/fixes/
git commit -m "chore: delete SimpleMem ingest scripts and state files"
```

---

## Task 9: Simplify sync-all.sh

**Files:**
- Modify: `scripts/sync/sync-all.sh`

Remove SimpleMem ingest steps (4, 5, 6, 9, 11), renumber remaining steps.

- [ ] **Step 1: Rewrite sync-all.sh**

Replace the entire file with:

```bash
#!/bin/bash
# Master sync script: email + QMD indexing + Apple Notes export
# Runs every 8 hours via launchd
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/sync.log"
PYTHON3="/Users/mgandal/.pyenv/versions/anaconda3-2024.02-1/bin/python3"

# Redirect all output to log (and stdout for launchd)
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "=========================================="
echo "SYNC RUN: $(date)"
echo "=========================================="

# Ensure pip packages are available
export PATH="/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export GMAIL_MIGRATE_USER="mikejg1838@gmail.com"

ERRORS=0

# --- Pre-flight: verify dependencies are reachable ---
echo ""
echo "[pre-flight] Checking sync dependencies..."
bash "$SCRIPT_DIR/sync-health-check.sh" 2>&1 | grep -E '✓|✗|⚠|Results'
echo ""

# --- Step 1: Exchange email sync (DISABLED — migration complete) ---
echo ""
echo "[1/6] Exchange email sync... SKIPPED (migration complete, requires Full Disk Access)"

# --- Step 2: Gmail sync (mgandal → mikejg1838) ---
echo ""
echo "[2/6] Gmail sync: mgandal@gmail.com → mikejg1838@gmail.com..."
$PYTHON3 "$SCRIPT_DIR/gmail-sync.py" 2>&1
EC=$?
if [ $EC -ne 0 ]; then
    echo "[2/6] WARNING: Gmail sync had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi

# --- Step 3: Calendar sync (DISABLED — causes repeated email notifications) ---
echo ""
echo "[3/6] Calendar sync... SKIPPED (disabled — causes repeated email notifications)"

# --- Step 4: Apple Notes re-export to markdown ---
echo ""
echo "[4/6] Apple Notes re-export..."
EXPORT_SCRIPT="$HOME/.cache/apple-notes-mcp/export-notes.js"
if [ -f "$EXPORT_SCRIPT" ]; then
    osascript -e 'tell application "Notes" to activate' 2>/dev/null
    sleep 2
    node "$EXPORT_SCRIPT" 2>&1 | tail -5
    EC=$?
    osascript -e 'tell application "Notes" to quit' 2>/dev/null
    if [ $EC -ne 0 ]; then
        echo "[4/6] WARNING: Apple Notes export had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[4/6] SKIP: export-notes.js not found"
fi

# --- Step 5: QMD update (re-scan collections for new/changed files) ---
echo ""
# BUN_INSTALL in ~/.bash_profile causes qmd's shim to use bun instead of node,
# which crashes on sqlite-vec extension loading. Force node runtime.
echo "[5/6] QMD update..."
if command -v qmd &>/dev/null; then
    BUN_INSTALL= qmd update 2>&1
    EC=$?
    if [ $EC -ne 0 ]; then
        echo "[5/6] WARNING: QMD update had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[5/6] SKIP: qmd not found in PATH"
fi

# --- Step 6: QMD embed (vectorize pending docs) ---
echo ""
echo "[6/6] QMD embed..."
if command -v qmd &>/dev/null; then
    BUN_INSTALL= qmd embed 2>&1
    EC=$?
    if [ $EC -ne 0 ]; then
        echo "[6/6] WARNING: QMD embed had errors (exit $EC)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[6/6] SKIP: qmd not found in PATH"
fi

echo ""
echo "=========================================="
echo "SYNC COMPLETE: $(date) (errors: $ERRORS)"
echo "=========================================="

# Trim log file if over 1MB
if [ -f "$LOG_FILE" ]; then
    SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null)
    if [ "$SIZE" -gt 1048576 ] 2>/dev/null; then
        tail -5000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
fi

exit $ERRORS
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sync/sync-all.sh
git commit -m "chore: simplify sync-all.sh, remove SimpleMem ingest steps"
```

---

## Task 10: Update Documentation and Memory

**Files:**
- Modify: `CLAUDE.md` (MCP servers section)
- Modify: project memory files

- [ ] **Step 1: Update CLAUDE.md**

In the Key Files table or MCP servers section, find any SimpleMem references and replace with Honcho. The MCP Servers in Agent Runner list should be updated to show `honcho` instead of `simplemem`.

- [ ] **Step 2: Update MEMORY.md**

Update the project memory index to reflect:
- SimpleMem section → mark as deprecated/removed
- Add Honcho section with workspace, peers, session mapping
- Update sync script references (now 6 steps instead of 11)
- Update MCP servers list (remove simplemem, add honcho)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md and memory for SimpleMem→Honcho migration"
```

---

## Task 11: Rebuild Container and End-to-End Verification

**Files:** None (verification only)

- [ ] **Step 1: Rebuild the agent container**

```bash
cd /Users/mgandal/Agents/nanoclaw && ./container/build.sh
```

Expected: Build succeeds with new honcho-client, honcho-session, honcho-mcp-stdio compiled

- [ ] **Step 2: Delete cached agent-runner source**

Force all groups to pick up the new agent-runner:

```bash
rm -rf data/sessions/*/agent-runner-src/
```

- [ ] **Step 3: Restart NanoClaw**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 4: Verify Honcho workspace exists**

```bash
curl -s -X POST http://localhost:8010/v3/workspaces/list -H "Content-Type: application/json" -d '{}' | python3 -m json.tool
```

Expected: `nanoclaw` workspace appears in the list

- [ ] **Step 5: Send a test message via Telegram**

Send a message to any registered group (e.g., CLAIRE). Then verify:

```bash
# Check Honcho sessions were created
curl -s -X POST http://localhost:8010/v3/workspaces/nanoclaw/sessions/list \
  -H "Content-Type: application/json" -d '{}' | python3 -m json.tool

# Check messages were synced
# (use the session ID from the previous output)
```

- [ ] **Step 6: Verify SimpleMem is no longer referenced**

```bash
grep -r "simplemem\|SIMPLEMEM" src/ container/agent-runner/src/ --include="*.ts" | grep -v test | grep -v ".d.ts"
```

Expected: No matches (only test files may reference it for historical reasons)

- [ ] **Step 7: Verify graceful degradation**

Stop Honcho temporarily and send a message:

```bash
docker stop honcho-api-1
# Send a test message via Telegram — should still work (Honcho is optional)
docker start honcho-api-1
```

Expected: Agent responds normally without Honcho context. Logs show `[honcho] ... failed: ...` warnings.

- [ ] **Step 8: Commit any fixups**

If any issues were found, fix and commit.
