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
- `executed` — same rationale; an `executed:false` bail produces a `{success:false}` file.
- `decision !== null` — `skipGate` handlers return `null` for `decision`. They never produce a notify (read-only by allowlist). `slack_dm` is a write and is not on `SKIP_GATE_ALLOWLIST`, so `decision` is always non-null for valid calls. The guard is defense-in-depth — if anyone accidentally adds `postHocNotify + skipGate` to a future handler, the dispatcher fails silent rather than firing an unauthorized notify.
- `isSuccessPayload(resultPayload)` — matches legacy `slack_dm` semantics: notify only on bridge 2xx. A 4xx/5xx returns `{success:false}` in the result file and skips the notify.

`fireNotifyIfRequested` already AND's with `decision.notify` internally (confirmed via reading `trust-gate.ts`), so the dispatcher does not need to check `decision.notify` itself — passing `decision` is enough.

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
    if (ctx.agentName === null) return null; // write actions require agent
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
      },
      'slack_dm IPC handled',
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
- `authorize` returns `null` for non-agent callers — write actions never accept non-agent invocation. This is a small, deliberate divergence from legacy (see Behavior-Preservation Matrix). Mirrors `imessageSendHandler`.
- `auditSummary: input.text || ''` matches legacy `summary: data.text` (ipc.ts:1096). The trust-enforcement layer truncates to 200 chars — pre-existing cluster-wide behavior, not new.
- `notifySummary` matches legacy at ipc.ts:1168 (`Slack DM → … : …`). The 120-char slice is preserved exactly.
- `logger.info` inside execute mirrors legacy at ipc.ts:1182.

### Change 3: Strip legacy

- Delete `src/ipc.ts:958-972` (dispatcher if-ladder branch for `slack_dm`).
- Delete `src/ipc.ts:1074-1196` (entire `handleSlackDmIpc` function — verify exact line range at execute time; `handleSlackDmReadIpc` is already gone post-Batch 2F).
- Update the inline comment block in `src/ipc.ts:951-961` to drop the "slack_dm remains in if-ladder pending Batch 2F.1" caveat and add a `slack_dm migrated to src/ipc/handlers/slack.ts` line.
- Register `slackDmHandler` in `src/ipc/handlers/index.ts` immediately after `slackDmReadHandler` (cluster grouping per R2 convention).
- If any imports become orphaned (e.g. `firePostHocNotify` if `slack_dm` was its only caller), strip them. Plan-time grep will check.

## Test plan

Tests split into two files:

**A. New dispatcher contract test:** `src/ipc/handler-post-hoc-notify.test.ts` (mirrors `handler-action-type-override.test.ts`).
**B. Handler tests:** new `describe('slack_dm handler')` block appended to existing `src/ipc/handlers/slack.test.ts`.

### A. Dispatcher contract tests (5 tests)

Each registers a stub handler with `type: 'wire_x'`, `responseKind: 'result'`, `resultsDirName: 'wire_x_results'`. The stub's `authorize` returns the various combinations. `sendMessage` is spied via `deps.sendMessage`.

1. **`postHocNotify && success && decision.notify → sendMessage called once.`** Stub returns `{executed:true, result:{success:true, message:'ok'}}`. Agent caller, `trust.yaml` set to `wire_x: notify`. Expect: result file written, `sendMessage` called with notify text containing `auth.notifySummary`.
2. **`postHocNotify && success && !decision.notify (autonomous) → sendMessage NOT called.`** Same as #1 but `trust.yaml` set to `wire_x: autonomous`. Expect: result file written, `sendMessage` not called.
3. **`postHocNotify && !success (bridge failed) → sendMessage NOT called.`** Stub returns `{executed:true, result:{success:false, message:'bridge 500'}}`. Trust level `notify`. Expect: result file written with failure payload, `sendMessage` not called.
4. **`!postHocNotify && success → sendMessage NOT called` (no opt-in regression).** Same shape as #1 but `auth.postHocNotify` omitted. Expect: result file written, `sendMessage` not called. Pins that other result-kind handlers (dashboard_query, kg_query, imessage_read, pageindex_*, tasks_*) are unaffected.
5. **Ordering: result file exists on disk before `sendMessage` is awaited.** Wire a `sendMessage` spy whose body reads the result file and asserts it exists. Expect: assertion passes (file written first), `sendMessage` called once.

### B. `slack_dm handler` describe block in `slack.test.ts` (16 tests)

Unit-level (6):

6. `parse` returns null for non-object input.
7. `parse` extracts `{text, user_id, user_email}` and coerces wrong types to undefined.
8. `authorize` returns null for non-agent caller.
9. `authorize` returns IpcAuthorization with `postHocNotify:true`, `actionTypeOverride:'send_slack_dm'`, `target = user_email || user_id || ''`, `auditSummary = text`, `notifySummary` matches legacy format including 120-char slice.
10a. `execute` missing `text` returns `{executed:true, result:{success:false, message:'Missing required parameters: text and either user_id or user_email'}}`.
10b. `execute` missing both `user_id` and `user_email` returns same failure message.

Execute-level (4):

11. `execute` happy path: fetch POST 19876/slack/dm with body matching `{text, user_id?, user_email?}`; on `{ok:true, status:200, json: {message:'sent'}}` returns `{executed:true, result:{success:true, message:'sent', data:<response>}}`.
12. `execute` bridge 4xx with `{error:'user_not_found'}` returns `{executed:true, result:{success:false, message:'user_not_found'}}`.
13. `execute` bridge 5xx with `{}` returns `{executed:true, result:{success:false, message:'Bridge returned 500'}}`.
14. `execute` includes `user_email` in body when set, omits when undefined; same for `user_id`.

Integration (6):

15. End-to-end success writes result file at `slack_results/{requestId}.json` (NOT `slack_dm_results/`). Pin the path explicitly — guards against accidental `resultsDirName` drop, same shape as test 10 in `slack_dm_read`.
16. Dispatcher drops malformed requestId (`'../../etc/passwd'`), no file written (Rule 2).
17. Dispatcher drops missing requestId, no file written (Rule 2).
18. Dispatcher catches fetch rejection (`mockRejectedValueOnce(new Error('ECONNREFUSED'))`), writes failure file with `message` containing 'ECONNREFUSED'.
19. **Agent with `send_slack_dm: notify` + bridge 200 → result file written AND audit row `action_type='send_slack_dm', outcome='allowed'` AND `sendMessage` called once with `Slack DM → <target>: <text-slice>` summary.** This is THE load-bearing test that proves `postHocNotify` works end-to-end for the real handler.
20. **Agent with `send_slack_dm: autonomous` + bridge 200 → result file written AND audit row `outcome='allowed'` AND `sendMessage` NOT called.** Pins that the autonomous trust level remains silent post-migration.
21. Agent with `send_slack_dm: ask` → result file NOT written (gate stages, doesn't execute), audit row `outcome='staged'`. Matches the imessage_send pattern. **Tests the `else if (executed && decision !== null)` branch is not reached.**

Total: 5 (Section A) + 16 (Section B) = **21 new tests** (tests 10a and 10b count separately).

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
| Log line | `logger.info({requestId, sourceGroup, userId, userEmail}, 'slack_dm IPC handled')` | Same (added inside execute) | ✅ |
| Non-agent caller | Legacy: `if (agentName)` skipped, no gate, falls through to bridge call. Returns true. | New: `authorize` returns null → dispatcher drops, no bridge call, no file | ⚠️ DIVERGENCE |

### Documented divergence: non-agent caller

**Legacy:** `handleSlackDmIpc` accepts non-agent callers — the `if (agentName)` block at ipc.ts:1090-1109 is skipped, so the bridge call still fires, the result file still lands, and `firePostHocNotify` still runs (with `notify: false` because `slackNotify` defaults to `false`). Effectively a no-audit, no-notify but successful Slack send for non-agent callers.

**New:** `authorize` returns `null` for non-agent callers → dispatcher drops the call entirely (Rule 4). No bridge call, no result file.

**Why this is acceptable:**
1. No production code path invokes `slack_dm` from a non-agent caller. The only legitimate callers are in-container agents, which always set the compound source `{group}--{agentName}`.
2. All other write handlers in the migrated set (`imessage_send`, `tasks_close`, `deploy_mini_app`) already return null from `authorize` for non-agent callers. New behavior matches the cluster norm.
3. Plan will include a grep-check for any test/script that exercises the legacy non-agent path. If one exists, surface in plan-time as a blocker.

**Why we don't preserve the legacy:** The legacy path is dead code in practice and unsafe in principle (an attacker who could write a non-agent IPC file could send arbitrary Slacks with no audit trail). Closing it is a quiet security win.

### Other minor cluster-wide divergences (unchanged from Batch 2F)

- `agent_actions.summary` is truncated to 200 chars by `checkTrustAndStage` (`trust-enforcement.ts:113`). Legacy explicit `insertAgentAction` passed `summary` raw. Pre-existing cluster-wide divergence flagged in 2F spec. For `slack_dm`, summaries are `data.text` — could exceed 200 chars for long DM bodies. Will be flagged as a Batch 4 follow-up. Not blocking this batch.
- Outcome string space widens (could emit `'staged'` for `ask` level). Documented in test 21.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| **`postHocNotify` becomes a magnet for hybrid creep.** Future handlers use it to bolt notifies onto result-kind actions instead of choosing one. | Contract doc names `slack_dm` as THE canonical use case and tells authors to choose one if they can. Reviewer can grep `postHocNotify:` in PRs to catch new uses. |
| **Notify firing before file written breaks the in-container agent's poll-and-act ordering.** Agent reads file expecting the action already happened. | Test 5 (dispatcher ordering test) wires a `sendMessage` spy that asserts the file exists before `sendMessage` is awaited. Test 19 covers the end-to-end ordering. |
| **`isSuccessPayload` false-positives on a handler that returns `{success: true}` from a failure path.** | The check is narrow (`payload.success === true`). Every result-handler in the codebase today uses `success` as a strict boolean. Plan adds a grep-check for any handler returning `{success: 'true'}` (string) or `{success: 1}` (number) — none exist today. |
| **Non-agent divergence breaks a real caller we missed.** | Plan-time grep for `data.type === 'slack_dm'` and `slack/dm` outside `src/ipc/handlers/slack.ts` and `container/agent-runner/`. If any non-test, non-handler caller appears, surface as blocker. |
| **`fireNotifyIfRequested` semantics change between read of this spec and implementation.** | Spec pins the contract at `trust-gate.ts:fireNotifyIfRequested` AND-with-decision.notify behavior. Plan re-verifies via test 2 (autonomous trust → no notify). |
| **Half-migrated cluster window** (slack_dm in legacy + slack_dm_read in registry between commit 2 and 3 if split awkwardly). | Migration is single-commit (commit 2 adds handler + strips legacy + updates registry in one atomic change). No half-migrated window. |

## Scope discipline (what we are NOT doing)

- **Not** migrating `skill_save` / `skill_load` — Batch 2G.
- **Not** changing `fireNotifyIfRequested` — it already does the right thing.
- **Not** adding `postHocNotify` to any other handler.
- **Not** auditing other clusters for hybrid result+notify patterns. `slack_dm` is the only one — confirmed via reading the dispatcher branches in `src/ipc.ts:920-1000`.
- **Not** closing the 200-char summary truncation divergence — Batch 4 follow-up.
- **Not** changing the wire type `'slack_dm'` — `actionTypeOverride` handles the legacy audit name.
- **Not** renaming `trust.yaml` entries from `send_slack_dm` to `slack_dm` — the override preserves the legacy key.

## Acceptance criteria

1. `bun run test` passes after all commits (~2350 tests, exact count varies; baseline +21 from this batch).
2. `bun run typecheck` passes.
3. `bun run lint` passes.
4. New tests 1-5 (dispatcher contract) and 19-21 (audit + notify behavior pinning) all pass.
5. `grep -rln "send_slack_dm" data/agents/*/trust.yaml | wc -l` returns 9 (unchanged from pre-batch baseline).
6. `grep -nE "handleSlackDmIpc\b|handleSlackDmReadIpc\b" src/ipc.ts` returns zero matches (both clusters out of the if-ladder).
7. `grep -n "data.type === 'slack_dm'" src/ipc.ts` returns zero matches.
8. Manual smoke test (or test 19 by proxy): dispatch a `slack_dm` IPC from a test-agent caller with `send_slack_dm: notify`, confirm result file appears at `slack_results/{requestId}.json`, one `agent_actions` row with `action_type='send_slack_dm'`, and one `sendMessage` call.

## Commit sequence

1. `refactor(ipc): add postHocNotify to IpcAuthorization (Batch 2F.1 prep)`
   - `src/ipc/handler.ts`: extend interface + dispatcher + `isSuccessPayload` helper
   - `src/ipc/handler-post-hoc-notify.test.ts`: tests 1-5
   - `docs/context-engineering/ipc-handler-contract.md`: Rule 3 paragraph + authoring checklist bullet

2. `refactor(ipc): migrate slack_dm to IpcHandler registry (Batch 2F.1)`
   - `src/ipc/handlers/slack.ts`: append `slackDmHandler`
   - `src/ipc/handlers/slack.test.ts`: append `describe('slack_dm handler')` block (tests 6-21)
   - `src/ipc/handlers/index.ts`: register `slackDmHandler` after `slackDmReadHandler`
   - `src/ipc.ts`: strip dispatcher branch + delete `handleSlackDmIpc` + update comment block

3. `style(ipc): apply prettier formatting to slack cluster + postHocNotify test` *(only if prettier yields a diff)*

## Peer-review log

This spec was authored after a 5-question brainstorm with the user (2026-05-18 22:40 ET) that locked:
- Q1: postHocNotify on `IpcAuthorization` (per-call, symmetric with `skipGate` / `actionTypeOverride`).
- Q2: Trigger is `result.success === true` (matches legacy 2xx-only gating).
- Q3: AND with gate `decision.notify` (autonomous trust → silent, preserves legacy).
- Q4: Notify fires AFTER result-file write (preserves legacy ordering; tests pin).
- Q5: Same file (`slack.ts`) for both handlers; same test file (`slack.test.ts`) with new describe block.

Open questions for user before plan-writing: see "User Review Gate" below.

## Open questions for user review

None at spec time. The non-agent divergence is documented and the spec asks for plan-time grep-verification.
