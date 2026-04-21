import { describe, it, expect } from 'vitest';
import { checkAccess } from './access.js';

describe('checkAccess', () => {
  const ALLOWED = ['mgandal@gmail.com'];

  it('accepts request with both headers and allowlisted email', () => {
    const headers = new Headers({
      'Cf-Access-Jwt-Assertion': 'eyJ...',
      'Cf-Access-Authenticated-User-Email': 'mgandal@gmail.com',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.email).toBe('mgandal@gmail.com');
  });

  it('rejects request missing the JWT header', () => {
    const headers = new Headers({
      'Cf-Access-Authenticated-User-Email': 'mgandal@gmail.com',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/jwt/i);
  });

  it('rejects request missing the email header', () => {
    const headers = new Headers({
      'Cf-Access-Jwt-Assertion': 'eyJ...',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/email/i);
  });

  it('rejects request with non-allowlisted email', () => {
    const headers = new Headers({
      'Cf-Access-Jwt-Assertion': 'eyJ...',
      'Cf-Access-Authenticated-User-Email': 'stranger@example.com',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/not.*allow/i);
  });

  it('is case-insensitive on email comparison', () => {
    const headers = new Headers({
      'Cf-Access-Jwt-Assertion': 'eyJ...',
      'Cf-Access-Authenticated-User-Email': 'MGandal@Gmail.com',
    });
    const r = checkAccess(headers, ALLOWED);
    expect(r.allowed).toBe(true);
  });
});
