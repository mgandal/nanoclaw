import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readPapersLog } from './papers-log.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `papers-${Date.now()}.jsonl`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe('readPapersLog', () => {
  it('returns empty structure when file is absent', () => {
    const result = readPapersLog('/nonexistent/path.jsonl', new Date('2026-04-19T12:00:00Z'));
    expect(result.count_24h).toBe(0);
    expect(result.last_at).toBeNull();
    expect(result.recent).toEqual([]);
  });

  it('reads lines in chronological order and returns recent-first', () => {
    fs.writeFileSync(tmpFile, [
      '{"evaluated_at":"2026-04-18T10:00:00Z","title":"Paper A","authors":"A et al","verdict":"ADOPT"}',
      '{"evaluated_at":"2026-04-19T08:00:00Z","title":"Paper B","authors":"B et al","verdict":"STEAL"}',
      '',
      '{"evaluated_at":"2026-04-19T11:00:00Z","title":"Paper C","authors":"C et al","verdict":"SKIP","url":"http://c"}',
    ].join('\n'));
    const now = new Date('2026-04-19T12:00:00Z');
    const result = readPapersLog(tmpFile, now);
    expect(result.recent).toHaveLength(3);
    expect(result.recent[0].title).toBe('Paper C');
    expect(result.recent[2].title).toBe('Paper A');
    expect(result.count_24h).toBe(2);
    expect(result.last_at).toBe('2026-04-19T11:00:00Z');
  });

  it('caps recent[] at 20 items', () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(JSON.stringify({ evaluated_at: `2026-04-${String(19 - (i % 10)).padStart(2, '0')}T10:00:00Z`, title: `Paper ${i}`, authors: 'x', verdict: 'SKIP' }));
    }
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const result = readPapersLog(tmpFile, new Date('2026-04-19T12:00:00Z'));
    expect(result.recent).toHaveLength(20);
  });

  it('skips lines that fail to parse', () => {
    fs.writeFileSync(tmpFile, [
      '{"evaluated_at":"2026-04-19T11:00:00Z","title":"Good","authors":"x","verdict":"ADOPT"}',
      'not json at all',
      '{"no_date":true}',
    ].join('\n'));
    const result = readPapersLog(tmpFile, new Date('2026-04-19T12:00:00Z'));
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0].title).toBe('Good');
  });
});
