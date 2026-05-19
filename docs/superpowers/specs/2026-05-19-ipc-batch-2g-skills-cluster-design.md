# Batch 2G — `skill_*` cluster migration

**Status:** Spec — awaiting user review before plan-writing.
**Owner:** mgandal
**Date:** 2026-05-19
**Predecessor:** Batch 2F.1 (`slack_dm` write + `postHocNotify` contract widening, commits `ddb573a4`..`37365cec`).
**Successor:** None — Batch 2G is the last migration in the IPC handler-registry consolidation arc. After this lands, the `src/ipc.ts` if-ladder contains only the dynamic skill-loader branches (`x_*`, `browser_*`) which are NOT registry candidates and use dynamic import.

## TL;DR

Migrate the last four legacy handlers from `src/ipc.ts` into a new `src/ipc/handlers/skills.ts`:

- `save_skill` — write skill to `container/skills/{name}/SKILL.md`. **Main-only.**
- `crystallize_skill` — write skill to `data/agents/{agent}/skills/crystallized/{name}/SKILL.md`. **Main-only.** (R2 Critical 1 + R1 Medium 1 — verified by reading `src/ipc.ts:1028-1036`, NOT the false "no main check" I claimed during brainstorming.)
- `skill_search` — POST to QMD bridge at `localhost:8181/mcp`, format result.
- `skill_invoked` — fire-and-forget telemetry: mutates a crystallized skill's frontmatter and appends to `usage.jsonl`.

**Preserve-bypass policy.** All four go on `SKIP_GATE_ALLOWLIST`. `skill_search` and `skill_invoked` are already there (handler.ts:28-29); `save_skill` and `crystallize_skill` must be added. The 9 dormant `save_skill: draft` trust.yaml entries (claire, freud, simon, coo, einstein, steve, marvin, vincent, warren) stay dormant by design — legacy never read them, the migration explicitly keeps them dormant. **Activating them is a future explicit decision (Batch 4 candidate flagged in project memory).**

Three commits:
1. Migrate `skill_search` + `skill_invoked` (already-allowlisted reads/telemetry).
2. Migrate `save_skill` + `crystallize_skill` (main-only writes; add to SKIP_GATE_ALLOWLIST).
3. Strip legacy from `src/ipc.ts`; register all 4; relocate shared helpers (`getBuiltinSkillNames`, `MAX_SKILL_CONTENT_BYTES`, `writeSkillResult`, `_resetBuiltinSkillsCacheForTests`).

No new contract feature needed. The cluster uses existing primitives (`skipGate`, `responseKind: 'notify' | 'result'`, `resultsDirName: 'skill_results'`) plus the `!ctx.isMain` rejection pattern that `imessageSendHandler` uses.

## Why this matters

Closes the IPC migration arc. After this lands, every gate-able action in the project goes through the typed `IpcHandler` registry rather than the if-ladder. The if-ladder remainder (`x_*`, `browser_*`) uses a different mechanism (dynamic skill imports) that doesn't benefit from the registry pattern.

Project memory has repeatedly flagged `save_skill`, `crystallize_skill`, and the `x_*` actions as "genuine writes currently bypassing the trust gate that should be gated." This batch does NOT close that gap — it preserves the bypass behavior structurally. The gap is acknowledged here and tagged for a future Batch 4-style gating pass. The reason for preserve-bypass: changing both *structural location* and *gate policy* in one batch maximizes the chance of breaking something quietly. Move first, gate later.

## Source-of-truth references

- Contract doc: `docs/context-engineering/ipc-handler-contract.md`
- Dispatcher: `src/ipc/handler.ts` (especially lines 21-43 `SKIP_GATE_ALLOWLIST`, 77-156 `IpcAuthorization`, 192-405 `dispatchIpcAction`, 421-460 `writeResultFile`).
- Trust-gate helper: `src/ipc/trust-gate.ts` (lines 27-46 `gateAndStage` + `NON_AGENT_DECISION`; line 61 `fireNotifyIfRequested` AND with `decision.notify && agentName`).
- Closest skipGate precedent (read-only): `src/ipc/handlers/slack.ts` `slackDmReadHandler`.
- Closest main-only-write precedent: `src/ipc/handlers/imessage.ts` `imessageSendHandler` (lines ~180-202: `if (!ctx.isMain) return null;`).
- Legacy code being migrated:
  - `src/ipc.ts:1008-1052` (4 dispatcher branches)
  - `src/ipc.ts:1061-1102` (`MAX_SKILL_CONTENT_BYTES`, `getBuiltinSkillNames`, `_resetBuiltinSkillsCacheForTests`)
  - `src/ipc.ts:1107-1199` (`handleSaveSkillIpc`)
  - `src/ipc.ts:1218-1328` (`handleCrystallizeSkillIpc`)
  - `src/ipc.ts:1336-1428` (`handleSkillInvokedIpc`)
  - `src/ipc.ts:1430-1442` (`writeSkillResult` helper)
  - `src/ipc.ts:1444-1532` (`handleSkillSearchIpc`)
- Trust.yaml dormancy: `data/agents/{claire,freud,simon,coo,einstein,steve,marvin,vincent,warren}/trust.yaml` each contain `save_skill: draft`. Verified by `grep -rn "save_skill\|crystallize_skill\|skill_search\|skill_invoked:" data/agents/*/trust.yaml` returning only the 9 `save_skill: draft` lines — the other 3 action types have ZERO entries.
- Container-side poller (do NOT change): `container/agent-runner/src/ipc-mcp-stdio.ts` references `skill_results/` directory; skills.ts MUST set `resultsDirName: 'skill_results'`.

## Architecture

### Change 1: `skill_search` + `skill_invoked` (Commit 1)

Both are already on `SKIP_GATE_ALLOWLIST` (handler.ts:28-29). Pure structural migration.

```typescript
// skill_search — read-only, fetches QMD bridge.
export const skillSearchHandler: IpcHandler<
  { query: string | undefined },
  { executed: true; result: { success: boolean; message: string } }
> = {
  type: 'skill_search',
  responseKind: 'result',
  resultsDirName: 'skill_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return { query: typeof r.query === 'string' ? r.query : undefined };
  },

  authorize(input) {
    return {
      target: input.query ?? '',
      notifySummary: '', // never fires — skipGate makes decision=null
      payloadForStaging: { type: 'skill_search' },
      skipGate: true,
    };
  },

  async execute(input, ctx) {
    if (!input.query) {
      return {
        executed: true,
        result: { success: false, message: 'Missing query parameter' },
      };
    }

    // legacy ipc.ts:1457-1530 — fetch QMD, parse response, format
    // Bearer token from getBridgeToken() (already imported in src/ipc.ts:5,
    // must be added to skills.ts imports).
    // Timeout: AbortSignal.timeout(10000).
    // Failure modes:
    //   - timeout → {success:false, message:'Skill search timed out'}
    //   - other fetch error → {success:false, message:'QMD unavailable: <msg>'}
    //   - 2xx but empty content → {success:false, message:'QMD returned empty response'}
    //   - 2xx with results → {success:true, message:<formatted>}
    // (Exact formatting logic — title/score/snippet — moves verbatim.)
  },
};

// skill_invoked — telemetry fire-and-forget. Mutates SKILL.md frontmatter
// + appends usage.jsonl. NO result file, NO audit row, NO notify.
//
// DO NOT change responseKind to 'result' (forward-compat note — R1 Low 1).
// If responseKind flips, the dispatcher writes a synthetic {success:true}
// file AND the side effect runs, which would surprise downstream consumers.
//
// skipGate: true is load-bearing — without it, an agent without a
// `skill_invoked` trust.yaml entry would be blocked AND a misleading
// "blocked" audit row would be written, silently stopping the telemetry
// AND the SKILL.md mutation (R1 High 2). The regression test at
// SKIP_GATE_ALLOWLIST asserts skill_invoked stays on the list.
export const skillInvokedHandler: IpcHandler<
  { agent: string | undefined; name: string | undefined; agentsRoot: string | undefined },
  void
> = {
  type: 'skill_invoked',
  // responseKind omitted — defaults to 'notify'. Combined with skipGate,
  // the dispatcher's notify branch is unreachable (decision === null).

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      agent: typeof r.agent === 'string' ? r.agent : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
      // agentsRoot test seam — accepted from data only; execute() enforces
      // the env-gate (R2 Critical 2). DO NOT short-circuit the env-gate.
      agentsRoot: typeof r.agentsRoot === 'string' ? r.agentsRoot : undefined,
    };
  },

  authorize() {
    return {
      target: '',
      notifySummary: '', // never fires — skipGate
      payloadForStaging: { type: 'skill_invoked' },
      skipGate: true,
    };
  },

  execute(input) {
    const agentRe = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    const skillNameRe = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
    if (!input.agent || !agentRe.test(input.agent)) return;
    if (!input.name || !skillNameRe.test(input.name)) return;

    // Env-gate for agentsRoot test seam (R2 Critical 2 — MUST preserve).
    const isTestEnv =
      process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
    const agentsRoot =
      isTestEnv && typeof input.agentsRoot === 'string'
        ? input.agentsRoot
        : AGENTS_DIR;

    // ... rest of legacy ipc.ts:1362-1428 logic — frontmatter regex
    // mutations (invocation_count++, last_invoked_at upsert) +
    // usage.jsonl append.
  },
};
```

**Key decisions (Commit 1):**

- `skill_search.parse` does shape checks only. Missing/empty `query` is a runtime concern (the dispatcher's Rule 2 requestId check fires first; if requestId is valid and `query` is missing, `execute` returns `{success:false, message:'Missing query parameter'}` via the result file).
- `skill_invoked.execute` returns `void` (notify-kind contract). Validation failures (bad agent regex, missing SKILL.md, malformed frontmatter) are silent returns — match legacy at `ipc.ts:1370-1383`.
- `agentsRoot` env-gate **is load-bearing** (R2 Critical 2). In production, a compromised container could pass arbitrary `agentsRoot` in `data` and redirect writes to any host path. The `isTestEnv` guard is the only barrier; if removed, the production protection vanishes. Both positive AND negative tests verify the gate (R3 High 6).

### Change 2: `save_skill` + `crystallize_skill` (Commit 2)

Both writes. **Both main-only.** **Both added to SKIP_GATE_ALLOWLIST.**

```typescript
// save_skill — writes a global skill to container/skills/{name}/SKILL.md.
// Main-only.
//
// Validation lives in execute() (NOT parse() or authorize()) so the agent
// gets the 4 actionable error messages from legacy (R1 Critical 2). If
// validation ran in parse(), the dispatcher's default-payload synthesizes
// {success:false, message:'execution bailed'} — losing the legacy text
// that tells the agent EXACTLY why the save was rejected.
export const saveSkillHandler: IpcHandler<
  { skillName: string | undefined; skillContent: string | undefined },
  { executed: true; result: { success: boolean; message: string } }
> = {
  type: 'save_skill',
  responseKind: 'result',
  resultsDirName: 'skill_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      skillName: typeof r.skillName === 'string' ? r.skillName : undefined,
      skillContent: typeof r.skillContent === 'string' ? r.skillContent : undefined,
    };
  },

  authorize(_input, ctx) {
    // Preserve legacy non-main block (ipc.ts:1013-1021).
    if (!ctx.isMain) return null;
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'save_skill' },
      skipGate: true,
    };
  },

  execute(input) {
    if (!input.skillName || !input.skillContent) {
      // Legacy logs warn + returns true with NO result file (writeSkillResult
      // is conditional on requestId). After migration the dispatcher writes
      // a synthetic {success:false, message:'execution bailed'} via the
      // default-payload branch — that is the legacy-equivalent message for
      // this shape-failure case. (Dispatcher's Rule 2 already validates
      // requestId; this branch is reached only when requestId is valid AND
      // skillName/skillContent are missing.)
      return {
        executed: true,
        result: {
          success: false,
          message: 'Missing required parameters: skillName and skillContent',
        },
      };
    }

    // Validation chain — each branch returns a user-facing message
    // verbatim from legacy ipc.ts:1121-1175. These 4 messages are agent-
    // facing UX and MUST survive the migration (R1 Critical 2).

    if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(input.skillName)) {
      return {
        executed: true,
        result: {
          success: false,
          message:
            'Invalid skill name. Use lowercase letters, numbers, and hyphens (2-64 chars).',
        },
      };
    }

    const contentBytes = Buffer.byteLength(input.skillContent, 'utf-8');
    if (contentBytes > MAX_SKILL_CONTENT_BYTES) {
      return {
        executed: true,
        result: {
          success: false,
          message: `Skill content (${contentBytes} bytes) exceeds the ${MAX_SKILL_CONTENT_BYTES}-byte cap.`,
        },
      };
    }

    if (getBuiltinSkillNames().has(input.skillName)) {
      return {
        executed: true,
        result: {
          success: false,
          message: `Cannot overwrite built-in skill "${input.skillName}".`,
        },
      };
    }

    if (frontmatterDeclaresBash(input.skillContent)) {
      return {
        executed: true,
        result: {
          success: false,
          message:
            'Skill frontmatter declares allowed-tools: Bash. Bash-using skills must be vetted and added to the operator-managed allowlist, not persisted via save_skill.',
        },
      };
    }

    try {
      const skillDir = path.join(process.cwd(), 'container', 'skills', input.skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), input.skillContent);
      // Logger inside execute (matches legacy at ipc.ts:1182).
      logger.info({ skillName: input.skillName }, 'Container skill saved permanently via IPC');
      return {
        executed: true,
        result: { success: true, message: `Skill "${input.skillName}" saved permanently.` },
      };
    } catch (err) {
      return {
        executed: true,
        result: {
          success: false,
          message: `Error saving skill: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  },
};
```

`crystallizeSkillHandler` follows the same pattern: `parse()` includes `agentsRoot?: string`; `authorize` returns null when `!ctx.isMain` (R2 Critical 1: this preserves the legacy non-main block at `ipc.ts:1028-1036` — NOT the "no main check" I incorrectly described in brainstorming); `execute()` does the validation chain (agent regex, name regex, non-empty description/body/source_task, confidence 1..10) and returns `{executed:true, result:{success:false, message:'Invalid crystallize_skill payload.'}}` on validation failure, OR writes to `{agentsRoot}/{agent}/skills/crystallized/{name}/SKILL.md` + appends to `log.jsonl` on success. The `agentsRoot` env-gate (R2 Critical 2) is the same pattern as `skill_invoked`.

### Change 3: Strip legacy + register all 4 + relocate helpers (Commit 3)

- Delete `src/ipc.ts:1008-1052` (4 dispatcher branches).
- Delete `src/ipc.ts:1061-1102` (MAX_SKILL_CONTENT_BYTES, getBuiltinSkillNames, _resetBuiltinSkillsCacheForTests).
- Delete `src/ipc.ts:1107-1199, 1218-1328, 1336-1428, 1430-1442, 1444-1532` (all 5 handler functions + writeSkillResult).
- Update inline comment block in `src/ipc.ts:944-959` to add the skill_* migration line.
- Register all 4 handlers in `src/ipc/handlers/index.ts` after the existing slack registrations.
- **Add `save_skill` and `crystallize_skill` to `SKIP_GATE_ALLOWLIST` in `src/ipc/handler.ts:21-43`.** Place in the second sub-section (the "Writes that bypassed the gate in the if-ladder" group). Add a parallel TODO comment:

```typescript
// TODO: gate save_skill / crystallize_skill (currently preserve-bypass
// per Batch 2G; trust.yaml has 9 dormant save_skill: draft entries on
// claire/freud/simon/coo/einstein/steve/marvin/vincent/warren that this
// gate-bypass keeps inactive).
'save_skill',
'crystallize_skill',
```

- Move helpers to `src/ipc/handlers/skills.ts`:
  - `MAX_SKILL_CONTENT_BYTES = 64 * 1024` constant
  - `getBuiltinSkillNames()` function (with internal `builtinSkillsCache` module-scoped variable)
  - `_resetBuiltinSkillsCacheForTests()` exported test helper
  - `writeSkillResult()` is REPLACED by the dispatcher's `writeResultFile` (Rule 1) — handlers return result via `{executed:true, result:{...}}` and the dispatcher writes the file. Verify no other callers exist.
- Move imports to skills.ts:
  - `import { getBridgeToken } from '../../bridge-auth.js';` (was at `src/ipc.ts:5`)
  - `import { frontmatterDeclaresBash } from '../../skill-frontmatter.js';` (was at `src/ipc.ts:37`)
  - `import { AGENTS_DIR } from '../../config.js';` (if not already in skills.ts)
- Strip any imports orphaned from src/ipc.ts after the deletion.

## Test plan

New file `src/ipc/handlers/skills.test.ts` with 4 `describe` blocks. Pattern reference: `src/ipc/handlers/slack.test.ts` (38 tests, 2 describe blocks — exact structural twin). Plus one cross-cluster test in a separate file (or appended to skills.test.ts) for the `SKIP_GATE_ALLOWLIST` membership pins.

### A. `save_skill` (12 tests — R3 Critical 1, R3 M9, R3 M8)

**Unit-level (5):**
1. `parse` returns null for non-object input.
2. `parse` extracts skillName + skillContent + coerces wrong types to undefined.
3. `authorize` returns null for non-main caller (preserves legacy block).
4. `authorize` returns non-null with `skipGate: true` for main caller.
5. `execute` returns missing-params failure when skillName or skillContent absent.

**Execute-level validation (5 — each pins exact message string per R3 M9):**
6. `execute` invalid skill name returns `{success:false, message:'Invalid skill name. Use lowercase letters, numbers, and hyphens (2-64 chars).'}`.
7. `execute` content exceeds 64 KB cap returns `{success:false, message:'Skill content (<N> bytes) exceeds the 65536-byte cap.'}`. **Includes one variant where content = '\u{1F600}'.repeat(16385) (~65540 bytes of 4-byte chars) to pin Buffer.byteLength vs .length** (R3 M8).
8. `execute` builtin overwrite attempt returns `{success:false, message:'Cannot overwrite built-in skill "<name>".'}`. (Use the test seam: `getBuiltinSkillNames()` reads `container/skills/` — confirm a known builtin like `claw` is in the result.)
9. `execute` frontmatter declares Bash returns `{success:false, message:'Skill frontmatter declares allowed-tools: Bash. ...'}`.
10. `execute` happy path writes file at `container/skills/<name>/SKILL.md` AND returns `{success:true, message:'Skill "<name>" saved permanently.'}`.

**Integration (2 — R3 Critical 1 + Critical 2):**
11. **Preserve-bypass enforcement (R3 Critical 1):** dispatch from agent main caller with `trust.yaml save_skill: draft` set. Assert: SKILL.md WAS written; agent_actions table has ZERO rows for `save_skill` (no audit row); pending_actions table has ZERO rows for this agent (NOT staged). This test fails if save_skill is dropped from SKIP_GATE_ALLOWLIST.
12. **Non-main is silent block (R3 Critical 2):** dispatch from non-main caller with a valid requestId. Assert: skill_results/ dir does NOT exist (or, if pre-created by another test, is empty); container/skills/ has NO new directory; `agent_actions` table has ZERO rows. (Legacy = no file write; new = same outcome via authorize-null.)

### B. `crystallize_skill` (10 tests)

**Unit-level (3):**
13. `parse` returns null for non-object input; otherwise extracts agent + name + description + source_task + body + confidence + agentsRoot.
14. `authorize` returns null for non-main caller (R2 Critical 1 — preserve legacy block).
15. `authorize` returns non-null with `skipGate: true` for main caller.

**Execute-level (4):**
16. `execute` invalid payload (any of: missing/bad agent, missing/bad name, missing description/body/source_task, confidence out of 1..10) returns `{success:false, message:'Invalid crystallize_skill payload.'}` exactly.
17. `execute` happy path writes `{agentsRoot}/{agent}/skills/crystallized/{name}/SKILL.md` with stamped frontmatter (name, description JSON-quoted, crystallized_at ISO, source_task JSON-quoted, confidence, invocation_count: 0) + appends `{ts, agent, name, source_task, confidence}` to `{agentsRoot}/{agent}/skills/crystallized/log.jsonl`. **Pin the literal key set on log.jsonl** (R3 H4): `expect(Object.keys(JSON.parse(line))).toEqual(['ts','agent','name','source_task','confidence'])`.
18. **agentsRoot positive test (R3 H6):** dispatch with `agentsRoot: <tmpdir>`; assert SKILL.md lands at `<tmpdir>/.../SKILL.md`, NOT at AGENTS_DIR.
19. **agentsRoot negative test (R3 H6 + R2 Critical 2):** stub `process.env.VITEST = undefined` AND `process.env.NODE_ENV !== 'test'`; dispatch with `agentsRoot: <tmpdir>`. Assert tmpdir stays empty (env-gate refused the override). Restore env after.

**Integration (3):**
20. **Preserve-bypass enforcement (R3 Critical 1):** dispatch from main agent caller; assert SKILL.md written, zero agent_actions rows, zero pending_actions rows.
21. **Non-main is silent block:** dispatch from non-main; assert no SKILL.md written, no result file.
22. **Path-traversal block via agent regex:** dispatch with `agent: '../etc'`; assert validation rejects (no SKILL.md at AGENTS_DIR/../etc/...).

### C. `skill_search` (8 tests — R3 M7, R3 L11)

**Unit-level (3):**
23. `parse` returns null for non-object input; otherwise extracts query.
24. `authorize` returns non-null with `skipGate: true` (no main check).
25. `execute` missing query returns `{success:false, message:'Missing query parameter'}`.

**Execute-level (5 — pin exact messages per R3 L11):**
26. `execute` happy path: fetch mock returns 200 with valid QMD shape; result formats title/score/snippet from results array.
27. **`execute` empty QMD response (R3 M7 parametrized):** fetch returns 200 with body `{}`, `{result:{}}`, `{result:{content:[]}}`, `{result:{content:[{}]}}` — each returns `{success:false, message:'QMD returned empty response'}`. Use `it.each` for the 4 cases.
28. `execute` AbortError timeout returns `{success:false, message:'Skill search timed out'}` (mock fetch to reject with `Object.assign(new DOMException(), { name: 'AbortError' })`).
29. `execute` other fetch error returns `{success:false, message:'QMD unavailable: <err>'}` (mock fetch to reject with `new Error('ECONNREFUSED')` — assert message contains 'QMD unavailable: ECONNREFUSED').
30. `execute` malformed JSON (response.json() throws) → caught by dispatcher → result file `{success:false, message:'Error: ...'}`. (This is the dispatcher catch path, not the in-execute catch — different message text. Mirrors Batch 2F.1's slack.test.ts pattern.)

### D. `skill_invoked` (8 tests — R3 H3, R3 H4, R3 H5)

**Unit-level (3):**
31. `parse` returns null for non-object input; otherwise extracts agent + name + agentsRoot.
32. `authorize` returns non-null with `skipGate: true` AND `notifySummary: ''` (R1 Low 2 — documentation pin).
33. `execute` returns void (notify-kind contract).

**Execute behavior (4):**
34. `execute` no-op when SKILL.md doesn't exist (legacy ipc.ts:1370-1376). Assert no usage.jsonl created.
35. `execute` no-op when frontmatter is malformed (legacy ipc.ts:1379-1382). Assert SKILL.md unchanged, no usage.jsonl append.
36. `execute` happy path: SKILL.md frontmatter gets `invocation_count: N+1` (bumped via regex) AND `last_invoked_at: <ISO>` (upserted). usage.jsonl gets appended with `{ts, agent, name, sourceGroup}`. **Pin literal key set** (R3 H4): `expect(Object.keys(JSON.parse(line))).toEqual(['ts','agent','name','sourceGroup'])`.
37. **Idempotency (R3 H5):** seed count=0; invoke once → count=1; invoke again → count=2. Use `vi.setSystemTime` to pin two distinct `last_invoked_at` ISO strings; assert second invocation's last_invoked_at is the LATER timestamp. Each invocation gets a fresh `mkdtempSync` agent dir.

**Integration (1 — R3 H3):**
38. **No result file + no audit row (R3 H3):** dispatch a skill_invoked IPC. Assert: `skill_results/` directory either does not exist OR is empty (`fs.existsSync(skillResultsDir) ? fs.readdirSync(skillResultsDir) : []` is `[]`). Assert: `agent_actions` table has ZERO rows for `skill_invoked`. This is the correct shape — earlier brainstorm had `expect(existsSync(<requestId>.json)).toBe(false)` which is tautological because skill_invoked has no requestId.

### E. SKIP_GATE_ALLOWLIST regression pins (3 tests — R3 Critical 1)

In a separate `describe` block (could live in `skills.test.ts` or `handler.test.ts`):

39. `expect([...SKIP_GATE_ALLOWLIST]).toContain('save_skill');`
40. `expect([...SKIP_GATE_ALLOWLIST]).toContain('crystallize_skill');`
41. `expect([...SKIP_GATE_ALLOWLIST]).toContain('skill_invoked');` (R1 Low — skill_invoked's skipGate is load-bearing per R1 High 2, regress-coverage explicitly).

These three assertions are the mutation guards: dropping any of the three from the allowlist breaks at least one test loudly.

### Total: 41 tests

Section A: 12, B: 10, C: 8, D: 8, E: 3 = 41. Plus the existing tests around handler registration (one duplicate-handler check fires at import time if any of the 4 are registered twice).

## Behavior-preservation matrix

| Behavior | Legacy | New | Match? |
|---|---|---|---|
| **save_skill: !isMain** | `logger.warn + handled=true`, NO writeSkillResult | `authorize returns null`, dispatcher exits before result-write — NO file written | ✅ |
| **crystallize_skill: !isMain** (R2 Critical 1 / R1 Medium 1 fix) | `logger.warn + handled=true`, NO writeSkillResult — verified at ipc.ts:1028-1036 | `authorize returns null`, same outcome | ✅ |
| save_skill 4 validation paths return user-facing message | writeSkillResult with exact text at ipc.ts:1126, 1141, 1155, 1169 | execute returns `{executed:true, result:{success:false, message:<same text>}}` — dispatcher writes file | ✅ (R1 Critical 2 fix — validation in execute) |
| save_skill happy path writes container/skills/{name}/SKILL.md | yes | yes | ✅ |
| crystallize_skill happy path writes {agentsRoot}/{agent}/skills/crystallized/{name}/SKILL.md | yes | yes | ✅ |
| crystallize_skill log.jsonl append shape `{ts,agent,name,source_task,confidence}` | yes (ipc.ts:1302-1309) | yes (pinned by test 17) | ✅ |
| skill_invoked frontmatter mutation (count++, last_invoked_at upsert) | yes (ipc.ts:1390-1407) | yes | ✅ |
| skill_invoked usage.jsonl append shape `{ts,agent,name,sourceGroup}` | yes (ipc.ts:1414-1421) | yes (pinned by test 36) | ✅ |
| skill_search QMD fetch + format | yes | yes | ✅ |
| skill_search timeout message | `'Skill search timed out'` | same | ✅ |
| skill_search non-timeout fetch error | `'QMD unavailable: <err>'` | same | ✅ |
| skill_search empty response | `'QMD returned empty response'` | same | ✅ |
| All 4 handlers: NO trust gate, NO audit row, NO pending_actions | yes (legacy never calls checkTrustAndStage) | yes (skipGate → decision=null → no gate, no audit) | ✅ |
| Dormant `save_skill: draft` trust.yaml entries | unread | unread (skipGate bypasses) | ✅ |
| agentsRoot test seam env-gated | `process.env.VITEST === 'true' \|\| NODE_ENV === 'test'` | same (R2 Critical 2 fix — env-gate preserved in execute) | ✅ |

**Documented divergences (none are silent — all surfaced in spec):**

| Divergence | Legacy | New | Why acceptable |
|---|---|---|---|
| Missing requestId for skill_search/save_skill/crystallize_skill | `logger.warn + return true`, no file, NO audit row | dispatcher Rule 2 writes synthetic `agent_actions` row with `outcome='dropped_invalid_requestId'` + no file | Improves forensics (R1 High 1). Spec acknowledges as intentional. |
| Missing skillName/skillContent for save_skill (with valid requestId) | writeSkillResult inside legacy → `{success:false, message:'execution bailed'}` was NOT a legacy message (legacy just `logger.warn + return true` for missing fields) — wait, legacy at ipc.ts:1115-1118 actually ONLY logger.warns and returns. NO result file. | execute returns `{success:false, message:'Missing required parameters: skillName and skillContent'}` → dispatcher writes file | **Real divergence — flagged.** Legacy hung the agent poller; new behavior responds with structured failure. Improvement. |
| skill_search/skill_invoked synthetic audit row for malformed input | none | Rule 2 writes synthetic row | Improvement (R1 High 1). |

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| **save_skill or crystallize_skill drops off SKIP_GATE_ALLOWLIST** in future refactor → silent denial of all saves | Tests 39 and 40 assert membership. Failure surfaces immediately. |
| **skill_invoked drops off SKIP_GATE_ALLOWLIST** → silent loss of telemetry mutation + misleading blocked audit row | Test 41 asserts membership. R1 High 2. |
| **agentsRoot env-gate dropped** → compromised container redirects writes to arbitrary host path | R2 Critical 2 documented inline + tests 18/19 pin positive AND negative env-gate behavior. |
| **Validation logic moves to parse() in future cleanup** → 4 actionable error messages reduce to 'execution bailed' | R1 Critical 2 documented inline in saveSkillHandler comment + tests 6-9 pin each exact message string. |
| **usage.jsonl or log.jsonl key set drifts** → downstream consumers break silently | Tests 17 and 36 pin literal key sets via `Object.keys(JSON.parse(line))`. |
| **getBuiltinSkillNames cache pollution between tests** | _resetBuiltinSkillsCacheForTests is moved to skills.ts; test fixtures call it in beforeEach. |
| **writeSkillResult helper removed but some external caller still uses it** | Grep verification: writeSkillResult is private to src/ipc.ts (not exported). Confirmed only the 4 skill handlers call it. |
| **Container poller path collision** | `resultsDirName: 'skill_results'` matches the container-side hardcoded path. Plan-time grep verifies `skill_results` literal still appears in `container/agent-runner/src/ipc-mcp-stdio.ts`. |
| **`save_skill: draft` dormant entries cause confusion** in future debugging | R1 High 3: spec explicitly tags as Batch 4 candidate. Inline TODO comment in SKIP_GATE_ALLOWLIST adds context. |

## Scope discipline (NOT in this batch)

- **Not** activating the 9 dormant `save_skill: draft` trust.yaml entries. Tagged as a future explicit decision (Batch 4 candidate).
- **Not** activating ANY of the gate-bypassing actions flagged in project memory (`task_add`, `task_close`, `task_reopen`, `imessage_send`, `save_skill`, `crystallize_skill`, `x_*`). All preserve-bypass.
- **Not** changing the `x_*` or `browser_*` dispatch branches — they use dynamic skill imports, not the registry.
- **Not** removing the dormant trust.yaml entries from `data/agents/*/trust.yaml`. The entries are dormant config, not actively misleading — removal can wait for the gate-activation batch.
- **Not** introducing a new contract feature. All 4 handlers fit existing primitives.
- **Not** refactoring `getBridgeToken`, `frontmatterDeclaresBash`, or `getBuiltinSkillNames` — they relocate verbatim.

## Acceptance criteria

1. `bun run test` passes after all 3 commits (baseline + 41 new tests).
2. `bun run typecheck` passes.
3. `bun run lint` passes (zero errors; pre-existing warnings unchanged).
4. `grep -rln "save_skill" data/agents/*/trust.yaml | wc -l` returns 9 (unchanged from pre-batch baseline).
5. `grep -nE "handleSaveSkillIpc|handleCrystallizeSkillIpc|handleSkillSearchIpc|handleSkillInvokedIpc|writeSkillResult" src/ipc.ts` returns zero matches.
6. `grep -nE "data\\.type === '(save_skill|crystallize_skill|skill_search|skill_invoked)'" src/ipc.ts` returns zero matches.
7. `grep -n "MAX_SKILL_CONTENT_BYTES\\|getBuiltinSkillNames\\|_resetBuiltinSkillsCacheForTests" src/ipc.ts` returns zero matches (helpers fully moved).
8. The 4 new handlers visible in `src/ipc/handlers/index.ts` (8 grep matches: 4 imports + 4 registrations).
9. SKIP_GATE_ALLOWLIST size increased by 2 (save_skill + crystallize_skill added). Tests 39-41 verify.
10. `grep -n "skill_results" container/agent-runner/src/ipc-mcp-stdio.ts` returns at least 1 match (container poller path unchanged).

## Commit sequence

1. `refactor(ipc): migrate skill_search + skill_invoked to IpcHandler registry (Batch 2G part 1)`
   - `src/ipc/handlers/skills.ts`: new file containing skillSearchHandler, skillInvokedHandler, relocated helpers (getBuiltinSkillNames, MAX_SKILL_CONTENT_BYTES, _resetBuiltinSkillsCacheForTests). NOTE: getBuiltinSkillNames is for save_skill (Commit 2) but the helper moves cleanly in Commit 1 alongside skill_search/skill_invoked imports so the file is internally coherent.
   - `src/ipc/handlers/skills.test.ts`: new file with describes C (skill_search) + D (skill_invoked).
   - `src/ipc/handlers/index.ts`: import + register both.

2. `refactor(ipc): migrate save_skill + crystallize_skill, preserve bypass (Batch 2G part 2)`
   - `src/ipc/handlers/skills.ts`: append saveSkillHandler, crystallizeSkillHandler.
   - `src/ipc/handlers/skills.test.ts`: append describes A (save_skill) + B (crystallize_skill) + E (allowlist pins).
   - `src/ipc/handlers/index.ts`: register both.
   - `src/ipc/handler.ts`: add `'save_skill'` and `'crystallize_skill'` to SKIP_GATE_ALLOWLIST with TODO comment.

3. `refactor(ipc): strip legacy skill_* if-ladder (Batch 2G part 3)`
   - `src/ipc.ts`: delete 4 dispatcher branches + 5 handler functions + writeSkillResult + MAX_SKILL_CONTENT_BYTES + getBuiltinSkillNames + _resetBuiltinSkillsCacheForTests; update comment block; strip orphan imports.
   - Verify: full test suite passes, all acceptance criteria met.

(Optional 4th commit if prettier yields a diff after the cluster lands.)

## Peer-review log

### Round 1 — Brainstorm with user (2026-05-19 13:06 ET)

Three-question structured brainstorm. Locked: single skills.ts file (Q1); skill_invoked = notify-kind + skipGate (Q2); preserve legacy main-only policy "asymmetry" (Q3 — Q3 was malformed because the asymmetry did not exist; the answer happens to map cleanly to "both block non-main").

User additionally locked the preserve-bypass policy upfront: SKIP_GATE_ALLOWLIST membership for all 4 handlers, dormant trust.yaml entries stay dormant.

### Round 2 — Adversarial reviewer pass (2026-05-19 ~13:08 ET)

Three parallel reviewers dispatched against the brainstorm-locked design. Pre-loaded hypotheses:
- R1 (silent-failure-hunter): "preserve-bypass calcifies a real security gap, or migration silently changes behavior."
- R2 (code-reviewer): "skipGate composition with postHocNotify / actionTypeOverride / off-allowlist check has a bug."
- R3 (test-analyzer): "test plan misses regression coverage for preserve-bypass, or skill_invoked assertions are tautological."

Findings synthesized:

**Critical (5) — applied inline:**
- R2 Critical 1 + R1 Medium 1 (independently confirmed): crystallize_skill DOES have legacy non-main block (verified at ipc.ts:1028-1036). My "no main check" claim was wrong. Both writes block non-main.
- R1 Critical 2: save_skill validation logic must live in execute(), NOT parse()/authorize(). Preserves 4 user-facing error messages. Spec pins all 4 exact strings.
- R2 Critical 2: agentsRoot test-seam placement — must live in parse() output + env-gate in execute(). Spec spells out the pattern.
- R3 Critical 1: preserve-bypass policy unenforced by tests. Spec adds explicit allowlist-membership tests (39-41) + positive integration tests (11, 20).
- R3 Critical 2: brainstorm text said non-main writes `{success:false}` file; actually no file is written. Spec fixed.

**High (6) — applied inline:**
- R1 High 1: dispatcher Rule 2 synthetic audit row for missing requestId is intended divergence. Spec documents.
- R1 High 2 / Low 2: skill_invoked.skipGate is load-bearing. Spec adds inline comment + test 41.
- R1 High 3: 9 dormant trust.yaml entries flagged as Batch 4 candidate. Inline TODO in SKIP_GATE_ALLOWLIST.
- R1 High 4: getBridgeToken import move spelled out.
- R3 High 3: skill_invoked "no result file" assertion was tautological. Spec corrects to "skill_results/ dir empty + agent_actions zero rows" (test 38).
- R3 High 4: usage.jsonl + log.jsonl content shape pinned literally (tests 17, 36).
- R3 High 5: skill_invoked idempotency test added (test 37, fake timers).
- R3 High 6: agentsRoot positive AND negative env-gate tests (tests 18, 19).

**Medium (5) — applied inline:**
- R3 M7: empty-QMD-response message string pinned via `it.each` (test 27).
- R3 M8: multibyte byte-cap test added (test 7).
- R3 M9: each save_skill failure path pins exact message string (tests 6-9).
- R3 M10: container poller path collision check added to acceptance criteria (#10).
- R1 Low 1: skill_invoked.responseKind 'result' defensive inline comment.

**Low (1) — applied inline:**
- R3 L11: skill_search timeout vs other-error message difference pinned (tests 28, 29).

**Falsified (3):** R1's main hypothesis on preserve-bypass security — verified that the 4 handlers genuinely never went through the trust gate in legacy. R2's main hypothesis on contract composition bugs — verified clean composition with postHocNotify, off-allowlist check, and the 2F.1 loud-deny. Documented as "Falsified" in this log so a future reader can see what was explicitly checked and ruled out.

### Round 3 — Self-review of amended spec

Round-3 self-review will run after the spec is committed. No new findings expected at the design level — all 20 reviewer findings have been folded in.

## Open questions for user review

None at spec time. The two design decisions both reviewers caught (crystallize_skill main-only; validation in execute) are resolved by source verification. Brainstorm Q3's false-asymmetry premise is corrected.
