import { describe, it, expect, vi } from 'vitest';
import {
  extractApprovalCommand,
  extractSessionCommand,
  handleApprovalCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toBe('/compact');
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage & { seq: number }> = {},
): NewMessage & { seq: number } {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    seq: 1,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith(1);
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith(1);
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith(1);
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99', seq: 1 }),
      makeMsg('/compact', { timestamp: '100', seq: 2 }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99', seq: 1 }),
      makeMsg('/compact', { timestamp: '100', seq: 2 }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  // --- NEW REGRESSION TESTS ---

  it('handles /new command: forwards to agent and advances cursor', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith('/new', expect.any(Function));
    expect(deps.advanceCursor).toHaveBeenCalledWith(1);
    expect(deps.setTyping).toHaveBeenCalledWith(true);
    expect(deps.setTyping).toHaveBeenCalledWith(false);
  });

  it('/new during active container execution: reports failure when agent errors', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'error', result: 'Container busy' });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    // Should send the error output AND a failure message
    expect(deps.sendMessage).toHaveBeenCalledWith('Container busy');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
    // Cursor still advances even on error
    expect(deps.advanceCursor).toHaveBeenCalledWith(1);
  });

  it('/compact forwards agent output to sendMessage', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'success', result: 'Context compacted.' });
        await onOutput({ status: 'success', result: null });
        return 'success';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('Context compacted.');
  });

  it('/compact with no active session still forwards to agent', async () => {
    // The session-commands module doesn't check session existence;
    // it always forwards to runAgent which handles session lifecycle
    const deps = makeDeps({
      runAgent: vi.fn().mockResolvedValue('success'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('returns handled:false for unknown slash commands', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/reset')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('rejects commands with extra args (not just the bare command)', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new force')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('is case-sensitive: /New and /COMPACT are not recognized', async () => {
    const deps = makeDeps();
    const result1 = await handleSessionCommand({
      missedMessages: [makeMsg('/New')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result1.handled).toBe(false);

    const result2 = await handleSessionCommand({
      missedMessages: [makeMsg('/COMPACT')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result2.handled).toBe(false);
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('handles /new followed by a regular message: only processes /new, leaves post-command messages pending', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('/new', { seq: 1 }),
      makeMsg('hello after reset', { seq: 2 }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith('/new', expect.any(Function));
    // Cursor advances to the command seq (1), NOT the post-command message (2)
    expect(deps.advanceCursor).toHaveBeenCalledWith(1);
  });

  it('handles multiple rapid /new commands: only processes the first one', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('/new', { seq: 1 }),
      makeMsg('/new', { seq: 2 }),
      makeMsg('/new', { seq: 3 }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    // Only one runAgent call for the first /new
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    expect(deps.runAgent).toHaveBeenCalledWith('/new', expect.any(Function));
    // Cursor advances to the first command only
    expect(deps.advanceCursor).toHaveBeenCalledWith(1);
  });

  it('strips internal tags from agent output before sending', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({
          status: 'success',
          result: 'Visible text <internal>hidden stuff</internal> more visible',
        });
        return 'success';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('Visible text  more visible');
  });
});

describe('extractApprovalCommand', () => {
  const tp = /@Claire\s*/i;

  it('parses /approve <id>', () => {
    expect(extractApprovalCommand('/approve pa-123-abc', tp)).toEqual({
      kind: 'approve',
      id: 'pa-123-abc',
    });
  });

  it('parses /reject <id>', () => {
    expect(extractApprovalCommand('/reject pa-xyz', tp)).toEqual({
      kind: 'reject',
      id: 'pa-xyz',
    });
  });

  it('parses /pending (no arg)', () => {
    expect(extractApprovalCommand('/pending', tp)).toEqual({ kind: 'pending' });
  });

  it('strips trigger prefix', () => {
    expect(extractApprovalCommand('@Claire /approve pa-42', tp)).toEqual({
      kind: 'approve',
      id: 'pa-42',
    });
  });

  it('rejects ids with invalid chars', () => {
    expect(extractApprovalCommand('/approve pa-foo/../bar', tp)).toBeNull();
  });

  it('returns null for non-approval text', () => {
    expect(extractApprovalCommand('hello world', tp)).toBeNull();
    expect(extractApprovalCommand('/compact', tp)).toBeNull();
  });
});

describe('handleApprovalCommand', () => {
  const makeDb = (rows: Record<string, any>) => {
    const statusUpdates: Array<[string, string, string?]> = [];
    return {
      statusUpdates,
      getPendingAction: (id: string) => rows[id] ?? null,
      listPendingActions: (opts: { groupFolder?: string }) =>
        Object.values(rows).filter((r: any) =>
          opts.groupFolder ? r.group_folder === opts.groupFolder : true,
        ) as any,
      updatePendingActionStatus: (id: string, status: any, result?: string) => {
        statusUpdates.push([id, status, result]);
        if (rows[id]) rows[id].status = status;
      },
    };
  };

  it('approve path calls execute and marks executed', async () => {
    const db = makeDb({
      'pa-1': {
        id: 'pa-1',
        group_folder: 'g',
        agent_name: 'marvin',
        action_type: 'send_message',
        summary: 'hi',
        payload_json: '{"chatJid":"tg:x","text":"hi"}',
        status: 'pending',
        created_at: new Date().toISOString(),
      },
    });
    const execute = vi.fn(async () => 'sent');
    const result = await handleApprovalCommand({
      command: { kind: 'approve', id: 'pa-1' },
      sourceGroupFolder: 'g',
      isMainGroup: false,
      db: db as any,
      execute,
    });
    expect(result).toContain('Approved');
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ action_type: 'send_message' }),
    );
    expect(db.statusUpdates.map((u) => u[1])).toEqual(['approved', 'executed']);
  });

  it('reject path marks rejected and does not execute', async () => {
    const db = makeDb({
      'pa-2': {
        id: 'pa-2',
        group_folder: 'g',
        agent_name: 'x',
        action_type: 'y',
        summary: 's',
        payload_json: '{}',
        status: 'pending',
        created_at: new Date().toISOString(),
      },
    });
    const execute = vi.fn(async () => 'no');
    const result = await handleApprovalCommand({
      command: { kind: 'reject', id: 'pa-2' },
      sourceGroupFolder: 'g',
      isMainGroup: false,
      db: db as any,
      execute,
    });
    expect(result).toContain('Rejected');
    expect(execute).not.toHaveBeenCalled();
    expect(db.statusUpdates[0][1]).toBe('rejected');
  });

  it('non-main cannot approve cross-group pending actions', async () => {
    const db = makeDb({
      'pa-3': {
        id: 'pa-3',
        group_folder: 'telegram_claire',
        agent_name: 'claire',
        action_type: 'send_message',
        summary: 'main-only',
        payload_json: '{}',
        status: 'pending',
        created_at: new Date().toISOString(),
      },
    });
    const execute = vi.fn(async () => 'x');
    const result = await handleApprovalCommand({
      command: { kind: 'approve', id: 'pa-3' },
      sourceGroupFolder: 'telegram_other',
      isMainGroup: false,
      db: db as any,
      execute,
    });
    expect(result).toMatch(/not in this group/);
    expect(execute).not.toHaveBeenCalled();
    expect(db.statusUpdates).toHaveLength(0);
  });

  it('already-processed rows cannot be re-approved', async () => {
    const db = makeDb({
      'pa-4': {
        id: 'pa-4',
        group_folder: 'g',
        agent_name: 'x',
        action_type: 'y',
        summary: 's',
        payload_json: '{}',
        status: 'executed',
        created_at: new Date().toISOString(),
      },
    });
    const result = await handleApprovalCommand({
      command: { kind: 'approve', id: 'pa-4' },
      sourceGroupFolder: 'g',
      isMainGroup: true,
      db: db as any,
      execute: vi.fn(),
    });
    expect(result).toMatch(/already executed/);
  });

  it('pending listing scopes non-main to own group', async () => {
    const db = makeDb({
      'pa-own': {
        id: 'pa-own',
        group_folder: 'telegram_other',
        agent_name: 'marvin',
        action_type: 'send_message',
        summary: 'own',
        payload_json: '{}',
        status: 'pending',
        created_at: new Date().toISOString(),
      },
      'pa-main': {
        id: 'pa-main',
        group_folder: 'telegram_claire',
        agent_name: 'claire',
        action_type: 'send_message',
        summary: 'confidential',
        payload_json: '{}',
        status: 'pending',
        created_at: new Date().toISOString(),
      },
    });
    const result = await handleApprovalCommand({
      command: { kind: 'pending' },
      sourceGroupFolder: 'telegram_other',
      isMainGroup: false,
      db: db as any,
      execute: vi.fn(),
    });
    expect(result).toContain('pa-own');
    expect(result).not.toContain('pa-main');
    expect(result).not.toContain('confidential');
  });

  it('execute failure marks failed', async () => {
    const db = makeDb({
      'pa-f': {
        id: 'pa-f',
        group_folder: 'g',
        agent_name: 'x',
        action_type: 'y',
        summary: 's',
        payload_json: '{}',
        status: 'pending',
        created_at: new Date().toISOString(),
      },
    });
    const execute = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await handleApprovalCommand({
      command: { kind: 'approve', id: 'pa-f' },
      sourceGroupFolder: 'g',
      isMainGroup: true,
      db: db as any,
      execute,
    });
    expect(result).toMatch(/failed.*boom/);
    expect(db.statusUpdates.map((u) => u[1])).toEqual(['approved', 'failed']);
  });
});
