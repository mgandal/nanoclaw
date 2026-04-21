import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readBlogs } from './blogs.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `blogs-${Date.now()}.json`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe('readBlogs', () => {
  it('returns null when file is missing (surface hidden)', () => {
    expect(readBlogs('/nonexistent.json')).toBeNull();
  });

  it('returns [] when file exists but is empty array (configured, no items)', () => {
    fs.writeFileSync(tmpFile, '[]');
    expect(readBlogs(tmpFile)).toEqual([]);
  });

  it('returns parsed items for well-formed input', () => {
    const items = [
      { source: 'Anthropic', title: 'Release', url: 'https://x', published_at: '2026-04-18T00:00:00Z' },
    ];
    fs.writeFileSync(tmpFile, JSON.stringify(items));
    expect(readBlogs(tmpFile)).toEqual(items);
  });

  it('returns null for malformed JSON', () => {
    fs.writeFileSync(tmpFile, 'not json');
    expect(readBlogs(tmpFile)).toBeNull();
  });

  it('returns null if file contains non-array JSON', () => {
    fs.writeFileSync(tmpFile, '{"oops": "object not array"}');
    expect(readBlogs(tmpFile)).toBeNull();
  });
});
