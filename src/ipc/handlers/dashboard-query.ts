import { runDashboardQuery } from '../../dashboard-ipc.js';
import { logger } from '../../logger.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

/**
 * Read-only dashboard queries. Migrated from the if-ladder arm at
 * src/ipc.ts:1012-1059 + src/dashboard-ipc.ts.
 *
 * The actual per-query logic lives in {@link runDashboardQuery}; this
 * handler is the registry adapter. Two consumers share the same core:
 * this handler (dispatched via the IPC handler registry, dispatcher writes
 * the result file per Rule 1) and legacy {@link handleDashboardIpc} (kept
 * for the dashboard-ipc.test.ts harness).
 *
 * Migration preserves behaviour exactly:
 *   - Agent callers go through gateAndStage via the dispatcher (skipGate is
 *     requested only for non-agent callers).
 *   - Bare non-main callers are not blocked at dispatch; per-query
 *     denyNonMain logic for group_summary/skill_inventory lives in
 *     runDashboardQuery.
 *   - payloadForStaging carries `view` and `params` (not `queryType`)
 *     because that is the legacy staging shape callers and tests depend on.
 */
interface Input {
  // The actual switch key consumed by runDashboardQuery.
  queryType: string | undefined;
  // Legacy staging fields. The if-ladder staged on `view` rather than
  // `queryType`; tests + UI surface depend on this shape, so we preserve it.
  view: string | undefined;
  params: unknown;
}

export const dashboardQueryHandler: IpcHandler<Input, ExecuteResult> = {
  type: 'dashboard_query',
  responseKind: 'result',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    // requestId is validated by the dispatcher (Rule 2). queryType is
    // permissively typed — runDashboardQuery accepts undefined and returns
    // a structured 'Unknown query type' result rather than rejecting at
    // parse time, matching the legacy handler's behaviour.
    return {
      queryType: typeof r.queryType === 'string' ? r.queryType : undefined,
      view: typeof r.view === 'string' ? r.view : undefined,
      params: r.params,
    };
  },

  authorize(input, ctx) {
    // For agent callers, the trust gate must fire — dashboard_query is on
    // the read-only allowlist but agents may have stricter per-action trust
    // (e.g. `dashboard_query: draft` should still stage). Only request
    // skipGate for non-agent callers (host-side scripts, the main group's
    // own bypass via the no-agent path).
    const isAgentCaller = ctx.agentName !== null;
    return {
      target: 'dashboard',
      auditSummary:
        typeof input.view === 'string' ? input.view.slice(0, 100) : '(query)',
      notifySummary: `queried ${
        typeof input.view === 'string' ? input.view.slice(0, 80) : '(view)'
      }`,
      payloadForStaging: {
        type: 'dashboard_query',
        view: input.view,
        params: input.params,
      },
      ...(isAgentCaller ? {} : { skipGate: true as const }),
    };
  },

  execute(input, ctx): ExecuteResult {
    const result = runDashboardQuery(
      input.queryType,
      ctx.sourceGroup,
      ctx.isMain,
    );
    logger.info(
      { queryType: input.queryType, sourceGroup: ctx.sourceGroup },
      'dashboard IPC handled',
    );
    return { executed: true, result };
  },
};
