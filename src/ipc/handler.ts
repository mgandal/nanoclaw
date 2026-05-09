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
  target: string;
  /** User-facing post-hoc notification text (e.g. "paused task X-123"). */
  notifySummary: string;
  /**
   * Forensic audit-log summary written to agent_actions.summary. Defaults to
   * `target` when omitted, matching the original switch-case convention where
   * the audit summary was the bare identifier.
   */
  auditSummary?: string;
  payloadForStaging: Record<string, unknown>;
}

export interface IpcHandler<TInput, TResult = void> {
  readonly type: string;
  parse(raw: unknown): TInput | null;
  authorize(input: TInput, ctx: IpcHandlerContext): IpcAuthorization | null;
  execute(input: TInput, ctx: IpcHandlerContext): Promise<TResult> | TResult;
}

const HANDLERS: Map<string, IpcHandler<unknown, unknown>> = new Map();

export function registerIpcHandler<TInput, TResult>(
  handler: IpcHandler<TInput, TResult>,
): void {
  if (HANDLERS.has(handler.type)) {
    throw new Error(`Duplicate IPC handler registered: ${handler.type}`);
  }
  HANDLERS.set(handler.type, handler as IpcHandler<unknown, unknown>);
}

export function getIpcHandler(
  type: string,
): IpcHandler<unknown, unknown> | undefined {
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

  const decision = gateAndStage({
    agentName: ctx.agentName,
    baseGroup: ctx.baseGroup,
    actionType: handler.type,
    summary: auditSummary,
    target: auth.target,
    payloadForStaging: auth.payloadForStaging,
  });
  if (!decision.allowed) return { handled: true };

  await handler.execute(input, ctx);

  await fireNotifyIfRequested(decision, {
    agentName: ctx.agentName,
    actionType: handler.type,
    summary: auth.notifySummary,
    target: auth.target,
    registeredGroups: ctx.registeredGroups,
    deps: ctx.deps,
  });

  return { handled: true };
}
