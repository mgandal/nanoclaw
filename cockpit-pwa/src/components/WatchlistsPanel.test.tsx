import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { WatchlistsPanel } from './WatchlistsPanel.js';
import type { WatchlistGroup } from '../types.js';

const wls: WatchlistGroup[] = [
  { scope: 'agent', scope_name: 'einstein', items: [{ title: 'Paper A', url: 'http://a' }] },
  { scope: 'agent', scope_name: 'marvin', items: [{ title: 'Admin item' }] },
  { scope: 'group', scope_name: 'lab', items: [{ title: 'Group thing' }] },
];

describe('WatchlistsPanel', () => {
  it('renders all items when "All" filter is active (default)', () => {
    render(<WatchlistsPanel watchlists={wls} />);
    expect(screen.getByText('Paper A')).toBeTruthy();
    expect(screen.getByText('Admin item')).toBeTruthy();
    expect(screen.getByText('Group thing')).toBeTruthy();
  });

  it('renders one chip per scope_name plus All', () => {
    render(<WatchlistsPanel watchlists={wls} />);
    const chips = Array.from(document.querySelectorAll('.chip')).map(el => el.textContent);
    expect(chips).toEqual(['All', 'einstein', 'marvin', 'lab']);
  });

  it('filters items when a scope chip is clicked', () => {
    render(<WatchlistsPanel watchlists={wls} />);
    const einsteinChip = Array.from(document.querySelectorAll('.chip')).find(
      el => el.textContent === 'einstein',
    )!;
    fireEvent.click(einsteinChip);
    expect(screen.queryByText('Paper A')).toBeTruthy();
    expect(screen.queryByText('Admin item')).toBeNull();
    expect(screen.queryByText('Group thing')).toBeNull();
  });

  it('renders nothing when watchlists is empty', () => {
    const { container } = render(<WatchlistsPanel watchlists={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
