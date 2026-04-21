import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './render-markdown.js';
import type { VaultNode } from '../types.js';

const tree: VaultNode = {
  name: 'vault', path: '', kind: 'dir', children: [
    { name: '99-wiki', path: '99-wiki', kind: 'dir', children: [
      { name: 'tools', path: '99-wiki/tools', kind: 'dir', children: [
        { name: 'polars-bio.md', path: '99-wiki/tools/polars-bio.md', kind: 'file' },
      ]},
    ]},
  ],
};

describe('renderMarkdown', () => {
  it('renders plain markdown to HTML', () => {
    const html = renderMarkdown('# Hello\n\nWorld', tree);
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<p>World</p>');
  });

  it('resolves a wikilink that matches the vault_tree to an /vault/<slug> anchor', () => {
    const html = renderMarkdown('See [[polars-bio]] for details.', tree);
    expect(html).toContain('<a href="/vault/99-wiki%2Ftools%2Fpolars-bio"');
    expect(html).toContain('>polars-bio</a>');
  });

  it('renders an unmatched wikilink as a broken-link span', () => {
    const html = renderMarkdown('See [[nonexistent]].', tree);
    expect(html).toContain('<span class="broken-link">nonexistent</span>');
    expect(html).not.toContain('href="/vault/nonexistent"');
  });

  it('renders YAML frontmatter as a collapsed details block', () => {
    const md = '---\ntitle: Test\ntags: [a,b]\n---\n\n# Body';
    const html = renderMarkdown(md, tree);
    expect(html).toContain('<details');
    expect(html).toContain('title: Test');
    expect(html).toContain('<h1>Body</h1>');
  });

  it('renders fenced code blocks (highlight.js output is permissible)', () => {
    const md = '```ts\nconst x = 1;\n```';
    const html = renderMarkdown(md, tree);
    expect(html).toMatch(/<pre><code/);
    expect(html).toContain('const');
  });

  it('leaves non-wikilink bracket-looking text alone', () => {
    // Plain markdown shouldn't get mangled by the wikilink plugin.
    const html = renderMarkdown('See [label](http://example.com) for more.', tree);
    expect(html).toContain('<a href="http://example.com"');
    expect(html).not.toContain('broken-link');
  });
});
