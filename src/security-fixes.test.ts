/**
 * Tests for upstream security and bug fixes.
 *
 * Phase 1: Baseline tests that PROVE the bugs exist (marked with "BUG:")
 * Phase 2: After fixes are applied, these same tests prove the fixes work.
 * Phase 3: Guardrail tests that prevent regressions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  _initTestDatabase,
  _closeDatabase,
  getLastBotMessageSeq,
  getMessagesSince,
  setRegisteredGroup,
  getRegisteredGroup,
  storeMessage,
  storeChatMetadata,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';
import {
  CONTAINER_RUNTIME_BIN,
  stopContainer,
} from './container-runtime.js';

// ─── 1. stopContainer: command injection via name ───────────────────

describe('stopContainer security', () => {
  it('accepts valid container names', () => {
    const cmd = stopContainer('nanoclaw-telegram_claire-1711500000000');
    expect(cmd).toContain('nanoclaw-telegram_claire-1711500000000');
  });

  it('accepts names with dots and dashes', () => {
    const cmd = stopContainer('nanoclaw-lab.claw-123');
    expect(cmd).toContain('nanoclaw-lab.claw-123');
  });

  // BUG: These should throw but currently don't — shell metacharacters
  // are passed directly into the command string.
  it('rejects names with semicolons (command injection)', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow();
  });

  it('rejects names with backticks (command injection)', () => {
    expect(() => stopContainer('foo`whoami`')).toThrow();
  });

  it('rejects names with $() (command injection)', () => {
    expect(() => stopContainer('foo$(whoami)')).toThrow();
  });

  it('rejects names with spaces', () => {
    expect(() => stopContainer('foo bar')).toThrow();
  });

  it('rejects empty names', () => {
    expect(() => stopContainer('')).toThrow();
  });

  // Guardrail: the return type must stay string (for async exec caller)
  it('returns a string command (preserves async caller compatibility)', () => {
    const result = stopContainer('nanoclaw-test-123');
    expect(typeof result).toBe('string');
    expect(result).toBe(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`);
  });
});

// ─── 2. mount-security: colon in container path ─────────────────────

// isValidContainerPath is not exported, so we test through validateMount
import { validateMount, loadMountAllowlist } from './mount-security.js';

describe('mount-security: container path validation', () => {
  // BUG: Colons in container paths can override Docker -v readonly flags
  // e.g., a containerPath of "repo:rw" in a -v flag becomes -v host:repo:rw
  it('rejects container paths containing colons', () => {
    const result = validateMount(
      { hostPath: '/tmp/test', containerPath: 'repo:rw', readonly: true },
      true,
    );
    // After fix: rejected at containerPath validation with "Invalid container path"
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/invalid container path/i);
  });
});

// ─── 3. IPC: isMain preservation on register_group ──────────────────

describe('IPC register_group preserves isMain', () => {
  const MAIN_GROUP: RegisteredGroup = {
    name: 'CLAIRE',
    folder: 'telegram_claire',
    trigger: '@Claire',
    added_at: '2024-01-01T00:00:00.000Z',
    isMain: true,
  };

  let groups: Record<string, RegisteredGroup>;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    groups = {
      'tg:123': { ...MAIN_GROUP },
    };
    setRegisteredGroup('tg:123', MAIN_GROUP);

    deps = {
      sendMessage: async () => {},
      registeredGroups: () => groups,
      registerGroup: (jid, group) => {
        groups[jid] = group;
        setRegisteredGroup(jid, group);
      },
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
    };
  });

  // BUG: register_group IPC updates strip isMain, corrupting DB permanently
  it('preserves isMain=true when group is re-registered via IPC', async () => {
    // Simulate an IPC register_group (e.g., agent adds additionalMounts)
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'tg:123',
        name: 'CLAIRE',
        folder: 'telegram_claire',
        trigger: '@Claire',
        containerConfig: { additionalMounts: [] },
        requiresTrigger: false,
      },
      'telegram_claire', // sourceGroup = same group (self-registration)
      true,              // isMain source
      deps,
    );

    // Check in-memory state
    expect(groups['tg:123'].isMain).toBe(true);

    // Check DB state (the permanent record)
    const dbGroup = getRegisteredGroup('tg:123');
    expect(dbGroup?.isMain).toBe(true);
  });

  it('does not set isMain for groups that never had it', async () => {
    // Register a new non-main group
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'tg:456',
        name: 'OTHER',
        folder: 'telegram_other',
        trigger: '@Other',
        requiresTrigger: true,
      },
      'telegram_claire',
      true,
      deps,
    );

    expect(groups['tg:456'].isMain).toBeUndefined();
  });
});

// ─── 4. Message overflow: cursor recovery + limit ───────────────────

describe('message overflow protection', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
  });

  it('returns up to 200 messages when sinceSeq is 0 (current default)', () => {
    // Store 15 messages
    for (let i = 1; i <= 15; i++) {
      storeMessage({
        id: `msg-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        is_from_me: false,
      });
    }

    // With sinceSeq=0 and no explicit limit, all 15 come back
    const msgs = getMessagesSince('group@g.us', 0, 'Andy');
    expect(msgs.length).toBe(15);
  });

  // Guardrail: explicit limit parameter should be respected
  it('respects explicit limit parameter', () => {
    for (let i = 1; i <= 15; i++) {
      storeMessage({
        id: `msg-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        is_from_me: false,
      });
    }

    const msgs = getMessagesSince('group@g.us', 0, 'Andy', 5);
    expect(msgs.length).toBe(5);
    // Should be the 5 most recent (due to ORDER BY rowid DESC LIMIT, then re-sort)
    expect(msgs[0].content).toBe('message 11');
    expect(msgs[4].content).toBe('message 15');
  });

  // Guardrail: bot messages should be excluded
  it('excludes bot messages from results', () => {
    storeMessage({
      id: 'msg-user',
      chat_jid: 'group@g.us',
      sender: 'user@s.net',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'msg-bot',
      chat_jid: 'group@g.us',
      sender: 'bot@s.net',
      sender_name: 'Andy',
      content: 'Andy: response',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: true,
    });

    const msgs = getMessagesSince('group@g.us', 0, 'Andy');
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('hello');
  });
});

// ─── 4b. Cursor recovery: getLastBotMessageSeq ─────────────────────

describe('getLastBotMessageSeq', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
  });

  it('returns 0 when no bot messages exist', () => {
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.net',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    expect(getLastBotMessageSeq('group@g.us')).toBe(0);
  });

  it('returns 0 for an unknown chat', () => {
    expect(getLastBotMessageSeq('unknown@g.us')).toBe(0);
  });

  it('returns the rowid of the last bot message', () => {
    // Store user message first
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.net',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    // Store a bot reply — must set is_bot_message explicitly
    storeMessage({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: 'bot@s.net',
      sender_name: 'Andy',
      content: 'Andy: hi there',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    // Store another user message after the bot reply
    storeMessage({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'user@s.net',
      sender_name: 'User',
      content: 'thanks',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });

    const seq = getLastBotMessageSeq('group@g.us');
    // Bot message should have a positive rowid
    expect(seq).toBeGreaterThan(0);

    // Using this seq as cursor should return only messages after the bot reply
    const msgs = getMessagesSince('group@g.us', seq, 'Andy');
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('thanks');
  });
});

// ─── 5. Env parser: single-char value ───────────────────────────────
//
// The env parser is tested via a dedicated file that isolates the
// parsing logic without touching the real .env.
// See env-parser.test.ts
