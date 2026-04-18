import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { QmdEmailAdapter } from './qmd-email-adapter.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qmd-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeEmail(
  dir: string,
  name: string,
  frontmatter: Record<string, string>,
): void {
  const body = `---\n${Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\nbody\n`;
  fs.writeFileSync(path.join(dir, name), body);
}

describe('QmdEmailAdapter.queryThreads', () => {
  it('groups by thread_id and returns messages', async () => {
    writeEmail(tmp, 'a.md', {
      thread_id: 't1',
      direction: 'inbound',
      from: 'x@y',
      subject: 's',
      timestamp: '2026-04-15T10:00:00Z',
    });
    writeEmail(tmp, 'b.md', {
      thread_id: 't1',
      direction: 'outbound',
      from: 'me',
      subject: 's',
      timestamp: '2026-04-15T11:00:00Z',
    });
    writeEmail(tmp, 'c.md', {
      thread_id: 't2',
      direction: 'inbound',
      from: 'z',
      subject: 's2',
      timestamp: '2026-04-14T09:00:00Z',
    });
    const a = new QmdEmailAdapter(tmp);
    const threads = await a.queryThreads();
    expect(threads).toHaveLength(2);
    const t1 = threads.find((t) => t.threadId === 't1')!;
    expect(t1.messages).toHaveLength(2);
  });

  it('ignores files missing thread_id or direction', async () => {
    writeEmail(tmp, 'x.md', { from: 'x', subject: 's' });
    const a = new QmdEmailAdapter(tmp);
    expect(await a.queryThreads()).toHaveLength(0);
  });

  it('returns empty when directory does not exist', async () => {
    const a = new QmdEmailAdapter('/nonexistent/path');
    expect(await a.queryThreads()).toEqual([]);
  });

  it('handles quoted YAML values (strips surrounding quotes)', async () => {
    writeEmail(tmp, 'q.md', {
      thread_id: '"t-quoted"',
      direction: 'inbound',
      from: '"jane@example.com"',
      subject: '"hello"',
      timestamp: '2026-04-15T10:00:00Z',
    });
    const a = new QmdEmailAdapter(tmp);
    const threads = await a.queryThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe('t-quoted');
    expect(threads[0].messages[0].from).toBe('jane@example.com');
  });

  it('recurses into subdirectories (email-ingest uses gmail/YYYY-MM/ layout)', async () => {
    fs.mkdirSync(path.join(tmp, 'gmail/2026-04'), { recursive: true });
    writeEmail(path.join(tmp, 'gmail/2026-04'), 'a.md', {
      thread_id: 't1',
      direction: 'inbound',
      from: 'x',
      subject: 's',
      timestamp: '2026-04-15T10:00:00Z',
    });
    const a = new QmdEmailAdapter(tmp);
    const threads = await a.queryThreads();
    expect(threads).toHaveLength(1);
  });
});
