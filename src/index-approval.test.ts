import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, insertPendingAction } from './db.js';

/**
 * Phase 3 integration tests for /pending, /approve, /reject slash-command
 * preprocessing in src/index.ts. Separated from src/index.test.ts because
 * that file vi.mocks ./session-commands.js globally — these tests need
 * the real handleApprovalCommand path (spec R3-C4).
 *
 * These tests exercise the exported handleApprovalSlashCommand directly
 * (it's a pure helper that takes injected deps), so no main-loop spin-up
 * is required.
 */
describe('src/index.ts approval slash-command wiring (Phase 3)', () => {
  let sentMessages: string[];

  beforeEach(() => {
    sentMessages = [];
    _initTestDatabase();
  });

  function stubSendMessage(): (text: string) => Promise<void> {
    return async (text: string) => {
      sentMessages.push(text);
    };
  }

  it("T11 — /pending from main group lists all groups' pending rows", async () => {
    const id1 = insertPendingAction({
      agent_name: 'claire',
      group_folder: 'telegram_claire',
      action_type: 'save_skill',
      summary: 'skill-1',
      payload: {},
    });
    const id2 = insertPendingAction({
      agent_name: 'einstein',
      group_folder: 'telegram_lab-claw',
      action_type: 'crystallize_skill',
      summary: 'pattern-1',
      payload: {},
    });

    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: '/pending',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });

    expect(replied).toBe(true);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain(id1);
    expect(sentMessages[0]).toContain(id2);
  });

  it('T12 — /pending from LAB-claw lists only LAB-claw rows', async () => {
    insertPendingAction({
      agent_name: 'claire',
      group_folder: 'telegram_claire',
      action_type: 'save_skill_main_marker',
      summary: 'main-summary',
      payload: {},
    });
    const idLab = insertPendingAction({
      agent_name: 'einstein',
      group_folder: 'telegram_lab-claw',
      action_type: 'crystallize_skill',
      summary: 'lab-summary',
      payload: {},
    });

    const { handleApprovalSlashCommand } = await import('./index.js');
    await handleApprovalSlashCommand({
      text: '/pending',
      sourceGroupFolder: 'telegram_lab-claw',
      isMainGroup: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });

    // Header should say "(1):", not "(2):"
    expect(sentMessages[0]).toMatch(/Pending \(1\):/);
    expect(sentMessages[0]).toContain(idLab);
    // Use non-id markers to avoid Math.random()/Date.now() substring collisions
    // when both inserts land in the same ms with a short random suffix.
    expect(sentMessages[0]).not.toContain('save_skill_main_marker');
    expect(sentMessages[0]).not.toContain('main-summary');
  });

  it('T13 — /pending empty queue replies "No pending actions."', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    await handleApprovalSlashCommand({
      text: '/pending',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(sentMessages[0]).toBe('No pending actions.');
  });

  it('T17 — /approve with no id replies usage hint', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: '/approve',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(replied).toBe(true);
    expect(sentMessages[0]).toContain('Usage');
    expect(sentMessages[0]).toContain('/approve');
  });

  it('T18 — /approve with whitespace args replies usage hint', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: '/approve pa abc def',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(replied).toBe(true);
    expect(sentMessages[0]).toContain('Usage');
  });

  it('T22 — /approve this is a great idea triggers usage hint (multi-word arg)', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: '/approve this is a great idea',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(replied).toBe(true);
    expect(sentMessages[0]).toContain('Usage');
  });

  it('T-noncmd — random text returns false (let agent handle)', async () => {
    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: 'hello what is the weather',
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(replied).toBe(false);
    expect(sentMessages.length).toBe(0);
  });

  it('T-reject-wiring — /reject <id> routes through to handleApprovalCommand (pins prefix regex includes reject)', async () => {
    // Mutation pin: if a future refactor drops 'reject' from the wrapper's
    // prefix regex (src/index.ts), this test fails because /reject would
    // fall through to natural language instead of being consumed.
    // Parsing+handler of /reject is covered by session-commands.test.ts;
    // this test verifies the WIRING (prefix-regex route) only.
    const id = insertPendingAction({
      agent_name: 'claire',
      group_folder: 'telegram_claire',
      action_type: 'save_skill',
      summary: 'reject-target',
      payload: {},
    });
    const { handleApprovalSlashCommand } = await import('./index.js');
    const replied = await handleApprovalSlashCommand({
      text: `/reject ${id}`,
      sourceGroupFolder: 'telegram_claire',
      isMainGroup: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { registeredGroups: () => ({}) } as any,
      sendMessage: stubSendMessage(),
    });
    expect(replied).toBe(true);
    // handleApprovalCommand returns `Rejected ${id}.` on the reject path
    // (src/session-commands.ts:253-255).
    expect(sentMessages[0]).toContain('Rejected');
    expect(sentMessages[0]).toContain(id);
  });
});
