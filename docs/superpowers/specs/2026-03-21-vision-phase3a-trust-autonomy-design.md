# Phase 3a: Trust & Autonomy Framework

## Goal

Make the event router learn from user feedback. Currently, trust rules are static YAML — someone must manually edit `data/trust.yaml` to change routing. Phase 3a adds approval tracking so the system can propose promotions when patterns stabilize: "You've approved 35/35 routine lab-member emails over the past month. Promote to autonomous?"

## Architecture

```
Event Router (Phase 2) classifies event → applies trust rules → routing decision
    ↓
    ├── autonomous → execute, log decision to trust_decisions table
    ├── notify → publish to bus, log decision
    ├── draft → create draft action, send approval request via Telegram, wait for response
    └── escalate → trigger Claude session, log decision
         ↓
User responds (approve / reject / edit) via Telegram reply
         ↓
Approval response recorded in trust_decisions table
         ↓
Weekly promotion analyzer scans approval patterns
    ├── >95% approval over 30+ instances → propose promotion
    ├── <80% approval → propose demotion
    └── safety floor prevents certain actions from promoting past 'draft'
         ↓
Promotion proposal sent to main group → user confirms → trust.yaml updated
```

All components run within the existing NanoClaw process. No new services.

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
  trust_rule TEXT,                   -- which YAML rule matched (stringified conditions)
  classification_summary TEXT,       -- from Ollama classification
  classification_importance REAL,    -- 0-1
  classification_urgency TEXT,       -- 'low' | 'medium' | 'high' | 'critical'
  user_response TEXT,                -- 'approved' | 'rejected' | 'edited' | NULL (no response needed)
  user_feedback TEXT,                -- free-text reason for rejection/edit
  responded_at TEXT                  -- when user responded
);
```

Events with routing `autonomous` are logged with `user_response: NULL` (no approval needed). Events with routing `draft` are logged with `user_response` filled in after the user responds.

**Interface:**
```typescript
class ApprovalTracker {
  constructor(db: Database);

  recordDecision(decision: TrustDecision): number; // returns decision ID
  recordResponse(decisionId: number, response: 'approved' | 'rejected' | 'edited', feedback?: string): void;
  getApprovalRate(eventType: string, conditions: Record<string, unknown>, windowDays: number): { total: number; approved: number; rate: number };
  getRecentDecisions(limit: number): TrustDecision[];
  getPendingApprovals(): TrustDecision[]; // routing='draft', user_response=NULL
}
```

### 2. Extended Routing Tiers in Event Router

Add `draft` routing to the existing event router. When a rule routes to `draft`:

1. Log the decision to `trust_decisions` with `user_response: NULL`
2. Format an approval message with the classified event summary
3. Send to Telegram main group with the decision ID embedded
4. The event is NOT published to the message bus yet — it waits for approval

When the user responds (approve/reject):
- `approved`: publish the event to the message bus, record response
- `rejected`: record response with feedback, do NOT publish
- `edited`: user provides modified text, publish modified version, record response

**Approval message format (Telegram):**
```
[Draft #42] Email from alice@nih.gov
Topic: R01 resubmission timeline
Summary: NIH program officer responds about deadline...
Importance: 0.85 | Urgency: medium

Reply with:
  ✓ (or "approve") — publish to agents
  ✗ (or "reject") — discard
  Or reply with modified text to edit
```

**Response detection:** The approval message includes `[Draft #42]` prefix. When a user replies to a message containing this prefix, it's intercepted in the message loop and routed to the approval tracker instead of the normal agent pipeline. This uses the existing message processing flow — no new IPC mechanism needed.

### 3. Promotion Analyzer (`src/promotion-analyzer.ts`)

Periodic analysis of approval patterns to propose trust rule changes.

**Logic:**
1. Query `trust_decisions` for the past 30 days, grouped by `(event_type, trust_rule)`
2. For each group with 30+ decisions:
   - If approval rate > 95%: propose promotion (e.g., `draft` → `notify`, `notify` → `autonomous`)
   - If approval rate < 80%: propose demotion (e.g., `autonomous` → `notify`)
3. Check safety floors before proposing (some rules can never promote past a ceiling)
4. Send proposals to main group via Telegram
5. User responds with "yes" or "no" per proposal
6. If "yes": update `data/trust.yaml` programmatically and reload

**Safety floors** are defined in the trust matrix:
```yaml
rules:
  - event_type: email
    conditions:
      sender_domain: [nih.gov, nsf.gov]
    routing: notify
    max_promotion: notify  # <-- safety floor: never promote past notify
```

**Interface:**
```typescript
class PromotionAnalyzer {
  constructor(config: {
    tracker: ApprovalTracker;
    trustMatrixPath: string;
    minDecisions: number;      // default 30
    promotionThreshold: number; // default 0.95
    demotionThreshold: number;  // default 0.80
  });

  analyze(): PromotionProposal[];
  applyPromotion(proposal: PromotionProposal): void; // updates trust.yaml
}

interface PromotionProposal {
  ruleIndex: number;
  currentRouting: string;
  proposedRouting: string;
  evidence: { total: number; approved: number; rate: number };
  safetyFloor?: string;
  blocked: boolean; // true if safety floor prevents promotion
}
```

**Schedule:** Runs weekly via the existing task scheduler (a new scheduled task, not a separate cron).

### 4. Trust Matrix Extensions

Extend the YAML format to support:

**`max_promotion` field** — safety ceiling per rule:
```yaml
rules:
  - event_type: email
    conditions:
      sender_domain: [nih.gov]
      importance_gte: 0.7
    routing: notify
    max_promotion: notify  # can never be auto-promoted past this
```

**`draft` routing** — new routing tier:
```yaml
  - event_type: email
    conditions:
      importance_gte: 0.5
      importance_lt: 0.7
    routing: draft  # creates approval request
```

The existing `TrustRule` interface gains:
```typescript
interface TrustRule {
  // existing fields...
  routing: 'notify' | 'autonomous' | 'draft' | 'escalate';
  max_promotion?: 'notify' | 'autonomous' | 'draft' | 'escalate';
}
```

### 5. Approval Response Handler

Intercepts Telegram messages that are responses to approval requests.

**Detection:** When a message in the main group starts with a reply to a `[Draft #N]` message, or the text itself matches `/^(approve|reject|✓|✗)/i`:

1. Extract the decision ID from the original message
2. Parse user intent (approve/reject/edit)
3. Call `approvalTracker.recordResponse()`
4. If approved: publish the original classified event to the message bus
5. Send confirmation: "Draft #42 approved" or "Draft #42 rejected"

This handler runs in the existing message processing pipeline in `src/index.ts`, before the normal agent invocation path.

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
| `src/event-router.ts` | Add 'draft' routing, integrate approval tracker |
| `src/event-router.test.ts` | Add draft routing tests |
| `src/index.ts` | Initialize approval tracker, add response handler, schedule weekly analysis |
| `src/config.ts` | Add promotion thresholds config |
| `config-examples/trust.yaml.example` | Add draft rules and max_promotion examples |

## Data Flow

### Draft Approval Flow
```
1. Event arrives → Router classifies → trust rule matches → routing: 'draft'
2. Router calls approvalTracker.recordDecision() → returns decisionId: 42
3. Router sends Telegram: "[Draft #42] Email from alice@nih.gov..."
4. User replies: "approve" (or ✓)
5. Message handler detects approval response → calls approvalTracker.recordResponse(42, 'approved')
6. Handler publishes original event to message bus
7. Handler sends: "Draft #42 approved"
```

### Promotion Flow
```
1. Weekly scheduled task runs promotionAnalyzer.analyze()
2. Analyzer queries: "For rule X, 32 decisions in 30 days, 31 approved (96.9%)"
3. Check safety floor: rule has max_promotion: 'notify' → blocked if currently 'notify'
4. Not blocked → propose: "Promote from 'draft' to 'notify'?"
5. Send Telegram: "Promotion proposal: Low-importance emails (importance < 0.3) ..."
6. User responds "yes" → analyzer.applyPromotion() → updates trust.yaml → reloads rules
```

## Error Handling

- **User never responds to draft:** Pending approvals older than 24h are auto-expired with `user_response: 'expired'`. The event is NOT published (conservative default).
- **Trust.yaml write failure:** Log error, keep existing rules. Never leave trust.yaml in a corrupted state (write to temp file, then rename).
- **DB migration failure:** `addColumn` pattern already handles "column already exists" gracefully.
- **Multiple pending approvals:** Each has a unique decision ID. User can respond to any in any order.

## Testing Strategy

- **Approval tracker:** SQLite in-memory DB, test CRUD operations, approval rate calculations, pending query.
- **Promotion analyzer:** Mock approval tracker with known approval rates, verify proposal generation respects thresholds and safety floors, verify YAML update.
- **Draft routing:** Mock Telegram send, verify approval message format, verify response handling.
- **Integration:** End-to-end from event → draft → approve → bus publish.

## Known Limitations (Acceptable for Phase 3a)

1. **No inline approval buttons.** Telegram Bot API supports inline keyboards, but implementing them requires Grammy API changes. Text-based approve/reject is simpler and sufficient. Inline buttons can be added later.

2. **Weekly promotion analysis.** Not real-time. A rule could be promoted faster if patterns are obvious, but weekly cadence prevents over-fitting to short-term patterns.

3. **Single-user approval.** Only the main group user can approve/reject. No multi-user consensus. Appropriate for a personal assistant.

4. **No automatic demotion enforcement.** Demotions are proposed but not auto-applied — user must confirm. A safety measure to prevent the system from becoming more restrictive without consent.

## Phase 3b Preview

Phase 3b (Knowledge Graph) builds on approval tracking:
- Classified events with approval history feed entity extraction
- Trust decisions inform relationship strength (approved interactions → stronger connections)
- Knowledge graph enables proactive scheduling (Phase 3c) by understanding who, what, and when
