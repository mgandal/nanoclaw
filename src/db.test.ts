import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  _closeDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getConsecutiveFailures,
  getLastBotMessageSeq,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  getTaskRunLogs,
  getTaskSuccessRate,
  logTaskRun,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
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
