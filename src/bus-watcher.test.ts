import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BusWatcher } from './bus-watcher.js';

describe('BusWatcher', () => {
  let tmpDir: string;
  let agentsDir: string;
  const mockDispatch = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-watcher-test-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dispatches pending messages to compound key', async () => {
    const dir = path.join(agentsDir, 'telegram_lab-claw--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '123-abc.json'),
      JSON.stringify({
        id: '1',
        topic: 'test',
        priority: 'medium',
        from: 'x',
        timestamp: 't',
      }),
    );

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    await watcher.poll();

    expect(mockDispatch).toHaveBeenCalledWith(
      'telegram_lab-claw:einstein',
      expect.arrayContaining([expect.objectContaining({ topic: 'test' })]),
    );
  });

  it('skips directories with no pending .json files', async () => {
    const dir = path.join(agentsDir, 'telegram_lab-claw--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '123-abc.processing'), '{"id":"1"}');

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    await watcher.poll();

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('returns shortened interval for high priority messages', async () => {
    const dir = path.join(agentsDir, 'telegram_lab-claw--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '123-abc.json'),
      JSON.stringify({
        id: '1',
        topic: 'urgent',
        priority: 'high',
        from: 'x',
        timestamp: 't',
      }),
    );

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    const interval = await watcher.poll();
    expect(interval).toBe(5000);
  });

  it('restores messages on dispatch failure', async () => {
    const dir = path.join(agentsDir, 'telegram_lab-claw--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '123-abc.json'),
      '{"id":"1","from":"x","topic":"t","timestamp":"t"}',
    );

    const failDispatch = vi
      .fn()
      .mockRejectedValue(new Error('dispatch failed'));
    const watcher = new BusWatcher(tmpDir, failDispatch);
    await watcher.poll();

    // Message should be restored to .json
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.processing'))).toBe(false);
  });

  it('moves messages to done/ on success', async () => {
    const dir = path.join(agentsDir, 'telegram_lab-claw--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '123-abc.json'),
      '{"id":"1","from":"x","topic":"t","timestamp":"t"}',
    );

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    await watcher.poll();

    // Original directory should be empty of .json and .processing
    const remaining = fs.readdirSync(dir);
    expect(remaining.filter((f) => f.endsWith('.json'))).toHaveLength(0);
    expect(remaining.filter((f) => f.endsWith('.processing'))).toHaveLength(0);

    // done/ directory should have the message
    const doneDir = path.join(tmpDir, 'done');
    expect(fs.existsSync(doneDir)).toBe(true);
    expect(fs.readdirSync(doneDir).length).toBeGreaterThan(0);
  });

  it('returns normal interval when no messages pending', async () => {
    const watcher = new BusWatcher(tmpDir, mockDispatch);
    const interval = await watcher.poll();
    expect(interval).toBe(30000);
  });

  // --- B3(iii): from-field verification ---

  it('rejects bus files with reserved from values (B3 iii)', async () => {
    const dir = path.join(agentsDir, 'telegram_test--recipient');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'spoof.json'),
      JSON.stringify({ from: 'SYSTEM', topic: 't', summary: 'x' }),
    );

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    await watcher.poll();

    expect(mockDispatch).not.toHaveBeenCalled();
    // File should have been moved to _errors/, not left in the recipient dir
    expect(fs.existsSync(path.join(dir, 'spoof.json'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, '_errors', 'spoof.json'))).toBe(
      true,
    );
  });

  it('rejects bus files with reserved from values case-insensitively (B3 iii)', async () => {
    const dir = path.join(agentsDir, 'telegram_test--recipient');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'spoof-lower.json'),
      JSON.stringify({ from: 'root', topic: 't', summary: 'x' }),
    );

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    await watcher.poll();

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rejects bus files whose from fails the agent-name regex (B3 iii)', async () => {
    const dir = path.join(agentsDir, 'telegram_test--recipient');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({
        from: '../../etc/passwd',
        topic: 't',
        summary: 'x',
      }),
    );

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    await watcher.poll();

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('accepts bus files with a valid agent-style from (B3 iii)', async () => {
    const dir = path.join(agentsDir, 'telegram_test--recipient');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ok.json'),
      JSON.stringify({ id: '1', from: 'simon', topic: 't', summary: 'hi' }),
    );

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    await watcher.poll();

    expect(mockDispatch).toHaveBeenCalledWith(
      'telegram_test:recipient',
      expect.arrayContaining([expect.objectContaining({ from: 'simon' })]),
    );
  });

  // ─────────────────────────────────────────────────
  // C15: idempotency — dispatch-failure + restore must not re-fire side effects
  // ─────────────────────────────────────────────────
  //
  // Today: dispatch throws → .processing → .json restore → next poll re-reads
  // the same message and calls dispatch again. Any side effects that ran
  // before the throw fire twice.
  //
  // Fix: track dispatched message ids in an in-memory Map<id, expireMs>. Mark
  // at the moment of the dispatch() call, so the restored .json is recognized
  // as a repeat on the next poll and moved to _stale/ instead of being
  // re-dispatched.

  it('C15: restore-then-repoll does not re-dispatch the same id', async () => {
    const dir = path.join(agentsDir, 'telegram_test--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'msg-aaa.json'),
      JSON.stringify({
        id: 'unique-c15-1',
        from: 'simon',
        topic: 't',
        timestamp: 't',
      }),
    );

    // First poll: dispatch throws → message restored to .json
    const failOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('partial side effect then boom'))
      .mockResolvedValue(undefined);
    const watcher = new BusWatcher(tmpDir, failOnce);
    await watcher.poll();
    expect(failOnce).toHaveBeenCalledTimes(1);
    // Restored
    expect(fs.existsSync(path.join(dir, 'msg-aaa.json'))).toBe(true);

    // Second poll: must NOT call dispatch again with this id
    await watcher.poll();
    expect(failOnce).toHaveBeenCalledTimes(1);

    // The file must not be left in the recipient dir spinning.
    // It should be moved to _stale/ under agents/.
    expect(fs.existsSync(path.join(dir, 'msg-aaa.json'))).toBe(false);
    const staleDir = path.join(agentsDir, '_stale');
    expect(fs.existsSync(staleDir)).toBe(true);
    const staleFiles = fs.readdirSync(staleDir);
    expect(staleFiles.length).toBeGreaterThan(0);
  });

  it('C15: different message ids are not deduplicated', async () => {
    const dir = path.join(agentsDir, 'telegram_test--einstein');
    fs.mkdirSync(dir, { recursive: true });
    // First message fails
    fs.writeFileSync(
      path.join(dir, 'a.json'),
      JSON.stringify({
        id: 'c15-msg-A',
        from: 'simon',
        topic: 't',
        timestamp: 't',
      }),
    );

    const firstFail = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const watcher = new BusWatcher(tmpDir, firstFail);
    await watcher.poll();
    expect(firstFail).toHaveBeenCalledTimes(1);

    // A new message (different id) arrives
    fs.writeFileSync(
      path.join(dir, 'b.json'),
      JSON.stringify({
        id: 'c15-msg-B',
        from: 'simon',
        topic: 't',
        timestamp: 't',
      }),
    );

    await watcher.poll();
    // The new message should dispatch; the old one should NOT.
    expect(firstFail).toHaveBeenCalledTimes(2);
    const lastCallArgs = firstFail.mock.calls[firstFail.mock.calls.length - 1];
    const dispatched = lastCallArgs[1] as Array<{ id: string }>;
    const ids = dispatched.map((m) => m.id);
    expect(ids).toContain('c15-msg-B');
    expect(ids).not.toContain('c15-msg-A');
  });

  it('C15: messages without an id are still dispatched (no-op dedup)', async () => {
    // Old or hand-written bus files may lack id. Dedup should degrade
    // gracefully rather than drop the message.
    const dir = path.join(agentsDir, 'telegram_test--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'noid.json'),
      JSON.stringify({ from: 'simon', topic: 't', timestamp: 't' }),
    );

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    await watcher.poll();
    expect(mockDispatch).toHaveBeenCalled();
  });

  it('C15: TTL expiry allows re-dispatch after grace window', async () => {
    const dir = path.join(agentsDir, 'telegram_test--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ttl.json'),
      JSON.stringify({
        id: 'c15-ttl-1',
        from: 'simon',
        topic: 't',
        timestamp: 't',
      }),
    );

    // Tiny TTL so we can test expiry without a long sleep.
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const watcher = new BusWatcher(tmpDir, dispatch, { dedupTtlMs: 10 });

    // Attempt 1: dispatch fails, id marked, file restored to .json.
    await watcher.poll();
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Wait past the TTL. The restored .json is still in the recipient dir;
    // the next poll will sweep the id out of the dedup map, re-claim, and
    // dispatch successfully.
    await new Promise((r) => setTimeout(r, 30));
    await watcher.poll();

    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
