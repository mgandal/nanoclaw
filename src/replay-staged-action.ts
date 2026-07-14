/**
 * Host-side replay executor for /approve.
 *
 * Called by handleApprovalCommand (src/session-commands.ts) when the user
 * approves a pending_actions row. Looks up the matching IPC handler in
 * the registry, builds a real IpcHandlerContext via the canonical
 * buildContext (NOT a hand-rolled stub — see spec R2-I1), and invokes
 * handler.execute(payload, ctx) DIRECTLY.
 *
 * The replay deliberately bypasses gateAndStage: the user's approval IS
 * the authorization (spec D5). Re-running checkTrust on a `draft` row
 * would just re-stage it — infinite loop.
 *
 * Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
 */
import { buildContext, getIpcHandler } from './ipc/handler.js';
import type { IpcDeps } from './ipc.js';
import { logger } from './logger.js';

export interface ReplayStagedActionInput {
  action_type: string;
  payload: unknown;
  group_folder: string;
  agent_name: string;
  deps: IpcDeps;
}

/**
 * Returns a short human-readable result string suitable for the Telegram
 * reply. Throws if the action_type has no registered handler or if the
 * handler itself throws.
 */
export async function replayStagedAction(
  input: ReplayStagedActionInput,
): Promise<string> {
  const { action_type, payload, group_folder, agent_name, deps } = input;

  const handler = getIpcHandler(action_type);
  if (!handler) {
    throw new Error(`No handler registered for action_type: ${action_type}`);
  }

  // Build a real IpcHandlerContext via the canonical constructor (R2-I1).
  //
  // isMain carries the ORIGIN group's tier, derived from the registration —
  // NOT a blanket true. The user's approval authorizes the ACTION (that is
  // why gateAndStage is bypassed below, per D5), but it must not promote the
  // caller's trust tier: handler execute() bodies key tier-scoped behavior
  // on ctx.isMain (send_file's absolute-path pass-through and credential-
  // blocklist bypass, dashboard/kg result scoping, pageindex mount
  // validation). A hardcoded true let an approved non-main staged send_file
  // run with main's file-safety exemptions — 2026-07-14 security review H4.
  // An unregistered origin (group removed since staging) fails safe to
  // non-main. requestId=null: host-initiated, no IPC poller waiting.
  const originIsMain = Object.values(deps.registeredGroups()).some(
    (g) => g.folder === group_folder && g.isMain === true,
  );
  const ctx = buildContext(group_folder, originIsMain, deps);

  logger.info(
    {
      action_type,
      group_folder,
      agent_name,
      // Guard against non-object payloads (DB corruption, manual edit) — the
      // type-safe path stores Record<string, unknown> per IpcAuthorization
      // contract, but Object.keys(null) throws and would mask the cleaner
      // parse-rejected error below.
      payloadKeys:
        payload && typeof payload === 'object'
          ? Object.keys(payload as object).slice(0, 10)
          : typeof payload,
    },
    'replayStagedAction: invoking handler.execute directly (gate bypassed per D5)',
  );

  // Parse the payload through the handler if the handler defines parse().
  // The stored payload_json was built from the same input the handler
  // originally parsed, so parse should be a no-op or recover the typed
  // shape. If parse returns null, the stored payload is malformed —
  // surface as a clear error rather than crash inside execute.
  const parsed = handler.parse ? handler.parse(payload) : payload;
  if (parsed === null) {
    throw new Error(
      `Handler ${action_type} rejected stored payload at parse() time`,
    );
  }

  const executeResult = await handler.execute(parsed as any, ctx as any);

  // Map executeResult into a single human-readable line.
  if (executeResult && typeof executeResult === 'object') {
    if ('executed' in executeResult && executeResult.executed === false) {
      return `execution bailed (action_type=${action_type})`;
    }
    if (
      'executed' in executeResult &&
      executeResult.executed === true &&
      'result' in executeResult
    ) {
      const result = (executeResult as any).result;
      if (result && typeof result === 'object' && 'message' in result) {
        return String(result.message).slice(0, 200);
      }
      if (result && typeof result === 'object' && 'success' in result) {
        return result.success ? 'ok' : 'failed';
      }
    }
  }
  return 'ok';
}
