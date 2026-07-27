import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

/**
 * scripts/nano-oauth.sh copies the current OAuth token from Claude Code's
 * keychain entry into .env every hour.
 *
 * The script runs under `set -euo pipefail`. Its expiry check used a Python
 * snippet that deliberately `sys.exit(1)`s when the token expires in under 30
 * minutes, then tested `$?` afterwards to log a warning and continue. Under
 * `set -e` the shell aborts on that non-zero assignment before ever reaching
 * the test, so the "updating anyway" branch was unreachable and .env was left
 * holding the stale token — precisely in the window where the refresh matters
 * most. Same `set -e` family documented in CLAUDE.md.
 */
function setup(opts: {
  expiresInHours: number;
  newToken: string;
  envToken: string;
}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-oauth-'));
  const scriptsDir = path.join(tempDir, 'scripts');
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(path.join(scriptsDir, 'sync'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  fs.copyFileSync(
    path.resolve('scripts/nano-oauth.sh'),
    path.join(scriptsDir, 'nano-oauth.sh'),
  );
  fs.chmodSync(path.join(scriptsDir, 'nano-oauth.sh'), 0o755);

  fs.writeFileSync(
    path.join(tempDir, '.env'),
    `SOME_OTHER=keepme\nCLAUDE_CODE_OAUTH_TOKEN=${opts.envToken}\nTRAILING=alsokeep\n`,
  );

  // Stub the macOS keychain lookup.
  const expiresAt = Date.now() + opts.expiresInHours * 3600 * 1000;
  fs.writeFileSync(
    path.join(binDir, 'security'),
    `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({
      claudeAiOauth: { accessToken: opts.newToken, expiresAt },
    })}\nJSON\n`,
  );
  fs.chmodSync(path.join(binDir, 'security'), 0o755);

  const result = spawnSync('bash', [path.join(scriptsDir, 'nano-oauth.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      // Keep the real hourly job's lock out of the test's way and vice versa.
      NANOCLAW_OAUTH_LOCKDIR: path.join(tempDir, 'lock'),
    },
    timeout: 15000,
  });

  const env = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  const logPath = path.join(scriptsDir, 'sync', 'sync.log');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return { result, env, log };
}

describe('nano-oauth.sh', () => {
  it('writes a comfortably-valid new token into .env', () => {
    const { result, env } = setup({
      expiresInHours: 5,
      newToken: 'fresh-token',
      envToken: 'stale-token',
    });
    expect(result.status).toBe(0);
    expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=fresh-token');
    expect(env).not.toContain('stale-token');
  });

  it('still writes the token when it expires in under 30 minutes', () => {
    // The regression: set -e aborted here, leaving .env on the stale token.
    const { result, env, log } = setup({
      expiresInHours: 0.2,
      newToken: 'nearly-expired-but-newer',
      envToken: 'stale-token',
    });
    expect(result.status).toBe(0);
    expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=nearly-expired-but-newer');
    expect(env).not.toContain('stale-token');
    expect(log).toMatch(/WARNING/i);
  });

  it('leaves the rest of .env untouched when rewriting the token', () => {
    const { env } = setup({
      expiresInHours: 5,
      newToken: 'fresh-token',
      envToken: 'stale-token',
    });
    expect(env).toContain('SOME_OTHER=keepme');
    expect(env).toContain('TRAILING=alsokeep');
  });

  it('is a no-op when the keychain token already matches .env', () => {
    const { result, env, log } = setup({
      expiresInHours: 5,
      newToken: 'same-token',
      envToken: 'same-token',
    });
    expect(result.status).toBe(0);
    expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=same-token');
    expect(log).toMatch(/unchanged/i);
  });
});
