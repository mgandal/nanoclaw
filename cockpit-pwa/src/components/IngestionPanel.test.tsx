import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { IngestionPanel } from './IngestionPanel.js';
import type { IngestionSnapshot } from '../types.js';

const ingestion: IngestionSnapshot = {
  emails: { count_24h: 42, last_at: '2026-04-21T11:00:00Z', recent: [] },
  papers: { count_24h: 3, last_at: '2026-04-20T09:00:00Z', recent: [] },
  vault: { count_24h: 7, last_at: '2026-04-21T08:00:00Z', recent: [] },
};

describe('IngestionPanel', () => {
  it('renders all three counters', () => {
    render(<IngestionPanel ingestion={ingestion} />);
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('labels each counter', () => {
    render(<IngestionPanel ingestion={ingestion} />);
    expect(screen.getByText(/emails/i)).toBeTruthy();
    expect(screen.getByText(/papers/i)).toBeTruthy();
    expect(screen.getByText(/vault/i)).toBeTruthy();
  });
});
