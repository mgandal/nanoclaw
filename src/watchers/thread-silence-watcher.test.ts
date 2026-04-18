import { describe, it, expect, vi } from 'vitest';
import { ThreadSilenceWatcher } from './thread-silence-watcher.js';

describe('ThreadSilenceWatcher', () => {
  it('emits for thread with inbound latest, no outbound since, >=48h silent', async () => {
    const qmd = {
      queryThreads: vi.fn().mockResolvedValue([
        {
          threadId: 't1',
          messages: [
            {
              direction: 'inbound',
              from: 'x@y',
              subject: 's',
              timestamp: new Date(Date.now() - 3 * 86400_000).toISOString(),
            },
          ],
        },
      ]),
    };
    const emit = vi.fn();
    const w = new ThreadSilenceWatcher({
      qmd: qmd as any,
      onEvent: emit,
      hasRecentEmission: () => false,
    });
    await w.poll();
    expect(emit).toHaveBeenCalled();
    expect(emit.mock.calls[0][0].type).toBe('silent_thread');
    expect(emit.mock.calls[0][0].payload.thread_id).toBe('t1');
  });

  it('skips when outbound exists after inbound', async () => {
    const qmd = {
      queryThreads: vi.fn().mockResolvedValue([
        {
          threadId: 't2',
          messages: [
            {
              direction: 'inbound',
              from: 'x',
              subject: 's',
              timestamp: new Date(Date.now() - 5 * 86400_000).toISOString(),
            },
            {
              direction: 'outbound',
              from: 'me',
              subject: 's',
              timestamp: new Date(Date.now() - 4 * 86400_000).toISOString(),
            },
          ],
        },
      ]),
    };
    const emit = vi.fn();
    const w = new ThreadSilenceWatcher({
      qmd: qmd as any,
      onEvent: emit,
      hasRecentEmission: () => false,
    });
    await w.poll();
    expect(emit).not.toHaveBeenCalled();
  });

  it('skips when inbound is <48h old', async () => {
    const qmd = {
      queryThreads: vi.fn().mockResolvedValue([
        {
          threadId: 't3',
          messages: [
            {
              direction: 'inbound',
              from: 'x',
              subject: 's',
              timestamp: new Date(Date.now() - 12 * 3600_000).toISOString(),
            },
          ],
        },
      ]),
    };
    const emit = vi.fn();
    const w = new ThreadSilenceWatcher({
      qmd: qmd as any,
      onEvent: emit,
      hasRecentEmission: () => false,
    });
    await w.poll();
    expect(emit).not.toHaveBeenCalled();
  });

  it('dedup: skips when recent emission exists', async () => {
    const qmd = {
      queryThreads: vi.fn().mockResolvedValue([
        {
          threadId: 't4',
          messages: [
            {
              direction: 'inbound',
              from: 'x',
              subject: 's',
              timestamp: new Date(Date.now() - 3 * 86400_000).toISOString(),
            },
          ],
        },
      ]),
    };
    const emit = vi.fn();
    const w = new ThreadSilenceWatcher({
      qmd: qmd as any,
      onEvent: emit,
      hasRecentEmission: () => true,
    });
    await w.poll();
    expect(emit).not.toHaveBeenCalled();
  });
});
