import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { VaultPage } from './VaultPage.js';
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

const origFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('VaultPage', () => {
  it('fetches the right R2 key and renders the markdown', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('# Hello\n\nWorld', { status: 200 }),
    );
    render(<VaultPage slug="99-wiki%2Ftools%2Fpolars-bio" tree={tree} origin="https://c.example" />);
    const heading = await screen.findByText('Hello');
    expect(heading).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://c.example/data/pages/99-wiki%2Ftools%2Fpolars-bio.md',
      expect.any(Object),
    );
  });

  it('resolves wikilinks against the passed-in tree', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('See [[polars-bio]].', { status: 200 }),
    );
    render(<VaultPage slug="other" tree={tree} origin="https://c.example" />);
    const link = await screen.findByText('polars-bio');
    expect(link.closest('a')?.getAttribute('href')).toBe('/vault/99-wiki%2Ftools%2Fpolars-bio');
  });

  it('renders an error message when fetch returns 404', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 404 }),
    );
    render(<VaultPage slug="missing" tree={tree} origin="https://c.example" />);
    const err = await screen.findByText(/could not load/i);
    expect(err).toBeTruthy();
  });
});
