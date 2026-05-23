import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb, setRegisteredGroup } from '../../db.js';
import { DATA_DIR } from '../../config.js';
import { IpcDeps } from '../../ipc.js';
import { logger } from '../../logger.js';
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
  saveSkillHandler,
  crystallizeSkillHandler,
  crystallizeCandidateHandler,
  _resetBuiltinSkillsCacheForTests,
} from './skills.js';
import type { IpcHandlerContext } from '../handler.js';

/**
 * Build a minimal IpcHandlerContext for direct-execute tests (Task 5).
 * The crystallize_candidate handler reads ctx.deps.db and ctx.deps.sendMessage
 * directly — no dispatcher round-trip — so we hand-roll a context here.
 */
function buildTestCtx(opts: {
  sourceGroup: string;
  agentName: string | null;
  sendMessage?: (jid: string, text: string) => Promise<void>;
}): IpcHandlerContext {
  const ctx: IpcHandlerContext = {
    sourceGroup: opts.sourceGroup,
    isMain: false,
    baseGroup: opts.sourceGroup,
    agentName: opts.agentName,
    requestId: null,
    registeredGroups: {},
    deps: {
      db: getDb(),
      sendMessage: opts.sendMessage ?? (async () => undefined),
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    },
    dataDir: '/tmp/test-data',
  };
  return ctx;
}

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
      db: getDb(),
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
    expect(skillSearchHandler.parse({ query: 'foo' })).toEqual({
      query: 'foo',
    });
    expect(skillSearchHandler.parse({ query: 42 })).toEqual({
      query: undefined,
    });
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

  it('25b. execute missing query emits logger.warn with sourceGroup + requestId (M2 observability fix)', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
      await skillSearchHandler.execute({ query: undefined }, ctx);
      const missingQueryCalls = spy.mock.calls.filter((c) => {
        const msg = c[1];
        return (
          typeof msg === 'string' && msg.includes('missing query parameter')
        );
      });
      expect(missingQueryCalls).toHaveLength(1);
      const callCtx = missingQueryCalls[0][0] as Record<string, unknown>;
      expect(callCtx.sourceGroup).toBe(SOURCE_GROUP);
      expect(callCtx.requestId).toBe(ctx.requestId);
    } finally {
      spy.mockRestore();
    }
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
    const payload = (out as { result: { success: boolean; message: string } })
      .result;
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
  ])(
    '27. execute empty QMD response (%s) returns exact failure message',
    async (_label, body) => {
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
    },
  );

  it('28. execute AbortError timeout returns Skill search timed out', async () => {
    const abortErr = new DOMException('aborted', 'AbortError');
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

  it.each([
    ['results missing', { foo: 'bar' }],
    ['results null', { results: null }],
    ['results string', { results: 'not-an-array' }],
    ['results object', { results: { 0: 'x' } }],
    // H1.6 fix from R2 review: rawText can also be a non-object primitive.
    // JSON.parse("null") returns null, not {}. Without the parsed-shape
    // guard, Array.isArray(parsed.results) threw TypeError on the null
    // dereference and was caught as "QMD unavailable: ...". Now: distinct
    // malformed-results message via a guard BEFORE the L1 check.
    ['parsed is null', null],
    ['parsed is integer primitive', 42],
    ['parsed is boolean primitive', true],
    ['parsed is string primitive', 'just a string'],
    ['parsed is array (not object)', [1, 2, 3]],
  ])(
    '29b. execute malformed QMD results (%s) returns malformed-results message, NOT QMD-unavailable (L1 defensive fix)',
    async (_label, parsedBody) => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            content: [{ text: JSON.stringify(parsedBody) }],
          },
        }),
      });
      const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
      const out = await skillSearchHandler.execute({ query: 'foo' }, ctx);
      expect(out).toEqual({
        executed: true,
        result: {
          success: false,
          message: 'QMD returned malformed results array',
        },
      });
    },
  );

  // Inner-element shape coverage (H1 fix from R2 review). The original L1
  // guard only validated outer Array.isArray; an array of malformed
  // elements (missing fields, wrong types, null) bypassed the guard and
  // hit .map(), where r.title / r.score.toFixed() / etc. threw TypeError.
  // The outer try/catch then reported it as 'QMD unavailable: ...' —
  // exactly the misleading-error pattern L1 was supposed to close.
  it.each([
    ['element null', { results: [null] }],
    ['element empty object', { results: [{}] }],
    [
      'element missing score',
      { results: [{ file: 'a', title: 'T', snippet: 's' }] },
    ],
    [
      'element missing title',
      { results: [{ file: 'a', score: 0.5, snippet: 's' }] },
    ],
    [
      'element score wrong type',
      { results: [{ file: 'a', title: 'T', score: 'high', snippet: 's' }] },
    ],
    [
      'element file wrong type',
      { results: [{ file: 42, title: 'T', score: 0.5, snippet: 's' }] },
    ],
    [
      'mixed valid+invalid',
      {
        results: [
          { file: 'a', title: 'A', score: 0.9, snippet: 'aaa' },
          { foo: 'bar' },
        ],
      },
    ],
  ])(
    '29c. execute malformed QMD element shape (%s) returns malformed-results message (H1 defensive fix)',
    async (_label, parsedBody) => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            content: [{ text: JSON.stringify(parsedBody) }],
          },
        }),
      });
      const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
      const out = await skillSearchHandler.execute({ query: 'foo' }, ctx);
      expect(out).toEqual({
        executed: true,
        result: {
          success: false,
          message: 'QMD returned malformed results array',
        },
      });
    },
  );

  it('29d. execute empty results array succeeds with No-skills-found body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: { content: [{ text: JSON.stringify({ results: [] }) }] },
      }),
    });
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const out = await skillSearchHandler.execute({ query: 'foo' }, ctx);
    // Empty array is well-formed — just zero results. Preserve legacy
    // 'No skills found' message (skills.ts:163).
    expect(out).toMatchObject({
      executed: true,
      result: { success: true, message: 'No skills found' },
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
    const result = readResult(SOURCE_GROUP, 'req-json-throw');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('QMD unavailable');
    expect(result!.message).toContain('Unexpected token');
  });
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
 *  - usage.jsonl literal key set pinned
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
      db: getDb(),
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-invoked-test-'));
    agentsTmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skill-invoked-agents-'),
    );
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
      skillInvokedHandler.parse({
        agent: 'a',
        name: 'b',
        agentsRoot: '/tmp/x',
      }),
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
    const dir = path.join(
      agentsTmpRoot,
      'agent1',
      'skills',
      'crystallized',
      'skill1',
    );
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    const orig = 'no frontmatter at all\njust body';
    fs.writeFileSync(file, orig);

    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    skillInvokedHandler.execute(
      { agent: 'agent1', name: 'skill1', agentsRoot: agentsTmpRoot },
      ctx,
    );

    expect(fs.readFileSync(file, 'utf-8')).toBe(orig);
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
    expect(Object.keys(parsed).sort()).toEqual([
      'agent',
      'name',
      'sourceGroup',
      'ts',
    ]);
    expect(parsed.agent).toBe('agent1');
    expect(parsed.name).toBe('skill1');
    expect(parsed.sourceGroup).toBe(SOURCE_GROUP);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('37. idempotency: invoke twice → count=2 AND second last_invoked_at is later', () => {
    const file = seedSkill(agentsTmpRoot, 'agent1', 'skill1');
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);

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

    const t2 = new Date('2026-05-19T13:00:10.000Z');
    vi.setSystemTime(t2);
    skillInvokedHandler.execute(
      { agent: 'agent1', name: 'skill1', agentsRoot: agentsTmpRoot },
      ctx,
    );
    const afterSecond = fs.readFileSync(file, 'utf-8');
    expect(afterSecond).toContain('invocation_count: 2');
    expect(afterSecond).toContain('last_invoked_at: 2026-05-19T13:00:10.000Z');
    expect(afterSecond).not.toContain(
      'last_invoked_at: 2026-05-19T13:00:00.000Z',
    );
  });

  it('38. integration: dispatch writes no result file AND no audit row', async () => {
    seedSkill(agentsTmpRoot, 'agent1', 'skill1');
    await dispatch({
      type: 'skill_invoked',
      agent: 'agent1',
      name: 'skill1',
      agentsRoot: agentsTmpRoot,
    });

    const skillResultsDir = path.join(
      dataDir,
      'ipc',
      SOURCE_GROUP,
      'skill_results',
    );
    const entries = fs.existsSync(skillResultsDir)
      ? fs.readdirSync(skillResultsDir)
      : [];
    expect(entries).toEqual([]);

    const rows = getDb()
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type = 'skill_invoked'",
      )
      .all();
    expect(rows).toHaveLength(0);
  });
});

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
      db: getDb(),
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-skill-test-'));

    cwdTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'save-skill-cwd-'));
    fs.mkdirSync(path.join(cwdTmp, 'container', 'skills'), { recursive: true });
    // Seed 'agent-browser' as a known builtin for the overwrite test.
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

  it('1. parse returns null for non-object input', () => {
    expect(saveSkillHandler.parse(null)).toBeNull();
    expect(saveSkillHandler.parse(42)).toBeNull();
  });

  it('2. parse extracts skillName + skillContent + coerces wrong types to undefined', () => {
    expect(
      saveSkillHandler.parse({ skillName: 'foo', skillContent: 'body' }),
    ).toEqual({ skillName: 'foo', skillContent: 'body' });
    expect(
      saveSkillHandler.parse({ skillName: 42, skillContent: true }),
    ).toEqual({
      skillName: undefined,
      skillContent: undefined,
    });
  });

  it('3. authorize succeeds for non-main caller and flows through the gate (Phase 4)', () => {
    // Phase 0b dropped the !ctx.isMain early-return in saveSkillHandler.authorize.
    // Trust.yaml policy is now the only restriction.
    // Phase 4 (gate-activation): skipGate REMOVED — every call now flows
    // through gateAndStage. Authorize must return non-null with NO
    // skipGate field, so the dispatcher routes to the gate path.
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = saveSkillHandler.authorize(
      { skillName: 'foo', skillContent: 'body' },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBeUndefined();
    expect(auth!.payloadForStaging).toEqual({
      type: 'save_skill',
      skillName: 'foo',
      skillContent: 'body',
    });
  });

  it('4. authorize returns non-null with NO skipGate field for main caller (Phase 4)', () => {
    // Phase 4: main caller no longer bypasses gate. Returns non-null + the
    // staging payload, so the dispatcher routes through gateAndStage.
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const auth = saveSkillHandler.authorize(
      { skillName: 'foo', skillContent: 'body' },
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBeUndefined();
    expect(auth!.payloadForStaging).toEqual({
      type: 'save_skill',
      skillName: 'foo',
      skillContent: 'body',
    });
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

  // Boundary coverage for the 65536-byte cap: pins that the comparison is
  // strict (>), not loose (>=). Mutation guard — if anyone flips '>' to
  // '>=', test 7a fails. Existing test 7 only pinned OVER-cap (65540).
  it('7a. execute content at EXACTLY 64 KB cap succeeds (mutation-guard for boundary)', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const exactContent = 'a'.repeat(64 * 1024); // 1 byte × 65536 = 65536 bytes
    expect(Buffer.byteLength(exactContent, 'utf-8')).toBe(65536);
    const r = saveSkillHandler.execute(
      { skillName: 'boundary-ok', skillContent: exactContent },
      ctx,
    );
    expect(r).toMatchObject({
      executed: true,
      result: {
        success: true,
        message: 'Skill "boundary-ok" saved permanently.',
      },
    });
  });

  it('7b. execute content at 64 KB + 1 byte fails (mutation-guard for boundary)', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const overContent = 'a'.repeat(64 * 1024 + 1); // exactly one byte over
    expect(Buffer.byteLength(overContent, 'utf-8')).toBe(65537);
    const r = saveSkillHandler.execute(
      { skillName: 'boundary-over', skillContent: overContent },
      ctx,
    );
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message: `Skill content (65537 bytes) exceeds the ${64 * 1024}-byte cap.`,
      },
    });
  });

  it('8. execute builtin overwrite attempt returns exact builtin message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
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
    const file = path.join(
      cwdTmp,
      'container',
      'skills',
      'my-skill',
      'SKILL.md',
    );
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      '---\nname: my-skill\n---\nbody',
    );
  });

  it('11. integration: gate-activation — main caller stages save_skill in pending_actions (Phase 4)', async () => {
    // Phase 4 flipped this: pre-Phase-4 the skipGate bypass let execute()
    // run, writing SKILL.md + zero audit/pending rows ("preserve-bypass").
    // Post-Phase-4 the gate sees trust.yaml `save_skill: draft`, decides
    // `stage: true`, writes ONE agent_actions row (outcome=staged), inserts
    // ONE pending_actions row, and short-circuits before execute() — so the
    // SKILL.md file is NEVER written. The agent gets a stage-result file
    // (Phase 0c) via the dispatcher's `decision.pendingId !== null` branch.
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
          skillName: 'gate-staged-save',
          skillContent: '---\nname: gate-staged-save\n---\nbody',
        },
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );

      // SKILL.md NOT written — execute() short-circuited at the gate.
      const file = path.join(
        cwdTmp,
        'container',
        'skills',
        'gate-staged-save',
        'SKILL.md',
      );
      expect(fs.existsSync(file)).toBe(false);

      // agent_actions row written by checkTrustAndStage (outcome=staged).
      const actionRows = getDb()
        .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
        .all(agentName) as Array<Record<string, unknown>>;
      expect(actionRows).toHaveLength(1);
      expect(actionRows[0].action_type).toBe('save_skill');
      expect(actionRows[0].outcome).toBe('staged');

      // pending_actions row written; agent must /approve to invoke.
      const pendingRows = getDb()
        .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
        .all(agentName) as Array<Record<string, unknown>>;
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0].action_type).toBe('save_skill');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('12. integration: non-agent caller path — non-main dispatch with no agentName executes inline (Phase 4)', async () => {
    // Phase 4: skipGate is gone, but the gate's NON_AGENT_DECISION short-
    // circuit (trust-gate.ts:35 `if (!input.agentName) return NON_AGENT_DECISION`)
    // still allows non-agent callers through. compoundSource here is bare
    // `SOURCE_GROUP` (no `--agent` suffix), so buildContext parses
    // agentName=null. The gate returns allowed=true without consulting any
    // trust.yaml; execute() runs and writes both the SKILL.md + result file.
    //
    // Pre-Phase-4 this passed via the skipGate bypass for the same outcome;
    // post-Phase-4 it passes via the non-agent decision path. Test is
    // structurally identical — the underlying mechanism changed.
    await dispatch(
      {
        type: 'save_skill',
        requestId: 'req-nonmain',
        skillName: 'phase4-nonagent-save',
        skillContent: '---\nname: phase4-nonagent-save\n---\nbody',
      },
      SOURCE_GROUP,
      false,
    );

    const skillResultsDir = path.join(
      dataDir,
      'ipc',
      SOURCE_GROUP,
      'skill_results',
    );
    const entries = fs.existsSync(skillResultsDir)
      ? fs.readdirSync(skillResultsDir)
      : [];
    expect(entries).toContain('req-nonmain.json');

    expect(
      fs.existsSync(
        path.join(cwdTmp, 'container', 'skills', 'phase4-nonagent-save'),
      ),
    ).toBe(true);
  });

  it('T26.5 — payloadForStaging contains actual skillName + skillContent, not just {type}', () => {
    // Mutation-pin for M4 (revert payloadForStaging to {type:'save_skill'} stub).
    // This test verifies the Phase 0a fix: when the handler stages a real call,
    // the stored payload must be reconstructible into a working replay payload.
    const auth = saveSkillHandler.authorize(
      {
        skillName: 'my-test-skill',
        skillContent: '# Test\nBody',
      },
      {
        sourceGroup: 'telegram_claire',
        isMain: true,
        baseGroup: 'telegram_claire',
        agentName: 'claire',
        requestId: null,
        registeredGroups: {},
        deps: {} as any,
        dataDir: '/tmp/test',
      },
    );
    expect(auth).not.toBeNull();
    expect((auth as any).payloadForStaging).toEqual({
      type: 'save_skill',
      skillName: 'my-test-skill',
      skillContent: '# Test\nBody',
    });
  });

  it('T-non-main-save — save_skill authorize succeeds for non-main groups (post-isMain-drop)', () => {
    const auth = saveSkillHandler.authorize(
      { skillName: 'x', skillContent: 'y' },
      {
        sourceGroup: 'telegram_lab-claw--einstein',
        isMain: false,
        baseGroup: 'telegram_lab-claw',
        agentName: 'einstein',
        requestId: null,
        registeredGroups: {},
        deps: {} as any,
        dataDir: '/tmp/test',
      },
    );
    expect(auth).not.toBeNull();
    expect((auth as any).target).toBe('');
  });

  // Phase 4 gate-activation tests (T24, T26, T28). Behavior assertions
  // replacing the previous tautological "no skipGate field" pin.
  it('T24 — dispatch save_skill invokes gateAndStage (not skipGate)', async () => {
    // R3-I3 amendment: behavior assertion, not line-edit assertion.
    // Spy on loadAgentTrust to verify the gate path was taken — pre-Phase-4,
    // skipGate short-circuited before gateAndStage so loadAgentTrust never
    // fired. Post-Phase-4 it MUST fire.
    const agentRegistry = await import('../../agent-registry.js');
    const spy = vi.spyOn(agentRegistry, 'loadAgentTrust');

    const agentName = `t24-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
          requestId: `req_t24_${agentName}`,
          skillName: 'x',
          skillContent: 'y',
        },
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('T26 — stage save_skill end-to-end with REAL on-disk trust.yaml (R3-C5)', async () => {
    // End-to-end gate-activation pin. Verifies that a real on-disk trust.yaml
    // with `save_skill: draft` causes the dispatcher to stage the action in
    // pending_actions and skip execute() — using the existing dispatch()
    // helper (not raw dispatchIpcAction) so the compound-source path is real.
    const agentName = `t26-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
          requestId: `req_t26_${agentName}`,
          skillName: 't26-skill',
          skillContent: '# t26',
        },
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );

      // pending_actions has one row for this agent.
      const pending = getDb()
        .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
        .all(agentName) as Array<Record<string, unknown>>;
      expect(pending).toHaveLength(1);
      expect(pending[0].action_type).toBe('save_skill');

      // Skill file NOT written — execute() short-circuited at the gate.
      const skillFile = path.join(
        cwdTmp,
        'container',
        'skills',
        't26-skill',
        'SKILL.md',
      );
      expect(fs.existsSync(skillFile)).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('T28 — pending_actions.payload_json contains actual skillName + skillContent (R3-C6)', async () => {
    // Load-bearing roundtrip pin. Mutation pin for M4 — without the Phase 0a
    // payloadForStaging fix, this row would contain only `{type:'save_skill'}`
    // and /approve replay would fail with "missing required parameters."
    const agentName = `t28-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
          requestId: `req_t28_${agentName}`,
          skillName: 't28-skill',
          skillContent: '# real content',
        },
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );

      const pending = getDb()
        .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
        .all(agentName) as Array<Record<string, unknown>>;
      expect(pending).toHaveLength(1);
      const payload = JSON.parse(pending[0].payload_json as string);
      expect(payload).toEqual({
        type: 'save_skill',
        skillName: 't28-skill',
        skillContent: '# real content',
      });
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

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
      db: getDb(),
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crystallize-test-'));
    agentsTmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'crystallize-agents-'),
    );
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

  type CrystInput = {
    agent: string | undefined;
    name: string | undefined;
    description: string | undefined;
    source_task: string | undefined;
    body: string | undefined;
    confidence: number;
    agentsRoot: string | undefined;
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

  it('14. authorize succeeds for non-main caller and flows through the gate (Phase 4)', () => {
    // Phase 0b dropped the !ctx.isMain early-return.
    // Phase 4 (gate-activation): skipGate REMOVED — every call flows through
    // gateAndStage. Authorize returns non-null with NO skipGate field.
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = crystallizeSkillHandler.authorize(
      validInput() as unknown as CrystInput,
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBeUndefined();
    expect(auth!.payloadForStaging.type).toBe('crystallize_skill');
  });

  it('15. authorize returns non-null with NO skipGate field for main caller (Phase 4)', () => {
    // Phase 4: main caller no longer bypasses gate. Returns non-null + the
    // staging payload (agentsRoot intentionally NOT included — test-only seam).
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const auth = crystallizeSkillHandler.authorize(
      validInput() as unknown as CrystInput,
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBeUndefined();
    expect(auth!.payloadForStaging.type).toBe('crystallize_skill');
  });

  // Tests 16, 16b–16g pin per-field validation messages (M1 fix). Legacy
  // collapsed all 7 failure paths to one generic message, leaving agents
  // unable to self-correct. Each test isolates exactly one bad field and
  // asserts the field-specific message text.
  it('16. execute invalid agent identifier returns agent-specific message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const bad: CrystInput = {
      agent: 'BAD UPPER',
      name: 'skill1',
      description: 'd',
      source_task: 's',
      body: 'b',
      confidence: 5,
      agentsRoot: agentsTmpRoot,
    };
    const r = crystallizeSkillHandler.execute(bad, ctx);
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Invalid agent identifier. Use lowercase letters, numbers, underscores, or hyphens (1-64 chars).',
      },
    });
  });

  it('16b. execute invalid skill name returns name-specific message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const bad: CrystInput = {
      agent: 'agent1',
      name: 'BAD NAME',
      description: 'd',
      source_task: 's',
      body: 'b',
      confidence: 5,
      agentsRoot: agentsTmpRoot,
    };
    const r = crystallizeSkillHandler.execute(bad, ctx);
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Invalid skill name. Use lowercase letters, numbers, and hyphens (2-64 chars).',
      },
    });
  });

  it('16c. execute missing description returns description-specific message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const bad: CrystInput = {
      agent: 'agent1',
      name: 'skill1',
      description: undefined,
      source_task: 's',
      body: 'b',
      confidence: 5,
      agentsRoot: agentsTmpRoot,
    };
    const r = crystallizeSkillHandler.execute(bad, ctx);
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message: 'Missing required field: description.',
      },
    });
  });

  it('16d. execute missing source_task returns source_task-specific message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const bad: CrystInput = {
      agent: 'agent1',
      name: 'skill1',
      description: 'd',
      source_task: undefined,
      body: 'b',
      confidence: 5,
      agentsRoot: agentsTmpRoot,
    };
    const r = crystallizeSkillHandler.execute(bad, ctx);
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message: 'Missing required field: source_task.',
      },
    });
  });

  it('16e. execute missing body returns body-specific message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const bad: CrystInput = {
      agent: 'agent1',
      name: 'skill1',
      description: 'd',
      source_task: 's',
      body: undefined,
      confidence: 5,
      agentsRoot: agentsTmpRoot,
    };
    const r = crystallizeSkillHandler.execute(bad, ctx);
    expect(r).toEqual({
      executed: true,
      result: { success: false, message: 'Missing required field: body.' },
    });
  });

  it('16f. execute non-finite confidence returns confidence-type message', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const bad: CrystInput = {
      agent: 'agent1',
      name: 'skill1',
      description: 'd',
      source_task: 's',
      body: 'b',
      confidence: NaN,
      agentsRoot: agentsTmpRoot,
    };
    const r = crystallizeSkillHandler.execute(bad, ctx);
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Invalid confidence. Must be a finite number between 1 and 10.',
      },
    });
  });

  it.each([
    ['below range', 0],
    ['above range', 11],
  ])(
    '16g. execute confidence out of range (%s) returns confidence-range message',
    (_label, value) => {
      const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
      const bad: CrystInput = {
        agent: 'agent1',
        name: 'skill1',
        description: 'd',
        source_task: 's',
        body: 'b',
        confidence: value,
        agentsRoot: agentsTmpRoot,
      };
      const r = crystallizeSkillHandler.execute(bad, ctx);
      expect(r).toEqual({
        executed: true,
        result: {
          success: false,
          message:
            'Invalid confidence. Must be a finite number between 1 and 10.',
        },
      });
    },
  );

  it('17b. idempotency: invoking twice with same agent/name overwrites SKILL.md AND appends second log.jsonl line', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const firstInput: CrystInput = {
      agent: 'agent1',
      name: 'skill1',
      description: 'first description',
      source_task: 'first task',
      body: '## First Body\n',
      confidence: 5,
      agentsRoot: agentsTmpRoot,
    };
    const secondInput: CrystInput = {
      agent: 'agent1',
      name: 'skill1',
      description: 'second description',
      source_task: 'second task',
      body: '## Second Body\n',
      confidence: 9,
      agentsRoot: agentsTmpRoot,
    };

    // First invocation
    const r1 = crystallizeSkillHandler.execute(firstInput, ctx);
    expect(r1).toMatchObject({
      executed: true,
      result: { success: true },
    });

    // Second invocation — same agent + name, different content
    const r2 = crystallizeSkillHandler.execute(secondInput, ctx);
    expect(r2).toMatchObject({
      executed: true,
      result: { success: true },
    });

    // SKILL.md should reflect the SECOND invocation (overwrite, not append)
    const file = path.join(
      agentsTmpRoot,
      'agent1',
      'skills',
      'crystallized',
      'skill1',
      'SKILL.md',
    );
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('description: "second description"');
    expect(content).toContain('confidence: 9');
    expect(content).toContain('## Second Body');
    expect(content).not.toContain('first description');
    expect(content).not.toContain('## First Body');

    // log.jsonl should have TWO lines (append-only audit trail)
    const logFile = path.join(
      agentsTmpRoot,
      'agent1',
      'skills',
      'crystallized',
      'log.jsonl',
    );
    const lines = fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);
    expect(parsed1.source_task).toBe('first task');
    expect(parsed1.confidence).toBe(5);
    expect(parsed2.source_task).toBe('second task');
    expect(parsed2.confidence).toBe(9);
  });

  it('17. execute happy path writes SKILL.md AND appends log.jsonl with literal key set', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const input: CrystInput = {
      agent: 'agent1',
      name: 'skill1',
      description: 'desc',
      source_task: 'task',
      body: '## Steps\n',
      confidence: 8,
      agentsRoot: agentsTmpRoot,
    };
    const r = crystallizeSkillHandler.execute(input, ctx);
    expect(r).toMatchObject({
      executed: true,
      result: {
        success: true,
        message: 'Crystallized skill "skill1" saved for agent1.',
      },
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
    // R3 H4: pin literal key set
    expect(Object.keys(parsed).sort()).toEqual([
      'agent',
      'confidence',
      'name',
      'source_task',
      'ts',
    ]);
  });

  it('18. agentsRoot positive: vitest env honors override → writes land in tmpdir', () => {
    expect(
      process.env.VITEST === 'true' || process.env.NODE_ENV === 'test',
    ).toBe(true);
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
      },
      ctx,
    );
    expect(
      fs.existsSync(
        path.join(
          agentsTmpRoot,
          'agent-pos',
          'skills',
          'crystallized',
          'skill-pos',
          'SKILL.md',
        ),
      ),
    ).toBe(true);
  });

  it('19. agentsRoot negative: env-gate refuses override when neither VITEST nor NODE_ENV=test', () => {
    const origVitest = process.env.VITEST;
    const origNodeEnv = process.env.NODE_ENV;
    // Unique agent name keeps the production-AGENTS_DIR fallback write
    // contained to a known cleanup target. Without this, the negative
    // test pollutes data/agents/ on every run.
    const negAgentName = `agent-neg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const negAgentDir = path.join(DATA_DIR, 'agents', negAgentName);
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
      const denyTmp = fs.mkdtempSync(
        path.join(os.tmpdir(), 'crystallize-deny-'),
      );
      try {
        crystallizeSkillHandler.execute(
          {
            agent: negAgentName,
            name: 'skill-neg',
            description: 'd',
            source_task: 's',
            body: 'b',
            confidence: 5,
            agentsRoot: denyTmp,
          },
          ctx,
        );
        // Override was refused — denyTmp must stay empty.
        expect(fs.readdirSync(denyTmp)).toEqual([]);
        // Positive proof the env-gate routed to production AGENTS_DIR
        // (rather than silently no-op'ing). Without this, a future bug
        // that disables the entire execute path would pass test 19
        // by virtue of denyTmp staying empty for the wrong reason.
        const productionFile = path.join(
          negAgentDir,
          'skills',
          'crystallized',
          'skill-neg',
          'SKILL.md',
        );
        expect(fs.existsSync(productionFile)).toBe(true);
      } finally {
        fs.rmSync(denyTmp, { recursive: true, force: true });
      }
    } finally {
      if (origVitest !== undefined) process.env.VITEST = origVitest;
      else delete process.env.VITEST;
      if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
      else delete process.env.NODE_ENV;
      // Clean up the production-AGENTS_DIR write (proof the env-gate
      // honored the production code path and ignored the override).
      fs.rmSync(negAgentDir, { recursive: true, force: true });
    }
  });

  it('20. integration: gate-activation — main caller stages crystallize_skill in pending_actions (Phase 4)', async () => {
    // Phase 4 flipped this: pre-Phase-4 the skipGate bypass let execute()
    // run, writing SKILL.md + zero audit/pending rows. Post-Phase-4 the gate
    // reads trust.yaml. We write `crystallize_skill: draft` explicitly
    // (mirroring Test 11 and the migration script's Phase 1 writes) so
    // trust_level lands as 'draft' — NOT the 'ask' fail-safe path. This
    // pins that the migrated trust.yaml entry is what's actually consulted
    // (caught by Phase 4 code review: without explicit draft, the test
    // would still pass via fail-safe and silently miss a regression where
    // crystallize_skill: draft never got written to disk).
    const agentName = `test-crystal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  crystallize_skill: draft\n',
    );

    try {
      await dispatch(
        validInput({ agent: 'crystal-target' }),
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );

      // SKILL.md NOT written — execute() short-circuited at the gate.
      const file = path.join(
        agentsTmpRoot,
        'crystal-target',
        'skills',
        'crystallized',
        'test-skill-1',
        'SKILL.md',
      );
      expect(fs.existsSync(file)).toBe(false);

      // agent_actions row written by checkTrustAndStage (outcome=staged,
      // trust_level=draft — not 'ask' — confirming the on-disk entry was
      // consulted, not the missing-entry fail-safe).
      const actionRows = getDb()
        .prepare('SELECT * FROM agent_actions WHERE agent_name = ?')
        .all(agentName) as Array<Record<string, unknown>>;
      expect(actionRows).toHaveLength(1);
      expect(actionRows[0].action_type).toBe('crystallize_skill');
      expect(actionRows[0].outcome).toBe('staged');
      expect(actionRows[0].trust_level).toBe('draft');

      // pending_actions row written; agent must /approve to invoke.
      const pendingRows = getDb()
        .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
        .all(agentName) as Array<Record<string, unknown>>;
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0].action_type).toBe('crystallize_skill');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('21. integration: non-agent caller path — non-main dispatch with no agentName executes inline (Phase 4)', async () => {
    // Phase 4: skipGate is gone, but the gate's NON_AGENT_DECISION short-
    // circuit (trust-gate.ts:35 `if (!input.agentName) return NON_AGENT_DECISION`)
    // still allows non-agent callers through. compoundSource here is bare
    // `SOURCE_GROUP` (no `--agent` suffix), so buildContext parses
    // agentName=null; the gate returns allowed=true without consulting any
    // trust.yaml; execute() runs and writes both the SKILL.md + result file.
    //
    // Pre-Phase-4 this passed via the skipGate bypass for the same outcome;
    // post-Phase-4 it passes via the non-agent decision path. Test is
    // structurally identical — the underlying mechanism changed.
    await dispatch(
      validInput({ agent: 'crystal-target-nonmain' }),
      SOURCE_GROUP,
      false,
    );

    const skillResultsDir = path.join(
      dataDir,
      'ipc',
      SOURCE_GROUP,
      'skill_results',
    );
    const entries = fs.existsSync(skillResultsDir)
      ? fs.readdirSync(skillResultsDir)
      : [];
    expect(entries).toContain('req-crystal.json');

    expect(
      fs.existsSync(path.join(agentsTmpRoot, 'crystal-target-nonmain')),
    ).toBe(true);
  });

  it('22. path-traversal: agent regex rejects "../etc" → invalid agent message', () => {
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
      },
      ctx,
    );
    expect(r).toEqual({
      executed: true,
      result: {
        success: false,
        message:
          'Invalid agent identifier. Use lowercase letters, numbers, underscores, or hyphens (1-64 chars).',
      },
    });
    // Verify no SKILL.md was written via path traversal. We check the
    // specific subpath the handler would have created (skills/crystallized/
    // <name>/SKILL.md) rather than asserting `../etc` itself does not exist
    // — the latter is host-environment-dependent (macOS sometimes creates
    // an /etc subdirectory in $TMPDIR for unrelated reasons), making the
    // assertion flaky.
    const traversalTarget = path.join(
      agentsTmpRoot,
      '..',
      'etc',
      'skills',
      'crystallized',
      'skill1',
      'SKILL.md',
    );
    expect(fs.existsSync(traversalTarget)).toBe(false);
    // Also verify agentsTmpRoot itself is empty (no writes landed even
    // partially via the rejected path).
    expect(fs.readdirSync(agentsTmpRoot)).toEqual([]);
  });

  it('T27.5 — payloadForStaging contains actual agent/name/description/source_task/body/confidence, not just {type}', () => {
    // Mutation-pin for M4 (revert payloadForStaging to {type:'crystallize_skill'} stub).
    // Phase 0a fix — see T26.5 docblock.
    const auth = crystallizeSkillHandler.authorize(
      {
        agent: 'claire',
        name: 'my-pattern',
        description: 'a learned pattern',
        source_task: 'task-123',
        body: '# Pattern\nBody',
        confidence: 8,
        agentsRoot: undefined,
      },
      {
        sourceGroup: 'telegram_claire',
        isMain: true,
        baseGroup: 'telegram_claire',
        agentName: 'claire',
        requestId: null,
        registeredGroups: {},
        deps: {} as any,
        dataDir: '/tmp/test',
      },
    );
    expect(auth).not.toBeNull();
    expect((auth as any).payloadForStaging).toEqual({
      type: 'crystallize_skill',
      agent: 'claire',
      name: 'my-pattern',
      description: 'a learned pattern',
      source_task: 'task-123',
      body: '# Pattern\nBody',
      confidence: 8,
    });
  });

  it('T-non-main-crystallize — crystallize_skill authorize succeeds for non-main groups', () => {
    const auth = crystallizeSkillHandler.authorize(
      {
        agent: 'einstein',
        name: 'x',
        description: 'd',
        source_task: 's',
        body: 'b',
        confidence: 5,
        agentsRoot: undefined,
      },
      {
        sourceGroup: 'telegram_lab-claw--einstein',
        isMain: false,
        baseGroup: 'telegram_lab-claw',
        agentName: 'einstein',
        requestId: null,
        registeredGroups: {},
        deps: {} as any,
        dataDir: '/tmp/test',
      },
    );
    expect(auth).not.toBeNull();
  });

  // Phase 4 gate-activation tests (T25, T27, T29). Behavior assertions
  // replacing the previous tautological "no skipGate field" pin.
  it('T25 — dispatch crystallize_skill invokes gateAndStage (not skipGate)', async () => {
    // R3-I3 amendment: behavior assertion. loadAgentTrust MUST fire under
    // Phase 4. Pre-Phase-4 the skipGate path short-circuited before
    // gateAndStage so loadAgentTrust never fired.
    const agentRegistry = await import('../../agent-registry.js');
    const spy = vi.spyOn(agentRegistry, 'loadAgentTrust');

    const agentName = `t25-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  crystallize_skill: draft\n',
    );

    try {
      await dispatch(
        {
          type: 'crystallize_skill',
          requestId: `req_t25_${agentName}`,
          agent: 'einstein',
          name: 'x',
          description: 'd',
          source_task: 's',
          body: 'b',
          confidence: 5,
        },
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('T27 — stage crystallize_skill end-to-end with REAL on-disk trust.yaml (R3-C5)', async () => {
    // End-to-end gate-activation pin. Mirror of T26 for the crystallize_skill
    // handler. Uses the existing dispatch() helper (compound-source path).
    const agentName = `t27-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  crystallize_skill: draft\n',
    );

    try {
      await dispatch(
        {
          type: 'crystallize_skill',
          requestId: `req_t27_${agentName}`,
          agent: 'einstein',
          name: 't27-pattern',
          description: 'd',
          source_task: 's',
          body: '# body',
          confidence: 7,
        },
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );

      const pending = getDb()
        .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
        .all(agentName) as Array<Record<string, unknown>>;
      expect(pending).toHaveLength(1);
      expect(pending[0].action_type).toBe('crystallize_skill');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('T29 — pending_actions.payload_json contains all crystallize_skill fields (R3-C6)', async () => {
    // Load-bearing roundtrip pin. Mutation pin for M4 — without the Phase 0a
    // payloadForStaging fix, this row would contain only
    // `{type:'crystallize_skill'}` and /approve replay would fail validation.
    // agentsRoot is intentionally NOT in the expected payload (it's a test-
    // only seam that must never round-trip through staging; see authorize()
    // comment in skills.ts:630).
    const agentName = `t29-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  crystallize_skill: draft\n',
    );

    try {
      await dispatch(
        {
          type: 'crystallize_skill',
          requestId: `req_t29_${agentName}`,
          agent: 'einstein',
          name: 't29-pattern',
          description: 'desc',
          source_task: 'task-1',
          body: '# body',
          confidence: 7,
        },
        `${SOURCE_GROUP}--${agentName}`,
        true,
      );

      const pending = getDb()
        .prepare('SELECT * FROM pending_actions WHERE agent_name = ?')
        .all(agentName) as Array<Record<string, unknown>>;
      expect(pending).toHaveLength(1);
      const payload = JSON.parse(pending[0].payload_json as string);
      expect(payload).toEqual({
        type: 'crystallize_skill',
        agent: 'einstein',
        name: 't29-pattern',
        description: 'desc',
        source_task: 'task-1',
        body: '# body',
        confidence: 7,
      });
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

/**
 * SKIP_GATE_ALLOWLIST membership regression pins (spec Section E).
 *
 * Phase 4 update: save_skill + crystallize_skill have been REMOVED from
 * the allowlist as the policy flip goes live. T23 pins the new state;
 * T-allowlist-exact is a single regression sentinel for the whole list.
 * skill_invoked stays on the allowlist (R1 High 2 — skipGate is load-bearing
 * for the fire-and-forget telemetry path).
 */
describe('skill_* SKIP_GATE_ALLOWLIST membership', () => {
  it('T23 — save_skill and crystallize_skill are NOT in SKIP_GATE_ALLOWLIST (post-Phase-4)', () => {
    // After Phase 4, both handlers flow through gateAndStage.
    expect(SKIP_GATE_ALLOWLIST.has('save_skill')).toBe(false);
    expect(SKIP_GATE_ALLOWLIST.has('crystallize_skill')).toBe(false);
  });

  it('T-allowlist-exact — exact membership pin (R3-I4)', () => {
    // Single regression sentinel for the WHOLE allowlist. If any entry is
    // added, removed, or renamed without updating this list, the test
    // breaks loudly. Sorted-array compare so ordering changes do not break.
    const expected = [
      'crystallize_candidate',
      'crystallize_candidate_fetch',
      'dashboard_query',
      'imessage_list_contacts',
      'imessage_read',
      'imessage_search',
      'kg_query',
      'knowledge_search',
      'pageindex_fetch',
      'pageindex_index',
      'schedule_wakeup',
      'skill_invoked',
      'skill_search',
      'slack_dm_read',
      'task_add',
      'task_close',
      'task_list',
      'task_reopen',
    ].sort();
    expect([...SKIP_GATE_ALLOWLIST].sort()).toEqual(expected);
  });

  it('41. skill_invoked is on SKIP_GATE_ALLOWLIST (skipGate is load-bearing per R1 High 2)', () => {
    expect([...SKIP_GATE_ALLOWLIST]).toContain('skill_invoked');
  });
});

describe('SKIP_GATE_ALLOWLIST — crystallize candidate types', () => {
  it('contains crystallize_candidate (regression pin C3)', () => {
    expect(SKIP_GATE_ALLOWLIST.has('crystallize_candidate')).toBe(true);
  });
  it('contains crystallize_candidate_fetch (regression pin C5a)', () => {
    expect(SKIP_GATE_ALLOWLIST.has('crystallize_candidate_fetch')).toBe(true);
  });
});

/**
 * crystallize_candidate handler tests (Task 5 of R1). Notify-kind IPC that
 * lands the candidate row written by the Stop hook (Task 6) and DMs Telegram
 * CLAIRE. Eight tests pinning the adversarial-review fixes:
 *  - C1: DM to Telegram CLAIRE jid `tg:8475020901`
 *  - C2: race-safe via UNIQUE INDEX + INSERT OR IGNORE
 *  - C6: sha256 content_hash dedup key (not user-prompt)
 *  - I1: per-day DM cap (3/agent/day) — overflow persists, dm_message_id NULL
 *  - I7: swarm-safe — use data.agent (payload) NOT ctx.agentName
 *  - I8: sourceGroup verification — deny on mismatch with ctx.sourceGroup
 */
describe('crystallize_candidate handler', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('parses valid payload', () => {
    const parsed = crystallizeCandidateHandler.parse({
      type: 'crystallize_candidate',
      agent: 'marvin',
      sourceGroup: 'telegram_lab-claw',
      sourceJid: 'tg:-1003892106437',
      sessionId: 'sess-1',
      traceSummary: 'A'.repeat(600),
      toolSequence: [
        { tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.agent).toBe('marvin');
  });

  it('parse rejects missing fields', () => {
    expect(crystallizeCandidateHandler.parse({})).toBeNull();
    expect(
      crystallizeCandidateHandler.parse({
        type: 'crystallize_candidate',
        agent: 'm',
      }),
    ).toBeNull();
  });

  it('authorize is skipGate=true notify-only', () => {
    const ctx = buildTestCtx({
      sourceGroup: 'g',
      agentName: 'm',
    });
    const auth = crystallizeCandidateHandler.authorize(
      {
        agent: 'm',
        sourceGroup: 'g',
        sourceJid: 'j',
        sessionId: 's',
        traceSummary: '',
        toolSequence: [],
      },
      ctx,
    );
    expect(auth?.skipGate).toBe(true);
    expect(auth?.notifySummary).toBe('');
    expect(auth?.payloadForStaging.type).toBe('crystallize_candidate');
  });

  it('responseKind is notify, not result', () => {
    expect(crystallizeCandidateHandler.responseKind).toBe('notify');
  });

  it('rejects sourceGroup mismatch (I8)', async () => {
    const ctx = buildTestCtx({
      sourceGroup: 'telegram_lab-claw',
      agentName: 'marvin',
    });
    await crystallizeCandidateHandler.execute(
      {
        agent: 'marvin',
        sourceGroup: 'telegram_other', // mismatch
        sourceJid: 'j',
        sessionId: 's',
        traceSummary: 'A'.repeat(600),
        toolSequence: [
          { tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' },
        ],
      },
      ctx,
    );
    const rows = ctx.deps.db
      .prepare('SELECT * FROM crystallize_candidates')
      .all();
    expect(rows).toHaveLength(0);
  });

  it('uses data.agent over ctx.agentName (I7 swarm-safe)', async () => {
    const ctx = buildTestCtx({
      sourceGroup: 'telegram_lab-claw',
      agentName: 'claire',
    });
    await crystallizeCandidateHandler.execute(
      {
        agent: 'marvin', // payload says marvin
        sourceGroup: 'telegram_lab-claw',
        sourceJid: 'j',
        sessionId: 's',
        traceSummary: 'A'.repeat(600),
        toolSequence: [
          { tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' },
        ],
      },
      ctx,
    );
    const rows = ctx.deps.db
      .prepare(`SELECT agent FROM crystallize_candidates`)
      .all() as Array<{ agent: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe('marvin'); // payload, not ctx
  });

  it('INSERT OR IGNOREs duplicates (C2)', async () => {
    const ctx = buildTestCtx({ sourceGroup: 'g', agentName: 'm' });
    const payload = {
      agent: 'm',
      sourceGroup: 'g',
      sourceJid: 'j',
      sessionId: 's',
      traceSummary: 'A'.repeat(600),
      toolSequence: [
        { tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' },
      ],
    };
    await crystallizeCandidateHandler.execute(payload, ctx);
    await crystallizeCandidateHandler.execute(payload, ctx); // same content
    const rows = ctx.deps.db
      .prepare(`SELECT * FROM crystallize_candidates`)
      .all();
    expect(rows).toHaveLength(1);
  });

  it('skips DM when day-cap (3) reached, persists row (I1)', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const ctx = buildTestCtx({
      sourceGroup: 'g',
      agentName: 'm',
      sendMessage: sendMessage as unknown as (
        jid: string,
        text: string,
      ) => Promise<void>,
    });
    for (let i = 0; i < 4; i++) {
      await crystallizeCandidateHandler.execute(
        {
          agent: 'm',
          sourceGroup: 'g',
          sourceJid: 'j',
          sessionId: `s-${i}`,
          traceSummary: `A${i}`.repeat(300), // differ to avoid dedup
          toolSequence: [
            { tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' },
            { tool: `mcp__x${i}__y`, argSummary: 'a', resultSummary: 'b' },
            { tool: `mcp__y${i}__z`, argSummary: 'a', resultSummary: 'b' },
          ],
        },
        ctx,
      );
    }
    expect(sendMessage).toHaveBeenCalledTimes(3); // cap at 3
    const overflowRows = ctx.deps.db
      .prepare(
        `SELECT * FROM crystallize_candidates WHERE dm_message_id IS NULL`,
      )
      .all();
    expect(overflowRows).toHaveLength(1); // 4th row persisted, no DM
  });

  it('sends DM to Telegram CLAIRE jid (L3)', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const ctx = buildTestCtx({
      sourceGroup: 'g',
      agentName: 'm',
      sendMessage: sendMessage as unknown as (
        jid: string,
        text: string,
      ) => Promise<void>,
    });
    await crystallizeCandidateHandler.execute(
      {
        agent: 'm',
        sourceGroup: 'g',
        sourceJid: 'tg:-1234',
        sessionId: 's',
        traceSummary: 'A'.repeat(600),
        toolSequence: [
          { tool: 'mcp__qmd__query', argSummary: 'x', resultSummary: 'y' },
          { tool: 'mcp__honcho__profile', argSummary: 'a', resultSummary: 'b' },
          { tool: 'mcp__gmail__search', argSummary: 'c', resultSummary: 'd' },
        ],
      },
      ctx,
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0]).toBe('tg:8475020901'); // CLAIRE
  });
});
