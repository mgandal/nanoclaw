/**
 * Tests for the .env parser (env.ts), particularly the single-char value bug.
 * Uses fs mocking to avoid touching the real .env file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs so we control what .env content is read
const mockStatSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
vi.mock('fs', () => ({
  default: {
    statSync: (...args: unknown[]) => mockStatSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
  statSync: (...args: unknown[]) => mockStatSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// Mock logger to avoid noise
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Fresh import each time (module cache is shared, but we change mtime to bust cache)
import { readEnvFile } from './env.js';

let fakeMtime = 1;

function setEnvContent(content: string) {
  fakeMtime++;
  mockStatSync.mockReturnValue({ mtimeMs: fakeMtime });
  mockReadFileSync.mockReturnValue(content);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('env parser: quote stripping', () => {
  it('strips double quotes from normal values', () => {
    setEnvContent('KEY="hello world"');
    expect(readEnvFile(['KEY']).KEY).toBe('hello world');
  });

  it('strips single quotes from normal values', () => {
    setEnvContent("KEY='hello world'");
    expect(readEnvFile(['KEY']).KEY).toBe('hello world');
  });

  it('does not strip unmatched quotes', () => {
    setEnvContent('KEY="hello');
    expect(readEnvFile(['KEY']).KEY).toBe('"hello');
  });

  it('preserves unquoted single-char values', () => {
    setEnvContent('KEY=a');
    expect(readEnvFile(['KEY']).KEY).toBe('a');
  });

  // BUG: A lone quote character as value is treated as a quoted empty string
  // value.startsWith('"') && value.endsWith('"') is true for '"',
  // then slice(1, -1) produces '' and the `if (value)` guard drops it.
  it('does not treat a lone double-quote as a quoted string', () => {
    setEnvContent('KEY="');
    // After fix: " is preserved as a literal value
    expect(readEnvFile(['KEY']).KEY).toBe('"');
  });

  it('does not treat a lone single-quote as a quoted string', () => {
    setEnvContent("KEY='");
    expect(readEnvFile(['KEY']).KEY).toBe("'");
  });
});

describe('env parser: general correctness', () => {
  it('parses multiple keys', () => {
    setEnvContent('A=1\nB=2\nC=3');
    expect(readEnvFile(['A', 'B', 'C'])).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('skips comments and empty lines', () => {
    setEnvContent('# comment\n\nKEY=val\n  # another');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'val' });
  });

  it('only returns requested keys', () => {
    setEnvContent('A=1\nB=2');
    expect(readEnvFile(['A'])).toEqual({ A: '1' });
  });

  it('handles values with = signs', () => {
    setEnvContent('KEY=a=b=c');
    expect(readEnvFile(['KEY']).KEY).toBe('a=b=c');
  });

  it('returns empty object when .env is missing', () => {
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(readEnvFile(['KEY'])).toEqual({});
  });

  it('caches by mtime (same mtime = no re-read)', () => {
    fakeMtime++;
    mockStatSync.mockReturnValue({ mtimeMs: fakeMtime });
    mockReadFileSync.mockReturnValue('KEY=first');
    readEnvFile(['KEY']);

    // Second call with same mtime should not re-read
    mockReadFileSync.mockReturnValue('KEY=second');
    const result = readEnvFile(['KEY']);
    expect(result.KEY).toBe('first');
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('busts cache when mtime changes', () => {
    fakeMtime++;
    mockStatSync.mockReturnValue({ mtimeMs: fakeMtime });
    mockReadFileSync.mockReturnValue('KEY=first');
    readEnvFile(['KEY']);

    // Change mtime
    fakeMtime++;
    mockStatSync.mockReturnValue({ mtimeMs: fakeMtime });
    mockReadFileSync.mockReturnValue('KEY=second');
    const result = readEnvFile(['KEY']);
    expect(result.KEY).toBe('second');
  });
});
