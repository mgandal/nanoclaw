import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock heavy dependencies that throw on import without env vars
vi.mock('./container-runtime.js', () => ({
  PROXY_BIND_HOST: '127.0.0.1',
  CONTAINER_HOST_GATEWAY: '192.168.64.1',
  CONTAINER_RUNTIME_BIN: 'container',
  ensureContainerRuntimeRunning: vi.fn(),
  cleanupOrphans: vi.fn(),
  hostGatewayArgs: vi.fn(() => []),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  setQmdReachable: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./credential-proxy.js', () => ({
  startCredentialProxy: vi.fn().mockResolvedValue({ close: vi.fn() }),
}));

vi.mock('./channels/index.js', () => ({}));
vi.mock('./channels/registry.js', () => ({
  getChannelFactory: vi.fn(),
  getRegisteredChannelNames: vi.fn(() => []),
}));
vi.mock('./channels/telegram.js', () => ({
  initBotPool: vi.fn(),
}));

vi.mock('./ipc.js', () => ({
  startIpcWatcher: vi.fn(),
}));

vi.mock('./remote-control.js', () => ({
  restoreRemoteControl: vi.fn(),
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
}));

vi.mock('./health-check.js', () => ({
  checkMcpEndpoint: vi.fn().mockResolvedValue({ reachable: true }),
}));

vi.mock('./system-alerts.js', () => ({
  appendAlert: vi.fn(),
}));

vi.mock('./task-scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
}));

vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(() => true),
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({})),
  shouldDropMessage: vi.fn(() => false),
}));

vi.mock('./session-commands.js', () => ({
  extractSessionCommand: vi.fn(() => null),
  handleSessionCommand: vi.fn().mockResolvedValue({ handled: false }),
  isSessionCommandAllowed: vi.fn(() => true),
}));

vi.mock('./watchers/gmail-watcher.js', () => ({
  GmailWatcher: vi.fn(),
}));

vi.mock('./watchers/calendar-watcher.js', () => ({
  CalendarWatcher: vi.fn(),
}));

vi.mock('./event-router.js', () => ({
  EventRouter: vi.fn(),
  TrustConfig: vi.fn(),
}));

vi.mock('./message-bus.js', () => ({
  MessageBus: vi.fn(() => ({
    pruneOld: vi.fn(),
  })),
}));

import {
  _initTestDatabase,
  _closeDatabase,
  storeChatMetadata,
  storeMessage,
  setSession,
  getSessionTimestamps,
  deleteSession,
  getAllSessions,
  touchSession,
  getNewMessages,
  getMessagesSince,
  getLastBotMessageSeq,
  setRouterState,
  getRouterState,
  storeMessageDirect,
} from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';
import {
  checkSessionExpiry,
  parseLastAgentSeq,
  isStaleSessionError,
} from './index-helpers.js';
import { getTriggerPattern, buildTriggerPattern } from './config.js';

// ---- DB-backed tests: session management ----

describe('session management (DB layer)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('setSession creates session with both timestamps', () => {
    setSession('telegram_claire', 'session-abc');
    const ts = getSessionTimestamps('telegram_claire');
    expect(ts.lastUsed).toBeDefined();
    expect(ts.createdAt).toBeDefined();
  });

  it('touchSession updates last_used without changing created_at', async () => {
    setSession('telegram_claire', 'session-abc');
    const before = getSessionTimestamps('telegram_claire');

    await new Promise((r) => setTimeout(r, 10));
    touchSession('telegram_claire');

    const after = getSessionTimestamps('telegram_claire');
    expect(after.createdAt).toBe(before.createdAt);
    expect(new Date(after.lastUsed!).getTime()).toBeGreaterThanOrEqual(
      new Date(before.lastUsed!).getTime(),
    );
  });

  it('deleteSession removes the session entirely', () => {
    setSession('telegram_claire', 'session-abc');
    deleteSession('telegram_claire');
    const sessions = getAllSessions();
    expect(sessions['telegram_claire']).toBeUndefined();
    const ts = getSessionTimestamps('telegram_claire');
    expect(ts.lastUsed).toBeUndefined();
    expect(ts.createdAt).toBeUndefined();
  });

  it('setSession preserves created_at on session ID change', async () => {
    setSession('telegram_claire', 'session-1');
    const first = getSessionTimestamps('telegram_claire');

    await new Promise((r) => setTimeout(r, 10));
    setSession('telegram_claire', 'session-2');

    const second = getSessionTimestamps('telegram_claire');
    expect(second.createdAt).toBe(first.createdAt);
    const sessions = getAllSessions();
    expect(sessions['telegram_claire']).toBe('session-2');
  });

  it('getAllSessions returns all active sessions', () => {
    setSession('group_a', 'sess-a');
    setSession('group_b', 'sess-b');
    const sessions = getAllSessions();
    expect(Object.keys(sessions)).toHaveLength(2);
    expect(sessions['group_a']).toBe('sess-a');
    expect(sessions['group_b']).toBe('sess-b');
  });
});

// ---- Pure function tests: session expiry ----

describe('checkSessionExpiry', () => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  it('returns null when session is fresh', () => {
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - 30 * 60 * 1000).toISOString(),
      new Date(now - 5 * 60 * 1000).toISOString(),
      TWO_HOURS,
      FOUR_HOURS,
    );
    expect(result).toBeNull();
  });

  it('returns "idle" when idle too long', () => {
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - 60 * 60 * 1000).toISOString(),
      new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      TWO_HOURS,
      FOUR_HOURS,
    );
    expect(result).toMatch(/idle/);
  });

  it('returns "max age" when total age exceeded', () => {
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - 5 * 60 * 60 * 1000).toISOString(),
      new Date(now - 1 * 60 * 1000).toISOString(),
      TWO_HOURS,
      FOUR_HOURS,
    );
    expect(result).toMatch(/max age/);
  });

  it('expires when lastUsed is undefined (Infinity idle)', () => {
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - 30 * 60 * 1000).toISOString(),
      undefined,
      TWO_HOURS,
      FOUR_HOURS,
    );
    expect(result).toMatch(/idle/);
  });

  it('expires when createdAt is undefined (Infinity total age)', () => {
    const now = Date.now();
    const result = checkSessionExpiry(
      undefined,
      new Date(now - 1000).toISOString(),
      TWO_HOURS,
      FOUR_HOURS,
    );
    expect(result).toMatch(/max age/);
  });

  it('max age takes priority over idle when both exceeded', () => {
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - 5 * 60 * 60 * 1000).toISOString(),
      new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      TWO_HOURS,
      FOUR_HOURS,
    );
    expect(result).toMatch(/max age/);
  });
});

// ---- Pure function tests: parseLastAgentSeq ----

describe('parseLastAgentSeq', () => {
  it('parses valid JSON', () => {
    const result = parseLastAgentSeq('{"chat1@g.us":42,"chat2@g.us":100}');
    expect(result).toEqual({ 'chat1@g.us': 42, 'chat2@g.us': 100 });
  });

  it('returns empty object for null/undefined', () => {
    expect(parseLastAgentSeq(null)).toEqual({});
    expect(parseLastAgentSeq(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseLastAgentSeq('')).toEqual({});
  });

  it('returns empty object for corrupted JSON', () => {
    expect(parseLastAgentSeq('{invalid json')).toEqual({});
  });

  it('returns empty object for non-object JSON (string)', () => {
    expect(parseLastAgentSeq('"hello"')).toEqual({});
  });

  it('returns empty object for array JSON', () => {
    expect(parseLastAgentSeq('[1,2,3]')).toEqual({});
  });
});

// ---- Pure function tests: isStaleSessionError ----

describe('isStaleSessionError', () => {
  it('detects "no conversation found" errors', () => {
    expect(isStaleSessionError('No conversation found for session xyz')).toBe(
      true,
    );
  });

  it('detects ENOENT .jsonl errors', () => {
    expect(isStaleSessionError('ENOENT: no such file /tmp/session.jsonl')).toBe(
      true,
    );
  });

  it('detects "session not found" errors', () => {
    expect(isStaleSessionError('Session ID abc123 not found')).toBe(true);
  });

  it('returns false for generic errors', () => {
    expect(isStaleSessionError('Container timeout exceeded')).toBe(false);
    expect(isStaleSessionError('Out of memory')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isStaleSessionError(null)).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });
});

// ---- getAvailableGroups ----

describe('getAvailableGroups', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('returns empty array when no chats exist', () => {
    _setRegisteredGroups({});
    const groups = getAvailableGroups();
    expect(groups).toEqual([]);
  });

  it('excludes __group_sync__ metadata chat', () => {
    storeChatMetadata(
      '__group_sync__',
      new Date().toISOString(),
      'sync',
      'telegram',
      true,
    );
    storeChatMetadata(
      'real-group@g.us',
      new Date().toISOString(),
      'Real Group',
      'telegram',
      true,
    );
    _setRegisteredGroups({
      'real-group@g.us': {
        name: 'Real',
        folder: 'telegram_real',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
    });
    const groups = getAvailableGroups();
    expect(groups.every((g) => g.jid !== '__group_sync__')).toBe(true);
    expect(groups).toHaveLength(1);
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'group1@g.us',
      new Date().toISOString(),
      'Group 1',
      'telegram',
      true,
    );
    storeChatMetadata(
      'group2@g.us',
      new Date().toISOString(),
      'Group 2',
      'telegram',
      true,
    );
    _setRegisteredGroups({
      'group1@g.us': {
        name: 'Group 1',
        folder: 'telegram_group1',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
    });
    const groups = getAvailableGroups();
    const g1 = groups.find((g) => g.jid === 'group1@g.us');
    const g2 = groups.find((g) => g.jid === 'group2@g.us');
    expect(g1?.isRegistered).toBe(true);
    expect(g2?.isRegistered).toBe(false);
  });

  it('excludes non-group chats (DMs)', () => {
    storeChatMetadata(
      'user@s.whatsapp.net',
      new Date().toISOString(),
      'Alice',
      'whatsapp',
      false,
    );
    _setRegisteredGroups({});
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// ---- Regression: session expiry boundary conditions ----

describe('checkSessionExpiry boundary conditions', () => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  it('returns null when idle time is exactly at threshold (not exceeded)', () => {
    // Edge case: idle === threshold should NOT expire (must be strictly >)
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - 60 * 60 * 1000).toISOString(), // 1h old
      new Date(now - TWO_HOURS).toISOString(), // exactly 2h idle
      TWO_HOURS,
      FOUR_HOURS,
    );
    // The function uses > not >=, so exactly at threshold should NOT expire
    expect(result).toBeNull();
  });

  it('returns null when total age is exactly at max threshold', () => {
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - FOUR_HOURS).toISOString(), // exactly 4h old
      new Date(now - 1000).toISOString(), // recently active
      TWO_HOURS,
      FOUR_HOURS,
    );
    // Exactly at threshold should NOT expire (strict >)
    expect(result).toBeNull();
  });

  it('expires when both createdAt and lastUsed are undefined', () => {
    const result = checkSessionExpiry(
      undefined,
      undefined,
      TWO_HOURS,
      FOUR_HOURS,
    );
    // Both Infinity, max age check comes first
    expect(result).toMatch(/max age/);
  });
});

// ---- Regression: startup recovery of unprocessed messages ----

describe('startup recovery (DB layer)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('getMessagesSince returns unprocessed messages after a given seq', () => {
    // Simulate messages that arrived while the process was down
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group1@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'Hello',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'msg-2',
      chat_jid: 'group1@g.us',
      sender: 'user2',
      sender_name: 'User Two',
      content: 'World',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    // sinceSeq=0 means "get everything"
    const pending = getMessagesSince('group1@g.us', 0, 'Claire', 200);
    expect(pending).toHaveLength(2);
    expect(pending[0].content).toBe('Hello');
    expect(pending[1].content).toBe('World');
  });

  it('getMessagesSince skips bot messages during recovery', () => {
    storeMessage({
      id: 'msg-user',
      chat_jid: 'group1@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'Hi there',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'msg-bot',
      chat_jid: 'group1@g.us',
      sender: 'bot',
      sender_name: 'Claire',
      content: 'Claire: I am here',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: true,
    });

    const pending = getMessagesSince('group1@g.us', 0, 'Claire', 200);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe('Hi there');
  });

  it('getLastBotMessageSeq recovers cursor from last bot reply', () => {
    storeMessage({
      id: 'msg-user-1',
      chat_jid: 'group1@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'First message',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'msg-bot-1',
      chat_jid: 'group1@g.us',
      sender: 'bot',
      sender_name: 'Claire',
      content: 'Claire: response',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: true,
    });
    storeMessage({
      id: 'msg-user-2',
      chat_jid: 'group1@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'After bot reply',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    // Recovery should find the bot message's seq
    const recoveredSeq = getLastBotMessageSeq('group1@g.us');
    expect(recoveredSeq).toBeGreaterThan(0);

    // Messages since recovered seq should only be the one after the bot reply
    const pending = getMessagesSince(
      'group1@g.us',
      recoveredSeq,
      'Claire',
      200,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe('After bot reply');
  });
});

// ---- Regression: duplicate message deduplication ----

describe('message deduplication (DB layer)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('storeMessage with same ID replaces rather than duplicates', () => {
    const msg = {
      id: 'dup-msg-1',
      chat_jid: 'group1@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'Original',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    };
    storeMessage(msg);
    storeMessage({ ...msg, content: 'Updated' });

    const messages = getMessagesSince('group1@g.us', 0, 'Claire', 200);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Updated');
  });

  it('getNewMessages groups messages by chat_jid correctly', () => {
    storeMessage({
      id: 'g1-msg-1',
      chat_jid: 'group1@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'Group 1 message',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'g2-msg-1',
      chat_jid: 'group2@g.us',
      sender: 'user2',
      sender_name: 'User Two',
      content: 'Group 2 message',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      0,
      'Claire',
      200,
    );
    expect(messages).toHaveLength(2);

    // Verify messages come from different groups
    const byGroup = new Map<string, typeof messages>();
    for (const m of messages) {
      const existing = byGroup.get(m.chat_jid) || [];
      existing.push(m);
      byGroup.set(m.chat_jid, existing);
    }
    expect(byGroup.size).toBe(2);
    expect(byGroup.get('group1@g.us')).toHaveLength(1);
    expect(byGroup.get('group2@g.us')).toHaveLength(1);
  });
});

// ---- Regression: /new command session reset (DB layer) ----

describe('/new command session reset', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('deleteSession removes session and timestamps completely', () => {
    setSession('telegram_claire', 'session-xyz');
    const before = getSessionTimestamps('telegram_claire');
    expect(before.createdAt).toBeDefined();
    expect(before.lastUsed).toBeDefined();

    deleteSession('telegram_claire');

    const after = getSessionTimestamps('telegram_claire');
    expect(after.createdAt).toBeUndefined();
    expect(after.lastUsed).toBeUndefined();

    const sessions = getAllSessions();
    expect(sessions['telegram_claire']).toBeUndefined();
  });

  it('new session after /new reset gets fresh timestamps', async () => {
    setSession('telegram_claire', 'session-old');
    const oldTs = getSessionTimestamps('telegram_claire');

    await new Promise((r) => setTimeout(r, 10));

    // Simulate /new: delete then create new session
    deleteSession('telegram_claire');
    setSession('telegram_claire', 'session-new');

    const newTs = getSessionTimestamps('telegram_claire');
    const sessions = getAllSessions();
    expect(sessions['telegram_claire']).toBe('session-new');
    // The new session's created_at should be later than the old one
    expect(new Date(newTs.createdAt!).getTime()).toBeGreaterThan(
      new Date(oldTs.createdAt!).getTime(),
    );
  });
});

// ---- Regression: trigger pattern matching ----

describe('trigger pattern matching', () => {
  it('getTriggerPattern matches trigger at start of message', () => {
    const pattern = getTriggerPattern('@Claire');
    expect(pattern.test('@Claire hello')).toBe(true);
    expect(pattern.test('@Claire')).toBe(true);
  });

  it('getTriggerPattern is case-insensitive', () => {
    const pattern = getTriggerPattern('@Claire');
    expect(pattern.test('@claire hello')).toBe(true);
    expect(pattern.test('@CLAIRE test')).toBe(true);
  });

  it('getTriggerPattern does not match trigger mid-message', () => {
    const pattern = getTriggerPattern('@Claire');
    expect(pattern.test('hey @Claire')).toBe(false);
  });

  it('getTriggerPattern requires word boundary after trigger', () => {
    const pattern = getTriggerPattern('@Claire');
    // "@Clairely" should NOT match because \b word boundary
    expect(pattern.test('@Clairely')).toBe(false);
  });

  it('getTriggerPattern uses default trigger when undefined', () => {
    // getTriggerPattern(undefined) should use DEFAULT_TRIGGER
    const pattern = getTriggerPattern(undefined);
    expect(pattern).toBeInstanceOf(RegExp);
  });
});

// ---- Regression: stale session error detection ----

describe('isStaleSessionError edge cases', () => {
  it('detects case-insensitive "session not found"', () => {
    expect(isStaleSessionError('SESSION NOT FOUND for id abc')).toBe(true);
  });

  it('detects ENOENT with .jsonl in path', () => {
    expect(
      isStaleSessionError(
        'Error: ENOENT: no such file or directory, open "/data/sessions/abc.jsonl"',
      ),
    ).toBe(true);
  });

  it('does not false-positive on "session" without "not found"', () => {
    expect(isStaleSessionError('session started successfully')).toBe(false);
  });

  it('does not false-positive on ENOENT without .jsonl', () => {
    expect(isStaleSessionError('ENOENT: no such file /tmp/config.json')).toBe(
      false,
    );
  });
});

// ---- Regression: session touch on all code paths ----

describe('session touch tracking (DB layer)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('touchSession is idempotent on non-existent session', () => {
    // touchSession on a session that doesn't exist should not throw
    expect(() => touchSession('nonexistent-group')).not.toThrow();
    // And should not create a session
    const sessions = getAllSessions();
    expect(sessions['nonexistent-group']).toBeUndefined();
  });

  it('multiple touchSession calls update last_used monotonically', async () => {
    setSession('telegram_claire', 'session-abc');
    const ts1 = getSessionTimestamps('telegram_claire');

    await new Promise((r) => setTimeout(r, 10));
    touchSession('telegram_claire');
    const ts2 = getSessionTimestamps('telegram_claire');

    await new Promise((r) => setTimeout(r, 10));
    touchSession('telegram_claire');
    const ts3 = getSessionTimestamps('telegram_claire');

    expect(new Date(ts2.lastUsed!).getTime()).toBeGreaterThanOrEqual(
      new Date(ts1.lastUsed!).getTime(),
    );
    expect(new Date(ts3.lastUsed!).getTime()).toBeGreaterThanOrEqual(
      new Date(ts2.lastUsed!).getTime(),
    );
    // created_at stays the same throughout
    expect(ts3.createdAt).toBe(ts1.createdAt);
  });
});

// ---- Regression: parseLastAgentSeq robustness ----

describe('parseLastAgentSeq edge cases', () => {
  it('handles numeric JSON value (not an object)', () => {
    expect(parseLastAgentSeq('42')).toEqual({});
  });

  it('handles boolean JSON value', () => {
    expect(parseLastAgentSeq('true')).toEqual({});
  });

  it('handles null JSON value', () => {
    expect(parseLastAgentSeq('null')).toEqual({});
  });

  it('handles deeply nested but valid object', () => {
    const input = JSON.stringify({ 'chat1@g.us': 42, nested: { a: 1 } });
    const result = parseLastAgentSeq(input);
    expect(result['chat1@g.us']).toBe(42);
    // Nested objects pass through (the function only validates top-level is object)
    expect(result.nested).toEqual({ a: 1 });
  });
});

// ---- TDD hardening: session expiry 1ms past threshold ----

describe('checkSessionExpiry: 1ms past threshold (strict > boundary)', () => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  it('expires when idle time is 1ms past threshold', () => {
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - 60 * 60 * 1000).toISOString(), // 1h old (within max age)
      new Date(now - TWO_HOURS - 1).toISOString(), // 2h + 1ms idle
      TWO_HOURS,
      FOUR_HOURS,
    );
    expect(result).toMatch(/idle/);
  });

  it('expires when total age is 1ms past max threshold', () => {
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - FOUR_HOURS - 1).toISOString(), // 4h + 1ms total
      new Date(now - 1000).toISOString(), // recently active
      TWO_HOURS,
      FOUR_HOURS,
    );
    expect(result).toMatch(/max age/);
  });

  it('max age at exactly threshold + idle past threshold still returns idle', () => {
    // If total age is exactly at max (not exceeded) but idle exceeds, we get idle
    const now = Date.now();
    const result = checkSessionExpiry(
      new Date(now - FOUR_HOURS).toISOString(), // exactly at max (not exceeded)
      new Date(now - TWO_HOURS - 1).toISOString(), // idle exceeded
      TWO_HOURS,
      FOUR_HOURS,
    );
    // totalAge === FOUR_HOURS, not >, so max age doesn't trigger
    // idleAge > TWO_HOURS, so idle triggers
    expect(result).toMatch(/idle/);
  });
});

// ---- TDD hardening: session full lifecycle (create → expire → re-create) ----

describe('session full lifecycle: create → expire check → re-create', () => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('expired session can be deleted and recreated with fresh timestamps', async () => {
    // Phase 1: Create session
    setSession('telegram_test', 'session-v1');
    const v1 = getSessionTimestamps('telegram_test');
    expect(v1.createdAt).toBeDefined();
    expect(v1.lastUsed).toBeDefined();

    // Phase 2: Simulate expiry check (using real timestamps shifted back)
    // We can't actually wait 2h, so we check the logic directly
    const expiryReason = checkSessionExpiry(
      new Date(Date.now() - FOUR_HOURS - 1).toISOString(),
      new Date(Date.now() - TWO_HOURS - 1).toISOString(),
      TWO_HOURS,
      FOUR_HOURS,
    );
    expect(expiryReason).toBeTruthy();

    // Phase 3: Delete (simulating what runAgent does on expiry)
    deleteSession('telegram_test');
    const deleted = getAllSessions();
    expect(deleted['telegram_test']).toBeUndefined();
    const deletedTs = getSessionTimestamps('telegram_test');
    expect(deletedTs.createdAt).toBeUndefined();

    // Phase 4: Re-create fresh session
    await new Promise((r) => setTimeout(r, 5));
    setSession('telegram_test', 'session-v2');
    const v2 = getSessionTimestamps('telegram_test');
    expect(v2.createdAt).toBeDefined();
    expect(getAllSessions()['telegram_test']).toBe('session-v2');
    // New timestamps are strictly after the old ones
    expect(new Date(v2.createdAt!).getTime()).toBeGreaterThan(
      new Date(v1.createdAt!).getTime(),
    );
  });
});

// ---- TDD hardening: getMessagesSince respects limit ----

describe('getMessagesSince respects MAX_MESSAGES_PER_PROMPT limit', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('returns at most `limit` messages even when more exist', () => {
    // Insert 10 messages
    for (let i = 0; i < 10; i++) {
      storeMessage({
        id: `msg-limit-${i}`,
        chat_jid: 'group-limit@g.us',
        sender: 'user1',
        sender_name: 'User One',
        content: `Message ${i}`,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });
    }

    // Request with limit=5
    const limited = getMessagesSince('group-limit@g.us', 0, 'Claire', 5);
    expect(limited).toHaveLength(5);
    // Should return the LATEST 5 messages (most recent)
    // Verify ordering — messages should be in ascending seq order
    for (let i = 1; i < limited.length; i++) {
      expect(limited[i].seq).toBeGreaterThan(limited[i - 1].seq);
    }
  });

  it('returns all messages when count is under limit', () => {
    storeMessage({
      id: 'msg-under-limit-1',
      chat_jid: 'group-under@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'Only message',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    const result = getMessagesSince('group-under@g.us', 0, 'Claire', 200);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Only message');
  });
});

// ---- TDD hardening: getNewMessages with empty JID list ----

describe('getNewMessages edge cases', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('returns empty array when JID list is empty', () => {
    // Store a message that would normally be returned
    storeMessage({
      id: 'msg-orphan',
      chat_jid: 'group-orphan@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'Orphan message',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    const { messages, newSeq } = getNewMessages([], 0, 'Claire', 200);
    expect(messages).toHaveLength(0);
    // newSeq should be 0 when no messages are returned
    expect(newSeq).toBe(0);
  });

  it('only returns messages for specified JIDs', () => {
    storeMessage({
      id: 'msg-included',
      chat_jid: 'group-include@g.us',
      sender: 'user1',
      sender_name: 'User',
      content: 'Included',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'msg-excluded',
      chat_jid: 'group-exclude@g.us',
      sender: 'user2',
      sender_name: 'User 2',
      content: 'Excluded',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    const { messages } = getNewMessages(
      ['group-include@g.us'],
      0,
      'Claire',
      200,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Included');
  });
});

// ---- TDD hardening: buildTriggerPattern with regex-special characters ----

describe('buildTriggerPattern with special regex characters', () => {
  it('safely escapes dots in trigger name', () => {
    const pattern = buildTriggerPattern('@Dr.Smith');
    // Should match literal dot, not regex "any character"
    expect(pattern.test('@Dr.Smith hello')).toBe(true);
    expect(pattern.test('@DrXSmith hello')).toBe(false);
  });

  it('matches triggers ending in non-word chars like parentheses', () => {
    const pattern = buildTriggerPattern('@Bot(1)');
    expect(pattern.test('@Bot(1) do stuff')).toBe(true);
    expect(pattern.test('@Bot(1)')).toBe(true); // trigger at end of string
    expect(pattern.test('@Bot1 do stuff')).toBe(false);
  });

  it('safely escapes plus sign in trigger name', () => {
    const pattern = buildTriggerPattern('@C++Bot');
    expect(pattern.test('@C++Bot hello')).toBe(true);
    expect(pattern.test('@CCBot hello')).toBe(false);
  });

  it('matches triggers ending in $ using lookahead boundary', () => {
    const pattern = buildTriggerPattern('$$$');
    expect(pattern.test('$$$ help')).toBe(true);
    expect(pattern.test('$$$')).toBe(true); // trigger at end of string
    expect(pattern.test('$$$extra')).toBe(false); // no boundary — should not match
    expect(pattern.test('xxx help')).toBe(false);
  });
});

// ---- TDD hardening: isStaleSessionError with multi-line errors ----

describe('isStaleSessionError with real container error formats', () => {
  it('detects stale session in multi-line error output', () => {
    const multiLineError =
      'Error running container agent:\n' +
      'stderr: No conversation found for session abc-123-def\n' +
      'exit code: 1';
    expect(isStaleSessionError(multiLineError)).toBe(true);
  });

  it('detects ENOENT .jsonl in verbose error stack', () => {
    const stackError =
      'Error: ENOENT: no such file or directory, open ' +
      "'/data/sessions/telegram_claire/abc123.jsonl'\n" +
      '    at Object.openSync (node:fs:123:3)\n' +
      '    at readFileSync (node:fs:456:7)';
    expect(isStaleSessionError(stackError)).toBe(true);
  });

  it('does not match "session" in unrelated context', () => {
    expect(
      isStaleSessionError('Starting new session for group telegram_claire'),
    ).toBe(false);
  });

  it('handles empty string', () => {
    expect(isStaleSessionError('')).toBe(false);
  });
});

// ---- TDD hardening: storeMessage with minimal fields ----

describe('storeMessage with minimal / edge-case payloads', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('empty content messages are stored but filtered from getMessagesSince', () => {
    // getMessagesSince intentionally filters content != '' AND content IS NOT NULL
    // to avoid sending empty messages to the agent. This is correct behavior.
    storeMessage({
      id: 'msg-empty-content',
      chat_jid: 'group1@g.us',
      sender: 'user1',
      sender_name: 'User',
      content: '',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    const msgs = getMessagesSince('group1@g.us', 0, 'Claire', 200);
    expect(msgs).toHaveLength(0); // empty content is filtered out by design
  });

  it('stores message with undefined optional fields', () => {
    storeMessage({
      id: 'msg-minimal',
      chat_jid: 'group1@g.us',
      sender: 'user1',
      sender_name: 'User',
      content: 'hello',
      timestamp: new Date().toISOString(),
      // is_from_me and is_bot_message intentionally omitted
    });

    const msgs = getMessagesSince('group1@g.us', 0, 'Claire', 200);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('hello');
  });

  it('stores and retrieves message with unicode/emoji content', () => {
    const unicodeContent = 'Hello \u{1F600} \u{1F4DD} \u4F60\u597D';
    storeMessage({
      id: 'msg-unicode',
      chat_jid: 'group1@g.us',
      sender: 'user1',
      sender_name: 'User',
      content: unicodeContent,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    const msgs = getMessagesSince('group1@g.us', 0, 'Claire', 200);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe(unicodeContent);
  });
});

// ---- TDD hardening: router state persistence ----

describe('router state persistence round-trip', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('getRouterState returns undefined for missing key', () => {
    const val = getRouterState('nonexistent_key');
    expect(val).toBeUndefined();
  });

  it('setRouterState + getRouterState round-trips correctly', () => {
    setRouterState('test_key', 'test_value');
    expect(getRouterState('test_key')).toBe('test_value');
  });

  it('setRouterState overwrites existing value', () => {
    setRouterState('overwrite_key', 'first');
    setRouterState('overwrite_key', 'second');
    expect(getRouterState('overwrite_key')).toBe('second');
  });

  it('last_agent_seq JSON round-trips through router state', () => {
    const agentSeq = { 'chat1@g.us': 42, 'chat2@g.us': 100 };
    setRouterState('last_agent_seq', JSON.stringify(agentSeq));
    const raw = getRouterState('last_agent_seq');
    const parsed = parseLastAgentSeq(raw);
    expect(parsed).toEqual(agentSeq);
  });

  it('handles large sequence numbers without precision loss', () => {
    const largeSeq = { 'chat@g.us': 2147483647 }; // INT32_MAX
    setRouterState('last_agent_seq', JSON.stringify(largeSeq));
    const parsed = parseLastAgentSeq(getRouterState('last_agent_seq'));
    expect(parsed['chat@g.us']).toBe(2147483647);
  });
});
