import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { VaultDeltaWatcher } from './vault-delta-watcher.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('VaultDeltaWatcher', () => {
  it('emits RawEvent on file write with tag + author', async () => {
    const emit = vi.fn();
    const w = new VaultDeltaWatcher({
      roots: [tmp],
      onEvent: emit,
      coalesceMs: 30,
    });
    w.start();
    await new Promise((r) => setTimeout(r, 50));
    fs.mkdirSync(path.join(tmp, '99-wiki/papers'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '99-wiki/papers/foo.md'), 'x');
    await new Promise((r) => setTimeout(r, 400));
    expect(emit).toHaveBeenCalled();
    const ev = emit.mock.calls.at(-1)![0];
    expect(ev.type).toBe('vault_change');
    expect(ev.payload.path).toContain('foo.md');
    expect(ev.payload.tag).toBe('papers');
    expect(ev.payload.author).toBe('user');
    w.stop();
  });

  it('coalesces rapid repeat enqueues on same path into one emit', async () => {
    // Direct unit test of the enqueue→flush path, bypassing fs.watch
    // which is racy under test-suite load on macOS.
    const emit = vi.fn();
    const w = new VaultDeltaWatcher({
      roots: [tmp],
      onEvent: emit,
      coalesceMs: 50,
    });
    for (let i = 0; i < 5; i++) {
      w.enqueueForTest(path.join(tmp, '10-daily/a.md'));
    }
    await new Promise((r) => setTimeout(r, 120));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].payload.coalescedCount).toBe(5);
    w.stop();
  });

  it('tags author=agent when path contains /agents/output/', async () => {
    const emit = vi.fn();
    const w = new VaultDeltaWatcher({
      roots: [tmp],
      onEvent: emit,
      coalesceMs: 30,
    });
    w.start();
    // fs.watch on macOS needs a tick to settle before picking up events.
    await new Promise((r) => setTimeout(r, 50));
    fs.mkdirSync(path.join(tmp, 'agents/output'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents/output/x.md'), 'x');
    await new Promise((r) => setTimeout(r, 400));
    expect(emit).toHaveBeenCalled();
    const ev = emit.mock.calls.at(-1)![0];
    expect(ev.payload.author).toBe('agent');
    w.stop();
  });

  it('skips missing roots without crashing', () => {
    const emit = vi.fn();
    const w = new VaultDeltaWatcher({
      roots: ['/nonexistent/path'],
      onEvent: emit,
    });
    w.start();
    w.stop();
    expect(emit).not.toHaveBeenCalled();
  });
});
