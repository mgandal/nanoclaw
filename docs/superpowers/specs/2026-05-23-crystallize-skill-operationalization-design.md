# Crystallize Skill Operationalization — Design

**Author:** Claude (Opus 4.7) + Mike Gandal
**Date:** 2026-05-23
**Status:** Draft — pending plan
**Tracking:** No issue yet.

---

## 1. Problem

The `crystallize` skill (`container/skills/crystallize/SKILL.md`, shipped 2026-04-19) lets agents save reusable "recipes for doing" as `data/agents/{agent}/skills/crystallized/{name}/SKILL.md` files. In 34 days of production it has produced **zero real crystallizations**:

| Agent | Skill | Origin |
|---|---|---|
| claire | `p1-roundtrip-test` (2026-04-19) | Phase 1 ship-day smoke test, no SKILL.md survived |
| einstein | `t27-pattern`, `t29-pattern` (2026-05-20, 14 log entries in 26s) | Test harness leak — `description: "d"`, body `# body` |
| marvin | `pptx` (2026-04-20) | Operator hand-install, not crystallized by agent |

`usage.jsonl` does not exist in any agent directory. The Phase 2 invocation telemetry (PreToolUse hook → `skill_invoked` IPC → `usage.jsonl`) has never fired in practice because there is no skill worth invoking.

**Root cause:** the skill is dormant at the **creation** step. Agents finish tasks → respond → session ends. The crystallize call requires an agent to consciously decide "this generalizes" before the turn ends, write the SKILL.md body, and fire IPC. There is no trigger, no scaffold, no end-of-session prompt. The hindsight memory from 2026-05-18 ("steal Phase-3 activation-hook pattern from Claudeception") flagged this gap; this spec closes it.

## 2. Goals & Non-Goals

### Goals

1. **Creation trigger.** Stop hook fires per turn-end, applies a structural+verbosity gate, DMs the user a cheap candidate summary in CLAIRE for `/yes` or `/skip`.
2. **Body generation on demand.** `/yes` schedules a one-shot agent task that fetches the candidate row via a new MCP tool, generates the SKILL.md body, fires the existing `crystallize_skill` IPC, lands in `pending_actions` for `/approve`.
3. **Telemetry lifecycle.** Weekly digest of top-invoked + unused crystallized skills; auto-promote (≥10 invocations across ≥3 sessions) to `container/skills/` via staged `pending_action`; monthly auto-prune (0 invocations, age >30d, confidence ≤7) to `_archive/` via staged `pending_action`.

### Non-goals

- Replacing the existing `crystallize_skill` IPC handler. The new code feeds the existing flow; it does not duplicate it.
- Auto-firing `crystallize_skill` directly from the hook (matches the t27-pattern failure mode).
- Cross-agent skill sharing without `/approve` (promote requires gated pending action).
- Real-time SDK extension. No new SDK hook events; only the existing `Stop` event.
- Slash-command auto-discovery framework. Two new slash commands land as inline if-blocks in `src/index.ts` (no `src/commands/` directory).

## 3. Locked Inputs

Five user decisions were locked during brainstorming and are not reopened by this spec:

| # | Decision | Rationale |
|---|---|---|
| L1 | Primary goal = all three phases (creation, invocation lifecycle, quality control) in order | Single coherent spec; avoids partial-build dead-ends. |
| L2 | Trigger model = Stop hook in container | Closest to the prior 2026-05-18 Claudeception eval verdict. |
| L3 | Suggestion target = Telegram CLAIRE only (`tg:8475020901`) | Locked after adversarial review C1 revealed there is no global "main channel" abstraction; pinning to one JID avoids ambiguity. |
| L4 | Two-step approval: hook DMs cheap summary → `/yes` schedules body-gen | Smaller hook payload, human-in-loop at suggestion stage, agent only writes body when confirmed. |
| L5 | Stop-hook gate = ≥3 distinct MCP tools (whitelisted) AND assistant text ≥500 chars AND no failure-phrase at sentence start | Structural + verbosity only; no Ollama call (avoids MLX-availability risk per `project_mlx_memory_pressure_fix`). |
| L6 | Lifecycle = all three (weekly digest + promote + prune) | Each is small; existing cron infra reused. |
| L7 | Excerpt format = Hybrid: SDK `last_assistant_message` + tool_sequence summary, ~1KB | Locked after C5(b); balances faithfulness vs DB payload size. |

## 4. Architecture

```
 CONTAINER (per-session)                          HOST
                                                  ─────────────────────────
 Agent finishes turn                              ▌ src/ipc/handlers/skills.ts
        │                                         ▌
        ▼                                         ▌ crystallize_candidate
 createStopHook (NEW)                             ▌   - parse + validate
   1. parse transcript_path                       ▌   - verify sourceGroup matches ctx (I8)
   2. gate: ≥500 chars                            ▌   - sha256 content_hash (C6)
   3. gate: ≥3 distinct MCP tools (incl Skill)    ▌   - INSERT OR IGNORE (C2 race-safe)
   4. gate: no "I/we couldn't" at sentence start  ▌   - day-cap check (I1): ≥3 today → no DM
   5. write JSON to                               ▌   - ctx.deps.sendMessage(CLAIRE_JID, dmText)
      /workspace/ipc/tasks/                       ▌
      crystallize-candidate-                      ▌ crystallize_candidate_fetch (NEW MCP tool)
      {group}-{agent}-{ts}-{rand}.json (I8)       ▌   - read-only; returns trace + tools
                                                  ▌
                                                  ▌ src/index.ts slash if-ladder
                                                  ▌   /crystallize-yes cc-xxx →
                                                  ▌     UPDATE candidate, INSERT into tasks
                                                  ▌     prompt: "fetch cc-xxx, generate body,
                                                  ▌              fire crystallize_skill IPC"
                                                  ▌   /crystallize-skip cc-xxx → UPDATE only
                                                  ▌
                                                  ▌ existing pending_actions /approve flow
                                                  ▌   → SKILL.md lands on disk
                                                  ─────────────────────────
                                                  3 scheduled tasks (cron via scheduled_tasks):
                                                    - Mon 8:00  weekly digest    (Python guard → agent DM)
                                                    - Mon 8:05  promote check    (Python guard → agent stages pa-xxx)
                                                    - 1st 8:10  prune check      (Python guard → agent stages pa-xxx)
                                                  Two new pending_action types:
                                                    - promote_crystallized_skill (copy → container/skills/)
                                                    - archive_crystallized_skill (mv → _archive/)
```

## 5. Data Model

### 5.1 New table: `crystallize_candidates`

```sql
CREATE TABLE IF NOT EXISTS crystallize_candidates (
  id TEXT PRIMARY KEY,                     -- 'cc-<6 base36>'
  agent TEXT NOT NULL,                     -- from payload (I7), validated regex
  source_group TEXT NOT NULL,              -- e.g. 'telegram_lab-claw', verified against ctx (I8)
  source_jid TEXT NOT NULL,                -- originating chat jid, kept for future re-routing
  session_id TEXT NOT NULL,                -- SDK session_id from StopHookInput
  trace_summary TEXT NOT NULL,             -- last_assistant_message (R2), <=2048 chars
  tool_sequence TEXT NOT NULL,             -- JSON array of {tool, argSummary, resultSummary}, <=20 entries
  content_hash TEXT NOT NULL,              -- sha256(tool_sequence + trace_summary[:300])  (C6)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | skipped | expired | crystallized
  dm_message_id TEXT,                      -- Telegram message_id; NULL if DM-capped (I1)
  pending_action_id TEXT,                  -- pa-xxx after body-gen stages crystallize_skill
  created_at TEXT NOT NULL,                -- ISO
  responded_at TEXT,                       -- ISO; when /yes or /skip arrived
  expires_at TEXT NOT NULL                 -- created_at + 7d
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_dedup
  ON crystallize_candidates(agent, content_hash, substr(created_at, 1, 10));

CREATE INDEX IF NOT EXISTS idx_cc_status_created
  ON crystallize_candidates(status, created_at);
```

Migration: idempotent `CREATE TABLE IF NOT EXISTS` inside `createSchema()` in `src/db.ts`, alongside the `tasks` table pattern (db.ts:177-211). No data migration; empty start.

### 5.2 Unchanged tables

- `pending_actions` — body-gen agent uses existing `crystallize_skill` IPC → existing `gateAndStage` → existing `/approve`.
- `agent_actions` — `responseKind: 'notify'` + `skipGate: true` means no audit rows fire for `crystallize_candidate` (matches `skill_invoked` contract).
- `tasks` — body-gen one-shot reuses this table; `/crystallize-yes` inserts a row.

### 5.3 Filesystem layout

```
data/agents/{agent}/skills/
├── crystallized/                          (existing, unchanged scope)
│   ├── log.jsonl                          (append-only)
│   ├── usage.jsonl                        (append-only, by skill_invoked handler)
│   └── {skill-name}/SKILL.md
└── _archive/                              (NEW, sibling — NOT under crystallized/)
    └── {skill-name}/
        ├── SKILL.md                       (moved from crystallized/)
        └── archive_meta.json              ({archived_at, reason, original_invocation_count})
```

Sibling layout per I6 + R10 — the PreToolUse `readdirSync('/workspace/agent/skills/crystallized')` does not descend into siblings, so archived skills cannot rejoin `crystallizedSet`.

## 6. IPC + Hook Contracts

### 6.1 Stop hook (`container/agent-runner/src/index.ts`)

Registration alongside existing `PreCompact` and `PreToolUse` hooks at line ~820:

```ts
hooks: {
  PreCompact: [...],
  PreToolUse: [...],
  Stop: [{ hooks: [createStopHook(
    containerInput.agentName,
    containerInput.groupFolder,
    containerInput.chatJid,
  )] }],
}
```

`createStopHook(agentName, sourceGroup, sourceJid): HookCallback`:

1. Early-return if `stop_hook_active === true` (R3 re-entry guard).
2. Early-return if `agentName` is undefined.
3. Read `last_assistant_message`; reject if `< 500` chars.
4. Parse `transcript_path` JSONL → list of `{tool, argSummary (<=80c), resultSummary (<=80c)}`.
5. Filter `meaningful = tool.startsWith('mcp__') || tool === 'Skill'` (I3 includes Skill).
6. Reject if `new Set(meaningful.map(t => t.tool)).size < 3`.
7. Reject if `/(^|[.!?]\s+)(I|we)\s+(couldn't|failed|cannot)\b/i.test(lastMsg)` (I2 word-boundary).
8. Reject if `/\bunclear (whether|if|how)\b/i.test(lastMsg)`.
9. Write `/workspace/ipc/tasks/crystallize-candidate-{sourceGroup}-{agentName}-{Date.now()}-{rand6}.json` with body:
   ```json
   {
     "type": "crystallize_candidate",
     "agent": "marvin",
     "sourceGroup": "telegram_lab-claw",
     "sourceJid": "tg:-1003892106437",
     "sessionId": "session-abc",
     "traceSummary": "<last_assistant_message[:2048]>",
     "toolSequence": [{ "tool": "mcp__qmd__query", "argSummary": "...", "resultSummary": "..." }]
   }
   ```
10. Return `{}` (fire-and-forget).

### 6.2 `crystallize_candidate` handler (`src/ipc/handlers/skills.ts`)

Mirror `skillInvokedHandler` shape (handlers/skills.ts:306).

- `responseKind: 'notify'` (explicit, not `'result'`; would synthesize fake audit rows otherwise — Batch 4 memory).
- `authorize() → { target: '', notifySummary: '', payloadForStaging: { type: 'crystallize_candidate' }, skipGate: true }`.
- Add `'crystallize_candidate'` to `SKIP_GATE_ALLOWLIST` at `src/ipc/handler.ts:30` (C3).
- `execute(input, ctx)`:
  1. If `input.sourceGroup !== ctx.sourceGroup` → warn, return (I8).
  2. Validate `input.agent` against `/^[a-z0-9][a-z0-9_-]{0,63}$/`; reject otherwise.
  3. Compute `contentHash = sha256(JSON.stringify(input.toolSequence) + input.traceSummary.slice(0, 300))` (C6).
  4. `INSERT OR IGNORE INTO crystallize_candidates …` (C2). If `changes === 0` → log dedup, return.
  5. Day-cap check: count today's rows for this agent where `dm_message_id IS NOT NULL`. If `>= 3` → return; row persists for digest overflow (I1).
  6. `msgId = await ctx.deps.sendMessage('tg:8475020901', formatCandidateDm(...))` (L3).
  7. `UPDATE crystallize_candidates SET dm_message_id = ? WHERE id = ?`.

### 6.3 `crystallize_candidate_fetch` MCP tool (C5a)

New tool in `container/agent-runner/src/ipc-mcp-stdio.ts`:

```
name:        nanoclaw.crystallize_candidate_fetch
description: Fetch a crystallize candidate row by ID. Returns trace + tool_sequence for body generation.
inputSchema: { ccId: string }
returns:     { agent, sourceGroup, traceSummary, toolSequence }
```

Host handler in `src/ipc/handlers/skills.ts`. `responseKind: 'result'`, `skipGate: true`, on `SKIP_GATE_ALLOWLIST`. Read-only. Required so the body-gen agent in a non-main container (which has no `store/messages.db` mount per I9) can hydrate the candidate.

### 6.4 Slash commands (`src/index.ts` if-ladder, C4)

Added alongside `/approve` (~line 495). No new directory.

```ts
} else if (/^\/crystallize-yes\s+cc-[a-z0-9]{6}\b/.test(trimmed)) {
  const ccId = trimmed.match(/cc-[a-z0-9]{6}/)![0];
  await handleCrystallizeYes(ccId, deps);
  return;
} else if (/^\/crystallize-skip\s+cc-[a-z0-9]{6}\b/.test(trimmed)) {
  const ccId = trimmed.match(/cc-[a-z0-9]{6}/)![0];
  await handleCrystallizeSkip(ccId, deps);
  return;
}
```

`handleCrystallizeYes(ccId)`:
1. SELECT row; reject if status != 'pending' or expires_at < now (reply with reason).
2. UPDATE status='accepted', responded_at=now.
3. INSERT into `tasks` for `source_group` with prompt body referencing `ccId`:
   > Body-generation for {ccId}. Call `mcp__nanoclaw__crystallize_candidate_fetch` with `ccId="{ccId}"` to hydrate trace_summary + tool_sequence. Then follow `/crystallize` skill steps 1-4: pick a name, write the SKILL.md body, self-report confidence (1-10), fire `crystallize_skill` IPC. The candidate came from a previous session of yours — generalize, do not replay.
4. Reply in CLAIRE: `Scheduled body-gen for {ccId} in {sourceGroup}. pa-xxx will appear when done.`

`handleCrystallizeSkip(ccId)`:
1. UPDATE status='skipped', responded_at=now.
2. Reply: `Skipped {ccId}.`

## 7. Lifecycle Crons

Three new rows in `scheduled_tasks`. Each populates both `script` (Python guard, exit 0 = wake agent, exit 1 = skip) and `prompt` (the wake-up instruction). Pin Python interpreter to absolute path per `feedback_qmd_update_cmd_absolute_python`.

### 7.1 Weekly digest — Mon 8:00 ET

`crystallize-weekly-digest.py`:
- Scans `data/agents/*/skills/crystallized/usage.jsonl` for top 5 invoked (last 7d).
- Scans `log.jsonl` for skills created in last 30d with no usage entries (unused-since-creation).
- Reads `crystallize_candidates` for status='pending' AND dm_message_id IS NULL (overflow from day-cap) in last 7d.
- If all three empty → exit 1, no DM.
- Else writes Markdown to `~/.cache/nanoclaw/crystallize-digest.md` and exits 0.

Agent prompt: `Read /Users/mgandal/.cache/nanoclaw/crystallize-digest.md and DM the contents to me as-is. Skip silently if file missing or empty.`

### 7.2 Promote check — Mon 8:05 ET

`crystallize-promote-check.py`:
- Per `usage.jsonl`, find skills where `count >= 10` AND `count(distinct sourceGroup) >= 3` (each row's `sourceGroup` field treated as the "session" axis) AND not already in `container/skills/{name}/`.
- Write JSON list to `~/.cache/nanoclaw/crystallize-promote-candidates.json`. Exit 0 if non-empty, else 1.

Agent prompt: walk candidates, apply linter (reject if SKILL.md body contains `/workspace/extra/`, agent-specific name in allowed-tools, or `Bash` in allowed-tools), stage `promote_crystallized_skill` pending_action per survivor. Reply with pa-xxx count.

### 7.3 Prune check — 1st of month 8:10 ET

`crystallize-prune-check.py`:
- Per `log.jsonl`, find skills where `invocation_count == 0` AND `age > 30d` AND `confidence <= 7` AND not already under `_archive/`.
- Write JSON list to `~/.cache/nanoclaw/crystallize-prune-candidates.json`. Exit 0 if non-empty, else 1.

Agent prompt: stage `archive_crystallized_skill` pending_action per candidate. Reply with pa-xxx count.

### 7.4 New pending_action types

Wired into the `/approve pa-xxx` executor:

- **`promote_crystallized_skill`** — payload `{agent, name}`. Copies `data/agents/{agent}/skills/crystallized/{name}/SKILL.md` → `container/skills/{name}/SKILL.md`. Appends `{ts, action: 'promoted', agent, name}` to source `log.jsonl`. Skill becomes visible to all agents on next container spawn (per R10).
- **`archive_crystallized_skill`** — payload `{agent, name, reason}` where `reason` defaults to `"unused-30d-low-confidence"` when staged by the prune cron. `mv data/agents/{agent}/skills/crystallized/{name}` → `data/agents/{agent}/skills/_archive/{name}`. Writes `_archive/{name}/archive_meta.json` with `{archived_at, reason, original_invocation_count}`. Reversible by manual `mv` back.

## 8. Error Handling

| Failure | Behavior |
|---|---|
| Stop hook gate rejects | silent no-op, no IPC |
| `crystallize_candidate` payload malformed | logger.warn, return (matches `skill_invoked` shape) |
| `sourceGroup` mismatch | logger.warn, return (I8 deny-on-mismatch) |
| Dedup collision (UNIQUE INDEX) | INSERT OR IGNORE; logger.debug; return |
| DM cap hit | row persisted with `dm_message_id=NULL`; surfaces in weekly digest overflow |
| `sendMessage` throws | logger.error; row persists; user sees nothing — digest will catch it Monday |
| `/crystallize-yes` for non-pending or expired | reply with explanation; do not mutate |
| `crystallize_candidate_fetch` ccId not found | return `{error: 'not_found'}`; body-gen agent aborts with explanation |
| Body-gen agent fails to fire `crystallize_skill` | candidate row status stuck at 'accepted'; weekly digest surfaces; user can manually re-issue `/crystallize-yes` |
| Promote linter rejects skill body | agent replies with rejection reason; no pa-xxx staged; row stays in candidates JSON |
| Archive `mv` fails (permission, race) | pa-xxx executor surfaces error; row stays in candidates JSON; manual retry |
| Mid-session skill archived | PreToolUse still fires `skill_invoked`; existing handler at `src/ipc/handlers/skills.ts:368` silently no-ops on missing file (R10 verified) |

## 9. Testing Strategy

| Layer | Tests | Pin |
|---|---|---|
| Unit — Stop hook | gate thresholds (<500c, <3 tools), re-entry guard, word-boundary I2 (true + false negatives), Skill inclusion (I3), filename format (I8) | ~12 |
| Unit — `crystallize_candidate` handler | parse rejection, sourceGroup mismatch, content_hash determinism, dedup INSERT OR IGNORE, day-cap, SKIP_GATE_ALLOWLIST membership (C3 regression pin), `data.agent` over `ctx.agentName` (I7) | ~10 |
| Unit — `crystallize_candidate_fetch` | row hydration, not-found path | ~3 |
| Unit — slash commands | `/yes` happy path (UPDATE + tasks INSERT + source_group propagation), `/yes` on expired, `/yes` on already-accepted, `/skip` happy, malformed cc-id | ~5 |
| Unit — DB migration | UNIQUE INDEX collision pin (C2), CREATE IF NOT EXISTS idempotent | ~3 |
| Unit — guard scripts | digest empty-state exit 1, digest renders 3 sections, promote excludes already-promoted, prune excludes already-archived | ~4 |
| Integration | E2E: Stop hook → IPC → DB → DM → `/yes` → body-gen task → `crystallize_skill` IPC → pa-xxx → `/approve` → SKILL.md on disk | 1 |
| Integration | E2E promote: write usage.jsonl meeting threshold → run guard → agent stages pa-xxx → `/approve` → file in `container/skills/` | 1 |
| Integration | E2E archive: prune-threshold skill → guard → agent stages pa-xxx → `/approve` → file under `_archive/` | 1 |
| Mutation discipline | Flip `distinct.size < 3` → `< 2`: at least one gate test fails. Delete UNIQUE INDEX: dedup race test fails. | manual |

Target: +800 LOC test, +1,030 LOC source. ~78% coverage.

## 10. Rollout

Four staged ships, each gated on real evidence:

| Stage | Lands | Verify | Gate-to-next |
|---|---|---|---|
| R1 | Stop hook + `crystallize_candidate` IPC + DB + DM (NO slash commands yet) | Observe CLAIRE 48h; count DMs/day; spot-check rows | ≤5 DMs/day AND ≥1 looks like a real recipe |
| R2 | `/crystallize-yes` + `/crystallize-skip` + `crystallize_candidate_fetch` + body-gen one-shot flow | First real `/yes` lands a SKILL.md via `/approve` with no hallucination | 1 successful end-to-end crystallization |
| R3 | Weekly digest scheduled task only | First Monday digest fires; format reads cleanly | Digest visibly correct, overflow surfaces if any |
| R4 | Promote + prune scheduled tasks + 2 new pending_action types in `/approve` executor | First-of-month prune; first qualifying promote (likely weeks later) | Both stage pa-xxx; `/approve` executes file ops |

R1 → R2: ≥3-day observation. R2 → R3: next Monday. R3 → R4: next first-of-month or sooner.

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| DM spam if gate too loose | Med | I1 day-cap (3/agent/day) + R1 observation gate |
| Body-gen agent hallucinates | Med | C5b excerpt + R2 single-success gate before automating promote/prune |
| Promote breaks freud in COACH-claw via path-references | Low | I4 linter rejects `/workspace/extra/` paths + `/approve` diff visible |
| Prune deletes skill user actually values | Low | `_archive/` `mv`-reversible by hand |
| `ctx.agentName` propagation broken end-to-end | Med | I7: use `data.agent`, validated by regex |
| Stop hook fires per-tool not per-turn | Low | R3 verified once-per-turn via SDK type; re-entry guard pinned |
| Telegram bot down → DMs lost | Low | Row persists; weekly digest surfaces as overflow |
| User `/yes` >7d after candidate | Low | `expires_at = 7d` enforced; replied with "expired" |
| Two containers race on same content_hash | Low | C2 UNIQUE INDEX + INSERT OR IGNORE |
| `crystallize_candidate_fetch` leaks cross-agent | Low | Handler scopes by ctx.sourceGroup; payload group verified |

## 12. Adversarial Review Trail

Three reviewers dispatched in parallel during brainstorming. Surfaced:

- **6 Critical** issues (C1-C6) folded into spec before write.
- **8 Important** issues (I1-I8) folded into spec before write.
- **10 Research** confirmations (R1-R10) that validated Stop-hook SDK support, slash-command pattern, sendMessage primitive, migration pattern, mid-session archive safety.

Per `feedback_adversarial_reviewer_prompt`: each reviewer received pre-loaded hypotheses to falsify rather than open-ended "any concerns?" prompts. The 6 Criticals would have shipped to main without this review.

## 13. Out of Scope (Future Work)

- Cross-agent skill sharing without `/approve` gate.
- Skill versioning when a same-name skill is re-crystallized.
- LLM-driven generalization quality check on the agent-generated body.
- UI for browsing/searching all crystallized skills.
- Per-skill enable/disable for specific agents.

## 14. References

- Existing crystallize skill: `container/skills/crystallize/SKILL.md`
- Existing crystallize_skill IPC: `src/ipc/handlers/skills.ts:589`
- Existing skill_invoked IPC (reference shape): `src/ipc/handlers/skills.ts:306`
- Existing PreToolUse hook (reference pattern): `container/agent-runner/src/index.ts:436`
- SKIP_GATE_ALLOWLIST: `src/ipc/handler.ts:30`
- Migration pattern (tasks table): `src/db.ts:177-211`
- Existing scheduled task pattern: `scripts/guards/hermes-pipeline-liveness.py`
- sendMessage pattern: `src/trust-notify.ts:17`
- Slash command pattern: `src/index.ts:355-502`
- 2026-05-18 Claudeception eval (hindsight): "steal Phase-3 activation-hook pattern"
- Memory: `project_agent_actions_table_empty 2026-05-21` (drives I7)
- Memory: `bash-supervisor-wait-hangs-on-partial-child-death` (informs guard-script structure)
- Memory: `failsafe-sentinel-default` (informs I8 deny-on-mismatch)
- Memory: `silent-failure-wedge-anti-pattern` (informs C2 race-safety)
