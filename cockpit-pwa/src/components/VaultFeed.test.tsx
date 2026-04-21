import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { VaultFeed } from './VaultFeed.js';
import type { IngestionVault } from '../types.js';

const vault: IngestionVault = {
  count_24h: 2,
  last_at: '2026-04-21T10:00:00Z',
  recent: [
    { path: '99-wiki/tools/polars-bio.md', title: 'polars-bio', at: '2026-04-21T10:00:00Z', kind: 'tool' },
    { path: '00-inbox/foo.md', title: 'foo', at: '2026-04-20T15:00:00Z', kind: 'inbox' },
  ],
};

describe('VaultFeed', () => {
  it('renders each recent vault entry', () => {
    render(<VaultFeed vault={vault} />);
    expect(screen.getByText('polars-bio')).toBeTruthy();
    expect(screen.getByText('foo')).toBeTruthy();
  });

  it('renders the "Browse vault" link', () => {
    render(<VaultFeed vault={vault} />);
    const link = screen.getByText(/browse vault/i);
    expect(link.closest('a')?.getAttribute('href')).toBe('#/vault');
  });

  it('renders nothing when recent is empty', () => {
    const { container } = render(
      <VaultFeed vault={{ count_24h: 0, last_at: null, recent: [] }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
