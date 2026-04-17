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

  it('returns stage=true for ask actions (not silent drop)', () => {
    const trust = { actions: { schedule_meeting: 'ask' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'schedule_meeting',
      trust,
    );
    expect(result.allowed).toBe(false);
    expect(result.stage).toBe(true);
    expect(result.level).toBe('ask');
  });

  it('returns stage=true for draft actions', () => {
    const trust = { actions: { send_email: 'draft' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'send_email',
      trust,
    );
    expect(result.allowed).toBe(false);
    expect(result.stage).toBe(true);
    expect(result.level).toBe('draft');
  });

  it('defaults unknown actions to ask (stage, not silent drop)', () => {
    const trust = { actions: {} };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'unknown_action',
      trust,
    );
    expect(result.allowed).toBe(false);
    expect(result.stage).toBe(true);
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
    expect(result.stage).toBe(false);
  });

  it('autonomous and notify both have stage=false (execute immediately)', () => {
    const a = checkTrust('x', 'g', 'a', { actions: { a: 'autonomous' } });
    const n = checkTrust('x', 'g', 'a', { actions: { a: 'notify' } });
    expect(a.stage).toBe(false);
    expect(n.stage).toBe(false);
  });

  it('invalid level string also stages (fail-safe)', () => {
    const trust = { actions: { x: 'unrecognized_level_xyz' } };
    const result = checkTrust('einstein', 'g', 'x', trust);
    expect(result.allowed).toBe(false);
    expect(result.stage).toBe(true);
  });
});
