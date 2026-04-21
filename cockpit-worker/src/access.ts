export type AccessResult =
  | { allowed: true; email: string }
  | { allowed: false; reason: string };

export function checkAccess(headers: Headers, allowedEmails: string[]): AccessResult {
  const jwt = headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return { allowed: false, reason: 'missing Cf-Access-Jwt-Assertion header' };

  const email = headers.get('Cf-Access-Authenticated-User-Email');
  if (!email) return { allowed: false, reason: 'missing Cf-Access-Authenticated-User-Email header' };

  const normalized = email.toLowerCase();
  const match = allowedEmails.some(a => a.toLowerCase() === normalized);
  if (!match) return { allowed: false, reason: `email not in allowlist: ${email}` };

  return { allowed: true, email: normalized };
}
