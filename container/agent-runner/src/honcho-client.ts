/**
 * Honcho v3 HTTP Client for NanoClaw agent containers
 *
 * Typed HTTP wrapper around the Honcho v3 REST API.
 * Uses native fetch() with AbortController timeouts.
 * All methods degrade gracefully: return null/empty/false on failure, never throw.
 */

// ─── Timeout constants ────────────────────────────────────────────────────────

/** CRUD operations: workspace/peer/session create */
const TIMEOUT_CRUD_MS = 5_000;
/** Read operations: card, search, messages */
const TIMEOUT_READ_MS = 10_000;
/** Context fetch */
const TIMEOUT_CONTEXT_MS = 30_000;
/** Dialectic (peerChat) — can be slow with local Ollama */
const TIMEOUT_DIALECTIC_MS = 60_000;

/** Max chars per message before chunking */
const CHUNK_MAX_CHARS = 25_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HonchoMessage {
  content: string;
  peer_id: string;
}

export interface HonchoMessageResponse {
  id: string;
  content: string;
  session_id: string;
  peer_id: string;
  created_at: string;
  [key: string]: unknown;
}

export interface HonchoConclusion {
  content: string;
  observer_id: string;
  observed_id: string;
}

export interface HonchoWorkspace {
  id: string;
  metadata: Record<string, unknown>;
  configuration: Record<string, unknown>;
  created_at: string;
}

export interface HonchoPeer {
  id: string;
  name?: string;
  workspace_id: string;
  created_at: string;
  metadata: Record<string, unknown>;
  configuration: Record<string, unknown>;
}

export interface HonchoPeerList {
  items: HonchoPeer[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

export interface HonchoContext {
  peer_id: string;
  target_id: string;
  representation: string | null;
  peer_card: string | null;
}

export interface HonchoClient {
  baseUrl: string;

  /** Ensure workspace exists (creates if missing). Returns true on success or if already exists. */
  ensureWorkspace(workspaceId: string): Promise<boolean>;

  /** Ensure peer exists. Returns the peer id string or null on failure. */
  ensurePeer(workspaceId: string, peerId: string): Promise<string | null>;

  /** Ensure session exists. Returns true on success or if already exists. */
  ensureSession(workspaceId: string, sessionId: string): Promise<boolean>;

  /** Add messages to a session. Chunks content >25k chars. Returns array of created messages. */
  addMessages(workspaceId: string, sessionId: string, messages: HonchoMessage[]): Promise<HonchoMessageResponse[]>;

  /** Get context representation for a peer. Returns empty string on failure. */
  getPeerContext(workspaceId: string, peerId: string, sessionId?: string): Promise<string>;

  /** Get the peer card for a peer. Returns empty string on failure. */
  getPeerCard(workspaceId: string, peerId: string): Promise<string>;

  /** Search messages observed by a peer. Returns array (possibly empty) on failure. */
  peerSearch(workspaceId: string, peerId: string, query: string, observedId: string): Promise<HonchoMessageResponse[]>;

  /** Send a dialectic chat query to a peer. Returns empty string on failure. */
  peerChat(workspaceId: string, peerId: string, query: string): Promise<string>;

  /** Add conclusions (derived insights) to a workspace. Returns true on success. */
  addConclusions(workspaceId: string, conclusions: HonchoConclusion[]): Promise<boolean>;
}

// ─── Internal fetch helper ────────────────────────────────────────────────────

async function honchoFetch(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Chunking helper ──────────────────────────────────────────────────────────

function chunkMessages(messages: HonchoMessage[]): HonchoMessage[][] {
  const batches: HonchoMessage[][] = [];
  let currentBatch: HonchoMessage[] = [];

  for (const msg of messages) {
    if (msg.content.length <= CHUNK_MAX_CHARS) {
      currentBatch.push(msg);
    } else {
      // Flush current batch if any
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      // Split long message into chunks.
      // Reserve space for the [continued N/M] prefix within CHUNK_MAX_CHARS.
      // Worst-case prefix: "[continued 99/99] " = 18 chars; use 20 for safety.
      const MAX_PREFIX_LEN = 20;
      const sliceSize = CHUNK_MAX_CHARS - MAX_PREFIX_LEN;
      const text = msg.content;
      const numChunks = Math.ceil(text.length / sliceSize);
      for (let i = 0; i < numChunks; i++) {
        const slice = text.slice(i * sliceSize, (i + 1) * sliceSize);
        const prefix = `[continued ${i + 1}/${numChunks}] `;
        batches.push([{ content: prefix + slice, peer_id: msg.peer_id }]);
      }
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createHonchoClient(baseUrl: string): HonchoClient {
  const base = baseUrl.replace(/\/$/, '');

  function jsonPost(url: string, body: unknown, timeoutMs: number): Promise<Response> {
    return honchoFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  function jsonGet(url: string, timeoutMs: number): Promise<Response> {
    return honchoFetch(url, { method: 'GET' }, timeoutMs);
  }

  return {
    baseUrl: base,

    // ─── ensureWorkspace ──────────────────────────────────────────────────────

    async ensureWorkspace(workspaceId: string): Promise<boolean> {
      try {
        const res = await jsonPost(`${base}/v3/workspaces`, { id: workspaceId }, TIMEOUT_CRUD_MS);
        if (res.ok || res.status === 409) return true;
        return false;
      } catch {
        return false;
      }
    },

    // ─── ensurePeer ───────────────────────────────────────────────────────────

    async ensurePeer(workspaceId: string, peerName: string): Promise<string | null> {
      try {
        const res = await jsonPost(`${base}/v3/workspaces/${workspaceId}/peers`, { name: peerName }, TIMEOUT_CRUD_MS);
        if (res.ok) {
          const data = await res.json() as HonchoPeer;
          return data.id;
        }
        if (res.status === 409) {
          // Already exists — fetch peer list to find the id by name
          try {
            const listRes = await jsonPost(
              `${base}/v3/workspaces/${workspaceId}/peers/list`,
              {},
              TIMEOUT_READ_MS,
            );
            if (listRes.ok) {
              const list = await listRes.json() as HonchoPeerList;
              const found = list.items.find(p => p.name === peerName || p.id === peerName);
              if (found) return found.id;
            }
          } catch {
            // fall through to null
          }
          return null;
        }
        return null;
      } catch {
        return null;
      }
    },

    // ─── ensureSession ────────────────────────────────────────────────────────

    async ensureSession(workspaceId: string, sessionId: string): Promise<boolean> {
      try {
        const res = await jsonPost(
          `${base}/v3/workspaces/${workspaceId}/sessions`,
          { id: sessionId },
          TIMEOUT_CRUD_MS,
        );
        if (res.ok || res.status === 409) return true;
        return false;
      } catch {
        return false;
      }
    },

    // ─── addMessages ──────────────────────────────────────────────────────────

    async addMessages(
      workspaceId: string,
      sessionId: string,
      messages: HonchoMessage[],
    ): Promise<HonchoMessageResponse[]> {
      const batches = chunkMessages(messages);
      const allResults: HonchoMessageResponse[] = [];

      for (const batch of batches) {
        try {
          const res = await jsonPost(
            `${base}/v3/workspaces/${workspaceId}/sessions/${sessionId}/messages`,
            { messages: batch },
            TIMEOUT_READ_MS,
          );
          if (res.ok) {
            const data = await res.json() as HonchoMessageResponse[];
            allResults.push(...data);
          }
        } catch {
          // graceful degradation — skip failed batch, continue
        }
      }

      return allResults;
    },

    // ─── getPeerContext ───────────────────────────────────────────────────────

    async getPeerContext(workspaceId: string, peerId: string, sessionId?: string): Promise<string> {
      try {
        const url = sessionId
          ? `${base}/v3/workspaces/${workspaceId}/peers/${peerId}/context?session_id=${encodeURIComponent(sessionId)}`
          : `${base}/v3/workspaces/${workspaceId}/peers/${peerId}/context`;
        const res = await jsonGet(url, TIMEOUT_CONTEXT_MS);
        if (!res.ok) return '';
        const data = await res.json() as HonchoContext;
        return data.representation ?? '';
      } catch {
        return '';
      }
    },

    // ─── getPeerCard ──────────────────────────────────────────────────────────

    async getPeerCard(workspaceId: string, peerId: string): Promise<string> {
      try {
        const res = await jsonGet(
          `${base}/v3/workspaces/${workspaceId}/peers/${peerId}/card`,
          TIMEOUT_READ_MS,
        );
        if (!res.ok) return '';
        const data = await res.json() as { peer_card: string | null };
        return data.peer_card ?? '';
      } catch {
        return '';
      }
    },

    // ─── peerSearch ───────────────────────────────────────────────────────────

    async peerSearch(
      workspaceId: string,
      peerId: string,
      query: string,
      observedId: string,
    ): Promise<HonchoMessageResponse[]> {
      try {
        const res = await jsonPost(
          `${base}/v3/workspaces/${workspaceId}/peers/${peerId}/search`,
          { query, observed: observedId },
          TIMEOUT_READ_MS,
        );
        if (!res.ok) return [];
        return await res.json() as HonchoMessageResponse[];
      } catch {
        return [];
      }
    },

    // ─── peerChat ─────────────────────────────────────────────────────────────

    async peerChat(workspaceId: string, peerId: string, query: string): Promise<string> {
      try {
        const res = await jsonPost(
          `${base}/v3/workspaces/${workspaceId}/peers/${peerId}/chat`,
          { query },
          TIMEOUT_DIALECTIC_MS,
        );
        if (!res.ok) return '';
        return await res.json() as string;
      } catch {
        return '';
      }
    },

    // ─── addConclusions ───────────────────────────────────────────────────────

    async addConclusions(workspaceId: string, conclusions: HonchoConclusion[]): Promise<boolean> {
      try {
        const res = await jsonPost(
          `${base}/v3/workspaces/${workspaceId}/conclusions`,
          { conclusions },
          TIMEOUT_CRUD_MS,
        );
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
