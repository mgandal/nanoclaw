# Phase 3a: Trust & Autonomy Framework

## Goal

Make the event router learn from user feedback. Currently, trust rules are static YAML — someone must manually edit `data/trust.yaml` to change routing. Phase 3a adds approval tracking so the system can propose promotions when patterns stabilize: "You've approved 35/35 routine lab-member emails over the past month. Promote to autonomous?"

## Architecture

```
Event Router (Phase 2) classifies event → applies trust rules → routing decision
    ↓
    ├── autonomous → log decision, publish to bus
    ├── notify → log decision, publish to bus
    ├── draft → log decision, send approval request via Telegram, DO NOT publish yet
    └── escalate → log decision, trigger Claude session
         ↓
User replies to [Draft #N] or [Promotion #N] message in Telegram
         ↓
Approval response recorded in trust_decisions table
    ├── approved → publish event to bus
    ├── rejected → discard, record feedback
    └── expired (24h timeout) → discard, excluded from rate calculations
         ↓
Weekly promotion analyzer scans approval patterns (draft decisions only)
    ├── >95% approval over 30+ instances → propose promotion
    └── safety floor prevents certain actions from promoting past a ceiling
         ↓
Promotion proposal sent as [Promotion #N] → user confirms → trust.yaml updated → router reloaded
```

All components run within the existing NanoClaw process. No new services.

**Scope decision:** Demotion logic is deferred. Autonomous events have no user approval signal, so there's no data to detect poor autonomous decisions. A `/flag-last` command for retroactive flagging can be added in a future phase.

## Components

### 1. Approval Tracker (`src/approval-tracker.ts`)

SQLite table recording every trust decision the event router makes.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS trust_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,          -- 'email' | 'calendar'
  event_source TEXT NOT NULL,        -- 'gmail:mgandal@gmail.com'
  routing TEXT NOT NULL,             -- 'autonomous' | 'notify' | 'draft' | 'escalate'
  trust_rule_id TEXT,                -- stable rule ID from YAML (e.g., 'lab-member-email')
  classification_summary TEXT,       -- from Ollama classification
  classification_importance REAL,    -- 0-1
  classification_urgency TEXT,       -- urgency label as string
  user_response TEXT,                -- 'approved' | 'rejected' | 'edited' | 'expired' | NULL
  user_feedback TEXT,                -- free-text reason for rejection/edit
  responded_at TEXT,                 -- when user responded
  telegram_msg_id TEXT               -- outbound Telegram message ID (for reply matching)
);
```

**Key design decisions:**
- `trust_rule_id` stores the rule's stable `id` field from YAML (not a stringified condition or array index). See Section 4.
- `telegram_msg_id` stores the Telegram message ID of the outbound `[Draft #N]` notification, enabling reply-based response detection.
- `user_response: 'expired'` is explicitly excluded from approval rate calculations (denominator is only 'approved' + 'rejected' + 'edited').
- `classification_urgency` is stored as the string label from `Classification.urgency`. The Phase 2 event router parses Ollama's response into a string enum; if it changes to a number, convert via thresholds.

**Interface:**
```typescript
class ApprovalTracker {
  constructor(db: Database);

  recordDecision(decision: TrustDecision): number; // returns decision ID
  recordResponse(decisionId: number, response: 'approved' | 'rejected' | 'edited' | 'expired', feedback?: string): void;
  getApprovalStats(windowDays: number): ApprovalStat[]; // aggregate by trust_rule_id
  getRecentDecisions(limit: number): TrustDecision[];
  getPendingApprovals(): TrustDecision[]; // routing='draft', user_response=NULL, age < 24h
  expireStaleApprovals(): number; // set expired for pending > 24h, return count
  setTelegramMsgId(decisionId: number, telegramMsgId: string): void;
}

interface ApprovalStat {
  trustRuleId: string;
  eventType: string;
  total: number;       // count of 'approved' + 'rejected' + 'edited' (excludes expired/null)
  approved: number;
  rate: number;        // approved / total
}
```

`getApprovalStats` runs a single SQL aggregate:
```sql
SELECT trust_rule_id, event_type,
  COUNT(*) as total,
  SUM(CASE WHEN user_response = 'approved' THEN 1 ELSE 0 END) as approved
FROM trust_decisions
WHERE timestamp > ? AND user_response IN ('approved', 'rejected', 'edited')
GROUP BY trust_rule_id, event_type
```

### 2. Extended Routing in Event Router

**Conditional bus publish:** The `route()` method must NOT unconditionally publish to the message bus. Currently (Phase 2) it publishes for every routing outcome. Phase 3a restructures this:

```typescript
async route(event: RawEvent): Promise<ClassifiedEvent> {
  // ... classify via Ollama ...
  // ... apply trust rules → { routing, ruleId } ...

  // Log ALL decisions to approval tracker
  const decisionId = this.approvalTracker.recordDecision({ ... });

  // Conditional publish based on routing
  if (routing === 'draft') {
    // DO NOT publish — send approval request instead
    await this.sendApprovalRequest(classified, decisionId);
  } else if (routing === 'escalate') {
    await this.config.onEscalate(classified);
    this.config.messageBus.publish({ ... });
  } else {
    // autonomous and notify both publish
    this.config.messageBus.publish({ ... });
  }

  return classified;
}
```

**`applyTrustRules` returns matched rule:** Changed from returning just the routing string to returning `{ routing: RoutingLevel; ruleId: string | null }` so the approval tracker can record which rule matched.

**Approval request sending:** The router needs a `sendToMainGroup` callback (injected via config) that returns the Telegram message ID. This is different from the existing `onEscalate` which returns void.

```typescript
interface EventRouterConfig {
  // ... existing fields ...
  approvalTracker: ApprovalTracker;
  sendToMainGroup: (text: string) => Promise<string | undefined>; // returns telegram msg ID
}
```

`channel.sendMessage()` currently returns `Promise<void>`. For the Telegram channel specifically, we need to return the sent message ID. This requires modifying the `Channel.sendMessage` return type to `Promise<string | undefined>` (message ID if available) or adding a `sendMessageWithId` method to avoid breaking the existing interface.

### 3. Telegram Reply Detection

**Required plumbing changes:**

1. **`NewMessage` type** (`src/types.ts`): Add `replyToMessageId?: string` field
2. **Telegram channel** (`src/channels/telegram.ts`): Extract `ctx.message.reply_to_message?.message_id.toString()` in the Grammy handler, include in `NewMessage`
3. **`Channel.sendMessage` return type**: Change from `Promise<void>` to `Promise<string | undefined>` to return the sent Telegram message ID

**Response detection flow** in `src/index.ts` message handler:

```
1. Message arrives in main group
2. Check: does it have replyToMessageId?
   YES → look up replyToMessageId in trust_decisions.telegram_msg_id
     FOUND → extract decision ID, parse response (approve/reject/text-edit)
     NOT FOUND → proceed to normal pipeline
   NO → check text for /^(approve|reject)\s+#(\d+)/i pattern
     MATCH → verify decision ID exists in getPendingApprovals()
       EXISTS → handle approval response
       NOT EXISTS → proceed to normal pipeline
     NO MATCH → proceed to normal pipeline
3. Normal pipeline: store message, check triggers, invoke agent
```

This runs BEFORE the normal agent invocation in the message processing flow. It's a short-circuit: if the message is an approval response, handle it and return without invoking the agent.

### 4. Trust Matrix Extensions

**Stable rule IDs:** Every rule in `trust.yaml` must have an `id` field. This is the primary key for approval tracking and promotion proposals. Rules without IDs are functional but cannot participate in approval tracking or promotion.

```yaml
default_routing: notify

rules:
  - id: institutional-email
    event_type: email
    conditions:
      sender_domain: [ucla.edu, nih.gov, sfari.org]
      importance_gte: 0.7
    routing: notify
    max_promotion: notify  # safety floor

  - id: low-importance-email
    event_type: email
    conditions:
      importance_lt: 0.3
    routing: autonomous

  - id: calendar-conflict
    event_type: calendar
    conditions:
      change_type: conflict
    routing: escalate
    max_promotion: escalate  # conflicts always need human judgment

  - id: medium-importance-email
    event_type: email
    conditions:
      importance_gte: 0.3
      importance_lt: 0.7
    routing: draft  # approval required; can be promoted to 'notify' over time

  - id: new-calendar-event
    event_type: calendar
    conditions:
      change_type: new_event
    routing: notify
```

**Type changes in `src/event-router.ts`:**

```typescript
type RoutingLevel = 'autonomous' | 'notify' | 'draft' | 'escalate';

interface TrustRule {
  id?: string;                    // stable identifier for tracking
  event_type?: string;
  conditions?: TrustRuleConditions;
  routing: RoutingLevel;
  max_promotion?: RoutingLevel;   // safety ceiling
  action?: string;
}
```

### 5. Promotion Analyzer (`src/promotion-analyzer.ts`)

Periodic analysis of approval patterns to propose trust rule changes. **Only analyzes `draft` routing decisions** (the only ones with user approval signals).

**Logic:**
1. Call `tracker.getApprovalStats(30)` — returns approval rates grouped by `trust_rule_id`
2. For each rule with 30+ responded decisions:
   - If approval rate > 95%: propose promotion (e.g., `draft` → `notify`)
3. Check `max_promotion` before proposing — if current routing is already at the ceiling, skip
4. Send proposal to main group as `[Promotion #N]` message
5. Store pending proposal in memory (Map<decisionId, PromotionProposal>)
6. When user responds "yes": call `applyPromotion()` → update trust.yaml → call `eventRouter.reloadFromPath()`

**Promotion proposals are tracked using the same trust_decisions table** with `event_type: 'promotion'` and `routing: 'draft'`. This reuses the existing approval response handler — the handler checks both `[Draft #N]` and `[Promotion #N]` prefixes against `getPendingApprovals()`.

**Interface:**
```typescript
class PromotionAnalyzer {
  constructor(config: {
    tracker: ApprovalTracker;
    trustMatrixPath: string;
    eventRouter: EventRouter;        // for reloadFromPath()
    sendToMainGroup: (text: string) => Promise<string | undefined>;
    minDecisions: number;            // default 30
    promotionThreshold: number;      // default 0.95
  });

  analyze(): Promise<PromotionProposal[]>;
  applyPromotion(proposal: PromotionProposal): void;
}

interface PromotionProposal {
  ruleId: string;             // stable ID from YAML
  currentRouting: RoutingLevel;
  proposedRouting: RoutingLevel;
  evidence: { total: number; approved: number; rate: number };
  maxPromotion?: RoutingLevel;
  blocked: boolean;
}
```

**Schedule:** Store `last_promotion_analysis` in `router_state` (existing key-value table). On startup and then daily via `setInterval(checkIfWeekElapsed, 24 * 60 * 60 * 1000)`, check if a week has elapsed since last analysis. This survives restarts correctly.

**Trust.yaml rewriting:** `applyPromotion()` reads the YAML, updates the matching rule's `routing` field (preserving all other fields including `max_promotion`, `conditions`, etc.), writes to a temp file, renames atomically, then calls `eventRouter.reloadFromPath()`. The `reloadFromPath` method re-parses the YAML and synchronously replaces the in-memory rules array.

### 6. EventRouter.reloadFromPath

New method on `EventRouter`:

```typescript
reloadFromPath(yamlPath: string): void {
  const raw = fs.readFileSync(yamlPath, 'utf-8');
  const parsed = YAML.parse(raw) as TrustConfig;
  // Synchronous assignment — no race with in-flight route() calls
  // in single-threaded Node.js
  this.trustRules = parsed.rules;
  this.defaultRouting = parsed.default_routing;
  logger.info({ ruleCount: parsed.rules.length }, 'Trust rules reloaded');
}
```

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
| `src/db.ts` | Add trust_decisions table migration |
| `src/types.ts` | Add `replyToMessageId?: string` to `NewMessage` |
| `src/channels/telegram.ts` | Extract reply_to_message ID; return sent message ID from sendMessage |
| `src/event-router.ts` | Add RoutingLevel type, 'draft' routing, conditional publish, applyTrustRules returns ruleId, integrate approval tracker, add reloadFromPath method |
| `src/event-router.test.ts` | Add draft routing tests |
| `src/index.ts` | Initialize approval tracker, add approval response handler before agent pipeline, schedule weekly promotion analysis |
| `src/config.ts` | Add promotion thresholds config |
| `config-examples/trust.yaml.example` | Add rule IDs, draft rules, max_promotion examples |

## Error Handling

- **User never responds to draft:** `expireStaleApprovals()` runs periodically (every hour), sets `user_response: 'expired'` for pending approvals older than 24h. Expired decisions are excluded from approval rate denominators.
- **Trust.yaml write failure:** Log error, keep existing rules. Write to temp file then rename — never leave YAML in corrupted state.
- **DB migration failure:** `CREATE TABLE IF NOT EXISTS` and `addColumn` patterns handle idempotency.
- **Multiple pending approvals:** Each has a unique decision ID. User can respond in any order.
- **Telegram sendMessage fails:** Log error, set `telegram_msg_id: null`. Reply detection falls back to text-prefix matching.
- **Rule has no `id`:** Decision is logged with `trust_rule_id: null`. It cannot participate in promotion analysis.

## Testing Strategy

- **Approval tracker:** SQLite in-memory DB. Test CRUD, approval stats aggregate, pending query, expiry logic.
- **Promotion analyzer:** Mock approval tracker with known rates. Verify promotion respects thresholds and max_promotion floors. Verify YAML update preserves all fields. Verify reloadFromPath is called.
- **Draft routing:** Mock sendToMainGroup. Verify draft events are NOT published to bus. Verify approval response publishes to bus.
- **Reply detection:** Verify Telegram reply-to matching. Verify text-prefix fallback with pending check. Verify false-positive rejection.
- **Integration:** Event → draft → Telegram notification → reply → approve → bus publish.

## Known Limitations (Acceptable for Phase 3a)

1. **No inline Telegram buttons.** Text-based approve/reject via replies. Inline keyboards can be added later.
2. **No demotion.** Autonomous events have no approval signal. A `/flag-last` command for retroactive flagging is a future enhancement.
3. **Weekly promotion cadence.** Prevents over-fitting to short-term patterns. Stored in router_state, survives restarts.
4. **Single-user approval.** Appropriate for a personal assistant.
5. **Channel.sendMessage return type change.** Breaking interface change — all channel implementations must update. Telegram returns message ID, others return undefined.

## Phase 3b Preview

Phase 3b (Knowledge Graph) builds on approval tracking:
- Classified events with approval history feed entity extraction
- Trust decisions inform relationship strength
- Knowledge graph enables proactive scheduling (Phase 3c)
