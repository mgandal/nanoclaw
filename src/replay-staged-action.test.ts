import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { _resetHandlersForTests, registerIpcHandler } from './ipc/handler.js';
import { _initTestDatabase } from './db.js';

describe('replayStagedAction', () => {
  let tmpDir: string;
  let deps: any;

  beforeEach(() => {
    _resetHandlersForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
    _initTestDatabase();
    deps = {
      registeredGroups: () => ({}),
      messageBus: { publish: vi.fn() },
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('T1 — replayStagedAction(save_skill payload) invoked directly returns formatted result string', async () => {
    const executeMock = vi.fn(async () => ({
      executed: true,
      result: { success: true, message: 'saved skill: foo' },
    }));
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: executeMock,
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    const result = await replayStagedAction({
      action_type: 'save_skill',
      payload: { type: 'save_skill', skillName: 'foo', skillContent: '#x' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('foo');
  });

  it('T2 — replayStagedAction(crystallize_skill payload) invoked directly returns formatted result', async () => {
    const executeMock = vi.fn(async () => ({
      executed: true,
      result: { success: true, message: 'crystallized: pattern-a' },
    }));
    registerIpcHandler({
      type: 'crystallize_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: executeMock,
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    const result = await replayStagedAction({
      action_type: 'crystallize_skill',
      payload: {
        type: 'crystallize_skill',
        agent: 'claire',
        name: 'pattern-a',
        description: 'd',
        source_task: 's',
        body: '# body',
        confidence: 7,
      },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('pattern-a');
  });

  it('T3 — unknown action_type throws "No handler registered for action_type: X"', async () => {
    const { replayStagedAction } = await import('./replay-staged-action.js');
    await expect(
      replayStagedAction({
        action_type: 'definitely_not_a_handler',
        payload: {},
        group_folder: 'telegram_claire',
        agent_name: 'claire',
        deps,
      }),
    ).rejects.toThrow(
      /No handler registered for action_type: definitely_not_a_handler/,
    );
  });

  it('T5 — handler throw propagates', async () => {
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async () => {
        throw new Error('disk full');
      },
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    await expect(
      replayStagedAction({
        action_type: 'save_skill',
        payload: { skillName: 'x', skillContent: 'y' },
        group_folder: 'telegram_claire',
        agent_name: 'claire',
        deps,
      }),
    ).rejects.toThrow(/disk full/);
  });

  it('T6 — MUTATION PIN: replayStagedAction does NOT call checkTrustAndStage (D5 — approval is the authorization)', async () => {
    const trustEnforcement = await import('./trust-enforcement.js');
    const spy = vi.spyOn(trustEnforcement, 'checkTrustAndStage');

    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async () => ({
        executed: true,
        result: { success: true, message: 'ok' },
      }),
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    await replayStagedAction({
      action_type: 'save_skill',
      payload: { skillName: 'x', skillContent: 'y' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('T10b — replayStagedAction calls buildContext with real deps, NOT a stubbed object', async () => {
    let capturedCtx: any = null;
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async (_input, ctx) => {
        capturedCtx = ctx;
        return { executed: true, result: { success: true, message: 'ok' } };
      },
    });

    // isMain now derives from the ORIGIN group's registration (H4 fix) —
    // register telegram_claire as main so the tier assertion stays true.
    deps.registeredGroups = () => ({
      'tg:main1': { name: 'Main', folder: 'telegram_claire', isMain: true },
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    await replayStagedAction({
      action_type: 'save_skill',
      payload: { skillName: 'x', skillContent: 'y' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.deps).toBe(deps);
    expect(capturedCtx.sourceGroup).toBe('telegram_claire');
    expect(capturedCtx.isMain).toBe(true);
    expect(capturedCtx.requestId).toBe(null);
  });

  it('T9 — handler returning {executed:false} surfaces as "execution bailed" message', async () => {
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async () => ({ executed: false }),
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    const result = await replayStagedAction({
      action_type: 'save_skill',
      payload: { skillName: 'x', skillContent: 'y' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(result).toContain('bailed');
  });

  it('T-result-falsy — handler returning {success:false, message} surfaces the message verbatim', async () => {
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: (r) => r as any,
      authorize: () => null,
      execute: async () => ({
        executed: true,
        result: { success: false, message: 'name already exists' },
      }),
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    const result = await replayStagedAction({
      action_type: 'save_skill',
      payload: { skillName: 'x', skillContent: 'y' },
      group_folder: 'telegram_claire',
      agent_name: 'claire',
      deps,
    });

    expect(result).toContain('name already exists');
  });

  it('T-parse-rejected — handler.parse(payload)===null throws "rejected stored payload at parse() time"', async () => {
    // Production scenario: pending_actions.payload_json corruption produces
    // a shape the handler's parse() can't validate. Surface as a clear error
    // BEFORE execute() runs — execute would otherwise receive garbage.
    registerIpcHandler({
      type: 'save_skill',
      responseKind: 'result',
      resultsDirName: 'skill_results',
      parse: () => null,
      authorize: () => null,
      execute: async () => {
        throw new Error('execute should NOT fire when parse rejects');
      },
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    await expect(
      replayStagedAction({
        action_type: 'save_skill',
        payload: { malformed: true },
        group_folder: 'telegram_claire',
        agent_name: 'claire',
        deps,
      }),
    ).rejects.toThrow(
      /Handler save_skill rejected stored payload at parse\(\) time/,
    );
  });

  it('H4 fix — replay context carries the ORIGIN group tier, not a blanket isMain=true', async () => {
    // A staged action from a NON-main group must replay with isMain=false so
    // execute-time tier checks (send_file pass-through/blocklist, dashboard
    // scoping) still apply. Approval bypasses the gate, not the caller tier.
    let seenIsMain: boolean | null = null;
    registerIpcHandler({
      type: 'send_file',
      parse: (r: unknown) => r as any,
      authorize: () => null,
      execute: async (_input: any, ctx: any) => {
        seenIsMain = ctx.isMain;
      },
    } as any);

    deps.registeredGroups = () => ({
      'tg:main1': { name: 'Main', folder: 'telegram_main', isMain: true },
      'tg:other1': { name: 'Other', folder: 'telegram_other' },
    });

    const { replayStagedAction } = await import('./replay-staged-action.js');
    await replayStagedAction({
      action_type: 'send_file',
      payload: { chatJid: 'tg:other1', filePath: '/etc/passwd' },
      group_folder: 'telegram_other',
      agent_name: 'einstein',
      deps,
    });
    expect(seenIsMain).toBe(false);

    // Origin main replays as main (unchanged legitimate behavior).
    seenIsMain = null;
    await replayStagedAction({
      action_type: 'send_file',
      payload: { chatJid: 'tg:main1', filePath: '/tmp/x.pdf' },
      group_folder: 'telegram_main',
      agent_name: 'claire',
      deps,
    });
    expect(seenIsMain).toBe(true);

    // Unregistered origin (group removed since staging) fails safe: non-main.
    seenIsMain = null;
    await replayStagedAction({
      action_type: 'send_file',
      payload: { chatJid: 'tg:gone', filePath: '/tmp/x.pdf' },
      group_folder: 'telegram_gone',
      agent_name: 'einstein',
      deps,
    });
    expect(seenIsMain).toBe(false);
  });
});
