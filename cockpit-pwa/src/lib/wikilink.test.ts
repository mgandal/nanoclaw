import { describe, it, expect } from 'vitest';
import { resolveWikilink } from './wikilink.js';
import type { VaultNode } from '../types.js';

const tree: VaultNode = {
  name: 'vault', path: '', kind: 'dir', children: [
    { name: '99-wiki', path: '99-wiki', kind: 'dir', children: [
      { name: 'tools', path: '99-wiki/tools', kind: 'dir', children: [
        { name: 'polars-bio.md', path: '99-wiki/tools/polars-bio.md', kind: 'file' },
        { name: 'seurat.md', path: '99-wiki/tools/seurat.md', kind: 'file' },
      ]},
      { name: 'papers', path: '99-wiki/papers', kind: 'dir', children: [
        { name: 'smith-2026.md', path: '99-wiki/papers/smith-2026.md', kind: 'file' },
      ]},
    ]},
  ],
};

describe('resolveWikilink', () => {
  it('resolves an exact basename match to the slug', () => {
    const slug = resolveWikilink('polars-bio', tree);
    expect(slug).toBe('99-wiki%2Ftools%2Fpolars-bio');
  });

  it('resolves against basenames that include hyphens', () => {
    const slug = resolveWikilink('smith-2026', tree);
    expect(slug).toBe('99-wiki%2Fpapers%2Fsmith-2026');
  });

  it('returns null for unmatched targets', () => {
    expect(resolveWikilink('does-not-exist', tree)).toBeNull();
  });

  it('is case-sensitive (targets match basename exactly)', () => {
    expect(resolveWikilink('Polars-Bio', tree)).toBeNull();
  });

  it('ignores directories (only file basenames match)', () => {
    expect(resolveWikilink('tools', tree)).toBeNull();
  });

  it('strips .md from target if provided', () => {
    expect(resolveWikilink('polars-bio.md', tree)).toBe('99-wiki%2Ftools%2Fpolars-bio');
  });
});
