import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifySendError,
  trackTransientFailure,
  resetTrackers,
} from './send-failure-tracker.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  resetTrackers();
});

describe('classifySendError', () => {
  it('classifies 403 as structural', () => {
    expect(classifySendError(403, 'Forbidden')).toBe('structural');
  });
  it('classifies 401 as structural', () => {
    expect(classifySendError(401, 'Unauthorized')).toBe('structural');
  });
  it('classifies 400 chat not found as structural', () => {
    expect(classifySendError(400, 'chat not found')).toBe('structural');
  });
  it('classifies 400 bot was blocked as structural', () => {
    expect(classifySendError(400, 'bot was blocked by the user')).toBe(
      'structural',
    );
  });
  it('classifies 429 as transient', () => {
    expect(classifySendError(429, 'Too Many Requests')).toBe('transient');
  });
  it('classifies 500 as transient', () => {
    expect(classifySendError(500, 'Internal Server Error')).toBe('transient');
  });
  it('classifies 0 (network error) as transient', () => {
    expect(classifySendError(0, 'ECONNRESET')).toBe('transient');
  });
});

describe('trackTransientFailure', () => {
  it('returns null below threshold', () => {
    const result = trackTransientFailure('tg:123');
    expect(result).toBeNull();
  });
  it('returns per-group alert after 3 failures', () => {
    trackTransientFailure('tg:123');
    trackTransientFailure('tg:123');
    const result = trackTransientFailure('tg:123');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('per-group');
    expect(result!.count).toBe(3);
  });
  it('returns global outage alert after 3 distinct groups fail', () => {
    trackTransientFailure('tg:111');
    trackTransientFailure('tg:222');
    const result = trackTransientFailure('tg:333');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('global-outage');
  });
  it('resets per-group counter after 10-minute window', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    trackTransientFailure('tg:123');
    trackTransientFailure('tg:123');
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    const result = trackTransientFailure('tg:123');
    expect(result).toBeNull();
  });
});
