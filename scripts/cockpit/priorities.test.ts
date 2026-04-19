import { describe, it, expect } from 'vitest';
import { parsePriorities } from './priorities.js';

describe('parsePriorities', () => {
  it('extracts numbered items from a Top 3 section', () => {
    const md = [
      '# Current',
      '## Top 3',
      '1. Miao Tang hire',
      '2. Nature Genetics review',
      '3. Emma ABCD manuscript',
      '',
      '## Other',
      'Not in priorities',
    ].join('\n');
    expect(parsePriorities(md)).toEqual([
      'Miao Tang hire',
      'Nature Genetics review',
      'Emma ABCD manuscript',
    ]);
  });

  it('handles Top 5 or Top N by matching heading with digit', () => {
    const md = '## Top 5\n1. A\n2. B\n3. C\n4. D\n5. E';
    expect(parsePriorities(md)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('returns empty array if no Top N section found', () => {
    expect(parsePriorities('# Current\nNothing here')).toEqual([]);
  });

  it('stops at next heading', () => {
    const md = '## Top 3\n1. A\n2. B\n## Next\n1. Ignored';
    expect(parsePriorities(md)).toEqual(['A', 'B']);
  });

  it('ignores non-numbered lines inside the section', () => {
    const md = '## Top 3\n1. First\nnote in between\n2. Second';
    expect(parsePriorities(md)).toEqual(['First', 'Second']);
  });
});
