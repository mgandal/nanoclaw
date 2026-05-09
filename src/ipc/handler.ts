import { logger } from '../logger.js';
import { parseCompoundKey, fsPathToCompoundKey } from '../compound-key.js';
import { RegisteredGroup } from '../types.js';
import type { IpcDeps } from '../ipc.js';
import { gateAndStage, fireNotifyIfRequested } from './trust-gate.js';

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
}

/**
 * Result of execute(). Returning void or undefined is treated as "executed
 * normally" — the dispatcher fires the post-hoc notify. Return `{ executed:
 * false }` to signal a no-op (a race-disappearance, a deferred validation
 * failure, etc.) — the dispatcher skips the notify so the user does not see
 * a misleading message for an action that didn't actually happen. The audit
 * log row was already written upstream and is unaffected.
 */
export type ExecuteResult = void | { executed: boolean };

export interface IpcHandler<TInput, TResult extends ExecuteResult = void> {
  readonly type: string;
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

  const auditSummary = auth.auditSummary ?? auth.target;
  const auditTarget = auth.auditTarget ?? auth.target;

  const decision = gateAndStage({
    agentName: ctx.agentName,
    baseGroup: ctx.baseGroup,
    actionType: handler.type,
    summary: auditSummary,
    target: auditTarget,
    payloadForStaging: auth.payloadForStaging,
  });
  if (!decision.allowed) return { handled: true };

  const executeResult = await handler.execute(input, ctx);
  // Treat void/undefined as executed normally; explicit { executed: false }
  // means the handler bailed (e.g., race, deferred validation) and the user
  // should NOT see a post-hoc notification claiming the action happened.
  const executed = executeResult ? executeResult.executed !== false : true;

  if (executed) {
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
