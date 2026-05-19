import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { knowledgeSearchHandler } from './knowledge-search.js';
import type { IpcHandlerContext } from '../handler.js';

function buildCtx(
  overrides: Partial<IpcHandlerContext> = {},
): IpcHandlerContext {
  return {
    sourceGroup: 'telegram_claire',
    isMain: true,
    baseGroup: 'telegram_claire',
    agentName: 'claire',
    requestId: 'req-test-001',
    registeredGroups: {},
    deps: {} as any,
    dataDir: '/tmp/test',
    ...overrides,
  };
}

describe('knowledgeSearchHandler.parse', () => {
  it('returns null for non-object input', () => {
    expect(knowledgeSearchHandler.parse(null)).toBeNull();
    expect(knowledgeSearchHandler.parse(42)).toBeNull();
    expect(knowledgeSearchHandler.parse('s')).toBeNull();
  });

  it('returns null for missing query field', () => {
    expect(knowledgeSearchHandler.parse({})).toBeNull();
  });

  it('returns null for empty-string query (after trim)', () => {
    expect(knowledgeSearchHandler.parse({ query: '   ' })).toBeNull();
  });

  it('clamps max_results to [1, 20]: 0 → 1, 50 → 20, 5 → 5', () => {
    expect(
      knowledgeSearchHandler.parse({ query: 'x', max_results: 0 })!.max_results,
    ).toBe(1);
    expect(
      knowledgeSearchHandler.parse({ query: 'x', max_results: 50 })!
        .max_results,
    ).toBe(20);
    expect(
      knowledgeSearchHandler.parse({ query: 'x', max_results: 5 })!.max_results,
    ).toBe(5);
  });

  it('defaults max_results to 5 when omitted', () => {
    expect(knowledgeSearchHandler.parse({ query: 'x' })!.max_results).toBe(5);
  });
});

describe('knowledgeSearchHandler.authorize', () => {
  it('returns skipGate=true for non-agent caller', () => {
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const auth = knowledgeSearchHandler.authorize(
      input,
      buildCtx({ agentName: null }),
    );
    expect(auth).not.toBeNull();
    expect((auth as any).skipGate).toBe(true);
    expect((auth as any).target).toBe('agent-knowledge');
  });

  it('omits skipGate for agent caller (gate writes audit row)', () => {
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const auth = knowledgeSearchHandler.authorize(
      input,
      buildCtx({ agentName: 'claire' }),
    );
    expect(auth).not.toBeNull();
    expect((auth as any).skipGate).toBeUndefined();
    expect((auth as any).target).toBe('agent-knowledge');
    expect((auth as any).auditSummary).toContain('q');
  });
});

describe('knowledgeSearchHandler.execute', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: returns success with raw results text', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: { content: [{ text: '[{"topic":"x"}]' }] },
      }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).executed).toBe(true);
    expect((result as any).result.success).toBe(true);
    expect((result as any).result.results).toContain('"topic"');
  });

  it('CRITICAL — response.ok=false produces {success:false}, NOT silent {success:true,results:""}', async () => {
    // Round-1-amended Critical fix. skill_search lacks this check and would
    // parse the 503 JSON body, find no content[0].text, and return
    // {success:true, results:""} — a silent false-success. We must NOT
    // inherit that bug. With the response.ok check, the handler throws
    // → catch → {success:false}.
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'bridge down' }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).executed).toBe(true);
    expect((result as any).result.success).toBe(false);
    expect((result as any).result.message).toContain('503');
  });

  it('fetch throws (ECONNREFUSED) → {success:false, message}', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).executed).toBe(true);
    expect((result as any).result.success).toBe(false);
    expect((result as any).result.message).toContain('ECONNREFUSED');
  });

  it('QMD response missing content field → {success:true, results:""}', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: {} }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).result.success).toBe(true);
    expect((result as any).result.results).toBe('');
  });

  it('sends BOTH vec and lex sub-queries (knowledge_search differs from skill_search)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { content: [{ text: '[]' }] } }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'apa regulation' })!;
    await knowledgeSearchHandler.execute(input, buildCtx());
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const searches = requestBody.params.arguments.searches;
    expect(searches).toHaveLength(2);
    expect(searches.map((s: any) => s.type).sort()).toEqual(['lex', 'vec']);
  });

  it('uses agent-knowledge collection (not skill-catalog)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { content: [{ text: '[]' }] } }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    await knowledgeSearchHandler.execute(input, buildCtx());
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.params.arguments.collections).toEqual([
      'agent-knowledge',
    ]);
  });

  it('IMPORTANT #2 — HTTP 200 with JSON-RPC error body → {success:false}, NOT silent {success:true,results:""}', async () => {
    // Sibling silent-false-success class to the response.ok bug, one envelope
    // layer deeper. QMD can return 200 with {"jsonrpc":"2.0","error":{...}}
    // for collection-not-found, malformed args, MCP server exceptions, etc.
    // Without the json.error check, json.result is undefined and the optional
    // chain collapses to '', producing {success:true, results:""} — caller
    // cannot distinguish from "no findings". This test pins the guard.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'collection not found' },
      }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).executed).toBe(true);
    expect((result as any).result.success).toBe(false);
    expect((result as any).result.message).toContain('QMD MCP error');
    expect((result as any).result.message).toContain('collection not found');
    expect((result as any).result.message).toContain('-32000');
  });

  it('ROUND-2 IMPORTANT #2 — bare envelope (no result, no error) → {success:false}, NOT silent {success:true,""}', async () => {
    // Symmetric closure to the json.error guard. A malformed MCP response
    // with neither `result` nor `error` (e.g., {"jsonrpc":"2.0","id":1})
    // would otherwise silently fall through: json.result is undefined, the
    // optional chain collapses to '', caller sees {success:true, results:''}.
    // CRITICAL pin: this test must NOT regress the existing `{result:{}}`
    // test at line 134-144, which represents a legitimate empty search
    // (json.result is truthy, just has empty content).
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1 }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).executed).toBe(true);
    expect((result as any).result.success).toBe(false);
    expect((result as any).result.message).toContain('malformed envelope');
  });

  it('IMPORTANT #4 — AbortError (timeout) → "Knowledge search timed out", not opaque "operation was aborted"', async () => {
    // AbortSignal.timeout() throws a DOMException with name='AbortError'.
    // skill_search differentiates this in its catch (skills.ts:166-181) so
    // the agent gets a self-explanatory message and can choose to back off.
    // Without differentiation, err.message is "The operation was aborted",
    // which is indistinguishable from a non-timeout abort.
    const abortErr = new DOMException(
      'The operation was aborted',
      'AbortError',
    );
    fetchSpy.mockRejectedValueOnce(abortErr);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).executed).toBe(true);
    expect((result as any).result.success).toBe(false);
    expect((result as any).result.message).toBe(
      'Knowledge search timed out (15s)',
    );
  });
});
