import { describe, it, expect, vi } from 'vitest';
import {
  detectRepeatedTools,
  detectTimePatterns,
  canProposeToday,
  type ActionLogRow,
} from './pattern-engine.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('detectRepeatedTools', () => {
  it('finds tools called 3+ times with same params hash', () => {
    const rows: ActionLogRow[] = [
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-10T10:00:00Z' },
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-11T10:00:00Z' },
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-12T10:00:00Z' },
      { tool_name: 'send_message', params_hash: 'xyz', timestamp: '2026-04-10T10:00:00Z' },
    ];

    const patterns = detectRepeatedTools(rows, 3);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].tool).toBe('qmd_query');
    expect(patterns[0].count).toBe(3);
  });

  it('ignores tools below threshold', () => {
    const rows: ActionLogRow[] = [
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-10T10:00:00Z' },
      { tool_name: 'qmd_query', params_hash: 'abc', timestamp: '2026-04-11T10:00:00Z' },
    ];

    const patterns = detectRepeatedTools(rows, 3);
    expect(patterns).toHaveLength(0);
  });
});

describe('detectTimePatterns', () => {
  it('detects actions on the same day of week', () => {
    // 2026-04-06, 2026-04-13, 2026-04-20 are Mondays
    const rows: ActionLogRow[] = [
      { tool_name: 'send_message', params_hash: 'weekly', timestamp: '2026-04-06T09:00:00Z' },
      { tool_name: 'send_message', params_hash: 'weekly', timestamp: '2026-04-13T09:00:00Z' },
      { tool_name: 'send_message', params_hash: 'weekly', timestamp: '2026-04-20T09:00:00Z' },
    ];

    const patterns = detectTimePatterns(rows, 3);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].dayOfWeek).toBe(1); // Monday = 1
  });
});

describe('canProposeToday', () => {
  it('returns true when no proposals made today', () => {
    expect(canProposeToday([], '2026-04-13')).toBe(true);
  });

  it('returns false when 2 proposals already made today', () => {
    const proposals = [
      { proposed_at: '2026-04-13', status: 'pending' },
      { proposed_at: '2026-04-13', status: 'approved' },
    ];
    expect(canProposeToday(proposals as any[], '2026-04-13')).toBe(false);
  });

  it('ignores proposals from other days', () => {
    const proposals = [
      { proposed_at: '2026-04-12', status: 'pending' },
      { proposed_at: '2026-04-12', status: 'approved' },
    ];
    expect(canProposeToday(proposals as any[], '2026-04-13')).toBe(true);
  });
});
