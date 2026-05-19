import { getBridgeToken } from '../../bridge-auth.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  query: string;
  max_results: number;
}

type Result = {
  executed: true;
  result:
    | { success: true; results: string; query: string }
    | { success: false; message: string };
};

export const knowledgeSearchHandler: IpcHandler<Input, Result> = {
  type: 'knowledge_search',
  responseKind: 'result',
  resultsDirName: 'knowledge_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const query = typeof r.query === 'string' ? r.query.trim() : '';
    if (query.length === 0) return null;
    const rawMax = typeof r.max_results === 'number' ? r.max_results : 5;
    const max_results = Math.min(20, Math.max(1, Math.round(rawMax)));
    return { query, max_results };
  },

  authorize(input, ctx) {
    return {
      target: 'agent-knowledge',
      auditSummary: input.query.slice(0, 100),
      notifySummary: `searched knowledge: ${input.query.slice(0, 80)}`,
      payloadForStaging: {
        type: 'knowledge_search',
        query: input.query,
      },
      // Non-agent callers (operator scripts, host-side IPC) skip the gate.
      // Agent callers go through gateAndStage so the search shows up in
      // agent_actions for forensic review. Same pattern intent as the spec §3.2.
      ...(ctx.agentName === null ? { skipGate: true as const } : {}),
    };
  },

  async execute(input, ctx): Promise<Result> {
    try {
      const response = await fetch('http://localhost:8181/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getBridgeToken()}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'query',
            arguments: {
              // Both vec and lex — paraphrased queries need semantic matching
              // (vec) while specialized vocabulary needs exact-term matching (lex).
              // skill_search uses lex-only because skill names are exact strings;
              // knowledge findings are mixed prose.
              searches: [
                { type: 'vec', query: input.query },
                { type: 'lex', query: input.query },
              ],
              collections: ['agent-knowledge'],
              intent: input.query,
              limit: input.max_results,
            },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      // ROUND-1 AMENDMENT §4.2 (CRITICAL): fetch does NOT throw on non-2xx.
      // skill_search skips this check (src/ipc/handlers/skills.ts:96-117) and
      // gets away with it only because empty 503 bodies fail JSON parse and
      // hit its catch. QMD CAN return 503 with a valid JSON error body —
      // without this guard, the handler would parse it successfully, find
      // no content[0].text, and return {success:true, results:""} — a silent
      // false-success the caller would interpret as "no results found".
      if (!response.ok) {
        throw new Error(
          `Bridge returned ${response.status} ${response.statusText}`,
        );
      }

      const json = (await response.json()) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const rawText = json.result?.content?.[0]?.text ?? '';
      logger.info(
        {
          sourceGroup: ctx.sourceGroup,
          query: input.query,
          requestId: ctx.requestId,
        },
        'knowledge_search QMD call complete',
      );
      return {
        executed: true,
        result: { success: true, results: rawText, query: input.query },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, sourceGroup: ctx.sourceGroup, query: input.query },
        'knowledge_search QMD fetch failed',
      );
      return { executed: true, result: { success: false, message } };
    }
  },
};
