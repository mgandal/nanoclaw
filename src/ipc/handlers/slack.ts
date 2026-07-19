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

/**
 * slack_dm (write) — migrated from src/ipc.ts:1074-1196 (handleSlackDmIpc)
 * at git HEAD prior to Batch 2F.1.
 *
 * Wire-format notes:
 *  - resultsDirName: 'slack_results' matches the container-side hardcoded
 *    path at container/agent-runner/src/ipc-mcp-stdio.ts:1601 (same dir as
 *    slackDmReadHandler).
 *  - actionTypeOverride: 'send_slack_dm' preserves the legacy audit name
 *    referenced by 9 live trust.yaml files (claire, coo, einstein, freud,
 *    marvin, simon, steve, vincent, warren) AND by the agent-facing MCP
 *    tool description at ipc-mcp-stdio.ts:1569.
 *  - Post-hoc notify: the dispatcher fires fireNotifyIfRequested AFTER
 *    writeResultFile for every result-kind handler whose gate decision
 *    has notify=true and whose result payload reports success (the old
 *    per-handler postHocNotify opt-in flag was removed 2026-07-19).
 *    Together with the trust gate's decision.notify boolean (autonomous
 *    → silent, notify → ping), this preserves the legacy "notify level
 *    fires firePostHocNotify on bridge 2xx" behavior at ipc.ts:1163-1172.
 *  - authorize accepts non-agent callers (no agentName check) — matches
 *    imessageSendHandler at imessage.ts:184-202. The non-agent path
 *    flows through gateAndStage's NON_AGENT_DECISION (autonomous, no
 *    notify) and fireNotifyIfRequested's internal agentName guard
 *    (trust-gate.ts:61), preserving the legacy "bridge fires, no audit,
 *    no notify" behavior.
 */

interface SlackDmInput {
  text: string | undefined;
  user_id: string | undefined;
  user_email: string | undefined;
}

export const slackDmHandler: IpcHandler<
  SlackDmInput,
  {
    executed: true;
    result: { success: boolean; message: string; data?: unknown };
  }
> = {
  type: 'slack_dm',
  responseKind: 'result',
  resultsDirName: 'slack_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      text: typeof r.text === 'string' ? r.text : undefined,
      user_id: typeof r.user_id === 'string' ? r.user_id : undefined,
      user_email: typeof r.user_email === 'string' ? r.user_email : undefined,
    };
  },

  authorize(input) {
    const target = input.user_email || input.user_id || '';
    return {
      target,
      auditSummary: input.text || '',
      notifySummary: `Slack DM → ${input.user_email || input.user_id || '?'}: ${(input.text || '').slice(0, 120)}`,
      payloadForStaging: {
        type: 'slack_dm',
        text: input.text,
        user_id: input.user_id,
        user_email: input.user_email,
      },
      actionTypeOverride: 'send_slack_dm',
    };
  },

  async execute(input, ctx) {
    if (!input.text || (!input.user_id && !input.user_email)) {
      return {
        executed: true,
        result: {
          success: false,
          message:
            'Missing required parameters: text and either user_id or user_email',
        },
      };
    }

    const body: Record<string, string> = { text: input.text };
    if (input.user_id) body.user_id = input.user_id;
    if (input.user_email) body.user_email = input.user_email;

    const response = await fetch('http://127.0.0.1:19876/slack/dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;

    logger.info(
      {
        sourceGroup: ctx.sourceGroup,
        user_id: input.user_id,
        user_email: input.user_email,
        bridgeStatus: response.status,
        requestId: ctx.requestId,
      },
      'slack_dm bridge call complete',
    );

    if (response.ok) {
      return {
        executed: true,
        result: {
          success: true,
          message: (result.message as string) || 'Slack DM sent',
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
