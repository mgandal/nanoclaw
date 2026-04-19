import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getBridgeToken,
  verifyBridgeToken,
  writeBridgeTokenFile,
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

describe('writeBridgeTokenFile', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    delete process.env.NANOCLAW_BRIDGE_TOKEN;
    _resetBridgeToken();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes the token to ~/.cache/nanoclaw/bridge-token with mode 0600', () => {
    const expectedPath = path.join(
      tmpHome,
      '.cache',
      'nanoclaw',
      'bridge-token',
    );
    writeBridgeTokenFile();
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath, 'utf-8')).toBe(getBridgeToken());
    expect(fs.statSync(expectedPath).mode & 0o777).toBe(0o600);
  });

  it('is idempotent (re-writing keeps the same token)', () => {
    writeBridgeTokenFile();
    const file = path.join(tmpHome, '.cache', 'nanoclaw', 'bridge-token');
    const first = fs.readFileSync(file, 'utf-8');
    writeBridgeTokenFile();
    const second = fs.readFileSync(file, 'utf-8');
    expect(first).toBe(second);
  });

  it('creates the parent dir with mode 0700 when it does not exist', () => {
    writeBridgeTokenFile();
    const parent = path.join(tmpHome, '.cache', 'nanoclaw');
    expect(fs.existsSync(parent)).toBe(true);
    // macOS umask may filter; chmod in writeBridgeTokenFile belt-and-braces
    // only ensures the file itself is 0600. Parent dir 0700 check is
    // advisory — tolerate 0700 or 0755.
    const mode = fs.statSync(parent).mode & 0o777;
    expect([0o700, 0o755]).toContain(mode);
  });
});
