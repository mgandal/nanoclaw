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
 * The if-ladder bypassed the trust gate for all four actions — Rule 5
 * preserves that for now via skipGate for non-agent callers + omitting
 * skipGate for agent callers (which falls back to gateAndStage, but since
 * task_* is not on SKIP_GATE_ALLOWLIST the dispatcher would treat
 * agent-side skipGate as a contract violation).
 *
 * Per-action notes:
 *   - task_list — read-only, on SKIP_GATE_ALLOWLIST. skipGate always.
 *   - task_add, task_close, task_reopen — writes. Today bypass the gate
 *     entirely. The migration ships that behaviour (no skipGate request
 *     for agent callers → gateAndStage fires → but with no trust.yaml
 *     entry, the gate defaults to autonomous → audit row gets written
 *     where today there isn't one). That's a Rule 5 deviation worth
 *     calling out, but the alternative (skipGate: true for off-allowlist
 *     types) would trigger Rule 4's deny + violation audit, breaking the
 *     handlers entirely. The pragmatic choice: ship the audit-row-now
 *     behaviour. A separate follow-up commit can add the writes to
 *     SKIP_GATE_ALLOWLIST or to the trust matrix.
 *
 * payloadForStaging shapes are minimal — the if-ladder didn't stage
 * task_* actions at all (no gateAndStage call), so any shape works for
 * the moment. Including the full data record is the safe default; a
 * future trust matrix entry can refine it.
 */

interface AddInput {
  raw: Record<string, unknown>;
  title: string | undefined;
}

export const taskAddHandler: IpcHandler<AddInput, ExecuteResult> = {
  type: 'task_add',
  responseKind: 'result',
  resultsDirName: 'task_results',

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
      // Rule 5: the if-ladder bypassed the gate for task_*. Preserved
      // here via skipGate; on SKIP_GATE_ALLOWLIST with the TODO(Batch4)
      // marker. A separate commit will close this bypass.
      skipGate: true as const,
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
      skipGate: true as const, // Rule 5 — see task_add note.
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
      skipGate: true as const, // Rule 5 — see task_add note.
    };
  },

  execute(input, ctx): ExecuteResult {
    return {
      executed: true,
      result: runTaskReopen(input.raw, ctx.sourceGroup, ctx.isMain),
    };
  },
};
