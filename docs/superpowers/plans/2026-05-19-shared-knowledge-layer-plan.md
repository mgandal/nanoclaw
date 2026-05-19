# Phase 1.2 — Shared Knowledge Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the partially-shipped Phase 1.2 of NanoClaw's shared knowledge layer by (a) adding a `confidence` field to KnowledgeEntry, (b) replacing the `knowledge_search` redirect-stub with a real `result`-kind IPC handler that calls QMD via HTTP MCP, and (c) firing a background `qmd update agent-knowledge` subprocess after each publish so findings become BM25-searchable within ~30 seconds (vs. 4-hour sync cycle).

**Architecture:** Two commits per spec §10. Commit 1 (`feat(knowledge): add confidence field + QMD update on publish`) extends `KnowledgeEntry` + the handler's local `Input` + `publishKnowledge()` frontmatter, adds an `execFile` background QMD update call, extends the MCP tool. Commit 2 (`feat(knowledge): real knowledge_search IPC handler`) adds a new `result`-kind handler, registers it, adds `'knowledge_search'` to `SKIP_GATE_ALLOWLIST`, rewrites the container MCP tool from a redirect stub to a real `waitForIpcResult` round-trip, adds 2 dispatcher-contract tests. The handler's `execute()` includes a CRITICAL `response.ok` check that `skill_search` lacks (round-1 amendment).

**Tech Stack:** TypeScript (strict mode), Vitest (testing — invoked via `bun run test`), bun:sqlite (DB-backed tests via `_initTestDatabase()`), `src/ipc/handlers/skills.ts` (the closest analogue handler — read this BEFORE implementing knowledge-search.ts), `container/agent-runner/src/ipc-mcp-stdio.ts` (container MCP tools), `getBridgeToken` from `src/bridge-auth.ts`.

**Spec:** `docs/superpowers/specs/2026-05-19-shared-knowledge-layer-design.md` (commit `13fa035d` round-1 amended). The round-1 amendments header documents 4 fixes from peer review that this plan implements:
- §4.2 Critical: `execute()` MUST include `if (!response.ok) throw` — `fetch` doesn't throw on non-2xx and `skill_search` lacks this check
- §4.1 Important: `confidence` MUST be added to BOTH `KnowledgeEntry` (in src/knowledge.ts) AND the handler's local `Input` interface (in src/ipc/handlers/knowledge-publish.ts) — they are structurally distinct types
- Citation fix: `skill_search` reference moved from `src/ipc.ts:1593-1614` (stale) to `src/ipc/handlers/skills.ts:96-117` (correct, post-Batch-2G)
- §3.5 Nit: `execFile` env override must include `HOME` in addition to `PATH` because launchd strips both

---

## Pre-flight: What Currently Exists

This is a PARTIALLY-SHIPPED feature. Before writing any code, understand exactly what's already there:

- `src/ipc/handlers/knowledge-publish.ts` — handler with `parse → authorize → execute`. Currently writes a file via `publishKnowledge()` and fires a bus message. **No `confidence`, no QMD update subprocess.**
- `src/knowledge.ts` — `publishKnowledge()` file writer. Frontmatter has `agent, topic, date, tags`. **No `confidence`.**
- `container/agent-runner/src/ipc-mcp-stdio.ts:1904-1937` — `knowledge_publish` MCP tool (Zod inputs: topic, finding, evidence, tags — NO confidence). Fire-and-forget. Works.
- `container/agent-runner/src/ipc-mcp-stdio.ts:1939-1966` — `knowledge_search` MCP tool. **REDIRECT STUB** that returns a text instruction telling the agent to call `mcp__qmd__query` directly. Never writes an IPC file, never polls for results.
- `src/ipc/handlers/skills.ts:64-167` — `skillSearchHandler` is the CLOSEST analogue for what we're building. Read it BEFORE writing the new handler. Key patterns to mirror: `IpcHandler<Input, { executed: true; result: {...} }>` typing, `responseKind: 'result'`, `resultsDirName: 'skill_results'`, the `fetch(localhost:8181/mcp, ...)` JSON-RPC body, AbortSignal.timeout.

---

## File Structure

**Created (1 file):**
- `src/ipc/handlers/knowledge-search.ts` — new `result`-kind handler. ~120 LOC.

**Modified (8 files):**
- `src/knowledge.ts` — add `confidence?: number` to `KnowledgeEntry`, add `confidence` field to YAML.stringify call. ~3 LOC delta.
- `src/ipc/handlers/knowledge-publish.ts` — add `confidence: number` to local `Input` interface, parse it from raw payload (default 5, clamp 1-10), add fire-and-forget `execFile` QMD update subprocess after `publishKnowledge` succeeds. ~30 LOC delta.
- `src/knowledge.test.ts` (existing) — extend with 2 tests for confidence in frontmatter (Section A).
- `src/ipc/handlers/knowledge-publish.test.ts` (CREATE if doesn't exist) — 7 tests for the publish handler extension (Section B).
- `src/ipc/handlers/knowledge-search.test.ts` (CREATE) — 15 tests for the new handler (Section C).
- `src/ipc/handler.ts:21-46` — add `'knowledge_search'` to `SKIP_GATE_ALLOWLIST`. ~3 LOC.
- `src/ipc/handlers/index.ts` — import + register `knowledgeSearchHandler` after `knowledgePublishHandler`. ~2 LOC.
- `src/ipc/handler-post-hoc-notify.test.ts` — append 2 dispatcher-contract tests for the new wire type's on/off allowlist behavior. Same pattern as the Phase 1.1 Test 7/8. ~80 LOC.
- `container/agent-runner/src/ipc-mcp-stdio.ts` — (a) extend `knowledge_publish` tool: add `confidence` Zod param, update description, pass through to IPC payload; (b) replace `knowledge_search` redirect stub with real round-trip via `waitForIpcResult(KNOWLEDGE_RESULTS_DIR, ...)`. ~70 LOC delta. Add `KNOWLEDGE_RESULTS_DIR` constant.

**Total: 24 new tests** (2 knowledge.test.ts + 7 publish-handler + 13 search-handler + 2 dispatcher = 24).

---

## Pre-flight

### Task 0: Read the spec, the analogue handler, and current state

- [ ] **Step 1: Read the round-1-amended spec header.**

Open `docs/superpowers/specs/2026-05-19-shared-knowledge-layer-design.md` and read the "Round-1 amendments" section at the top (right under the status header). The 4 amendments matter:
- §4.2 Critical `response.ok` check
- §4.1 Important `confidence` in TWO type sites
- Citation fix to `skill_search` at `src/ipc/handlers/skills.ts:96-117`
- §3.5 Nit `HOME` in execFile env

- [ ] **Step 2: Read the analogue handler.**

Open `src/ipc/handlers/skills.ts`. The `skillSearchHandler` at lines 64-167 is the structural template for the new `knowledgeSearchHandler`. Pay attention to:
- The `IpcHandler<SkillSearchInput, { executed: true; result: { success: boolean; message: string } }>` type
- `responseKind: 'result'` + `resultsDirName: 'skill_results'`
- `skipGate: true` ONLY in authorize() (no conditional yet — Phase 1.2 spec wants agent callers to gate, non-agent callers to skipGate)
- The fetch JSON-RPC body at lines 96-117 — **note that line 119 reads `response.json()` WITHOUT checking `response.ok`**. This is the bug we're NOT inheriting in the new handler.

- [ ] **Step 3: Read what's currently shipped for knowledge_publish.**

Read `src/ipc/handlers/knowledge-publish.ts` (~68 lines) and `src/knowledge.ts` (~50 lines). Note:
- The handler's local `Input` interface at lines 7-12 has `topic, finding, evidence, tags` — no confidence.
- `publishKnowledge()` writes YAML frontmatter with `agent, topic, date, tags` — no confidence.
- The handler's execute() awaits a dynamic import of `publishKnowledge`, then fires a bus message via `ctx.deps.messageBus.publish`.

- [ ] **Step 4: Read the current MCP stubs.**

`container/agent-runner/src/ipc-mcp-stdio.ts` lines 1904-1937 (publish — works) and 1939-1966 (search — redirect stub). Note the constants block at lines 820-824 where `KNOWLEDGE_RESULTS_DIR` will be added.

- [ ] **Step 5: Verify QMD binary path.**

Run: `which qmd`
Capture the output. This will go into the `QMD_BIN` constant in Task 2's edit to `knowledge-publish.ts`. If `qmd` is not at `/opt/homebrew/bin/qmd`, use the path that `which` returned.

- [ ] **Step 6: Run baseline test suite.**

Run: `bun run test 2>&1 | tail -5`
Capture the test count (e.g. "2406 passed"). The acceptance criterion is "baseline + 24 new = ~2430".

---

## Commit 1: Confidence Field + Background QMD Update

### Task 1: Add `confidence` to KnowledgeEntry and publishKnowledge frontmatter

**Files:**
- Modify: `src/knowledge.ts:6-13` (add `confidence?: number` to interface)
- Modify: `src/knowledge.ts:39-44` (add `confidence` to YAML.stringify call)
- Modify: `src/knowledge.test.ts` — extend with 2 tests in the existing publishKnowledge describe block

- [ ] **Step 1: Write the failing tests first.**

Locate the existing `describe('publishKnowledge', ...)` block in `src/knowledge.test.ts`. Append these tests inside that block (or in a new sibling describe — match the existing pattern):

```typescript
  it('writes confidence: 8 to frontmatter when entry has confidence: 8', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
    try {
      const filePath = publishKnowledge(
        { topic: 'test', finding: 'X', evidence: 'manual', tags: ['t'], confidence: 8 },
        'telegram_claire',
        dir,
      );
      const body = fs.readFileSync(filePath, 'utf-8');
      // Frontmatter is YAML between '---' markers
      const fmMatch = body.match(/^---\n([\s\S]+?)\n---/);
      expect(fmMatch).toBeTruthy();
      const fm = YAML.parse(fmMatch![1]) as { confidence?: number };
      expect(fm.confidence).toBe(8);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes confidence: 5 (default) to frontmatter when entry omits confidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
    try {
      const filePath = publishKnowledge(
        { topic: 'test', finding: 'X', evidence: 'manual', tags: ['t'] },
        'telegram_claire',
        dir,
      );
      const body = fs.readFileSync(filePath, 'utf-8');
      const fmMatch = body.match(/^---\n([\s\S]+?)\n---/);
      const fm = YAML.parse(fmMatch![1]) as { confidence?: number };
      expect(fm.confidence).toBe(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
```

Verify the test file's top-level imports already include `fs`, `path`, `os`, and `YAML`. If `YAML` is not imported, add `import YAML from 'yaml';` to the imports.

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun --bun vitest run src/knowledge.test.ts -t 'confidence' 2>&1 | tail -15`
Expected: FAIL. Test 1 fails because `KnowledgeEntry` does not have `confidence` (TypeScript error), or because frontmatter does not contain `confidence`. Test 2 similarly.

If the TypeScript error blocks compilation, that confirms the failing test — we don't get a runtime assertion failure because the test file doesn't compile. That's still TDD-red.

- [ ] **Step 3: Add `confidence?: number` to KnowledgeEntry.**

Use `Edit` on `src/knowledge.ts`. Find:

```typescript
export interface KnowledgeEntry {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
  /** Ignored — overwritten by verified sourceGroup. */
  agent?: string;
}
```

Replace with:

```typescript
export interface KnowledgeEntry {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
  /**
   * Self-assessed confidence 1-10. 1-3=weak/preliminary; 4-6=moderate;
   * 7-9=high/evidenced; 10=definitive. Defaults to 5 when undefined.
   */
  confidence?: number;
  /** Ignored — overwritten by verified sourceGroup. */
  agent?: string;
}
```

- [ ] **Step 4: Add `confidence` to the YAML frontmatter.**

Use `Edit` on `src/knowledge.ts`. Find the `YAML.stringify` call (around lines 39-44):

```typescript
  const frontmatter = YAML.stringify({
    agent: sourceGroup,
    topic: entry.topic,
    date,
    tags: entry.tags,
  }).trimEnd();
```

Replace with:

```typescript
  const frontmatter = YAML.stringify({
    agent: sourceGroup,
    topic: entry.topic,
    date,
    tags: entry.tags,
    // Default 5 when omitted so consumers can filter by confidence consistently
    // (downstream agents weight findings by this value when ranking results).
    confidence: entry.confidence ?? 5,
  }).trimEnd();
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `bun --bun vitest run src/knowledge.test.ts -t 'confidence' 2>&1 | tail -10`
Expected: PASS (2 tests).

- [ ] **Step 6: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

**DO NOT COMMIT** — Commit 1 lands as one atomic unit after Tasks 1-4.

### Task 2: Add `confidence` to handler Input + background QMD update

**Files:**
- Modify: `src/ipc/handlers/knowledge-publish.ts:7-12` (add confidence to local Input interface)
- Modify: `src/ipc/handlers/knowledge-publish.ts:20-33` (parse confidence with clamping)
- Modify: `src/ipc/handlers/knowledge-publish.ts:50-67` (add execFile background QMD update after publishKnowledge succeeds)
- Modify: `src/ipc/handlers/knowledge-publish.ts:40-46` (add confidence to payloadForStaging)

This is the round-1-amended Important #2: `confidence` must be added to the handler's local `Input` interface in addition to `KnowledgeEntry` (Task 1). They are structurally distinct types.

- [ ] **Step 1: Write the failing handler tests first.**

Create `src/ipc/handlers/knowledge-publish.test.ts` (if it doesn't already exist; if it does, append to the existing describe block):

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as childProcess from 'child_process';

import { knowledgePublishHandler } from './knowledge-publish.js';
import type { IpcHandlerContext } from '../handler.js';

function buildCtx(overrides: Partial<IpcHandlerContext> = {}): IpcHandlerContext {
  return {
    sourceGroup: 'telegram_claire',
    isMain: true,
    baseGroup: 'telegram_claire',
    agentName: 'claire',
    requestId: null,
    registeredGroups: {},
    deps: {
      messageBus: { publish: () => {} } as any,
    } as any,
    dataDir: '/tmp/test',
    ...overrides,
  };
}

describe('knowledgePublishHandler.parse with confidence', () => {
  it('extracts confidence: 7 from raw payload', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't', finding: 'f', evidence: 'e', tags: [], confidence: 7,
    });
    expect((result as any).confidence).toBe(7);
  });

  it('defaults confidence to 5 when field is missing', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't', finding: 'f', evidence: 'e', tags: [],
    });
    expect((result as any).confidence).toBe(5);
  });

  it('normalizes confidence: 0 to 5 (out-of-range)', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't', finding: 'f', evidence: 'e', tags: [], confidence: 0,
    });
    expect((result as any).confidence).toBe(5);
  });

  it('normalizes confidence: 11 to 5 (out-of-range)', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't', finding: 'f', evidence: 'e', tags: [], confidence: 11,
    });
    expect((result as any).confidence).toBe(5);
  });

  it('normalizes confidence: 7.5 to 5 (non-integer)', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't', finding: 'f', evidence: 'e', tags: [], confidence: 7.5,
    });
    expect((result as any).confidence).toBe(5);
  });
});

describe('knowledgePublishHandler.execute fires QMD update', () => {
  let tmpDir: string;
  let execFileSpy: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));
    execFileSpy = vi.spyOn(childProcess, 'execFile').mockImplementation(
      (() => ({}) as any) as any,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('execute fires execFile(qmd update agent-knowledge) after publishKnowledge completes', async () => {
    const input = knowledgePublishHandler.parse({
      topic: 't', finding: 'f', evidence: 'e', tags: [], confidence: 8,
    });
    await knowledgePublishHandler.execute!(input as any, buildCtx());
    expect(execFileSpy).toHaveBeenCalled();
    const call = execFileSpy.mock.calls[0];
    expect(call[1]).toEqual(['update', 'agent-knowledge']);
  });

  it('QMD update subprocess failure is non-fatal (logger.warn, no throw)', async () => {
    // Stub execFile to invoke the callback with an error.
    execFileSpy.mockImplementation(((_bin: string, _args: string[], _opts: any, cb: any) => {
      if (typeof cb === 'function') {
        setImmediate(() => cb(new Error('ENOENT: qmd not found')));
      }
      return {} as any;
    }) as any);
    const input = knowledgePublishHandler.parse({
      topic: 't', finding: 'f', evidence: 'e', tags: [], confidence: 8,
    });
    // Should NOT throw despite the subprocess error
    await expect(
      knowledgePublishHandler.execute!(input as any, buildCtx()),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun --bun vitest run src/ipc/handlers/knowledge-publish.test.ts 2>&1 | tail -20`
Expected: FAIL — parse() doesn't extract `confidence` (returns undefined), and execute() doesn't call execFile.

- [ ] **Step 3: Extend the handler.**

Use `Edit` on `src/ipc/handlers/knowledge-publish.ts`. The current file looks like:

```typescript
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
}

const KNOWLEDGE_DIR = path.join(DATA_DIR, 'agent-knowledge');
const AUDIT_TARGET = 'agent-knowledge';

export const knowledgePublishHandler: IpcHandler<Input> = {
  type: 'knowledge_publish',

  parse(raw) {
    // Original case accepted any payload, substituting sensible defaults for
    // missing fields. Preserve that lenient behavior — no reject path here.
    const r =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    return {
      topic: typeof r.topic === 'string' ? r.topic : 'unknown',
      finding: typeof r.finding === 'string' ? r.finding : '',
      evidence: typeof r.evidence === 'string' ? r.evidence : '',
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    };
  },

  authorize(input) {
    return {
      target: AUDIT_TARGET,
      auditSummary: input.topic,
      notifySummary: `published "${input.topic}"`,
      payloadForStaging: {
        type: 'knowledge_publish',
        topic: input.topic,
        finding: input.finding,
        evidence: input.evidence,
        tags: input.tags,
      },
    };
  },

  async execute(input, ctx) {
    const { publishKnowledge } = await import('../../knowledge.js');
    const filePath = publishKnowledge(input, ctx.sourceGroup, KNOWLEDGE_DIR);
    logger.info(
      { sourceGroup: ctx.sourceGroup, topic: input.topic, filePath },
      'Knowledge entry published',
    );

    if (ctx.deps.messageBus) {
      ctx.deps.messageBus.publish({
        from: ctx.sourceGroup,
        topic: `knowledge:${input.topic}`,
        summary: input.finding.slice(0, 200),
        action_needed: '',
        priority: 'low',
      });
    }
  },
};
```

Replace the **entire file contents** with:

```typescript
import { execFile } from 'child_process';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
  /**
   * Self-assessed confidence 1-10. Distinct from KnowledgeEntry.confidence:
   * this is the IPC-payload-side input; KnowledgeEntry is the publishKnowledge()
   * file-writer input. Both gained `confidence` in the same commit (Phase 1.2
   * round-1 amendment §4.1) — they are structurally separate types.
   *
   * parse() always returns a number here (defaulted to 5 if missing or
   * out-of-range), so the field is non-optional.
   */
  confidence: number;
}

const KNOWLEDGE_DIR = path.join(DATA_DIR, 'agent-knowledge');
const AUDIT_TARGET = 'agent-knowledge';

// Verify with `which qmd` at deploy time. Under launchd, PATH and HOME are
// stripped — both are explicit in the execFile env (round-1 amendment §3.5).
// If the path differs on the host, update this constant.
const QMD_BIN = '/opt/homebrew/bin/qmd';

export const knowledgePublishHandler: IpcHandler<Input> = {
  type: 'knowledge_publish',

  parse(raw) {
    // Original case accepted any payload, substituting sensible defaults for
    // missing fields. Preserve that lenient behavior — no reject path here.
    const r =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    // Confidence: clamp to [1, 10] integers; default 5 for missing, non-numeric,
    // non-integer, or out-of-range values. Lenient parsing matches the original
    // handler's behavior for other fields.
    const rawConf = r.confidence;
    const confidence =
      typeof rawConf === 'number' &&
      Number.isInteger(rawConf) &&
      rawConf >= 1 &&
      rawConf <= 10
        ? rawConf
        : 5;
    return {
      topic: typeof r.topic === 'string' ? r.topic : 'unknown',
      finding: typeof r.finding === 'string' ? r.finding : '',
      evidence: typeof r.evidence === 'string' ? r.evidence : '',
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      confidence,
    };
  },

  authorize(input) {
    return {
      target: AUDIT_TARGET,
      auditSummary: input.topic,
      notifySummary: `published "${input.topic}"`,
      payloadForStaging: {
        type: 'knowledge_publish',
        topic: input.topic,
        finding: input.finding,
        evidence: input.evidence,
        tags: input.tags,
        confidence: input.confidence,
      },
    };
  },

  async execute(input, ctx) {
    const { publishKnowledge } = await import('../../knowledge.js');
    const filePath = publishKnowledge(input, ctx.sourceGroup, KNOWLEDGE_DIR);
    logger.info(
      { sourceGroup: ctx.sourceGroup, topic: input.topic, filePath },
      'Knowledge entry published',
    );

    // Fire-and-forget QMD index update so the finding is BM25-searchable
    // within ~30 seconds (vs. the 4-hour sync cycle). Under launchd, BOTH
    // PATH and HOME are stripped; provide both explicitly (round-1 amendment
    // §3.5). Failure is logged but does not propagate — same pattern as the
    // bus publish below.
    execFile(
      QMD_BIN,
      ['update', 'agent-knowledge'],
      {
        timeout: 30_000,
        env: {
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
          HOME: process.env.HOME ?? '/Users/mgandal',
        },
      },
      (err) => {
        if (err) {
          logger.warn(
            { err, sourceGroup: ctx.sourceGroup, topic: input.topic },
            'qmd update agent-knowledge failed (non-fatal)',
          );
        }
      },
    );

    if (ctx.deps.messageBus) {
      ctx.deps.messageBus.publish({
        from: ctx.sourceGroup,
        topic: `knowledge:${input.topic}`,
        summary: input.finding.slice(0, 200),
        action_needed: '',
        priority: 'low',
      });
    }
  },
};
```

- [ ] **Step 4: Run the publish-handler tests to verify they pass.**

Run: `bun --bun vitest run src/ipc/handlers/knowledge-publish.test.ts 2>&1 | tail -15`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the knowledge.ts tests to confirm no regression.**

Run: `bun --bun vitest run src/knowledge.test.ts 2>&1 | tail -10`
Expected: PASS (existing tests + the 2 from Task 1).

- [ ] **Step 6: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

### Task 3: Extend `knowledge_publish` MCP tool with confidence

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:1904-1937`

The current MCP tool has Zod inputs `topic, finding, evidence, tags`. Add `confidence` and pass it to the IPC payload.

- [ ] **Step 1: Read the current tool registration.**

Open `container/agent-runner/src/ipc-mcp-stdio.ts` and re-read lines 1904-1937 to confirm the current shape.

- [ ] **Step 2: Update the tool.**

Use `Edit`. Find the current registration:

```typescript
server.tool(
  'knowledge_publish',
  `Publish a structured finding to the shared cross-group knowledge base. Indexed by QMD so other agents can discover it via semantic search.

Use when: you discover a durable, reusable fact (regulation change, new paper, workflow decision) that future sessions — yours or other agents — should be able to retrieve.
Prefer bus_publish when: the finding is time-sensitive and should trigger immediate awareness rather than live in the searchable index.
Prefer write_agent_memory when: the fact is personal to you (an agent) rather than useful to everyone.

Inputs:
- topic: short category (e.g. "APA regulation", "lab scheduling").
- finding: clear, specific, actionable statement.
- evidence: source — DOI, URL, or conversation reference.
- tags: array of tags for QMD retrieval.

Returns: "Published knowledge: <topic>". Indexing happens asynchronously; retrieval via qmd or knowledge_search may lag by one ingest cycle.`,
  {
    topic: z.string().describe('Topic category (e.g., "APA regulation", "lab scheduling")'),
    finding: z.string().describe('The finding — clear, specific, actionable'),
    evidence: z.string().describe('Source (DOI, URL, conversation reference)'),
    tags: z.array(z.string()).describe('Tags for discoverability'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'knowledge_publish',
      topic: args.topic,
      finding: args.finding,
      evidence: args.evidence,
      tags: args.tags,
      from: groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Published knowledge: "${args.topic}"` }] };
  },
);
```

Replace with:

```typescript
server.tool(
  'knowledge_publish',
  `Publish a structured finding to the shared cross-group knowledge base. Indexed by QMD so other agents can discover it via semantic search.

Use when: you discover a durable, reusable fact (regulation change, new paper, workflow decision) that future sessions — yours or other agents — should be able to retrieve.
Prefer bus_publish when: the finding is time-sensitive and should trigger immediate awareness rather than live in the searchable index.
Prefer write_agent_memory when: the fact is personal to you (an agent) rather than useful to everyone.

Inputs:
- topic: short category (e.g. "APA regulation", "lab scheduling").
- finding: clear, specific, actionable statement.
- evidence: source — DOI, URL, or conversation reference.
- tags: array of tags for QMD retrieval.
- confidence: optional integer 1-10. Your self-assessed confidence in the finding. 1-3=weak/preliminary; 4-6=moderate; 7-9=high/evidenced; 10=definitive. Default 5 when omitted. Returned in search results so other agents can weight findings.

Returns: "Published knowledge: <topic>". BM25 search is available within ~30 seconds (host fires \`qmd update agent-knowledge\` immediately after write). Semantic search may lag up to 4 hours (next embed cycle). Retrieve via knowledge_search.`,
  {
    topic: z.string().describe('Topic category (e.g., "APA regulation", "lab scheduling")'),
    finding: z.string().describe('The finding — clear, specific, actionable'),
    evidence: z.string().describe('Source (DOI, URL, conversation reference)'),
    tags: z.array(z.string()).describe('Tags for discoverability'),
    confidence: z.number().int().min(1).max(10).optional().describe('Self-assessed 1-10 (1-3=weak, 4-6=moderate, 7-9=high, 10=definitive). Default 5.'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'knowledge_publish',
      topic: args.topic,
      finding: args.finding,
      evidence: args.evidence,
      tags: args.tags,
      confidence: args.confidence ?? 5,
      from: groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Published knowledge: "${args.topic}"` }] };
  },
);
```

- [ ] **Step 3: Verify container TypeScript compiles.**

The container has its own TS build. Try:

Run: `cd container/agent-runner && bun run tsc --noEmit 2>&1 | tail -10`

If `tsc --noEmit` isn't a configured script, look at `container/agent-runner/package.json` for the equivalent (likely `build` or `typecheck`) and run that. If the container build is hard to invoke, escalate (NEEDS_CONTEXT).

Expected: no new errors in `ipc-mcp-stdio.ts`. Pre-existing errors in `honcho-client.test.ts` (per Phase 1.1 implementer notes) are not our concern.

### Task 4: Commit 1 — atomic commit

- [ ] **Step 1: Verify staging area.**

Run: `git status --short`
Expected: 5 modified or new files: `src/knowledge.ts`, `src/knowledge.test.ts`, `src/ipc/handlers/knowledge-publish.ts`, `src/ipc/handlers/knowledge-publish.test.ts` (likely new), `container/agent-runner/src/ipc-mcp-stdio.ts`.

There may be OTHER pre-existing modifications in the working tree from parallel work (CLAUDE.md, etc.). DO NOT stage those.

- [ ] **Step 2: Stage explicitly.**

Run:
```bash
git add src/knowledge.ts src/knowledge.test.ts \
        src/ipc/handlers/knowledge-publish.ts \
        src/ipc/handlers/knowledge-publish.test.ts \
        container/agent-runner/src/ipc-mcp-stdio.ts
git diff --cached --stat
```

Expected: 5 files staged, all additions or specific line modifications. No unrelated files.

- [ ] **Step 3: Write the commit message.**

Save to `/tmp/knowledge-commit1-msg.txt`:

```
feat(knowledge): add confidence field + background QMD update on publish

Round-1 amended Phase 1.2 of NanoClaw's shared knowledge layer.

Adds a `confidence` field (integer 1-10, default 5) to:
  - KnowledgeEntry interface in src/knowledge.ts (and its YAML frontmatter)
  - The local Input interface in knowledge-publish.ts (structurally distinct
    from KnowledgeEntry — both must be updated per round-1 amendment §4.1)
  - The knowledge_publish MCP tool's Zod schema and IPC payload

Adds a fire-and-forget `qmd update agent-knowledge` subprocess call after
publishKnowledge() succeeds, so new findings are BM25-searchable within
~30 seconds rather than waiting for the 4-hour sync cycle. Uses absolute
QMD_BIN path with explicit PATH+HOME env (round-1 amendment §3.5 — launchd
strips both).

Test scope: +7 tests (5 parse + 2 execute) for the handler, +2 frontmatter
tests for publishKnowledge.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 4: Commit.**

Run:
```bash
git commit -F /tmp/knowledge-commit1-msg.txt
rm /tmp/knowledge-commit1-msg.txt
git log -1 --oneline
```

Expected: commit landed.

---

## Commit 2: Real knowledge_search IPC Handler

### Task 5: Add `knowledge_search` to SKIP_GATE_ALLOWLIST

**Files:**
- Modify: `src/ipc/handler.ts:21-46` (the SKIP_GATE_ALLOWLIST Set)

- [ ] **Step 1: Read the current allowlist.**

Open `src/ipc/handler.ts:21-46`. Notice it has the read-only block (dashboard_query, kg_query, etc.) and the writes-that-bypassed-the-gate block (task_add, task_close, task_reopen, pageindex_index, and the Phase 1.1 addition `schedule_wakeup`).

- [ ] **Step 2: Add the entry.**

Use `Edit`. Find the read-only block (around lines 22-32):

```typescript
const SKIP_GATE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Read-only
  'dashboard_query',
  'kg_query',
  'pageindex_fetch',
  'task_list',
  'slack_dm_read',
  'skill_search',
  'skill_invoked',
  'imessage_search',
  'imessage_read',
  'imessage_list_contacts',
```

Replace with (adds `knowledge_search` to the read-only block — alphabetical proximity to `kg_query`):

```typescript
const SKIP_GATE_ALLOWLIST: ReadonlySet<string> = new Set([
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
```

- [ ] **Step 3: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

### Task 6: Create the knowledge_search handler with parse, authorize, and execute

**Files:**
- Create: `src/ipc/handlers/knowledge-search.ts`
- Create: `src/ipc/handlers/knowledge-search.test.ts`

This is the load-bearing task. The handler mirrors `skillSearchHandler` at `src/ipc/handlers/skills.ts:64-167` but with the round-1-amended Critical fix: `if (!response.ok) throw` before reading JSON.

- [ ] **Step 1: Write the handler unit tests first.**

Create `src/ipc/handlers/knowledge-search.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { knowledgeSearchHandler } from './knowledge-search.js';
import type { IpcHandlerContext } from '../handler.js';

function buildCtx(overrides: Partial<IpcHandlerContext> = {}): IpcHandlerContext {
  return {
    sourceGroup: 'telegram_claire',
    isMain: true,
    baseGroup: 'telegram_claire',
    agentName: 'claire',
    requestId: 'req-test-001',
    registeredGroups: {},
    deps: {} as any,
    dataDir: '/tmp/test',
    ...overrides,
  };
}

describe('knowledgeSearchHandler.parse', () => {
  it('returns null for non-object input', () => {
    expect(knowledgeSearchHandler.parse(null)).toBeNull();
    expect(knowledgeSearchHandler.parse(42)).toBeNull();
    expect(knowledgeSearchHandler.parse('s')).toBeNull();
  });

  it('returns null for missing query field', () => {
    expect(knowledgeSearchHandler.parse({})).toBeNull();
  });

  it('returns null for empty-string query (after trim)', () => {
    expect(knowledgeSearchHandler.parse({ query: '   ' })).toBeNull();
  });

  it('clamps max_results to [1, 20]: 0 → 1, 50 → 20, 5 → 5', () => {
    expect(knowledgeSearchHandler.parse({ query: 'x', max_results: 0 })!.max_results).toBe(1);
    expect(knowledgeSearchHandler.parse({ query: 'x', max_results: 50 })!.max_results).toBe(20);
    expect(knowledgeSearchHandler.parse({ query: 'x', max_results: 5 })!.max_results).toBe(5);
  });

  it('defaults max_results to 5 when omitted', () => {
    expect(knowledgeSearchHandler.parse({ query: 'x' })!.max_results).toBe(5);
  });
});

describe('knowledgeSearchHandler.authorize', () => {
  it('returns skipGate=true for non-agent caller', () => {
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const auth = knowledgeSearchHandler.authorize(input, buildCtx({ agentName: null }));
    expect(auth).not.toBeNull();
    expect((auth as any).skipGate).toBe(true);
    expect((auth as any).target).toBe('agent-knowledge');
  });

  it('omits skipGate for agent caller (gate writes audit row)', () => {
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const auth = knowledgeSearchHandler.authorize(input, buildCtx({ agentName: 'claire' }));
    expect(auth).not.toBeNull();
    expect((auth as any).skipGate).toBeUndefined();
    expect((auth as any).target).toBe('agent-knowledge');
    expect((auth as any).auditSummary).toContain('q');
  });
});

describe('knowledgeSearchHandler.execute', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: returns success with raw results text', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { content: [{ text: '[{"topic":"x"}]' }] } }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).executed).toBe(true);
    expect((result as any).result.success).toBe(true);
    expect((result as any).result.results).toContain('"topic"');
  });

  it('CRITICAL — response.ok=false produces {success:false}, NOT silent {success:true,results:""}', async () => {
    // This is the round-1-amended Critical fix. skill_search lacks this check
    // and would parse the 503 JSON body, find no content[0].text, and return
    // {success:true, results:""} — a silent false-success. We must NOT inherit
    // that bug. With response.ok check, the handler throws → catch → {success:false}.
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'bridge down' }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).executed).toBe(true);
    expect((result as any).result.success).toBe(false);
    expect((result as any).result.message).toContain('503');
  });

  it('fetch throws (ECONNREFUSED) → {success:false, message}', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).executed).toBe(true);
    expect((result as any).result.success).toBe(false);
    expect((result as any).result.message).toContain('ECONNREFUSED');
  });

  it('QMD response missing content field → {success:true, results:""}', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: {} }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    const result = await knowledgeSearchHandler.execute(input, buildCtx());
    expect((result as any).result.success).toBe(true);
    expect((result as any).result.results).toBe('');
  });

  it('sends BOTH vec and lex sub-queries (knowledge_search differs from skill_search)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { content: [{ text: '[]' }] } }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'apa regulation' })!;
    await knowledgeSearchHandler.execute(input, buildCtx());
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const searches = requestBody.params.arguments.searches;
    expect(searches).toHaveLength(2);
    expect(searches.map((s: any) => s.type).sort()).toEqual(['lex', 'vec']);
  });

  it('uses agent-knowledge collection (not skill-catalog)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { content: [{ text: '[]' }] } }),
    } as any);
    const input = knowledgeSearchHandler.parse({ query: 'q' })!;
    await knowledgeSearchHandler.execute(input, buildCtx());
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.params.arguments.collections).toEqual(['agent-knowledge']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `bun --bun vitest run src/ipc/handlers/knowledge-search.test.ts 2>&1 | tail -20`
Expected: FAIL — module './knowledge-search.js' not found.

- [ ] **Step 3: Create the handler.**

Create `src/ipc/handlers/knowledge-search.ts`:

```typescript
import { getBridgeToken } from '../../bridge-auth.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  query: string;
  max_results: number;
}

type Result = {
  executed: true;
  result: { success: true; results: string; query: string } | { success: false; message: string };
};

export const knowledgeSearchHandler: IpcHandler<Input, Result> = {
  type: 'knowledge_search',
  responseKind: 'result',
  resultsDirName: 'knowledge_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const query = typeof r.query === 'string' ? r.query.trim() : '';
    if (query.length === 0) return null;
    const rawMax = typeof r.max_results === 'number' ? r.max_results : 5;
    const max_results = Math.min(20, Math.max(1, Math.round(rawMax)));
    return { query, max_results };
  },

  authorize(input, ctx) {
    return {
      target: 'agent-knowledge',
      auditSummary: input.query.slice(0, 100),
      notifySummary: `searched knowledge: ${input.query.slice(0, 80)}`,
      payloadForStaging: {
        type: 'knowledge_search',
        query: input.query,
      },
      // Non-agent callers (operator scripts, host-side IPC) skip the gate.
      // Agent callers go through gateAndStage so the search shows up in
      // agent_actions for forensic review. Same pattern intent as the spec §3.2.
      ...(ctx.agentName === null ? { skipGate: true as const } : {}),
    };
  },

  async execute(input, ctx): Promise<Result> {
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
              // Both vec and lex — paraphrased queries need semantic matching
              // (vec) while specialized vocabulary needs exact-term matching (lex).
              // skill_search uses lex-only because skill names are exact strings;
              // knowledge findings are mixed prose.
              searches: [
                { type: 'vec', query: input.query },
                { type: 'lex', query: input.query },
              ],
              collections: ['agent-knowledge'],
              intent: input.query,
              limit: input.max_results,
            },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      // ROUND-1 AMENDMENT §4.2 (CRITICAL): fetch does NOT throw on non-2xx.
      // skill_search skips this check (src/ipc/handlers/skills.ts:96-117) and
      // gets away with it only because empty 503 bodies fail JSON parse and
      // hit its catch. QMD CAN return 503 with a valid JSON error body —
      // without this guard, the handler would parse it successfully, find
      // no content[0].text, and return {success:true, results:""} — a silent
      // false-success the caller would interpret as "no results found".
      if (!response.ok) {
        throw new Error(`Bridge returned ${response.status} ${response.statusText}`);
      }

      const json = (await response.json()) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const rawText = json.result?.content?.[0]?.text ?? '';
      logger.info(
        { sourceGroup: ctx.sourceGroup, query: input.query, requestId: ctx.requestId },
        'knowledge_search QMD call complete',
      );
      return {
        executed: true,
        result: { success: true, results: rawText, query: input.query },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, sourceGroup: ctx.sourceGroup, query: input.query },
        'knowledge_search QMD fetch failed',
      );
      return { executed: true, result: { success: false, message } };
    }
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `bun --bun vitest run src/ipc/handlers/knowledge-search.test.ts 2>&1 | tail -15`
Expected: PASS (13 tests).

- [ ] **Step 5: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

### Task 7: Register the handler in index.ts

**Files:**
- Modify: `src/ipc/handlers/index.ts`

- [ ] **Step 1: Read the current registry.**

Open `src/ipc/handlers/index.ts`. Find:
- The `import { knowledgePublishHandler } from './knowledge-publish.js';` line (around line 26)
- The `registerIpcHandler(knowledgePublishHandler);` call inside `registerBuiltinHandlers()`

- [ ] **Step 2: Add the import.**

Use `Edit`. Find:

```typescript
import { knowledgePublishHandler } from './knowledge-publish.js';
```

Replace with:

```typescript
import { knowledgePublishHandler } from './knowledge-publish.js';
import { knowledgeSearchHandler } from './knowledge-search.js';
```

- [ ] **Step 3: Add the registration.**

Find:

```typescript
  registerIpcHandler(knowledgePublishHandler);
```

Replace with:

```typescript
  registerIpcHandler(knowledgePublishHandler);
  registerIpcHandler(knowledgeSearchHandler);
```

- [ ] **Step 4: GREP-VERIFY both edits landed.**

Run: `grep -n "knowledgeSearchHandler" /Users/mgandal/Agents/nanoclaw/src/ipc/handlers/index.ts`
Expected: 2 lines — one import, one register. If 0 or 1, the Edit didn't take — re-apply.

(This grep-verify step is a Phase 1.1 lesson: Task 8 subagents have hallucinated registry edits before. Always verify wiring tasks with a grep before declaring done.)

- [ ] **Step 5: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS.

### Task 8: Replace the container knowledge_search stub with real round-trip

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:820-824` (add KNOWLEDGE_RESULTS_DIR constant)
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:1939-1966` (replace the redirect stub with a real round-trip)

- [ ] **Step 1: Add the KNOWLEDGE_RESULTS_DIR constant.**

Use `Edit` on `container/agent-runner/src/ipc-mcp-stdio.ts`. Find:

```typescript
const BROWSER_RESULTS_DIR = path.join(IPC_DIR, 'browser_results');
const DASHBOARD_RESULTS_DIR = path.join(IPC_DIR, 'dashboard_results');
const SKILL_RESULTS_DIR = path.join(IPC_DIR, 'skill_results');
const KG_RESULTS_DIR = path.join(IPC_DIR, 'kg_results');
const TASK_RESULTS_DIR = path.join(IPC_DIR, 'task_results');
```

Replace with (adds `KNOWLEDGE_RESULTS_DIR` in alphabetical position):

```typescript
const BROWSER_RESULTS_DIR = path.join(IPC_DIR, 'browser_results');
const DASHBOARD_RESULTS_DIR = path.join(IPC_DIR, 'dashboard_results');
const KG_RESULTS_DIR = path.join(IPC_DIR, 'kg_results');
const KNOWLEDGE_RESULTS_DIR = path.join(IPC_DIR, 'knowledge_results');
const SKILL_RESULTS_DIR = path.join(IPC_DIR, 'skill_results');
const TASK_RESULTS_DIR = path.join(IPC_DIR, 'task_results');
```

- [ ] **Step 2: Replace the knowledge_search redirect stub.**

Use `Edit`. Find the current stub:

```typescript
// knowledge_search — search the shared knowledge base
server.tool(
  'knowledge_search',
  `Helper that returns an instruction for how to search the shared knowledge base via qmd. Does NOT perform the search itself.

Use when: you want a reminder of the correct qmd invocation for the agent-knowledge collection.
Prefer calling qmd directly when: you already know the qmd query interface — this tool only reformats your query into a qmd call.

Inputs: query (required), from_agent (optional filter), topic (optional filter).

Returns: text instructing which qmd call to make next. You must then call qmd to get actual results.`,
  {
    query: z.string().describe('Semantic search query'),
    from_agent: z.string().optional().describe('Restrict to findings published by this agent'),
    topic: z.string().optional().describe('Restrict to findings with this topic'),
  },
  async (args) => {
    return {
      content: [{
        type: 'text' as const,
        text:
          `To search shared knowledge, use the qmd tool with collection "agent-knowledge" and query: "${args.query}". ` +
          (args.from_agent ? `Filter by agent: ${args.from_agent}. ` : '') +
          (args.topic ? `Filter by topic: ${args.topic}.` : ''),
      }],
    };
  },
);
```

Replace with the real round-trip implementation:

```typescript
// knowledge_search — REAL handler (replaces the prior redirect-stub).
server.tool(
  'knowledge_search',
  `Search the shared cross-group knowledge base for findings published by any agent.

Use when: you need to know what any agent has previously discovered about a topic — across all groups, all agents. Returns structured findings with their source, confidence rating, publishing agent, and date.

Do not use for:
- Searching the general document vault (use mcp__qmd__query with collection "vault").
- Searching your own agent memory (read /workspace/agents/{you}/memory.md directly).
- Real-time coordination with another agent (use publish_to_bus).
- Searching emails, calendar, or notes (use Gmail MCP, calendar tools, or Apple Notes MCP).

Inputs:
- query: natural language description of what you want to know. Example: "chromatin accessibility APA TF binding".
- max_results: results to return (default 5, max 20). Increase for exploratory searches.

Returns: JSON from QMD with matching findings including topic, body, evidence, confidence, agent provenance, and date. Returns { success: false, message } if QMD is unreachable. 15-second timeout.`,
  {
    query: z.string().describe('Natural language query — what do you want to know?'),
    max_results: z.number().int().min(1).max(20).optional().describe('Results to return (default 5, max 20)'),
  },
  async (args) => {
    const requestId = `ks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'knowledge_search',
      query: args.query,
      max_results: args.max_results ?? 5,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForIpcResult(KNOWLEDGE_RESULTS_DIR, requestId, 15_000);
    if (!result || !(result as { success?: boolean }).success) {
      const msg =
        (result as { message?: string })?.message ??
        'No matching findings (or QMD unavailable).';
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
    const resultsText = (result as { results?: string }).results ?? '[]';
    return { content: [{ type: 'text' as const, text: resultsText }] };
  },
);
```

- [ ] **Step 3: Verify container TypeScript compiles.**

Run: `cd container/agent-runner && bun run tsc --noEmit 2>&1 | tail -10`
Expected: no new errors in `ipc-mcp-stdio.ts` (pre-existing `honcho-client.test.ts` errors are not our concern).

- [ ] **Step 4: GREP-VERIFY the stub is gone.**

Run: `grep -n "To search shared knowledge" /Users/mgandal/Agents/nanoclaw/container/agent-runner/src/ipc-mcp-stdio.ts`
Expected: 0 matches. (The redirect-stub's signature string is gone.)

Run: `grep -n "waitForIpcResult.*KNOWLEDGE_RESULTS" /Users/mgandal/Agents/nanoclaw/container/agent-runner/src/ipc-mcp-stdio.ts`
Expected: 1 match. (The real round-trip is in place.)

### Task 9: Add 2 dispatcher contract tests for knowledge_search

**Files:**
- Modify: `src/ipc/handler-post-hoc-notify.test.ts` — append 2 tests (Tests 9 and 10) at the end of the existing describe block

This is the same pattern as Phase 1.1's Tests 7+8 (and Phase 2F.1's Test 6). On-allowlist control + off-allowlist denial for the new `knowledge_search` wire type.

- [ ] **Step 1: Read the existing pattern.**

Open `src/ipc/handler-post-hoc-notify.test.ts` and re-read Tests 7+8 (added by Phase 1.1, around lines 392-470). Notice the pattern: define a stub handler with a chosen `type` + `skipGate: true`, register it, dispatch, assert on `executed` and `agent_actions` rows queried via `getDb()`.

- [ ] **Step 2: Append the new tests.**

Add at the end of the file, BEFORE the closing `});` of the outer describe block:

```typescript
  // ---- Test 9: knowledge_search-style on-allowlist skipGate → execute runs ----

  it('9. knowledge_search on-allowlist with skipGate → execute runs, no denied_contract_violation', async () => {
    // Pins that SKIP_GATE_ALLOWLIST honors skipGate when the wire type is
    // 'knowledge_search'. Regression guard: a future removal from the
    // allowlist (Phase 1.2 Task 5) would fail this test.
    let executed = false;

    const handler: IpcHandler<{ ok: boolean }, void> = {
      type: 'knowledge_search', // ON SKIP_GATE_ALLOWLIST per Phase 1.2 Task 5
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'agent-knowledge',
        notifySummary: 'knowledge_search stub',
        payloadForStaging: { type: 'knowledge_search' },
        skipGate: true,
      }),
      execute: () => {
        executed = true;
        return undefined;
      },
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'knowledge_search' });

    expect(executed).toBe(true);

    const rows = getDb()
      .prepare(
        'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    expect(rows.map((r) => r.outcome)).not.toContain('denied_contract_violation');
  });

  // ---- Test 10: off-allowlist control (parallel to Test 9) ----

  it('10. off-allowlist handler with skipGate (knowledge_publish-not-yet-allowlisted) → denied_contract_violation', async () => {
    // Parallel control for Test 9 — confirms the allowlist gate actually
    // fires when the wire type is not listed. We use 'wire_off_allow_v2' to
    // avoid colliding with the existing Test 8 stub identifier.
    let executed = false;

    const handler: IpcHandler<{ ok: boolean }, void> = {
      type: 'wire_off_allow_v2',
      parse: (raw) =>
        typeof raw === 'object' && raw !== null ? { ok: true } : null,
      authorize: () => ({
        target: 'target-off-v2',
        notifySummary: 'should never fire',
        payloadForStaging: { type: 'wire_off_allow_v2' },
        skipGate: true,
      }),
      execute: () => {
        executed = true;
        return undefined;
      },
    };
    registerIpcHandler(handler);

    await dispatch({ type: 'wire_off_allow_v2' });

    expect(executed).toBe(false);

    const rows = getDb()
      .prepare(
        'SELECT action_type, outcome FROM agent_actions WHERE agent_name = ?',
      )
      .all(agentName) as { action_type: string; outcome: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('wire_off_allow_v2');
    expect(rows[0].outcome).toBe('denied_contract_violation');
  });
```

- [ ] **Step 3: Run the new tests.**

Run: `bun --bun vitest run src/ipc/handler-post-hoc-notify.test.ts -t '9. knowledge_search|10. off-allowlist handler' 2>&1 | tail -10`
Expected: PASS (2 tests).

- [ ] **Step 4: Run the full file to confirm no regression.**

Run: `bun --bun vitest run src/ipc/handler-post-hoc-notify.test.ts 2>&1 | tail -10`
Expected: PASS (all existing + 2 new).

### Task 10: Verification before Commit 2

- [ ] **Step 1: Run all our new/modified test files.**

Run:
```bash
bun --bun vitest run src/knowledge.test.ts \
                    src/ipc/handlers/knowledge-publish.test.ts \
                    src/ipc/handlers/knowledge-search.test.ts \
                    src/ipc/handler-post-hoc-notify.test.ts 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 2: Run typecheck.**

Run: `bun run typecheck`
Expected: PASS (modulo pre-existing untracked-file errors flagged in Phase 1.1).

- [ ] **Step 3: Run lint, scoped to our new files.**

Run: `bun run lint 2>&1 | grep -A 2 "knowledge-search\|knowledge-publish" | head -20`
Expected: At most warnings (catch-block warnings on the new try/catch are acceptable — same pattern as the Phase 1.1 `execute()` catch). No errors.

- [ ] **Step 4: Run the full test suite.**

Run: `bun run test 2>&1 | tail -10`
Expected: baseline + ~24 new tests pass. One pre-existing failure in `src/ipc.test.ts > skill_search > handles empty results from QMD` may still appear — that's the same environmental flake from Phase 1.1; not caused by this work.

### Task 11: Commit 2 — atomic commit

- [ ] **Step 1: Verify staging.**

Run: `git status --short`
Expected: 5 modified/new files: `src/ipc/handler.ts`, `src/ipc/handlers/knowledge-search.ts` (new), `src/ipc/handlers/knowledge-search.test.ts` (new), `src/ipc/handlers/index.ts`, `src/ipc/handler-post-hoc-notify.test.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`. (Plus any pre-existing untracked files NOT from this commit — DO NOT stage those.)

- [ ] **Step 2: Stage explicitly.**

Run:
```bash
git add src/ipc/handler.ts \
        src/ipc/handlers/knowledge-search.ts \
        src/ipc/handlers/knowledge-search.test.ts \
        src/ipc/handlers/index.ts \
        src/ipc/handler-post-hoc-notify.test.ts \
        container/agent-runner/src/ipc-mcp-stdio.ts
git diff --cached --stat
```

Expected: 6 files staged, all additions or specific modifications. No unrelated files.

- [ ] **Step 3: Write the commit message.**

Save to `/tmp/knowledge-commit2-msg.txt`:

```
feat(knowledge): real knowledge_search IPC handler (replaces redirect stub)

Replaces the long-standing knowledge_search redirect-stub (which returned a
text instruction telling the agent to call mcp__qmd__query directly) with a
real result-kind IPC handler that calls QMD's HTTP MCP endpoint, sends both
vec and lex sub-queries against the agent-knowledge collection, and writes
structured results to knowledge_results/{requestId}.json.

Key design choices (round-1 amended):
- §4.2 Critical fix: execute() includes an explicit `if (!response.ok) throw`
  check before reading response.json(). The skill_search reference at
  src/ipc/handlers/skills.ts:96-117 lacks this and would parse a 503 JSON
  error body silently, producing { success: true, results: '' } — a false
  success the caller interprets as "no matches found". knowledge_search
  rejects bridge errors as { success: false, message }.
- §3.2: 'knowledge_search' on SKIP_GATE_ALLOWLIST. Non-agent callers fully
  skip the gate; agent callers go through gateAndStage so the search shows
  up in agent_actions for forensic review.
- §3.3: BOTH vec and lex sub-queries sent in parallel — findings use
  specialized vocabulary (BM25 handles exact terms) but paraphrased queries
  need semantic matching (vec).

Test scope: +15 tests
  - 13 handler tests (5 parse + 2 authorize + 6 execute)
  - 2 dispatcher contract tests (on-allowlist honored / off-allowlist denied)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 4: Commit.**

Run:
```bash
git commit -F /tmp/knowledge-commit2-msg.txt
rm /tmp/knowledge-commit2-msg.txt
git log -2 --oneline
```

Expected: 2 commits visible (Commit 1 + Commit 2 for Phase 1.2).

- [ ] **Step 5: Final verification on committed state.**

Run: `bun --bun vitest run src/ipc/handlers/knowledge-search.test.ts src/ipc/handlers/knowledge-publish.test.ts src/knowledge.test.ts 2>&1 | tail -10`
Expected: all tests green on committed state.

---

## Acceptance Criteria (from spec §11)

After Tasks 1-11 complete, verify each:

| # | Criterion | How to verify |
|---|---|---|
| 1 | Full test suite passes (baseline + ~24 new) | `bun run test` |
| 2 | `bun run typecheck` passes | self-explanatory |
| 3 | `bun run lint` passes | (acceptable warnings on our new catch-blocks; no new errors) |
| 4 | `confidence` exists in BOTH KnowledgeEntry and YAML.stringify call | `grep -n "confidence" src/knowledge.ts` should return 2+ hits |
| 5 | `knowledge_search` on SKIP_GATE_ALLOWLIST | `grep -n "'knowledge_search'" src/ipc/handler.ts` |
| 6 | KNOWLEDGE_RESULTS_DIR constant exists in container | `grep -n "KNOWLEDGE_RESULTS_DIR" container/agent-runner/src/ipc-mcp-stdio.ts` |
| 7 | Container stub is replaced (real round-trip via waitForIpcResult) | `grep -n "waitForIpcResult.*KNOWLEDGE" container/agent-runner/src/ipc-mcp-stdio.ts` returns 1 hit; `grep -n "To search shared knowledge" container/agent-runner/src/ipc-mcp-stdio.ts` returns 0 hits |
| 8 | Handler registered | `grep -n "knowledgeSearchHandler" src/ipc/handlers/index.ts` returns 2 hits |
| 9 | Critical `response.ok` check fires on QMD 503 | The Critical test in `knowledge-search.test.ts` covers this |
| 10 | Background QMD update is fired | The `execFile fires after publishKnowledge` test covers this |
| 11 | `qmd` binary path verified | Task 0 Step 5 captured `which qmd`; if it differs from `/opt/homebrew/bin/qmd`, the constant in `knowledge-publish.ts` was updated |

---

## Out of Scope (for future phases)

Per spec §11 Open Questions:

- **Q1**: TTL / staleness handling on findings — deferred to Phase 1.3.
- **Q2**: `knowledge_publish` trust default (`autonomous` vs. `notify`) — keep autonomous; revisit if abuse seen.
- **Q4**: Raw JSON vs. parsed `SearchResult[]` from search — keep raw; agents already handle QMD JSON.
- **Q5**: `min_confidence` / `from_agent` filter parameters — deferred; agents can include filter terms in the natural-language query.

The Section D and E manual integration tests in the spec (QMD round-trip and multi-agent cross-publish) are operational verification steps to run AFTER deployment, not part of this plan. Run them after the container image is rebuilt (`./container/build.sh`).
