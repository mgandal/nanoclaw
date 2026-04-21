import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { BlogsPanel } from './BlogsPanel.js';
import type { BlogItem } from '../types.js';

const items: BlogItem[] = [
  { source: 'Anthropic', title: 'Release', url: 'https://x', published_at: '2026-04-20T10:00:00Z' },
  { source: 'Cloudflare', title: 'R2 GA', url: 'https://y', published_at: '2026-04-19T10:00:00Z' },
];

describe('BlogsPanel', () => {
  it('renders each blog item with its title', () => {
    render(<BlogsPanel blogs={items} />);
    expect(screen.getByText('Release')).toBeTruthy();
    expect(screen.getByText('R2 GA')).toBeTruthy();
  });

  it('links each title to its URL', () => {
    render(<BlogsPanel blogs={items} />);
    const link = screen.getByText('Release').closest('a');
    expect(link?.getAttribute('href')).toBe('https://x');
  });

  it('renders nothing when blogs is null (feature hidden)', () => {
    const { container } = render(<BlogsPanel blogs={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an empty-state message when blogs is [] (configured, no items)', () => {
    render(<BlogsPanel blogs={[]} />);
    expect(screen.getByText(/no.*blog/i)).toBeTruthy();
  });
});
