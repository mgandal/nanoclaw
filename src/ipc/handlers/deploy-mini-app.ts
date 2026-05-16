import { runDeployMiniApp } from '../../vercel-deployer.js';
import { logger } from '../../logger.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

/**
 * Deploy a self-contained HTML mini-app to Vercel. Migrated from the if-
 * ladder arm at src/ipc.ts:951-1010 + src/vercel-deployer.ts.
 *
 * The actual deployment lives in {@link runDeployMiniApp}; this handler is
 * the registry adapter. Two consumers share the same core: this handler
 * (dispatched via the IPC handler registry, dispatcher writes the result
 * file per Rule 1) and legacy {@link handleDeployMiniApp} (kept for the
 * vercel-deployer.test.ts harness).
 *
 * Migration preserves behaviour exactly:
 *   - Agent callers go through gateAndStage via the dispatcher.
 *   - Non-agent + non-main callers are denied at authorize() — preserving
 *     the C1 fence from the if-ladder (`else if (!isMain)` rejection at
 *     git show 7b25dfc6:src/ipc.ts:981-989). Bare-group callers bypass the
 *     trust gate, so the fence is the only thing keeping a non-main group
 *     from triggering deploys.
 *   - payloadForStaging shape preserved: {type, requestId, appName, html}.
 *   - resultsDirName='deploy_results' (legacy prefix-grouped wire format).
 */
interface Input {
  appName: string | undefined;
  html: string | undefined;
  requestId: string | undefined;
}

export const deployMiniAppHandler: IpcHandler<Input, ExecuteResult> = {
  type: 'deploy_mini_app',
  responseKind: 'result',
  // Wire-format override: container reads from `deploy_results/` (hardcoded
  // at container/agent-runner/src/ipc-mcp-stdio.ts:1714). Contract Rule 1.
  resultsDirName: 'deploy_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    // requestId is validated by the dispatcher (Rule 2). appName/html
    // permissively typed — runDeployMiniApp returns a structured failure
    // result for missing/invalid values rather than rejecting at parse.
    return {
      appName: typeof r.appName === 'string' ? r.appName : undefined,
      html: typeof r.html === 'string' ? r.html : undefined,
      requestId: typeof r.requestId === 'string' ? r.requestId : undefined,
    };
  },

  authorize(input, ctx) {
    // C1 fence: non-agent + non-main callers are denied. checkTrustAndStage
    // does not gate non-agent callers (returns autonomous), so without this
    // an arbitrary non-main group could trigger Vercel deploys. The if-
    // ladder enforced this at git show 7b25dfc6:src/ipc.ts:981-989.
    if (ctx.agentName === null && !ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'deploy_mini_app rejected: non-main group, no agent component',
      );
      return null;
    }
    return {
      target: 'vercel',
      auditSummary:
        typeof input.appName === 'string'
          ? input.appName.slice(0, 100)
          : '(unnamed)',
      notifySummary: `deployed ${
        typeof input.appName === 'string'
          ? input.appName.slice(0, 80)
          : '(unnamed)'
      }`,
      payloadForStaging: {
        type: 'deploy_mini_app',
        requestId: input.requestId,
        appName: input.appName,
        html: input.html,
      },
    };
  },

  async execute(input, ctx): Promise<ExecuteResult> {
    const result = await runDeployMiniApp(
      input.appName,
      input.html,
      ctx.sourceGroup,
    );
    return { executed: true, result };
  },
};
