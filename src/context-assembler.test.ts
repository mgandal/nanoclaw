import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import {
  assembleContextPacket,
  writeContextPacket,
} from './context-assembler.js';
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
    // Generate enough content to exceed CONTEXT_PACKET_MAX_SIZE (16000)
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('X'.repeat(10000));
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
    vi.mocked(getRecentMessages).mockReturnValue(
      Array.from({ length: 100 }, (_, i) => ({
        sender: `user${i}`,
        content: 'A'.repeat(2000),
        timestamp: '2026-03-20T10:00:00Z',
      })),
    );
    vi.mocked(getAllTasks).mockReturnValue(
      Array.from({ length: 100 }, (_, i) => ({
        id: `task-${i}`,
        prompt: 'B'.repeat(500),
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
    vi.mocked(fs.statSync).mockReturnValue({
      mtimeMs: fourDaysAgo,
    } as fs.Stats);
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
          classification: {
            urgency: 'high',
            summary: 'Grant deadline moved up',
          },
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

  it('truncates memory.md content to 2000 characters', async () => {
    const longMemory = 'M'.repeat(3000);
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('memory.md'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(longMemory);
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).toContain('Group Memory');
    // The memory content in the packet should be at most 2000 chars of 'M'
    const memorySection = packet.split('--- Group Memory ---\n')[1];
    // Count consecutive M's — should be exactly 2000
    const mRun = memorySection?.match(/^M+/)?.[0] ?? '';
    expect(mRun.length).toBe(2000);
  });

  it('truncates current.md content to 1500 characters', async () => {
    const longCurrent = 'P'.repeat(2500);
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('current.md'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(longCurrent);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).toContain('Current Priorities');
    const prioritiesSection = packet.split('--- Current Priorities ---\n')[1];
    const pRun = prioritiesSection?.match(/^P+/)?.[0] ?? '';
    expect(pRun.length).toBe(1500);
  });

  it('truncates individual message content to 200 characters', async () => {
    const longContent = 'Z'.repeat(500);
    vi.mocked(getRecentMessages).mockReturnValue([
      {
        sender: 'user1',
        content: longContent,
        timestamp: '2026-03-20T10:00:00Z',
      },
    ]);
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).toContain('Recent messages');
    // The message content should be truncated to 200 chars
    const zRun = packet.match(/Z+/)?.[0] ?? '';
    expect(zRun.length).toBe(200);
  });

  it('filters out inactive tasks (only active tasks shown)', async () => {
    vi.mocked(getAllTasks).mockReturnValue([
      {
        id: 'task-active',
        prompt: 'Active task here',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        group_folder: 'telegram_test',
        chat_jid: 'tg:123',
        context_mode: 'group',
        next_run: null,
        last_run: null,
        last_result: null,
        created_at: '2026-03-20',
      },
      {
        id: 'task-paused',
        prompt: 'Paused task here',
        schedule_type: 'cron',
        schedule_value: '0 10 * * *',
        status: 'paused',
        group_folder: 'telegram_test',
        chat_jid: 'tg:123',
        context_mode: 'group',
        next_run: null,
        last_run: null,
        last_result: null,
        created_at: '2026-03-20',
      },
    ]);
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).toContain('Active task here');
    expect(packet).not.toContain('Paused task here');
  });

  it('does not add bus sections when queue.json contains empty array', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('queue.json'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('[]');
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).not.toContain('Pending items from other agents');
    expect(packet).not.toContain('Recent Events (classified)');
  });

  it('handles bus queue items with missing from/finding fields', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('queue.json'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        { from: undefined, finding: undefined },
        { from: 'agent-x' },
        { finding: 'something happened' },
      ]),
    );
    const packet = await assembleContextPacket('telegram_test', false);
    // Should not crash; should still show the section
    expect(packet).toContain('Pending items from other agents');
  });

  it('handles classified events with missing classification sub-fields', async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('queue.json'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        { topic: 'classified_event', from: 'agent-y' },
        { topic: 'classified_event', classification: {} },
        { topic: 'classified_event', classification: { urgency: 'low' } },
      ]),
    );
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).toContain('Recent Events (classified)');
    // Missing urgency defaults to 'medium'
    expect(packet).toContain('[medium]');
    // Missing summary falls back to finding or 'No summary'
    expect(packet).toContain('No summary');
    // Explicit urgency present
    expect(packet).toContain('[low]');
  });

  it('does not add truncation marker when packet is exactly at max size', async () => {
    // Build a packet and check: if it's <= CONTEXT_PACKET_MAX_SIZE, no marker
    // Use minimal content (just date/time/timezone) which should be well under limit
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet.length).toBeLessThanOrEqual(8000);
    expect(packet).not.toContain('[...truncated]');
  });

  it('truncates bus queue finding text to 150 characters', async () => {
    const longFinding = 'Q'.repeat(300);
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('queue.json'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([{ from: 'test-agent', finding: longFinding }]),
    );
    const packet = await assembleContextPacket('telegram_test', false);
    expect(packet).toContain('Pending items from other agents');
    // Use 'Q' to avoid collisions with other text in the packet
    const qRun = packet.match(/Q+/)?.[0] ?? '';
    expect(qRun.length).toBe(150);
  });
});

describe('writeContextPacket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes context packet atomically via tmp+rename', async () => {
    const packet = await writeContextPacket(
      'telegram_test',
      false,
      '/tmp/test-ipc',
    );
    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/test-ipc', {
      recursive: true,
    });
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
    const writeCall = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('queue.json.tmp'),
      );
    expect(writeCall).toBeDefined();
    expect(writeCall![1]).toBe('[]');
  });
});
