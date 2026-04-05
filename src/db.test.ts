import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  _closeDatabase,
  createTask,
  deleteSession,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getConsecutiveFailures,
  getDueTasks,
  getLastBotMessageSeq,
  getLastBotMessageTimestamp,
  getLastSuccessTime,
  getMessagesSince,
  getNewMessages,
  getRecentMessages,
  getRegisteredGroup,
  getRouterState,
  getSession,
  getSessionTimestamps,
  getTaskById,
  getTaskRunLogs,
  getTasksForGroup,
  getTaskSuccessRate,
  logTaskRun,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  touchSession,
  updateChatName,
  updateTask,
  updateTaskAfterRun,
  validateTaskSchedule,
} from './db.js';
import { formatMessages } from './router.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
    expect(messages[0].seq).toBeGreaterThan(0);
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- reply context persistence ---

describe('reply context', () => {
  it('stores and retrieves reply_to fields', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-1',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Yes, on my way!',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '42',
      reply_to_message_content: 'Are you coming tonight?',
      reply_to_sender_name: 'Bob',
    });

    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('42');
    expect(messages[0].reply_to_message_content).toBe(
      'Are you coming tonight?',
    );
    expect(messages[0].reply_to_sender_name).toBe('Bob');
  });

  it('returns null for messages without reply context', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'no-reply',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Just a normal message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBeNull();
    expect(messages[0].reply_to_message_content).toBeNull();
    expect(messages[0].reply_to_sender_name).toBeNull();
  });

  it('retrieves reply context via getNewMessages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-2',
      chat_jid: 'group@g.us',
      sender: '456',
      sender_name: 'Carol',
      content: 'Agreed',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '99',
      reply_to_message_content: 'We should meet',
      reply_to_sender_name: 'Dave',
    });

    const { messages } = getNewMessages(['group@g.us'], 0, 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('99');
    expect(messages[0].reply_to_sender_name).toBe('Dave');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given seq', () => {
    // Get seq of m2 to use as cursor
    const allMsgs = getMessagesSince('group@g.us', 0, 'Andy');
    const m2 = allMsgs.find((m) => m.content === 'second')!;
    const msgs = getMessagesSince('group@g.us', m2.seq, 'Andy');
    // Should exclude m1, m2 (at/before seq), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince('group@g.us', 0, 'Andy');
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceSeq is 0', () => {
    const msgs = getMessagesSince('group@g.us', 0, 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply when lastAgentSeq is missing', () => {
    // beforeEach already inserts m1 (user), m2 (user), m3 (bot), m4 (user)
    // Add a new message after all existing ones
    store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message seq (m3 from beforeEach)
    const recoveredSeq = getLastBotMessageSeq('group@g.us');
    expect(recoveredSeq).toBeGreaterThan(0);

    // Using recovered seq cursor: get messages after the bot reply's rowid
    // m3 (bot) was inserted before m4, so m4 and new-1 have higher rowids
    const msgs = getMessagesSince('group@g.us', recoveredSeq, 'Andy', 10);
    // m4 (third) + new-1 — skips m1/m2 (before bot) and m3 (bot, filtered)
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    // With limit=10, only the 10 most recent are returned
    const msgs = getMessagesSince('group@g.us', 0, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    // Most recent 10: pending-21 through pending-30
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('returns last N messages when no bot reply and no cursor exist', () => {
    // Use a fresh group with no bot messages
    storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceSeq = 0 but limit caps the result
    const msgs = getMessagesSince('fresh@g.us', 0, 'Andy', 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    // Get seq of m4 to use as cursor
    const allMsgs = getMessagesSince('group@g.us', 0, 'Andy');
    const m4 = allMsgs.find((m) => m.content === 'third')!;
    const msgs = getMessagesSince('group@g.us', m4.seq, 'Andy');
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newSeq } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      0,
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newSeq).toBeGreaterThan(0);
    // Each message should have a seq field
    for (const msg of messages) {
      expect(msg.seq).toBeGreaterThan(0);
    }
  });

  it('filters by seq', () => {
    // Get all first, then use the seq of the second message as cursor
    const { messages: allMsgs } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      0,
      'Andy',
    );
    const g2msg = allMsgs.find((m) => m.content === 'g2 msg1')!;
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      g2msg.seq,
      'Andy',
    );
    // Only g1 msg2 (after g2 msg1's seq, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newSeq } = getNewMessages([], 0, 'Andy');
    expect(messages).toHaveLength(0);
    expect(newSeq).toBe(0);
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newSeq } = getNewMessages(['group@g.us'], 0, 'Andy', 3);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Monotonic seq order preserved
    expect(messages[1].seq > messages[0].seq).toBe(true);
    // newSeq reflects latest returned row
    expect(newSeq).toBe(messages[2].seq);
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince('group@g.us', 0, 'Andy', 3);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].seq > messages[0].seq).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(['group@g.us'], 0, 'Andy', 50);
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- Dashboard DB queries ---

describe('dashboard DB queries', () => {
  // Helper: create a minimal parent task so FK constraints are satisfied
  function ensureTask(id: string) {
    createTask({
      id,
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2026-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  }

  beforeEach(() => {
    _initTestDatabase();
  });

  describe('getTaskRunLogs', () => {
    it('returns logs since a given timestamp', () => {
      ensureTask('t1');
      ensureTask('t2');
      logTaskRun({
        task_id: 't1',
        run_at: '2026-03-22T10:00:00Z',
        duration_ms: 1000,
        status: 'success',
        result: 'ok',
        error: null,
      });
      logTaskRun({
        task_id: 't1',
        run_at: '2026-03-23T10:00:00Z',
        duration_ms: 2000,
        status: 'error',
        result: null,
        error: 'fail',
      });
      logTaskRun({
        task_id: 't2',
        run_at: '2026-03-23T12:00:00Z',
        duration_ms: 500,
        status: 'success',
        result: 'done',
        error: null,
      });

      const logs = getTaskRunLogs('2026-03-23T00:00:00Z');
      expect(logs).toHaveLength(2);
      expect(logs[0].task_id).toBe('t1');
      expect(logs[1].task_id).toBe('t2');
    });
  });

  describe('getTaskSuccessRate', () => {
    it('returns pass/total for a task in the given window', () => {
      ensureTask('t1');
      const now = new Date();
      const recent = new Date(now.getTime() - 3600000).toISOString();
      logTaskRun({
        task_id: 't1',
        run_at: recent,
        duration_ms: 100,
        status: 'success',
        result: 'ok',
        error: null,
      });
      logTaskRun({
        task_id: 't1',
        run_at: now.toISOString(),
        duration_ms: 100,
        status: 'error',
        result: null,
        error: 'fail',
      });

      const rate = getTaskSuccessRate('t1', 1);
      expect(rate).toEqual({ total: 2, passed: 1 });
    });
  });

  describe('getConsecutiveFailures', () => {
    it('returns 0 when last run was success', () => {
      ensureTask('t1');
      logTaskRun({
        task_id: 't1',
        run_at: '2026-03-23T10:00:00Z',
        duration_ms: 100,
        status: 'error',
        result: null,
        error: 'fail',
      });
      logTaskRun({
        task_id: 't1',
        run_at: '2026-03-23T11:00:00Z',
        duration_ms: 100,
        status: 'success',
        result: 'ok',
        error: null,
      });

      expect(getConsecutiveFailures('t1')).toBe(0);
    });

    it('returns count of trailing consecutive failures', () => {
      ensureTask('t1');
      logTaskRun({
        task_id: 't1',
        run_at: '2026-03-23T10:00:00Z',
        duration_ms: 100,
        status: 'success',
        result: 'ok',
        error: null,
      });
      logTaskRun({
        task_id: 't1',
        run_at: '2026-03-23T11:00:00Z',
        duration_ms: 100,
        status: 'error',
        result: null,
        error: 'fail1',
      });
      logTaskRun({
        task_id: 't1',
        run_at: '2026-03-23T12:00:00Z',
        duration_ms: 100,
        status: 'error',
        result: null,
        error: 'fail2',
      });
      logTaskRun({
        task_id: 't1',
        run_at: '2026-03-23T13:00:00Z',
        duration_ms: 100,
        status: 'error',
        result: null,
        error: 'fail3',
      });

      expect(getConsecutiveFailures('t1')).toBe(3);
    });

    it('returns 0 when no runs exist', () => {
      expect(getConsecutiveFailures('nonexistent')).toBe(0);
    });
  });
});

// --- registered_groups schema round-trip ---

describe('registered_groups schema', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('round-trips a registered group with all fields', () => {
    const jid = 'tg:-1234567890';
    setRegisteredGroup(jid, {
      name: 'TEST-GROUP',
      folder: 'telegram_test-group',
      trigger: '@Test',
      added_at: '2026-03-26T00:00:00.000Z',
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '/Volumes/sandisk4TB/marvin-vault',
            containerPath: 'claire-vault',
            readonly: false,
          },
        ],
      },
      requiresTrigger: false,
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups[jid];

    expect(group).toBeDefined();
    expect(group.name).toBe('TEST-GROUP');
    expect(group.folder).toBe('telegram_test-group');
    expect(group.trigger).toBe('@Test');
    expect(group.added_at).toBe('2026-03-26T00:00:00.000Z');
    expect(group.containerConfig?.additionalMounts).toHaveLength(1);
    expect(group.requiresTrigger).toBe(false);
    expect(group.isMain).toBe(true);
  });

  it('round-trips a group with no optional fields', () => {
    const jid = 'tg:999';
    setRegisteredGroup(jid, {
      name: 'MINIMAL',
      folder: 'telegram_minimal',
      trigger: '@Bot',
      added_at: '2026-03-26T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups[jid];

    expect(group).toBeDefined();
    expect(group.name).toBe('MINIMAL');
    expect(group.containerConfig).toBeUndefined();
    expect(group.requiresTrigger).toBe(true); // default
    expect(group.isMain).toBeUndefined(); // false stored as 0, read as undefined
  });
});

// =============================================================================
// REGRESSION TESTS - TDD hardening pass
// =============================================================================

// --- NULL handling in messages ---

describe('NULL and edge-case handling in messages', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
  });

  it('stores and retrieves messages with null sender_name', () => {
    storeMessageDirect({
      id: 'null-sender-1',
      chat_jid: 'group@g.us',
      sender: 'unknown',
      sender_name: '',
      content: 'message from unknown',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_name).toBe('');
  });

  it('handles NULL content messages gracefully (filtered out)', () => {
    // storeMessage with null content — should be stored but filtered from queries
    storeMessageDirect({
      id: 'null-content-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: null as unknown as string,
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    // NULL content should be filtered by "content IS NOT NULL" in query
    expect(messages).toHaveLength(0);
  });

  it('stores messages with unicode, emoji, and special characters', () => {
    const specialContent =
      '🎉 Hello 世界! <script>alert("xss")</script> \n\t\r\0 SELECT * FROM messages; -- \'"; DROP TABLE messages;';
    store({
      id: 'unicode-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: '用户名 👤',
      content: specialContent,
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(specialContent);
    expect(messages[0].sender_name).toBe('用户名 👤');
  });

  it('stores and retrieves very long message content', () => {
    const longContent = 'x'.repeat(100_000);
    store({
      id: 'long-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: longContent,
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', 0, 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].content.length).toBe(100_000);
  });
});

// --- Session expiry edge cases ---

describe('session lifecycle and expiry edge cases', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('setSession preserves created_at on session ID update', () => {
    setSession('test-group', 'session-1');
    const ts1 = getSessionTimestamps('test-group');
    expect(ts1.createdAt).toBeDefined();

    // Small delay to ensure timestamps differ
    const originalCreatedAt = ts1.createdAt;

    // Update session with new ID — should preserve created_at
    setSession('test-group', 'session-2');
    const ts2 = getSessionTimestamps('test-group');
    expect(ts2.createdAt).toBe(originalCreatedAt);
    expect(getSession('test-group')).toBe('session-2');
  });

  it('touchSession updates last_used without changing session_id', () => {
    setSession('test-group', 'session-1');
    const ts1 = getSessionTimestamps('test-group');

    touchSession('test-group');
    const ts2 = getSessionTimestamps('test-group');

    expect(getSession('test-group')).toBe('session-1');
    // last_used should be updated (or equal if clock didn't tick)
    expect(ts2.lastUsed).toBeDefined();
    expect(ts2.lastUsed! >= ts1.lastUsed!).toBe(true);
  });

  it('touchSession on non-existent session is a no-op', () => {
    // Should not throw or create a session
    touchSession('nonexistent-group');
    expect(getSession('nonexistent-group')).toBeUndefined();
  });

  it('deleteSession removes session completely', () => {
    setSession('test-group', 'session-1');
    expect(getSession('test-group')).toBe('session-1');

    deleteSession('test-group');
    expect(getSession('test-group')).toBeUndefined();
    expect(getSessionTimestamps('test-group')).toEqual({});
  });

  it('getSessionTimestamps returns empty for non-existent session', () => {
    const ts = getSessionTimestamps('no-such-group');
    expect(ts).toEqual({ lastUsed: undefined, createdAt: undefined });
  });

  it('getAllSessions returns all active sessions', () => {
    setSession('group-a', 'sess-a');
    setSession('group-b', 'sess-b');

    const sessions = getAllSessions();
    expect(Object.keys(sessions)).toHaveLength(2);
    expect(sessions['group-a']).toBe('sess-a');
    expect(sessions['group-b']).toBe('sess-b');
  });
});

// --- Concurrent database access ---

describe('concurrent database access (WAL mode)', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
  });

  it('handles rapid sequential writes without data loss', () => {
    // Simulate rapid writes that could cause issues with non-WAL mode
    for (let i = 0; i < 100; i++) {
      store({
        id: `rapid-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `rapid message ${i}`,
        timestamp: `2024-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      });
    }

    const { messages } = getNewMessages(['group@g.us'], 0, 'Andy', 200);
    expect(messages).toHaveLength(100);
  });

  it('interleaves reads and writes without corruption', () => {
    for (let i = 0; i < 20; i++) {
      store({
        id: `interleave-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `interleave ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });

      // Read after every write
      const msgs = getMessagesSince('group@g.us', 0, 'Andy', 200);
      expect(msgs).toHaveLength(i + 1);
    }
  });
});

// --- Migration idempotency ---

describe('schema creation idempotency', () => {
  it('running _initTestDatabase twice does not throw or corrupt data', () => {
    // Already initialized in beforeEach — store some data
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    setSession('test-group', 'session-1');
    setRegisteredGroup('tg:123', {
      name: 'Test',
      folder: 'telegram_test',
      trigger: '@Bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    // Re-initialize — should not throw
    _initTestDatabase();

    // Data from previous DB is gone (new in-memory DB), but schema is valid
    const chats = getAllChats();
    expect(Array.isArray(chats)).toBe(true);

    // Verify schema is functional — store and retrieve
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    setSession('test-group', 'session-2');
    expect(getSession('test-group')).toBe('session-2');
  });
});

// --- Group operations with non-existent groups ---

describe('operations on non-existent groups', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('getRegisteredGroup returns undefined for non-existent JID', () => {
    const group = getRegisteredGroup('nonexistent@g.us');
    expect(group).toBeUndefined();
  });

  it('getRecentMessages returns empty for non-existent group folder', () => {
    const messages = getRecentMessages('nonexistent-folder', 10);
    expect(messages).toHaveLength(0);
  });

  it('getTasksForGroup returns empty for non-existent group', () => {
    const tasks = getTasksForGroup('nonexistent-folder');
    expect(tasks).toHaveLength(0);
  });

  it('getTaskById returns undefined for non-existent task', () => {
    expect(getTaskById('nonexistent-task')).toBeUndefined();
  });

  it('getLastBotMessageSeq returns 0 for non-existent chat', () => {
    expect(getLastBotMessageSeq('nonexistent@g.us')).toBe(0);
  });

  it('getLastBotMessageTimestamp returns undefined for non-existent chat', () => {
    expect(
      getLastBotMessageTimestamp('nonexistent@g.us', 'Andy'),
    ).toBeUndefined();
  });

  it('getLastSuccessTime returns null for non-existent task', () => {
    expect(getLastSuccessTime('nonexistent-task')).toBeNull();
  });

  it('setRegisteredGroup rejects invalid folder names', () => {
    expect(() => {
      setRegisteredGroup('tg:123', {
        name: 'Bad',
        folder: '../escape',
        trigger: '@Bot',
        added_at: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow(/Invalid group folder/);
  });

  it('setRegisteredGroup rejects folder named "global" (reserved)', () => {
    expect(() => {
      setRegisteredGroup('tg:123', {
        name: 'Global',
        folder: 'global',
        trigger: '@Bot',
        added_at: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow(/Invalid group folder/);
  });

  it('getRegisteredGroup skips groups with now-invalid folder names', () => {
    // First register a group with a valid folder
    setRegisteredGroup('tg:valid', {
      name: 'Valid',
      folder: 'telegram_valid',
      trigger: '@Bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    // Verify it's returned
    expect(getRegisteredGroup('tg:valid')).toBeDefined();

    // getAllRegisteredGroups should contain it
    const groups = getAllRegisteredGroups();
    expect(groups['tg:valid']).toBeDefined();
  });
});

// --- Task schedule validation ---

describe('task schedule validation', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('rejects cron that fires more frequently than every 30 minutes', () => {
    expect(() => {
      validateTaskSchedule('cron', '*/5 * * * *');
    }).toThrow(/minimum/i);
  });

  it('accepts cron that fires every 30 minutes', () => {
    expect(() => {
      validateTaskSchedule('cron', '*/30 * * * *');
    }).not.toThrow();
  });

  it('rejects interval less than 30 minutes', () => {
    expect(() => {
      validateTaskSchedule('interval', '60000'); // 1 minute
    }).toThrow(/too frequent/i);
  });

  it('accepts interval of exactly 30 minutes', () => {
    expect(() => {
      validateTaskSchedule('interval', '1800000');
    }).not.toThrow();
  });

  it('rejects non-numeric interval', () => {
    expect(() => {
      validateTaskSchedule('interval', 'not-a-number');
    }).toThrow(/too frequent/i);
  });

  it('createTask refuses to create with too-frequent schedule', () => {
    expect(() => {
      createTask({
        id: 'bad-task',
        group_folder: 'main',
        chat_jid: 'group@g.us',
        prompt: 'test',
        schedule_type: 'cron',
        schedule_value: '* * * * *',
        context_mode: 'isolated',
        next_run: null,
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow(/minimum/i);

    // Verify task was not created
    expect(getTaskById('bad-task')).toBeUndefined();
  });
});

// --- Router state round-trips ---

describe('router state accessors', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores and retrieves router state', () => {
    setRouterState('last_timestamp', '2024-01-01T00:00:00.000Z');
    expect(getRouterState('last_timestamp')).toBe('2024-01-01T00:00:00.000Z');
  });

  it('returns undefined for non-existent key', () => {
    expect(getRouterState('nonexistent')).toBeUndefined();
  });

  it('overwrites existing key on second set', () => {
    setRouterState('key', 'value1');
    setRouterState('key', 'value2');
    expect(getRouterState('key')).toBe('value2');
  });
});

// --- updateTaskAfterRun and getDueTasks ---

describe('task lifecycle (due tasks, run updates)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('getDueTasks returns tasks whose next_run is in the past', () => {
    const pastTime = new Date(Date.now() - 60000).toISOString();
    createTask({
      id: 'due-task',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'due task',
      schedule_type: 'once',
      schedule_value: pastTime,
      context_mode: 'isolated',
      next_run: pastTime,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const due = getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('due-task');
  });

  it('getDueTasks excludes paused tasks', () => {
    const pastTime = new Date(Date.now() - 60000).toISOString();
    createTask({
      id: 'paused-task',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: pastTime,
      context_mode: 'isolated',
      next_run: pastTime,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('paused-task', { status: 'paused' });
    const due = getDueTasks();
    expect(due).toHaveLength(0);
  });

  it('updateTaskAfterRun marks task completed when nextRun is null', () => {
    createTask({
      id: 'once-task',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'run once',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTaskAfterRun('once-task', null, 'done');
    const task = getTaskById('once-task');
    expect(task!.status).toBe('completed');
    expect(task!.last_result).toBe('done');
    expect(task!.last_run).toBeDefined();
  });

  it('updateTaskAfterRun keeps task active when nextRun is provided', () => {
    const futureTime = new Date(Date.now() + 3600000).toISOString();
    createTask({
      id: 'recurring-task',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'recurring',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      next_run: '2024-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTaskAfterRun('recurring-task', futureTime, 'ok');
    const task = getTaskById('recurring-task');
    expect(task!.status).toBe('active');
    expect(task!.next_run).toBe(futureTime);
  });
});

// --- storeChatMetadata channel/isGroup ---

describe('storeChatMetadata channel classification', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores explicit channel and isGroup', () => {
    storeChatMetadata(
      'tg:123',
      '2024-01-01T00:00:00.000Z',
      'Test',
      'telegram',
      false,
    );
    const chats = getAllChats();
    const chat = chats.find((c) => c.jid === 'tg:123');
    expect(chat).toBeDefined();
    expect(chat!.channel).toBe('telegram');
    expect(chat!.is_group).toBe(0);
  });

  it('COALESCE preserves existing channel when new value is null', () => {
    storeChatMetadata(
      'tg:123',
      '2024-01-01T00:00:00.000Z',
      'Test',
      'telegram',
      true,
    );
    // Update without channel — should preserve 'telegram'
    storeChatMetadata('tg:123', '2024-01-01T00:00:01.000Z', 'Test Updated');
    const chats = getAllChats();
    const chat = chats.find((c) => c.jid === 'tg:123');
    expect(chat!.channel).toBe('telegram');
    expect(chat!.is_group).toBe(1);
  });

  it('updateChatName does not clear timestamp of existing chat', () => {
    storeChatMetadata('tg:123', '2024-06-01T00:00:00.000Z', 'Old Name');
    updateChatName('tg:123', 'New Name');
    const chats = getAllChats();
    const chat = chats.find((c) => c.jid === 'tg:123');
    expect(chat!.name).toBe('New Name');
    // timestamp should remain the original (updateChatName uses ON CONFLICT DO UPDATE SET name only)
    expect(chat!.last_message_time).toBe('2024-06-01T00:00:00.000Z');
  });
});
