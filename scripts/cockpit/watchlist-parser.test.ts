import { describe, it, expect } from 'vitest';
import { parseWatchlistBullets, extractSection } from './watchlist-parser.js';

describe('parseWatchlistBullets', () => {
  it('parses title + url + note', () => {
    const input = '- [Paper: Smith et al 2026](https://arxiv.org/abs/1234) — added 2026-04-18';
    const [item] = parseWatchlistBullets(input);
    expect(item.title).toBe('Paper: Smith et al 2026');
    expect(item.url).toBe('https://arxiv.org/abs/1234');
    expect(item.note).toBe('added 2026-04-18');
  });

  it('parses title + url only (no note)', () => {
    const input = '- [Tool: polars-bio](https://github.com/x/polars-bio)';
    const [item] = parseWatchlistBullets(input);
    expect(item.title).toBe('Tool: polars-bio');
    expect(item.url).toBe('https://github.com/x/polars-bio');
    expect(item.note).toBeUndefined();
  });

  it('parses plain text bullet (no url)', () => {
    const input = '- A note without a link';
    const [item] = parseWatchlistBullets(input);
    expect(item.title).toBe('A note without a link');
    expect(item.url).toBeUndefined();
    expect(item.note).toBeUndefined();
  });

  it('ignores nested bullets and non-bullet lines', () => {
    const input = [
      '- Top level',
      '  - Nested should be ignored',
      'Non-bullet line',
      '- Second top-level',
    ].join('\n');
    const items = parseWatchlistBullets(input);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Top level');
    expect(items[1].title).toBe('Second top-level');
  });

  it('returns empty array for empty input', () => {
    expect(parseWatchlistBullets('')).toEqual([]);
  });
});

describe('extractSection', () => {
  it('extracts only the named section body', () => {
    const md = [
      '# Memory',
      '## Standing Instructions',
      '- Be concise',
      '',
      '## Watchlist',
      '- [Item A](http://a)',
      '- [Item B](http://b)',
      '',
      '## Session Continuity',
      '- something else',
    ].join('\n');
    const body = extractSection(md, 'Watchlist');
    expect(body).toContain('[Item A](http://a)');
    expect(body).toContain('[Item B](http://b)');
    expect(body).not.toContain('Be concise');
    expect(body).not.toContain('something else');
  });

  it('returns null for missing section', () => {
    const md = '## Standing Instructions\n- Be concise';
    expect(extractSection(md, 'Watchlist')).toBeNull();
  });

  it('returns empty string for section with no body', () => {
    const md = '## Watchlist\n\n## Next Section\n- x';
    expect(extractSection(md, 'Watchlist')).toBe('');
  });
});
