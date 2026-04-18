import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeFileSecure } from './secure-write.js';

describe('writeFileSecure', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-write-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes content to the target file', () => {
    const target = path.join(tmpDir, 'out.txt');
    writeFileSecure(target, 'hello', { mode: 0o600 });
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
  });

  it('sets the requested file mode', () => {
    const target = path.join(tmpDir, 'out.txt');
    writeFileSecure(target, 'x', { mode: 0o600 });
    const stat = fs.statSync(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('writes atomically (no partial file on crash simulation)', () => {
    const target = path.join(tmpDir, 'out.txt');
    writeFileSecure(target, 'first', { mode: 0o600 });
    writeFileSecure(target, 'second', { mode: 0o600 });
    expect(fs.readFileSync(target, 'utf-8')).toBe('second');
    const leftover = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  it('rejects a target path containing NUL bytes', () => {
    expect(() =>
      writeFileSecure(path.join(tmpDir, 'bad\x00name'), 'x', { mode: 0o600 }),
    ).toThrow();
  });
});
