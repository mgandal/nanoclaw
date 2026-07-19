import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { insertAgentAction, isAgentEligibleForGroup } from '../db.js';
import { logger } from '../logger.js';
import { parseCompoundKey, fsPathToCompoundKey } from '../compound-key.js';
import { RegisteredGroup } from '../types.js';
import type { IpcDeps } from '../ipc.js';
import { isValidAgentName } from './file-validation.js';
import {
  gateAndStage,
  fireNotifyIfRequested,
  type GateDecision,
} from './trust-gate.js';

/**
 * Read-only IPC actions allowed to declare `skipGate: true` in their
 * authorization. Rule 4 of docs/context-engineering/ipc-handler-contract.md.
 *
 * Hardcoded (not a registration flag) so that adding a type here requires
 * a code change in this file — a reviewer who knows the trust contract sees
 * the addition. Mutating actions must go through the gate; the dispatcher
 * rejects `skipGate: true` from off-allowlist handlers.
 */
export const SKIP_GATE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Read-only
  'dashboard_query',
  'kg_query',
  'knowledge_search',
  'pageindex_fetch',
  'task_list',
  'slack_dm_read',
  'skill_search',
  'imessage_search',
  'imessage_read',
  'imessage_list_contacts',
  // Batch 4 closure (2026-07-19): task_add / task_close / task_reopen /
  // pageindex_index REMOVED from this list — the last write-actions that
  // bypassed the gate. All 9 agents' trust.yaml carry explicit
  // `autonomous` entries for the four types (behaviour parity: they
  // execute immediately, but now leave agent_actions audit rows).
  // An agent whose trust.yaml lacks an entry falls to the 'ask' default
  // and stages — fail-safe, not silent. Non-agent callers are unaffected
  // (NON_AGENT_DECISION short-circuit in trust-gate.ts).
  // Phase 4 (2026-05-19): save_skill REMOVED from this list as the
  // gate-activation policy flip went live — every call stages in
  // pending_actions; user `/approve pa-xxx` invokes the replay module to
  // actually write the SKILL.md.
  // See docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md.
  // 2026-07-19: the crystallize family (crystallize_skill,
  // crystallize_candidate, crystallize_candidate_fetch, skill_invoked)
  // was removed outright with the feature — handlers unregistered, so
  // those wire types now fall through dispatch as unknown.
  // Self-directed agent wakeup. Rate-limited (10/agent/group) in
  // scheduleWakeupHandler.authorize; handler writes its own audit row.
  // Phase 1.1 — see docs/superpowers/specs/2026-05-19-ipc-agent-self-wakeup-design.md
  'schedule_wakeup',
]);

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface IpcHandlerContext {
  sourceGroup: string;
  isMain: boolean;
  baseGroup: string;
  agentName: string | null;
  /**
   * Per-dispatch requestId for result-kind handlers (populated after the
   * Rule 2 requestId validation block). `null` for notify-kind handlers
   * (no requestId in flow) AND for result-kind handlers whose
   * requestId failed validation (dispatcher returns before this is set).
   *
   * Batch 4 contract: handler logger calls inside `execute()` SHOULD
   * include `requestId: ctx.requestId` so logs can be joined to
   * `agent_actions` and the container-side poller. See
   * docs/context-engineering/ipc-handler-contract.md Rule N.
   */
  requestId: string | null;
  registeredGroups: Record<string, RegisteredGroup>;
  deps: IpcDeps;
  /**
   * Root of the IPC filesystem tree. Defaults to the global DATA_DIR; tests
   * override via buildContext(dataDirOverride) to isolate per-test fs state
   * under a tmpdir. The dispatcher reads this when writing result files
   * (Rule 1) so a test can be mkdtempSync-scoped without touching production
   * data/. Handlers should reach for this rather than re-importing DATA_DIR
   * when their work writes under data/ipc/.
   */
  dataDir: string;
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
  /**
   * Override for the action_type string written to agent_actions and looked
   * up in trust.yaml. Defaults to `handler.type` (the wire type). The
   * contract-violation audit row (handler.ts off-allowlist skipGate) keeps
   * using `handler.type` regardless — that row describes the handler, not
   * the user action.
   *
   * Use this when migrating a legacy handler whose audit action_type does
   * not match the wire type. Example: the legacy slack cluster used
   * verb_noun audit names (`read_slack_dm`, `send_slack_dm`) but the wire
   * types are noun_verb (`slack_dm_read`, `slack_dm`). Without this
   * override, the migration would silently invalidate every existing
   * trust.yaml policy keyed on the legacy name and break the agent-facing
   * MCP tool description that references the legacy name.
   *
   * NEW handlers should NOT use this — design the wire type and audit type
   * to match. The override exists only to bridge legacy mismatches.
   */
  actionTypeOverride?: string;
  payloadForStaging: Record<string, unknown>;
  /**
   * Opt out of the trust gate. Permitted only when the handler's `type` is
   * in SKIP_GATE_ALLOWLIST — the dispatcher rejects this flag from
   * off-allowlist handlers as a defense-in-depth check. Rule 4 of the IPC
   * handler contract. Read-only actions only.
   */
  skipGate?: true;
  /**
   * Suppress the post-hoc notify when `auth.target` equals this jid.
   *
   * The generic notify (`fireNotifyIfRequested`) always sends its receipt to
   * the main jid. For an action that *delivers to* the main jid (an agent in
   * the main group sending a message to main), that receipt would echo back
   * into the very chat the action just wrote to. The `message` handler sets
   * this to the main jid so the dispatcher skips the receipt in exactly that
   * case — reproducing the inline `processIpcMessage` self-echo guard
   * (`mainJidForSelfCheck !== data.chatJid`).
   *
   * Has no effect when the gate did not request a notify, or when `target`
   * differs from this value. Applies to both the `result`-kind and the
   * `notify`-kind notify branches.
   */
  suppressNotifyWhenTargetIs?: string;
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
  /**
   * Rethrow execute() errors instead of swallowing them, so the IPC
   * watcher moves the claimed file to errors/ for inspection/replay.
   * ONLY for notify-kind delivery handlers (message, send_file) whose
   * pre-migration ladder semantics preserved failed payloads. Never set
   * on result-kind handlers — they must always write a failure result
   * file so the container poller doesn't hang.
   */
  readonly rethrowExecuteErrors?: boolean;
  /**
   * Accept payload-based agent attribution. Production containers write
   * IPC into their bare group dir (never a compound `group--agent` dir),
   * so directory-derived `ctx.agentName` is null for every container
   * call. Handlers that opt in let the dispatcher attribute the trust
   * gate from a validated top-level `agent` string in the payload —
   * stamped by the container MCP server from NANOCLAW_AGENT_NAME, not
   * model-supplied. Malformed names drop the call outright (fail-safe);
   * a well-formed name that matches no data/agents/ dir still
   * attributes and falls to the trust gate's 'ask' default (staged,
   * visible — never a silent bypass). Directory attribution wins when
   * present. Audit rows from payload-attributed calls carry a
   * ` [payload-agent]` summary suffix so forensics can distinguish the
   * two sources.
   */
  readonly payloadAgentAttribution?: true;
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

/** Registered handlers, for contract-consistency tests only. */
export function _getRegisteredHandlersForTests(): ReadonlyMap<
  string,
  IpcHandler<unknown, ExecuteResult>
> {
  return HANDLERS;
}

export function buildContext(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  dataDirOverride?: string,
): IpcHandlerContext {
  const { group: baseGroup, agent } = parseCompoundKey(
    fsPathToCompoundKey(sourceGroup),
  );
  return {
    sourceGroup,
    isMain,
    baseGroup,
    agentName: agent,
    requestId: null,
    registeredGroups: deps.registeredGroups(),
    deps,
    dataDir: dataDirOverride ?? DATA_DIR,
  };
}

export async function dispatchIpcAction(
  data: { type: string } & Record<string, unknown>,
  ctx: IpcHandlerContext,
): Promise<{ handled: boolean }> {
  const handler = HANDLERS.get(data.type);
  if (!handler) return { handled: false };

  const responseKind = handler.responseKind ?? 'notify';
  const resultsDirName = handler.resultsDirName ?? `${handler.type}_results`;

  // Payload-based agent attribution — see IpcHandler.payloadAgentAttribution.
  // Runs FIRST so every downstream drop (requestId, parse) is attributed
  // to the claimed agent and the eligibility gate covers all paths.
  let payloadAttributed = false;
  if (handler.payloadAgentAttribution && ctx.agentName === null) {
    const claimed = (data as { agent?: unknown }).agent;
    if (claimed !== undefined) {
      // Malformed name → fail-safe drop (never silent unattributed
      // execute). Well-formed but not eligible for THIS group → also
      // drop, so a container cannot forge an audit row under an agent
      // that runs in some OTHER group (cross-group attribution
      // poisoning). Both write a failure result file so the poller
      // doesn't hang.
      const eligible =
        typeof claimed === 'string' &&
        isValidAgentName(claimed) &&
        isAgentEligibleForGroup(claimed, ctx.baseGroup);
      if (!eligible) {
        logger.warn(
          {
            type: data.type,
            sourceGroup: ctx.sourceGroup,
            claimedAgent:
              typeof claimed === 'string' ? claimed : '(non-string)',
          },
          'IPC payload agent field malformed or ineligible for group — dropping action',
        );
        if (responseKind === 'result') {
          const rid = data.requestId;
          if (typeof rid === 'string' && REQUEST_ID_PATTERN.test(rid)) {
            writeResultFile(ctx.dataDir, ctx.sourceGroup, resultsDirName, rid, {
              success: false,
              message:
                'Error: agent field invalid or not registered for this group — action not executed',
            });
          }
        }
        return { handled: true };
      }
      ctx.agentName = claimed;
      payloadAttributed = true;
    }
  }

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
      writeSyntheticAuditRow(
        ctx,
        data.type,
        null,
        'dispatch_drop_input',
        payloadAttributed
          ? 'malformed requestId [payload-agent]'
          : 'malformed requestId',
        'dropped_invalid_requestId',
      );
      return { handled: true };
    }
    requestId = raw;
  }

  // Batch 4: bind requestId to context so handlers can include it in
  // logger calls per the new contract. Null for notify-kind handlers
  // (where responseKind !== 'result' and the validation block above
  // didn't run).
  ctx.requestId = requestId;

  const input = handler.parse(data);
  if (input === null) {
    logger.warn(
      { type: data.type, sourceGroup: ctx.sourceGroup, requestId },
      'IPC handler rejected input shape',
    );
    writeSyntheticAuditRow(
      ctx,
      data.type,
      requestId,
      'dispatch_drop_input',
      payloadAttributed ? 'parse rejected [payload-agent]' : 'parse rejected',
      'dropped_invalid_input',
    );
    return { handled: true };
  }

  const auth = handler.authorize(input, ctx);
  if (auth === null) return { handled: true };

  // Rule 4: skipGate is honored only for allowlisted types. An off-allowlist
  // handler declaring skipGate is a contract violation. We deny + log AND
  // write a forensic audit row so the violation surfaces in agent_actions
  // queries (otherwise the gate-bypass attempt leaves no trail). We do NOT
  // throw — that would crash the IPC watcher process on a contributor bug,
  // taking down all other in-flight dispatches with it. Loud-but-contained
  // is the right failure mode.
  const wantsSkipGate = auth.skipGate === true;
  if (wantsSkipGate && !SKIP_GATE_ALLOWLIST.has(handler.type)) {
    logger.error(
      { type: handler.type, sourceGroup: ctx.sourceGroup },
      'IPC handler declared skipGate but type is not on SKIP_GATE_ALLOWLIST — denying',
    );
    if (ctx.agentName) {
      // Agent-attributed violation. Write the audit row so a security
      // reviewer can grep for this outcome and find every contract abuse.
      try {
        insertAgentAction({
          agent_name: ctx.agentName,
          group_folder: ctx.baseGroup,
          action_type: handler.type,
          trust_level: 'contract_violation',
          summary: `off-allowlist skipGate (target=${auth.target.slice(0, 100)})${payloadAttributed ? ' [payload-agent]' : ''}`,
          target: auth.auditTarget ?? auth.target,
          outcome: 'denied_contract_violation',
        });
      } catch (err) {
        // Audit write failure is itself a violation we can't recover from
        // here. Log and proceed with the denial — primary discipline (deny)
        // is preserved even if forensics fails.
        logger.error(
          { err, type: handler.type },
          'Failed to write contract-violation audit row',
        );
      }
    }
    return { handled: true };
  }

  const auditSummary = auth.auditSummary ?? auth.target;
  const auditTarget = auth.auditTarget ?? auth.target;
  const auditActionType = auth.actionTypeOverride ?? handler.type;
  // Forensic marker: audit rows whose attribution came from the payload
  // (container-stamped `agent` field) are distinguishable from
  // directory-derived attribution.
  const gateSummary = payloadAttributed
    ? `${auditSummary} [payload-agent]`
    : auditSummary;

  // The gate performs synchronous DB writes (audit row, staging insert).
  // A throw here — SQLITE_BUSY past the busy_timeout, malformed staging
  // payload — must not escape the dispatcher: for result-kind handlers
  // that would skip the Rule-1 result file and hang the container poller
  // for its full timeout. Loud-but-contained, like the execute() catch.
  let decision: GateDecision | null;
  try {
    decision = wantsSkipGate
      ? null
      : gateAndStage({
          agentName: ctx.agentName,
          baseGroup: ctx.baseGroup,
          actionType: auditActionType,
          summary: gateSummary,
          target: auditTarget,
          payloadForStaging: auth.payloadForStaging,
        });
  } catch (err) {
    logger.error(
      {
        err,
        type: handler.type,
        sourceGroup: ctx.sourceGroup,
        requestId,
        agentName: ctx.agentName,
      },
      'Trust gate threw during dispatch — dropping action',
    );
    if (responseKind === 'result' && requestId !== null) {
      writeResultFile(ctx.dataDir, ctx.sourceGroup, resultsDirName, requestId, {
        success: false,
        message: 'Error: trust gate failure — action not executed',
      });
    }
    return { handled: true };
  }
  if (decision !== null && !decision.allowed) {
    // Phase 0c (R3-C3 amendment): write a stage-result file for result-kind
    // handlers so the container poller doesn't hang IPC_TIMEOUT_MS waiting
    // on a file the old short-circuit never wrote. Notify-kind handlers
    // don't need this — they have no result-file contract.
    //
    // The `decision.pendingId !== null` guard pins this to the stage path
    // (level=draft/ask). A future "blocked" path (level=denied) would have
    // pendingId=null and we'd correctly NOT write a result file — the agent
    // should see a timeout, matching the legacy deny semantics. Today only
    // the stage path produces !allowed, so this is forward-compatible.
    if (
      responseKind === 'result' &&
      requestId !== null &&
      decision.pendingId !== null
    ) {
      writeResultFile(ctx.dataDir, ctx.sourceGroup, resultsDirName, requestId, {
        executed: false,
        staged: true,
        pendingId: decision.pendingId,
        message: `Staged for approval: ${decision.pendingId}`,
      });
    }
    return { handled: true };
  }

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
      {
        err,
        type: handler.type,
        sourceGroup: ctx.sourceGroup,
        requestId: ctx.requestId,
        agentName: ctx.agentName,
      },
      'IPC handler execute threw',
    );
    // Delivery handlers (message/send_file) opt into rethrow so the watcher
    // moves the claimed IPC file to errors/ for inspection/replay — the
    // pre-migration ladder semantics. Result-kind handlers must NOT set
    // this: their contract is to always write a failure result file below
    // so the container poller never hangs.
    if (handler.rethrowExecuteErrors) throw err;
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
    writeResultFile(
      ctx.dataDir,
      ctx.sourceGroup,
      resultsDirName,
      requestId!,
      filePayload,
    );

    // Trust-level `notify` semantics for result-kind handlers: execute,
    // write the result file, THEN send the post-hoc receipt to main —
    // ordering guarantees the in-container agent sees the file before
    // the user sees the Telegram notify. The guards express: gate ran
    // (not skipGate) and asked for a notify, no throw, no bail, and the
    // side effect reported real success ({success:true} payload — a
    // bridge 4xx/5xx stays silent).
    //
    // History: this branch used to require a handler-side postHocNotify
    // opt-in (Batch 2F.1), which made trust level 'notify' a silent
    // no-op for every result-kind handler that didn't set it — the
    // 2026-07-19 review killed the flag; decision.notify alone drives.
    if (
      decision !== null &&
      decision.notify &&
      !executeThrew &&
      executed &&
      isSuccessPayload(resultPayload) &&
      !notifySuppressedBySelfEcho(auth)
    ) {
      await fireNotifyIfRequested(decision, {
        agentName: ctx.agentName,
        actionType: auditActionType,
        summary: auth.notifySummary,
        target: auth.target,
        registeredGroups: ctx.registeredGroups,
        deps: ctx.deps,
      });
    }
  } else if (
    executed &&
    !executeThrew &&
    decision !== null &&
    !notifySuppressedBySelfEcho(auth)
  ) {
    // Notify path (existing behaviour). decision is null only for skipGate
    // calls, which are read-only and on the allowlist — by construction they
    // never produce a notify, and skipping fireNotifyIfRequested here keeps
    // that invariant explicit.
    //
    // !executeThrew: a throw leaves `executed` at its initialized true, so
    // without this guard a failed delivery fired a receipt to main claiming
    // success (2026-07-14 review). Mirrors the result-kind branch above.
    //
    // notifySuppressedBySelfEcho gates the chatJid-aware self-echo case: a
    // message delivered TO the main jid must not also fire a receipt to main
    // (it would echo into the same chat). See IpcAuthorization
    // .suppressNotifyWhenTargetIs.
    await fireNotifyIfRequested(decision, {
      agentName: ctx.agentName,
      actionType: auditActionType,
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
 * Path: {dataDir}/ipc/{sourceGroup}/{resultsDirName}/{requestId}.json.
 *
 * `dataDir` comes from ctx.dataDir — the production DATA_DIR by default,
 * or a tmpdir override in tests. `resultsDirName` comes from the handler's
 * `resultsDirName` field (legacy override) or the dispatcher's default
 * `${type}_results` (new handlers).
 *
 * Best-effort: a write failure is logged but does not propagate, since the
 * caller (dispatcher) is past the side effect and the agent will time out
 * its poll — the correct failure mode.
 */
function writeResultFile(
  dataDir: string,
  sourceGroup: string,
  resultsDirName: string,
  requestId: string,
  payload: unknown,
): void {
  try {
    const resultsDir = path.join(dataDir, 'ipc', sourceGroup, resultsDirName);
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

/**
 * True iff `payload` is a `{ success: true, ... }` object shape.
 *
 * Used by the dispatcher's postHocNotify branch to gate the post-write
 * Telegram notify on whether the handler's `execute` reported the side
 * effect as successful. A bridge 4xx/5xx returns `{success: false}` and
 * must not produce a notify (legacy semantics for slack_dm).
 *
 * Narrow on purpose: only the literal boolean `true` qualifies. A handler
 * that returns `{success: 'true'}` (string) or `{success: 1}` (number)
 * will fail the check. See spec Risks table.
 */
export function isSuccessPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { success?: unknown }).success === true
  );
}

/**
 * True when the post-hoc notify should be suppressed because the action's
 * target equals `auth.suppressNotifyWhenTargetIs` — the chatJid-aware
 * self-echo guard for delivery-shaped handlers (see
 * IpcAuthorization.suppressNotifyWhenTargetIs). Returns false (no
 * suppression) when the field is unset.
 */
function notifySuppressedBySelfEcho(auth: IpcAuthorization): boolean {
  return (
    auth.suppressNotifyWhenTargetIs !== undefined &&
    auth.suppressNotifyWhenTargetIs === auth.target
  );
}

/**
 * Write a synthetic `agent_actions` row for a pre-execute dispatcher drop
 * (Batch 4 paths B + C). Used when an agent caller's IPC is rejected
 * before `handler.execute()` runs — without this row, the caller leaves
 * zero forensic trail in the canonical audit table.
 *
 * Non-agent callers (`ctx.agentName === null`) skip the write, matching
 * the existing `NON_AGENT_DECISION` convention at trust-gate.ts:27-32 —
 * non-agent calls never write audit rows on any path.
 *
 * `target` is omitted because `AgentActionInput.target` is `target?: string`
 * (optional, NOT nullable) and `insertAgentAction` at db.ts:1416 coerces
 * falsy values to SQL NULL via `action.target || null`.
 *
 * Contrast: the contract-violation row written in the SKIP_GATE_ALLOWLIST
 * enforcement block (search for `denied_contract_violation` in this file)
 * *does* set target because the gate auth provides one; here the drop
 * happens before authorization runs, so no target exists to pass.
 *
 * Failures are logged-and-continued (not propagated) — a DB hiccup must
 * not crash the IPC watcher and take down all in-flight dispatches.
 * Primary discipline = drop the bad call; forensic write is best-effort.
 */
function writeSyntheticAuditRow(
  ctx: IpcHandlerContext,
  type: string,
  requestId: string | null,
  trust_level: 'dispatch_drop_input',
  summary: string,
  outcome: 'dropped_invalid_requestId' | 'dropped_invalid_input',
): void {
  if (!ctx.agentName) return;
  try {
    insertAgentAction({
      agent_name: ctx.agentName,
      group_folder: ctx.baseGroup,
      action_type: type,
      trust_level,
      summary: requestId
        ? `${summary} (req=${requestId.slice(0, 64)})`
        : summary,
      outcome,
    });
  } catch (err) {
    logger.error(
      { err, type, requestId },
      'Failed to write synthetic drop audit row',
    );
  }
}
