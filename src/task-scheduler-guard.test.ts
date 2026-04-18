import { describe, it, expect, vi } from 'vitest';

// task-scheduler.ts transitively imports container-runtime.ts, which throws
// at load time if CREDENTIAL_PROXY_HOST is unset. Matches the hoist pattern
// used in container-runtime.test.ts.
vi.hoisted(() => {
  if (!process.env.CREDENTIAL_PROXY_HOST) {
    process.env.CREDENTIAL_PROXY_HOST = '192.168.64.1';
  }
});

import { runGuardScript } from './task-scheduler.js';
import { logger } from './logger.js';

describe('runGuardScript', () => {
  it('returns true when script exits 0', async () => {
    const result = await runGuardScript('echo "ok" && exit 0', 5000);
    expect(result.shouldRun).toBe(true);
  });

  it('returns false when script exits 1', async () => {
    const result = await runGuardScript('exit 1', 5000);
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toContain('exit code');
  });

  it('returns true (fail-open) when script times out', async () => {
    const result = await runGuardScript('sleep 10', 500);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toContain('timed out');
  });

  it('returns true (fail-open) when script errors', async () => {
    const result = await runGuardScript('/nonexistent/path/script', 5000);
    expect(result.shouldRun).toBe(true);
  });

  it('returns true when script is null/undefined', async () => {
    const result = await runGuardScript(null, 5000);
    expect(result.shouldRun).toBe(true);
    const result2 = await runGuardScript(undefined, 5000);
    expect(result2.shouldRun).toBe(true);
  });

  it('emits an audit log entry on every non-null invocation (A1)', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    await runGuardScript('echo audit && exit 0', 5000);
    const auditCalls = infoSpy.mock.calls.filter((c) =>
      String(c[1] ?? '').includes('Guard script executed'),
    );
    expect(auditCalls.length).toBeGreaterThan(0);
    infoSpy.mockRestore();
  });

  it('does NOT emit an audit log when script is null', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    await runGuardScript(null, 5000);
    const auditCalls = infoSpy.mock.calls.filter((c) =>
      String(c[1] ?? '').includes('Guard script executed'),
    );
    expect(auditCalls.length).toBe(0);
    infoSpy.mockRestore();
  });
});
