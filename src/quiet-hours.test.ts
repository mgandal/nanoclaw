import { describe, it, expect } from 'vitest';
import { isInQuietHours, nextQuietEnd } from './quiet-hours.js';

describe('isInQuietHours', () => {
  const cfg = {
    start: '20:00',
    end: '08:00',
    daysOff: ['Sat', 'Sun'],
    timezone: 'America/New_York',
  };
  it('true at 22:00 Tuesday', () => {
    expect(isInQuietHours(new Date('2026-04-14T22:00:00-04:00'), cfg)).toBe(
      true,
    );
  });
  it('false at 10:00 Tuesday', () => {
    expect(isInQuietHours(new Date('2026-04-14T10:00:00-04:00'), cfg)).toBe(
      false,
    );
  });
  it('true all day Saturday', () => {
    expect(isInQuietHours(new Date('2026-04-18T12:00:00-04:00'), cfg)).toBe(
      true,
    );
  });
  it('true at 07:00 before end', () => {
    expect(isInQuietHours(new Date('2026-04-14T07:00:00-04:00'), cfg)).toBe(
      true,
    );
  });
  it('false exactly at 08:00 end', () => {
    expect(isInQuietHours(new Date('2026-04-14T08:00:00-04:00'), cfg)).toBe(
      false,
    );
  });
  it('returns true when start == end (24h quiet)', () => {
    expect(
      isInQuietHours(new Date('2026-04-14T12:00:00-04:00'), {
        start: '08:00',
        end: '08:00',
        daysOff: [],
        timezone: 'America/New_York',
      }),
    ).toBe(true);
  });
});

describe('nextQuietEnd', () => {
  const cfg = {
    start: '20:00',
    end: '08:00',
    daysOff: ['Sat', 'Sun'],
    timezone: 'America/New_York',
  };
  it('Fri 22:00 → Mon 08:00 EDT (12:00 UTC)', () => {
    const next = nextQuietEnd(new Date('2026-04-17T22:00:00-04:00'), cfg);
    expect(next.toISOString()).toBe('2026-04-20T12:00:00.000Z');
  });
  it('Tue 22:00 → Wed 08:00 EDT', () => {
    const next = nextQuietEnd(new Date('2026-04-14T22:00:00-04:00'), cfg);
    expect(next.toISOString()).toBe('2026-04-15T12:00:00.000Z');
  });
  it('Sat noon → Mon 08:00 EDT', () => {
    const next = nextQuietEnd(new Date('2026-04-18T12:00:00-04:00'), cfg);
    expect(next.toISOString()).toBe('2026-04-20T12:00:00.000Z');
  });
  it('handles DST spring-forward (local day is 23h, not 24h)', () => {
    // In America/New_York, 2026-03-08 is the spring-forward day.
    // Fri 2026-03-06 22:00 EST → Mon 2026-03-09 08:00 EDT = 12:00 UTC
    const next = nextQuietEnd(new Date('2026-03-06T22:00:00-05:00'), {
      start: '20:00',
      end: '08:00',
      daysOff: ['Sat', 'Sun'],
      timezone: 'America/New_York',
    });
    expect(next.toISOString()).toBe('2026-03-09T12:00:00.000Z');
  });
});
