import { DEFAULT_KG_DB_PATH, runKgQuery } from '../../kg-ipc.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

/**
 * Knowledge-graph query. Migrated from the if-ladder arm at
 * src/ipc.ts (git show 7b25dfc6:src/ipc.ts:1093-1141) + src/kg-ipc.ts.
 *
 * The actual graph query lives in {@link runKgQuery}; this handler is the
 * registry adapter. Two consumers share the same core: this handler
 * (dispatched via the IPC handler registry, dispatcher writes the result
 * file per Rule 1) and legacy {@link handleKgIpc} (kept for the kg-ipc
 * test harness, which needs a dbPath override to inject a per-test DB).
 *
 * Migration preserves behaviour exactly:
 *   - Agent callers go through gateAndStage via the dispatcher; kg_query is
 *     on SKIP_GATE_ALLOWLIST, so the handler requests skipGate only for
 *     non-agent callers (matches the dashboard pattern from Batch 1).
 *   - payloadForStaging carries {type, requestId, query, hops} matching
 *     the legacy if-ladder shape.
 *   - resultsDirName='kg_results' (container reads from there at
 *     container/agent-runner/src/ipc-mcp-stdio.ts:735).
 *
 * The handler always uses DEFAULT_KG_DB_PATH. The dbPath override exists
 * only for the legacy kg-ipc.test.ts harness; production code (both legacy
 * wrapper and this handler) uses the default.
 */
interface Input {
  // Full raw data forwarded to runKgQuery — it consumes many optional
  // fields (entity_type, relation_type, hops, limit, from_entity_id) and
  // the shape is permissive on purpose.
  raw: Record<string, unknown>;
  // Subset preserved verbatim for staging payload + audit summary.
  query: string | undefined;
  hops: unknown;
  requestId: string | undefined;
}

export const kgQueryHandler: IpcHandler<Input, ExecuteResult> = {
  type: 'kg_query',
  responseKind: 'result',
  resultsDirName: 'kg_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      raw: r,
      query: typeof r.query === 'string' ? r.query : undefined,
      hops: r.hops,
      requestId: typeof r.requestId === 'string' ? r.requestId : undefined,
    };
  },

  authorize(input, ctx) {
    const isAgentCaller = ctx.agentName !== null;
    return {
      target: 'knowledge-graph',
      auditSummary:
        typeof input.query === 'string' ? input.query.slice(0, 100) : '(query)',
      notifySummary: `queried KG: ${
        typeof input.query === 'string' ? input.query.slice(0, 80) : '(query)'
      }`,
      payloadForStaging: {
        type: 'kg_query',
        requestId: input.requestId,
        query: input.query,
        hops: input.hops,
      },
      ...(isAgentCaller ? {} : { skipGate: true as const }),
    };
  },

  execute(input, ctx): ExecuteResult {
    const result = runKgQuery(
      input.raw,
      ctx.sourceGroup,
      ctx.isMain,
      DEFAULT_KG_DB_PATH,
    );
    return { executed: true, result };
  },
};
