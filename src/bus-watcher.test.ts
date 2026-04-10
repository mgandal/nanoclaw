import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BusWatcher } from './bus-watcher';

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
      JSON.stringify({ id: '1', topic: 'test', priority: 'medium', from: 'x', timestamp: 't' }),
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
      JSON.stringify({ id: '1', topic: 'urgent', priority: 'high', from: 'x', timestamp: 't' }),
    );

    const watcher = new BusWatcher(tmpDir, mockDispatch);
    const interval = await watcher.poll();
    expect(interval).toBe(5000);
  });

  it('restores messages on dispatch failure', async () => {
    const dir = path.join(agentsDir, 'telegram_lab-claw--einstein');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '123-abc.json'), '{"id":"1","from":"x","topic":"t","timestamp":"t"}');

    const failDispatch = vi.fn().mockRejectedValue(new Error('dispatch failed'));
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
    fs.writeFileSync(path.join(dir, '123-abc.json'), '{"id":"1","from":"x","topic":"t","timestamp":"t"}');

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
});
