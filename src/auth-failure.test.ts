import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  AUTH_BACKOFF_MS,
  AUTH_SELF_HEAL_COOLDOWN_MS,
  clearAuthIncident,
  isAuthBackoffActive,
  isAuthFailureText,
  initAuthFailureHandling,
  reportAuthFailure,
  resetAuthFailureState,
} from './auth-failure.js';

describe('isAuthFailureText — recognises Claude Agent SDK auth output', () => {
  const sdkOutputs = [
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."},"request_id":null}',
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CcWZQ42FzG9ewur84nHKF"}',
    'Please run /login · API Error: 403 {"type":"error"}',
    'Authentication error · This may be a temporary network issue, please try again',
    'Your account does not have access to Claude. Please login again or contact your administrator.',
    'Your organization does not have access to Claude. Please login again or contact your administrator.',
    'Your account does not have access to Claude Code. Please run /login.',
  ];

  for (const text of sdkOutputs) {
    it(`matches: ${text.slice(0, 44)}…`, () => {
      expect(isAuthFailureText(text)).toBe(true);
    });
  }

  it('matches despite leading whitespace the host trims', () => {
    expect(
      isAuthFailureText('\n  Failed to authenticate. API Error: 401'),
    ).toBe(true);
  });

  it('does not match an agent legitimately discussing a 401', () => {
    expect(
      isAuthFailureText(
        'The Todoist sync returned 401 — its token expired. I refreshed it, so "Failed to authenticate" is gone.',
      ),
    ).toBe(false);
  });

  it('does not match ordinary replies or empty text', () => {
    expect(isAuthFailureText('Done — 3 papers filed.')).toBe(false);
    expect(isAuthFailureText('')).toBe(false);
  });
});

describe('auth incident handling', () => {
  beforeEach(() => {
    resetAuthFailureState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAuthFailureState();
  });

  it('alerts once per incident no matter how many sources report it', async () => {
    const alert = vi.fn();
    const selfHeal = vi.fn().mockResolvedValue('refreshed');
    initAuthFailureHandling({ alert, selfHeal });

    await reportAuthFailure('agent-reply:telegram_claire');
    await reportAuthFailure('agent-reply:telegram_lab-claw');
    await reportAuthFailure('credential-proxy');

    expect(alert).toHaveBeenCalledTimes(1);
    expect(selfHeal).toHaveBeenCalledTimes(1);
    // Constant message: sendSystemAlert dedupes on `${service}:${message}`, so
    // a varying request_id in the text would defeat its own 30m cooldown too.
    expect(alert.mock.calls[0][1]).not.toMatch(/req_|request_id/);
  });

  it('still alerts once when every group reports concurrently', async () => {
    const alert = vi.fn();
    // A self-heal that yields: the incident flags must be claimed before the
    // first await, or each concurrent report reads a stale "not alerted yet".
    const selfHeal = vi
      .fn()
      .mockImplementation(
        () => new Promise((r) => queueMicrotask(() => r('refreshed'))),
      );
    initAuthFailureHandling({ alert, selfHeal });

    await Promise.all([
      reportAuthFailure('group-1'),
      reportAuthFailure('group-2'),
      reportAuthFailure('group-3'),
      reportAuthFailure('group-4'),
    ]);

    expect(alert).toHaveBeenCalledTimes(1);
    expect(selfHeal).toHaveBeenCalledTimes(1);
  });

  it('retries the self-heal once its cooldown lapses, without re-alerting', async () => {
    const alert = vi.fn();
    const selfHeal = vi.fn().mockResolvedValue('unchanged');
    initAuthFailureHandling({ alert, selfHeal });

    await reportAuthFailure('credential-proxy');
    vi.setSystemTime(Date.now() + AUTH_SELF_HEAL_COOLDOWN_MS + 1000);
    await reportAuthFailure('credential-proxy');

    expect(selfHeal).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('never rejects when the self-heal script fails', async () => {
    const alert = vi.fn();
    const selfHeal = vi.fn().mockRejectedValue(new Error('script missing'));
    initAuthFailureHandling({ alert, selfHeal });

    await expect(
      reportAuthFailure('credential-proxy'),
    ).resolves.toBeUndefined();
    // The alert still goes out — a failed self-heal must not swallow the signal.
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('opens a bounded spawn backoff that expires on its own', async () => {
    initAuthFailureHandling({ alert: vi.fn(), selfHeal: vi.fn() });
    expect(isAuthBackoffActive()).toBe(false);

    await reportAuthFailure('credential-proxy');
    expect(isAuthBackoffActive()).toBe(true);

    vi.setSystemTime(Date.now() + AUTH_BACKOFF_MS - 1);
    expect(isAuthBackoffActive()).toBe(true);

    vi.setSystemTime(Date.now() + 2);
    expect(isAuthBackoffActive()).toBe(false);
  });

  it('clears the backoff as soon as auth is observed working', async () => {
    initAuthFailureHandling({ alert: vi.fn(), selfHeal: vi.fn() });
    await reportAuthFailure('credential-proxy');
    expect(isAuthBackoffActive()).toBe(true);

    clearAuthIncident();
    expect(isAuthBackoffActive()).toBe(false);
  });

  it('re-alerts for a new incident after recovery', async () => {
    const alert = vi.fn();
    const selfHeal = vi.fn().mockResolvedValue('unchanged');
    initAuthFailureHandling({ alert, selfHeal });

    await reportAuthFailure('credential-proxy');
    clearAuthIncident();
    await reportAuthFailure('credential-proxy');

    expect(alert).toHaveBeenCalledTimes(2);
    // Self-heal keeps its own time cooldown — a flapping incident must not
    // re-run the refresh script on every flap.
    expect(selfHeal).toHaveBeenCalledTimes(1);
  });

  it('still records the backoff when nothing is wired yet (no throw)', async () => {
    await expect(reportAuthFailure('agent-reply:x')).resolves.toBeUndefined();
    expect(isAuthBackoffActive()).toBe(true);
  });
});
