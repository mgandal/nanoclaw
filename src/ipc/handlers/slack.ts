import { logger } from '../../logger.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

/**
 * slack_dm_read — migrated from src/ipc.ts:1205-1314 (handleSlackDmReadIpc)
 * at git HEAD prior to Batch 2F.
 *
 * Wire-format notes:
 *  - resultsDirName: 'slack_results' matches the container-side hardcoded
 *    path at container/agent-runner/src/ipc-mcp-stdio.ts:1597.
 *  - actionTypeOverride: 'read_slack_dm' preserves the legacy audit name
 *    referenced by 7 live trust.yaml policies (data/agents/{claire, simon,
 *    coo, einstein, marvin, vincent}/trust.yaml + comments in freud/steve/
 *    warren) AND by the agent-facing MCP tool description at
 *    ipc-mcp-stdio.ts:1603. Renaming would silently void all of them.
 *  - slack_dm_read is on SKIP_GATE_ALLOWLIST (handler.ts:27) — read-only.
 *    skipGate fires only for non-agent callers; agent callers still go
 *    through the gate so the audit row is written.
 *
 * The slack_dm write handler is deferred to Batch 2F.1 because it fires
 * a post-hoc Telegram notify *after* writing its result file — a hybrid
 * the IpcHandler contract does not yet express.
 */

interface SlackDmReadInput {
  channel: string | undefined;
  limit: number | undefined;
}

export const slackDmReadHandler: IpcHandler<SlackDmReadInput, ExecuteResult> = {
  type: 'slack_dm_read',
  responseKind: 'result',
  resultsDirName: 'slack_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      channel: typeof r.channel === 'string' ? r.channel : undefined,
      limit: typeof r.limit === 'number' ? r.limit : undefined,
    };
  },

  authorize(input, ctx) {
    return {
      target: input.channel || '',
      auditSummary: `Read DM channel: ${input.channel || 'unknown'}`,
      notifySummary: 'read slack dm',
      payloadForStaging: { type: 'slack_dm_read' },
      actionTypeOverride: 'read_slack_dm',
      ...(ctx.agentName === null ? { skipGate: true as const } : {}),
    };
  },

  async execute(input, ctx): Promise<ExecuteResult> {
    if (!input.channel) {
      return {
        executed: true,
        result: {
          success: false,
          message: 'Missing required parameter: channel',
        },
      };
    }

    const body: Record<string, unknown> = { channel: input.channel };
    if (input.limit) body.limit = input.limit;

    const response = await fetch('http://127.0.0.1:19876/slack/dm/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;

    logger.info(
      {
        sourceGroup: ctx.sourceGroup,
        channel: input.channel,
        requestId: ctx.requestId,
      },
      'slack_dm_read IPC handled',
    );

    if (response.ok) {
      const messages = result.messages as unknown[];
      return {
        executed: true,
        result: {
          success: true,
          message: JSON.stringify(messages || [], null, 2),
          data: result,
        },
      };
    }
    return {
      executed: true,
      result: {
        success: false,
        message:
          (result.error as string) || `Bridge returned ${response.status}`,
      },
    };
  },
};
