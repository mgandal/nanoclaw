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
  saveSkillHandler,
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
 * SKIP_GATE_ALLOWLIST membership regression pins (spec Section E).
 *
 * Phase 4 removed save_skill from the allowlist (gate-activation flip);
 * the 2026-07-19 crystallize removal dropped the whole crystallize family
 * (crystallize_skill/candidate/fetch, skill_invoked) — handlers gone, so
 * their types must not linger as gate exemptions. T23 pins the absences;
 * T-allowlist-exact is a single regression sentinel for the whole list.
 */
describe('skill_* SKIP_GATE_ALLOWLIST membership', () => {
  it('T23 — save_skill and the removed crystallize family are NOT in SKIP_GATE_ALLOWLIST', () => {
    // save_skill flows through gateAndStage (Phase 4); the crystallize
    // family has no handlers at all (2026-07-19 removal) and must never
    // reappear as gate exemptions.
    expect(SKIP_GATE_ALLOWLIST.has('save_skill')).toBe(false);
    expect(SKIP_GATE_ALLOWLIST.has('crystallize_skill')).toBe(false);
    expect(SKIP_GATE_ALLOWLIST.has('crystallize_candidate')).toBe(false);
    expect(SKIP_GATE_ALLOWLIST.has('crystallize_candidate_fetch')).toBe(false);
    expect(SKIP_GATE_ALLOWLIST.has('skill_invoked')).toBe(false);
  });

  it('T-allowlist-exact — exact membership pin (R3-I4)', () => {
    // Single regression sentinel for the WHOLE allowlist. If any entry is
    // added, removed, or renamed without updating this list, the test
    // breaks loudly. Sorted-array compare so ordering changes do not break.
    // Batch 4 closure (2026-07-19): task_add / task_close / task_reopen /
    // pageindex_index removed — the last gate-bypassing writes now flow
    // through gateAndStage (trust.yaml `autonomous` for all 9 agents).
    // Crystallize removal (2026-07-19): crystallize_candidate /
    // crystallize_candidate_fetch / skill_invoked dropped with their
    // handlers.
    const expected = [
      'dashboard_query',
      'imessage_list_contacts',
      'imessage_read',
      'imessage_search',
      'kg_query',
      'knowledge_search',
      'pageindex_fetch',
      'schedule_wakeup',
      'skill_search',
      'slack_dm_read',
      'task_list',
    ].sort();
    expect([...SKIP_GATE_ALLOWLIST].sort()).toEqual(expected);
  });
});

