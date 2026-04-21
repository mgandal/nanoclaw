import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readEmailsState } from './emails-log.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `emails-${Date.now()}.json`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe('readEmailsState', () => {
  it('returns zeros when file is missing', () => {
    const r = readEmailsState('/nonexistent.json', new Date('2026-04-19T12:00:00Z'));
    expect(r.count_24h).toBe(0);
    expect(r.last_at).toBeNull();
    expect(r.recent).toEqual([]);
  });

  it('derives last_at from last_epoch when present', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      last_epoch: Math.floor(new Date('2026-04-19T11:00:00Z').getTime() / 1000),
      synced_ids: ['id1', 'id2', 'id3'],
    }));
    const r = readEmailsState(tmpFile, new Date('2026-04-19T12:00:00Z'));
    expect(r.last_at).toBe('2026-04-19T11:00:00.000Z');
    expect(r.count_24h).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(r.recent)).toBe(true);
  });

  it('handles malformed JSON gracefully', () => {
    fs.writeFileSync(tmpFile, 'not json');
    const r = readEmailsState(tmpFile, new Date('2026-04-19T12:00:00Z'));
    expect(r.count_24h).toBe(0);
    expect(r.last_at).toBeNull();
    expect(r.recent).toEqual([]);
  });
});
