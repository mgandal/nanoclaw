import { describe, it, expect, beforeEach } from 'vitest';
import {
  getBridgeToken,
  verifyBridgeToken,
  _resetBridgeToken,
} from './bridge-auth.js';

describe('bridge-auth', () => {
  beforeEach(() => {
    _resetBridgeToken();
    delete process.env.NANOCLAW_BRIDGE_TOKEN;
  });

  it('mints a token with sufficient entropy', () => {
    const t1 = getBridgeToken();
    expect(t1).toMatch(/^[A-Za-z0-9+/=_-]{32,}$/);
    // Stable across calls in the same process
    expect(getBridgeToken()).toBe(t1);
  });

  it('reads the token from env when provided (so tests and operators can pin it)', () => {
    process.env.NANOCLAW_BRIDGE_TOKEN = 'a'.repeat(40);
    _resetBridgeToken();
    expect(getBridgeToken()).toBe('a'.repeat(40));
  });

  it('ignores env values shorter than 32 chars (mints a fresh one)', () => {
    process.env.NANOCLAW_BRIDGE_TOKEN = 'too-short';
    _resetBridgeToken();
    const t = getBridgeToken();
    expect(t).not.toBe('too-short');
    expect(t.length).toBeGreaterThanOrEqual(32);
  });

  it('verifyBridgeToken accepts the minted token', () => {
    const t = getBridgeToken();
    expect(verifyBridgeToken(t)).toBe(true);
  });

  it('verifyBridgeToken rejects empty, wrong-length, and mismatched strings', () => {
    const t = getBridgeToken();
    expect(verifyBridgeToken('')).toBe(false);
    expect(verifyBridgeToken('bogus')).toBe(false);
    expect(verifyBridgeToken(t + 'x')).toBe(false); // different length
    // Same length, different content
    const wrong = Buffer.alloc(t.length, 'a').toString('utf-8');
    expect(verifyBridgeToken(wrong)).toBe(false);
  });
});
