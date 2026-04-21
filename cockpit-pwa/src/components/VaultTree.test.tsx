import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { VaultTree } from './VaultTree.js';
import type { VaultNode } from '../types.js';

const tree: VaultNode = {
  name: 'vault', path: '', kind: 'dir', children: [
    { name: '99-wiki', path: '99-wiki', kind: 'dir', children: [
      { name: 'tools', path: '99-wiki/tools', kind: 'dir', children: [
        { name: 'polars-bio.md', path: '99-wiki/tools/polars-bio.md', kind: 'file' },
        { name: 'seurat.md', path: '99-wiki/tools/seurat.md', kind: 'file' },
      ]},
    ]},
  ],
};

describe('VaultTree', () => {
  it('renders each file name as text', () => {
    render(<VaultTree tree={tree} available={['99-wiki%2Ftools%2Fpolars-bio', '99-wiki%2Ftools%2Fseurat']} />);
    expect(screen.getByText('polars-bio.md')).toBeTruthy();
    expect(screen.getByText('seurat.md')).toBeTruthy();
  });

  it('renders file nodes as links when their slug is in available', () => {
    render(<VaultTree tree={tree} available={['99-wiki%2Ftools%2Fpolars-bio']} />);
    const link = screen.getByText('polars-bio.md').closest('a');
    expect(link?.getAttribute('href')).toBe('#/vault/99-wiki%2Ftools%2Fpolars-bio');
  });

  it('renders file nodes as dimmed spans with tooltip when not in available', () => {
    render(<VaultTree tree={tree} available={['99-wiki%2Ftools%2Fpolars-bio']} />);
    const seurat = screen.getByText('seurat.md');
    expect(seurat.tagName.toLowerCase()).not.toBe('a');
    expect(seurat.className).toContain('dimmed');
    expect(seurat.getAttribute('title')).toMatch(/outside recent window/i);
  });

  it('renders directory names as nested headings', () => {
    render(<VaultTree tree={tree} available={[]} />);
    expect(screen.getByText('99-wiki')).toBeTruthy();
    expect(screen.getByText('tools')).toBeTruthy();
  });
});
