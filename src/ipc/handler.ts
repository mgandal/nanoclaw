import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { parseCompoundKey, fsPathToCompoundKey } from '../compound-key.js';
import { RegisteredGroup } from '../types.js';
import type { IpcDeps } from '../ipc.js';
import { gateAndStage, fireNotifyIfRequested } from './trust-gate.js';

/**
 * Read-only IPC actions allowed to declare `skipGate: true` in their
 * authorization. Rule 4 of docs/context-engineering/ipc-handler-contract.md.
 *
 * Hardcoded (not a registration flag) so that adding a type here requires
 * a code change in this file — a reviewer who knows the trust contract sees
 * the addition. Mutating actions must go through the gate; the dispatcher
 * rejects `skipGate: true` from off-allowlist handlers.
 */
const SKIP_GATE_ALLOWLIST: ReadonlySet<string> = new Set([
  'dashboard_query',
  'kg_query',
  'pageindex_fetch',
  'task_list',
  'slack_dm_read',
  'skill_search',
  'skill_invoked',
  'imessage_search',
  'imessage_read',
  'imessage_list_contacts',
]);

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface IpcHandlerContext {
  sourceGroup: string;
  isMain: boolean;
  baseGroup: string;
  agentName: string | null;
  registeredGroups: Record<string, RegisteredGroup>;
  deps: IpcDeps;
}

export interface IpcAuthorization {
  /** Default target identifier — used for both audit and notify when not split. */
  target: string;
  /** User-facing post-hoc notification text (e.g. "paused task X-123"). */
  notifySummary: string;
  /**
   * Forensic audit-log summary written to agent_actions.summary. Defaults to
   * `target` when omitted, matching the original switch-case convention where
   * the audit summary was the bare identifier.
   */
  auditSummary?: string;
  /**
   * Override for the audit-log target (agent_actions.target). Defaults to
   * `target` when omitted. Use this when the gate's audit row should reference
   * a different identifier than the user-facing notification (e.g.
   * schedule_task gates against the target group folder, but the post-hoc
   * notify references the newly-generated taskId).
   */
  auditTarget?: string;
  payloadForStaging: Record<string, unknown>;
  /**
   * Opt out of the trust gate. Permitted only when the handler's `type` is
   * in SKIP_GATE_ALLOWLIST — the dispatcher rejects this flag from
   * off-allowlist handlers as a defense-in-depth check. Rule 4 of the IPC
   * handler contract. Read-only actions only.
   */
  skipGate?: true;
}

/**
 * Result of execute().
 *
 * - `void` / `undefined`: executed normally. Dispatcher fires the post-hoc
 *   notify for `responseKind: 'notify'` handlers.
 * - `{ executed: false }`: handler bailed (race-disappearance, deferred
 *   validation failure). Dispatcher skips the notify so the user does not
 *   see a misleading message. The audit row was already written upstream.
 *   For `responseKind: 'result'` handlers, the dispatcher writes a failure
 *   result file so the in-container poller does not hang.
 * - `{ executed: true; result: unknown }`: executed and produced a result
 *   payload. Required for `responseKind: 'result'` handlers; the dispatcher
 *   writes the payload to data/ipc/{group}/{type}_results/{requestId}.json
 *   using atomic .tmp + rename. The post-hoc notify does NOT fire for
 *   result-kind handlers — the result file is the response surface.
 */
export type ExecuteResult =
  | void
  | { executed: false }
  | { executed: true; result?: unknown };

export interface IpcHandler<TInput, TResult extends ExecuteResult = void> {
  readonly type: string;
  /**
   * 'notify' (default): fire-and-forget. Dispatcher fires post-hoc notify
   * iff the gate decision asked for one and execute returned non-bailed.
   *
   * 'result': request/response. Dispatcher requires data.requestId, writes
   * the handler's `result` payload to a per-requestId file the agent polls.
   * See Rule 1 of the IPC handler contract — handlers never write the file
   * themselves.
   */
  readonly responseKind?: 'notify' | 'result';
  /**
   * Override for the results directory name. Only meaningful when
   * responseKind === 'result'. Defaults to `${type}_results` for new
   * handlers.
   *
   * Existing handlers being migrated from the if-ladder MUST set this to
   * match the container-side hardcoded path (see
   * container/agent-runner/src/ipc-mcp-stdio.ts). The legacy wire format
   * is prefix-grouped, not type-suffixed — e.g. `dashboard_query` writes
   * to `dashboard_results/` (not `dashboard_query_results/`), and every
   * `task_*` action writes to a shared `task_results/`.
   *
   * Rule of thumb (Rule 1, contract doc):
   *   - Legacy action group with a shared results dir → set override.
   *   - New action with a new wire path → omit; default applies.
   *
   * Path: data/ipc/{sourceGroup}/{resultsDirName}/{requestId}.json.
   */
  readonly resultsDirName?: string;
  parse(raw: unknown): TInput | null;
  authorize(input: TInput, ctx: IpcHandlerContext): IpcAuthorization | null;
  execute(input: TInput, ctx: IpcHandlerContext): Promise<TResult> | TResult;
}

const HANDLERS: Map<string, IpcHandler<unknown, ExecuteResult>> = new Map();

export function registerIpcHandler<TInput, TResult extends ExecuteResult>(
  handler: IpcHandler<TInput, TResult>,
): void {
  if (HANDLERS.has(handler.type)) {
    throw new Error(`Duplicate IPC handler registered: ${handler.type}`);
  }
  HANDLERS.set(handler.type, handler as IpcHandler<unknown, ExecuteResult>);
}

export function getIpcHandler(
  type: string,
): IpcHandler<unknown, ExecuteResult> | undefined {
  return HANDLERS.get(type);
}

export function _resetHandlersForTests(): void {
  HANDLERS.clear();
}

export function buildContext(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): IpcHandlerContext {
  const { group: baseGroup, agent } = parseCompoundKey(
    fsPathToCompoundKey(sourceGroup),
  );
  return {
    sourceGroup,
    isMain,
    baseGroup,
    agentName: agent,
    registeredGroups: deps.registeredGroups(),
    deps,
  };
}

export async function dispatchIpcAction(
  data: { type: string } & Record<string, unknown>,
  ctx: IpcHandlerContext,
): Promise<{ handled: boolean }> {
  const handler = HANDLERS.get(data.type);
  if (!handler) return { handled: false };

  const responseKind = handler.responseKind ?? 'notify';

  // Rule 2: result-kind handlers require a valid requestId BEFORE we parse
  // or authorize. A malformed call cannot produce a result file (the poller
  // will time out, which is correct for malformed input). This matches the
  // if-ladder's pre-parse requestId check for dashboard/kg/pageindex/etc.
  let requestId: string | null = null;
  if (responseKind === 'result') {
    const raw = data.requestId;
    if (typeof raw !== 'string' || !REQUEST_ID_PATTERN.test(raw)) {
      logger.warn(
        { type: data.type, sourceGroup: ctx.sourceGroup, requestId: raw },
        'IPC handler rejected: missing or malformed requestId for result-kind',
      );
      return { handled: true };
    }
    requestId = raw;
  }

  const input = handler.parse(data);
  if (input === null) {
    logger.warn(
      { type: data.type, sourceGroup: ctx.sourceGroup },
      'IPC handler rejected input shape',
    );
    return { handled: true };
  }

  const auth = handler.authorize(input, ctx);
  if (auth === null) return { handled: true };

  // Rule 4: skipGate is honored only for allowlisted types. An off-allowlist
  // handler declaring skipGate is a contract violation; treat as denial.
  const wantsSkipGate = auth.skipGate === true;
  if (wantsSkipGate && !SKIP_GATE_ALLOWLIST.has(handler.type)) {
    logger.error(
      { type: handler.type, sourceGroup: ctx.sourceGroup },
      'IPC handler declared skipGate but type is not on SKIP_GATE_ALLOWLIST — denying',
    );
    return { handled: true };
  }

  const auditSummary = auth.auditSummary ?? auth.target;
  const auditTarget = auth.auditTarget ?? auth.target;

  const decision = wantsSkipGate
    ? null
    : gateAndStage({
        agentName: ctx.agentName,
        baseGroup: ctx.baseGroup,
        actionType: handler.type,
        summary: auditSummary,
        target: auditTarget,
        payloadForStaging: auth.payloadForStaging,
      });
  if (decision !== null && !decision.allowed) return { handled: true };

  let executed = true;
  let resultPayload: unknown = undefined;
  let executeThrew = false;
  let throwMessage = '';
  try {
    const executeResult = await handler.execute(input, ctx);
    if (executeResult && typeof executeResult === 'object') {
      if ('executed' in executeResult && executeResult.executed === false) {
        executed = false;
      } else if (
        'executed' in executeResult &&
        executeResult.executed === true &&
        'result' in executeResult
      ) {
        resultPayload = executeResult.result;
      }
    }
  } catch (err) {
    executeThrew = true;
    throwMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, type: handler.type, sourceGroup: ctx.sourceGroup },
      'IPC handler execute threw',
    );
  }

  if (responseKind === 'result') {
    // Rule 1: dispatcher owns the result file. Always write something so the
    // poller never hangs — success payload on success, deliberate failure
    // shape on throw or bail.
    const filePayload: unknown = executeThrew
      ? { success: false, message: `Error: ${throwMessage}` }
      : !executed
        ? { success: false, message: 'execution bailed' }
        : resultPayload !== undefined
          ? resultPayload
          : { success: true };
    const resultsDirName = handler.resultsDirName ?? `${handler.type}_results`;
    writeResultFile(ctx.sourceGroup, resultsDirName, requestId!, filePayload);
  } else if (executed && decision !== null) {
    // Notify path (existing behaviour). decision is null only for skipGate
    // calls, which are read-only and on the allowlist — by construction they
    // never produce a notify, and skipping fireNotifyIfRequested here keeps
    // that invariant explicit.
    await fireNotifyIfRequested(decision, {
      agentName: ctx.agentName,
      actionType: handler.type,
      summary: auth.notifySummary,
      target: auth.target,
      registeredGroups: ctx.registeredGroups,
      deps: ctx.deps,
    });
  }

  return { handled: true };
}

/**
 * Write a result-kind handler's payload to its per-requestId file, atomically.
 * Path: data/ipc/{sourceGroup}/{resultsDirName}/{requestId}.json.
 *
 * `resultsDirName` comes from the handler's `resultsDirName` field (legacy
 * override) or the dispatcher's default `${type}_results` (new handlers).
 *
 * Best-effort: a write failure is logged but does not propagate, since the
 * caller (dispatcher) is past the side effect and the agent will time out
 * its poll — the correct failure mode.
 */
function writeResultFile(
  sourceGroup: string,
  resultsDirName: string,
  requestId: string,
  payload: unknown,
): void {
  try {
    const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, resultsDirName);
    fs.mkdirSync(resultsDir, { recursive: true });
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload));
    fs.renameSync(tmpFile, resultFile);
  } catch (err) {
    logger.error(
      { err, sourceGroup, resultsDirName, requestId },
      'Failed to write IPC result file',
    );
  }
}
