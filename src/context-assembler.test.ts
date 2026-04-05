import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { assembleContextPacket, writeContextPacket } from './context-assembler.js';
import { getRecentMessages, getAllTasks } from './db.js';

vi.mock('http', () => {
  const mockReq = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'error') setTimeout(() => cb(new Error('ECONNREFUSED')), 0);
      return mockReq;
    }),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    default: { request: vi.fn(() => mockReq) },
    request: vi.fn(() => mockReq),
  };
});

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  },
}));

vi.mock('./db.js', () => ({
  getRecentMessages: vi.fn(() => []),
  getAllTasks: vi.fn(() => []),
}));

describe('assembleContextPacket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes current date and timezone', async () => {
    const packet = await assembleContextPacket('main', true);
    expect(packet).toContain('Current date:');
    expect(packet).toContain('Timezone:');
  });

  it('includes recent messages when available', async () => {
    vi.mocked(getRecentMessages).mockReturnValue([
      {
        sender: 'user1',
        content: 'hello world',
        timestamp: '2026-03-20T10:00:00Z',
      },
    ]);
    const packet = await assembleContextPacket('main', true);
    expect(packet).toContain('Recent messages');
    expect(packet).toContain('hello world');
  });

  it('includes active scheduled tasks', async () => {
    vi.mocked(getAllTasks).mockReturnValue([
      {
        id: 'task-1',
        prompt: 'Morning briefing',
        schedule_type: 'cron',
        schedule_value: '0 7 * * 1-5',
        status: 'active',
        group_folder: 'main',
        chat_jid: 'tg:123',
        context_mode: 'group',
        next_run: null,
        last_run: null,
        last_result: null,
        created_at: '2026-03-20',
      },
    ]);
    const packet = await assembleContextPacket('main', true);
    expect(packet).toContain('Scheduled tasks');
    expect(packet).toContain('Morning briefing');
  });

  it('reads group memory.md if it exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('memory.md'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      '# Team Memory\n- Einstein: researcher',
    );
    const packet = await assembleContextPacket('telegram_science-claw', false);
    expect(packet).toContain('Einstein');
  });

  it('reads current.md for priorities', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('current.md'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      '## Top 3\n1) Grant deadline Friday',
    );
    const packet = await assembleContextPacket('main', true);
    expect(packet).toContain('Grant deadline');
  });

  it('truncates to max size', async () => {
    vi.mocked(getRecentMessages).mockReturnValue(
      Array.from({ length: 200 }, () => ({
        sender: 'user',
        content: 'x'.repeat(100),
        timestamp: '2026-03-20T10:00:00Z',
      })),
    );
    const packet = await assembleContextPacket('main', true);
    expect(packet.length).toBeLessThanOrEqual(8200);
  });

  it('handles missing memory.md gracefully (no crash, no section)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).not.toContain('Group Memory');
    expect(packet).toContain('Current date:');
  });

  it('handles empty memory.md (whitespace only) without adding section', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('memory.md'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('   \n  \n  ');
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).not.toContain('Group Memory');
  });

  it('truncated packet ends with [...]truncated] marker', async () => {
    // memory.md (2000 chars) + current.md (1500 chars) + 30 messages (~7000 chars) > 8000
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('X'.repeat(3000));
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
    vi.mocked(getRecentMessages).mockReturnValue(
      Array.from({ length: 30 }, (_, i) => ({
        sender: `user${i}`,
        content: 'A'.repeat(200),
        timestamp: '2026-03-20T10:00:00Z',
      })),
    );
    vi.mocked(getAllTasks).mockReturnValue(
      Array.from({ length: 50 }, (_, i) => ({
        id: `task-${i}`,
        prompt: 'B'.repeat(80),
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active' as const,
        group_folder: 'main',
        chat_jid: 'tg:123',
        context_mode: 'group',
        next_run: null,
        last_run: null,
        last_result: null,
        created_at: '2026-03-20',
      })),
    );
    const packet = await assembleContextPacket('main', true);
    expect(packet).toContain('[...truncated]');
  });

  it('survives DB error on getRecentMessages', async () => {
    vi.mocked(getRecentMessages).mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const packet = await assembleContextPacket('main', true);
    expect(packet).toContain('Current date:');
    expect(packet).not.toContain('Recent messages');
  });

  it('survives DB error on getAllTasks', async () => {
    vi.mocked(getAllTasks).mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const packet = await assembleContextPacket('main', true);
    expect(packet).toContain('Current date:');
    expect(packet).not.toContain('Scheduled tasks');
  });

  it('non-main group only sees own tasks, not other groups', async () => {
    vi.mocked(getAllTasks).mockReturnValue([
      {
        id: 'task-own',
        prompt: 'Own group task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        group_folder: 'telegram_science-claw',
        chat_jid: 'tg:123',
        context_mode: 'group',
        next_run: null,
        last_run: null,
        last_result: null,
        created_at: '2026-03-20',
      },
      {
        id: 'task-other',
        prompt: 'Other group task',
        schedule_type: 'cron',
        schedule_value: '0 10 * * *',
        status: 'active',
        group_folder: 'telegram_home-claw',
        chat_jid: 'tg:456',
        context_mode: 'group',
        next_run: null,
        last_run: null,
        last_result: null,
        created_at: '2026-03-20',
      },
    ]);
    const packet = await assembleContextPacket('telegram_science-claw', false);
    expect(packet).toContain('Own group task');
    expect(packet).not.toContain('Other group task');
  });

  it('main group sees all active tasks across groups', async () => {
    vi.mocked(getAllTasks).mockReturnValue([
      {
        id: 'task-a',
        prompt: 'Task A',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        group_folder: 'telegram_science-claw',
        chat_jid: 'tg:123',
        context_mode: 'group',
        next_run: null,
        last_run: null,
        last_result: null,
        created_at: '2026-03-20',
      },
      {
        id: 'task-b',
        prompt: 'Task B',
        schedule_type: 'cron',
        schedule_value: '0 10 * * *',
        status: 'active',
        group_folder: 'telegram_home-claw',
        chat_jid: 'tg:456',
        context_mode: 'group',
        next_run: null,
        last_run: null,
        last_result: null,
        created_at: '2026-03-20',
      },
    ]);
    const packet = await assembleContextPacket('main', true);
    expect(packet).toContain('Task A');
    expect(packet).toContain('Task B');
  });

  it('includes staleness warnings for old state files', async () => {
    const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('some content');
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: fourDaysAgo } as fs.Stats);
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).toContain('Stale Files');
    expect(packet).toContain('days ago');
  });

  it('includes bus queue items when queue.json exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('queue.json'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        { from: 'science-agent', finding: 'Found relevant paper on GWAS' },
      ]),
    );
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).toContain('Pending items from other agents');
    expect(packet).toContain('science-agent');
    expect(packet).toContain('GWAS');
  });

  it('includes classified events from bus queue', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('queue.json'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        {
          topic: 'classified_event',
          from: 'inbox-agent',
          finding: 'Urgent email from NIH',
          classification: { urgency: 'high', summary: 'Grant deadline moved up' },
        },
      ]),
    );
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).toContain('Recent Events (classified)');
    expect(packet).toContain('[high]');
    expect(packet).toContain('Grant deadline moved up');
  });

  it('handles malformed bus queue JSON gracefully', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('queue.json'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('NOT VALID JSON{{{');
    const packet = await assembleContextPacket('telegram_test', false);
    // Should not crash, should not include bus sections
    expect(packet).toContain('Current date:');
    expect(packet).not.toContain('Pending items');
  });
});

describe('writeContextPacket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes context packet atomically via tmp+rename', async () => {
    const packet = await writeContextPacket('telegram_test', false, '/tmp/test-ipc');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/test-ipc', { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/test-ipc/context-packet.txt.tmp',
      expect.any(String),
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      '/tmp/test-ipc/context-packet.txt.tmp',
      '/tmp/test-ipc/context-packet.txt',
    );
  });

  it('copies and clears bus queue when it exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('queue.json'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('[]');
    await writeContextPacket('telegram_test', false, '/tmp/test-ipc');
    expect(fs.copyFileSync).toHaveBeenCalled();
    // Bus queue should be cleared after copy (atomic write of '[]')
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('queue.json.tmp'),
    );
    expect(writeCall).toBeDefined();
    expect(writeCall![1]).toBe('[]');
  });
});
