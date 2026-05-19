# IPC Batch 2G (skill_* cluster migration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the last 4 if-ladder handlers (`save_skill`, `crystallize_skill`, `skill_search`, `skill_invoked`) from `src/ipc.ts` into a new `src/ipc/handlers/skills.ts`. Preserve-bypass policy: all 4 go on `SKIP_GATE_ALLOWLIST` so legacy behavior (no trust gate, no audit row) is preserved exactly.

**Architecture:** Three commits. (1) Migrate `skill_search` + `skill_invoked` (already on SKIP_GATE_ALLOWLIST). (2) Migrate `save_skill` + `crystallize_skill` (add to SKIP_GATE_ALLOWLIST; both main-only via `authorize` returning null for `!ctx.isMain`). (3) Strip legacy from `src/ipc.ts`; relocate shared helpers (`getBuiltinSkillNames`, `MAX_SKILL_CONTENT_BYTES`, `_resetBuiltinSkillsCacheForTests`). No new contract feature — uses existing `skipGate`, `responseKind`, and main-only-via-authorize-null primitives. Validation logic lives in `execute()` (not `parse()`) so the 4 user-facing save_skill error messages survive the migration.

**Tech Stack:** TypeScript (strict mode), Vitest (`bun run test`), bun:sqlite (`_initTestDatabase()` for audit-row queries), `src/ipc/handler.ts` (dispatcher), `src/ipc/trust-gate.ts` (gate skip + non-agent decision).

**Spec:** `docs/superpowers/specs/2026-05-19-ipc-batch-2g-skills-cluster-design.md` (commit `cac903d5`). Read it before starting if you have not already — the Behavior-Preservation Matrix, the documented divergences from legacy (Rule 2 audit rows + structured-failure response for missing skillName/skillContent), and the explicit policy decisions (crystallize_skill DOES block non-main; validation in execute) are the ground truth this plan implements step-by-step.

---

## File Structure

**Created (2 files):**
- `src/ipc/handlers/skills.ts` — All 4 handlers (`skillSearchHandler`, `skillInvokedHandler`, `saveSkillHandler`, `crystallizeSkillHandler`) + relocated helpers (`MAX_SKILL_CONTENT_BYTES`, `getBuiltinSkillNames`, `_resetBuiltinSkillsCacheForTests`). ~280 LOC.
- `src/ipc/handlers/skills.test.ts` — 41 tests across 5 describe blocks. ~750 LOC.

**Modified (3 files):**
- `src/ipc/handler.ts` — Add `'save_skill'` and `'crystallize_skill'` to `SKIP_GATE_ALLOWLIST` (writes sub-section). ~3 LOC delta.
- `src/ipc/handlers/index.ts` — Import + register all 4 handlers. ~8 LOC delta.
- `src/ipc.ts` — Strip 4 dispatcher branches + 5 handler functions + writeSkillResult + helpers; update comment block; strip orphan imports if any. ~425 LOC removed.

---

## Commit 1 — Migrate `skill_search` + `skill_invoked`

### Task 1: Create `src/ipc/handlers/skills.ts` skeleton with both handlers + relocated helpers

**Files:**
- Create: `src/ipc/handlers/skills.ts`

- [ ] **Step 1: Read the existing slack.ts** for pattern reference.

```bash
sed -n '1,30p' /Users/mgandal/Agents/nanoclaw/src/ipc/handlers/slack.ts
```

Note the import style and the IpcHandler generics.

- [ ] **Step 2: Read the legacy code being migrated** to lock in exact behavior.

```bash
sed -n '1066,1102p' /Users/mgandal/Agents/nanoclaw/src/ipc.ts   # MAX_SKILL_CONTENT_BYTES + getBuiltinSkillNames + _reset
sed -n '1336,1432p' /Users/mgandal/Agents/nanoclaw/src/ipc.ts   # skill_invoked + writeSkillResult
sed -n '1444,1533p' /Users/mgandal/Agents/nanoclaw/src/ipc.ts   # skill_search
```

- [ ] **Step 3: Write the new file**

Use the Write tool. Create `src/ipc/handlers/skills.ts` with this exact content:

```typescript
import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from '../../config.js';
import { getBridgeToken } from '../../bridge-auth.js';
import { frontmatterDeclaresBash } from '../../skill-frontmatter.js';
import { logger } from '../../logger.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

/**
 * Maximum size of a SKILL.md saved via save_skill IPC (64 KB). The agent
 * writes the body itself, so this is a soft DoS bound rather than a
 * structural limit. Existing builtins fit comfortably under 16 KB.
 *
 * Relocated from src/ipc.ts:1066 in Batch 2G.
 */
const MAX_SKILL_CONTENT_BYTES = 64 * 1024;

/**
 * Discover the active builtin skill names by listing container/skills/.
 * Cached per-process; the directory is read-only at runtime, so a single
 * read at first invocation is sufficient. A reload helper is exposed for
 * tests that swap the cwd between cases.
 *
 * Relocated from src/ipc.ts:1075 in Batch 2G.
 */
let builtinSkillsCache: Set<string> | null = null;
function getBuiltinSkillNames(): Set<string> {
  if (builtinSkillsCache) return builtinSkillsCache;
  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    builtinSkillsCache = new Set(
      entries.filter((e) => e.isDirectory()).map((e) => e.name),
    );
  } catch (err) {
    logger.error(
      { skillsDir, err: err instanceof Error ? err.message : String(err) },
      'getBuiltinSkillNames: container/skills/ unreadable — save_skill builtin protection is fail-open',
    );
    builtinSkillsCache = new Set();
  }
  return builtinSkillsCache;
}

/** @internal — for tests only. Forces re-scan on next getBuiltinSkillNames(). */
export function _resetBuiltinSkillsCacheForTests(): void {
  builtinSkillsCache = null;
}

/**
 * skill_search — read-only QMD bridge search. Already on SKIP_GATE_ALLOWLIST
 * at handler.ts:28. Migrated verbatim from src/ipc.ts:1444-1532.
 *
 * Wire-format notes:
 *  - resultsDirName: 'skill_results' matches the container-side hardcoded
 *    path. All 4 skill_* handlers share this directory.
 *  - skipGate: true preserves the legacy gate-bypass behavior.
 */
interface SkillSearchInput {
  query: string | undefined;
}

export const skillSearchHandler: IpcHandler<
  SkillSearchInput,
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

  authorize() {
    return {
      target: '',
      notifySummary: '',
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

    try {
      const response = await fetch('http://localhost:8181/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getBridgeToken()}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'query',
            arguments: {
              searches: [{ type: 'lex', query: input.query }],
              collections: ['skill-catalog'],
              intent: input.query,
              limit: 5,
            },
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      const json = (await response.json()) as {
        result?: {
          content?: Array<{ text?: string }>;
        };
      };

      const rawText = json.result?.content?.[0]?.text;
      if (!rawText) {
        return {
          executed: true,
          result: { success: false, message: 'QMD returned empty response' },
        };
      }

      const parsed = JSON.parse(rawText) as {
        results: Array<{
          file: string;
          title: string;
          score: number;
          snippet: string;
        }>;
      };

      const formatted = parsed.results
        .map(
          (r) =>
            `${r.title} (score: ${r.score.toFixed(2)})\n  ${r.snippet}\n  file: ${r.file}`,
        )
        .join('\n\n');

      logger.info(
        { sourceGroup: ctx.sourceGroup, query: input.query, requestId: ctx.requestId },
        'skill_search IPC handled',
      );

      return {
        executed: true,
        result: {
          success: true,
          message: formatted || 'No skills found',
        },
      };
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      logger.warn(
        { err, sourceGroup: ctx.sourceGroup, requestId: ctx.requestId },
        'skill_search IPC error',
      );
      return {
        executed: true,
        result: {
          success: false,
          message: isTimeout
            ? 'Skill search timed out'
            : 'QMD unavailable: ' +
              (err instanceof Error ? err.message : String(err)),
        },
      };
    }
  },
};

/**
 * skill_invoked — telemetry fire-and-forget. Mutates a crystallized skill's
 * frontmatter (invocation_count++, last_invoked_at upsert) and appends to
 * usage.jsonl. NO result file, NO audit row, NO notify.
 *
 * Already on SKIP_GATE_ALLOWLIST at handler.ts:29. Migrated verbatim from
 * src/ipc.ts:1336-1428.
 *
 * Contract pins (DO NOT change without redesign):
 *  - responseKind omitted → defaults to 'notify'. With skipGate=true,
 *    decision === null, so the dispatcher's else-if-decision-not-null
 *    notify branch is unreachable. notifySummary: '' never fires.
 *  - DO NOT change responseKind to 'result' — the dispatcher would
 *    synthesize a {success:true} file alongside the SKILL.md mutation,
 *    surprising downstream consumers.
 *  - skipGate: true is load-bearing. Without it, an agent with no
 *    trust.yaml entry for skill_invoked would be blocked AND a
 *    misleading "blocked" audit row would be written, silently
 *    stopping the telemetry mutation. Regression-guarded by the
 *    SKIP_GATE_ALLOWLIST membership test in skills.test.ts.
 *  - agentsRoot env-gate (`isTestEnv`) is the only barrier preventing a
 *    compromised container from redirecting writes to an arbitrary host
 *    path. DO NOT remove the env-gate.
 */
interface SkillInvokedInput {
  agent: string | undefined;
  name: string | undefined;
  agentsRoot: string | undefined;
}

export const skillInvokedHandler: IpcHandler<SkillInvokedInput, void> = {
  type: 'skill_invoked',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      agent: typeof r.agent === 'string' ? r.agent : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
      agentsRoot: typeof r.agentsRoot === 'string' ? r.agentsRoot : undefined,
    };
  },

  authorize() {
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'skill_invoked' },
      skipGate: true,
    };
  },

  execute(input, ctx) {
    const agentRe = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    const skillNameRe = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
    if (!input.agent || !agentRe.test(input.agent)) {
      logger.warn(
        { agent: input.agent, name: input.name, sourceGroup: ctx.sourceGroup },
        'skill_invoked IPC rejected: invalid payload',
      );
      return;
    }
    if (!input.name || !skillNameRe.test(input.name)) {
      logger.warn(
        { agent: input.agent, name: input.name, sourceGroup: ctx.sourceGroup },
        'skill_invoked IPC rejected: invalid payload',
      );
      return;
    }

    // Env-gate the agentsRoot test seam. DO NOT remove — production
    // protection against path-redirection from compromised container.
    const isTestEnv =
      process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
    const agentsRoot =
      isTestEnv && typeof input.agentsRoot === 'string'
        ? input.agentsRoot
        : AGENTS_DIR;

    try {
      const crystallizedDir = path.join(
        agentsRoot,
        input.agent,
        'skills',
        'crystallized',
      );
      const skillFile = path.join(crystallizedDir, input.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        logger.debug(
          { agent: input.agent, name: input.name },
          'skill_invoked: no SKILL.md found, ignoring',
        );
        return;
      }

      const existing = fs.readFileSync(skillFile, 'utf-8');
      const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!fmMatch) {
        logger.warn(
          { agent: input.agent, name: input.name },
          'skill_invoked: malformed frontmatter',
        );
        return;
      }

      let frontmatter = fmMatch[1];
      const body = fmMatch[2];
      const nowIso = new Date().toISOString();

      if (/^invocation_count:\s*\d+/m.test(frontmatter)) {
        frontmatter = frontmatter.replace(
          /^invocation_count:\s*(\d+)/m,
          (_, n) => `invocation_count: ${Number(n) + 1}`,
        );
      } else {
        frontmatter = `${frontmatter}\ninvocation_count: 1`;
      }

      if (/^last_invoked_at:/m.test(frontmatter)) {
        frontmatter = frontmatter.replace(
          /^last_invoked_at:.*$/m,
          `last_invoked_at: ${nowIso}`,
        );
      } else {
        frontmatter = `${frontmatter}\nlast_invoked_at: ${nowIso}`;
      }

      const updated = `---\n${frontmatter}\n---\n${body}`;
      const tmpPath = `${skillFile}.tmp`;
      fs.writeFileSync(tmpPath, updated);
      fs.renameSync(tmpPath, skillFile);

      const usageLine =
        JSON.stringify({
          ts: nowIso,
          agent: input.agent,
          name: input.name,
          sourceGroup: ctx.sourceGroup,
        }) + '\n';
      fs.appendFileSync(path.join(crystallizedDir, 'usage.jsonl'), usageLine);

      logger.info(
        { agent: input.agent, name: input.name, sourceGroup: ctx.sourceGroup },
        'Crystallized skill invoked',
      );
    } catch (err) {
      logger.error(
        { err, agent: input.agent, name: input.name },
        'skill_invoked IPC error',
      );
    }
  },
};
```

This file will be EXTENDED in Commit 2 (Task 5) with `saveSkillHandler` and `crystallizeSkillHandler`. For now, only the two read/telemetry handlers + the relocated helpers are in place.

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS (the new file references symbols from `../handler.js`, `../../config.js`, `../../bridge-auth.js`, `../../skill-frontmatter.js`, `../../logger.js` — all existing imports).

- [ ] **Step 5: Confirm helpers do not collide with src/ipc.ts**

```bash
grep -n "MAX_SKILL_CONTENT_BYTES\|getBuiltinSkillNames\|_resetBuiltinSkillsCacheForTests" src/ipc.ts
```

Expected: still shows the legacy declarations (will be deleted in Commit 3). Both files will define the same symbols simultaneously between Commit 1 and Commit 3 — TypeScript does not complain about this because they're in separate modules with no cross-import. The legacy `_resetBuiltinSkillsCacheForTests` is exported from `src/ipc.ts` and may be imported by an existing test; verify:

```bash
grep -rn "_resetBuiltinSkillsCacheForTests" src/
```

Expected: shows the legacy export at `src/ipc.ts:1099`, the new export at `src/ipc/handlers/skills.ts:N`, and any test files importing it. Note which test files import it — they'll need to be updated in Commit 3 when the legacy is deleted.

### Task 2: Register both handlers in `src/ipc/handlers/index.ts`

**Files:**
- Modify: `src/ipc/handlers/index.ts`

- [ ] **Step 1: Read the file** to find the existing slack imports and registrations.

```bash
cat src/ipc/handlers/index.ts
```

You should see lines like:

```typescript
import { slackDmReadHandler, slackDmHandler } from './slack.js';
// ...
  registerIpcHandler(slackDmReadHandler);
  registerIpcHandler(slackDmHandler);
```

- [ ] **Step 2: Add the import**

Use the Edit tool. Find:

```typescript
import { slackDmReadHandler, slackDmHandler } from './slack.js';
```

Replace with:

```typescript
import { slackDmReadHandler, slackDmHandler } from './slack.js';
import { skillSearchHandler, skillInvokedHandler } from './skills.js';
```

- [ ] **Step 3: Add the registrations**

Find:

```typescript
  registerIpcHandler(slackDmHandler);
```

Replace with:

```typescript
  registerIpcHandler(slackDmHandler);
  registerIpcHandler(skillSearchHandler);
  registerIpcHandler(skillInvokedHandler);
```

- [ ] **Step 4: Confirm no duplicate-handler errors**

The dispatcher has a `Duplicate IPC handler registered: skill_search` guard at handler.ts:188. Run the full IPC test suite to verify nothing broke:

```bash
bun run test -- src/ipc/
```

Expected: PASS for all `src/ipc/**/*.test.ts`. The legacy `handleSkillSearchIpc` is still in `src/ipc.ts` but not in the registry, so no collision. The dispatcher tries registry first (returns `{handled: true}` for skill_search via the new handler) and never reaches the legacy if-ladder branch — meaning the legacy code is effectively unreachable starting now (but still present until Commit 3).

### Task 3: Write tests for skill_search (Section C of spec, tests 23-30)

**Files:**
- Create: `src/ipc/handlers/skills.test.ts`

- [ ] **Step 1: Read the slack.test.ts pattern** to lock in the imports + beforeEach + helpers.

```bash
sed -n '1,100p' /Users/mgandal/Agents/nanoclaw/src/ipc/handlers/slack.test.ts
```

- [ ] **Step 2: Create skills.test.ts with the skill_search describe block**

Use the Write tool. Create `src/ipc/handlers/skills.test.ts` with:

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { _initTestDatabase, getDb, setRegisteredGroup } from '../../db.js';
import { DATA_DIR } from '../../config.js';
import { IpcDeps } from '../../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
  SKIP_GATE_ALLOWLIST,
} from '../handler.js';
import {
  skillSearchHandler,
  skillInvokedHandler,
  _resetBuiltinSkillsCacheForTests,
} from './skills.js';

/**
 * skill_search handler tests. Migrated from src/ipc.ts:1444-1532
 * (handleSkillSearchIpc) at git HEAD prior to Batch 2G.
 *
 * Pins:
 *  - parse / authorize / execute unit shape
 *  - empty-QMD-response paths return exact 'QMD returned empty response' message
 *  - timeout vs other-error message difference pinned
 *  - skipGate:true means no audit row written even for agent callers
 */
describe('skill_search handler', () => {
  const SOURCE_GROUP = 'telegram_skilltest';

  let dataDir: string;
  let deps: IpcDeps;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(skillSearchHandler);

    setRegisteredGroup('tg:skilltest1', {
      name: 'SkillTest',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    deps = {
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-search-test-'));

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const dispatch = async (
    data: Record<string, unknown>,
    compoundSource = SOURCE_GROUP,
  ) => {
    const ctx = buildContext(compoundSource, false, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const readResult = (
    sourceGroup: string,
    requestId: string,
  ): Record<string, unknown> | null => {
    const file = path.join(
      dataDir,
      'ipc',
      sourceGroup,
      'skill_results',
      `${requestId}.json`,
    );
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  };

  it('23. parse returns null for non-object; otherwise extracts query', () => {
    expect(skillSearchHandler.parse(null)).toBeNull();
    expect(skillSearchHandler.parse(42)).toBeNull();
    expect(skillSearchHandler.parse({ query: 'foo' })).toEqual({ query: 'foo' });
    expect(skillSearchHandler.parse({ query: 42 })).toEqual({ query: undefined });
  });

  it('24. authorize returns skipGate:true (no main check)', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = skillSearchHandler.authorize({ query: 'foo' }, ctx);
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBe(true);
  });

  it('25. execute missing query returns Missing query parameter', async () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const result = await skillSearchHandler.execute({ query: undefined }, ctx);
    expect(result).toEqual({
      executed: true,
      result: { success: false, message: 'Missing query parameter' },
    });
  });

  it('26. execute happy path formats title/score/snippet from QMD results', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          content: [
            {
              text: JSON.stringify({
                results: [
                  { file: '/a.md', title: 'Alpha', score: 0.9, snippet: 'aaa' },
                  { file: '/b.md', title: 'Beta', score: 0.8, snippet: 'bbb' },
                ],
              }),
            },
          ],
        },
      }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await skillSearchHandler.execute({ query: 'foo' }, ctx);
    expect(out).toMatchObject({ executed: true });
    const payload = (out as { result: { success: boolean; message: string } }).result;
    expect(payload.success).toBe(true);
    expect(payload.message).toContain('Alpha (score: 0.90)');
    expect(payload.message).toContain('aaa');
    expect(payload.message).toContain('Beta (score: 0.80)');
    expect(payload.message).toContain('file: /a.md');
  });

  it.each([
    ['empty body', {}],
    ['empty result', { result: {} }],
    ['empty content', { result: { content: [] } }],
    ['content without text', { result: { content: [{}] } }],
  ])('27. execute empty QMD response (%s) returns exact failure message', async (_label, body) => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await skillSearchHandler.execute({ query: 'foo' }, ctx);
    expect(out).toEqual({
      executed: true,
      result: { success: false, message: 'QMD returned empty response' },
    });
  });

  it('28. execute AbortError timeout returns Skill search timed out', async () => {
    const abortErr = Object.assign(new DOMException('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abortErr);
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await skillSearchHandler.execute({ query: 'foo' }, ctx);
    expect(out).toEqual({
      executed: true,
      result: { success: false, message: 'Skill search timed out' },
    });
  });

  it('29. execute other fetch error returns QMD unavailable: <msg>', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await skillSearchHandler.execute({ query: 'foo' }, ctx);
    expect(out).toMatchObject({
      executed: true,
      result: { success: false, message: 'QMD unavailable: ECONNREFUSED' },
    });
  });

  it('30. integration: dispatcher catches response.json() rejection → writes failure file', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <');
      },
    });
    await dispatch({
      type: 'skill_search',
      requestId: 'req-json-throw',
      query: 'foo',
    });
    // The execute() catches the json() throw because await response.json() is inside the try.
    // So we expect the in-execute failure message ('QMD unavailable: Unexpected token <'),
    // NOT the dispatcher's catch path.
    const result = readResult(SOURCE_GROUP, 'req-json-throw');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('QMD unavailable');
    expect(result!.message).toContain('Unexpected token');
  });
});
```

- [ ] **Step 3: Run the skill_search tests**

```bash
bun run test -- src/ipc/handlers/skills.test.ts
```

Expected: 8 tests PASS (the existing legacy `handleSkillSearchIpc` is now bypassed because the dispatcher's registry handles `skill_search` via the new handler).

### Task 4: Write tests for skill_invoked (Section D of spec, tests 31-38)

**Files:**
- Modify: `src/ipc/handlers/skills.test.ts` (append new describe block)

- [ ] **Step 1: Find the closing `});` of the existing `describe('skill_search handler', ...)` block** in `src/ipc/handlers/skills.test.ts`.

- [ ] **Step 2: Append the skill_invoked describe block**

Use the Edit tool. Find the last `});` in the file. Replace with that same `});` plus the new block:

```typescript
});

/**
 * skill_invoked handler tests. Migrated from src/ipc.ts:1336-1428
 * (handleSkillInvokedIpc) at git HEAD prior to Batch 2G.
 *
 * Pins:
 *  - parse / authorize / execute unit shape
 *  - notifySummary: '' (documentation pin per R1 Low 2)
 *  - frontmatter idempotency: invoke twice → count=2 with second timestamp
 *  - no-op when SKILL.md missing or frontmatter malformed
 *  - no result file written; no audit row (skipGate)
 *  - agentsRoot env-gate: positive (vitest env honored) AND negative
 *    (env unset, override refused)
 */
describe('skill_invoked handler', () => {
  const SOURCE_GROUP = 'telegram_skilltest';
  let dataDir: string;
  let deps: IpcDeps;
  let agentsTmpRoot: string;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(skillInvokedHandler);

    setRegisteredGroup('tg:skilltest1', {
      name: 'SkillTest',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    deps = {
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-invoked-test-'));
    agentsTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-invoked-agents-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentsTmpRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const dispatch = async (data: Record<string, unknown>) => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const seedSkill = (
    rootDir: string,
    agent: string,
    name: string,
    body: string = '\nSteps...\n',
    extraFrontmatter: string = '',
  ): string => {
    const dir = path.join(rootDir, agent, 'skills', 'crystallized', name);
    fs.mkdirSync(dir, { recursive: true });
    const fm = `---\nname: ${name}\ndescription: test\ninvocation_count: 0${extraFrontmatter}\n---`;
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, `${fm}${body}`);
    return file;
  };

  it('31. parse returns null for non-object; otherwise extracts agent + name + agentsRoot', () => {
    expect(skillInvokedHandler.parse(null)).toBeNull();
    expect(skillInvokedHandler.parse({ agent: 'a', name: 'b' })).toEqual({
      agent: 'a',
      name: 'b',
      agentsRoot: undefined,
    });
    expect(
      skillInvokedHandler.parse({ agent: 'a', name: 'b', agentsRoot: '/tmp/x' }),
    ).toEqual({ agent: 'a', name: 'b', agentsRoot: '/tmp/x' });
  });

  it('32. authorize returns skipGate:true AND notifySummary: ""', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = skillInvokedHandler.authorize(
      { agent: 'a', name: 'b', agentsRoot: undefined },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBe(true);
    expect(auth!.notifySummary).toBe('');
  });

  it('33. execute returns void (notify-kind contract)', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    // SKILL.md does not exist; execute should silently return.
    const result = skillInvokedHandler.execute(
      { agent: 'agent1', name: 'skill1', agentsRoot: agentsTmpRoot },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it('34. execute no-op when SKILL.md does not exist', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    skillInvokedHandler.execute(
      { agent: 'agent1', name: 'skill1', agentsRoot: agentsTmpRoot },
      ctx,
    );
    // No usage.jsonl created.
    const usageFile = path.join(
      agentsTmpRoot,
      'agent1',
      'skills',
      'crystallized',
      'usage.jsonl',
    );
    expect(fs.existsSync(usageFile)).toBe(false);
  });

  it('35. execute no-op when frontmatter is malformed', () => {
    const dir = path.join(agentsTmpRoot, 'agent1', 'skills', 'crystallized', 'skill1');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    const orig = 'no frontmatter at all\njust body';
    fs.writeFileSync(file, orig);

    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    skillInvokedHandler.execute(
      { agent: 'agent1', name: 'skill1', agentsRoot: agentsTmpRoot },
      ctx,
    );

    // SKILL.md unchanged.
    expect(fs.readFileSync(file, 'utf-8')).toBe(orig);
    // No usage.jsonl appended.
    const usageFile = path.join(
      agentsTmpRoot,
      'agent1',
      'skills',
      'crystallized',
      'usage.jsonl',
    );
    expect(fs.existsSync(usageFile)).toBe(false);
  });

  it('36. execute happy path bumps count + upserts last_invoked_at + appends usage.jsonl with literal key set', () => {
    const file = seedSkill(agentsTmpRoot, 'agent1', 'skill1');
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);

    skillInvokedHandler.execute(
      { agent: 'agent1', name: 'skill1', agentsRoot: agentsTmpRoot },
      ctx,
    );

    const updated = fs.readFileSync(file, 'utf-8');
    expect(updated).toContain('invocation_count: 1');
    expect(updated).toMatch(/last_invoked_at: \d{4}-\d{2}-\d{2}T/);

    const usageFile = path.join(
      agentsTmpRoot,
      'agent1',
      'skills',
      'crystallized',
      'usage.jsonl',
    );
    expect(fs.existsSync(usageFile)).toBe(true);
    const line = fs.readFileSync(usageFile, 'utf-8').trim();
    const parsed = JSON.parse(line);
    // Pin literal key set per spec R3 H4.
    expect(Object.keys(parsed).sort()).toEqual(['agent', 'name', 'sourceGroup', 'ts']);
    expect(parsed.agent).toBe('agent1');
    expect(parsed.name).toBe('skill1');
    expect(parsed.sourceGroup).toBe(SOURCE_GROUP);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('37. idempotency: invoke twice → count=2 AND second last_invoked_at is later', () => {
    const file = seedSkill(agentsTmpRoot, 'agent1', 'skill1');
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);

    // First invocation at frozen time T1.
    vi.useFakeTimers();
    const t1 = new Date('2026-05-19T13:00:00.000Z');
    vi.setSystemTime(t1);
    skillInvokedHandler.execute(
      { agent: 'agent1', name: 'skill1', agentsRoot: agentsTmpRoot },
      ctx,
    );
    const afterFirst = fs.readFileSync(file, 'utf-8');
    expect(afterFirst).toContain('invocation_count: 1');
    expect(afterFirst).toContain('last_invoked_at: 2026-05-19T13:00:00.000Z');

    // Second invocation at T2 (10s later).
    const t2 = new Date('2026-05-19T13:00:10.000Z');
    vi.setSystemTime(t2);
    skillInvokedHandler.execute(
      { agent: 'agent1', name: 'skill1', agentsRoot: agentsTmpRoot },
      ctx,
    );
    const afterSecond = fs.readFileSync(file, 'utf-8');
    expect(afterSecond).toContain('invocation_count: 2');
    expect(afterSecond).toContain('last_invoked_at: 2026-05-19T13:00:10.000Z');
    // Earlier timestamp should be gone (upsert, not append).
    expect(afterSecond).not.toContain('last_invoked_at: 2026-05-19T13:00:00.000Z');
  });

  it('38. integration: dispatch writes no result file AND no audit row', async () => {
    seedSkill(agentsTmpRoot, 'agent1', 'skill1');
    await dispatch({
      type: 'skill_invoked',
      agent: 'agent1',
      name: 'skill1',
      agentsRoot: agentsTmpRoot,
    });

    // skill_results/ dir does not exist or is empty.
    const skillResultsDir = path.join(dataDir, 'ipc', SOURCE_GROUP, 'skill_results');
    const entries = fs.existsSync(skillResultsDir) ? fs.readdirSync(skillResultsDir) : [];
    expect(entries).toEqual([]);

    // No audit row for skill_invoked.
    const rows = getDb()
      .prepare("SELECT * FROM agent_actions WHERE action_type = 'skill_invoked'")
      .all();
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run skills.test.ts**

```bash
bun run test -- src/ipc/handlers/skills.test.ts
```

Expected: 15 tests PASS (8 skill_search + 7 skill_invoked unit/integration tests numbered 31-38, with 31-37 covered above; test 38 is the integration). Test 33 is a duplicate marker — the body of test 33 verifies `execute()` returns `undefined`; tests 34-37 verify the side effects. **Note**: tests are numbered to match the spec; the actual test count is 8 in skill_search + 8 in skill_invoked = 16, matching the spec's 8+8.

- [ ] **Step 4: Run the full ipc test sweep**

```bash
bun run test -- src/ipc/
```

Expected: All `src/ipc/**/*.test.ts` PASS. The legacy `handleSkillSearchIpc` and `handleSkillInvokedIpc` are now unreachable (registry handles them first) but still defined.

### Task 5: Commit 1 — `skill_search` + `skill_invoked` migration

**Files:**
- Stage: `src/ipc/handlers/skills.ts`, `src/ipc/handlers/skills.test.ts`, `src/ipc/handlers/index.ts`

- [ ] **Step 1: Verify only the intended files are modified**

```bash
rtk git status
```

Expected: 3 files in the modified/untracked lists.

- [ ] **Step 2: Stage explicitly**

```bash
rtk git add src/ipc/handlers/skills.ts src/ipc/handlers/skills.test.ts src/ipc/handlers/index.ts
```

- [ ] **Step 3: Commit**

```bash
rtk git commit -m "$(cat <<'EOF'
refactor(ipc): migrate skill_search + skill_invoked to IpcHandler registry (Batch 2G part 1)

Lifts handleSkillSearchIpc and handleSkillInvokedIpc out of the
src/ipc.ts if-ladder into the typed registry. Both were already on
SKIP_GATE_ALLOWLIST (handler.ts:28-29) — pure structural migration,
no policy change.

skillSearchHandler:
- responseKind: 'result', resultsDirName: 'skill_results'
- skipGate: true (no main check, no trust gate)
- Wraps QMD bridge fetch + response formatting verbatim
- Pinned messages: 'Missing query parameter', 'QMD returned empty
  response', 'Skill search timed out', 'QMD unavailable: <err>'

skillInvokedHandler:
- responseKind omitted (defaults to 'notify')
- skipGate: true (load-bearing — without it, an agent missing trust
  policy would be silently blocked AND the side effect would stop)
- Mutates SKILL.md frontmatter (invocation_count, last_invoked_at)
- Appends usage.jsonl with {ts, agent, name, sourceGroup}
- agentsRoot test seam env-gated by VITEST / NODE_ENV (production
  protection against compromised-container path-redirection)

Tests: 16 new in skills.test.ts pinning literal messages, the 4
empty-QMD-response shapes (it.each), idempotency via vi.setSystemTime,
no-result-file + no-audit-row integration test (the correct shape —
the brainstorm's <requestId>.json existsSync check was tautological
because skill_invoked has no requestId).

Relocated helpers (MAX_SKILL_CONTENT_BYTES, getBuiltinSkillNames,
_resetBuiltinSkillsCacheForTests) accompany the new file. Legacy
src/ipc.ts versions remain temporarily until Commit 3 strip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify the commit**

```bash
rtk git log -1 --oneline
```

Expected: One line beginning `refactor(ipc): migrate skill_search + skill_invoked to IpcHandler registry (Batch 2G part 1)`.

---

## Commit 2 — Migrate `save_skill` + `crystallize_skill`

### Task 6: Add `save_skill` and `crystallize_skill` to `SKIP_GATE_ALLOWLIST`

**Files:**
- Modify: `src/ipc/handler.ts:21-43`

- [ ] **Step 1: Read the current allowlist**

```bash
sed -n '21,43p' src/ipc/handler.ts
```

You should see two sub-sections (read-only and writes), with the writes section ending in `pageindex_index`.

- [ ] **Step 2: Add the two new entries**

Use the Edit tool. Find this block:

```typescript
  // TODO(Batch4): gate task_add / task_close / task_reopen / pageindex_index.
  'task_add',
  'task_close',
  'task_reopen',
  'pageindex_index',
]);
```

Replace with:

```typescript
  // TODO(Batch4): gate task_add / task_close / task_reopen / pageindex_index.
  'task_add',
  'task_close',
  'task_reopen',
  'pageindex_index',
  // TODO: gate save_skill / crystallize_skill (currently preserve-bypass
  // per Batch 2G; trust.yaml has 9 dormant save_skill: draft entries on
  // claire/freud/simon/coo/einstein/steve/marvin/vincent/warren that this
  // gate-bypass keeps inactive).
  'save_skill',
  'crystallize_skill',
]);
```

- [ ] **Step 3: Run typecheck and existing IPC tests**

```bash
bun run typecheck
bun run test -- src/ipc/
```

Expected: PASS. The legacy `save_skill` if-ladder branch in `src/ipc.ts` will fire first (no handler registered for `save_skill` in the registry yet — Tasks 7-8 add it), so the allowlist addition is benign until the handler exists.

### Task 7: Write tests for save_skill (Section A of spec, tests 1-12)

**Files:**
- Modify: `src/ipc/handlers/skills.test.ts` (append new describe block)

- [ ] **Step 1: Find the closing `});` of the existing `describe('skill_invoked handler', ...)` block**.

- [ ] **Step 2: Append the save_skill describe block**

Use the Edit tool. Append after the closing `});` of the last describe:

```typescript

/**
 * save_skill handler tests. Migrated from src/ipc.ts:1107-1199
 * (handleSaveSkillIpc) at git HEAD prior to Batch 2G.
 *
 * Pins (per spec R1 Critical 2 + R3 M9 + R3 M8):
 *  - 4 user-facing rejection messages pinned exactly (validation lives
 *    in execute, NOT parse/authorize, so the agent sees the actionable
 *    text).
 *  - Multibyte byte-cap test: 16385 × '\u{1F600}' (4 bytes each) crosses
 *    the cap, proving Buffer.byteLength is honored over .length.
 *  - Preserve-bypass enforcement: agent main caller writes the file,
 *    writes ZERO agent_actions rows, writes ZERO pending_actions rows.
 *  - Non-main is a silent block (no file, no result).
 */
describe('save_skill handler', () => {
  const SOURCE_GROUP = 'telegram_skilltest';
  let dataDir: string;
  let deps: IpcDeps;
  let savedSkillsCwd: string;
  let originalCwd: string;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    _resetBuiltinSkillsCacheForTests();
    // We need saveSkillHandler imported, but it doesn't exist yet (Task 8
    // creates it). For now the import will fail; the test file will
    // compile only after Task 8 adds the export.
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (savedSkillsCwd) fs.rmSync(savedSkillsCwd, { recursive: true, force: true });
    if (originalCwd) process.chdir(originalCwd);
    _resetBuiltinSkillsCacheForTests();
  });

  // PLACEHOLDER — the full describe block is filled in by Task 8 because
  // the tests need saveSkillHandler to be importable. Task 7 is split
  // from Task 8 conceptually (write failing tests, then implementation)
  // but in practice the import-error red phase is the same regardless
  // of when we write the tests. Task 8 will both register the handler
  // AND complete this describe block content in one Edit.
});
```

This placeholder is intentional: the save_skill describe block depends on `saveSkillHandler` being importable. Task 8 will add the import to the test file AND extend this describe block in a single Edit. The reason for the split: keep "what changes in src/" and "what changes in test/" as separate atomic edits for review clarity.

- [ ] **Step 3: Run the tests — expect compile error**

```bash
bun run test -- src/ipc/handlers/skills.test.ts
```

Expected: existing skill_search + skill_invoked tests PASS. The save_skill describe block is empty so no tests fail; the file still compiles.

### Task 8: Implement `saveSkillHandler` in skills.ts AND fill in the save_skill tests

**Files:**
- Modify: `src/ipc/handlers/skills.ts` (append handler after `skillInvokedHandler`)
- Modify: `src/ipc/handlers/skills.test.ts` (fill in save_skill describe block + update imports)

- [ ] **Step 1: Append `saveSkillHandler` to skills.ts**

Use the Edit tool. Find the closing `};` of `skillInvokedHandler` (the last export in the file). Append after it:

```typescript

/**
 * save_skill — write a global skill to container/skills/{name}/SKILL.md.
 * Main-only. Migrated from src/ipc.ts:1107-1199 (handleSaveSkillIpc).
 *
 * Validation lives in execute() (NOT parse() or authorize()) so the agent
 * sees the 4 actionable error messages verbatim from legacy. If validation
 * ran in parse(), the dispatcher's default-payload would synthesize
 * `{success:false, message:'execution bailed'}` and the agent would lose
 * the actionable text. See spec Risks for details (R1 Critical 2).
 */
interface SaveSkillInput {
  skillName: string | undefined;
  skillContent: string | undefined;
}

export const saveSkillHandler: IpcHandler<
  SaveSkillInput,
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

  execute(input, ctx) {
    if (!input.skillName || !input.skillContent) {
      return {
        executed: true,
        result: {
          success: false,
          message: 'Missing required parameters: skillName and skillContent',
        },
      };
    }

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
      logger.info(
        { skillName: input.skillName, sourceGroup: ctx.sourceGroup, requestId: ctx.requestId },
        'Container skill saved permanently via IPC',
      );
      return {
        executed: true,
        result: {
          success: true,
          message: `Skill "${input.skillName}" saved permanently.`,
        },
      };
    } catch (err) {
      logger.error(
        { err, skillName: input.skillName, sourceGroup: ctx.sourceGroup },
        'save_skill IPC error',
      );
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

- [ ] **Step 2: Register `saveSkillHandler` in index.ts**

Use the Edit tool. Find:

```typescript
import { skillSearchHandler, skillInvokedHandler } from './skills.js';
```

Replace with:

```typescript
import {
  skillSearchHandler,
  skillInvokedHandler,
  saveSkillHandler,
} from './skills.js';
```

Find:

```typescript
  registerIpcHandler(skillInvokedHandler);
```

Replace with:

```typescript
  registerIpcHandler(skillInvokedHandler);
  registerIpcHandler(saveSkillHandler);
```

**Caveat**: the legacy `handleSaveSkillIpc` branch in `src/ipc.ts:1008-1022` ALSO handles `save_skill`. After this step, the dispatcher's registry handles `save_skill` FIRST (returns `{handled: true}`), so the legacy branch becomes unreachable. The legacy code remains until Commit 3 (Task 11) but is dead code from this point forward. Verify by running tests below.

- [ ] **Step 3: Fill in the save_skill describe block in skills.test.ts**

Use the Edit tool. Find the existing placeholder block:

```typescript
describe('save_skill handler', () => {
```

Through to its closing `});` (the placeholder block from Task 7). Replace the ENTIRE describe block (placeholder + closing) with:

```typescript
describe('save_skill handler', () => {
  const SOURCE_GROUP = 'telegram_skilltest';
  let dataDir: string;
  let deps: IpcDeps;
  let originalCwd: string;
  let cwdTmp: string;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    _resetBuiltinSkillsCacheForTests();
    registerIpcHandler(saveSkillHandler);

    setRegisteredGroup('tg:skilltest1', {
      name: 'SkillTest',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    deps = {
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-skill-test-'));

    // Swap cwd to a tmpdir so save_skill writes land under tmp/container/skills/
    // instead of the project's container/skills/. _resetBuiltinSkillsCache
    // ensures we re-scan the (empty) tmp container/skills/ dir.
    cwdTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'save-skill-cwd-'));
    fs.mkdirSync(path.join(cwdTmp, 'container', 'skills'), { recursive: true });
    // Seed one builtin into the tmp container/skills/ so the builtin-overwrite
    // test has a known target.
    fs.mkdirSync(path.join(cwdTmp, 'container', 'skills', 'agent-browser'), {
      recursive: true,
    });
    originalCwd = process.cwd();
    process.chdir(cwdTmp);
    _resetBuiltinSkillsCacheForTests();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cwdTmp, { recursive: true, force: true });
    _resetBuiltinSkillsCacheForTests();
  });

  const dispatch = async (
    data: Record<string, unknown>,
    compoundSource = SOURCE_GROUP,
    isMain = true,
  ) => {
    const ctx = buildContext(compoundSource, isMain, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const readResult = (sourceGroup: string, requestId: string) => {
    const file = path.join(
      dataDir,
      'ipc',
      sourceGroup,
      'skill_results',
      `${requestId}.json`,
    );
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  };

  it('1. parse returns null for non-object input', () => {
    expect(saveSkillHandler.parse(null)).toBeNull();
    expect(saveSkillHandler.parse(42)).toBeNull();
  });

  it('2. parse extracts skillName + skillContent + coerces wrong types to undefined', () => {
    expect(
      saveSkillHandler.parse({ skillName: 'foo', skillContent: 'body' }),
    ).toEqual({ skillName: 'foo', skillContent: 'body' });
    expect(saveSkillHandler.parse({ skillName: 42, skillContent: true })).toEqual({
      skillName: undefined,
      skillContent: undefined,
    });
  });

  it('3. authorize returns null for non-main caller', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir); // isMain=false
    const auth = saveSkillHandler.authorize(
      { skillName: 'foo', skillContent: 'body' },
      ctx,
    );
    expect(auth).toBeNull();
  });

  it('4. authorize returns non-null with skipGate:true for main caller', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir); // isMain=true
    const auth = saveSkillHandler.authorize(
      { skillName: 'foo', skillContent: 'body' },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBe(true);
  });

  it('5. execute missing skillName or skillContent returns Missing required parameters', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const r1 = saveSkillHandler.execute(
      { skillName: undefined, skillContent: 'body' },
      ctx,
    );
    expect(r1).toEqual({
      executed: true,
      result: {
        success: false,
        message: 'Missing required parameters: skillName and skillContent',
      },
    });
    const r2 = saveSkillHandler.execute(
      { skillName: 'foo', skillContent: undefined },
      ctx,
    );
    expect(r2).toEqual({
      executed: true,
      result: {
        success: false,
        message: 'Missing required parameters: skillName and skillContent',
      },
    });
  });

  it('6. execute invalid skill name returns exact validation message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const r = saveSkillHandler.execute(
      { skillName: 'BAD-NAME', skillContent: 'body' },
      ctx,
    );
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Invalid skill name. Use lowercase letters, numbers, and hyphens (2-64 chars).',
      },
    });
  });

  it('7. execute content over 64 KB cap returns exact size message (multibyte counts as bytes)', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    // 16385 × 4-byte emoji ≈ 65540 bytes — crosses the 65536 cap.
    const bigContent = '\u{1F600}'.repeat(16385);
    const r = saveSkillHandler.execute(
      { skillName: 'foo', skillContent: bigContent },
      ctx,
    );
    const expectedBytes = Buffer.byteLength(bigContent, 'utf-8');
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message: `Skill content (${expectedBytes} bytes) exceeds the ${64 * 1024}-byte cap.`,
      },
    });
  });

  it('8. execute builtin overwrite attempt returns exact builtin message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    // 'agent-browser' was seeded into cwdTmp/container/skills/ in beforeEach.
    const r = saveSkillHandler.execute(
      { skillName: 'agent-browser', skillContent: 'body' },
      ctx,
    );
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message: 'Cannot overwrite built-in skill "agent-browser".',
      },
    });
  });

  it('9. execute frontmatter declares Bash returns exact Bash-rejection message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const bashContent = '---\nname: foo\nallowed-tools: Bash\n---\nbody';
    const r = saveSkillHandler.execute(
      { skillName: 'foo', skillContent: bashContent },
      ctx,
    );
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Skill frontmatter declares allowed-tools: Bash. Bash-using skills must be vetted and added to the operator-managed allowlist, not persisted via save_skill.',
      },
    });
  });

  it('10. execute happy path writes container/skills/<name>/SKILL.md AND returns success', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const r = saveSkillHandler.execute(
      { skillName: 'my-skill', skillContent: '---\nname: my-skill\n---\nbody' },
      ctx,
    );
    expect(r).toEqual({
      executed: true,
      result: { success: true, message: 'Skill "my-skill" saved permanently.' },
    });
    const file = path.join(cwdTmp, 'container', 'skills', 'my-skill', 'SKILL.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('---\nname: my-skill\n---\nbody');
  });

  it('11. integration: agent main caller writes SKILL.md, no audit row, no pending_actions (preserve-bypass)', async () => {
    const agentName = `test-save-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  save_skill: draft\n',
    );

    try {
      await dispatch(
        {
          type: 'save_skill',
          requestId: 'req-bypass',
          skillName: 'preserve-bypass-test',
          skillContent: '---\nname: preserve-bypass-test\n---\nbody',
        },
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );

      const file = path.join(
        cwdTmp,
        'container',
        'skills',
        'preserve-bypass-test',
        'SKILL.md',
      );
      expect(fs.existsSync(file)).toBe(true);

      // ZERO agent_actions rows — preserve-bypass.
      const actionRows = getDb()
        .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
        .all(agentName);
      expect(actionRows).toHaveLength(0);

      // ZERO pending_actions rows — draft policy was NOT honored (bypassed).
      const pendingRows = getDb()
        .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
        .all(agentName);
      expect(pendingRows).toHaveLength(0);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('12. integration: non-main dispatch silently blocks — skill_results/ empty, no file written', async () => {
    await dispatch(
      {
        type: 'save_skill',
        requestId: 'req-nonmain',
        skillName: 'should-not-save',
        skillContent: 'body',
      },
      SOURCE_GROUP,
      false, // isMain=false
    );

    // skill_results/ either does not exist or is empty for non-main.
    const skillResultsDir = path.join(dataDir, 'ipc', SOURCE_GROUP, 'skill_results');
    const entries = fs.existsSync(skillResultsDir)
      ? fs.readdirSync(skillResultsDir)
      : [];
    expect(entries).toEqual([]);

    // container/skills/should-not-save/ does NOT exist.
    expect(
      fs.existsSync(path.join(cwdTmp, 'container', 'skills', 'should-not-save')),
    ).toBe(false);
  });
});
```

- [ ] **Step 4: Run typecheck + tests**

```bash
bun run typecheck
bun run test -- src/ipc/handlers/skills.test.ts
```

Expected: 12 + 8 + 8 = 28 tests pass (save_skill + skill_search + skill_invoked).

- [ ] **Step 5: Run full IPC sweep**

```bash
bun run test -- src/ipc/
```

Expected: All `src/ipc/**/*.test.ts` PASS. Some existing tests in `src/ipc.test.ts` may exercise `handleSaveSkillIpc` directly — verify:

```bash
grep -n "handleSaveSkillIpc" src/ipc.test.ts
```

If any exist, note them for Task 11 (they'll need deletion/rewrite when the legacy function is stripped). DO NOT update src/ipc.test.ts in this commit — Task 11 owns that.

### Task 9: Implement `crystallizeSkillHandler` AND its test block

**Files:**
- Modify: `src/ipc/handlers/skills.ts` (append handler after `saveSkillHandler`)
- Modify: `src/ipc/handlers/skills.test.ts` (append crystallize_skill describe + import)
- Modify: `src/ipc/handlers/index.ts` (import + register)

- [ ] **Step 1: Append `crystallizeSkillHandler` to skills.ts**

Use the Edit tool. Find the closing `};` of `saveSkillHandler`. Append after it:

```typescript

/**
 * crystallize_skill — write a "reusable recipe" skill to
 * data/agents/{agent}/skills/crystallized/{name}/SKILL.md. Main-only.
 * Migrated from src/ipc.ts:1218-1328 (handleCrystallizeSkillIpc).
 *
 * Validation lives in execute() per the same R1 Critical 2 reasoning as
 * saveSkillHandler. agentsRoot env-gate preserved (R2 Critical 2).
 */
interface CrystallizeSkillInput {
  agent: string | undefined;
  name: string | undefined;
  description: string | undefined;
  source_task: string | undefined;
  body: string | undefined;
  confidence: number;
  agentsRoot: string | undefined;
}

export const crystallizeSkillHandler: IpcHandler<
  CrystallizeSkillInput,
  { executed: true; result: { success: boolean; message: string } }
> = {
  type: 'crystallize_skill',
  responseKind: 'result',
  resultsDirName: 'skill_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      agent: typeof r.agent === 'string' ? r.agent : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
      source_task: typeof r.source_task === 'string' ? r.source_task : undefined,
      body: typeof r.body === 'string' ? r.body : undefined,
      confidence: typeof r.confidence === 'number' ? r.confidence : NaN,
      agentsRoot: typeof r.agentsRoot === 'string' ? r.agentsRoot : undefined,
    };
  },

  authorize(_input, ctx) {
    // Preserve legacy non-main block at ipc.ts:1028-1036.
    // R2 Critical 1 caught the brainstorm's false "no main check" claim.
    if (!ctx.isMain) return null;
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'crystallize_skill' },
      skipGate: true,
    };
  },

  execute(input, ctx) {
    const agentRe = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    const skillNameRe = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
    if (
      !input.agent ||
      !agentRe.test(input.agent) ||
      !input.name ||
      !skillNameRe.test(input.name) ||
      !input.description ||
      !input.body ||
      !input.source_task ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 1 ||
      input.confidence > 10
    ) {
      logger.warn(
        {
          agent: input.agent,
          name: input.name,
          sourceGroup: ctx.sourceGroup,
          confidence: input.confidence,
        },
        'crystallize_skill IPC rejected: invalid payload',
      );
      return {
        executed: true,
        result: { success: false, message: 'Invalid crystallize_skill payload.' },
      };
    }

    // Env-gate the agentsRoot test seam. DO NOT remove.
    const isTestEnv =
      process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
    const agentsRoot =
      isTestEnv && typeof input.agentsRoot === 'string'
        ? input.agentsRoot
        : AGENTS_DIR;

    try {
      const crystallizedDir = path.join(
        agentsRoot,
        input.agent,
        'skills',
        'crystallized',
      );
      const skillDir = path.join(crystallizedDir, input.name);
      fs.mkdirSync(skillDir, { recursive: true });

      const nowIso = new Date().toISOString();
      const descYaml = JSON.stringify(input.description);
      const taskYaml = JSON.stringify(input.source_task);
      const frontmatter = [
        '---',
        `name: ${input.name}`,
        `description: ${descYaml}`,
        `crystallized_at: ${nowIso}`,
        `source_task: ${taskYaml}`,
        `confidence: ${input.confidence}`,
        `invocation_count: 0`,
        '---',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), frontmatter + input.body);

      const logLine =
        JSON.stringify({
          ts: nowIso,
          agent: input.agent,
          name: input.name,
          source_task: input.source_task,
          confidence: input.confidence,
        }) + '\n';
      fs.appendFileSync(path.join(crystallizedDir, 'log.jsonl'), logLine);

      logger.info(
        {
          agent: input.agent,
          name: input.name,
          confidence: input.confidence,
          sourceGroup: ctx.sourceGroup,
          requestId: ctx.requestId,
        },
        'Crystallized skill saved',
      );
      return {
        executed: true,
        result: {
          success: true,
          message: `Crystallized skill "${input.name}" saved for ${input.agent}.`,
        },
      };
    } catch (err) {
      logger.error(
        { err, agent: input.agent, name: input.name },
        'crystallize_skill IPC error',
      );
      return {
        executed: true,
        result: {
          success: false,
          message: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  },
};
```

- [ ] **Step 2: Register in index.ts**

Use the Edit tool. Find:

```typescript
import {
  skillSearchHandler,
  skillInvokedHandler,
  saveSkillHandler,
} from './skills.js';
```

Replace with:

```typescript
import {
  skillSearchHandler,
  skillInvokedHandler,
  saveSkillHandler,
  crystallizeSkillHandler,
} from './skills.js';
```

Find:

```typescript
  registerIpcHandler(saveSkillHandler);
```

Replace with:

```typescript
  registerIpcHandler(saveSkillHandler);
  registerIpcHandler(crystallizeSkillHandler);
```

- [ ] **Step 3: Append the crystallize_skill describe block to skills.test.ts**

Use the Edit tool. First update the import to include `crystallizeSkillHandler`:

Find:

```typescript
import {
  skillSearchHandler,
  skillInvokedHandler,
  _resetBuiltinSkillsCacheForTests,
} from './skills.js';
```

Replace with:

```typescript
import {
  skillSearchHandler,
  skillInvokedHandler,
  saveSkillHandler,
  crystallizeSkillHandler,
  _resetBuiltinSkillsCacheForTests,
} from './skills.js';
```

(Note: `saveSkillHandler` may already be in the import if Task 8 added it — if so, just add `crystallizeSkillHandler`.)

Then append after the closing `});` of the `save_skill handler` describe block:

```typescript

/**
 * crystallize_skill handler tests. Migrated from src/ipc.ts:1218-1328
 * (handleCrystallizeSkillIpc) at git HEAD prior to Batch 2G.
 *
 * Pins:
 *  - Both R2 Critical 1 (non-main blocked) + R1 Medium 1 (verified)
 *  - log.jsonl shape pinned literally (R3 H4)
 *  - agentsRoot env-gate positive AND negative (R3 H6 + R2 Critical 2)
 *  - Path-traversal block via agent regex
 */
describe('crystallize_skill handler', () => {
  const SOURCE_GROUP = 'telegram_skilltest';
  let dataDir: string;
  let deps: IpcDeps;
  let agentsTmpRoot: string;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(crystallizeSkillHandler);

    setRegisteredGroup('tg:skilltest1', {
      name: 'SkillTest',
      folder: SOURCE_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    deps = {
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crystallize-test-'));
    agentsTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crystallize-agents-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentsTmpRoot, { recursive: true, force: true });
  });

  const dispatch = async (
    data: Record<string, unknown>,
    compoundSource = SOURCE_GROUP,
    isMain = true,
  ) => {
    const ctx = buildContext(compoundSource, isMain, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const validInput = (over: Partial<Record<string, unknown>> = {}) => ({
    type: 'crystallize_skill',
    requestId: 'req-crystal',
    agent: 'test-agent-1',
    name: 'test-skill-1',
    description: 'a test skill',
    source_task: 'the user wanted X',
    body: '## Steps\n1. do thing\n',
    confidence: 7,
    agentsRoot: agentsTmpRoot,
    ...over,
  });

  it('13. parse returns null for non-object; otherwise extracts all 7 fields', () => {
    expect(crystallizeSkillHandler.parse(null)).toBeNull();
    expect(
      crystallizeSkillHandler.parse({
        agent: 'a',
        name: 'b',
        description: 'd',
        source_task: 's',
        body: 'B',
        confidence: 5,
        agentsRoot: '/tmp/x',
      }),
    ).toEqual({
      agent: 'a',
      name: 'b',
      description: 'd',
      source_task: 's',
      body: 'B',
      confidence: 5,
      agentsRoot: '/tmp/x',
    });
  });

  it('14. authorize returns null for non-main caller (R2 Critical 1 preserves legacy block)', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = crystallizeSkillHandler.authorize(
      validInput() as unknown as CrystallizeSkillInputT,
      ctx,
    );
    expect(auth).toBeNull();
  });

  it('15. authorize returns non-null with skipGate:true for main caller', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const auth = crystallizeSkillHandler.authorize(
      validInput() as unknown as CrystallizeSkillInputT,
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBe(true);
  });

  it('16. execute invalid payload returns exact failure message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const bad = {
      agent: 'BAD UPPER',
      name: 'skill1',
      description: 'd',
      source_task: 's',
      body: 'b',
      confidence: 5,
      agentsRoot: agentsTmpRoot,
    };
    const r = crystallizeSkillHandler.execute(bad as unknown as CrystallizeSkillInputT, ctx);
    expect(r).toEqual({
      executed: true,
      result: { success: false, message: 'Invalid crystallize_skill payload.' },
    });
  });

  it('17. execute happy path writes SKILL.md AND appends log.jsonl with literal key set', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const input = {
      agent: 'agent1',
      name: 'skill1',
      description: 'desc',
      source_task: 'task',
      body: '## Steps\n',
      confidence: 8,
      agentsRoot: agentsTmpRoot,
    };
    const r = crystallizeSkillHandler.execute(input as unknown as CrystallizeSkillInputT, ctx);
    expect(r).toMatchObject({
      executed: true,
      result: { success: true, message: 'Crystallized skill "skill1" saved for agent1.' },
    });

    const file = path.join(
      agentsTmpRoot,
      'agent1',
      'skills',
      'crystallized',
      'skill1',
      'SKILL.md',
    );
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('name: skill1');
    expect(content).toContain('description: "desc"');
    expect(content).toContain('source_task: "task"');
    expect(content).toContain('confidence: 8');
    expect(content).toContain('invocation_count: 0');

    const logFile = path.join(
      agentsTmpRoot,
      'agent1',
      'skills',
      'crystallized',
      'log.jsonl',
    );
    expect(fs.existsSync(logFile)).toBe(true);
    const line = fs.readFileSync(logFile, 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed).sort()).toEqual([
      'agent',
      'confidence',
      'name',
      'source_task',
      'ts',
    ]);
  });

  it('18. agentsRoot positive: vitest env honors override → writes land in tmpdir', () => {
    expect(process.env.VITEST === 'true' || process.env.NODE_ENV === 'test').toBe(true);
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    crystallizeSkillHandler.execute(
      {
        agent: 'agent-pos',
        name: 'skill-pos',
        description: 'd',
        source_task: 's',
        body: 'b',
        confidence: 5,
        agentsRoot: agentsTmpRoot,
      } as unknown as CrystallizeSkillInputT,
      ctx,
    );
    expect(
      fs.existsSync(
        path.join(agentsTmpRoot, 'agent-pos', 'skills', 'crystallized', 'skill-pos', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('19. agentsRoot negative: env-gate refuses override when neither VITEST nor NODE_ENV=test', () => {
    const origVitest = process.env.VITEST;
    const origNodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
      // Use a tmp tmp dir different from agentsTmpRoot — verify nothing
      // ever writes there.
      const denyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crystallize-deny-'));
      try {
        crystallizeSkillHandler.execute(
          {
            agent: 'agent-neg',
            name: 'skill-neg',
            description: 'd',
            source_task: 's',
            body: 'b',
            confidence: 5,
            agentsRoot: denyTmp,
          } as unknown as CrystallizeSkillInputT,
          ctx,
        );
        // Override was refused — denyTmp must stay empty.
        expect(fs.readdirSync(denyTmp)).toEqual([]);
      } finally {
        fs.rmSync(denyTmp, { recursive: true, force: true });
      }
    } finally {
      if (origVitest !== undefined) process.env.VITEST = origVitest;
      else delete process.env.VITEST;
      if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
      else delete process.env.NODE_ENV;
    }
  });

  it('20. integration: agent main caller writes SKILL.md, no audit row, no pending_actions', async () => {
    const agentName = `test-crystal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });

    try {
      await dispatch(
        validInput({ agent: 'crystal-target' }),
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );

      const file = path.join(
        agentsTmpRoot,
        'crystal-target',
        'skills',
        'crystallized',
        'test-skill-1',
        'SKILL.md',
      );
      expect(fs.existsSync(file)).toBe(true);

      const actionRows = getDb()
        .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
        .all(agentName);
      expect(actionRows).toHaveLength(0);

      const pendingRows = getDb()
        .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
        .all(agentName);
      expect(pendingRows).toHaveLength(0);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('21. integration: non-main dispatch silently blocks, no SKILL.md written, no result file', async () => {
    await dispatch(validInput({ agent: 'crystal-target-nonmain' }), SOURCE_GROUP, false);

    const skillResultsDir = path.join(dataDir, 'ipc', SOURCE_GROUP, 'skill_results');
    const entries = fs.existsSync(skillResultsDir)
      ? fs.readdirSync(skillResultsDir)
      : [];
    expect(entries).toEqual([]);

    expect(
      fs.existsSync(path.join(agentsTmpRoot, 'crystal-target-nonmain')),
    ).toBe(false);
  });

  it('22. path-traversal: agent regex rejects "../etc" → invalid payload', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const r = crystallizeSkillHandler.execute(
      {
        agent: '../etc',
        name: 'skill1',
        description: 'd',
        source_task: 's',
        body: 'b',
        confidence: 5,
        agentsRoot: agentsTmpRoot,
      } as unknown as CrystallizeSkillInputT,
      ctx,
    );
    expect(r).toEqual({
      executed: true,
      result: { success: false, message: 'Invalid crystallize_skill payload.' },
    });
    // Nothing was written outside agentsTmpRoot.
    expect(fs.existsSync(path.join(agentsTmpRoot, '..', 'etc'))).toBe(false);
  });
});

// Type alias for the tests' input casts. The handler's input interface is
// not exported, so we declare a local alias matching the spec/shape.
type CrystallizeSkillInputT = {
  agent: string | undefined;
  name: string | undefined;
  description: string | undefined;
  source_task: string | undefined;
  body: string | undefined;
  confidence: number;
  agentsRoot: string | undefined;
};
```

- [ ] **Step 4: Append the SKIP_GATE_ALLOWLIST membership tests (Section E)**

Use the Edit tool. Find the end of the file (after the closing `});` of the last describe). Append:

```typescript

/**
 * SKIP_GATE_ALLOWLIST membership regression pins (spec Section E,
 * tests 39-41 — R3 Critical 1).
 *
 * These tests are the mutation guards for the preserve-bypass policy.
 * Dropping any of these three handlers from the allowlist would silently
 * change behavior: writes would either be staged in pending_actions or
 * write denied_contract_violation audit rows. Each assertion makes that
 * regression loud at test-time.
 */
describe('skill_* SKIP_GATE_ALLOWLIST membership', () => {
  it('39. save_skill is on SKIP_GATE_ALLOWLIST (preserve-bypass)', () => {
    expect([...SKIP_GATE_ALLOWLIST]).toContain('save_skill');
  });

  it('40. crystallize_skill is on SKIP_GATE_ALLOWLIST (preserve-bypass)', () => {
    expect([...SKIP_GATE_ALLOWLIST]).toContain('crystallize_skill');
  });

  it('41. skill_invoked is on SKIP_GATE_ALLOWLIST (skipGate is load-bearing per R1 High 2)', () => {
    expect([...SKIP_GATE_ALLOWLIST]).toContain('skill_invoked');
  });
});
```

- [ ] **Step 5: Run typecheck + tests**

```bash
bun run typecheck
bun run test -- src/ipc/handlers/skills.test.ts
```

Expected: 41 tests pass.

- [ ] **Step 6: Run full IPC sweep**

```bash
bun run test -- src/ipc/
```

Expected: All `src/ipc/**/*.test.ts` PASS.

### Task 10: Commit 2 — `save_skill` + `crystallize_skill` migration

**Files:**
- Stage: `src/ipc/handler.ts`, `src/ipc/handlers/skills.ts`, `src/ipc/handlers/skills.test.ts`, `src/ipc/handlers/index.ts`

- [ ] **Step 1: Verify status**

```bash
rtk git status
```

- [ ] **Step 2: Stage explicitly**

```bash
rtk git add src/ipc/handler.ts src/ipc/handlers/skills.ts src/ipc/handlers/skills.test.ts src/ipc/handlers/index.ts
```

- [ ] **Step 3: Commit**

```bash
rtk git commit -m "$(cat <<'EOF'
refactor(ipc): migrate save_skill + crystallize_skill, preserve bypass (Batch 2G part 2)

Lifts handleSaveSkillIpc and handleCrystallizeSkillIpc out of the
src/ipc.ts if-ladder. Both writes go on SKIP_GATE_ALLOWLIST to preserve
legacy bypass-trust behavior — the 9 dormant save_skill: draft entries
on disk stay dormant by design. Activating them is a future explicit
decision tagged in the allowlist TODO comment.

Both handlers block non-main callers (R2 Critical 1 + R1 Medium 1 —
independently verified that crystallize_skill DOES have a legacy
non-main block at ipc.ts:1028-1036, contrary to the original brainstorm
claim of "no main check").

Validation logic lives in execute() rather than parse() or authorize()
(R1 Critical 2) so the 4 user-facing save_skill rejection messages
survive verbatim:
  - 'Invalid skill name. Use lowercase letters, numbers, and hyphens (2-64 chars).'
  - 'Skill content (N bytes) exceeds the 65536-byte cap.'
  - 'Cannot overwrite built-in skill "X".'
  - 'Skill frontmatter declares allowed-tools: Bash...'

crystallize_skill preserves the agentsRoot test seam (R2 Critical 2):
parse() accepts agentsRoot from input; execute() applies the
isTestEnv env-gate before honoring the override. Production protection
against compromised-container path-redirection preserved.

Tests (25 new + 3 allowlist pins = 28):
- save_skill: 12 tests (5 unit, 5 execute-level message pins inc.
  multibyte byte-cap, 2 integration including preserve-bypass
  enforcement)
- crystallize_skill: 10 tests (3 unit, 4 execute including agentsRoot
  positive + negative env-gate, 3 integration inc. path-traversal pin)
- Section E: 3 SKIP_GATE_ALLOWLIST membership pins (save_skill,
  crystallize_skill, skill_invoked) — the mutation guards for the
  preserve-bypass policy

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify**

```bash
rtk git log -2 --oneline
```

Expected: 2 lines — Commit 1 and Commit 2 of Batch 2G.

---

## Commit 3 — Strip legacy + relocate helpers

### Task 11: Strip legacy code from `src/ipc.ts`

**Files:**
- Modify: `src/ipc.ts` — delete 4 dispatcher branches + 5 handler functions + writeSkillResult + 3 helpers + update comment block + strip orphan imports
- Possibly modify: `src/ipc.test.ts` — if any test references `handleSaveSkillIpc`, `handleCrystallizeSkillIpc`, `handleSkillSearchIpc`, `handleSkillInvokedIpc`, or `_resetBuiltinSkillsCacheForTests` from src/ipc.ts

- [ ] **Step 1: Locate all the deletion sites**

```bash
grep -n "handleSaveSkillIpc\|handleCrystallizeSkillIpc\|handleSkillSearchIpc\|handleSkillInvokedIpc\|writeSkillResult\|MAX_SKILL_CONTENT_BYTES\|getBuiltinSkillNames\|_resetBuiltinSkillsCacheForTests\|data\.type === 'save_skill'\|data\.type === 'crystallize_skill'\|data\.type === 'skill_search'\|data\.type === 'skill_invoked'" src/ipc.ts | head -30
```

You should see:
- 4 if-ladder dispatcher branches (around lines 1008-1052)
- `MAX_SKILL_CONTENT_BYTES = 64 * 1024` (~line 1066)
- `getBuiltinSkillNames` + `builtinSkillsCache` (~lines 1074-1096)
- `_resetBuiltinSkillsCacheForTests` (~line 1099)
- `handleSaveSkillIpc` (~lines 1107-1199)
- `handleCrystallizeSkillIpc` (~lines 1218-1328)
- `handleSkillInvokedIpc` (~lines 1336-1428)
- `writeSkillResult` (~lines 1430-1442)
- `handleSkillSearchIpc` (~lines 1444-1532)

Read each section to confirm exact line ranges:

```bash
sed -n '1004,1058p' src/ipc.ts
sed -n '1062,1102p' src/ipc.ts
sed -n '1105,1202p' src/ipc.ts
sed -n '1216,1330p' src/ipc.ts
sed -n '1334,1432p' src/ipc.ts
sed -n '1442,1535p' src/ipc.ts
```

- [ ] **Step 2: Update the inline comment block**

Use the Edit tool. Find the comment block (around lines 944-959) that lists the migrated clusters. Append a `skill_* migrated to src/ipc/handlers/skills.ts` line consistent with the existing slack_dm comment.

For example, find:

```typescript
      // slack_dm_read AND slack_dm migrated to src/ipc/handlers/slack.ts —
      // both dispatched via the IpcHandler registry above
      // (dispatchIpcAction). slack_dm uses postHocNotify: true (added in
      // Batch 2F.1) to fire a Telegram notify after the result file is
      // written.
```

Append immediately after:

```typescript
      // save_skill / crystallize_skill / skill_search / skill_invoked
      // migrated to src/ipc/handlers/skills.ts — all dispatched via the
      // IpcHandler registry above (dispatchIpcAction). All 4 use
      // skipGate: true (preserve-bypass per Batch 2G; trust.yaml has 9
      // dormant save_skill: draft entries that the gate-bypass keeps
      // inactive — future Batch 4 candidate).
```

- [ ] **Step 3: Delete the 4 if-ladder dispatcher branches**

Use the Edit tool to delete each of the 4 branches:

```typescript
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'save_skill'
      ) {
        if (!isMain) {
          logger.warn(
            { sourceGroup },
            'Non-main save_skill IPC attempt blocked',
          );
          handled = true;
        } else {
          handled = handleSaveSkillIpc(data, sourceGroup);
        }
      }
```

```typescript
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'crystallize_skill'
      ) {
        if (!isMain) {
          logger.warn(
            { sourceGroup },
            'Non-main crystallize_skill IPC attempt blocked',
          );
          handled = true;
        } else {
          handled = handleCrystallizeSkillIpc(data, sourceGroup);
        }
      }
```

```typescript
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'skill_search'
      ) {
        handled = await handleSkillSearchIpc(data, sourceGroup);
      }
```

```typescript
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'skill_invoked'
      ) {
        // Phase 2 telemetry — any group can emit, host writes to that
        // agent's own log. Path-traversal gated by handler regex.
        handled = handleSkillInvokedIpc(data, sourceGroup);
      }
```

Delete each by replacing with empty string. If your file shows slightly different formatting/wording (e.g. a comment moved), read the surrounding 5-10 lines before each Edit and use the exact `old_string` matching what's actually there.

- [ ] **Step 4: Delete the 5 handler functions + writeSkillResult**

Use the Edit tool. Delete each function block, top-to-bottom from line ~1107 through ~1532. Sample for `handleSaveSkillIpc`:

```typescript
function handleSaveSkillIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
): boolean {
  // ... ~90 lines of body ...
  return true;
}
```

Delete all of: `handleSaveSkillIpc`, `handleCrystallizeSkillIpc`, `handleSkillInvokedIpc`, `writeSkillResult`, `handleSkillSearchIpc`. Be careful NOT to delete adjacent unrelated functions (the function immediately above the skill block and the function immediately below).

- [ ] **Step 5: Delete `MAX_SKILL_CONTENT_BYTES`, `builtinSkillsCache`, `getBuiltinSkillNames`, `_resetBuiltinSkillsCacheForTests`**

Use the Edit tool. Delete the block of lines that includes:

```typescript
/**
 * Maximum size of a SKILL.md saved via save_skill IPC (64 KB). ...
 */
const MAX_SKILL_CONTENT_BYTES = 64 * 1024;

/**
 * Discover the active builtin skill names by listing container/skills/. ...
 */
let builtinSkillsCache: Set<string> | null = null;
function getBuiltinSkillNames(): Set<string> {
  // ... ~22 lines of body ...
}

/** @internal — for tests only. Forces re-scan on next getBuiltinSkillNames(). */
export function _resetBuiltinSkillsCacheForTests(): void {
  builtinSkillsCache = null;
}
```

Use the file's actual content to construct the exact `old_string`. Read the file lines first to confirm.

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected outcomes:
- `src/ipc.ts`: PASS — all deletions are self-contained.
- `src/ipc.test.ts`: MAY FAIL if it imports any of the deleted symbols. If so, the typecheck error message names the file and symbol. Proceed to Step 7.

- [ ] **Step 7: Update `src/ipc.test.ts` if needed**

Run:

```bash
grep -n "handleSaveSkillIpc\|handleCrystallizeSkillIpc\|handleSkillSearchIpc\|handleSkillInvokedIpc\|_resetBuiltinSkillsCacheForTests" src/ipc.test.ts | head
```

If the grep returns matches, those imports + any test bodies calling those functions need to be removed. There is NO equivalent "C13" describe block for skill_* (that was specific to slack_dm; this batch's spec verifies no equivalent block exists). BUT `_resetBuiltinSkillsCacheForTests` may be imported by existing save_skill / save_skill_e2e tests for the OLD code path. Verify and update:

- If `_resetBuiltinSkillsCacheForTests` is imported from `./ipc.js`: update the import to `from './ipc/handlers/skills.js'`.
- If `handleSaveSkillIpc` etc. are imported and called: delete the import + the test calls. If those tests are pinning behavior we've already moved to `skills.test.ts`, delete the whole test block.

Run grep again after updates to confirm zero matches.

- [ ] **Step 8: Strip orphan imports in `src/ipc.ts`**

After the deletions, some imports may be orphaned. Common candidates:

```bash
grep -n "import.*getBridgeToken\|import.*frontmatterDeclaresBash\|import.*AGENTS_DIR" src/ipc.ts
```

For each, check if it's still used:

```bash
grep -c "getBridgeToken\b" src/ipc.ts
grep -c "frontmatterDeclaresBash\b" src/ipc.ts
grep -c "AGENTS_DIR\b" src/ipc.ts
```

If the count is 1 (just the import line), the import is orphaned — remove it. If the count is >1, leave it.

- [ ] **Step 9: Final verification**

```bash
bun run typecheck
bun run test
bun run lint
```

All three must PASS (lint: zero errors, pre-existing warnings unchanged).

- [ ] **Step 10: Final grep checks (acceptance criteria)**

```bash
grep -nE "handleSaveSkillIpc|handleCrystallizeSkillIpc|handleSkillSearchIpc|handleSkillInvokedIpc|writeSkillResult" src/ipc.ts
grep -nE "data\\.type === '(save_skill|crystallize_skill|skill_search|skill_invoked)'" src/ipc.ts
grep -n "MAX_SKILL_CONTENT_BYTES\|getBuiltinSkillNames\|_resetBuiltinSkillsCacheForTests" src/ipc.ts
grep -rln "save_skill" data/agents/*/trust.yaml | wc -l
grep -n "skill_results" container/agent-runner/src/ipc-mcp-stdio.ts | head -3
```

Expected:
- First 3 commands: zero matches (legacy fully stripped).
- 4th: 9 (unchanged — dormant trust.yaml entries preserved).
- 5th: at least 1 match (container poller path unchanged).

### Task 12: Commit 3 — Strip legacy

**Files:**
- Stage: `src/ipc.ts`, possibly `src/ipc.test.ts`

- [ ] **Step 1: Stage**

```bash
rtk git add src/ipc.ts
# If you updated ipc.test.ts in Task 11 Step 7:
rtk git add src/ipc.test.ts
```

- [ ] **Step 2: Commit**

```bash
rtk git commit -m "$(cat <<'EOF'
refactor(ipc): strip legacy skill_* if-ladder (Batch 2G part 3)

Removes the 4 dispatcher branches, the 5 handler functions (handleSaveSkillIpc,
handleCrystallizeSkillIpc, handleSkillInvokedIpc, handleSkillSearchIpc,
writeSkillResult), and the 3 relocated helpers (MAX_SKILL_CONTENT_BYTES,
getBuiltinSkillNames, _resetBuiltinSkillsCacheForTests). Updates the inline
comment block to mark the skill_* cluster as migrated.

Closes the IPC migration arc. The src/ipc.ts if-ladder now contains only
the dynamic skill-loader branches (x_*, browser_*) which are NOT registry
candidates by design — they use dynamic import for optional skills.

Net deletion: ~425 LOC from src/ipc.ts. All 41 cluster tests + the full
test suite pass; trust.yaml dormancy (9 save_skill: draft entries)
preserved; container poller path (skill_results/) unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify final commit log**

```bash
rtk git log -3 --oneline
```

Expected: 3 lines — Commits 1, 2, 3 of Batch 2G.

---

## Acceptance verification (final gate)

Run after Commit 3 lands. Do NOT push — that is a user-initiated action.

- [ ] **Step 1: Full test sweep**

```bash
bun run test
```

Expected: PASS. Baseline + 41 new tests.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Expected: PASS (zero errors, pre-existing warnings unchanged).

- [ ] **Step 4: Spec AC #4 — trust.yaml preservation**

```bash
grep -rln "save_skill" data/agents/*/trust.yaml | wc -l
```

Expected: 9 (unchanged from pre-batch baseline).

- [ ] **Step 5: Spec AC #5/6/7 — legacy code stripped**

```bash
grep -nE "handleSaveSkillIpc|handleCrystallizeSkillIpc|handleSkillSearchIpc|handleSkillInvokedIpc|writeSkillResult" src/ipc.ts
grep -nE "data\\.type === '(save_skill|crystallize_skill|skill_search|skill_invoked)'" src/ipc.ts
grep -n "MAX_SKILL_CONTENT_BYTES\|getBuiltinSkillNames\|_resetBuiltinSkillsCacheForTests" src/ipc.ts
```

Expected: All three return zero matches.

- [ ] **Step 6: Spec AC #8 — handlers registered**

```bash
grep -nE "saveSkillHandler|crystallizeSkillHandler|skillSearchHandler|skillInvokedHandler" src/ipc/handlers/index.ts
```

Expected: 8 matches — 4 in the import statement + 4 in registration calls.

- [ ] **Step 7: Spec AC #9 — SKIP_GATE_ALLOWLIST size**

```bash
grep -cE "'save_skill'|'crystallize_skill'" src/ipc/handler.ts
```

Expected: 2 (both entries in the allowlist).

Tests 39-41 in `skills.test.ts` also verify this.

- [ ] **Step 8: Spec AC #10 — container poller path**

```bash
grep -n "skill_results" container/agent-runner/src/ipc-mcp-stdio.ts
```

Expected: at least 1 match (container poller still reads from `skill_results/`).

---

## Self-review checklist (post-write)

Spec coverage:
- Spec § Change 1 (skill_search + skill_invoked) → Tasks 1, 2, 3, 4, 5. ✅
- Spec § Change 2 (save_skill + crystallize_skill, allowlist) → Tasks 6, 7, 8, 9, 10. ✅
- Spec § Change 3 (strip legacy + relocate helpers) → Tasks 11, 12. ✅
- Spec § Test plan Section A (save_skill tests 1-12) → Task 8 Step 3. ✅
- Spec § Test plan Section B (crystallize tests 13-22) → Task 9 Step 3. ✅
- Spec § Test plan Section C (skill_search tests 23-30) → Task 3. ✅
- Spec § Test plan Section D (skill_invoked tests 31-38) → Task 4. ✅
- Spec § Test plan Section E (allowlist pins 39-41) → Task 9 Step 4. ✅
- Spec § Acceptance criteria 1-10 → Acceptance verification section. ✅
- Spec § Commit sequence → Tasks 5, 10, 12. ✅
- R1 Critical 2 (validation in execute) → Task 8 Step 1 (saveSkillHandler.execute) + Task 9 Step 1 (crystallizeSkillHandler.execute). ✅
- R2 Critical 1 (crystallize_skill non-main block) → Task 9 Step 1 (`if (!ctx.isMain) return null;` in authorize). ✅
- R2 Critical 2 (agentsRoot env-gate) → Task 1 Step 3 (skill_invoked.execute) + Task 9 Step 1 (crystallize.execute). ✅
- R3 Critical 1 (preserve-bypass enforcement tests) → Task 8 Step 3 test 11 + Task 9 Step 3 test 20 + Task 9 Step 4 tests 39-41. ✅
- R3 Critical 2 (non-main wire format pin) → Task 8 Step 3 test 12 + Task 9 Step 3 test 21. ✅
- R3 H3 (skill_invoked no-result-file correct shape) → Task 4 Step 2 test 38. ✅
- R3 H4 (usage.jsonl + log.jsonl key set pin) → Task 4 Step 2 test 36 + Task 9 Step 3 test 17. ✅
- R3 H5 (idempotency with fake timers) → Task 4 Step 2 test 37. ✅
- R3 H6 (agentsRoot positive AND negative) → Task 9 Step 3 tests 18 + 19. ✅
- R3 M7 (empty QMD response parametrized) → Task 3 Step 2 test 27 (it.each). ✅
- R3 M8 (multibyte byte-cap) → Task 8 Step 3 test 7. ✅
- R3 M9 (each save_skill failure pins message) → Task 8 Step 3 tests 5-9. ✅
- R3 L11 (skill_search timeout vs other-error) → Task 3 Step 2 tests 28 + 29. ✅

Placeholder scan: None. Every step has complete code or exact commands. The placeholder describe block in Task 7 is documented as deliberate scaffolding to be filled by Task 8.

Type consistency:
- `saveSkillHandler`, `crystallizeSkillHandler`, `skillSearchHandler`, `skillInvokedHandler` named identically across Tasks 1, 3, 4, 8, 9, 11.
- `_resetBuiltinSkillsCacheForTests` named identically in skills.ts + skills.test.ts + (deleted from) src/ipc.ts.
- `resultsDirName: 'skill_results'` matches the container poller path (verified in acceptance Step 8).
- `MAX_SKILL_CONTENT_BYTES` named identically (legacy + new location).
- Validation messages pinned EXACTLY in the spec + plan + tests + handler.

No gaps found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-ipc-batch-2g-skills-cluster.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, two-stage review per task (spec then code-quality). Good fit because the cluster has 4 distinct handlers and the validation-in-execute pattern is a non-obvious contract subtlety worth a second pair of eyes per implementation. Mirrors Batch 2F.1's execution mode which caught one orphan-variable bug at acceptance verification.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints. Faster end-to-end but loses the second-pair-of-eyes effect on the preserve-bypass enforcement and the agentsRoot env-gate tests.

Which approach?
