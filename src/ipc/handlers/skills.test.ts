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
} from '../handler.js';
import {
  skillSearchHandler,
  skillInvokedHandler,
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
    expect(Object.keys(parsed).sort()).toEqual(['agent', 'name', 'sourceGroup', 'ts']);
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

    const skillResultsDir = path.join(dataDir, 'ipc', SOURCE_GROUP, 'skill_results');
    const entries = fs.existsSync(skillResultsDir) ? fs.readdirSync(skillResultsDir) : [];
    expect(entries).toEqual([]);

    const rows = getDb()
      .prepare("SELECT * FROM agent_actions WHERE action_type = 'skill_invoked'")
      .all();
    expect(rows).toHaveLength(0);
  });
});
