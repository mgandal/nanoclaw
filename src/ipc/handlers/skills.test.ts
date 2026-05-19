import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  saveSkillHandler,
  crystallizeSkillHandler,
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
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = saveSkillHandler.authorize(
      { skillName: 'foo', skillContent: 'body' },
      ctx,
    );
    expect(auth).toBeNull();
  });

  it('4. authorize returns non-null with skipGate:true for main caller', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
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

  it('12. integration: non-main dispatch silently blocks — skill_results/ empty, no file written', async () => {
    await dispatch(
      {
        type: 'save_skill',
        requestId: 'req-nonmain',
        skillName: 'should-not-save',
        skillContent: 'body',
      },
      SOURCE_GROUP,
      false,
    );

    const skillResultsDir = path.join(dataDir, 'ipc', SOURCE_GROUP, 'skill_results');
    const entries = fs.existsSync(skillResultsDir)
      ? fs.readdirSync(skillResultsDir)
      : [];
    expect(entries).toEqual([]);

    expect(
      fs.existsSync(path.join(cwdTmp, 'container', 'skills', 'should-not-save')),
    ).toBe(false);
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

  it('14. authorize returns null for non-main caller (R2 Critical 1 preserves legacy block)', () => {
    const ctx = buildContext(SOURCE_GROUP, false, deps, dataDir);
    const auth = crystallizeSkillHandler.authorize(
      validInput() as unknown as CrystInput,
      ctx,
    );
    expect(auth).toBeNull();
  });

  it('15. authorize returns non-null with skipGate:true for main caller', () => {
    const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
    const auth = crystallizeSkillHandler.authorize(
      validInput() as unknown as CrystInput,
      ctx,
    );
    expect(auth).not.toBeNull();
    expect(auth!.skipGate).toBe(true);
  });

  it('16. execute invalid payload returns exact failure message', () => {
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
      result: { success: false, message: 'Invalid crystallize_skill payload.' },
    });
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
      },
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
    // Unique agent name keeps the production-AGENTS_DIR fallback write
    // contained to a known cleanup target. Without this, the negative
    // test pollutes data/agents/ on every run.
    const negAgentName = `agent-neg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const negAgentDir = path.join(DATA_DIR, 'agents', negAgentName);
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      const ctx = buildContext(SOURCE_GROUP, true, deps, dataDir);
      const denyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crystallize-deny-'));
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
      },
      ctx,
    );
    expect(r).toEqual({
      executed: true,
      result: { success: false, message: 'Invalid crystallize_skill payload.' },
    });
    expect(fs.existsSync(path.join(agentsTmpRoot, '..', 'etc'))).toBe(false);
  });
});

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
