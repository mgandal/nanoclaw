# Phase 3a: Trust & Autonomy Framework

> **Status: INTENT SHIPPED via different artifacts (SUPERSEDED).** The plan's *concept* (trust gating, approval queue, promotion analyzer) shipped, but the schema and approval UX diverged from the original design. This plan called for `src/approval-tracker.ts`, `src/promotion-analyzer.ts`, a `data/trust.yaml` `draft` routing tier, and `max_promotion` keys — none of these specific artifacts exist. Actual delivery vehicles: **`pending_actions` table + `checkTrustAndStage`** (commits `a73af0a5`, `be0ff06c`, `fa68d5c3`, `0471f2c9` under the `2026-04-19-tier-b-trust-coverage.md` and `2026-04-18-adopt-queue.md` plans), and **promotion analyzer** added in `577d7cf4 feat(sync): add trust promotion analyzer as step 9`. The successor plans use in-band tool gating instead of Telegram-reply approvals. Treat this plan as a design artifact for the trust framework intent; the implementation lives in the two adopt-queue/tier-b plans. Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add approval tracking and automatic trust promotion to NanoClaw's event router, enabling the system to learn from user feedback and propose routing changes when patterns stabilize.

**Architecture:** Extend the Phase 2 event router with a `draft` routing tier that sends approval requests via Telegram and waits for user response. A SQLite table tracks every trust decision. A weekly promotion analyzer scans approval patterns and proposes trust rule changes. All runs within the existing NanoClaw process.

**Tech Stack:** TypeScript (Node.js), SQLite (better-sqlite3), YAML (yaml package), vitest for tests.

**Spec:** `docs/superpowers/specs/2026-03-21-vision-phase3a-trust-autonomy-design.md`

**IMPORTANT: This plan builds on Phase 2.** The worktree must branch from `feature/phase2-event-classification`, not from `main`. Phase 2 introduces the event router, classification prompts, and watchers that this plan modifies.

**Key codebase facts (verified against Phase 2 worktree):**
- `src/types.ts`: `NewMessage` interface at lines 45-54 (no `replyToMessageId` field yet). `Channel` interface has `sendMessage(jid, text): Promise<void>`.
- `src/channels/telegram.ts`: Grammy handler at line 258, NewMessage at lines 321-329, `sendMessage` at lines 619-645 (returns `Promise<void>`), helper `sendTelegramMessage` at line 201 (returns `Promise<void>`, calls `api.sendMessage` which returns `Message` with `message_id`)
- `src/event-router.ts`: `ClassifiedEvent` at lines 39-45, `TrustRule` at lines 54-59 (no `id` or `max_promotion`), `EventRouterConfig` at lines 75-84 (no `approvalTracker`), `route()` at line 116 with **unconditional** `messageBus.publish()` at lines 141-149, `applyTrustRules` at lines 293-304 returns routing string only
- `src/db.ts`: Schema at lines 18-87, `addColumn` helper at line 90. No `trust_decisions` table.
- `src/index.ts`: `onMessage` at lines 905-931 (intercepts remote control, sender allowlist, then stores), event router init at lines 788-807
- `src/config.ts`: Last line 149
- `config-examples/trust.yaml.example`: No rule IDs, no draft routing, no max_promotion
- `src/event-router.test.ts`: 210 lines

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/approval-tracker.ts` | SQLite CRUD for trust_decisions table |
| `src/approval-tracker.test.ts` | Tests for approval tracker |
| `src/promotion-analyzer.ts` | Analyzes approval patterns, proposes promotions |
| `src/promotion-analyzer.test.ts` | Tests for promotion analyzer |

### Modified Files

| File | Changes |
|------|---------|
| `src/db.ts` | Add `trust_decisions` table in schema creation |
| `src/types.ts` | Add `replyToMessageId?: string` to `NewMessage`, change `Channel.sendMessage` return type |
| `src/channels/telegram.ts` | Extract reply_to_message_id; return sent message ID from sendMessage |
| `src/event-router.ts` | Add `RoutingLevel` type with `'draft'`, conditional publish, `applyTrustRules` returns `{ routing, ruleId }`, `reloadFromPath()`, approval tracker integration |
| `src/event-router.test.ts` | Add draft routing tests |
| `src/index.ts` | Initialize approval tracker, add approval response handler, schedule promotion analysis |
| `src/config.ts` | Add promotion config constants |
| `config-examples/trust.yaml.example` | Add rule IDs, draft rules, max_promotion |

---

## Task 1: Config and Schema Prerequisites

Add config constants and DB schema. Must complete before other tasks.

**Files:**
- Modify: `src/config.ts` (add constants after line 149)
- Modify: `src/db.ts` (add table in schema creation, line ~87)

### Step 1.1: Add config constants

- [ ] **Add to end of `src/config.ts`:**

```typescript
// Promotion analyzer
export const PROMOTION_MIN_DECISIONS = parseInt(
  process.env.PROMOTION_MIN_DECISIONS || '30',
  10,
);
export const PROMOTION_THRESHOLD = parseFloat(
  process.env.PROMOTION_THRESHOLD || '0.95',
);
export const APPROVAL_EXPIRY_HOURS = parseInt(
  process.env.APPROVAL_EXPIRY_HOURS || '24',
  10,
);
```

- [ ] **Build:** `npm run build`
- [ ] **Commit:** `feat: add Phase 3a promotion config constants`

### Step 1.2: Add trust_decisions table

- [ ] **In `src/db.ts`, add after the `registered_groups` CREATE TABLE (after line 87), before the `addColumn` helper (line 89):**

```typescript
  database.exec(`
    CREATE TABLE IF NOT EXISTS trust_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_source TEXT NOT NULL,
      routing TEXT NOT NULL,
      trust_rule_id TEXT,
      classification_summary TEXT,
      classification_importance REAL,
      classification_urgency TEXT,
      user_response TEXT,
      user_feedback TEXT,
      responded_at TEXT,
      telegram_msg_id TEXT
    );
  `);
```

- [ ] **Build:** `npm run build`
- [ ] **Run tests:** `npm test` — all pass
- [ ] **Commit:** `feat: add trust_decisions table schema`

---

## Task 2: Telegram Plumbing

Add reply-to detection and message ID returns to the Telegram channel.

**Files:**
- Modify: `src/types.ts` (NewMessage + Channel interface)
- Modify: `src/channels/telegram.ts` (handler + sendMessage)

### Step 2.1: Add replyToMessageId to NewMessage

- [ ] **In `src/types.ts`, add before the closing `}` of `NewMessage` (before line 54):**

```typescript
  replyToMessageId?: string;
```

- [ ] **Commit:** `feat: add replyToMessageId to NewMessage type`

### Step 2.2: Extract reply_to_message in Grammy handler

- [ ] **In `src/channels/telegram.ts`, modify the NewMessage construction at lines 321-329. Add `replyToMessageId` field:**

Add this line after `is_from_me: false,`:
```typescript
        replyToMessageId: ctx.message.reply_to_message?.message_id?.toString(),
```

- [ ] **Commit:** `feat: extract Telegram reply_to_message_id`

### Step 2.3: Return message ID from sendMessage

- [ ] **Modify `sendTelegramMessage` helper (line 201):** Change return type from `Promise<void>` to `Promise<number | undefined>`. Capture and return `result.message_id` from `api.sendMessage()`.

- [ ] **Modify `sendMessage` method on TelegramChannel (line 619):** Change return type from `Promise<void>` to `Promise<string | undefined>`. Capture message ID from `sendTelegramMessage` calls, return as string.

- [ ] **Update `Channel` interface in `src/types.ts`:** Change `sendMessage` return type from `Promise<void>` to `Promise<string | undefined>`.

- [ ] **Fix any other Channel implementations** that have `sendMessage` returning `Promise<void>` — change to return `undefined`.

- [ ] **Build:** `npm run build`
- [ ] **Run tests:** `npm test` — all pass
- [ ] **Commit:** `feat: return message ID from Telegram sendMessage`

---

## Task 3: Approval Tracker

SQLite CRUD for trust decisions. Independent of other tasks — can run in parallel with Task 2.

**Files:**
- Create: `src/approval-tracker.ts`
- Create: `src/approval-tracker.test.ts`

### Step 3.1: Write failing tests

- [ ] **Create `src/approval-tracker.test.ts`** with tests for:
  - `recordDecision` returns positive ID
  - `recordResponse` stores approved/rejected/edited
  - `getPendingApprovals` returns only draft+NULL decisions
  - `getApprovalStats` groups by rule ID, computes rate correctly
  - `getApprovalStats` excludes expired decisions from denominator
  - `setTelegramMsgId` stores message ID
  - `findByTelegramMsgId` retrieves decision by Telegram msg ID
  - `expireStaleApprovals` expires old pending decisions

Use `better-sqlite3` in-memory DB with the trust_decisions schema.

- [ ] **Run to verify failure**
- [ ] **Commit:** `test: add approval tracker tests`

### Step 3.2: Implement approval tracker

- [ ] **Create `src/approval-tracker.ts`** with:
  - `ApprovalTracker` class wrapping a `better-sqlite3` Database
  - `TrustDecision` interface for input
  - `ApprovalStat` interface for aggregated stats
  - All methods from the spec: `recordDecision`, `recordResponse`, `getApprovalStats`, `getRecentDecisions`, `getPendingApprovals`, `expireStaleApprovals`, `setTelegramMsgId`, `findByTelegramMsgId`

Key: `getApprovalStats` uses SQL aggregate `GROUP BY trust_rule_id, event_type` and filters `user_response IN ('approved', 'rejected', 'edited')` (excludes expired and NULL).

- [ ] **Run tests:** all pass
- [ ] **Build:** `npm run build`
- [ ] **Commit:** `feat: implement approval tracker`

---

## Task 4: Event Router Extensions

Add `draft` routing, conditional publish, rule ID tracking, and `reloadFromPath`. This is the most complex task.

**Files:**
- Modify: `src/event-router.ts`
- Modify: `src/event-router.test.ts`

### Step 4.1: Add draft routing tests

- [ ] **Add tests to `src/event-router.test.ts`:**
  - Draft events do NOT publish to message bus
  - Draft events call `sendToMainGroup` with `[Draft #N]` message
  - Draft events record decision via approval tracker
  - Notify events DO publish to message bus
  - Classified event includes `trustRuleId` from matched rule
  - `reloadFromPath` updates in-memory rules

- [ ] **Run to verify failure**
- [ ] **Commit:** `test: add draft routing tests`

### Step 4.2: Implement event router extensions

Changes to `src/event-router.ts`:

1. **Add `RoutingLevel` type:** `'autonomous' | 'notify' | 'draft' | 'escalate'`
2. **Add `id?: string` and `max_promotion?: RoutingLevel`** to `TrustRule`
3. **Add `trustRuleId?: string`** to `ClassifiedEvent`
4. **Add to `EventRouterConfig`:** `approvalTracker?: ApprovalTrackerLike`, `sendToMainGroup?: (text: string) => Promise<string | undefined>`
5. **Change `applyTrustRules`** to return `{ routing: RoutingLevel; ruleId: string | null }`
6. **Restructure `route()` publish logic:**
   - Always record decision if `approvalTracker` is configured
   - For `draft`: do NOT publish, call `sendApprovalRequest` instead
   - For `autonomous`, `notify`, `escalate`: publish as before
7. **Add `reloadFromPath(yamlPath: string): void`** — re-reads YAML, replaces in-memory rules
8. **Add private `sendApprovalRequest(classified, decisionId)`** — formats and sends `[Draft #N]` Telegram message

Add `import fs from 'fs'` and `import YAML from 'yaml'` if not already imported.

- [ ] **Run tests:** all pass (existing + new)
- [ ] **Build:** `npm run build`
- [ ] **Run ALL tests:** `npm test` — all pass
- [ ] **Commit:** `feat: add draft routing, rule IDs, conditional publish, reloadFromPath`

---

## Task 5: Promotion Analyzer

Analyzes approval patterns and proposes trust rule changes.

**Files:**
- Create: `src/promotion-analyzer.ts`
- Create: `src/promotion-analyzer.test.ts`

### Step 5.1: Write failing tests

- [ ] **Create `src/promotion-analyzer.test.ts`** with tests for:
  - Proposes promotion when rate > threshold and decisions > minimum
  - Blocks promotion at safety floor (max_promotion)
  - Skips rules with insufficient data
  - `applyPromotion` updates YAML file and calls `reloadFromPath`

Mock `fs`, `logger`, tracker, and router.

- [ ] **Run to verify failure**
- [ ] **Commit:** `test: add promotion analyzer tests`

### Step 5.2: Implement promotion analyzer

- [ ] **Create `src/promotion-analyzer.ts`** with:
  - `PromotionAnalyzer` class
  - `PromotionProposal` interface
  - Promotion order: `escalate → draft → notify → autonomous`
  - `analyze()`: gets stats, finds rules eligible for promotion, respects max_promotion, sends proposals as `[Promotion #ruleId]` messages
  - `applyPromotion()`: reads YAML, updates matching rule's routing, writes atomically (temp + rename), calls `eventRouter.reloadFromPath()`

- [ ] **Run tests:** all pass
- [ ] **Build:** `npm run build`
- [ ] **Commit:** `feat: implement promotion analyzer`

---

## Task 6: Integration Wiring

Wire everything into `src/index.ts`. Update trust.yaml example.

**Files:**
- Modify: `src/index.ts`
- Modify: `config-examples/trust.yaml.example`

### Step 6.1: Update trust.yaml.example

- [ ] **Replace `config-examples/trust.yaml.example`** with version that includes:
  - Rule IDs on every rule (e.g., `id: institutional-email`)
  - A `draft` routing rule for medium-importance emails
  - `max_promotion` on institutional email and calendar conflict rules

- [ ] **Commit:** `docs: update trust.yaml.example with rule IDs, draft, max_promotion`

### Step 6.2: Wire into index.ts

- [ ] **Add imports** for `ApprovalTracker`, `PromotionAnalyzer`, and new config constants

- [ ] **In `main()`, after event router initialization:**
  1. Create `ApprovalTracker` instance (uses existing `db`)
  2. Create `sendToMainGroup` helper function
  3. Pass `approvalTracker` and `sendToMainGroup` to `EventRouter` config
  4. Add approval response handler in `onMessage` callback (before `storeMessage`)
  5. Schedule hourly `expireStaleApprovals` via `setInterval`
  6. Create `PromotionAnalyzer` and schedule weekly analysis using `router_state` to track last run

The approval response handler:
- Checks if message is from main group with `replyToMessageId`
- Looks up decision via `findByTelegramMsgId`
- Parses approve/reject from message text
- Records response, publishes to bus if approved
- Returns early (does not invoke agent)

- [ ] **Build:** `npm run build`
- [ ] **Run ALL tests:** `npm test` — all pass
- [ ] **Commit:** `feat: wire approval tracker, response handler, and promotion analyzer`

---

## Task 7: Integration Validation

### Step 7.1: Full build and test

- [ ] `npm run build && npm test` — all pass

### Step 7.2: Copy trust matrix

- [ ] `mkdir -p data && cp config-examples/trust.yaml.example data/trust.yaml`

### Step 7.3: Restart and verify

- [ ] Clear agent-runner cache and restart NanoClaw
- [ ] Check logs for approval tracker and promotion analyzer initialization

### Step 7.4: Final commit

- [ ] Commit any remaining changes

---

## Known Limitations (Acceptable for Phase 3a)

1. **No inline Telegram buttons.** Text-based approve/reject via replies.
2. **No demotion.** Autonomous events have no approval signal.
3. **Weekly promotion cadence.** State persists in router_state, survives restarts.
4. **Single-user approval.** Appropriate for personal assistant.
5. **Channel.sendMessage return type change.** All implementations must update.
