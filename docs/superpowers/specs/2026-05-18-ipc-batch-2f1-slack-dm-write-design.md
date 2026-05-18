# Batch 2F.1 — `slack_dm` write migration with `postHocNotify` contract widening

**Status:** Spec — awaiting user review before plan-writing.
**Owner:** mgandal
**Date:** 2026-05-18
**Predecessor:** Batch 2F (`slack_dm_read` migration + `actionTypeOverride` widening, commits `8748c3d2`..`05d7585f`).
**Successor:** Batch 2G (`skill_save` / `skill_load` migration) — out of scope.

## TL;DR

Migrate the `slack_dm` write IPC action out of the `src/ipc.ts` if-ladder (function `handleSlackDmIpc`, lines 1074-1196) into a typed `IpcHandler` under the existing `src/ipc/handlers/slack.ts` (joining `slackDmReadHandler`). Three commits:

1. **Contract widening** — add `postHocNotify?: true` to `IpcAuthorization`. On a `responseKind: 'result'` handler, when the handler returns `result.success === true` AND the trust gate's `decision.notify` is `true`, the dispatcher fires `fireNotifyIfRequested` *after* writing the result file. This is the first IPC contract case where a single action both surfaces a structured result to the in-container agent (via result file) AND notifies the user out-of-band (via Telegram).
2. **Migrate `slack_dm`** — `slackDmHandler` joins `slack.ts`. Uses `actionTypeOverride: 'send_slack_dm'` to preserve audit/trust.yaml lookups across 9 live trust.yaml files. Strip the legacy if-ladder branch + `handleSlackDmIpc` function.
3. **Style** — prettier pass, only if it yields a diff.

## Why this matters

After Batch 2F, the slack cluster is half-migrated: `slack_dm_read` is in the registry, `slack_dm` is still in the if-ladder. The deferral was deliberate — `slack_dm`'s hybrid result+notify behavior had no contract expression. This batch adds that expression once, in the spirit of `actionTypeOverride` (a one-purpose flag for a real legacy pattern), and finishes the cluster migration. After it lands, only `skill_*` remains in the if-ladder.

The contract widening is general — any future handler that needs to write a structured result AND fire a user-facing notify can opt in. The spec deliberately frames it as a one-handler concession to avoid hybrid creep, but the mechanism is reusable.

## Source-of-truth references

- Contract doc: `docs/context-engineering/ipc-handler-contract.md`
- Dispatcher: `src/ipc/handler.ts` (esp. lines 77-130 `IpcAuthorization`, 305-405 `dispatchIpcAction` body, 371-403 the `result`/`notify` branches that this batch extends)
- Result-file writer: `src/ipc/handler.ts:421+` `writeResultFile()`
- Notify helper: `src/ipc/trust-gate.ts` `fireNotifyIfRequested()` (already AND's with `decision.notify` internally — confirmed via R1 read)
- Trust enforcement: `src/trust-enforcement.ts:98-120` `checkTrustAndStage()`
- Closest analogue handler (read sibling): `src/ipc/handlers/slack.ts` `slackDmReadHandler`
- Closest analogue test: `src/ipc/handlers/slack.test.ts`
- Closest analogue write handler (gate behavior reference): `src/ipc/handlers/imessage.ts` `imessageSendHandler`
- Legacy slack_dm handler: `src/ipc.ts:1074-1196` `handleSlackDmIpc`
- Legacy dispatcher branch: `src/ipc.ts:958-972`
- Container-side result reader: `container/agent-runner/src/ipc-mcp-stdio.ts` (hardcoded `slack_results/` dir; reused from read sibling)
- Container-side MCP tool description: `container/agent-runner/src/ipc-mcp-stdio.ts:1569` (references `send_slack_dm` trust key)
- Trust.yaml entries: 9 files under `data/agents/*/trust.yaml` reference `send_slack_dm`

## Architecture

### Change 1: Contract widening — `postHocNotify`

Add a fourth optional field to `IpcAuthorization` (after `actionTypeOverride` from Batch 2F):

```typescript
/**
 * On `responseKind: 'result'` handlers, fire a post-hoc Telegram notify
 * after the result file is written. The notify fires only when:
 *   1. `auth.postHocNotify === true` (this flag)
 *   2. The handler returned `executed: true` AND `result.success === true`
 *      (i.e. the side effect actually succeeded — not a bridge 4xx/5xx
 *      written as a failure result)
 *   3. The trust gate's `decision.notify === true` (i.e. trust.yaml says
 *      `notify`, not `autonomous` / `ask` / `draft`)
 *
 * All three must hold. Any one false → no notify (silent success at the
 * per-call level, which matches legacy behavior for `slack_dm`).
 *
 * Legitimate use: legacy hybrid handlers that both surface a structured
 * result to the in-container agent (via result file) AND notify the user
 * out-of-band (via Telegram). `slack_dm` is the canonical case. New
 * handlers should choose one or the other if possible; if both are
 * genuinely needed, the spec must justify the hybrid.
 *
 * Has no effect on `responseKind: 'notify'` handlers — those already fire
 * `fireNotifyIfRequested` via the dispatcher's existing notify branch.
 */
postHocNotify?: true;
```

**Dispatcher change** (`src/ipc/handler.ts:371-403`):

Today:

```typescript
if (responseKind === 'result') {
  // write file
  writeResultFile(...);
} else if (executed && decision !== null) {
  // notify path
  await fireNotifyIfRequested(decision, {...});
}
```

After:

```typescript
if (responseKind === 'result') {
  // write file (unchanged)
  writeResultFile(...);

  // NEW: post-hoc notify for hybrid handlers
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
  // notify path (unchanged)
  await fireNotifyIfRequested(decision, {...});
}
```

Plus a private helper at the bottom of `handler.ts`:

```typescript
/** True iff `payload` is `{ success: true, ... }` shape. */
function isSuccessPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { success?: unknown }).success === true
  );
}
```

**Why these guards in this order:**

- `auth.postHocNotify` — opt-in. Default-off preserves every other result-kind handler.
- `!executeThrew` — if execute threw, the dispatcher already wrote a `{success:false}` failure file at handler.ts:375-381. The success-payload guard below would catch this anyway, but explicit is clearer.
- `executed` — same rationale; an `executed:false` bail produces a `{success:false}` file (handler.ts:378). Test 5a pins this.
- `decision !== null` — required for the case when a `postHocNotify + skipGate` combination slips past the loud-deny check (defense in depth). See "Loud-deny check" below.
- `isSuccessPayload(resultPayload)` — matches legacy `slack_dm` semantics: notify only on bridge 2xx. A 4xx/5xx returns `{success:false}` in the result file and skips the notify.

`fireNotifyIfRequested` AND's with BOTH `decision.notify` AND `input.agentName` internally (verified at `src/ipc/trust-gate.ts:61`: `if (!decision.notify || !input.agentName) return;`). So the dispatcher's `decision !== null` guard is sufficient — non-agent callers get a `NON_AGENT_DECISION { notify: false }` from `gateAndStage`, which short-circuits `fireNotifyIfRequested` to a no-op. Both autonomous trust and non-agent invocation result in no notify, matching legacy.

**Loud-deny check for `postHocNotify + skipGate` (R1 High 2, peer-review amendment):**

Add a check immediately after `authorize` returns (handler.ts around line 270, parallel to the existing off-allowlist `skipGate` check at handler.ts:292-321):

```typescript
if (auth.postHocNotify && auth.skipGate) {
  insertAgentAction({
    agentName: ctx.agentName,
    groupFolder: ctx.baseGroup,
    actionType: handler.type, // wire type, like the off-allowlist check
    summary: 'postHocNotify + skipGate combination is not permitted',
    target: auth.target ?? '',
    outcome: 'denied_contract_violation',
    pendingId: null,
  });
  logger.error(
    { handlerType: handler.type, agentName: ctx.agentName },
    'IpcAuthorization combined postHocNotify with skipGate — contract violation',
  );
  return { handled: true };
}
```

This matches the existing dispatcher precedent (loud-deny on contract violation, not silent-fail-safe). Rationale: silent-fail on contract violations creates a debugging trap where misconfigured handlers silently do less than intended. Test 6 in Section A pins this behavior.

**`isSuccessPayload` edge: `resultPayload === undefined` (R3 High 4):**

If a `postHocNotify: true` handler's `execute` returns void (no `result` field), `resultPayload` stays `undefined`. The dispatcher's default-payload branch at handler.ts:381 writes `{success: true}` to the file (the synthetic success default), but `isSuccessPayload(undefined)` returns false because `typeof undefined !== 'object'`. So the file is `{success:true}` but the notify does NOT fire — a small asymmetry. **Deliberate decision:** keep the asymmetry as-is. A handler that opts into `postHocNotify` MUST explicitly return a success payload from `execute` to fire the notify — the synthetic default is a dispatcher convenience, not a notify signal. Slack handler always returns `{executed:true, result:...}` explicitly so this is YAGNI for the current scope, but documented for future handlers. Plan does not need a test for this — it is a forward-compat note.

**Contract doc change** (`docs/context-engineering/ipc-handler-contract.md`):

Add a paragraph after the existing `actionTypeOverride` paragraph in Rule 3, describing `postHocNotify` and naming `slack_dm` as the canonical case. Add a bullet to the authoring checklist warning against using it in new handlers.

### Change 2: Migrate `slack_dm`

`slackDmHandler` joins `src/ipc/handlers/slack.ts` below `slackDmReadHandler`:

```typescript
interface SlackDmInput {
  text: string | undefined;
  user_id: string | undefined;
  user_email: string | undefined;
}

export const slackDmHandler: IpcHandler<SlackDmInput, ExecuteResult> = {
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

  authorize(input, ctx) {
    // Non-agent callers fall through to gateAndStage → NON_AGENT_DECISION
    // (autonomous, notify=false). This matches the imessageSendHandler
    // pattern (verified by reading imessage.ts:184-202 directly — the
    // only check there is !ctx.isMain). For slack_dm there is no isMain
    // requirement either (legacy code at ipc.ts:1077 ignored isMain).
    // No notify ever fires for non-agent callers because
    // fireNotifyIfRequested AND's with input.agentName at trust-gate.ts:61.
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
      postHocNotify: true,
    };
  },

  async execute(input, ctx): Promise<ExecuteResult> {
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
```

**Key decisions:**

- `responseKind: 'result'` + `resultsDirName: 'slack_results'` — matches container hardcoded path; same dir as `slack_dm_read`.
- `actionTypeOverride: 'send_slack_dm'` — preserves audit + trust.yaml lookups for 9 trust.yaml files.
- `postHocNotify: true` — opt-in to the new contract feature.
- `authorize` returns a normal IpcAuthorization unconditionally — including for non-agent callers. The non-agent path is handled downstream by `gateAndStage` (`NON_AGENT_DECISION`) and `fireNotifyIfRequested`'s internal `agentName` AND-guard. This matches `imessageSendHandler` (verified at imessage.ts:184-202) and preserves the legacy behavior at ipc.ts:1090 where the `if (agentName)` gate was skipped for non-agent.
- `auditSummary: input.text || ''` matches legacy `summary: data.text` (ipc.ts:1096). The trust-enforcement layer truncates to 200 chars — pre-existing cluster-wide behavior, not new.
- `notifySummary` matches legacy at ipc.ts:1168 (`Slack DM → … : …`). The 120-char slice is preserved exactly.
- `logger.info` inside execute changes the message string from legacy `'slack_dm IPC handled'` (fired at ipc.ts:1182 after writeResult + firePostHocNotify) to `'slack_dm bridge call complete'` (fired inside execute, before the dispatcher writes the result file and before postHocNotify). **This is a deliberate operability divergence flagged by R2 peer review** — the new log fires earlier in the pipeline and means something narrower. Operators grepping for the old string need to update their alerts. The new string is more accurate (the log fires after the bridge call returns, not after the entire IPC has settled). Documented in the behavior-preservation matrix as ⚠️ DIVERGENCE.

### Change 3: Strip legacy

- Delete `src/ipc.ts:958-972` (dispatcher if-ladder branch for `slack_dm`).
- Delete `src/ipc.ts:1074-1196` (entire `handleSlackDmIpc` function — verify exact line range at execute time; `handleSlackDmReadIpc` is already gone post-Batch 2F).
- Update the inline comment block in `src/ipc.ts:951-961` to drop the "slack_dm remains in if-ladder pending Batch 2F.1" caveat and add a `slack_dm migrated to src/ipc/handlers/slack.ts` line.
- Register `slackDmHandler` in `src/ipc/handlers/index.ts` immediately after `slackDmReadHandler` (cluster grouping per R2 convention).
- If any imports become orphaned (e.g. `firePostHocNotify` if `slack_dm` was its only caller), strip them. Plan-time grep will check.

### Change 3b: Rewrite legacy test block (R1 Critical 1 + High 1)

The legacy describe block `'send_slack_dm trust enforcement (C13)'` at `src/ipc.test.ts:3646-3746` (4 tests, each calling `handleSlackDmIpc` directly) will not compile after the legacy function is deleted. The import at `src/ipc.test.ts:20` (`handleSlackDmIpc`) must also be removed.

**Test delta plan:**

- **Line 20 import:** Remove `handleSlackDmIpc` from the import block.
- **Lines 3680-3691 (`autonomous → no notify, no staging`):** Delete. Subsumed by new test 20 in `slack.test.ts` (autonomous trust + bridge 200 → file written, audit row, no sendMessage).
- **Lines 3692-3712 (`draft level → stages, no execute`):** Delete. Closest match is new test 21 (`ask` trust level → file NOT written, audit `outcome='staged'`). If draft-level behavior differs from ask, add a parallel test 21a — but per `src/trust-enforcement.ts`, draft and ask both stage. Verify at plan-time.
- **Lines 3714-3734 (`notify level → fires firePostHocNotify`):** Delete. Subsumed by new test 19 (notify trust + bridge 200 → file written, audit row, sendMessage called once with auditActionType in text).
- **Lines 3736-3746 (`bypasses trust for non-agent (main-group) callers`):** **Rewrite, do not delete.** This pins the non-agent path which is the cluster-norm-preserving design choice. Rewrite to dispatch the IPC via the new registry path (compound source without `--agent` suffix) and assert: `fetchSpy` called once (bridge call still fires for non-agent), no audit row written (gateAndStage returns NON_AGENT_DECISION early, skipping checkTrustAndStage), no sendMessage call. This becomes a new test in either `slack.test.ts` or stays in `ipc.test.ts` — plan-time decision.

**Concretely:** Commit 2 must include the `src/ipc.test.ts` edits to delete the import + delete/rewrite the four tests. If commit 2 only deletes the legacy function without updating `ipc.test.ts`, the build breaks before commit 3 runs.

## Test plan

Tests split into two files:

**A. New dispatcher contract test:** `src/ipc/handler-post-hoc-notify.test.ts` (mirrors `handler-action-type-override.test.ts`).
**B. Handler tests:** new `describe('slack_dm handler')` block appended to existing `src/ipc/handlers/slack.test.ts`.

### A. Dispatcher contract tests (7 tests)

Each registers a stub handler with `type: 'wire_x'`, `responseKind: 'result'`, `resultsDirName: 'wire_x_results'`. The stub's `authorize` returns the various combinations. `sendMessage` is spied via `vi.fn()` injected through `deps.sendMessage`. **Tests 1, 2, 3, 5, 5a must set up `deps.registeredGroups()` to return at least one entry with `isMain: true` so `firePostHocNotify` can resolve a main-jid recipient** — mirror the pattern at `src/ipc/handler-action-type-override.test.ts:148-176`.

1. **`postHocNotify && success && decision.notify → sendMessage called once with auditActionType in notify text.`** Stub returns `{executed:true, result:{success:true, message:'ok'}}`. Stub `type: 'wire_x'`, `actionTypeOverride: 'audit_x'`. Agent caller, `trust.yaml` set to `audit_x: notify`. Expect: result file written; `sendMessage` called once; `sent[0].text` contains `'audit_x'` AND does NOT contain `'wire_x'` (mirrors `handler-action-type-override.test.ts` Test 3 assertion shape — pins that postHocNotify uses `auditActionType` not `handler.type`, closing R2 Medium 1).
2. **`postHocNotify && success && !decision.notify (autonomous) → sendMessage NOT called.`** Same as #1 but `trust.yaml` set to `audit_x: autonomous`. Expect: result file written, `sendMessage` not called.
3. **`postHocNotify && !success (bridge failed) → sendMessage NOT called.`** Stub returns `{executed:true, result:{success:false, message:'bridge 500'}}`. Trust level `notify`. Expect: result file written with failure payload, `sendMessage` not called.
4. **`!postHocNotify && success → sendMessage NOT called` (no opt-in regression).** Same shape as #1 (trust.yaml `audit_x: notify` → `decision.notify=true`, ensuring this test catches a mutation that drops the `auth.postHocNotify` guard from the AND chain) but `auth.postHocNotify` omitted from authorize. Expect: result file written, `sendMessage` not called. Pins that other result-kind handlers (dashboard_query, kg_query, imessage_read, pageindex_*, tasks_*) are unaffected.
5. **Ordering: result file exists on disk before `sendMessage` is awaited.** Wire a `sendMessage` spy that captures `fs.existsSync(resultFile)` into an outer-scope variable on entry (do NOT throw inside the spy — `firePostHocNotify` wraps `sendMessage` in try/catch and swallows throws at trust-notify.ts:46-53, which would silently pass a buggy file-not-written case). After `dispatchIpcAction` returns, assert the captured `existedAtSpyEntry === true` AND `sendMessage` called exactly once. Closes R3 Critical 2.
5a. **`postHocNotify && execute returns {executed: false} → sendMessage NOT called.`** Stub `execute` returns `{executed: false}`. Trust level `notify`. Expect: result file written with `{success: false, message: 'execution bailed'}` (per handler.ts:378), `sendMessage` not called. Pins the `executed &&` guard — mutation that drops it should fail this test. Closes R3 High 3.
6. **`postHocNotify && skipGate → dispatcher rejects at authorize-time with contract-violation audit row.`** Stub returns `{postHocNotify: true, skipGate: true, ...}`. Expect: dispatcher writes `agent_actions` row with `outcome='denied_contract_violation'`, no execute, no notify. **NOTE:** this requires Change 1 to ALSO add an authorize-time check rejecting `postHocNotify + skipGate` (analogous to the existing off-allowlist `skipGate` check at handler.ts:292-321). See Change 1 below — added per R1 High 2. Loud-deny chosen over silent-fail-safe for consistency with existing dispatcher precedent.

### B. `slack_dm handler` describe block in `slack.test.ts` (19 tests)

**Fixture discipline (R3 Medium 8):** Tests 19, 20, 21 each create a unique-suffixed agent dir under `DATA_DIR/agents/{name}/` via `test-slack-dm-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, write the trust.yaml inside, and clean up in `try/finally` — mirroring the existing pattern at `slack.test.ts:328-369` (the `req-audit` test for `slack_dm_read`). No shared agent fixture across the three trust levels; each test is independently runnable.

**`registeredGroups` fixture (R3 High 5):** Tests 19 + 20 must inject at least one main-group entry into `deps.registeredGroups()` so `firePostHocNotify` (`src/trust-notify.ts:37-40`) can resolve a main-jid recipient. Pattern: `deps.registeredGroups = () => ({ 'tg:main1': { isMain: true, name: 'Main', folder: 'telegram_main' } })`. Without this, test 19 would still pass `sendMessage called once` checks vacuously because the helper returns early before calling `sendMessage`.

Unit-level (6):

6. `parse` returns null for non-object input.
7. `parse` extracts `{text, user_id, user_email}` and coerces wrong types to undefined.
8. `authorize` returns a non-null IpcAuthorization for non-agent caller (matches imessageSendHandler pattern verified at imessage.ts:184-202). Pins the precedent — drop of the `if (ctx.agentName === null) return null;` first-draft line.
9. `authorize` returns IpcAuthorization with `postHocNotify:true`, `actionTypeOverride:'send_slack_dm'`, `target = user_email || user_id || ''`, `auditSummary = text`, AND the exact literal notifySummary. Specifically with `input = { text: 'x'.repeat(200), user_email: 'alice@example.com', user_id: undefined }`, assert `auth.notifySummary === 'Slack DM → alice@example.com: ' + 'x'.repeat(120)` (closes R3 Medium 7 — no "matches legacy format" fuzz, pin the exact string).
10a. `execute` missing `text` returns `{executed:true, result:{success:false, message:'Missing required parameters: text and either user_id or user_email'}}`.
10b. `execute` missing both `user_id` and `user_email` returns same failure message.

Execute-level (4):

11. `execute` happy path: fetch POST 19876/slack/dm with body matching `{text, user_id?, user_email?}`; on `{ok:true, status:200, json: {message:'sent'}}` returns `{executed:true, result:{success:true, message:'sent', data:<response>}}`.
12. `execute` bridge 4xx with `{error:'user_not_found'}` returns `{executed:true, result:{success:false, message:'user_not_found'}}`.
13. `execute` bridge 5xx with `{}` returns `{executed:true, result:{success:false, message:'Bridge returned 500'}}`.
14. `execute` includes `user_email` in body when set, omits when undefined; same for `user_id`.

Integration (9):

15. End-to-end success writes result file at `slack_results/{requestId}.json` (NOT `slack_dm_results/`). Pin the path explicitly — guards against accidental `resultsDirName` drop, same shape as test 10 in `slack_dm_read`. Note: container poller reads from `SLACK_RESULTS_DIR` at `container/agent-runner/src/ipc-mcp-stdio.ts:1601`; rename of this constant must update the handler.
16. Dispatcher drops malformed requestId (`'../../etc/passwd'`) for non-agent caller, no file written (Rule 2).
16b. Dispatcher drops malformed requestId for AGENT caller, no file written AND synthetic audit row with `outcome='dropped_invalid_requestId'` (Batch 4 dispatcher-observability contract). Closes R3 High 6.
17. Dispatcher drops missing requestId for non-agent caller, no file written (Rule 2).
17b. Dispatcher drops missing requestId for AGENT caller, synthetic audit row written. Closes R3 High 6.
18. Dispatcher catches fetch rejection (`mockRejectedValueOnce(new Error('ECONNREFUSED'))`), writes failure file with `message` containing 'ECONNREFUSED'.
18b. Dispatcher catches `response.json()` rejection on bridge 200 + non-JSON body (mock `{ok:true, status:200, json: async () => { throw new Error('Unexpected token <'); }}`), writes failure file with `message` containing 'Unexpected token'. Mirrors `slack.test.ts:306-323` for `slack_dm_read`. Closes R3 Medium 9.
19. **Agent with `send_slack_dm: notify` + bridge 200 → result file written AND audit row `action_type='send_slack_dm', outcome='allowed'` AND `sendMessage` called once with `Slack DM → <target>: <text-slice>` summary.** Per the `registeredGroups` fixture note above. This is THE load-bearing test that proves `postHocNotify` works end-to-end for the real handler.
20. **Agent with `send_slack_dm: autonomous` + bridge 200 → result file written AND audit row `outcome='allowed'` AND `sendMessage` NOT called.** Pins that the autonomous trust level remains silent post-migration.
21. Agent with `send_slack_dm: ask` → result file NOT written (gate stages, doesn't execute), audit row `outcome='staged'`. Matches the imessage_send pattern. **Tests the dispatcher returns before the result branch and the new postHocNotify code path is not reached.** Note: `outcome='staged'` verified at `src/trust-enforcement.ts:115-119`.

Total: 7 (Section A) + 19 (Section B) = **26 new tests** (10a/10b, 16/16b, 17/17b, 18/18b count separately; test 5a is part of Section A).

## Behavior-preservation matrix (Rule 5 verification)

| Behavior | Legacy (`handleSlackDmIpc`) | New (`slackDmHandler`) | Match? |
|---|---|---|---|
| Wire result-file path | `{DATA_DIR}/ipc/{group}/slack_results/{requestId}.json` | Same (`resultsDirName: 'slack_results'`) | ✅ |
| Result-file payload shape on success | `{success:true, message, data}` | Same | ✅ |
| Result-file payload shape on bridge failure | `{success:false, message: result.error || 'Bridge returned <N>'}` | Same | ✅ |
| Result-file payload shape on missing params | `{success:false, message:'Missing required parameters...'}` | Same | ✅ |
| Result-file payload shape on throw | `{success:false, message:'Error: <err>'}` | Same (dispatcher catch at handler.ts:356-369 sets `executeThrew`; failure payload constructed at 375-381) | ✅ |
| `agent_actions.action_type` | `'send_slack_dm'` (explicit in `checkTrustAndStage` call at ipc.ts:1095) | `'send_slack_dm'` (via `actionTypeOverride`) | ✅ |
| `agent_actions.summary` | `data.text || ''` (ipc.ts:1096) — note: subject to `checkTrustAndStage` 200-char truncate | Same (via `auditSummary: input.text || ''`) | ✅ |
| `agent_actions.target` | `data.user_email || data.user_id || ''` | Same (via `target` field) | ✅ |
| Trust-deny outcome | `if (!decision.allowed) return true` — no result file, no notify | gateAndStage denies → dispatcher returns `{handled:true}` before execute, no result file (matches Rule 4) | ✅ |
| Trust `notify` outcome | After bridge 2xx, `firePostHocNotify({notify: decision.notify, …})` fires Telegram | After bridge 2xx (i.e. `result.success === true`), dispatcher checks `auth.postHocNotify && decision.notify` via `fireNotifyIfRequested`, fires Telegram | ✅ |
| Trust `autonomous` outcome | After bridge 2xx, `firePostHocNotify({notify: false, …})` is a no-op | Same — `fireNotifyIfRequested` AND's with `decision.notify` internally | ✅ |
| Trust `ask` outcome | `checkTrustAndStage` stages action in `pending_actions`, returns `{allowed:false}` → no result file | Same — `gateAndStage` stages, dispatcher returns before execute | ✅ |
| Notify on bridge failure | NOT fired (legacy: notify is inside the `if (response.ok)` block at ipc.ts:1157) | NOT fired (`isSuccessPayload` returns false for `{success:false}`) | ✅ |
| Log line message + position | `logger.info({requestId, sourceGroup, userId, userEmail}, 'slack_dm IPC handled')` fired at ipc.ts:1182 AFTER writeResult + firePostHocNotify (i.e. after side effects settle) | `logger.info({sourceGroup, user_id, user_email, bridgeStatus}, 'slack_dm bridge call complete')` fired inside `execute` BEFORE dispatcher writes file or fires notify. Operators grepping the legacy string for "action complete" will get a false signal unless they update to the new string. | ⚠️ DIVERGENCE (R2 H1) |
| Non-agent caller | Legacy: `if (agentName)` skipped, no gate (i.e. NON_AGENT_DECISION-equivalent), bridge call fires, file lands, firePostHocNotify called with `notify: false`. | New: `authorize` returns IpcAuthorization unconditionally → dispatcher gates via `gateAndStage` which returns `NON_AGENT_DECISION { autonomous, notify: false }` for `agentName === null` → execute fires → result file lands → postHocNotify guard's `decision !== null` is true but `fireNotifyIfRequested` AND's with `agentName` (trust-gate.ts:61), no notify fires. | ✅ |

### Non-agent caller policy (matches imessage_send precedent)

The first draft of this spec had `authorize` return `null` for non-agent callers, justified as matching the imessage_send cluster norm. **R1 peer review caught that the precedent was false** — `imessageSendHandler.authorize` (verified at imessage.ts:184-202) only blocks `!ctx.isMain`, NOT `agentName === null`. Non-agent main-group callers fall through to `gateAndStage` → `NON_AGENT_DECISION` (autonomous, no notify) → execute fires.

**Revised policy:** Match the real precedent. `slackDmHandler.authorize` accepts non-agent callers and returns a normal IpcAuthorization. They flow through:
- `gateAndStage` (trust-gate.ts:34) returns `NON_AGENT_DECISION` early when `agentName === null`.
- `execute` fires (bridge call, result file written).
- `postHocNotify` guard chain: `decision !== null` passes, `isSuccessPayload` passes on bridge 2xx, BUT `fireNotifyIfRequested` (trust-gate.ts:61) AND's with `input.agentName` internally → returns early → no notify fires.

**Result:** Non-agent callers get identical legacy behavior — bridge call, result file, no notify, no audit row (because `checkTrustAndStage` is never reached). Zero behavior change.

This also preserves the live test at `src/ipc.test.ts:3737-3745` ("bypasses trust for non-agent (main-group) callers") which asserts the bridge is called when no agent is set. That test will be updated to use the new dispatcher path (described in the test-delta section below) but the underlying behavior assertion remains valid.

### Other minor cluster-wide divergences (unchanged from Batch 2F)

- `agent_actions.summary` is truncated to 200 chars by `checkTrustAndStage` (`trust-enforcement.ts:113`). Legacy explicit `insertAgentAction` passed `summary` raw. Pre-existing cluster-wide divergence flagged in 2F spec. For `slack_dm`, summaries are `data.text` — could exceed 200 chars for long DM bodies. Will be flagged as a Batch 4 follow-up. Not blocking this batch.
- Outcome string space widens (could emit `'staged'` for `ask` level). Documented in test 21.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| **`postHocNotify` becomes a magnet for hybrid creep.** Future handlers use it to bolt notifies onto result-kind actions instead of choosing one. | Contract doc names `slack_dm` as THE canonical use case and tells authors to choose one if they can. Reviewer can grep `postHocNotify:` in PRs to catch new uses. |
| **Notify firing before file written breaks the in-container agent's poll-and-act ordering.** Agent reads file expecting the action already happened. | Test 5 (dispatcher ordering test) wires a `sendMessage` spy that captures `fs.existsSync` into an outer-scope variable on entry (NOT a throw-based assertion, which would be swallowed by `firePostHocNotify`'s try/catch at trust-notify.ts:46-53 — closes R3 Critical 2). Test 19 covers the end-to-end ordering. |
| **`isSuccessPayload` false-positives on a handler that returns `{success: true}` from a failure path.** | The check is narrow (`payload.success === true`). Every result-handler in the codebase today uses `success` as a strict boolean. Plan adds a grep-check for any handler returning `{success: 'true'}` (string) or `{success: 1}` (number) — none exist today. Acceptance criterion #9 (R1 Medium 1). |
| **A future handler opts into `postHocNotify` but returns `void` from `execute`.** Dispatcher writes synthetic `{success: true}` to the file (handler.ts:381) but `isSuccessPayload(undefined)` returns false → file says success, no notify. Documented asymmetry (R3 H4). | Forward-compat note in spec only; YAGNI for slack_dm itself. If a future handler needs the synthetic-success path to ALSO trigger notify, that's a contract decision that must be revisited deliberately. |
| **`fireNotifyIfRequested` semantics change between read of this spec and implementation.** | Spec pins the contract at `src/ipc/trust-gate.ts:61` — `if (!decision.notify \|\| !input.agentName) return;`. Plan re-verifies via test 2 (autonomous trust → no notify) and via test 19 fixture (non-agent → no notify even with `postHocNotify: true`). |
| **Half-migrated cluster window** (slack_dm in legacy + slack_dm_read in registry between commit 2 and 3 if split awkwardly). | Migration is single-commit (commit 2 adds handler + strips legacy function + updates registry + rewrites the C13 test block in one atomic change). No half-migrated window. |
| **Rename-failure atomicity (R2 Low 1, pre-existing).** `writeResultFile` is best-effort (atomic-on-rename, but rename can fail on disk-full / permission-denied); the dispatcher's `isSuccessPayload` reads the in-memory execute result, not the on-disk file. If rename fails, notify fires but agent times out. | Pre-existing architectural limitation, documented at handler.ts:416-420. Not in scope for this batch — affects every result-kind handler today. If the slack_dm case wants stronger atomicity, follow up in a future batch with a `writeResultFile` redesign. |
| **`fireNotifyIfRequested` or `firePostHocNotify` throw paths leak into dispatcher (R1 Medium 2).** Today `firePostHocNotify` wraps `deps.sendMessage` in try/catch at trust-notify.ts:46-53, so throws are swallowed and logged. If a future change removes that try/catch, the postHocNotify await in the dispatcher has no fallback. | Defense-in-depth: legacy ipc.ts:1131-1194 wraps everything in try/catch. The new dispatcher relies on `firePostHocNotify`'s internal try/catch. Plan adds a regression test sketch: if `sendMessage` rejects, dispatcher still returns `{handled: true}` and result file remains. Not a new test (covered transitively by test 5 + firePostHocNotify's existing tests). Document the implicit dependency in the contract doc. |

## Scope discipline (what we are NOT doing)

- **Not** migrating `skill_save` / `skill_load` — Batch 2G.
- **Not** changing `fireNotifyIfRequested` — it already does the right thing.
- **Not** adding `postHocNotify` to any other handler.
- **Not** auditing other clusters for hybrid result+notify patterns. `slack_dm` is the only one — confirmed via reading the dispatcher branches in `src/ipc.ts:920-1000`.
- **Not** closing the 200-char summary truncation divergence — Batch 4 follow-up.
- **Not** changing the wire type `'slack_dm'` — `actionTypeOverride` handles the legacy audit name.
- **Not** renaming `trust.yaml` entries from `send_slack_dm` to `slack_dm` — the override preserves the legacy key.

## Acceptance criteria

1. `bun run test` passes after all commits (baseline ~2350 tests + 26 new − 4 deleted legacy C13 tests = net ~+22; exact count varies). The C13 block delete must happen in commit 2 alongside the legacy-function delete — otherwise the build breaks (R1 Critical 1).
2. `bun run typecheck` passes.
3. `bun run lint` passes.
4. New tests 1, 5, 5a, 6 (dispatcher contract — opt-in, ordering, executed-bail, loud-deny) and 19, 20, 21 (audit + notify behavior pinning) all pass.
5. `grep -rln "send_slack_dm" data/agents/*/trust.yaml | wc -l` returns 9 (unchanged from pre-batch baseline).
6. `grep -nE "handleSlackDmIpc\b|handleSlackDmReadIpc\b" src/ipc.ts` returns zero matches (both clusters out of the if-ladder).
7. `grep -n "data.type === 'slack_dm'" src/ipc.ts` returns zero matches.
8. `grep -n "handleSlackDmIpc" src/ipc.test.ts` returns zero matches (the C13 import + four call sites must all be removed).
9. (R1 Medium 1 grep-check) For every handler in `src/ipc/handlers/` that returns `{success: true}` from any branch, confirm it does NOT set `postHocNotify: true` UNLESS every `{success: true}` branch represents a real, user-relevant side effect. Today this is just `slackDmHandler` — only the post-bridge-2xx branch returns `{success: true}`.
10. Manual smoke test (or test 19 by proxy): dispatch a `slack_dm` IPC from a test-agent caller with `send_slack_dm: notify`, confirm result file appears at `slack_results/{requestId}.json`, one `agent_actions` row with `action_type='send_slack_dm'`, and one `sendMessage` call.

## Commit sequence

1. `refactor(ipc): add postHocNotify to IpcAuthorization (Batch 2F.1 prep)`
   - `src/ipc/handler.ts`: extend interface + dispatcher (postHocNotify branch + loud-deny check for `postHocNotify + skipGate`) + `isSuccessPayload` helper
   - `src/ipc/handler-post-hoc-notify.test.ts`: tests 1-6 + 5a (7 dispatcher contract tests)
   - `docs/context-engineering/ipc-handler-contract.md`: Rule 3 paragraph + authoring checklist bullet

2. `refactor(ipc): migrate slack_dm to IpcHandler registry (Batch 2F.1)`
   - `src/ipc/handlers/slack.ts`: append `slackDmHandler`
   - `src/ipc/handlers/slack.test.ts`: append `describe('slack_dm handler')` block (tests 6-21 + 16b, 17b, 18b)
   - `src/ipc/handlers/index.ts`: register `slackDmHandler` after `slackDmReadHandler`
   - `src/ipc.ts`: strip dispatcher branch + delete `handleSlackDmIpc` + update comment block
   - `src/ipc.test.ts`: remove `handleSlackDmIpc` import (line 20), delete C13 trust enforcement tests (lines 3680-3734 — autonomous/draft/notify), rewrite the non-agent test (lines 3736-3746) to dispatch through the new registry path

3. `style(ipc): apply prettier formatting to slack cluster + postHocNotify test` *(only if prettier yields a diff)*

## Peer-review log

### Round 1 — Brainstorm with user (2026-05-18 22:40 ET)

Five-question structured brainstorm locked the contract decisions:
- Q1: postHocNotify on `IpcAuthorization` (per-call, symmetric with `skipGate` / `actionTypeOverride`).
- Q2: Trigger is `result.success === true` (matches legacy 2xx-only gating).
- Q3: AND with gate `decision.notify` (autonomous trust → silent, preserves legacy).
- Q4: Notify fires AFTER result-file write (preserves legacy ordering; tests pin).
- Q5: Same file (`slack.ts`) for both handlers; same test file (`slack.test.ts`) with new describe block.

### Round 2 — Adversarial reviewer pass (2026-05-18 ~23:00 ET)

Three parallel adversarial reviewers (R1: silent-failure-hunter, R2: code-reviewer for dispatcher composition, R3: pr-test-analyzer for test plan tautologies) dispatched against round-1 spec. Pre-loaded each with a specific skeptical hypothesis to falsify (per the `[adversarial-reviewer-prompt]` feedback memory). Findings:

**Critical (3) — applied inline:**
- R1 Critical 1: Live test at `src/ipc.test.ts:3737-3745` would fail post-migration; spec acceptance criterion #1 was wrong. **Fix:** added Change 3b + acceptance criterion #8 + commit-sequence updates listing the C13 block delete/rewrite.
- R1 Critical 2: Spec justified the non-agent deny with a false `imessageSendHandler` precedent. R1 verified imessage.ts:184-202 only blocks `!ctx.isMain`, not `agentName === null`. **Fix (user decision):** revised policy to match the real precedent — `authorize` returns a normal IpcAuthorization for non-agent callers; `gateAndStage`'s `NON_AGENT_DECISION` + `fireNotifyIfRequested`'s internal `agentName` AND-guard preserve legacy behavior exactly. Zero behavior change for non-agent callers.
- R3 Critical 2: Test 5 (ordering test) as originally written was tautological — `firePostHocNotify` swallows throws inside `sendMessage` spies (trust-notify.ts:46-53). **Fix:** rewrote test 5 to use the outer-scope-capture pattern; assertion happens after `dispatchIpcAction` returns.

**High (5) — applied inline:**
- R1 High 1: C13 describe block has 4 tests calling `handleSlackDmIpc` directly + an import; all must be deleted/rewritten in commit 2. **Fix:** added Change 3b with explicit line-range plan.
- R1 High 2: Silent-fail-safe on `postHocNotify + skipGate` is inconsistent with the existing loud-deny precedent at handler.ts:292-321. **Fix:** added an authorize-time loud-deny check writing a `denied_contract_violation` audit row + test 6 to pin it.
- R2 High 1: `logger.info` moved inside execute changes the message AND the timing — operability regression. **Fix:** renamed log message to `'slack_dm bridge call complete'` to reflect the narrower semantic; flagged as explicit DIVERGENCE in the behavior-preservation matrix with a note for operators relying on the legacy string.
- R3 High 3: Missing test for `executed: false` bail path. **Fix:** added test 5a.
- R3 High 5: Tests 19/20 main-jid setup under-specified — without `registeredGroups()` returning an isMain entry, `firePostHocNotify` never reaches `sendMessage` and "called once" assertions silently pass for the wrong reason. **Fix:** added the fixture discipline note at the top of Section B.
- R3 High 6: Tests 16/17 don't cover agent + malformed-requestId synthetic audit row path (Batch 4 contract). **Fix:** added tests 16b and 17b.

**Medium (5) — applied inline:**
- R2 Medium 1: Test 1 doesn't pin that `auditActionType` (not `handler.type`) propagates through to the notify text. **Fix:** rewrote test 1 to mirror the `handler-action-type-override.test.ts` assertion shape (`sent[0].text.toContain('audit_x')` + `.not.toContain('wire_x')`).
- R1 Medium 1: Forward-compat grep-check for `{success: true}` handlers that opt into `postHocNotify`. **Fix:** acceptance criterion #9.
- R1 Medium 2: No try/catch around the post-execute block; relies on `firePostHocNotify`'s internal try/catch. **Fix:** Risks-table entry documenting the implicit dependency.
- R3 High 4: `resultPayload === undefined` divergence — synthetic `{success: true}` file write but no notify. **Fix:** documented as a deliberate forward-compat asymmetry in the dispatcher-wiring section + Risks.
- R3 Medium 7: Test 9 fragility — "matches legacy format" is vague. **Fix:** pinned the exact expected literal string with concrete input.
- R3 Medium 8: Mock state pollution risk in tests 19/20/21. **Fix:** added the fixture discipline note (unique agent dirs + try/finally cleanup).
- R3 Medium 9: Missing test for bridge 200 + non-JSON body. **Fix:** added test 18b.

**Low (1) — applied inline:**
- R2 Low 1: Rename-failure atomicity. **Fix:** added to Risks table as pre-existing architectural limitation.

**Falsified (R2 A, B, C, D, F; R3 L10, L11, L12):** No bugs in the core architecture — dispatcher wiring is sound, `resultPayload` is in scope, `fireNotifyIfRequested` does AND-internally, no double-notify hazard, no auditTarget bug. These are documented but did not result in spec changes.

### Round 3 — Self-review of amended spec

After applying round-2 amendments, this round-3 self-review found no further critical issues. Test counts reconciled (26 new tests, 4 deleted). Acceptance criteria expanded from 8 to 10.

## Open questions for user review

None at spec time. The two policy decisions (non-agent → match imessage precedent; `postHocNotify + skipGate` → loud-deny) were resolved during the review pass.
