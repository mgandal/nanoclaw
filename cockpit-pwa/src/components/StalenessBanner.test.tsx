import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { StalenessBanner } from './StalenessBanner.js';

describe('StalenessBanner', () => {
  it('renders nothing when snapshot is fresh', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const { container } = render(
      <StalenessBanner generatedAt="2026-04-21T11:30:00Z" now={now} schemaMatches={true} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders yellow warning banner for stale-warn', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    render(
      <StalenessBanner generatedAt="2026-04-21T10:30:00Z" now={now} schemaMatches={true} />,
    );
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('stale-warn');
    expect(banner.textContent).toMatch(/90.*old/);
  });

  it('renders red critical banner for stale-crit', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    render(
      <StalenessBanner generatedAt="2026-04-21T08:30:00Z" now={now} schemaMatches={true} />,
    );
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('stale-crit');
  });

  it('renders blocking schema-mismatch banner regardless of staleness', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    render(
      <StalenessBanner generatedAt="2026-04-21T11:30:00Z" now={now} schemaMatches={false} />,
    );
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('schema-mismatch');
    expect(banner.textContent).toMatch(/out of date/i);
  });
});
