import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { checkTrust, type TrustDecision } from './trust-enforcement.js';

describe('checkTrust', () => {
  it('returns allow for autonomous actions', () => {
    const trust = { actions: { send_message: 'autonomous' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'send_message',
      trust,
    );
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('autonomous');
    expect(result.notify).toBe(false);
  });

  it('returns allow + notify for notify actions', () => {
    const trust = { actions: { send_message: 'notify' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'send_message',
      trust,
    );
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('notify');
    expect(result.notify).toBe(true);
  });

  it('returns blocked for ask actions', () => {
    const trust = { actions: { schedule_meeting: 'ask' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'schedule_meeting',
      trust,
    );
    expect(result.allowed).toBe(false);
    expect(result.level).toBe('ask');
  });

  it('returns blocked for draft actions (treated as ask)', () => {
    const trust = { actions: { send_email: 'draft' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'send_email',
      trust,
    );
    expect(result.allowed).toBe(false);
    expect(result.level).toBe('draft');
  });

  it('defaults unknown actions to ask (blocked)', () => {
    const trust = { actions: {} };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'unknown_action',
      trust,
    );
    expect(result.allowed).toBe(false);
    expect(result.level).toBe('ask');
  });

  it('returns allow for null trust (no trust file = legacy mode)', () => {
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'send_message',
      null,
    );
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('autonomous');
  });
});
