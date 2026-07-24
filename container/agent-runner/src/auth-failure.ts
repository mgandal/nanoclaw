/**
 * Recognise the Claude Agent SDK's authentication-failure output.
 *
 * The SDK does not throw on a 401 — it returns a normal result whose text is
 * the failure ("Failed to authenticate. API Error: 401 …"). Reported as a
 * success, the host would deliver that text to the group as the agent's reply
 * and consider the turn done, consuming the user's messages. Classifying it as
 * an error instead lets the host suppress it, alert once, and retry.
 *
 * Mirrors src/auth-failure.ts on the host (the container is a separate package
 * with no shared module). Keep the prefix list in sync.
 */
const AUTH_FAILURE_PREFIXES = [
  'Failed to authenticate.',
  'Please run /login',
  'Authentication error · This may be a temporary network issue',
  'Your account does not have access to Claude',
  'Your organization does not have access to Claude',
];

export function isAuthFailureText(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trimStart();
  return AUTH_FAILURE_PREFIXES.some((p) => trimmed.startsWith(p));
}
