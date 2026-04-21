import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { PrioritiesStrip } from './PrioritiesStrip.js';

describe('PrioritiesStrip', () => {
  it('renders each priority as a list item', () => {
    render(<PrioritiesStrip priorities={['One', 'Two', 'Three']} />);
    expect(screen.getByText('One')).toBeTruthy();
    expect(screen.getByText('Two')).toBeTruthy();
    expect(screen.getByText('Three')).toBeTruthy();
  });

  it('renders nothing when priorities is empty', () => {
    const { container } = render(<PrioritiesStrip priorities={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
