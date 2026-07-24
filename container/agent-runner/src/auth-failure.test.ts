import { describe, it, expect } from 'vitest';

import { isAuthFailureText } from './auth-failure.js';

describe('agent-runner isAuthFailureText', () => {
  it('flags the SDK 401 result text the host would otherwise deliver as a reply', () => {
    expect(
      isAuthFailureText(
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."},"request_id":null}',
      ),
    ).toBe(true);
    expect(isAuthFailureText('Please run /login · API Error: 403 {}')).toBe(
      true,
    );
  });

  it('leaves normal results (and null/empty) alone', () => {
    expect(isAuthFailureText('Filed 3 papers to the vault.')).toBe(false);
    expect(isAuthFailureText(null)).toBe(false);
    expect(isAuthFailureText(undefined)).toBe(false);
    expect(isAuthFailureText('')).toBe(false);
  });

  it('does not flag a reply that merely mentions a 401 from another service', () => {
    expect(
      isAuthFailureText(
        'Todoist returned 401 "Failed to authenticate" — its token needs a refresh.',
      ),
    ).toBe(false);
  });
});
