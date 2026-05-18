# IPC Dispatcher Drop Outcomes — Operator Runbook

For paging-triggered triage when an agent reports a stuck IPC call or
when `agent_actions` shows unexpected `outcome` values. Created in
Batch 4 (spec: `docs/superpowers/specs/2026-05-17-ipc-batch-4-dispatcher-observability-design.md`).

## Where the DB lives

Absolute path: `store/messages.db` (NOT `data/nanoclaw.db`). Read-only
queries:

```bash
sqlite3 store/messages.db
```

## Outcome glossary

| `outcome` value | Meaning | First-response action |
|---|---|---|
| `dropped_invalid_requestId` | Agent sent malformed/missing requestId on a result-kind call (path B). | Likely agent code bug. Grep container-side logs for the invocation site; the requestId is NOT in the row (see Path B asymmetry below). |
| `dropped_invalid_input` | Agent sent valid requestId but malformed payload — `handler.parse()` returned null (path C). | Likely schema drift between agent's `mcp_call` payload and host's `IpcHandler.parse()`. Find the handler at `src/ipc/handlers/<type>.ts` and compare the input shape. |
| `denied_contract_violation` | Handler declared `skipGate: true` but its type is not on `SKIP_GATE_ALLOWLIST` at `src/ipc/handler.ts:21-43`. | Contributor bug. Revert the handler change or add the type to the allowlist (after security review). |
| Other `dropped_*` | Not yet defined. | Investigate. Likely a future batch added new outcome strings without updating this runbook. |

Note: `authorize() → null` (path D) is INTENTIONALLY silent per contract
Rule 3 — no row is written for legitimate "polite-no" denials. If you
expected a row and don't see one, this may be why.

## Query templates

### "Agent stuck on poll for requestId=X"

```sql
SELECT created_at, agent_name, action_type, outcome, summary
FROM agent_actions
WHERE outcome LIKE 'dropped_%'
  AND summary LIKE '%req=X%'
ORDER BY created_at DESC
LIMIT 5;
```

Replace `X` with the literal requestId. Returns the row if a path-C drop
happened. For path B (malformed requestId), this query returns NOTHING —
see asymmetry below.

### "All drops for agent Y in last hour"

```sql
SELECT created_at, action_type, outcome, summary
FROM agent_actions
WHERE outcome LIKE 'dropped_%'
  AND agent_name = 'Y'
  AND created_at > datetime('now', '-1 hour')
ORDER BY created_at DESC;
```

### "Drop volume by outcome (last 24h)"

```sql
SELECT outcome, COUNT(*) as count
FROM agent_actions
WHERE outcome LIKE 'dropped_%'
  AND created_at > datetime('now', '-1 day')
GROUP BY outcome;
```

Baseline: 0-20/hour normal; >100/hour same outcome same agent = storm.

## Path B asymmetry — IMPORTANT (F-Q)

`dropped_invalid_requestId` rows do NOT carry `req=` in their summary,
because the malformed value is intentionally not stored in the audit
table (sanitization concern). Operators must join path-B rows by
`(agent_name, created_at)` only.

In the most common page scenario — "agent's container poll timed out on
requestId=abc123" — the agent had a VALID requestId from its
perspective; the host rejected it because of regex failure on something
the host saw. Check the host log line at `logs/nanoclaw.log`:

```bash
grep -F "requestId" logs/nanoclaw.log | grep -F "malformed"
```

The malformed value (whatever the host received) appears there, not in
the row.

## Per-outcome resolution decision tree

- **N=0 rows over 1 hour** → no incident; agent's symptom is elsewhere
  (container crash, poll bug, network).
- **N=1-3 rows, all same agent + same action_type** → likely a one-off
  agent bug; check container logs at that timestamp and file a ticket.
- **N>10 rows, all same agent + same action_type, last 5 minutes** →
  agent crash-loop; SSH and `container ls`, kill the agent container,
  restart NanoClaw.
- **N>100 rows, mixed agents + actions** → systemic issue (host change,
  dispatcher regression); revert most recent `src/ipc/handler.ts` change.

## Cross-reference

- Contract: `docs/context-engineering/ipc-handler-contract.md` Rule 3
  (authorize-null silent deny), Rule 6 (skipGate allowlist), Rule 7
  (handler logger requestId).
- Dispatcher source: `src/ipc/handler.ts` (paths B, C, D; helper
  `writeSyntheticAuditRow`).
- Schema: `src/db.ts:99-109` (`agent_actions` table), `:1395-1403`
  (`AgentActionInput`).
