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
} from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';
import {
  checkSessionExpiry,
  parseLastAgentSeq,
  isStaleSessionError,
  getOrRecoverSeqPure,
} from './index-helpers.js';

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
    expect(
      isStaleSessionError('ENOENT: no such file /tmp/session.jsonl'),
    ).toBe(true);
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

// ---- Pure function tests: getOrRecoverSeqPure ----

describe('getOrRecoverSeqPure', () => {
  it('returns cached value when positive', () => {
    const lastAgentSeq: Record<string, number> = { 'chat@g.us': 42 };
    const result = getOrRecoverSeqPure('chat@g.us', lastAgentSeq, () => 0);
    expect(result.seq).toBe(42);
    expect(result.recovered).toBe(false);
  });

  it('recovers from DB when cached is 0', () => {
    const lastAgentSeq: Record<string, number> = { 'chat@g.us': 0 };
    const result = getOrRecoverSeqPure('chat@g.us', lastAgentSeq, () => 99);
    expect(result.seq).toBe(99);
    expect(result.recovered).toBe(true);
  });

  it('recovers from DB when cached is missing', () => {
    const lastAgentSeq: Record<string, number> = {};
    const result = getOrRecoverSeqPure('chat@g.us', lastAgentSeq, () => 50);
    expect(result.seq).toBe(50);
    expect(result.recovered).toBe(true);
  });

  it('returns 0 when both cache and DB have no data', () => {
    const lastAgentSeq: Record<string, number> = {};
    const result = getOrRecoverSeqPure('chat@g.us', lastAgentSeq, () => 0);
    expect(result.seq).toBe(0);
    expect(result.recovered).toBe(false);
  });

  it('does not use DB when cached is positive', () => {
    const dbLookup = vi.fn(() => 999);
    const lastAgentSeq: Record<string, number> = { 'chat@g.us': 10 };
    getOrRecoverSeqPure('chat@g.us', lastAgentSeq, dbLookup);
    expect(dbLookup).not.toHaveBeenCalled();
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
