import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readPause,
  writePause,
  isPaused,
  clearPauseCache,
} from './proactive-pause.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-'));
const pauseFile = path.join(tmp, 'pause.json');

beforeEach(() => {
  try {
    fs.unlinkSync(pauseFile);
  } catch {
    /* not present */
  }
  clearPauseCache();
});

describe('proactive-pause', () => {
  it('null when file missing', () => {
    expect(readPause(pauseFile)).toBe(null);
    expect(isPaused(pauseFile)).toBe(false);
  });
  it('round-trips', () => {
    writePause(pauseFile, '2026-04-18T23:00:00Z');
    expect(readPause(pauseFile)?.pausedUntil).toBe('2026-04-18T23:00:00Z');
  });
  it('paused true when pausedUntil in future', () => {
    writePause(pauseFile, new Date(Date.now() + 3600_000).toISOString());
    expect(isPaused(pauseFile)).toBe(true);
  });
  it('paused false when pausedUntil in past', () => {
    writePause(pauseFile, '2020-01-01T00:00:00Z');
    expect(isPaused(pauseFile)).toBe(false);
  });
  it('paused true when pausedUntil is null (indefinite)', () => {
    writePause(pauseFile, null);
    expect(isPaused(pauseFile)).toBe(true);
  });
  it('treats corrupt file as paused indefinitely (fail closed)', () => {
    fs.writeFileSync(pauseFile, '{not valid json');
    expect(isPaused(pauseFile)).toBe(true);
  });
});
