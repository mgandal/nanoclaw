import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { claimAndProcessDir } from './watcher.js';

describe('claimAndProcessDir', () => {
  let tmp: string;
  let queueDir: string;
  let errorDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-watcher-'));
    queueDir = path.join(tmp, 'messages');
    errorDir = path.join(tmp, 'errors');
    fs.mkdirSync(queueDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function drop(name: string, payload: unknown): void {
    fs.writeFileSync(
      path.join(queueDir, name),
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
  }

  it('parses each .json file and invokes the processor with its data', async () => {
    drop('a.json', { type: 'message', text: 'hi' });
    drop('b.json', { type: 'message', text: 'bye' });
    const seen: unknown[] = [];

    await claimAndProcessDir(queueDir, errorDir, async (data) => {
      seen.push(data);
    });

    expect(seen).toContainEqual({ type: 'message', text: 'hi' });
    expect(seen).toContainEqual({ type: 'message', text: 'bye' });
  });

  it('ignores non-.json files', async () => {
    drop('note.txt', 'not json');
    drop('c.json', { type: 'message' });
    const seen: unknown[] = [];

    await claimAndProcessDir(queueDir, errorDir, async (data) => {
      seen.push(data);
    });

    expect(seen).toEqual([{ type: 'message' }]);
  });

  it('unlinks the processing file after a successful process', async () => {
    drop('a.json', { type: 'message' });

    await claimAndProcessDir(queueDir, errorDir, async () => {});

    expect(fs.readdirSync(queueDir)).toHaveLength(0);
  });

  it('moves a file to errors/ when the processor throws', async () => {
    drop('boom.json', { type: 'message' });

    await claimAndProcessDir(queueDir, errorDir, async () => {
      throw new Error('processor failed');
    });

    expect(fs.readdirSync(queueDir)).toHaveLength(0);
    const errored = fs.readdirSync(errorDir);
    expect(errored).toHaveLength(1);
    expect(errored[0]).toContain('boom.json');
  });

  it('moves a file to errors/ when its JSON is malformed', async () => {
    drop('bad.json', '{ not valid json');

    await claimAndProcessDir(queueDir, errorDir, async () => {});

    expect(fs.readdirSync(queueDir)).toHaveLength(0);
    expect(fs.readdirSync(errorDir)).toHaveLength(1);
  });

  it('is a no-op when the directory does not exist', async () => {
    const missing = path.join(tmp, 'nope');
    const processor = vi.fn();

    await expect(
      claimAndProcessDir(missing, errorDir, processor),
    ).resolves.toBeUndefined();
    expect(processor).not.toHaveBeenCalled();
  });
});
