import {
  runTaskAdd,
  runTaskClose,
  runTaskList,
  runTaskReopen,
} from '../../tasks-ipc.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

/**
 * task_* cluster handlers. Four registry entries sharing one results dir
 * (`task_results/`, hardcoded at
 * container/agent-runner/src/ipc-mcp-stdio.ts:736).
 *
 * Migrated from the if-ladder arms at git show 7b25dfc6:src/ipc.ts:1146-
 * 1160 (the bracket `task_add|task_list|task_close|task_reopen` arm).
 *
 * Per-action trust shape (Batch 4 closure, 2026-07-19):
 *   - task_list — read-only, on SKIP_GATE_ALLOWLIST. skipGate for
 *     non-agent callers; agent callers go through the gate.
 *   - task_add, task_close, task_reopen — writes, gated. Agent callers
 *     hit gateAndStage: all 9 agents ship trust.yaml `autonomous`
 *     entries (execute + agent_actions audit row); an agent without an
 *     entry falls to 'ask' and stages for /approve. Non-agent callers
 *     execute via the NON_AGENT_DECISION short-circuit, no audit row.
 *
 * payloadForStaging carries the full data record so an /approve replay
 * has everything the original call had.
 */

interface AddInput {
  raw: Record<string, unknown>;
  title: string | undefined;
}

export const taskAddHandler: IpcHandler<AddInput, ExecuteResult> = {
  type: 'task_add',
  responseKind: 'result',
  resultsDirName: 'task_results',
  payloadAgentAttribution: true,

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return { raw: r, title: typeof r.title === 'string' ? r.title : undefined };
  },

  authorize(input) {
    return {
      target: 'tasks',
      auditSummary: input.title?.slice(0, 100) ?? '(no title)',
      notifySummary: `added task '${input.title?.slice(0, 80) ?? '(no title)'}'`,
      payloadForStaging: { type: 'task_add', ...input.raw },
    };
  },

  execute(input, ctx): ExecuteResult {
    return {
      executed: true,
      result: runTaskAdd(input.raw, ctx.sourceGroup, ctx.isMain),
    };
  },
};

interface ListInput {
  raw: Record<string, unknown>;
}

export const taskListHandler: IpcHandler<ListInput, ExecuteResult> = {
  type: 'task_list',
  responseKind: 'result',
  resultsDirName: 'task_results',
  payloadAgentAttribution: true,

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    return { raw: raw as Record<string, unknown> };
  },

  authorize(input, ctx) {
    const isAgentCaller = ctx.agentName !== null;
    return {
      target: 'tasks',
      auditSummary: '(list)',
      notifySummary: 'listed tasks',
      payloadForStaging: { type: 'task_list', ...input.raw },
      // task_list is on SKIP_GATE_ALLOWLIST (read-only). Request skipGate
      // for non-agent callers; agent callers still go through the gate.
      ...(isAgentCaller ? {} : { skipGate: true as const }),
    };
  },

  execute(input): ExecuteResult {
    return { executed: true, result: runTaskList(input.raw) };
  },
};

interface CloseInput {
  raw: Record<string, unknown>;
  id: number | undefined;
  titleMatch: string | undefined;
}

export const taskCloseHandler: IpcHandler<CloseInput, ExecuteResult> = {
  type: 'task_close',
  responseKind: 'result',
  resultsDirName: 'task_results',
  payloadAgentAttribution: true,

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      raw: r,
      id: typeof r.id === 'number' ? r.id : undefined,
      titleMatch: typeof r.title_match === 'string' ? r.title_match : undefined,
    };
  },

  authorize(input) {
    return {
      target: 'tasks',
      auditSummary:
        input.id !== undefined
          ? `close #${input.id}`
          : (input.titleMatch?.slice(0, 100) ?? '(no match)'),
      notifySummary: `closed task ${input.id !== undefined ? `#${input.id}` : input.titleMatch?.slice(0, 80)}`,
      payloadForStaging: { type: 'task_close', ...input.raw },
    };
  },

  execute(input, ctx): ExecuteResult {
    return {
      executed: true,
      result: runTaskClose(input.raw, ctx.sourceGroup, ctx.isMain),
    };
  },
};

interface ReopenInput {
  raw: Record<string, unknown>;
  id: number | undefined;
}

export const taskReopenHandler: IpcHandler<ReopenInput, ExecuteResult> = {
  type: 'task_reopen',
  responseKind: 'result',
  resultsDirName: 'task_results',
  payloadAgentAttribution: true,

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return { raw: r, id: typeof r.id === 'number' ? r.id : undefined };
  },

  authorize(input) {
    return {
      target: 'tasks',
      auditSummary: input.id !== undefined ? `reopen #${input.id}` : '(no id)',
      notifySummary: `reopened task #${input.id ?? '?'}`,
      payloadForStaging: { type: 'task_reopen', ...input.raw },
    };
  },

  execute(input, ctx): ExecuteResult {
    return {
      executed: true,
      result: runTaskReopen(input.raw, ctx.sourceGroup, ctx.isMain),
    };
  },
};
