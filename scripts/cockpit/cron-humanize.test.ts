import { describe, it, expect } from 'vitest';
import { humanizeCron } from './cron-humanize.js';

describe('humanizeCron', () => {
  it('produces a readable string for a standard 5-field cron', () => {
    const result = humanizeCron('0 9 * * 1-5');
    expect(result).toMatch(/9/);
    expect(result).not.toBe('0 9 * * 1-5');
  });

  it('falls back to the raw string for malformed 7-token input', () => {
    const malformed = '0 0 8,11,14,17,20 * * 1-5';
    expect(humanizeCron(malformed)).toBe(malformed);
  });

  it('falls back to the raw string for unparseable garbage', () => {
    expect(humanizeCron('not a cron')).toBe('not a cron');
  });

  it('handles multi-hour step crons', () => {
    const result = humanizeCron('0 */2 * * *');
    expect(result).not.toBe('0 */2 * * *');
  });
});
