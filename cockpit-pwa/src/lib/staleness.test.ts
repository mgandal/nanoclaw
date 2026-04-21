import { describe, it, expect } from 'vitest';
import { stalenessOf } from './staleness.js';

describe('stalenessOf', () => {
  it('returns fresh when <60 min old', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const gen = '2026-04-21T11:30:00Z';  // 30 min old
    const r = stalenessOf(gen, now);
    expect(r.level).toBe('fresh');
    expect(r.ageMin).toBe(30);
  });

  it('returns stale-warn between 60 and 180 min old', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const gen = '2026-04-21T10:30:00Z';  // 90 min
    const r = stalenessOf(gen, now);
    expect(r.level).toBe('stale-warn');
    expect(r.ageMin).toBe(90);
  });

  it('returns stale-crit when >180 min old', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const gen = '2026-04-21T08:30:00Z';  // 210 min
    const r = stalenessOf(gen, now);
    expect(r.level).toBe('stale-crit');
    expect(r.ageMin).toBe(210);
  });

  it('treats exactly 60 min as fresh (boundary is strict >)', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const gen = '2026-04-21T11:00:00Z';
    expect(stalenessOf(gen, now).level).toBe('fresh');
  });

  it('treats exactly 180 min as stale-warn (boundary is strict >)', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const gen = '2026-04-21T09:00:00Z';
    expect(stalenessOf(gen, now).level).toBe('stale-warn');
  });

  it('handles future generated_at (clock skew) as fresh with 0 age', () => {
    const now = new Date('2026-04-21T12:00:00Z');
    const gen = '2026-04-21T12:05:00Z';
    const r = stalenessOf(gen, now);
    expect(r.level).toBe('fresh');
    expect(r.ageMin).toBe(0);
  });
});
