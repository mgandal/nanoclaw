import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { insertAgentAction } from '../db.js';
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
export const SKIP_GATE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Read-only
  'dashboard_query',
  'kg_query',
  'knowledge_search',
  'pageindex_fetch',
  'task_list',
  'slack_dm_read',
  'skill_search',
  'skill_invoked',
  'imessage_search',
  'imessage_read',
  'imessage_list_contacts',
  // Writes that bypassed the gate in the if-ladder. Migrated here as
  // "preserve current behaviour" (Rule 5). Each entry is a known
  // silent-failure-wedge candidate: closing the bypass is a Batch 4
  // follow-up that adds a trust.yaml entry + removes the type from
  // this list, in one focused commit per action.
  // TODO(Batch4): gate task_add / task_close / task_reopen / pageindex_index.
  'task_add',
  'task_close',
  'task_reopen',
  'pageindex_index',
  // Phase 4 (2026-05-19): save_skill + crystallize_skill REMOVED from this
  // list as the gate-activation policy flip went live. All 9 agents'
  // trust.yaml carry `save_skill: draft` + `crystallize_skill: draft`, so
  // every call now stages in pending_actions; user `/approve pa-xxx`
  // invokes the replay module (Phase 2) to actually write the SKILL.md.
  // See docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
  // and docs/superpowers/plans/2026-05-19-ipc-gate-activation-plan.md
  // Phase 4. Rollback: re-add both entries here AND re-add
  // `skipGate: true` to the two authorize() blocks in
  // src/ipc/handlers/skills.ts — gate stays inert without rows to approve.
  // Self-directed agent wakeup. Rate-limited (10/agent/group) in
  // scheduleWakeupHandler.authorize; handler writes its own audit row.
  // Phase 1.1 — see docs/superpowers/specs/2026-05-19-ipc-agent-self-wakeup-design.md
  'schedule_wakeup',
  // Crystallize candidate flow (spec 2026-05-23). Both are notify or
  // read-only telemetry; the body-generation that *creates* a SKILL.md
  // still goes through the existing crystallize_skill gate.
  'crystallize_candidate',
  'crystallize_candidate_fetch',
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
   * On `responseKind: 'result'` handlers, fire a post-hoc Telegram notify
   * after the result file is written. The notify fires only when ALL of:
   *   1. `auth.postHocNotify === true` (this flag)
   *   2. `executeThrew === false` (execute did not throw)
   *   3. `executed === true` (handler did not bail with `{executed: false}`)
   *   4. `decision !== null` (handler did not skipGate)
   *   5. `isSuccessPayload(resultPayload)` (the handler returned
   *      `{success: true, ...}` in its result payload — i.e. the side
   *      effect actually succeeded; a bridge 4xx/5xx that returns
   *      `{success: false}` skips the notify)
   *
   * The notify additionally AND's with `decision.notify` and
   * `input.agentName` inside `fireNotifyIfRequested` (trust-gate.ts:61).
   * Net effect: autonomous trust = silent; non-agent callers = silent;
   * bridge failure = silent.
   *
   * Legitimate use: legacy hybrid handlers that both surface a structured
   * result to the in-container agent (via result file) AND notify the user
   * out-of-band (via Telegram). `slack_dm` is the canonical case. New
   * handlers should choose one or the other if possible.
   *
   * Combining `postHocNotify` with `skipGate` is a contract violation —
   * the dispatcher loudly denies and writes a `denied_contract_violation`
   * audit row (parallel to the off-allowlist skipGate check above).
   *
   * Has no effect on `responseKind: 'notify'` handlers — those already
   * fire `fireNotifyIfRequested` via the dispatcher's existing notify
   * branch (the postHocNotify code path is nested inside
   * `if (responseKind === 'result')`, so it cannot run for notify-kind
   * handlers).
   */
  postHocNotify?: true;
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
        'malformed requestId',
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
      'parse rejected',
      'dropped_invalid_input',
    );
    return { handled: true };
  }

  const auth = handler.authorize(input, ctx);
  if (auth === null) return { handled: true };

  // Batch 2F.1: postHocNotify + skipGate is a contract violation. The
  // skipGate path returns `decision === null`, which would block the
  // postHocNotify branch silently. We make the violation loud, matching
  // the existing off-allowlist skipGate precedent below. This guards
  // against a future handler accidentally combining the two flags.
  //
  // Precedence: this check fires BEFORE the off-allowlist skipGate
  // check at line ~356. A handler with BOTH violations is attributed
  // here (the more specific intent foot-gun) rather than as off-
  // allowlist. Either attribution is correct; we prefer the narrower.
  if (auth.postHocNotify === true && auth.skipGate === true) {
    logger.error(
      {
        type: handler.type,
        sourceGroup: ctx.sourceGroup,
        agentName: ctx.agentName,
      },
      'IPC handler combined postHocNotify with skipGate — contract violation',
    );
    if (ctx.agentName) {
      try {
        insertAgentAction({
          agent_name: ctx.agentName,
          group_folder: ctx.baseGroup,
          action_type: handler.type,
          trust_level: 'contract_violation',
          summary: `postHocNotify + skipGate (target=${auth.target.slice(0, 100)})`,
          target: auth.auditTarget ?? auth.target,
          outcome: 'denied_contract_violation',
        });
      } catch (err) {
        logger.error(
          { err, type: handler.type },
          'Failed to write postHocNotify+skipGate contract-violation audit row',
        );
      }
    }
    return { handled: true };
  }

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
          summary: `off-allowlist skipGate (target=${auth.target.slice(0, 100)})`,
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

  const decision = wantsSkipGate
    ? null
    : gateAndStage({
        agentName: ctx.agentName,
        baseGroup: ctx.baseGroup,
        actionType: auditActionType,
        summary: auditSummary,
        target: auditTarget,
        payloadForStaging: auth.payloadForStaging,
      });
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
      const resultsDirName =
        handler.resultsDirName ?? `${handler.type}_results`;
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
    writeResultFile(
      ctx.dataDir,
      ctx.sourceGroup,
      resultsDirName,
      requestId!,
      filePayload,
    );

    // Batch 2F.1: postHocNotify for hybrid handlers (slack_dm). Fires
    // AFTER the result file write so the in-container agent sees the
    // file before the user receives the Telegram notify. The 5 AND'd
    // guards collectively express: opt-in, no throw, no bail, gate ran
    // (not skipGate), bridge reported real success.
    //
    // fireNotifyIfRequested internally AND's with decision.notify and
    // input.agentName (trust-gate.ts:61), so autonomous trust and
    // non-agent callers are silent without needing dispatcher-side
    // checks for those conditions.
    if (
      auth.postHocNotify &&
      !executeThrew &&
      executed &&
      decision !== null &&
      isSuccessPayload(resultPayload)
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
  } else if (executed && decision !== null) {
    // Notify path (existing behaviour). decision is null only for skipGate
    // calls, which are read-only and on the allowlist — by construction they
    // never produce a notify, and skipping fireNotifyIfRequested here keeps
    // that invariant explicit.
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
