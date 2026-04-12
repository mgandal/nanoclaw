import { describe, it, expect } from 'bun:test';
import { runGuardScript } from './task-scheduler.js';

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
});
