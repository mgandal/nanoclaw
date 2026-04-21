import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { GroupsPanel } from './GroupsPanel.js';
import type { GroupSnapshot } from '../types.js';

const groups: GroupSnapshot[] = [
  { folder: 'telegram_claire', display_name: 'CLAIRE', last_active_at: '2026-04-21T11:00:00Z', messages_24h: 5 },
  { folder: 'telegram_lab', display_name: 'LAB', last_active_at: null, messages_24h: 0 },
];

describe('GroupsPanel', () => {
  it('renders each group with name + message count', () => {
    render(<GroupsPanel groups={groups} />);
    expect(screen.getByText('CLAIRE')).toBeTruthy();
    expect(screen.getByText('LAB')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('renders a dash for groups with null last_active_at', () => {
    render(<GroupsPanel groups={groups} />);
    // LAB has null last_active_at; should render some placeholder.
    const labRow = screen.getByText('LAB').closest('.group-row');
    expect(labRow).toBeTruthy();
    expect(labRow?.textContent).toMatch(/—|never/i);
  });

  it('renders nothing when groups is empty', () => {
    const { container } = render(<GroupsPanel groups={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
